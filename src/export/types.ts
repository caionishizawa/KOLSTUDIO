import type { Project, Timeline } from '../types'

export interface ExportAsset {
  id: string
  name: string
  type: 'video' | 'image' | 'audio'
  file: File
  width?: number
  height?: number
  duration?: number
}

export interface ExportJob {
  project: Project
  timeline: Timeline
  assets: Record<string, ExportAsset>
  /** ganho de voz por asset (takes e clipe) */
  gains: Record<string, number>
  fileName: string
  /** Só para testes: 'vp9' usa VP9+Opus quando o navegador não tem H.264/AAC */
  debugCodec?: 'vp9'
}

export type WorkerIn =
  | { type: 'start'; job: ExportJob; handle: FileSystemFileHandle | null }
  | { type: 'cancel' }

export type WorkerOut =
  | { type: 'progress'; stage: string; frame: number; totalFrames: number; elapsedMs: number }
  | { type: 'info'; text: string }
  | { type: 'done'; buffer: ArrayBuffer | null }
  | { type: 'error'; message: string }
