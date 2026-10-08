/** Página de teste do cache de máscaras (masktest.html). Não faz parte do app. */
import { MaskPrecomputer, type MaskJobResult } from './precompute'
import { MaskReader, deleteMask, hasMask, listMasks, maskCacheKey, maskStorageUsage } from './maskCache'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const progressEl = $<HTMLDivElement>('progress')
const statsEl = $<HTMLPreElement>('stats')
const log = (s: string) => {
  progressEl.textContent = s
  console.log('[masktest]', s)
}

const pre = new MaskPrecomputer({
  onProgress: (key, frame, total) => log(`${key.slice(0, 24)}… ${frame}/${total}`),
  onError: (_key, m) => log('erro: ' + m),
})

interface Stats {
  key: string
  cached: boolean
  frameCount: number
  width: number
  height: number
  fps: number
  bytes: number
  storageBytes: number
  totalMs: number
  msPerFrame: number
  timing: unknown
  opaque2s: number
  opaque4s: number
  peekHit: boolean
  secondRun: { cached: boolean; ms: number } | null
  worker: unknown
  files: number
}

function drawBytes(canvas: HTMLCanvasElement, bytes: Uint8Array, w: number, h: number): number {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  let opaque = 0
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
    if (v > 128) opaque++
  }
  ctx.putImageData(img, 0, 0)
  return opaque / bytes.length
}

async function run(file: File) {
  statsEl.textContent = ''
  const key = maskCacheKey(file, 'mediapipe')
  const force = $<HTMLInputElement>('force').checked
  if (force) await deleteMask(key)
  log(`chave ${key}; no cache: ${await hasMask(key)}`)

  const q = new URLSearchParams(location.search)
  const opts = {
    fps: Number(q.get('fps')) || 30,
    inputWidth: q.has('inputWidth') ? Number(q.get('inputWidth')) : undefined,
    delegate: q.get('delegate') === 'CPU' ? ('CPU' as const) : undefined,
  }
  const t0 = performance.now()
  let result: MaskJobResult
  try {
    result = await pre.enqueue(file, key, opts)
  } catch (e) {
    log('falhou: ' + (e instanceof Error ? e.message : String(e)))
    statsEl.textContent = JSON.stringify({ error: String(e) })
    return
  }
  const totalMs = performance.now() - t0

  const reader = await MaskReader.open(key)
  if (!reader) {
    statsEl.textContent = JSON.stringify({ error: 'MaskReader.open devolveu null' })
    return
  }
  const f2 = await reader.frameAt(2)
  const f4 = await reader.frameAt(4)
  const opaque2s = f2 ? drawBytes($('c2'), f2, reader.width, reader.height) : -1
  const opaque4s = f4 ? drawBytes($('c4'), f4, reader.width, reader.height) : -1
  const peekHit = reader.peek(4) === f4 && reader.peekCanvas(2) !== null
  // canvasAt deve devolver um canvas com alfa
  const cv = await reader.canvasAt(2)
  if (!cv) throw new Error('canvasAt null')

  // segunda rodada com a mesma chave: deve ser pulada (cache hit)
  const t1 = performance.now()
  const second = await pre.enqueue(file, key)
  const secondRun = { cached: second.cached, ms: Math.round(performance.now() - t1) }

  // leitura dentro de um worker
  const w = new Worker(new URL('./masktest.reader.worker.ts', import.meta.url), { type: 'module' })
  const workerResult = await new Promise<unknown>((resolve) => {
    w.onmessage = (ev) => resolve(ev.data)
    w.onerror = (ev) => resolve({ error: ev.message })
    w.postMessage({ key, time: 2, expectOpaque: opaque2s })
  })
  w.terminate()

  const stats: Stats = {
    key,
    cached: result.cached,
    frameCount: reader.frameCount,
    width: reader.width,
    height: reader.height,
    fps: reader.fps,
    bytes: reader.byteLength,
    storageBytes: await maskStorageUsage(),
    totalMs: Math.round(totalMs),
    msPerFrame: result.cached ? 0 : +(result.elapsedMs / Math.max(1, result.frameCount)).toFixed(1),
    timing: result.timing ?? null,
    opaque2s: +opaque2s.toFixed(4),
    opaque4s: +opaque4s.toFixed(4),
    peekHit,
    secondRun,
    worker: workerResult,
    files: (await listMasks()).length,
  }
  statsEl.textContent = JSON.stringify(stats, null, 2)
  log('pronto')
  ;(window as unknown as { __maskStats?: Stats }).__maskStats = stats
}

$<HTMLInputElement>('file').addEventListener('change', (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (f) void run(f)
})
