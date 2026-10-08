/**
 * Motor do benchmark: roda MediaPipe (Segmenter) e RVM (RvmSegmenter) no mesmo quadro.
 * Usado tanto na thread principal (src/bench/main.ts) quanto dentro do worker (src/bench/worker.ts).
 */
import { Segmenter, type SegModel } from '../render/segmenter'
import { RvmSegmenter, type RvmBackend, type RvmPrecision } from '../render/rvm'

export interface BenchInitOptions {
  rvmBackend: RvmBackend
  rvmPrecision?: RvmPrecision
  rvmInputWidth: number
  rvmThreads?: number
  rvmGpuStates?: boolean
  mpDelegate: 'GPU' | 'CPU'
  mpModel: SegModel
  /** false = só RVM (útil quando o MediaPipe não inicializa no ambiente) */
  runMediaPipe: boolean
}

export interface BenchInitInfo {
  mediapipe: string | null
  rvm: string
  rvmInfo: RvmSegmenter['info']
  mpError: string | null
}

export interface BenchFrameResult {
  mpMs: number
  rvmMs: number
  /** Máscaras em RGBA (alfa = pessoa), já na resolução do modelo. */
  mp: ImageBitmap | null
  rvm: ImageBitmap | null
}

export class BenchEngine {
  private mp: Segmenter | null = null
  private rvm: RvmSegmenter | null = null

  async init(opts: BenchInitOptions): Promise<BenchInitInfo> {
    let mpError: string | null = null
    if (opts.runMediaPipe) {
      try {
        this.mp = await Segmenter.create(opts.mpDelegate, opts.mpModel)
      } catch (e) {
        mpError = e instanceof Error ? e.message : String(e)
        console.warn('MediaPipe indisponível no bench', e)
      }
    }
    this.rvm = await RvmSegmenter.create({ backend: opts.rvmBackend, precision: opts.rvmPrecision, inputWidth: opts.rvmInputWidth, threads: opts.rvmThreads, gpuStates: opts.rvmGpuStates })
    return {
      mediapipe: this.mp ? `MediaPipe ${this.mp.info.model} (${this.mp.info.delegate})` : null,
      rvm: this.rvm.info.label,
      rvmInfo: this.rvm.info,
      mpError,
    }
  }

  reset() {
    this.mp?.reset()
    this.rvm?.reset()
  }

  async frame(source: CanvasImageSource, w: number, h: number, tsMs: number): Promise<BenchFrameResult> {
    let mpMs = 0
    let mpMask: OffscreenCanvas | null = null
    if (this.mp) {
      const t0 = performance.now()
      mpMask = this.mp.segment(source, w, h, tsMs)
      mpMs = performance.now() - t0
    }
    const t1 = performance.now()
    const rvmMask = this.rvm ? await this.rvm.segment(source, w, h, tsMs) : null
    const rvmMs = performance.now() - t1
    // copia as máscaras (os canvases são reutilizados pelos segmentadores)
    const [mp, rvm] = await Promise.all([
      mpMask ? createImageBitmap(mpMask) : null,
      rvmMask ? createImageBitmap(rvmMask) : null,
    ])
    return { mpMs, rvmMs, mp, rvm }
  }

  close() {
    this.mp?.close()
    this.rvm?.close()
    this.mp = null
    this.rvm = null
  }
}
