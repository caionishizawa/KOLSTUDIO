import type { Asset, Project, TakeAnalysis, Timeline } from '../types'
import type { ExportAsset, ExportJob, WorkerIn, WorkerOut } from './types'

export interface ExportCallbacks {
  onProgress: (p: { stage: string; frame: number; totalFrames: number; elapsedMs: number }) => void
  onInfo: (text: string) => void
}

export function exportFileName(projectName: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
  const safe = (projectName || 'video').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'video'
  return `${safe}_${date}.mp4`
}

export function buildJob(
  project: Project,
  timeline: Timeline,
  assets: Record<string, Asset>,
  analyses: Record<string, TakeAnalysis>,
  fileName: string,
): ExportJob {
  const used = new Set<string>()
  for (const s of timeline.segments) used.add(s.assetId)
  for (const s of timeline.imageSpans) used.add(s.assetId)
  if (project.reactionId) used.add(project.reactionId)
  if (project.music.assetId) used.add(project.music.assetId)
  const exAssets: Record<string, ExportAsset> = {}
  for (const id of used) {
    const a = assets[id]
    if (!a) continue
    exAssets[id] = { id: a.id, name: a.name, type: a.type, file: a.file, width: a.width, height: a.height, duration: a.duration }
  }
  const gains: Record<string, number> = {}
  for (const [id, an] of Object.entries(analyses)) gains[id] = an.gain
  const debugCodec = new URLSearchParams(location.search).get('codec') === 'vp9' ? 'vp9' : undefined
  const segModel = new URLSearchParams(location.search).get('model') === 'small' ? 'small' : 'multiclass'
  return { project, timeline, assets: exAssets, gains, fileName, debugCodec, segModel }
}

export class Exporter {
  private worker: Worker | null = null

  async run(job: ExportJob, handle: FileSystemFileHandle | null, cb: ExportCallbacks): Promise<ArrayBuffer | null> {
    this.cancel()
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    return new Promise<ArrayBuffer | null>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const m = ev.data
        if (m.type === 'progress') cb.onProgress(m)
        else if (m.type === 'info') cb.onInfo(m.text)
        else if (m.type === 'done') {
          resolve(m.buffer)
          this.dispose()
        } else if (m.type === 'error') {
          reject(new Error(m.message))
          this.dispose()
        }
      }
      worker.onerror = (e) => {
        reject(new Error(e.message || 'Erro no worker de exportação'))
        this.dispose()
      }
      const msg: WorkerIn = { type: 'start', job, handle }
      worker.postMessage(msg)
    })
  }

  cancel() {
    if (this.worker) {
      const msg: WorkerIn = { type: 'cancel' }
      this.worker.postMessage(msg)
      setTimeout(() => this.dispose(), 500)
    }
  }

  private dispose() {
    this.worker?.terminate()
    this.worker = null
  }
}

/** Pede ao usuário onde salvar (streaming direto pro disco). Retorna null se o navegador não suportar ou o usuário cancelar. */
export async function pickSaveHandle(fileName: string): Promise<FileSystemFileHandle | null | 'cancelled'> {
  const w = window as Window & {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
  }
  if (!w.showSaveFilePicker) return null
  try {
    return await w.showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: 'Vídeo MP4', accept: { 'video/mp4': ['.mp4'] } }],
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
    return null
  }
}
