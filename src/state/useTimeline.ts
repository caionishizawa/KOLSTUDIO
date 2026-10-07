import { useMemo } from 'react'
import { computeTimeline, useStore } from './store'
import type { Timeline } from '../types'

export function useTimeline(): Timeline {
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const analyses = useStore((s) => s.analyses)
  return useMemo(() => computeTimeline({ project, assets, analyses }), [project, assets, analyses])
}

export function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '0:00.0'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
