import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

const WASM_PATH = '/mediapipe'
const MODEL_PATH = '/models/selfie_segmenter.tflite'
/** Largura do quadro reduzido enviado ao modelo (mantém a proporção) */
const INPUT_W = 256

/**
 * Em Web Workers de módulo não existe importScripts, e o carregador do MediaPipe precisa dele.
 * Este polyfill busca o script de forma síncrona e executa no escopo global.
 */
function ensureImportScripts() {
  const g = globalThis as unknown as { importScripts?: (...urls: string[]) => void; document?: unknown; __kolImportScripts?: boolean }
  if (typeof g.document !== 'undefined' || g.__kolImportScripts) return
  // Em worker de módulo, importScripts existe mas lança TypeError; substituímos pela versão síncrona.
  g.__kolImportScripts = true
  g.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', url, false)
      xhr.send()
      if (xhr.status < 200 || xhr.status >= 300) throw new Error(`importScripts falhou: ${url}`)
      // eslint-disable-next-line no-eval -- carregador Emscripten do MediaPipe precisa rodar no escopo global do worker
      ;(0, eval)(xhr.responseText)
    }
  }
}

export interface SegmenterInfo {
  delegate: 'GPU' | 'CPU'
}

export class Segmenter {
  private segmenter: ImageSegmenter
  private input: OffscreenCanvas
  private inputCtx: OffscreenCanvasRenderingContext2D
  private mask: OffscreenCanvas
  private maskCtx: OffscreenCanvasRenderingContext2D
  private imageData: ImageData | null = null
  private lastTs = -1
  /** 1 = último mapa é a pessoa, 0 = primeiro; -1 = ainda não decidido */
  private personIndex = -1
  readonly info: SegmenterInfo

  private constructor(segmenter: ImageSegmenter, info: SegmenterInfo) {
    this.segmenter = segmenter
    this.info = info
    this.input = new OffscreenCanvas(INPUT_W, INPUT_W)
    this.inputCtx = this.input.getContext('2d', { willReadFrequently: false })!
    this.mask = new OffscreenCanvas(INPUT_W, INPUT_W)
    this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true })!
  }

  static async create(preferred: 'GPU' | 'CPU' = 'GPU'): Promise<Segmenter> {
    ensureImportScripts()
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
    const tryCreate = (delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
        canvas: typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : undefined,
      })
    try {
      const s = await tryCreate(preferred)
      return new Segmenter(s, { delegate: preferred })
    } catch (e) {
      if (preferred === 'GPU') {
        console.warn('MediaPipe GPU falhou, usando CPU', e)
        const s = await tryCreate('CPU')
        return new Segmenter(s, { delegate: 'CPU' })
      }
      throw e
    }
  }

  /**
   * Gera a máscara (canvas com alfa) para o quadro. `srcW/srcH` são as dimensões exibidas da fonte.
   * O timestamp deve ser crescente (ms).
   */
  segment(source: CanvasImageSource, srcW: number, srcH: number, timestampMs: number): OffscreenCanvas | null {
    const h = Math.max(16, Math.round((INPUT_W * srcH) / Math.max(1, srcW)))
    if (this.input.height !== h) {
      this.input.height = h
      this.mask.height = h
      this.imageData = null
    }
    this.inputCtx.drawImage(source, 0, 0, INPUT_W, h)
    const ts = timestampMs <= this.lastTs ? this.lastTs + 1 : timestampMs
    this.lastTs = ts
    const result = this.segmenter.segmentForVideo(this.input, ts)
    const masks = result.confidenceMasks
    if (!masks || masks.length === 0) {
      result.close()
      return null
    }
    try {
      let idx = masks.length - 1
      if (masks.length > 1) {
        if (this.personIndex < 0) this.personIndex = this.detectPersonIndex(masks.map((m) => m.getAsFloat32Array()))
        idx = this.personIndex
      }
      const data = masks[idx].getAsFloat32Array()
      const mw = masks[idx].width
      const mh = masks[idx].height
      if (!this.imageData || this.imageData.width !== mw || this.imageData.height !== mh) {
        this.imageData = new ImageData(mw, mh)
        this.imageData.data.fill(255)
        if (this.mask.width !== mw || this.mask.height !== mh) {
          this.mask.width = mw
          this.mask.height = mh
        }
      }
      const px = this.imageData.data
      for (let i = 0; i < data.length; i++) {
        // smoothstep entre 0.35 e 0.65 para borda suave sem "neblina"
        let v = (data[i] - 0.35) / 0.3
        v = v < 0 ? 0 : v > 1 ? 1 : v
        v = v * v * (3 - 2 * v)
        px[i * 4 + 3] = v * 255
      }
      this.maskCtx.putImageData(this.imageData, 0, 0)
      return this.mask
    } finally {
      result.close()
    }
  }

  /** Quando há 2 mapas, decide qual é a pessoa: a pessoa tende a ocupar o centro-inferior do quadro. */
  private detectPersonIndex(maps: Float32Array[]): number {
    const w = this.input.width
    const h = this.input.height
    const score = (m: Float32Array) => {
      let s = 0
      let n = 0
      for (let y = Math.floor(h * 0.6); y < h; y++) {
        for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x++) {
          s += m[y * w + x]
          n++
        }
      }
      let corner = 0
      let cn = 0
      for (let y = 0; y < Math.floor(h * 0.15); y++) {
        for (let x = 0; x < Math.floor(w * 0.15); x++) {
          corner += m[y * w + x]
          cn++
        }
      }
      return s / Math.max(1, n) - corner / Math.max(1, cn)
    }
    let best = 0
    let bestScore = -Infinity
    maps.forEach((m, i) => {
      const sc = score(m)
      if (sc > bestScore) {
        bestScore = sc
        best = i
      }
    })
    return best
  }

  close() {
    this.segmenter.close()
  }
}
