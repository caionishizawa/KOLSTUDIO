import { create } from 'zustand'
import type { Asset, AssetKind, FaceSettings, Interval, Project, Take, TakeAnalysis, TakeOrder, Transform } from '../types'
import { defaultFace, defaultProject } from '../types'
import { classify, mediaTypeOf, naturalCompare, type DroppedFile } from '../lib/classify'
import { autoAssignImages, MIN_IMAGE_WIDTH } from '../lib/images'
import { analyzeTake, decodeAudioFile } from '../lib/silence'
import { measureLoudness } from '../lib/loudness'
import { probeImage, probeMedia, probeWithVideoElement } from '../media/probe'
import { transcodeToH264 } from '../media/ffmpeg'
import { buildTimeline, locate, takeKept } from '../lib/timeline'
import { maskCacheKey, opfsAvailable } from '../cache/maskCache'
import { MaskPrecomputer } from '../cache/precompute'

/** Modelo do pré-cálculo: RVM por padrão (estável entre quadros); ?maskmodel=mediapipe para comparar */
export const MASK_MODEL: 'rvm' | 'mediapipe' =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('maskmodel') === 'mediapipe' ? 'mediapipe' : 'rvm'

export interface MaskInfo {
  key: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  error?: string
}

export type Selection =
  | { type: 'project' }
  | { type: 'take'; id: string }
  | { type: 'clip' }
  | { type: 'reaction' }
  | { type: 'music' }
  | { type: 'title' }
  | { type: 'image'; takeId: string; assetId: string }

export interface Notice {
  id: number
  text: string
  level: 'info' | 'warn' | 'error'
}

export interface ExportState {
  running: boolean
  progress: number
  frame: number
  totalFrames: number
  etaSec: number | null
  message: string
  error: string | null
  resultUrl: string | null
  resultName: string | null
}

interface State {
  assets: Record<string, Asset>
  project: Project
  analyses: Record<string, TakeAnalysis>
  selection: Selection
  playhead: number
  playing: boolean
  notices: Notice[]
  exportState: ExportState
  segmenterInfo: string
  /** Estado do pré-cálculo da máscara de recorte por asset (takes e reação) */
  masks: Record<string, MaskInfo>

  addFiles: (files: DroppedFile[], forcedKind?: AssetKind) => Promise<void>
  removeAsset: (id: string) => void
  setAssetKind: (id: string, kind: AssetKind) => void
  updateProject: (patch: Partial<Project> | ((p: Project) => Partial<Project>)) => void
  updateTake: (id: string, patch: Partial<Take> | ((t: Take) => Partial<Take>)) => void
  reorderTakes: (from: number, to: number) => void
  setTakeOrder: (order: TakeOrder) => void
  setTakeImages: (takeId: string, images: string[]) => void
  moveImage: (assetId: string, fromTakeId: string | null, toTakeId: string, index?: number) => void
  setImageTransform: (takeId: string, assetId: string, t: Partial<Transform>) => void
  setTakeFace: (takeId: string, f: Partial<FaceSettings>) => void
  addManualCut: (takeId: string, iv: Interval) => void
  restoreCut: (takeId: string, iv: Interval) => void
  reassignImages: () => void
  /** Q / W do CapCut: apaga o que está antes (back) ou depois (forward) do cursor no take sob o cursor */
  cutAtPlayhead: (dir: 'back' | 'forward') => boolean
  /** Velocidade igual pra todos os takes (zera ajustes individuais) */
  setSpeedAll: (speed: number) => void
  select: (s: Selection) => void
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  notify: (text: string, level?: Notice['level']) => void
  dismissNotice: (id: number) => void
  setExportState: (patch: Partial<ExportState>) => void
  setSegmenterInfo: (s: string) => void
}

