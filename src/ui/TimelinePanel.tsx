import { useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import { useStore } from '../state/store'
import type { Interval, Timeline } from '../types'
import { fmtTime } from '../state/useTimeline'
import { takeKept } from '../lib/timeline'
import { normalizeSplits } from '../lib/timeline'

export function TimelinePanel({ timeline }: { timeline: Timeline }) {
  const selection = useStore((s) => s.selection)
  const selectedTakeId = selection.type === 'take' ? selection.id : selection.type === 'image' ? selection.takeId : null
  return (
    <section className="timeline">
      <OutputRuler timeline={timeline} />
      {selectedTakeId ? (
        <TakeStrip takeId={selectedTakeId} />
      ) : (
        <div className="tl-foot">
          <span>Clique num take pra ver os trechos mantidos e cortados. Arraste imagens do painel da esquerda para um take.</span>
        </div>
      )}
    </section>
  )
}

function OutputRuler({ timeline }: { timeline: Timeline }) {
  const ref = useRef<HTMLDivElement>(null)
  const assets = useStore((s) => s.assets)
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.playhead)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const moveImage = useStore((s) => s.moveImage)
  const updateTake = useStore((s) => s.updateTake)
  const [dropOver, setDropOver] = useState<string | null>(null)
  const dragSplit = useRef<{ takeId: string; index: number; splits: number[]; start: number; end: number } | null>(null)

  const dur = Math.max(0.01, timeline.duration)
  const pct = (t: number) => `${(t / dur) * 100}%`

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur))
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.tl-split') || (e.target as HTMLElement).closest('.tl-img')) return
    setPlayhead(timeAt(e.clientX))
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const ds = dragSplit.current
    if (ds) {
      const t = timeAt(e.clientX)
      const frac = Math.max(0.02, Math.min(0.98, (t - ds.start) / (ds.end - ds.start)))
      const splits = [...ds.splits]
      const lo = ds.index > 0 ? splits[ds.index - 1] + 0.02 : 0.02
      const hi = ds.index < splits.length - 1 ? splits[ds.index + 1] - 0.02 : 0.98
      splits[ds.index] = Math.max(lo, Math.min(hi, frac))
      updateTake(ds.takeId, { splits })
      return
    }
    if (e.buttons & 1 && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) setPlayhead(timeAt(e.clientX))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragSplit.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
  }

  const onDropOnTake = (e: DragEvent, takeId: string) => {
    e.preventDefault()
    setDropOver(null)
    const raw = e.dataTransfer.getData('application/x-kol-image')
    if (!raw) return
    try {
      const { assetId, fromTakeId } = JSON.parse(raw) as { assetId: string; fromTakeId: string | null }
      moveImage(assetId, e.altKey ? null : fromTakeId, takeId)
    } catch {
      /* ignora */
    }
  }

  const ticks = useMemo(() => {
    const step = dur > 120 ? 30 : dur > 60 ? 10 : dur > 20 ? 5 : 1
    const out: number[] = []
    for (let t = 0; t <= dur; t += step) out.push(t)
    return out
  }, [dur])

  return (
    <div className="tl-ruler" ref={ref} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {timeline.segments.length === 0 && <div className="tl-foot" style={{ padding: 10 }}>Linha do tempo vazia.</div>}
      {timeline.reactDuration > 0 && (
        <div
          className={`tl-block react ${selection.type === 'clip' ? 'selected' : ''}`}
          style={{ left: 0, width: pct(timeline.reactDuration) }}
          onPointerDown={() => select({ type: 'clip' })}
          title={`React · ${fmtTime(timeline.reactDuration)}`}
        >
          React · {fmtTime(timeline.reactDuration)}
        </div>
      )}
      {timeline.takeBlocks.map((b, i) => {
        const take = project.takes.find((t) => t.id === b.takeId)
        const name = assets[take?.assetId ?? '']?.name ?? ''
        const isSel = selection.type === 'take' && selection.id === b.takeId
        return (
          <div
            key={b.takeId}
            className={`tl-block take ${isSel ? 'selected' : ''} ${dropOver === b.takeId ? 'drop-over' : ''}`}
            style={{ left: pct(b.outStart), width: pct(b.outEnd - b.outStart) }}
            onPointerDown={() => select({ type: 'take', id: b.takeId })}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-kol-image')) {
                e.preventDefault()
                setDropOver(b.takeId)
              }
            }}
            onDragLeave={() => setDropOver(null)}
            onDrop={(e) => onDropOnTake(e, b.takeId)}
            title={`${name} · ${fmtTime(b.outEnd - b.outStart)}`}
          >
            {i + 1} · {name}
          </div>
        )
      })}
      {timeline.imageSpans.map((s) => {
        const img = assets[s.assetId]
        const take = project.takes.find((t) => t.id === s.takeId)
        const inherited = !take?.images.includes(s.assetId)
        const isSel = selection.type === 'image' && selection.takeId === s.takeId && selection.assetId === s.assetId
        return (
          <div
            key={`${s.takeId}-${s.index}`}
            className={`tl-img ${inherited ? 'inherited' : ''} ${isSel ? 'selected' : ''}`}
            style={{ left: pct(s.outStart), width: pct(s.outEnd - s.outStart) }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-kol-image', JSON.stringify({ assetId: s.assetId, fromTakeId: inherited ? null : s.takeId }))
              e.dataTransfer.effectAllowed = 'copyMove'
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              select({ type: 'image', takeId: s.takeId, assetId: s.assetId })
            }}
            title={`${img?.name ?? ''}${inherited ? ' (herdada do take anterior)' : ''} · arraste para outro take (Alt = copiar)`}
          >
            {img && <img src={img.url} alt="" draggable={false} />}
          </div>
        )
      })}
      {timeline.takeBlocks.map((b) => {
        const take = project.takes.find((t) => t.id === b.takeId)
        if (!take || take.images.length < 2) return null
        const splits = normalizeSplits(take.splits, take.images.length)
        return splits.map((f, i) => (
          <div
            key={`${b.takeId}-split-${i}`}
            className="tl-split"
            style={{ left: pct(b.outStart + f * (b.outEnd - b.outStart)) }}
            onPointerDown={(e) => {
              e.stopPropagation()
              dragSplit.current = { takeId: b.takeId, index: i, splits, start: b.outStart, end: b.outEnd }
              ;(e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId)
            }}
            title="Arraste pra mudar o ponto de troca"
          />
        ))
      })}
      {ticks.map((t) => (
        <div key={t} style={{ position: 'absolute', bottom: 0, left: pct(t), fontSize: 10, color: 'var(--muted)', transform: 'translateX(-50%)' }}>
          {fmtTime(t)}
        </div>
      ))}
      <div className="tl-playhead" style={{ left: pct(Math.min(playhead, dur)) }} />
    </div>
  )
}

