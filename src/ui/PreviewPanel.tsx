import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { useStore } from '../state/store'
import type { Timeline } from '../types'
import { CANVAS_H, CANVAS_W } from '../types'
import { PreviewEngine } from '../preview/engine'
import { locate } from '../lib/timeline'
import { pointInRect } from '../lib/layout'
import { fmtTime } from '../state/useTimeline'

type DragTarget =
  | { kind: 'title'; startX: number; startY: number }
  | { kind: 'clip'; startX: number; startY: number }
  | { kind: 'face'; takeId: string | null; startX: number; startY: number }
  | { kind: 'image'; takeId: string; assetId: string; startX: number; startY: number }

export function PreviewPanel({ timeline }: { timeline: Timeline }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const analyses = useStore((s) => s.analyses)
  const masks = useStore((s) => s.masks)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const playhead = useStore((s) => s.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const updateProject = useStore((s) => s.updateProject)
  const setTakeFace = useStore((s) => s.setTakeFace)
  const setImageTransform = useStore((s) => s.setImageTransform)
  const setSegmenterInfo = useStore((s) => s.setSegmenterInfo)
  const select = useStore((s) => s.select)
  const [drag, setDrag] = useState<DragTarget | null>(null)
  const dragRef = useRef<{ target: DragTarget; px: number; py: number } | null>(null)

  // cria o motor
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new PreviewEngine(canvas)
    engine.onTime = (t) => useStore.getState().setPlayhead(t)
    engine.onEnded = () => useStore.getState().setPlaying(false)
    engine.onSegmenter = (info) => setSegmenterInfo(info)
    engineRef.current = engine
    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [setSegmenterInfo])

  // dados
  useEffect(() => {
    engineRef.current?.setData({ project, assets, analyses, timeline, masks })
  }, [project, assets, analyses, timeline, masks])

  // transporte
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    if (playing && !e.isPlaying) e.play()
    else if (!playing && e.isPlaying) e.pause()
  }, [playing])

  // seek vindo de fora (timeline/slider): só quando difere do relógio do motor
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    if (Math.abs(e.currentTime - playhead) > 0.05) e.seek(playhead)
  }, [playhead])

  const toCanvas = (e: PointerEvent | WheelEvent) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * CANVAS_W, y: ((e.clientY - r.top) / r.height) * CANVAS_H }
  }

  const hitTest = (x: number, y: number): DragTarget | null => {
    const layout = engineRef.current?.lastLayout
    if (!layout) return null
    const loc = locate(timeline, useStore.getState().playhead)
    const p = useStore.getState().project
    if (layout.titleRect && pointInRect(x, y, layout.titleRect)) return { kind: 'title', startX: p.title.x, startY: p.title.y }
    if (layout.faceRect && pointInRect(x, y, layout.faceRect)) {
      const take = loc.segment?.kind === 'take' ? p.takes.find((t) => t.id === loc.segment!.takeId) : null
      const f = take ? take.face : p.faceDefault
      return { kind: 'face', takeId: take?.id ?? null, startX: f.x, startY: f.y }
    }
    if (layout.clipRect && pointInRect(x, y, layout.clipRect)) {
      return { kind: 'clip', startX: p.clip.transform.x, startY: p.clip.transform.y }
    }
    if (layout.imageRect && loc.image && loc.segment?.takeId) {
      const take = p.takes.find((t) => t.id === loc.segment!.takeId)
      const tr = take?.imageTransforms[loc.image.assetId] ?? { zoom: 1, x: 0, y: 0 }
      return { kind: 'image', takeId: loc.segment.takeId, assetId: loc.image.assetId, startX: tr.x, startY: tr.y }
    }
    return null
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvas(e)
    const target = hitTest(x, y)
    if (!target) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { target, px: x, py: y }
    setDrag(target)
    if (target.kind === 'title') select({ type: 'title' })
    else if (target.kind === 'clip') select({ type: 'clip' })
    else if (target.kind === 'image') select({ type: 'image', takeId: target.takeId, assetId: target.assetId })
    else if (target.kind === 'face' && target.takeId) select({ type: 'take', id: target.takeId })
    else if (target.kind === 'face') select({ type: 'reaction' })
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) return
    const { x, y } = toCanvas(e)
    const dx = x - d.px
    const dy = y - d.py
    const t = d.target
    if (t.kind === 'title') updateProject((p) => ({ title: { ...p.title, x: t.startX + dx, y: t.startY + dy } }))
    else if (t.kind === 'clip')
      updateProject((p) => ({ clip: { ...p.clip, transform: { ...p.clip.transform, x: t.startX + dx, y: t.startY + dy } } }))
    else if (t.kind === 'face') {
      if (t.takeId) setTakeFace(t.takeId, { x: t.startX + dx, y: t.startY + dy })
      else updateProject((p) => ({ faceDefault: { ...p.faceDefault, x: t.startX + dx, y: t.startY + dy } }))
    } else if (t.kind === 'image') setImageTransform(t.takeId, t.assetId, { x: t.startX + dx, y: t.startY + dy })
  }

  const onPointerUp = () => {
    dragRef.current = null
    setDrag(null)
  }

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvas(e)
    const target = hitTest(x, y)
    if (!target || target.kind === 'title') return
    const factor = e.deltaY < 0 ? 1.05 : 1 / 1.05
    const p = useStore.getState().project
    if (target.kind === 'clip') {
      updateProject({
        clip: { ...p.clip, transform: { ...p.clip.transform, zoom: clamp(p.clip.transform.zoom * factor, 1, 4) } },
      })
    } else if (target.kind === 'image') {
      const take = p.takes.find((t) => t.id === target.takeId)
      const tr = take?.imageTransforms[target.assetId] ?? { zoom: 1, x: 0, y: 0 }
      setImageTransform(target.takeId, target.assetId, { zoom: clamp(tr.zoom * factor, 0.3, 4) })
    } else if (target.kind === 'face') {
      if (target.takeId) {
        const take = p.takes.find((t) => t.id === target.takeId)!
        setTakeFace(target.takeId, { scale: clamp(take.face.scale * factor, 0.4, 1.8) })
      } else updateProject({ faceDefault: { ...p.faceDefault, scale: clamp(p.faceDefault.scale * factor, 0.4, 1.8) } })
    }
  }

  const hasContent = timeline.duration > 0
  return (
    <section className="preview">
      <div className="stage">
        <canvas
          ref={canvasRef}
          className={drag ? 'dragging' : ''}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{ display: hasContent ? 'block' : 'none' }}
        />
        {!hasContent && (
          <div className="empty">
            Adicione os arquivos à esquerda (ou arraste uma pasta). O vídeo é montado sozinho: react em cima, takes com imagem e
            rosto recortado embaixo.
            <br />
            <br />
            Arraste no preview para mover título, clipe, imagem ou rosto. Roda do mouse dá zoom.
          </div>
        )}
      </div>
      <div className="controls">
        <button onClick={() => setPlaying(!playing)} disabled={!hasContent} title="Espaço">
          {playing ? '❚❚ Pausar' : '▶ Play'}
        </button>
        <span className="time">
          {fmtTime(playhead)} / {fmtTime(timeline.duration)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0.01, timeline.duration)}
          step={0.01}
          value={Math.min(playhead, timeline.duration)}
          onChange={(e) => setPlayhead(parseFloat(e.target.value))}
          disabled={!hasContent}
        />
        <label className="check" style={{ margin: 0 }} title="Use se o computador não aguentar o preview em tempo real">
          <input type="checkbox" checked={project.previewHalf} onChange={(e) => updateProject({ previewHalf: e.target.checked })} />
          Meia resolução
        </label>
      </div>
    </section>
  )
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}
