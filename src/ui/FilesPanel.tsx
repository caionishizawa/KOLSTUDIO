import { useRef, useState, type DragEvent } from 'react'
import { useStore, type Selection } from '../state/store'
import type { Asset, AssetKind, TakeOrder } from '../types'
import { fromFileList, readDrop } from '../lib/classify'
import { fmtTime } from '../state/useTimeline'

const KIND_LABEL: Record<AssetKind, string> = {
  clip: 'Clipe da react',
  reaction: 'Reação',
  take: 'Take',
  image: 'Imagem',
  music: 'Música',
  unknown: '?',
}

const ACCEPT: Record<AssetKind, string> = {
  clip: 'video/*,.mp4,.mov',
  reaction: 'video/*,.mp4,.mov',
  take: 'video/*,.mp4,.mov',
  image: 'image/*,.png,.jpg,.jpeg,.webp,video/*,.mp4,.mov',
  music: 'audio/*,.mp3,.m4a,.wav',
  unknown: '*',
}

export function FilesPanel() {
  const assets = useStore((s) => s.assets)
  const project = useStore((s) => s.project)
  const addFiles = useStore((s) => s.addFiles)
  const [overGlobal, setOverGlobal] = useState(false)
  const dirInput = useRef<HTMLInputElement>(null)

  const onGlobalDrop = async (e: DragEvent) => {
    e.preventDefault()
    setOverGlobal(false)
    const files = await readDrop(e.dataTransfer)
    await addFiles(files)
  }

  const list = Object.values(assets)
  const byKind = (k: AssetKind) => list.filter((a) => a.kind === k)
  const takesOrdered = project.takes.map((t) => assets[t.assetId]).filter(Boolean) as Asset[]

  return (
    <aside className="panel files">
      <div
        className={`dropzone global ${overGlobal ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOverGlobal(true)
        }}
        onDragLeave={() => setOverGlobal(false)}
        onDrop={onGlobalDrop}
        onClick={() => dirInput.current?.click()}
      >
        Arraste uma pasta inteira aqui (ou clique)
        <br />
        <span className="dz-hint">classifica por subpasta e nome: clipe*, reacao*, takes, imagens, musica</span>
        <input
          ref={dirInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          // @ts-expect-error atributo não padrão do Chrome
          webkitdirectory=""
          onChange={async (e) => {
            if (e.target.files) await addFiles(fromFileList(e.target.files))
            e.target.value = ''
          }}
        />
      </div>

      <Zone kind="clip" assets={byKind('clip')} activeId={project.clipId} hint="MP4/MOV de outra pessoa, com áudio" />
      <Zone kind="reaction" assets={byKind('reaction')} activeId={project.reactionId} hint="seu rosto reagindo em silêncio" />
      <TakesZone assets={takesOrdered} />
      <Zone kind="image" assets={byKind('image')} hint="PNG/JPG/WEBP · número no nome = take (3.png, 3a.png)" />
      <Zone kind="music" assets={byKind('music')} activeId={project.music.assetId} hint="MP3/M4A/WAV" />
    </aside>
  )
}

function Zone({ kind, assets, hint, activeId }: { kind: AssetKind; assets: Asset[]; hint: string; activeId?: string | null }) {
  const addFiles = useStore((s) => s.addFiles)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const files = await readDrop(e.dataTransfer)
        if (files.length) await addFiles(files, kind)
      }}
    >
      <div className="dz-head">
        <div>
          <div className="dz-title">{KIND_LABEL[kind]}{kind === 'image' ? 's' : ''}</div>
          <div className="dz-hint">{hint}</div>
        </div>
        <button className="small" onClick={() => input.current?.click()}>
          + Adicionar
        </button>
        <input
          ref={input}
          type="file"
          multiple={kind !== 'clip' && kind !== 'reaction'}
          accept={ACCEPT[kind]}
          style={{ display: 'none' }}
          onChange={async (e) => {
            if (e.target.files) await addFiles(fromFileList(e.target.files), kind)
            e.target.value = ''
          }}
        />
      </div>
      {assets.map((a) => (
        <AssetRow key={a.id} asset={a} active={activeId === a.id} />
      ))}
    </div>
  )
}

function TakesZone({ assets }: { assets: Asset[] }) {
  const addFiles = useStore((s) => s.addFiles)
  const project = useStore((s) => s.project)
  const reorder = useStore((s) => s.reorderTakes)
  const setTakeOrder = useStore((s) => s.setTakeOrder)
  const [over, setOver] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (dragIdx !== null) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        if (dragIdx !== null) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const files = await readDrop(e.dataTransfer)
        if (files.length) await addFiles(files, 'take')
      }}
    >
      <div className="dz-head">
        <div>
          <div className="dz-title">Takes</div>
          <div className="dz-hint">
            ordenar por{' '}
            <select
              value={project.takeOrder}
              onChange={(e) => setTakeOrder(e.target.value as TakeOrder)}
              style={{ width: 'auto', padding: '1px 4px', fontSize: 11 }}
              title="Critério de ordem dos takes. Arrastar na lista passa a valer a ordem manual."
            >
              <option value="date">data de gravação</option>
              <option value="name">nome</option>
              <option value="upload">ordem de envio</option>
            </select>
            {project.takesManual ? ' · manual' : ''}
          </div>
        </div>
        <button className="small" onClick={() => input.current?.click()}>
          + Adicionar
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT.take}
          style={{ display: 'none' }}
          onChange={async (e) => {
            if (e.target.files) await addFiles(fromFileList(e.target.files), 'take')
            e.target.value = ''
          }}
        />
      </div>
      {project.takes.map((t, i) => {
        const a = assets.find((x) => x.id === t.assetId)
        if (!a) return null
        return (
          <AssetRow
            key={a.id}
            asset={a}
            takeIndex={i}
            takeId={t.id}
            enabled={t.enabled}
            dragging={dragIdx === i}
            dropBefore={dropIdx === i}
            onDragStart={() => setDragIdx(i)}
            onDragOverRow={(e) => {
              if (dragIdx === null) return
              e.preventDefault()
              e.stopPropagation()
              setDropIdx(i)
            }}
            onDropRow={(e) => {
              if (dragIdx === null) return
              e.preventDefault()
              e.stopPropagation()
              const to = dragIdx < i ? i - 1 : i
              if (dragIdx !== i) reorder(dragIdx, to)
              setDragIdx(null)
              setDropIdx(null)
            }}
            onDragEnd={() => {
              setDragIdx(null)
              setDropIdx(null)
            }}
          />
        )
      })}
    </div>
  )
}

interface RowProps {
  asset: Asset
  active?: boolean
  takeIndex?: number
  takeId?: string
  enabled?: boolean
  dragging?: boolean
  dropBefore?: boolean
  onDragStart?: () => void
  onDragOverRow?: (e: DragEvent) => void
  onDropRow?: (e: DragEvent) => void
  onDragEnd?: () => void
}

function AssetRow(p: RowProps) {
  const { asset: a } = p
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const remove = useStore((s) => s.removeAsset)
  const setKind = useStore((s) => s.setAssetKind)
  const updateTake = useStore((s) => s.updateTake)
  const updateProject = useStore((s) => s.updateProject)
  const reassign = useStore((s) => s.reassignImages)

  const sel: Selection | null =
    a.kind === 'take' && p.takeId
      ? { type: 'take', id: p.takeId }
      : a.kind === 'clip'
        ? { type: 'clip' }
        : a.kind === 'reaction'
          ? { type: 'reaction' }
          : a.kind === 'music'
            ? { type: 'music' }
            : null
  const isSelected =
    !!sel &&
    ((sel.type === 'take' && selection.type === 'take' && selection.id === sel.id) ||
      (sel.type !== 'take' && selection.type === sel.type && (a.kind !== 'clip' || true)))

  const onClick = () => {
    if (a.kind === 'clip') updateProject({ clipId: a.id })
    if (a.kind === 'reaction') updateProject({ reactionId: a.id })
    if (a.kind === 'music') updateProject((prj) => ({ music: { ...prj.music, assetId: a.id } }))
    if (sel) select(sel)
  }

  const isTake = a.kind === 'take' && p.takeId
  return (
    <div
      className={`asset ${isSelected && (p.active ?? true) ? 'selected' : ''} ${p.enabled === false ? 'disabled' : ''} ${p.dragging ? 'dragging' : ''} ${p.dropBefore ? 'drop-before' : ''}`}
      onClick={onClick}
      draggable={a.kind === 'image' || !!isTake}
      onDragStart={(e) => {
        if (a.kind === 'image') {
          e.dataTransfer.setData('application/x-kol-image', JSON.stringify({ assetId: a.id, fromTakeId: null }))
          e.dataTransfer.effectAllowed = 'copyMove'
        } else if (isTake) {
          e.dataTransfer.setData('application/x-kol-take', p.takeId!)
          e.dataTransfer.effectAllowed = 'move'
          p.onDragStart?.()
        }
      }}
      onDragOver={p.onDragOverRow}
      onDrop={p.onDropRow}
      onDragEnd={p.onDragEnd}
      title={a.warning ?? a.name}
    >
      {isTake && <span className="grip">⋮⋮</span>}
      {isTake && (
        <input
          type="checkbox"
          checked={p.enabled !== false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            updateTake(p.takeId!, { enabled: e.target.checked })
            setTimeout(reassign, 0)
          }}
          title="Ativar/desativar take"
        />
      )}
      {a.type === 'image' ? <img className="thumb" src={a.url} alt="" /> : null}
      <div className="name">
        {isTake ? <span className="tag">{(p.takeIndex ?? 0) + 1}</span> : null} {a.name}
        <div className="meta">
          {a.status === 'ready' ? (
            <>
              {a.duration != null ? fmtTime(a.duration) : null}
              {a.width ? ` · ${a.width}×${a.height}` : null}
              {a.warning ? <span className="warn"> · ⚠ {a.warning}</span> : null}
            </>
          ) : a.status === 'error' ? (
            <span className="warn">erro: {a.error}</span>
          ) : a.status === 'transcoding' ? (
            <span className="status">convertendo com FFmpeg…</span>
          ) : (
            <span className="status">lendo…</span>
          )}
        </div>
      </div>
      {a.type === 'video' && (
        <select
          value={a.kind}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setKind(a.id, e.target.value as AssetKind)}
          title="Corrigir classificação"
        >
          <option value="clip">Clipe</option>
          <option value="reaction">Reação</option>
          <option value="take">Take</option>
          <option value="image">Apoio</option>
        </select>
      )}
      <button
        className="x"
        onClick={(e) => {
          e.stopPropagation()
          remove(a.id)
        }}
        title="Remover"
      >
        ×
      </button>
    </div>
  )
}
