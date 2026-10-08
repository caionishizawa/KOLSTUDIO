/**
 * Segmentador de pessoa com Robust Video Matting (RVM, MobileNetV3) rodando localmente
 * via onnxruntime-web (WebGPU com fallback para wasm). Sem CDN: o JS vem pelo Vite e o
 * runtime wasm é servido de /ort (copiado por scripts/prepare-assets.mjs).
 *
 * ATENÇÃO — DIFERENÇA DE INTERFACE em relação a `Segmenter` (src/render/segmenter.ts):
 *   `segment()` é ASSÍNCRONO: devolve `Promise<OffscreenCanvas | null>`, porque
 *   `InferenceSession.run` do onnxruntime é assíncrono. O restante da interface é igual:
 *   `static create(...)`, `reset()`, `close()`, `info`.
 *
 *   - Se `segment()` for chamado enquanto um quadro anterior ainda está sendo processado
 *     (caso do preview), ele NÃO enfileira: devolve imediatamente `lastMask` (a última
 *     máscara pronta, ou null). Assim o preview nunca acumula atraso.
 *   - `lastMask` guarda a última máscara calculada para reutilização entre quadros.
 *   - O canvas devolvido é reutilizado internamente (como no MediaPipe): desenhe-o antes de
 *     chamar `segment()` de novo.
 *
 * Modelo: public/models/rvm_mobilenetv3_{fp16,fp32}.onnx (release oficial PeterL1n v1.0.0).
 *   entradas: src [1,3,H,W] (RGB 0..1), r1i..r4i (estados recorrentes; zeros [1,1,1,1] no
 *   primeiro quadro), downsample_ratio [1] float32.
 *   saídas: fgr [1,3,H,W], pha [1,1,H,W], r1o..r4o — realimentados em r*i no próximo quadro
 *   (é isso que dá a estabilidade temporal). `reset()` zera os estados.
 *
 * fp16: o modelo fp16 tem entradas/saídas float16; onnxruntime-web aceita `Uint16Array`
 * (bits IEEE half) para tensores 'float16', então convertemos manualmente (sem Float16Array).
 * No backend wasm os kernels fp16 de Conv não existem/são lentos, por isso em wasm sempre
 * usamos fp32. No WebGPU, os estados recorrentes e `fgr` ficam na GPU (`gpu-buffer`), só
 * `pha` desce para a CPU.
 *
 * Uso:
 *   const seg = await RvmSegmenter.create({ backend: 'webgpu', inputWidth: 256 })
 *   const mask = await seg.segment(video, video.videoWidth, video.videoHeight, tMs)
 *   ctx.drawImage(mask, 0, 0, w, h)   // RGBA: rgb=255, alpha=pha
 *   seg.reset()  // ao pular no tempo ou trocar de take
 *   seg.close()
 */
import * as ort from 'onnxruntime-web'

const MODEL_FP16 = '/models/rvm_mobilenetv3_fp16.onnx'
const MODEL_FP32 = '/models/rvm_mobilenetv3_fp32.onnx'
const ORT_WASM_PATH = '/ort/'
/** Largura padrão do quadro enviado ao modelo (256 é o indicado para máquinas com 4 GB). */
const DEFAULT_INPUT_W = 256
/** Largura alvo da resolução interna da rede (define downsample_ratio). */
const DEFAULT_INTERNAL_W = 256
const MAX_THREADS = 4

export type RvmBackend = 'webgpu' | 'wasm'
export type RvmPrecision = 'fp16' | 'fp32'

export interface RvmOptions {
  /** Backend preferido; 'webgpu' cai automaticamente para 'wasm' se indisponível/falhar. */
  backend?: RvmBackend
  /** Precisão do modelo. Padrão: fp16 no WebGPU, fp32 no wasm (wasm sempre usa fp32). */
  precision?: RvmPrecision
  /** Largura do quadro enviado ao modelo (altura pela proporção, múltiplo de 16). Padrão 256. */
  inputWidth?: number
  /** Largura alvo da resolução interna (downsample_ratio = internalWidth / inputWidth, máx. 1). Padrão 256. */
  internalWidth?: number
  /** Threads do wasm. Padrão: min(4, hardwareConcurrency). Só vale com crossOriginIsolated. */
  threads?: number
}

export interface RvmInfo {
  backend: RvmBackend
  precision: RvmPrecision
  inputWidth: number
  internalWidth: number
  threads: number
  /** Nome legível, para a UI. */
  label: string
}

