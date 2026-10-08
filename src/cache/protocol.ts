/** Mensagens entre a thread principal e o worker de pré-cálculo de máscaras. */

/** Nome do modelo de segmentação usado no pré-cálculo (entra na chave do cache). */
export type MaskModel = 'mediapipe' | 'rvm'

export interface PrecomputeStart {
  type: 'start'
  jobId: number
  file: File
  key: string
  model: MaskModel
  /** Quadros por segundo da máscara (padrão 30) */
  fps: number
  /** Largura da máscara no cache (padrão 192) */
  maskWidth: number
  /** Largura máxima do quadro desenhado antes de segmentar (padrão 720; 0 = resolução de exibição) */
  inputWidth?: number
  /** Delegate do MediaPipe (padrão GPU; CPU é útil em máquinas sem GPU utilizável) */
  delegate?: 'GPU' | 'CPU'
}

export interface PrecomputeCancel {
  type: 'cancel'
  jobId: number
}

export type PrecomputeIn = PrecomputeStart | PrecomputeCancel

/** Tempo acumulado por etapa (ms), para diagnóstico. */
export interface StageTiming {
  decodeMs: number
  segmentMs: number
  writeMs: number
}

export type PrecomputeOut =
  | { type: 'progress'; jobId: number; frame: number; total: number }
  | { type: 'done'; jobId: number; key: string; frameCount: number; width: number; height: number; elapsedMs: number; timing: StageTiming }
  | { type: 'error'; jobId: number; message: string }
  | { type: 'cancelled'; jobId: number }
