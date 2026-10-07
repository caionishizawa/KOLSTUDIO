import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

const WASM_PATH = '/mediapipe'
/** Modelo multiclasse (cabelo, pele, roupa...): borda bem melhor que o modelo pequeno. */
const MODEL_MULTICLASS = '/models/selfie_multiclass_256x256.tflite'
/** Modelo pequeno, usado se o multiclasse falhar. */
const MODEL_SMALL = '/models/selfie_segmenter.tflite'
/** Largura do quadro reduzido enviado ao modelo (mantém a proporção) */
const INPUT_W = 256

export type SegModel = 'multiclass' | 'small'

/** Parâmetros de limpeza da máscara */
const TEMPORAL_ALPHA = 0.6 // peso do quadro atual na média com o anterior (1 = sem suavização)
const THRESH_LO = 0.45 // começa a aparecer
const THRESH_HI = 0.8 // totalmente opaco
const MIN_COMPONENT_RATIO = 0.25 // manchas menores que 25% da maior área são apagadas

/**
 * Em Web Workers de módulo o importScripts nativo lança TypeError e o carregador do MediaPipe
 * cai num import() que não funciona com o Vite. Substituímos por uma versão síncrona.
 */
function ensureImportScripts() {
  const g = globalThis as unknown as { importScripts?: (...urls: string[]) => void; document?: unknown; __kolImportScripts?: boolean }
  if (typeof g.document !== 'undefined' || g.__kolImportScripts) return
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
  model: SegModel
}

export class Segmenter {
  private segmenter: ImageSegmenter
  private input: OffscreenCanvas
  private inputCtx: OffscreenCanvasRenderingContext2D
  private mask: OffscreenCanvas
  private maskCtx: OffscreenCanvasRenderingContext2D
  private imageData: ImageData | null = null
  private prev: Float32Array | null = null
  private work: Float32Array | null = null
  private labels: Int32Array | null = null
  private stack: Int32Array | null = null
  private lastTs = -1
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