type StateName = 'r1i' | 'r2i' | 'r3i' | 'r4i'
const STATE_IN: StateName[] = ['r1i', 'r2i', 'r3i', 'r4i']
const STATE_OUT = ['r1o', 'r2o', 'r3o', 'r4o'] as const

let ortConfigured = false
function configureOrt(threads: number) {
  if (ortConfigured) return
  ortConfigured = true
  // Forma de objeto (só o .wasm): o carregador .mjs fica embutido no bundle do ort que vem pelo
  // Vite. Com prefixo string o ort faria import() dinâmico de /ort/*.mjs, que o Vite em dev
  // bloqueia (arquivos de /public não podem ser importados como módulo).
  // O bundle padrão do onnxruntime-web (wasm + webgpu) usa o binário ".jsep.wasm" para os dois backends.
  ort.env.wasm.wasmPaths = { wasm: `${ORT_WASM_PATH}ort-wasm-simd-threaded.jsep.wasm` }
  ort.env.wasm.simd = true
  // Threads só funcionam com SharedArrayBuffer (crossOriginIsolated); senão o ort cai para 1 sozinho.
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  ort.env.wasm.numThreads = isolated ? Math.max(1, threads) : 1
  ort.env.wasm.proxy = false
  ort.env.logLevel = 'warning'
}

function defaultThreads(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1
  return Math.max(1, Math.min(MAX_THREADS, hc))
}

/** float32 -> bits IEEE 754 half (arredondamento para o mais próximo). Entrada já está em 0..1. */
const f32buf = new Float32Array(1)
const u32buf = new Uint32Array(f32buf.buffer)
function toHalf(v: number): number {
  f32buf[0] = v
  const x = u32buf[0]
  const sign = (x >>> 16) & 0x8000
  let exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0) // inf/nan
  exp = exp - 127 + 15
  if (exp >= 0x1f) return sign | 0x7c00
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >> (1 - exp)
    return sign | ((mant + 0x1000) >> 13)
  }
  return sign | (exp << 10) | ((mant + 0x1000) >> 13)
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

export class RvmSegmenter {
  readonly info: RvmInfo
  /** Última máscara pronta (reutilizável pelo preview enquanto o próximo quadro processa). */
  lastMask: OffscreenCanvas | null = null
  /** true enquanto um `session.run` está em andamento. */
  get busy() {
    return this.running
  }

  private session: ort.InferenceSession
  private readonly fp16: boolean
  private readonly inputW: number
  private readonly ratio: ort.Tensor
  private input: OffscreenCanvas
  private inputCtx: OffscreenCanvasRenderingContext2D
  private mask: OffscreenCanvas
  private maskCtx: OffscreenCanvasRenderingContext2D
  private maskData: ImageData | null = null
  private srcData: Float32Array | Uint16Array | null = null
  private states: Record<StateName, ort.Tensor>
  private running = false
  private closed = false
  private lastTs = -Infinity

  private constructor(session: ort.InferenceSession, info: RvmInfo) {
    this.session = session
    this.info = info
    this.fp16 = info.precision === 'fp16'
    this.inputW = info.inputWidth
    const r = Math.min(1, info.internalWidth / info.inputWidth)
    this.ratio = new ort.Tensor('float32', new Float32Array([r]), [1])
    this.input = new OffscreenCanvas(this.inputW, this.inputW)
    this.inputCtx = this.input.getContext('2d', { willReadFrequently: true })!
    this.mask = new OffscreenCanvas(this.inputW, this.inputW)
    this.maskCtx = this.mask.getContext('2d')!
    this.states = this.zeroStates()
  }

