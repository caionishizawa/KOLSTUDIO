/**
 * Página de benchmark (/bench.html em dev): MediaPipe vs RVM lado a lado no mesmo vídeo.
 *
 * Parâmetros de URL (todos opcionais): ?auto=1 (roda assim que um arquivo for escolhido)
 *   &mode=main|worker &backend=webgpu|wasm &precision=fp16|fp32 &width=256 &frames=40 &fps=10 &mp=0
 *   &threads=N (wasm) &mpd=CPU (delegate do MediaPipe) &gpustate=0 (WebGPU: estados na CPU)
 * Para automação (Playwright): `window.__bench.done` fica true ao terminar, `window.__bench.stats`
 * tem o JSON e `window.__bench.pngs()` devolve data URLs {src, mp, rvm} do último quadro.
 */
import { BenchEngine, type BenchFrameResult, type BenchInitInfo, type BenchInitOptions } from './engine'
import type { RvmBackend, RvmPrecision } from '../render/rvm'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const fileInput = $<HTMLInputElement>('file')
const modeSel = $<HTMLSelectElement>('mode')
const backendSel = $<HTMLSelectElement>('backend')
const precisionSel = $<HTMLSelectElement>('precision')
const widthInput = $<HTMLInputElement>('width')
const framesInput = $<HTMLInputElement>('frames')
const fpsInput = $<HTMLInputElement>('fps')
const mpCheck = $<HTMLInputElement>('mp')
const startBtn = $<HTMLButtonElement>('start')
const exportBtn = $<HTMLButtonElement>('export')
const statsPre = $<HTMLPreElement>('stats')
const srcCanvas = $<HTMLCanvasElement>('src')
const mpCanvas = $<HTMLCanvasElement>('cmp')
const rvmCanvas = $<HTMLCanvasElement>('crvm')

const params = new URLSearchParams(location.search)
if (params.get('mode')) modeSel.value = params.get('mode')!
if (params.get('backend')) backendSel.value = params.get('backend')!
if (params.get('precision')) precisionSel.value = params.get('precision')!
if (params.get('width')) widthInput.value = params.get('width')!
if (params.get('frames')) framesInput.value = params.get('frames')!
if (params.get('fps')) fpsInput.value = params.get('fps')!
if (params.get('mp') === '0') mpCheck.checked = false

const video = document.createElement('video')
video.muted = true
video.playsInline = true
video.preload = 'auto'

interface Stats {
  mode: 'main' | 'worker'
  video: { width: number; height: number; duration: number }
  frames: number
  sampleFps: number
  webgpuAvailable: boolean
  crossOriginIsolated: boolean
  hardwareConcurrency: number
  mediapipe: { label: string | null; error: string | null; msAvg: number; msP95: number; edgeFrac: number; edgeFracOfFg: number; fgFrac: number } | null
  rvm: { label: string; backend: string; precision: string; inputWidth: number; inputHeight: number; downsampleRatio: number; threads: number; msAvg: number; msP95: number; edgeFrac: number; edgeFracOfFg: number; fgFrac: number }
  /** IoU médio (alfa>0.5) entre as duas máscaras */
  iouMpRvm: number | null
  initMs: number
  error?: string
}

const bench = { done: false, running: false, stats: null as Stats | null, pngs: exportDataUrls, firstPngs: null as Record<string, string> | null }
;(window as unknown as { __bench: typeof bench }).__bench = bench

// cortes do último quadro com alfa (para exportar PNG)
const lastCut = { src: new OffscreenCanvas(1, 1), mp: new OffscreenCanvas(1, 1), rvm: new OffscreenCanvas(1, 1) }

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  if (!f) return
  video.src = URL.createObjectURL(f)
  await new Promise<void>((res, rej) => {
    video.onloadedmetadata = () => res()
    video.onerror = () => rej(new Error('falha ao carregar vídeo'))
  })
  statsPre.textContent = `vídeo ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s`
  if (params.get('auto') === '1') void run()
})
startBtn.addEventListener('click', () => void run())
exportBtn.addEventListener('click', () => void downloadPngs())

