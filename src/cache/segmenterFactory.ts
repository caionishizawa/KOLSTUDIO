import { Segmenter } from '../render/segmenter'
import type { MaskModel } from './protocol'

/**
 * Interface mínima que o worker de pré-cálculo usa. `segment` pode ser síncrono (MediaPipe)
 * ou devolver Promise (modelos ONNX como o RVM).
 */
export interface MaskSegmenter {
  /** Descrição curta para log (ex.: "mediapipe multiclass/GPU") */
  readonly label: string
  /** Esquece o estado temporal (chamar no início de cada take). */
  reset(): void
  /** Máscara do quadro: canvas com alfa = pessoa, ou null se o modelo não devolveu nada. */
  segment(source: CanvasImageSource, srcW: number, srcH: number, timestampMs: number): OffscreenCanvas | null | Promise<OffscreenCanvas | null>
  close(): void
}

/** Cria o segmentador pelo nome do modelo. Para plugar outro (ex.: RVM), acrescente um case. */
export async function createSegmenter(model: MaskModel): Promise<MaskSegmenter> {
  switch (model) {
    case 'mediapipe': {
      const seg = await Segmenter.create('GPU', 'multiclass')
      return {
        label: `mediapipe ${seg.info.model}/${seg.info.delegate}`,
        reset: () => seg.reset(),
        segment: (source, w, h, ts) => seg.segment(source, w, h, ts),
        close: () => seg.close(),
      }
    }
    default:
      throw new Error(`Modelo de segmentação desconhecido: ${String(model)}`)
  }
}