  static async create(opts: RvmOptions = {}): Promise<RvmSegmenter> {
    const threads = opts.threads ?? defaultThreads()
    configureOrt(threads)
    const inputWidth = Math.max(64, Math.round((opts.inputWidth ?? DEFAULT_INPUT_W) / 16) * 16)
    const internalWidth = opts.internalWidth ?? DEFAULT_INTERNAL_W
    const preferred = opts.backend ?? 'webgpu'

    const attempts: [RvmBackend, RvmPrecision][] = []
    if (preferred === 'webgpu') {
      const gpu = await probeWebGpu()
      if (gpu.ok) {
        // fp16 só compensa (e só funciona) se a GPU expõe shader-f16; senão fp32 direto.
        attempts.push(['webgpu', opts.precision ?? (gpu.f16 ? 'fp16' : 'fp32')])
      }
    }
    // wasm: sempre fp32 (kernels fp16 de Conv não são suportados/performáticos na CPU)
    attempts.push(['wasm', 'fp32'])

    let lastErr: unknown = null
    for (const [backend, precision] of attempts) {
      try {
        const model = await loadModel(precision === 'fp16' ? MODEL_FP16 : MODEL_FP32, backend === 'webgpu')
        const session = await ort.InferenceSession.create(model, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          // WebGPU: estados recorrentes e fgr ficam na GPU; só pha desce para a CPU.
          preferredOutputLocation:
            backend === 'webgpu'
              ? { fgr: 'gpu-buffer', pha: 'cpu', r1o: 'gpu-buffer', r2o: 'gpu-buffer', r3o: 'gpu-buffer', r4o: 'gpu-buffer' }
              : undefined,
        })
        const usedThreads = backend === 'wasm' ? ort.env.wasm.numThreads ?? 1 : 0
        const info: RvmInfo = {
          backend,
          precision,
          inputWidth,
          internalWidth: Math.min(internalWidth, inputWidth),
          threads: usedThreads,
          label: `RVM MobileNetV3 ${precision} (${backend}${backend === 'wasm' ? `, ${usedThreads} thread${usedThreads > 1 ? 's' : ''}` : ''})`,
        }
        const seg = new RvmSegmenter(session, info)
        // Aquecimento: valida que o backend realmente executa o grafo (WebGPU pode falhar só no run).
        try {
          await seg.warmup()
        } catch (e) {
          await session.release().catch(() => {})
          throw e
        }
        return seg
      } catch (e) {
        lastErr = e
        console.warn(`RVM ${precision}/${backend} falhou`, e)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private zeroStates(): Record<StateName, ort.Tensor> {
    const mk = () =>
      this.fp16
        ? new ort.Tensor('float16', new Uint16Array(1), [1, 1, 1, 1])
        : new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1])
    return { r1i: mk(), r2i: mk(), r3i: mk(), r4i: mk() }
  }

  private disposeStates() {
    for (const k of STATE_IN) {
      const t = this.states[k]
      if (t.location !== 'cpu') t.dispose()
    }
  }

  /** Esquece os quadros anteriores (chamar ao pular no tempo ou trocar de take). */
  reset() {
    this.disposeStates()
    this.states = this.zeroStates()
    this.lastTs = -Infinity
  }

  private async warmup() {
    const h = 64
    const w = 64
    const src = this.fp16 ? new Uint16Array(3 * h * w) : new Float32Array(3 * h * w)
    const feeds: Record<string, ort.Tensor> = {
      src: new ort.Tensor(this.fp16 ? 'float16' : 'float32', src, [1, 3, h, w]),
      downsample_ratio: new ort.Tensor('float32', new Float32Array([1]), [1]),
      ...this.states,
    }
    const out = await this.session.run(feeds)
    for (const k of Object.keys(out)) if (out[k].location !== 'cpu') out[k].dispose()
    this.reset()
  }

  /**
   * Gera a máscara (canvas RGBA: rgb=255, alfa=pha) para o quadro. `srcW/srcH` são as
   * dimensões exibidas da fonte. Se um quadro ainda estiver processando, devolve `lastMask`.
   * Timestamp menor que o anterior (busca para trás) zera os estados automaticamente.
   */
  async segment(source: CanvasImageSource, srcW: number, srcH: number, timestampMs: number): Promise<OffscreenCanvas | null> {
    if (this.closed) return null
    if (this.running) return this.lastMask
    this.running = true
    try {
      if (timestampMs < this.lastTs) this.reset()
      this.lastTs = timestampMs

      const w = this.inputW
      const h = Math.max(16, Math.round((w * srcH) / Math.max(1, srcW) / 16) * 16)
      if (this.input.height !== h || this.input.width !== w) {
        this.input.width = w
        this.input.height = h
        this.mask.width = w
        this.mask.height = h
        this.maskData = null
        this.srcData = null
        this.reset() // os estados têm forma dependente da resolução
      }
      this.inputCtx.drawImage(source, 0, 0, w, h)
      const rgba = this.inputCtx.getImageData(0, 0, w, h).data
      const n = w * h
      if (!this.srcData || this.srcData.length !== 3 * n) this.srcData = this.fp16 ? new Uint16Array(3 * n) : new Float32Array(3 * n)
      const src = this.srcData
      // RGBA entrelaçado -> CHW planar normalizado 0..1
      if (this.fp16) {
        // tabela de 256 entradas evita converter por pixel
        const lut = halfLut()
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          src[i] = lut[rgba[p]]
          src[n + i] = lut[rgba[p + 1]]
          src[2 * n + i] = lut[rgba[p + 2]]
        }
      } else {
        const k = 1 / 255
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          src[i] = rgba[p] * k
          src[n + i] = rgba[p + 1] * k
          src[2 * n + i] = rgba[p + 2] * k
        }
      }

