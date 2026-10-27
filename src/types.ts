export type AssetKind = 'clip' | 'reaction' | 'take' | 'image' | 'music' | 'unknown'
export type MediaType = 'video' | 'image' | 'audio'

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  /** Pasta relativa de origem (quando veio de drop de pasta) */
  folder: string
  file: File
  url: string
  type: MediaType
  duration?: number
  width?: number
  height?: number
  rotation?: number
  hasAudio?: boolean
  /** Aviso para mostrar na interface (HEVC convertido, imagem pequena, etc.) */
  warning?: string
  /** Estado de preparação do arquivo */
  status: 'pending' | 'probing' | 'transcoding' | 'ready' | 'error'
  error?: string
  /** Data de gravação (ms); cai para a data de modificação do arquivo */
  createdAt?: number
  /** Ordem em que o arquivo foi enviado */
  uploadIndex: number
}

export interface Interval {
  start: number
  end: number
}

export interface TakeAnalysis {
  /** Fala detectada (segundos no arquivo original), antes de margens */
  speech: Interval[]
  /** Energia RMS por janela de 10 ms (dBFS) */
  rms: Float32Array
  windowSec: number
  noiseFloorDb: number
  thresholdDb: number
  /** Ganho linear para normalizar o volume da voz */
  gain: number
  /** Loudness medido (LUFS aproximado) */
  loudness: number
  duration: number
}

export type FaceAlign = 'left' | 'center' | 'right'

export interface Transform {
  zoom: number
  x: number
  y: number
}

export interface FaceSettings {
  align: FaceAlign
  /** Multiplicador sobre a largura padrão (58% do canvas) */
  scale: number
  x: number
  y: number
}

export interface Take {
  id: string
  assetId: string
  enabled: boolean
  trimStart: number
  /** Segundos a cortar no fim do arquivo (0 = nenhum) */
  trimEnd: number
  /** Velocidade própria; null usa a geral */
  speed: number | null
  face: FaceSettings
  /** Ids de imagens (ou vídeos de apoio) deste take, na ordem */
  images: string[]
  /** Pontos de troca (fração 0..1 do tempo do take) quando há várias imagens */
  splits: number[]
  /** Transformação por imagem (zoom/posição) */
  imageTransforms: Record<string, Transform>
  /** Trechos cortados manualmente (segundos no arquivo original) */
  manualCuts: Interval[]
  /** Trechos restaurados manualmente */
  manualKeeps: Interval[]
  /** Quando true, a atribuição automática de imagens não mexe neste take */
  imagesLocked: boolean
  /** Fase 2: desligar o recorte de fundo neste take */
  cutout: boolean
}

export type SilenceIntensity = 'off' | 'soft' | 'normal' | 'aggressive'
/** Critério de ordenação dos takes */
export type TakeOrder = 'date' | 'name' | 'upload'

export interface Project {
  name: string
  clipId: string | null
  reactionId: string | null
  clip: { in: number; out: number | null; transform: Transform }
  takes: Take[]
  title: {
    text: string
    enabled: boolean
    wholeVideo: boolean
    x: number
    y: number
    width: number
    /** 'red' = caixa vermelha com texto branco (padrão); 'white' = caixa branca com texto preto */
    style: 'red' | 'white'
    uppercase: boolean
    /** Multiplicador do tamanho da fonte (redimensionar pelas alças) */
    fontScale: number
  }
  disclaimer: { text: string; enabled: boolean }
  music: { assetId: string | null; gainDb: number; start: number; muteDuringReact: boolean; ducking: boolean }
  speed: number
  silence: SilenceIntensity
  faceDefault: FaceSettings
  previewHalf: boolean
  takeOrder: TakeOrder
  /** true depois que o usuário reordenou à mão: novos takes entram no fim */
  takesManual: boolean
}

export interface OutputSegment {
  kind: 'react' | 'take'
  takeId?: string
  /** Asset de vídeo da fonte (take ou clipe) */
  assetId: string
  srcStart: number
  srcEnd: number
  outStart: number
  outEnd: number
  rate: number
}

export interface ImageSpan {
  assetId: string
  takeId: string
  outStart: number
  outEnd: number
  /** Índice da imagem dentro do take (para arrastar os pontos de troca) */
  index: number
}

export interface TakeBlock {
  takeId: string
  outStart: number
  outEnd: number
  /** Imagens efetivamente mostradas (depois da herança) */
  images: string[]
}

export interface Timeline {
  segments: OutputSegment[]
  imageSpans: ImageSpan[]
  takeBlocks: TakeBlock[]
  reactDuration: number
  duration: number
  /** Projeto sem imagem nenhuma: rosto sozinho */
  faceOnly: boolean
}

export const CANVAS_W = 1080
export const CANVAS_H = 1920
export const FPS = 30

export const DEFAULT_DISCLAIMER =
  "Not financial advice. Educational only, no promise of returns. Past results don't guarantee future results."

export const SILENCE_PRESETS: Record<SilenceIntensity, { minSilence: number; margin: number; label: string }> = {
  off: { minSilence: Infinity, margin: 0, label: 'Desligado' },
  soft: { minSilence: 0.5, margin: 0.15, label: 'Suave' },
  normal: { minSilence: 0.35, margin: 0.1, label: 'Normal' },
  aggressive: { minSilence: 0.2, margin: 0.06, label: 'Agressivo' },
}

export function defaultFace(): FaceSettings {
  return { align: 'left', scale: 1, x: 0, y: 0 }
}

export function defaultTransform(): Transform {
  return { zoom: 1, x: 0, y: 0 }
}

export function defaultProject(): Project {
  return {
    name: 'KOL React',
    clipId: null,
    reactionId: null,
    clip: { in: 0, out: null, transform: defaultTransform() },
    takes: [],
    title: { text: '', enabled: true, wholeVideo: false, x: CANVAS_W / 2, y: 190, width: 1000, style: 'red', uppercase: true, fontScale: 1 },
    disclaimer: { text: DEFAULT_DISCLAIMER, enabled: true },
    music: { assetId: null, gainDb: -13, start: 0, muteDuringReact: false, ducking: false },
    speed: 1,
    silence: 'off',
    faceDefault: defaultFace(),
    previewHalf: false,
    takeOrder: 'date',
    takesManual: false,
  }
}
