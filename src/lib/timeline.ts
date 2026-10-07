import type { Asset, ImageSpan, OutputSegment, Project, Take, TakeAnalysis, TakeBlock, Timeline } from '../types'
import { resolveInheritance } from './images'
import { keptIntervals } from './silence'

export interface TimelineInputs {
  project: Project
  assets: Map<string, Asset>
  analyses: Map<string, TakeAnalysis>
}

export function takeRate(project: Project, take: Take): number {
  return take.speed ?? project.speed
}

/** Duração de saída de um take (em segundos), sem contar imagens */
export function takeKept(inputs: TimelineInputs, take: Take) {
  const asset = inputs.assets.get(take.assetId)
  const duration = asset?.duration ?? inputs.analyses.get(take.assetId)?.duration ?? 0
  return keptIntervals(
    inputs.analyses.get(take.assetId),
    duration,
    inputs.project.silence,
    take.trimStart,
    take.trimEnd,
    take.manualCuts,
    take.manualKeeps,
  )
}

export function buildTimeline(inputs: TimelineInputs): Timeline {
  const { project, assets } = inputs
  const segments: OutputSegment[] = []
  let t = 0

  // --- react ---
  let reactDuration = 0
  const clip = project.clipId ? assets.get(project.clipId) : null
  if (clip && clip.status === 'ready' && clip.duration) {
    const inT = Math.max(0, Math.min(project.clip.in, clip.duration))
    const outT = Math.min(clip.duration, project.clip.out ?? clip.duration)
    if (outT - inT > 0.05) {
      reactDuration = outT - inT
      segments.push({
        kind: 'react',
        assetId: clip.id,
        srcStart: inT,
        srcEnd: outT,
        outStart: 0,
        outEnd: reactDuration,
        rate: 1,
      })
      t = reactDuration
    }
  }

  // --- takes ---
  const takeBlocks: TakeBlock[] = []
  const activeTakes = project.takes.filter((tk) => tk.enabled && assets.get(tk.assetId)?.status === 'ready')
  const rawLists: string[][] = []
  for (const take of activeTakes) {
    const rate = takeRate(project, take)
    const kept = takeKept(inputs, take)
    const start = t
    for (const iv of kept) {
      const dur = (iv.end - iv.start) / rate
      segments.push({
        kind: 'take',
        takeId: take.id,
        assetId: take.assetId,
        srcStart: iv.start,
        srcEnd: iv.end,
        outStart: t,
        outEnd: t + dur,
        rate,
      })
      t += dur
    }
    takeBlocks.push({ takeId: take.id, outStart: start, outEnd: t, images: [] })
    rawLists.push(take.images.filter((id) => assets.has(id)))
  }

  const anyImage = rawLists.some((l) => l.length > 0)
  const resolved = resolveInheritance(rawLists)
  const imageSpans: ImageSpan[] = []
  activeTakes.forEach((take, i) => {
    const block = takeBlocks[i]
    block.images = resolved[i]
    const imgs = resolved[i]
    if (imgs.length === 0) return
    const dur = block.outEnd - block.outStart
    const isOwn = rawLists[i].length > 0
    const splits = isOwn ? normalizeSplits(take.splits, imgs.length) : []
    const bounds = [0, ...splits, 1]
    for (let k = 0; k < imgs.length; k++) {
      imageSpans.push({
        assetId: imgs[k],
        takeId: take.id,
        index: k,
        outStart: block.outStart + bounds[k] * dur,
        outEnd: block.outStart + bounds[k + 1] * dur,
      })
    }
  })

  return {
    segments,
    imageSpans,
    takeBlocks,
    reactDuration,
    duration: t,
    faceOnly: !anyImage,
  }
}

/** Garante n-1 pontos de troca crescentes dentro de (0,1); por padrão divide igualmente */
export function normalizeSplits(splits: number[], n: number): number[] {
  const need = Math.max(0, n - 1)
  if (need === 0) return []
  if (splits.length === need && splits.every((s, i) => s > 0 && s < 1 && (i === 0 || s > splits[i - 1]))) return splits
  return Array.from({ length: need }, (_, i) => (i + 1) / n)
}

export interface Located {
  segment: OutputSegment | null
  /** tempo no arquivo da fonte */
  srcTime: number
  image: ImageSpan | null
  block: TakeBlock | null
}

export function locate(tl: Timeline, t: number): Located {
  let segment: OutputSegment | null = null
  for (const s of tl.segments) {
    if (t >= s.outStart && t < s.outEnd) {
      segment = s
      break
    }
  }
  if (!segment && tl.segments.length && t >= tl.duration) segment = tl.segments[tl.segments.length - 1]
  if (!segment && tl.segments.length && t < 0) segment = tl.segments[0]
  const srcTime = segment ? Math.min(segment.srcEnd, segment.srcStart + (t - segment.outStart) * segment.rate) : 0
  let image: ImageSpan | null = null
  let block: TakeBlock | null = null
  if (segment?.kind === 'take') {
    block = tl.takeBlocks.find((b) => b.takeId === segment!.takeId) ?? null
    image =
      tl.imageSpans.find((s) => s.takeId === segment!.takeId && t >= s.outStart && t < s.outEnd) ??
      tl.imageSpans.filter((s) => s.takeId === segment!.takeId).pop() ??
      null
  }
  return { segment, srcTime, image, block }
}

export function segmentIndexAt(tl: Timeline, t: number): number {
  for (let i = 0; i < tl.segments.length; i++) {
    const s = tl.segments[i]
    if (t >= s.outStart && t < s.outEnd) return i
  }
  return t >= tl.duration ? tl.segments.length - 1 : 0
}