/** Interface única sobre o engine local ou o worker. */
interface Runner {
  init(opts: BenchInitOptions): Promise<BenchInitInfo>
  frame(ts: number): Promise<BenchFrameResult>
  reset(): void
  close(): void
}

function mainRunner(): Runner {
  const engine = new BenchEngine()
  return {
    init: (o) => engine.init(o),
    frame: (ts) => engine.frame(video, video.videoWidth, video.videoHeight, ts),
    reset: () => engine.reset(),
    close: () => engine.close(),
  }
}

function workerRunner(): Runner {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const call = <T>(msg: unknown, transfer: Transferable[] = []) =>
    new Promise<T>((res, rej) => {
      worker.onmessage = (ev) => {
        if (ev.data.type === 'error') rej(new Error(ev.data.message))
        else res(ev.data as T)
      }
      worker.onerror = (e) => rej(new Error(e.message))
      worker.postMessage(msg, transfer)
    })
  return {
    init: async (opts) => (await call<{ info: BenchInitInfo }>({ type: 'init', opts })).info,
    frame: async (ts) => {
      const bitmap = await createImageBitmap(video)
      return call<BenchFrameResult>({ type: 'frame', bitmap, w: video.videoWidth, h: video.videoHeight, ts }, [bitmap])
    },
    reset: () => worker.postMessage({ type: 'reset' }),
    close: () => worker.postMessage({ type: 'close' }),
  }
}

function seek(t: number) {
  return new Promise<void>((res) => {
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return res()
    video.onseeked = () => res()
    video.currentTime = t
  })
}

function percentile(xs: number[], p: number) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

interface MaskMetrics {
  edge: number
  fg: number
  alpha: Float32Array
  w: number
  h: number
}
const metricCanvas = new OffscreenCanvas(1, 1)
const metricCtx = metricCanvas.getContext('2d', { willReadFrequently: true })!
/** Lê a máscara na sua própria resolução (ou numa dada) e mede: fração de pixels com alfa em (0.1,0.9) e fração de pessoa (>0.5). */
function maskMetrics(bmp: ImageBitmap, w = bmp.width, h = bmp.height): MaskMetrics {
  metricCanvas.width = w
  metricCanvas.height = h
  metricCtx.clearRect(0, 0, w, h)
  metricCtx.drawImage(bmp, 0, 0, w, h)
  const d = metricCtx.getImageData(0, 0, w, h).data
  const n = w * h
  const alpha = new Float32Array(n)
  let edge = 0
  let fg = 0
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255
    alpha[i] = a
    if (a > 0.1 && a < 0.9) edge++
    if (a > 0.5) fg++
  }
  return { edge: edge / n, fg: fg / n, alpha, w, h }
}

function iou(a: Float32Array, b: Float32Array) {
  let inter = 0
  let uni = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > 0.5
    const y = b[i] > 0.5
    if (x && y) inter++
    if (x || y) uni++
  }
  return uni ? inter / uni : 1
}

/** Desenha o vídeo recortado pela máscara (com alfa) em `cut` e depois sobre verde no canvas visível. */
function composite(cut: OffscreenCanvas, visible: HTMLCanvasElement, mask: ImageBitmap | null) {
  const w = video.videoWidth
  const h = video.videoHeight
  if (cut.width !== w || cut.height !== h) {
    cut.width = w
    cut.height = h
  }
  const c = cut.getContext('2d')!
  c.globalCompositeOperation = 'source-over'
  c.clearRect(0, 0, w, h)
  if (mask) {
    c.drawImage(video, 0, 0, w, h)
    c.globalCompositeOperation = 'destination-in'
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(mask, 0, 0, w, h)
    c.globalCompositeOperation = 'source-over'
  }
  const v = visible.getContext('2d')!
  v.fillStyle = '#00b140'
  v.fillRect(0, 0, visible.width, visible.height)
  v.drawImage(cut, 0, 0, visible.width, visible.height)
}