  static async create(preferred: 'GPU' | 'CPU' = 'GPU', model: SegModel = 'multiclass'): Promise<Segmenter> {
    ensureImportScripts()
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
    const tryCreate = (delegate: 'GPU' | 'CPU', m: SegModel) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: m === 'multiclass' ? MODEL_MULTICLASS : MODEL_SMALL, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
        canvas: typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : undefined,
      })
    const attempts: [typeof preferred, SegModel][] = [
      [preferred, model],
      [preferred, model === 'multiclass' ? 'small' : 'multiclass'],
      ['CPU', model],
      ['CPU', 'small'],
    ]
    let lastErr: unknown = null
    for (const [delegate, m] of attempts) {
      try {
        const s = await tryCreate(delegate, m)
        return new Segmenter(s, { delegate, model: m })
      } catch (e) {
        lastErr = e
        console.warn(`MediaPipe ${m}/${delegate} falhou`, e)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /** Esquece o quadro anterior (chamar ao pular no tempo ou trocar de take). */
  reset() {
    this.prev = null
  }

  /**
   * Gera a máscara (canvas com alfa) para o quadro. `srcW/srcH` são as dimensões exibidas da fonte.
   * O timestamp deve ser crescente (ms).
   */
  segment(source: CanvasImageSource, srcW: number, srcH: number, timestampMs: number): OffscreenCanvas | null {
    const w = INPUT_W
    const h = Math.max(16, Math.round((INPUT_W * srcH) / Math.max(1, srcW)))
    if (this.input.height !== h) {
      this.input.height = h
      this.mask.height = h
      this.imageData = null
      this.prev = null
    }
    this.inputCtx.drawImage(source, 0, 0, w, h)
    const ts = timestampMs <= this.lastTs ? this.lastTs + 1 : timestampMs
    this.lastTs = ts
    const result = this.segmenter.segmentForVideo(this.input, ts)
    const masks = result.confidenceMasks
    if (!masks || masks.length === 0) {
      result.close()
      return null
    }
    try {
      const mw = masks[0].width
      const mh = masks[0].height
      const n = mw * mh
      if (!this.work || this.work.length !== n) {
        this.work = new Float32Array(n)
        this.labels = new Int32Array(n)
        this.stack = new Int32Array(n)
        this.prev = null
      }
      const cur = this.work
      if (masks.length >= 6) {
        // multiclasse: pessoa = 1 - fundo
        const bg = masks[0].getAsFloat32Array()
        for (let i = 0; i < n; i++) cur[i] = 1 - bg[i]
      } else if (masks.length > 1) {
        if (this.personIndex < 0) this.personIndex = this.detectPersonIndex(masks.map((m) => m.getAsFloat32Array()), mw, mh)
        cur.set(masks[this.personIndex].getAsFloat32Array())
      } else {
        cur.set(masks[0].getAsFloat32Array())
      }

      // 1) suavização temporal (tira o tremido entre quadros)
      if (this.prev && this.prev.length === n) {
        const a = TEMPORAL_ALPHA
        const b = 1 - a
        const p = this.prev
        for (let i = 0; i < n; i++) {
          const v = a * cur[i] + b * p[i]
          cur[i] = v
          p[i] = v
        }
      } else {
        this.prev = Float32Array.from(cur)
      }

      // 2) borrão 3x3 (tira pontinhos isolados e serrilhado)
      boxBlur3(cur, mw, mh)

      // 3) só a área principal da pessoa: apaga manchas soltas
      keepMainComponents(cur, mw, mh, this.labels!, this.stack!)

      // 4) alfa com borda suave
      if (!this.imageData || this.imageData.width !== mw || this.imageData.height !== mh) {
        this.imageData = new ImageData(mw, mh)
        this.imageData.data.fill(255)
        if (this.mask.width !== mw || this.mask.height !== mh) {
          this.mask.width = mw
          this.mask.height = mh
        }
      }
      const px = this.imageData.data
      const range = THRESH_HI - THRESH_LO
      for (let i = 0; i < n; i++) {
        let v = (cur[i] - THRESH_LO) / range
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
  private detectPersonIndex(maps: Float32Array[], w: number, h: number): number {
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

let blurTmp: Float32Array | null = null

/** Borrão de caixa 3x3 separável, in-place. */
function boxBlur3(m: Float32Array, w: number, h: number) {
  const n = w * h
  if (!blurTmp || blurTmp.length !== n) blurTmp = new Float32Array(n)
  const t = blurTmp
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? m[row + x - 1] : m[row + x]
      const r = x < w - 1 ? m[row + x + 1] : m[row + x]
      t[row + x] = (l + m[row + x] + r) / 3
    }
  }
  for (let y = 0; y < h; y++) {
    const up = y > 0 ? (y - 1) * w : y * w
    const dn = y < h - 1 ? (y + 1) * w : y * w
    const row = y * w
    for (let x = 0; x < w; x++) m[row + x] = (t[up + x] + t[row + x] + t[dn + x]) / 3
  }
}

/**
 * Rotula componentes conexos acima de 0.5 e zera os que forem bem menores que o maior,
 * e também a "névoa" fraca que não encosta em nenhum componente mantido.
 * Mantém só a área principal da pessoa (apaga pedaço de cadeira, objeto atrás, etc.).
 */
function keepMainComponents(m: Float32Array, w: number, h: number, labels: Int32Array, stack: Int32Array) {
  const n = w * h
  labels.fill(0)
  const sizes: number[] = [0]
  let label = 0
  for (let i = 0; i < n; i++) {
    if (labels[i] !== 0 || m[i] <= 0.5) continue
    label++
    let size = 0
    let sp = 0
    stack[sp++] = i
    labels[i] = label
    while (sp > 0) {
      const p = stack[--sp]
      size++
      const x = p % w
      const y = (p - x) / w
      if (x > 0 && labels[p - 1] === 0 && m[p - 1] > 0.5) {
        labels[p - 1] = label
        stack[sp++] = p - 1
      }
      if (x < w - 1 && labels[p + 1] === 0 && m[p + 1] > 0.5) {
        labels[p + 1] = label
        stack[sp++] = p + 1
      }
      if (y > 0 && labels[p - w] === 0 && m[p - w] > 0.5) {
        labels[p - w] = label
        stack[sp++] = p - w
      }
      if (y < h - 1 && labels[p + w] === 0 && m[p + w] > 0.5) {
        labels[p + w] = label
        stack[sp++] = p + w
      }
    }
    sizes.push(size)
  }
  if (label === 0) return
  let largest = 0
  for (let l = 1; l <= label; l++) if (sizes[l] > largest) largest = sizes[l]
  const minSize = largest * MIN_COMPONENT_RATIO
  const keep = new Uint8Array(label + 1)
  for (let l = 1; l <= label; l++) keep[l] = sizes[l] >= minSize ? 1 : 0
  for (let i = 0; i < n; i++) {
    const l = labels[i]
    if (l !== 0 && !keep[l]) m[i] = 0
  }
  // névoa fraca longe de componentes mantidos
  for (let i = 0; i < n; i++) {
    if (labels[i] !== 0 || m[i] <= 0) continue
    const x = i % w
    const y = (i - x) / w
    let near = false
    for (let dy = -2; dy <= 2 && !near; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const l = labels[yy * w + xx]
        if (l !== 0 && keep[l]) {
          near = true
          break
        }
      }
    }
    if (!near) m[i] = 0
  }
}