function TakeStrip({ takeId }: { takeId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const analyses = useStore((s) => s.analyses)
  const addManualCut = useStore((s) => s.addManualCut)
  const restoreCut = useStore((s) => s.restoreCut)
  const updateTake = useStore((s) => s.updateTake)
  const playhead = useStore((s) => s.playhead)
  const [sel, setSel] = useState<Interval | null>(null)
  const dragStart = useRef<number | null>(null)

  const take = project.takes.find((t) => t.id === takeId)
  const asset = take ? assets[take.assetId] : null
  const dur = asset?.duration ?? 0
  const analysis = take ? analyses[take.assetId] : undefined

  const kept = useMemo(() => {
    if (!take) return []
    return takeKept(
      { project, assets: new Map(Object.entries(assets)), analyses: new Map(Object.entries(analyses)) },
      take,
    )
  }, [take, project, assets, analyses])

  // tempo do playhead dentro deste take (no arquivo original)
  const srcPlayhead = useMemo(() => {
    if (!take) return null
    const inputs = { project, assets: new Map(Object.entries(assets)), analyses: new Map(Object.entries(analyses)) }
    // recomputa a posição somando segmentos anteriores
    let t = 0
    const clip = project.clipId ? assets[project.clipId] : null
    if (clip?.duration) {
      const inT = project.clip.in
      const outT = project.clip.out ?? clip.duration
      if (outT - inT > 0.05) t = outT - inT
    }
    for (const tk of project.takes) {
      if (!tk.enabled || assets[tk.assetId]?.status !== 'ready') continue
      const rate = tk.speed ?? project.speed
      for (const iv of takeKept(inputs, tk)) {
        const d = (iv.end - iv.start) / rate
        if (tk.id === take.id && playhead >= t && playhead < t + d) return iv.start + (playhead - t) * rate
        t += d
      }
    }
    return null
  }, [take, project, assets, analyses, playhead])

  if (!take || !asset || dur <= 0) return null
  const pct = (t: number) => `${(t / dur) * 100}%`
  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur))
  }

  // trechos cortados = complemento dos mantidos dentro dos trims
  const lo = take.trimStart
  const hi = dur - take.trimEnd
  const cuts: Interval[] = []
  let cursor = lo
  for (const k of kept) {
    if (k.start > cursor + 0.005) cuts.push({ start: cursor, end: k.start })
    cursor = Math.max(cursor, k.end)
  }
  if (hi > cursor + 0.005) cuts.push({ start: cursor, end: hi })

  return (
    <>
      <div
        className="take-strip"
        ref={ref}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).classList.contains('cut')) return
          dragStart.current = timeAt(e.clientX)
          setSel(null)
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (dragStart.current == null) return
          const t = timeAt(e.clientX)
          const a = Math.min(dragStart.current, t)
          const b = Math.max(dragStart.current, t)
          if (b - a > 0.03) setSel({ start: a, end: b })
        }}
        onPointerUp={(e) => {
          dragStart.current = null
          try {
            ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
          } catch {
            /* ok */
          }
        }}
      >
        {analysis && <RmsCanvas rms={analysis.rms} threshold={analysis.thresholdDb} />}
        {lo > 0 && <div className="seg trim" style={{ left: 0, width: pct(lo) }} title="Aparado" />}
        {hi < dur && <div className="seg trim" style={{ left: pct(hi), width: pct(dur - hi) }} title="Aparado" />}
        {kept.map((k, i) => (
          <div key={'k' + i} className="seg keep" style={{ left: pct(k.start), width: pct(k.end - k.start), opacity: 0.55 }} title={`Mantido ${fmtTime(k.start)} – ${fmtTime(k.end)}`} />
        ))}
        {cuts.map((c, i) => (
          <div
            key={'c' + i}
            className="seg cut"
            style={{ left: pct(c.start), width: pct(c.end - c.start), opacity: 0.8 }}
            title={`Cortado ${fmtTime(c.start)} – ${fmtTime(c.end)} · clique pra restaurar`}
            onClick={(e) => {
              e.stopPropagation()
              restoreCut(takeId, c)
            }}
          />
        ))}
        {sel && <div className="sel" style={{ left: pct(sel.start), width: pct(sel.end - sel.start) }} />}
        {srcPlayhead != null && <div className="ph" style={{ left: pct(srcPlayhead) }} />}
      </div>
      <div className="tl-foot">
        <span>
          Take {project.takes.indexOf(take) + 1} · {asset.name} · verde = mantido, vermelho = cortado (clique pra restaurar), listrado = aparado. Arraste pra
          selecionar um trecho e cortar.
        </span>
        <span className="spacer" />
        {sel && (
          <>
            <span>
              {fmtTime(sel.start)} – {fmtTime(sel.end)}
            </span>
            <button
              className="small"
              onClick={() => {
                addManualCut(takeId, sel)
                setSel(null)
              }}
            >
              Cortar trecho
            </button>
            <button
              className="small"
              onClick={() => {
                restoreCut(takeId, sel)
                setSel(null)
              }}
            >
              Restaurar trecho
            </button>
            <button className="small" onClick={() => setSel(null)}>
              Limpar
            </button>
          </>
        )}
        {(take.manualCuts.length > 0 || take.manualKeeps.length > 0) && (
          <button className="small" onClick={() => updateTake(takeId, { manualCuts: [], manualKeeps: [] })}>
            Desfazer edições manuais
          </button>
        )}
      </div>
    </>
  )
}

function RmsCanvas({ rms, threshold }: { rms: Float32Array; threshold: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const draw = (c: HTMLCanvasElement | null) => {
    if (!c) return
    const w = (c.width = c.clientWidth || 800)
    const h = (c.height = 54)
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    const minDb = -70
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    const n = rms.length
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((x / w) * n)
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n))
      let m = minDb
      for (let i = i0; i < i1 && i < n; i++) if (rms[i] > m) m = rms[i]
      const v = Math.max(0, Math.min(1, (m - minDb) / -minDb))
      ctx.fillRect(x, h - v * h, 1, v * h)
    }
    const ty = h - Math.max(0, Math.min(1, (threshold - minDb) / -minDb)) * h
    ctx.strokeStyle = 'rgba(240,180,41,0.8)'
    ctx.beginPath()
    ctx.moveTo(0, ty)
    ctx.lineTo(w, ty)
    ctx.stroke()
  }
  return (
    <canvas
      className="rms"
      ref={(c) => {
        ref.current = c
        draw(c)
      }}
    />
  )
}