async function run() {
  if (bench.running || !video.videoWidth) return
  bench.running = true
  bench.done = false
  exportBtn.disabled = true
  startBtn.disabled = true
  const mode = modeSel.value as 'main' | 'worker'
  const nFrames = Math.max(1, Number(framesInput.value) || 40)
  const fps = Math.max(1, Number(fpsInput.value) || 10)
  const runner = mode === 'worker' ? workerRunner() : mainRunner()
  const mpTimes: number[] = []
  const rvmTimes: number[] = []
  const mpEdge: number[] = []
  const mpFg: number[] = []
  const rvmEdge: number[] = []
  const rvmFg: number[] = []
  const ious: number[] = []
  let info: BenchInitInfo | null = null
  let initMs = 0
  let error: string | undefined
  try {
    statsPre.textContent = 'inicializando segmentadores…'
    const t0 = performance.now()
    info = await withTimeout(runner.init({
      rvmBackend: backendSel.value as RvmBackend,
      rvmPrecision: (precisionSel.value || undefined) as RvmPrecision | undefined,
      rvmInputWidth: Number(widthInput.value) || 256,
      rvmThreads: params.get('threads') ? Number(params.get('threads')) : undefined,
      rvmGpuStates: params.get('gpustate') === '0' ? false : undefined,
      mpDelegate: params.get('mpd') === 'CPU' ? 'CPU' : 'GPU',
      mpModel: 'multiclass',
      runMediaPipe: mpCheck.checked,
    }), INIT_TIMEOUT_MS, `inicialização não terminou em ${INIT_TIMEOUT_MS / 1000}s`)
    console.info(`[bench] init ok: MP=${info.mediapipe} RVM=${info.rvm}`)
    initMs = performance.now() - t0
    $<HTMLElement>('capMp').textContent = info.mediapipe ?? `MediaPipe indisponível: ${info.mpError ?? ''}`
    $<HTMLElement>('capRvm').textContent = info.rvm
    runner.reset()
    for (let i = 0; i < nFrames; i++) {
      const t = Math.min(video.duration - 0.05, i / fps)
      await seek(t)
      const r = await withTimeout(runner.frame(t * 1000), FRAME_TIMEOUT_MS, `quadro ${i} não terminou em ${FRAME_TIMEOUT_MS / 1000}s`)
      console.info(`[bench] quadro ${i + 1}/${nFrames} MP ${r.mpMs.toFixed(1)}ms RVM ${r.rvmMs.toFixed(1)}ms`)
      // o 1º quadro inclui aquecimento (compilação de shaders / alocação): não entra na média
      if (i > 0) {
        mpTimes.push(r.mpMs)
        rvmTimes.push(r.rvmMs)
      }
      let mpM: MaskMetrics | null = null
      let rvmM: MaskMetrics | null = null
      if (r.rvm) {
        rvmM = maskMetrics(r.rvm)
        rvmEdge.push(rvmM.edge)
        rvmFg.push(rvmM.fg)
      }
      if (r.mp) {
        mpM = maskMetrics(r.mp)
        mpEdge.push(mpM.edge)
        mpFg.push(mpM.fg)
        if (rvmM) ious.push(iou(maskMetrics(r.mp, rvmM.w, rvmM.h).alpha, rvmM.alpha))
      }
      // desenha
      const sctx = srcCanvas.getContext('2d')!
      sctx.drawImage(video, 0, 0, srcCanvas.width, srcCanvas.height)
      composite(lastCut.mp, mpCanvas, r.mp)
      composite(lastCut.rvm, rvmCanvas, r.rvm)
      const sc = lastCut.src
      if (sc.width !== video.videoWidth) {
        sc.width = video.videoWidth
        sc.height = video.videoHeight
      }
      sc.getContext('2d')!.drawImage(video, 0, 0)
      r.mp?.close()
      r.rvm?.close()
      // guarda o 1º quadro já renderizado (útil se o processo de GPU cair no meio do teste)
      if (i === 0) bench.firstPngs = await exportDataUrls()
      statsPre.textContent = `quadro ${i + 1}/${nFrames}  MP ${r.mpMs.toFixed(1)} ms  RVM ${r.rvmMs.toFixed(1)} ms`
    }
  } catch (e) {
    error = e instanceof Error ? e.stack || e.message : String(e)
    console.error(e)
  } finally {
    runner.close()
  }
  const rinfo = info?.rvmInfo
  const inputH = rinfo ? Math.max(16, Math.round((rinfo.inputWidth * video.videoHeight) / video.videoWidth / 16) * 16) : 0
  const stats: Stats = {
    mode,
    video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration },
    frames: nFrames,
    sampleFps: fps,
    webgpuAvailable: 'gpu' in navigator && !!navigator.gpu,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency,
    mediapipe: mpCheck.checked
      ? {
          label: info?.mediapipe ?? null,
          error: info?.mpError ?? null,
          msAvg: round(avg(mpTimes)),
          msP95: round(percentile(mpTimes, 0.95)),
          edgeFrac: round(avg(mpEdge), 4),
          edgeFracOfFg: round(avg(mpEdge) / Math.max(1e-6, avg(mpFg)), 4),
          fgFrac: round(avg(mpFg), 4),
        }
      : null,
    rvm: {
      label: info?.rvm ?? '(falhou)',
      backend: rinfo?.backend ?? '',
      precision: rinfo?.precision ?? '',
      inputWidth: rinfo?.inputWidth ?? 0,
      inputHeight: inputH,
      downsampleRatio: rinfo ? round(Math.min(1, rinfo.internalWidth / rinfo.inputWidth), 3) : 0,
      threads: rinfo?.threads ?? 0,
      msAvg: round(avg(rvmTimes)),
      msP95: round(percentile(rvmTimes, 0.95)),
      edgeFrac: round(avg(rvmEdge), 4),
      edgeFracOfFg: round(avg(rvmEdge) / Math.max(1e-6, avg(rvmFg)), 4),
      fgFrac: round(avg(rvmFg), 4),
    },
    iouMpRvm: ious.length ? round(avg(ious), 4) : null,
    initMs: round(initMs),
    error,
  }
  bench.stats = stats
  statsPre.textContent = JSON.stringify(stats, null, 2)
  bench.running = false
  bench.done = true
  startBtn.disabled = false
  exportBtn.disabled = false
}

const FRAME_TIMEOUT_MS = 120_000
const INIT_TIMEOUT_MS = 300_000
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const id = setTimeout(() => rej(new Error(msg)), ms)
    p.then(
      (v) => {
        clearTimeout(id)
        res(v)
      },
      (e) => {
        clearTimeout(id)
        rej(e)
      },
    )
  })
}

function round(x: number, d = 2) {
  const k = 10 ** d
  return Math.round(x * k) / k
}

async function blobToDataUrl(b: Blob) {
  return new Promise<string>((res) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.readAsDataURL(b)
  })
}

async function exportDataUrls() {
  const out: Record<string, string> = {}
  for (const k of ['src', 'mp', 'rvm'] as const) {
    lastCut[k].getContext('2d') // garante contexto (convertToBlob falha sem ele)
    out[k] = await blobToDataUrl(await lastCut[k].convertToBlob({ type: 'image/png' }))
  }
  return out
}

async function downloadPngs() {
  for (const k of ['src', 'mp', 'rvm'] as const) {
    const blob = await lastCut[k].convertToBlob({ type: 'image/png' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `bench-${k}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }
}
