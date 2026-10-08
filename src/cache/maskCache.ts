/**
 * Cache de máscaras de recorte no OPFS (Origin Private File System).
 *
 * Um arquivo por take em `masks/<key>`:
 *   cabeçalho fixo de 32 bytes (little-endian):
 *     0  u32 magic 'KMSK'
 *     4  u32 versão do formato
 *     8  u32 width
 *    12  u32 height
 *    16  f32 fps
 *    20  u32 frameCount (0 enquanto está sendo escrito)
 *    24  8 bytes reservados
 *   seguido de frameCount quadros contíguos de width*height bytes (1 byte por pixel = alfa).
 *
 * Funciona na thread principal e em workers.
 */

export const MASK_FORMAT_VERSION = 1
export const MASK_HEADER_BYTES = 32
export const DEFAULT_MASK_WIDTH = 192
const MAGIC = 0x4b4d534b // 'KMSK'
const DIR_NAME = 'masks'
const WRITE_BUFFER_BYTES = 2 * 1024 * 1024
const READER_LRU = 8

// ---- tipos mínimos do OPFS que faltam em lib.dom (sync access handle é só de worker) ----
interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}
type FileHandleEx = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }
type DirHandleEx = FileSystemDirectoryHandle & {
  keys(): AsyncIterableIterator<string>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

export interface MaskHeader {
  width: number
  height: number
  fps: number
  frameCount: number
}

/** Altura da máscara para um vídeo de proporção srcW:srcH, dada a largura do cache. */
export function maskHeightFor(srcW: number, srcH: number, maskWidth = DEFAULT_MASK_WIDTH): number {
  return Math.max(1, Math.round((maskWidth * srcH) / Math.max(1, srcW)))
}

/** Hash FNV-1a 32 bits (para encurtar o nome do arquivo sem colisões práticas). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Chave do cache derivada de (nome, tamanho, lastModified, modelo, versão do formato).
 * O resultado é seguro para usar como nome de arquivo.
 */
export function maskCacheKey(file: File, model: string): string {
  const base = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)
  const raw = `${file.name}|${file.size}|${file.lastModified}|${model}|v${MASK_FORMAT_VERSION}`
  const m = model.replace(/[^A-Za-z0-9._-]+/g, '_')
  return `${base}-${file.size}-${file.lastModified}-${m}-v${MASK_FORMAT_VERSION}-${fnv1a(raw)}`
}

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function'
}

let dirPromise: Promise<DirHandleEx> | null = null
async function masksDir(): Promise<DirHandleEx> {
  if (!dirPromise) {
    dirPromise = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(DIR_NAME, { create: true }) as Promise<DirHandleEx>)
    dirPromise.catch(() => {
      dirPromise = null
    })
  }
  return dirPromise
}

function encodeHeader(h: MaskHeader): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(MASK_HEADER_BYTES)
  const dv = new DataView(buf)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, MASK_FORMAT_VERSION, true)
  dv.setUint32(8, h.width, true)
  dv.setUint32(12, h.height, true)
  dv.setFloat32(16, h.fps, true)
  dv.setUint32(20, h.frameCount, true)
  return new Uint8Array(buf)
}

function decodeHeader(buf: ArrayBuffer): MaskHeader | null {
  if (buf.byteLength < MASK_HEADER_BYTES) return null
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== MAGIC) return null
  if (dv.getUint32(4, true) !== MASK_FORMAT_VERSION) return null
  const width = dv.getUint32(8, true)
  const height = dv.getUint32(12, true)
  const fps = dv.getFloat32(16, true)
  const frameCount = dv.getUint32(20, true)
  if (width === 0 || height === 0 || !(fps > 0)) return null
  return { width, height, fps, frameCount }
}

