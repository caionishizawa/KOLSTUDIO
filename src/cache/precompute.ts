/**
 * API da thread principal para o pré-cálculo de máscaras: fila de um job por vez num único
 * worker (reaproveitado entre jobs para não recarregar o modelo).
 */
import { DEFAULT_MASK_WIDTH, hasMask } from './maskCache'
import type { MaskModel, PrecomputeOut } from './protocol'

export type { MaskModel } from './protocol'

export type MaskJobStatus = 'queued' | 'running' | 'done' | 'error'

export interface MaskJobOptions {
  model?: MaskModel
  fps?: number
  maskWidth?: number
  /** Largura máxima do quadro desenhado antes de segmentar (0 = resolução de exibição) */
  inputWidth?: number
  /** Recalcula mesmo que a chave já exista */
  force?: boolean
}

export interface MaskJobResult {
  key: string
  frameCount: number
  width: number
  height: number
  elapsedMs: number
  /** true quando a máscara já existia e o job foi pulado */
  cached: boolean
}

export interface MaskPrecomputerCallbacks {
  onProgress?: (key: string, frame: number, total: number) => void
  onDone?: (result: MaskJobResult) => void
  onError?: (key: string, message: string) => void
  /** Mudança de status de qualquer job (para a UI) */
  onStatus?: (key: string, status: MaskJobStatus | null) => void
}

interface Job {
  id: number
  key: string
  file: File
  opts: Required<Pick<MaskJobOptions, 'model' | 'fps' | 'maskWidth'>> & { inputWidth?: number; force: boolean }
  resolve: (r: MaskJobResult) => void
  reject: (e: Error) => void
  progress: { frame: number; total: number }
}

export class MaskPrecomputer {
  private worker: Worker | null = null
  private queue: Job[] = []
  private running: Job | null = null
  private statuses = new Map<string, MaskJobStatus>()
  private errors = new Map<string, string>()
  private nextId = 1
  private cb: MaskPrecomputerCallbacks

  constructor(callbacks: MaskPrecomputerCallbacks = {}) {
    this.cb = callbacks
  }

  /** Status do job da chave (null se nunca foi enfileirada nesta sessão). */
  status(key: string): MaskJobStatus | null {
    return this.statuses.get(key) ?? null
  }

  /** Mensagem do último erro da chave. */
  error(key: string): string | null {
    return this.errors.get(key) ?? null
  }

  /** Progresso do job em execução (ou null). */
  progress(key: string): { frame: number; total: number } | null {
    return this.running?.key === key ? this.running.progress : null
  }

  /** Chaves na fila (sem contar a que está rodando). */
  pending(): string[] {
    return this.queue.map((j) => j.key)
  }

  private setStatus(key: string, status: MaskJobStatus | null) {
    if (status) this.statuses.set(key, status)
    else this.statuses.delete(key)
    this.cb.onStatus?.(key, status)
  }

  /**
   * Enfileira o cálculo da máscara. Se a chave já está no cache (e não é `force`), resolve
   * imediatamente com `cached: true`. Se já está na fila/rodando, devolve a promessa do job existente.
   */
  async enqueue(file: File, key: string, opts: MaskJobOptions = {}): Promise<MaskJobResult> {
    const existing = this.running?.key === key ? this.running : this.queue.find((j) => j.key === key)
    if (existing) return new Promise<MaskJobResult>((resolve, reject) => chain(existing, resolve, reject))

    if (!opts.force && (await hasMask(key))) {
      this.setStatus(key, 'done')
      const r: MaskJobResult = { key, frameCount: 0, width: 0, height: 0, elapsedMs: 0, cached: true }
      this.cb.onDone?.(r)
      return r
    }

    return new Promise<MaskJobResult>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        key,
        file,
        opts: {
          model: opts.model ?? 'mediapipe',
          fps: opts.fps ?? 30,
          maskWidth: opts.maskWidth ?? DEFAULT_MASK_WIDTH,
          inputWidth: opts.inputWidth,
          force: !!opts.force,
        },
        resolve,
        reject,
        progress: { frame: 0, total: 0 },
      }
      this.queue.push(job)
      this.errors.delete(key)
      this.setStatus(key, 'queued')
      this.pump()
    })
  }

  /** Cancela o job da chave (na fila ou em execução). */
  cancel(key: string): void {
    const qi = this.queue.findIndex((j) => j.key === key)
    if (qi >= 0) {
      const [job] = this.queue.splice(qi, 1)
      this.setStatus(key, null)
      job.reject(new Error('cancelado'))
      return
    }
    if (this.running?.key === key && this.worker) {
      this.worker.postMessage({ type: 'cancel', jobId: this.running.id })
    }
  }

  /** Cancela tudo e encerra o worker. */
  dispose(): void {
    for (const job of this.queue.splice(0)) {
      this.setStatus(job.key, null)
      job.reject(new Error('cancelado'))
    }
    if (this.running) {
      const job = this.running
      this.running = null
      this.setStatus(job.key, null)
      job.reject(new Error('cancelado'))
    }
    this.worker?.terminate()
    this.worker = null
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./precompute.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<PrecomputeOut>) => this.handle(ev.data)
    worker.onerror = (ev) => {
      const job = this.running
      if (job) this.finishJob(job, 'error', ev.message || 'Falha no worker de máscaras')
      // worker em estado desconhecido: recria no próximo job
      this.worker?.terminate()
      this.worker = null
      this.pump()
    }
    this.worker = worker
    return worker
  }

  private pump() {
    if (this.running || this.queue.length === 0) return
    const job = this.queue.shift()!
    this.running = job
    this.setStatus(job.key, 'running')
    this.ensureWorker().postMessage({
      type: 'start',
      jobId: job.id,
      file: job.file,
      key: job.key,
      model: job.opts.model,
      fps: job.opts.fps,
      maskWidth: job.opts.maskWidth,
      inputWidth: job.opts.inputWidth,
    })
  }

  private handle(msg: PrecomputeOut) {
    const job = this.running
    if (!job || msg.jobId !== job.id) return
    if (msg.type === 'progress') {
      job.progress = { frame: msg.frame, total: msg.total }
      this.cb.onProgress?.(job.key, msg.frame, msg.total)
      return
    }
    if (msg.type === 'done') {
      const r: MaskJobResult = { key: msg.key, frameCount: msg.frameCount, width: msg.width, height: msg.height, elapsedMs: msg.elapsedMs, cached: false }
      this.running = null
      this.setStatus(job.key, 'done')
      job.resolve(r)
      this.cb.onDone?.(r)
    } else if (msg.type === 'error') {
      this.finishJob(job, 'error', msg.message)
    } else if (msg.type === 'cancelled') {
      this.finishJob(job, null, 'cancelado')
    }
    this.pump()
  }

  private finishJob(job: Job, status: MaskJobStatus | null, message: string) {
    if (this.running === job) this.running = null
    if (status === 'error') this.errors.set(job.key, message)
    this.setStatus(job.key, status)
    job.reject(new Error(message))
    if (status === 'error') this.cb.onError?.(job.key, message)
  }
}

/** Encadeia um segundo chamador na promessa de um job já existente. */
function chain(job: Job, resolve: (r: MaskJobResult) => void, reject: (e: Error) => void) {
  const r0 = job.resolve
  const j0 = job.reject
  job.resolve = (r) => {
    r0(r)
    resolve(r)
  }
  job.reject = (e) => {
    j0(e)
    reject(e)
  }
}