      const feeds: Record<string, ort.Tensor> = {
        src: new ort.Tensor(this.fp16 ? 'float16' : 'float32', src, [1, 3, h, w]),
        downsample_ratio: this.ratio,
        ...this.states,
      }
      const out = await this.session.run(feeds)
      if (this.closed) {
        for (const k of Object.keys(out)) if (out[k].location !== 'cpu') out[k].dispose()
        return null
      }

      // realimenta os estados recorrentes
      this.disposeStates()
      this.states = { r1i: out[STATE_OUT[0]], r2i: out[STATE_OUT[1]], r3i: out[STATE_OUT[2]], r4i: out[STATE_OUT[3]] }
      if (out.fgr.location !== 'cpu') out.fgr.dispose()

      const pha = out.pha
      const ph = pha.dims[2]
      const pw = pha.dims[3]
      const pn = pw * ph
      if (!this.maskData || this.maskData.width !== pw || this.maskData.height !== ph) {
        this.maskData = new ImageData(pw, ph)
        this.maskData.data.fill(255)
        if (this.mask.width !== pw || this.mask.height !== ph) {
          this.mask.width = pw
          this.mask.height = ph
        }
      }
      const px = this.maskData.data
      const data = pha.data as Float32Array | Uint16Array
      if (pha.type === 'float16' && data instanceof Uint16Array) {
        for (let i = 0; i < pn; i++) {
          const v = halfToFloat(data[i])
          px[i * 4 + 3] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255
        }
      } else {
        for (let i = 0; i < pn; i++) {
          const v = data[i]
          px[i * 4 + 3] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255
        }
      }
      if (pha.location !== 'cpu') pha.dispose()
      this.maskCtx.putImageData(this.maskData, 0, 0)
      this.lastMask = this.mask
      return this.mask
    } finally {
      this.running = false
    }
  }

  close() {
    this.closed = true
    this.disposeStates()
    this.lastMask = null
    void this.session.release().catch(() => {})
  }
}

async function probeWebGpu(): Promise<{ ok: boolean; f16: boolean }> {
  try {
    const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined
    if (!gpu) return { ok: false, f16: false }
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { ok: false, f16: false }
    return { ok: true, f16: adapter.features.has('shader-f16') }
  } catch {
    return { ok: false, f16: false }
  }
}

/**
 * Baixa o modelo e, para WebGPU, zera o atributo `ceil_mode` dos 3 AveragePool do decodificador:
 * o kernel AveragePool do WebGPU no onnxruntime-web 1.30 lança erro se ceil_mode=1. Esses pools
 * (2x2, passo 2) operam na resolução de entrada, que é múltipla de 16, então ceil e floor dão o
 * mesmo resultado — o patch não muda a saída. Protobuf: `0a 09 "ceil_mode" 18 01` -> `18 00`.
 */
async function loadModel(url: string, patchCeilMode: boolean): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`falha ao baixar ${url}: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (!patchCeilMode) return bytes
  const needle = [0x0a, 0x09, 0x63, 0x65, 0x69, 0x6c, 0x5f, 0x6d, 0x6f, 0x64, 0x65, 0x18, 0x01] // \n\tceil_mode\x18\x01
  let patched = 0
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== 0x0a || bytes[i + 1] !== 0x09) continue
    for (let j = 2; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
    bytes[i + needle.length - 1] = 0x00
    patched++
  }
  if (patched === 0) console.warn('RVM: nenhum ceil_mode encontrado para corrigir (modelo diferente do esperado?)')
  return bytes
}

let halfLutCache: Uint16Array | null = null
function halfLut(): Uint16Array {
  if (!halfLutCache) {
    halfLutCache = new Uint16Array(256)
    for (let i = 0; i < 256; i++) halfLutCache[i] = toHalf(i / 255)
  }
  return halfLutCache
}