/** Lê e valida o cabeçalho de um arquivo de máscara (null se não existe ou está incompleto). */
async function readHeader(key: string): Promise<{ file: File; header: MaskHeader } | null> {
  try {
    const dir = await masksDir()
    const fh = await dir.getFileHandle(key)
    const file = await fh.getFile()
    const header = decodeHeader(await file.slice(0, MASK_HEADER_BYTES).arrayBuffer())
    if (!header || header.frameCount === 0) return null
    if (file.size < MASK_HEADER_BYTES + header.frameCount * header.width * header.height) return null
    return { file, header }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

export interface MaskWriterOptions {
  width: number
  height: number
  fps: number
}

/**
 * Escreve um arquivo de máscara em streaming. Em workers usa `createSyncAccessHandle`
 * (mais rápido); na thread principal usa `createWritable`. Faz buffer de ~2 MB entre writes.
 */
export class MaskWriter {
  readonly key: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly frameBytes: number
  private frameCount = 0
  private buffer: Uint8Array<ArrayBuffer>
  private used = 0
  private position = MASK_HEADER_BYTES
  private sync: SyncAccessHandle | null = null
  private writable: FileSystemWritableFileStream | null = null
  private closed = false

  private constructor(key: string, opts: MaskWriterOptions) {
    this.key = key
    this.width = opts.width
    this.height = opts.height
    this.fps = opts.fps
    this.frameBytes = opts.width * opts.height
    // buffer múltiplo do tamanho do quadro, ~2 MB
    const framesPerBuffer = Math.max(1, Math.floor(WRITE_BUFFER_BYTES / this.frameBytes))
    this.buffer = new Uint8Array(framesPerBuffer * this.frameBytes)
  }

  static async open(key: string, opts: MaskWriterOptions): Promise<MaskWriter> {
    const w = new MaskWriter(key, opts)
    const dir = await masksDir()
    const fh = (await dir.getFileHandle(key, { create: true })) as FileHandleEx
    const header = encodeHeader({ width: w.width, height: w.height, fps: w.fps, frameCount: 0 })
    if (typeof fh.createSyncAccessHandle === 'function') {
      try {
        w.sync = await fh.createSyncAccessHandle()
      } catch {
        w.sync = null
      }
    }
    if (w.sync) {
      w.sync.truncate(0)
      w.sync.write(header, { at: 0 })
    } else {
      w.writable = await fh.createWritable({ keepExistingData: false })
      await w.writable.write({ type: 'write', position: 0, data: header })
    }
    return w
  }

  get count(): number {
    return this.frameCount
  }

  private async flushBuffer() {
    if (this.used === 0) return
    const chunk = this.buffer.subarray(0, this.used)
    if (this.sync) {
      this.sync.write(chunk, { at: this.position })
    } else if (this.writable) {
      // copia: o stream pode reter o buffer até concluir a escrita
      await this.writable.write({ type: 'write', position: this.position, data: chunk.slice() })
    }
    this.position += this.used
    this.used = 0
  }

  /** Acrescenta um quadro (width*height bytes). O conteúdo é copiado; o chamador pode reutilizar o array. */
  async append(frame: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('MaskWriter já fechado')
    if (frame.length !== this.frameBytes) throw new Error(`Quadro com ${frame.length} bytes; esperado ${this.frameBytes}`)
    if (this.used + this.frameBytes > this.buffer.length) await this.flushBuffer()
    this.buffer.set(frame, this.used)
    this.used += this.frameBytes
    this.frameCount++
  }

  /** Grava o que falta, atualiza frameCount no cabeçalho e fecha. */
  async finish(): Promise<MaskHeader> {
    if (this.closed) throw new Error('MaskWriter já fechado')
    await this.flushBuffer()
    const header = encodeHeader({ width: this.width, height: this.height, fps: this.fps, frameCount: this.frameCount })
    if (this.sync) {
      this.sync.write(header, { at: 0 })
      this.sync.flush()
      this.sync.close()
      this.sync = null
    } else if (this.writable) {
      await this.writable.write({ type: 'write', position: 0, data: header })
      await this.writable.close()
      this.writable = null
    }
    this.closed = true
    return { width: this.width, height: this.height, fps: this.fps, frameCount: this.frameCount }
  }

  /** Descarta a escrita e apaga o arquivo. */
  async abort(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (this.sync) {
        this.sync.close()
        this.sync = null
      } else if (this.writable) {
        await this.writable.abort()
        this.writable = null
      }
    } catch {
      /* ignora */
    }
    await deleteMask(this.key)
  }
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Lê quadros de um arquivo de máscara por slice do File (sem carregar tudo), com LRU dos
 * últimos quadros. `peek`/`peekCanvas` são síncronos para o loop de render não esperar.
 */
export class MaskReader {
  readonly key: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly frameCount: number
  readonly frameBytes: number
  /** Tamanho do arquivo em disco (bytes) */
  readonly byteLength: number
  private file: File
  private lru = new Map<number, Uint8Array>()
  private inflight = new Map<number, Promise<Uint8Array | null>>()
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  private imageData: ImageData | null = null
  private canvasFrame = -1

  private constructor(key: string, file: File, h: MaskHeader) {
    this.key = key
    this.file = file
    this.width = h.width
    this.height = h.height
    this.fps = h.fps
    this.frameCount = h.frameCount
    this.frameBytes = h.width * h.height
    this.byteLength = file.size
  }

  static async open(key: string): Promise<MaskReader | null> {
    const r = await readHeader(key)
    if (!r) return null
    return new MaskReader(key, r.file, r.header)
  }

  get duration(): number {
    return this.frameCount / this.fps
  }

  /** Índice do quadro mais próximo do tempo (limitado ao intervalo válido). */
  frameIndex(timeSec: number): number {
    const i = Math.round(timeSec * this.fps)
    return i < 0 ? 0 : i >= this.frameCount ? this.frameCount - 1 : i
  }

  private touch(index: number, bytes: Uint8Array) {
    this.lru.delete(index)
    this.lru.set(index, bytes)
    while (this.lru.size > READER_LRU) {
      const oldest = this.lru.keys().next().value as number
      this.lru.delete(oldest)
    }
  }

  /** Quadro no índice (bytes de alfa, width*height). Não modifique o array devolvido. */
  async frameAtIndex(index: number): Promise<Uint8Array | null> {
    if (index < 0 || index >= this.frameCount) return null
    const cached = this.lru.get(index)
    if (cached) {
      this.touch(index, cached)
      return cached
    }
    let p = this.inflight.get(index)
    if (!p) {
      const start = MASK_HEADER_BYTES + index * this.frameBytes
      p = this.file
        .slice(start, start + this.frameBytes)
        .arrayBuffer()
        .then((buf) => {
          if (buf.byteLength !== this.frameBytes) return null
          const bytes = new Uint8Array(buf)
          this.touch(index, bytes)
          return bytes
        })
        .finally(() => this.inflight.delete(index))
      this.inflight.set(index, p)
    }
    return p
  }

  /** Quadro mais próximo do tempo (segundos no arquivo original). */
  frameAt(timeSec: number): Promise<Uint8Array | null> {
    if (this.frameCount === 0) return Promise.resolve(null)
    return this.frameAtIndex(this.frameIndex(timeSec))
  }

  /** Dispara a leitura do quadro sem esperar (para o render chamar `peek` depois). */
  prefetch(timeSec: number): void {
    void this.frameAt(timeSec)
  }

  /** Síncrono: devolve o quadro se ele já estiver em memória, senão null. */
  peek(timeSec: number): Uint8Array | null {
    if (this.frameCount === 0) return null
    return this.lru.get(this.frameIndex(timeSec)) ?? null
  }

  private ensureCanvas(): OffscreenCanvasRenderingContext2D {
    if (!this.canvas || !this.ctx || !this.imageData) {
      this.canvas = new OffscreenCanvas(this.width, this.height)
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
      this.imageData = new ImageData(this.width, this.height)
      this.imageData.data.fill(255)
      this.canvasFrame = -1
    }
    return this.ctx
  }

  private paint(index: number, bytes: Uint8Array): OffscreenCanvas {
    const ctx = this.ensureCanvas()
    if (this.canvasFrame !== index) {
      const px = this.imageData!.data
      for (let i = 0, j = 3; i < bytes.length; i++, j += 4) px[j] = bytes[i]
      ctx.putImageData(this.imageData!, 0, 0)
      this.canvasFrame = index
    }
    return this.canvas!
  }

  /**
   * Canvas RGBA (rgb=255, alfa=máscara) do quadro mais próximo do tempo. Reutiliza um único
   * canvas interno: não guarde a referência entre quadros.
   */
  async canvasAt(timeSec: number): Promise<OffscreenCanvas | null> {
    if (this.frameCount === 0) return null
    const index = this.frameIndex(timeSec)
    const bytes = await this.frameAtIndex(index)
    return bytes ? this.paint(index, bytes) : null
  }

  /** Síncrono: canvas do quadro se ele já estiver em memória, senão null (dispara prefetch). */
  peekCanvas(timeSec: number): OffscreenCanvas | null {
    if (this.frameCount === 0) return null
    const index = this.frameIndex(timeSec)
    const bytes = this.lru.get(index)
    if (!bytes) {
      void this.frameAtIndex(index)
      return null
    }
    return this.paint(index, bytes)
  }

  /** Libera a memória do LRU e do canvas interno. */
  close(): void {
    this.lru.clear()
    this.canvas = null
    this.ctx = null
    this.imageData = null
    this.canvasFrame = -1
  }
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/** true se existe uma máscara completa (cabeçalho válido e frameCount > 0) para a chave. */
export async function hasMask(key: string): Promise<boolean> {
  return (await readHeader(key)) !== null
}

export async function deleteMask(key: string): Promise<void> {
  try {
    const dir = await masksDir()
    await dir.removeEntry(key)
  } catch {
    /* não existia */
  }
}

export interface MaskEntry {
  key: string
  bytes: number
  header: MaskHeader | null
}

/** Lista os arquivos do diretório de máscaras (inclui incompletos, com header null). */
export async function listMasks(): Promise<MaskEntry[]> {
  const out: MaskEntry[] = []
  try {
    const dir = await masksDir()
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue
      const file = await (handle as FileSystemFileHandle).getFile()
      const header = decodeHeader(await file.slice(0, MASK_HEADER_BYTES).arrayBuffer())
      out.push({ key: name, bytes: file.size, header: header && header.frameCount > 0 ? header : null })
    }
  } catch {
    /* OPFS indisponível */
  }
  return out
}

/** Bytes ocupados pelo cache de máscaras. */
export async function maskStorageUsage(): Promise<number> {
  const list = await listMasks()
  return list.reduce((s, e) => s + e.bytes, 0)
}

/** Apaga todas as máscaras cuja chave não está em `keepKeys`. Devolve as chaves removidas. */
export async function pruneMasks(keepKeys: string[]): Promise<string[]> {
  const keep = new Set(keepKeys)
  const removed: string[] = []
  for (const e of await listMasks()) {
    if (keep.has(e.key)) continue
    await deleteMask(e.key)
    removed.push(e.key)
  }
  return removed
}

// ---------------------------------------------------------------------------
// Conversão de canvas de máscara → bytes
// ---------------------------------------------------------------------------

export interface MaskScratch {
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  out: Uint8Array
}

export function createMaskScratch(width: number, height: number): MaskScratch {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return { canvas, ctx, out: new Uint8Array(width * height) }
}

/**
 * Converte um canvas de máscara (alfa = pessoa, como o do Segmenter) em bytes de alfa na resolução
 * do cache. Devolve o buffer de `scratch.out` (reutilizado: copie se precisar guardar).
 */
export function maskCanvasToBytes(canvas: CanvasImageSource, width: number, height: number, scratch: MaskScratch): Uint8Array {
  if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
    scratch.canvas.width = width
    scratch.canvas.height = height
    scratch.out = new Uint8Array(width * height)
  }
  const { ctx } = scratch
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(canvas, 0, 0, width, height)
  const px = ctx.getImageData(0, 0, width, height).data
  const out = scratch.out
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = px[j]
  return out
}