let idCounter = 0
let uploadCounter = 0
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`

const keyToAsset = new Map<string, string>()
let precomputer: MaskPrecomputer | null = null
function getPrecomputer(): MaskPrecomputer {
  if (!precomputer) {
    const patch = (key: string, p: Partial<MaskInfo>) => {
      const id = keyToAsset.get(key)
      if (!id) return
      useStore.setState((s) => (s.masks[id] ? { masks: { ...s.masks, [id]: { ...s.masks[id], ...p } } } : {}))
    }
    precomputer = new MaskPrecomputer({
      onStatus: (key, status) => {
        if (status) patch(key, { status })
      },
      onProgress: (key, frame, total) => {
        patch(key, { status: 'running', progress: total ? frame / total : 0 })
        // GPU lenta (máquina fraca ou GL por software): troca para CPU e recomeça
        const started = jobStart.get(key)
        if (started === 0) jobStart.set(key, performance.now())
        else if (started && MASK_MODEL === 'mediapipe' && maskDelegate === 'GPU' && frame >= 20) {
          const msPerFrame = (performance.now() - started) / frame
          if (msPerFrame > SLOW_GPU_MS_PER_FRAME) {
            maskDelegate = 'CPU'
            useStore.getState().notify('Recorte em segundo plano: GPU lenta neste computador, usando CPU.', 'info')
            const id = keyToAsset.get(key)
            const asset = id ? useStore.getState().assets[id] : undefined
            precomputer?.cancel(key)
            if (asset) setTimeout(() => enqueueMask(asset, key, true), 200)
          }
        }
      },
      onDone: (r) => patch(r.key, { status: 'done', progress: 1 }),
      onError: (key, message) => {
        patch(key, { status: 'error', error: message })
        useStore.getState().notify('Recorte em segundo plano falhou: ' + message, 'warn')
      },
    })
  }
  return precomputer
}

/** Delegate do pré-cálculo: GPU por padrão; cai para CPU se a GPU se mostrar lenta (ou via ?maskdelegate=CPU). */
let maskDelegate: 'GPU' | 'CPU' =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('maskdelegate') === 'CPU' ? 'CPU' : 'GPU'
const jobStart = new Map<string, number>()
const SLOW_GPU_MS_PER_FRAME = 250

function enqueueMask(asset: Asset, key: string, force = false) {
  jobStart.set(key, 0)
  getPrecomputer().enqueue(asset.file, key, { model: MASK_MODEL, fps: 30, maskWidth: 192, delegate: maskDelegate, force })
}

/** Agenda o pré-cálculo da máscara de recorte de um take ou da reação. */
function ensureMask(asset: Asset | undefined) {
  if (!asset || asset.status !== 'ready' || asset.type !== 'video') return
  if (asset.kind !== 'take' && asset.kind !== 'reaction') return
  if (!opfsAvailable()) return
  const key = maskCacheKey(asset.file, MASK_MODEL)
  keyToAsset.set(key, asset.id)
  const cur = useStore.getState().masks[asset.id]
  if (cur && cur.key === key && cur.status !== 'error') return
  useStore.setState((s) => ({ masks: { ...s.masks, [asset.id]: { key, status: 'queued', progress: 0 } } }))
  enqueueMask(asset, key)
}

export const useStore = create<State>((set, get) => ({
  assets: {},
  project: defaultProject(),
  analyses: {},
  selection: { type: 'project' },
  playhead: 0,
  playing: false,
  notices: [],
  exportState: {
    running: false,
    progress: 0,
    frame: 0,
    totalFrames: 0,
    etaSec: null,
    message: '',
    error: null,
    resultUrl: null,
    resultName: null,
  },
  segmenterInfo: '',
  masks: {},

  notify: (text, level = 'info') => {
    const id = ++idCounter
    set((s) => ({ notices: [...s.notices, { id, text, level }] }))
    if (level !== 'error') setTimeout(() => get().dismissNotice(id), 9000)
  },
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  setExportState: (patch) => set((s) => ({ exportState: { ...s.exportState, ...patch } })),
  setSegmenterInfo: (segmenterInfo) => set({ segmenterInfo }),

  select: (selection) => set({ selection }),
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (playing) => set({ playing }),

  updateProject: (patch) =>
    set((s) => ({ project: { ...s.project, ...(typeof patch === 'function' ? patch(s.project) : patch) } })),

  updateTake: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        takes: s.project.takes.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
      },
    })),

  reorderTakes: (from, to) =>
    set((s) => {
      const takes = [...s.project.takes]
      const [moved] = takes.splice(from, 1)
      takes.splice(to, 0, moved)
      return { project: { ...s.project, takes, takesManual: true } }
    }),

  setTakeOrder: (order) => {
    set((s) => ({
      project: { ...s.project, takeOrder: order, takesManual: false, takes: sortTakes(s.project.takes, s.assets, order) },
    }))
    get().reassignImages()
  },

  setTakeImages: (takeId, images) => {
    get().updateTake(takeId, { images, imagesLocked: true, splits: [] })
  },

  moveImage: (assetId, fromTakeId, toTakeId, index) => {
    const { project, updateTake } = get()
    if (fromTakeId && fromTakeId !== toTakeId) {
      const from = project.takes.find((t) => t.id === fromTakeId)
      if (from) updateTake(fromTakeId, { images: from.images.filter((i) => i !== assetId), imagesLocked: true, splits: [] })
    }
    const to = get().project.takes.find((t) => t.id === toTakeId)
    if (!to) return
    const oldIdx = to.images.indexOf(assetId)
    const list = to.images.filter((i) => i !== assetId)
    let at = index ?? list.length
    if (oldIdx >= 0 && index != null && oldIdx < index) at = index - 1
    list.splice(Math.max(0, Math.min(list.length, at)), 0, assetId)
    updateTake(toTakeId, { images: list, imagesLocked: true, splits: [] })
  },

  setImageTransform: (takeId, assetId, t) =>
    get().updateTake(takeId, (take) => ({
      imageTransforms: {
        ...take.imageTransforms,
        [assetId]: { ...(take.imageTransforms[assetId] ?? { zoom: 1, x: 0, y: 0 }), ...t },
      },
    })),

  setTakeFace: (takeId, f) => get().updateTake(takeId, (take) => ({ face: { ...take.face, ...f } })),

  addManualCut: (takeId, iv) =>
    get().updateTake(takeId, (take) => ({
      manualCuts: [...take.manualCuts, iv],
      manualKeeps: take.manualKeeps.filter((k) => k.end <= iv.start || k.start >= iv.end),
    })),

  restoreCut: (takeId, iv) =>
    get().updateTake(takeId, (take) => ({
      manualKeeps: [...take.manualKeeps, iv],
      manualCuts: take.manualCuts.filter((c) => c.end <= iv.start || c.start >= iv.end),
    })),

  setSpeedAll: (speed) =>
    set((s) => ({ project: { ...s.project, speed, takes: s.project.takes.map((t) => (t.speed == null ? t : { ...t, speed: null })) } })),

  cutAtPlayhead: (dir) => {
    const st = get()
    const tl = computeTimeline(st)
    const loc = locate(tl, st.playhead)
    const seg = loc.segment
    if (!seg || seg.kind !== 'take' || !seg.takeId) return false
    const take = st.project.takes.find((t) => t.id === seg.takeId)
    const dur = st.assets[seg.assetId]?.duration ?? 0
    if (!take || dur <= 0) return false
    const src = loc.srcTime
    const MIN = 0.1
    if (dir === 'back') {
      if (src <= take.trimStart + 0.01) return false
      const maxStart = dur - take.trimEnd - MIN
      st.updateTake(take.id, { trimStart: Math.min(src, maxStart) })
      // mantém o cursor no mesmo ponto do vídeo (que agora é o começo do take)
      const block = tl.takeBlocks.find((b) => b.takeId === take.id)
      if (block) st.setPlayhead(block.outStart + 0.001)
    } else {
      const newEnd = dur - src
      if (newEnd <= take.trimEnd + 0.01) return false
      const maxEnd = dur - take.trimStart - MIN
      st.updateTake(take.id, { trimEnd: Math.min(newEnd, maxEnd) })
    }
    st.select({ type: 'take', id: take.id })
    return true
  },

  reassignImages: () => {
    const { project, assets, analyses } = get()
    const images = Object.values(assets).filter((a) => a.kind === 'image' && a.status === 'ready')
    const inputs = { project, assets: new Map(Object.entries(assets)), analyses: new Map(Object.entries(analyses)) }
    const durations = new Map<string, number>()
    for (const t of project.takes) {
      const kept = takeKept(inputs, t)
      durations.set(
        t.id,
        kept.reduce((a, iv) => a + (iv.end - iv.start), 0),
      )
    }
    const map = autoAssignImages(project.takes, images, durations)
    set((s) => ({
      project: {
        ...s.project,
        takes: s.project.takes.map((t) => {
          const next = map.get(t.id) ?? t.images
          const same = next.length === t.images.length && next.every((v, i) => v === t.images[i])
          return same ? t : { ...t, images: next, splits: [] }
        }),
      },
    }))
  },

  removeAsset: (id) => {
    const a = get().assets[id]
    if (!a) return
    URL.revokeObjectURL(a.url)
    const m = get().masks[id]
    if (m && m.status !== 'done') precomputer?.cancel(m.key)
    set((s) => {
      const assets = { ...s.assets }
      delete assets[id]
      const masks = { ...s.masks }
      delete masks[id]
      const analyses = { ...s.analyses }
      delete analyses[id]
      const p = { ...s.project }
      if (p.clipId === id) p.clipId = null
      if (p.reactionId === id) p.reactionId = null
      if (p.music.assetId === id) p.music = { ...p.music, assetId: null }
      p.takes = p.takes
        .filter((t) => t.assetId !== id)
        .map((t) => (t.images.includes(id) ? { ...t, images: t.images.filter((i) => i !== id), splits: [] } : t))
      return { assets, analyses, masks, project: p, selection: { type: 'project' } }
    })
    get().reassignImages()
  },

  setAssetKind: (id, kind) => {
    const a = get().assets[id]
    if (!a || a.kind === kind) return
    // tira do papel antigo
    set((s) => {
      const p = { ...s.project }
      if (p.clipId === id) p.clipId = null
      if (p.reactionId === id) p.reactionId = null
      if (p.music.assetId === id) p.music = { ...p.music, assetId: null }
      p.takes = p.takes
        .filter((t) => t.assetId !== id)
        .map((t) => (t.images.includes(id) ? { ...t, images: t.images.filter((i) => i !== id), splits: [] } : t))
      return { project: p, assets: { ...s.assets, [id]: { ...s.assets[id], kind } } }
    })
    attachRole(get, set, get().assets[id])
    ensureMask(get().assets[id])
    get().reassignImages()
  },

  addFiles: async (files, forcedKind) => {
    const created: Asset[] = []
    for (const { file, folder } of files) {
      const type = mediaTypeOf(file.name, file.type)
      if (!type) {
        get().notify(`Arquivo ignorado (formato não suportado): ${file.name}`, 'warn')
        continue
      }
      let kind: AssetKind = forcedKind ?? classify(file.name, folder, type)
      // coerência: imagem não pode ser take, etc.
      if (type === 'image' && kind !== 'image') kind = 'image'
      if (type === 'audio' && kind !== 'music') kind = 'music'
      if (type === 'video' && (kind === 'music')) kind = 'take'
      const asset: Asset = {
        id: uid('a'),
        kind,
        name: file.name,
        folder,
        file,
        url: URL.createObjectURL(file),
        type,
        status: 'pending',
        createdAt: file.lastModified || undefined,
        uploadIndex: uploadCounter++,
      }
      created.push(asset)
    }
    if (created.length === 0) return
    set((s) => {
      const assets = { ...s.assets }
      for (const a of created) assets[a.id] = a
      return { assets }
    })
    await Promise.all(created.map((a) => prepareAsset(get, set, a.id)))
    get().reassignImages()
  },
}))

type Get = () => State
type Set = (fn: (s: State) => Partial<State>) => void

function patchAsset(set: Set, id: string, patch: Partial<Asset>) {
  set((s) => (s.assets[id] ? { assets: { ...s.assets, [id]: { ...s.assets[id], ...patch } } } : {}))
}

async function prepareAsset(get: Get, set: Set, id: string) {
  const asset = get().assets[id]
  if (!asset) return
  patchAsset(set, id, { status: 'probing' })
  try {
    if (asset.type === 'image') {
      const info = await probeImage(asset.file)
      const warning = (info.width ?? 0) < MIN_IMAGE_WIDTH ? `Imagem com ${info.width}px de largura: vai ficar borrada` : undefined
      if (warning) get().notify(`${asset.name}: ${warning}`, 'warn')
      patchAsset(set, id, { status: 'ready', width: info.width, height: info.height, warning })
    } else {
      let info
      try {
        info = await probeMedia(asset.file, asset.type)
      } catch (e) {
        if (asset.type === 'video') info = await probeWithVideoElement(asset.url)
        else throw e
      }
      let file = asset.file
      let url = asset.url
      let warning: string | undefined
      if (asset.type === 'video' && info.canDecodeVideo === false) {
        get().notify(`${asset.name}: o Chrome não decodifica este vídeo (${info.videoCodec ?? 'codec desconhecido'}). Convertendo com FFmpeg…`, 'warn')
        patchAsset(set, id, { status: 'transcoding' })
        file = await transcodeToH264(asset.file)
        URL.revokeObjectURL(url)
        url = URL.createObjectURL(file)
        warning = 'Convertido com FFmpeg (o Chrome não decodificava o original)'
        info = await probeMedia(file, 'video')
      }
      patchAsset(set, id, {
        status: 'ready',
        file,
        url,
        warning,
        duration: info.duration,
        width: info.width,
        height: info.height,
        rotation: info.rotation,
        hasAudio: info.hasAudio,
        createdAt: info.createdAt ?? asset.createdAt,
      })
    }
    const ready = get().assets[id]
    attachRole(get, set, ready)
    ensureMask(ready)
    // análise de áudio (takes e clipe)
    if (ready.type === 'video' && (ready.kind === 'take' || ready.kind === 'clip') && ready.hasAudio) {
      const buf = await decodeAudioFile(ready.file)
      if (buf) {
        const analysis = analyzeTake(buf)
        if (ready.kind === 'clip') {
          // clipe: não corta pausas, só normaliza volume
          const l = measureLoudness(buf)
          analysis.speech = []
          analysis.loudness = l
          analysis.gain = Number.isFinite(l) ? Math.min(8, Math.pow(10, (-16 - l) / 20)) : 1
        }
        set((s) => ({ analyses: { ...s.analyses, [id]: analysis } }))
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    patchAsset(set, id, { status: 'error', error: msg })
    get().notify(`${asset.name}: ${msg}`, 'error')
  }
}

/** Coloca o asset no papel certo do projeto (clipe, reação, take, música). */
function attachRole(get: Get, set: Set, asset: Asset | undefined) {
  if (!asset || asset.status !== 'ready') return
  const { project } = get()
  if (asset.kind === 'clip' && !project.clipId) {
    set((s) => ({ project: { ...s.project, clipId: asset.id, clip: { ...s.project.clip, in: 0, out: null } } }))
  } else if (asset.kind === 'reaction' && !project.reactionId) {
    set((s) => ({ project: { ...s.project, reactionId: asset.id } }))
  } else if (asset.kind === 'music' && !project.music.assetId) {
    set((s) => ({ project: { ...s.project, music: { ...s.project.music, assetId: asset.id } } }))
  } else if (asset.kind === 'take' && !project.takes.some((t) => t.assetId === asset.id)) {
    set((s) => {
      const take: Take = {
        id: uid('t'),
        assetId: asset.id,
        enabled: true,
        trimStart: 0,
        trimEnd: 0,
        speed: null,
        face: { ...s.project.faceDefault },
        images: [],
        splits: [],
        imageTransforms: {},
        manualCuts: [],
        manualKeeps: [],
        imagesLocked: false,
        cutout: true,
      }
      const takes = s.project.takesManual
        ? [...s.project.takes, take]
        : sortTakes([...s.project.takes, take], s.assets, s.project.takeOrder)
      return { project: { ...s.project, takes } }
    })
  }
}

/** Ordena os takes pelo critério escolhido. Data: gravação (metadados) ou modificação do arquivo. */
export function sortTakes(takes: Take[], assets: Record<string, Asset>, order: TakeOrder): Take[] {
  const byName = (a: Take, b: Take) => naturalCompare(assets[a.assetId]?.name ?? '', assets[b.assetId]?.name ?? '')
  return [...takes].sort((a, b) => {
    const aa = assets[a.assetId]
    const ab = assets[b.assetId]
    if (order === 'upload') return (aa?.uploadIndex ?? 0) - (ab?.uploadIndex ?? 0)
    if (order === 'date') {
      const da = aa?.createdAt ?? 0
      const db = ab?.createdAt ?? 0
      if (da && db && da !== db) return da - db
    }
    return byName(a, b)
  })
}

/** Seletor memoizável da linha do tempo. */
export function selectTimelineInputs(s: State) {
  return { project: s.project, assets: s.assets, analyses: s.analyses }
}

export function computeTimeline(s: Pick<State, 'project' | 'assets' | 'analyses'>) {
  return buildTimeline({
    project: s.project,
    assets: new Map(Object.entries(s.assets)),
    analyses: new Map(Object.entries(s.analyses)),
  })
}

export { defaultFace }
