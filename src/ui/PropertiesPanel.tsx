import { useStore } from '../state/store'
import type { FaceAlign, Project, SilenceIntensity, Take, Timeline } from '../types'
import { SILENCE_PRESETS } from '../types'
import { fmtTime } from '../state/useTimeline'

export function PropertiesPanel({ timeline }: { timeline: Timeline }) {
  const selection = useStore((s) => s.selection)
  const project = useStore((s) => s.project)
  return (
    <aside className="panel props">
      {selection.type === 'take' ? (
        <TakeProps takeId={selection.id} timeline={timeline} />
      ) : selection.type === 'image' ? (
        <ImageProps takeId={selection.takeId} assetId={selection.assetId} />
      ) : selection.type === 'clip' ? (
        <ClipProps />
      ) : selection.type === 'music' ? (
        <MusicProps />
      ) : selection.type === 'title' ? (
        <TitleProps />
      ) : selection.type === 'reaction' ? (
        <ReactionProps />
      ) : (
        <ProjectProps project={project} timeline={timeline} />
      )}
    </aside>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="value fixed">{format ? format(value) : value.toFixed(2)}</span>
      </div>
    </div>
  )
}

function ProjectProps({ project, timeline }: { project: Project; timeline: Timeline }) {
  const updateProject = useStore((s) => s.updateProject)
  const segInfo = useStore((s) => s.segmenterInfo)
  const takesCount = project.takes.filter((t) => t.enabled).length
  return (
    <>
      <h2>Projeto</h2>
      <p className="note">
        {timeline.reactDuration > 0 ? `React ${fmtTime(timeline.reactDuration)} · ` : 'Sem clipe (começa no take 1) · '}
        {takesCount} take{takesCount === 1 ? '' : 's'} · total {fmtTime(timeline.duration)}
        <br />
        Recorte: {segInfo || 'carregando…'}
      </p>

      <h2>Velocidade geral (takes)</h2>
      <Slider
        label="A react fica sempre em 1x. Tom da voz preservado."
        value={project.speed}
        min={0.8}
        max={1.5}
        step={0.01}
        onChange={(v) => updateProject({ speed: v })}
        format={(v) => v.toFixed(2) + 'x'}
      />
      <div className="btn-group" style={{ marginBottom: 10 }}>
        {[1, 1.1, 1.2, 1.25].map((v) => (
          <button key={v} className={Math.abs(project.speed - v) < 0.001 ? 'active' : ''} onClick={() => updateProject({ speed: v })}>
            {v}x
          </button>
        ))}
      </div>

      <h2>Corte de pausas</h2>
      <div className="btn-group" style={{ marginBottom: 6 }}>
        {(Object.keys(SILENCE_PRESETS) as SilenceIntensity[]).map((k) => (
          <button key={k} className={project.silence === k ? 'active' : ''} onClick={() => updateProject({ silence: k })}>
            {SILENCE_PRESETS[k].label}
          </button>
        ))}
      </div>
      <p className="note">
        Remove silêncio acima de {Math.round(SILENCE_PRESETS[project.silence].minSilence * 1000)} ms, margem de{' '}
        {Math.round(SILENCE_PRESETS[project.silence].margin * 1000)} ms antes e depois da fala. Só nos takes.
      </p>

      <TitleFields />
      <DisclaimerFields />
      <MusicFields />

      <h2>Rosto (padrão dos takes)</h2>
      <p className="note">Posição e tamanho por take ficam nas propriedades de cada take. Arraste o rosto no preview; roda do mouse muda o tamanho.</p>
      <div className="btn-group">
        {(['left', 'center', 'right'] as FaceAlign[]).map((a) => (
          <button
            key={a}
            className={project.faceDefault.align === a ? 'active' : ''}
            onClick={() => updateProject({ faceDefault: { ...project.faceDefault, align: a } })}
          >
            {a === 'left' ? 'Esquerda' : a === 'center' ? 'Centro' : 'Direita'}
          </button>
        ))}
      </div>
    </>
  )
}

function TitleFields() {
  const title = useStore((s) => s.project.title)
  const updateProject = useStore((s) => s.updateProject)
  return (
    <>
      <h2>Título (gancho)</h2>
      <div className="field">
        <textarea
          value={title.text}
          placeholder="Ex: Ele perdeu TUDO em 3 dias 😳"
          onChange={(e) => updateProject((p) => ({ title: { ...p.title, text: e.target.value } }))}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={title.enabled} onChange={(e) => updateProject((p) => ({ title: { ...p.title, enabled: e.target.checked } }))} />
        Mostrar título
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={title.wholeVideo}
          onChange={(e) => updateProject((p) => ({ title: { ...p.title, wholeVideo: e.target.checked } }))}
        />
        Manter no vídeo todo (padrão: só na react)
      </label>
      <Slider
        label="Largura da caixa"
        value={title.width}
        min={500}
        max={1060}
        step={10}
        onChange={(v) => updateProject((p) => ({ title: { ...p.title, width: v } }))}
        format={(v) => `${v}px`}
      />
      <button className="small" onClick={() => updateProject((p) => ({ title: { ...p.title, x: 540, y: 260 } }))}>
        Recentralizar título
      </button>
    </>
  )
}

function TitleProps() {
  return (
    <>
      <TitleFields />
      <p className="note" style={{ marginTop: 10 }}>
        Arraste a caixa no preview pra mudar a posição.
      </p>
    </>
  )
}

function DisclaimerFields() {
  const d = useStore((s) => s.project.disclaimer)
  const updateProject = useStore((s) => s.updateProject)
  return (
    <>
      <h2>Aviso fixo (rodapé)</h2>
      <label className="check">
        <input type="checkbox" checked={d.enabled} onChange={(e) => updateProject((p) => ({ disclaimer: { ...p.disclaimer, enabled: e.target.checked } }))} />
        Mostrar aviso
      </label>
      <div className="field">
        <textarea value={d.text} onChange={(e) => updateProject((p) => ({ disclaimer: { ...p.disclaimer, text: e.target.value } }))} />
      </div>
    </>
  )
}

function MusicFields() {
  const music = useStore((s) => s.project.music)
  const assets = useStore((s) => s.assets)
  const updateProject = useStore((s) => s.updateProject)
  const asset = music.assetId ? assets[music.assetId] : null
  const dur = asset?.duration ?? 0
  return (
    <>
      <h2>Música de fundo</h2>
      {!asset ? (
        <p className="note">Adicione uma música no painel da esquerda.</p>
      ) : (
        <>
          <p className="note">{asset.name} · {fmtTime(dur)}{dur > 0 ? ' · repete se for mais curta que o vídeo, fade de 1 s no fim' : ''}</p>
          <Slider
            label="Volume em relação à voz"
            value={music.gainDb}
            min={-30}
            max={0}
            step={0.5}
            onChange={(v) => updateProject((p) => ({ music: { ...p.music, gainDb: v } }))}
            format={(v) => `${v.toFixed(1)} dB`}
          />
          <Slider
            label="Ponto de início na música"
            value={music.start}
            min={0}
            max={Math.max(0.1, dur)}
            step={0.1}
            onChange={(v) => updateProject((p) => ({ music: { ...p.music, start: v } }))}
            format={fmtTime}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={music.muteDuringReact}
              onChange={(e) => updateProject((p) => ({ music: { ...p.music, muteDuringReact: e.target.checked } }))}
            />
            Silenciar durante a react
          </label>
        </>
      )}
    </>
  )
}

function MusicProps() {
  return <MusicFields />
}

function ReactionProps() {
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const a = project.reactionId ? assets[project.reactionId] : null
  return (
    <>
      <h2>Reação</h2>
      <p className="note">
        {a ? `${a.name} · ${fmtTime(a.duration ?? 0)}` : 'Nenhum arquivo de reação.'}
        <br />
        O áudio da reação fica desligado. Se for mais curta que o clipe, congela no último quadro; se for mais longa, corta. O rosto usa a
        posição padrão dos takes (arraste no preview).
      </p>
    </>
  )
}

function ClipProps() {
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const updateProject = useStore((s) => s.updateProject)
  const playhead = useStore((s) => s.playhead)
  const a = project.clipId ? assets[project.clipId] : null
  if (!a) return <p className="note">Nenhum clipe.</p>
  const dur = a.duration ?? 0
  const out = project.clip.out ?? dur
  const setClip = (patch: Partial<Project['clip']>) => updateProject((p) => ({ clip: { ...p.clip, ...patch } }))
  const t = project.clip.transform
  return (
    <>
      <h2>Clipe da react</h2>
      <p className="note">{a.name} · {fmtTime(dur)} · {a.width}×{a.height}</p>
      <div className="field">
        <label>Início do trecho (s)</label>
        <div className="row">
          <input type="number" step={0.1} min={0} max={out} value={project.clip.in.toFixed(2)} onChange={(e) => setClip({ in: clampN(parseFloat(e.target.value), 0, out - 0.1) })} />
          <button className="fixed small" onClick={() => setClip({ in: clampN(playhead, 0, out - 0.1) })} title="Usa a posição atual do preview (dentro da react)">
            Marcar no playhead
          </button>
        </div>
      </div>
      <div className="field">
        <label>Fim do trecho (s)</label>
        <div className="row">
          <input type="number" step={0.1} min={project.clip.in} max={dur} value={out.toFixed(2)} onChange={(e) => setClip({ out: clampN(parseFloat(e.target.value), project.clip.in + 0.1, dur) })} />
          <button className="fixed small" onClick={() => setClip({ out: clampN(project.clip.in + playhead, project.clip.in + 0.1, dur) })}>
            Marcar no playhead
          </button>
        </div>
      </div>
      <p className="note">Duração da react: {fmtTime(out - project.clip.in)}</p>
      <h2>Enquadramento</h2>
      <Slider label="Zoom (recorta o centro em 16:9)" value={t.zoom} min={1} max={4} step={0.01} onChange={(v) => setClip({ transform: { ...t, zoom: v } })} format={(v) => v.toFixed(2) + 'x'} />
      <Slider label="Deslocamento horizontal" value={t.x} min={-1080} max={1080} step={1} onChange={(v) => setClip({ transform: { ...t, x: v } })} format={(v) => `${Math.round(v)}`} />
      <Slider label="Deslocamento vertical" value={t.y} min={-1920} max={1920} step={1} onChange={(v) => setClip({ transform: { ...t, y: v } })} format={(v) => `${Math.round(v)}`} />
      <button className="small" onClick={() => setClip({ transform: { zoom: 1, x: 0, y: 0 } })}>
        Resetar enquadramento
      </button>
    </>
  )
}

function TakeProps({ takeId, timeline }: { takeId: string; timeline: Timeline }) {
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const analyses = useStore((s) => s.analyses)
  const updateTake = useStore((s) => s.updateTake)
  const setTakeFace = useStore((s) => s.setTakeFace)
  const setTakeImages = useStore((s) => s.setTakeImages)
  const select = useStore((s) => s.select)
  const reassign = useStore((s) => s.reassignImages)
  const take = project.takes.find((t) => t.id === takeId)
  if (!take) return <p className="note">Take não encontrado.</p>
  const a = assets[take.assetId]
  const idx = project.takes.indexOf(take)
  const dur = a?.duration ?? 0
  const block = timeline.takeBlocks.find((b) => b.takeId === takeId)
  const an = analyses[take.assetId]
  const images = Object.values(assets).filter((x) => x.kind === 'image' && x.status === 'ready')
  return (
    <>
      <h2>Take {idx + 1}</h2>
      <p className="note">
        {a?.name} · original {fmtTime(dur)} · no vídeo {block ? fmtTime(block.outEnd - block.outStart) : '—'}
        {an ? ` · ruído ${an.noiseFloorDb.toFixed(0)} dB, limiar ${an.thresholdDb.toFixed(0)} dB` : ''}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={take.enabled}
          onChange={(e) => {
            updateTake(takeId, { enabled: e.target.checked })
            setTimeout(reassign, 0)
          }}
        />
        Take ativo
      </label>

      <h2>Aparar</h2>
      <div className="field">
        <div className="row">
          <div>
            <label>Início (s)</label>
            <input type="number" step={0.1} min={0} max={dur} value={take.trimStart} onChange={(e) => updateTake(takeId, { trimStart: clampN(parseFloat(e.target.value) || 0, 0, dur) })} />
          </div>
          <div>
            <label>Fim (s cortados)</label>
            <input type="number" step={0.1} min={0} max={dur} value={take.trimEnd} onChange={(e) => updateTake(takeId, { trimEnd: clampN(parseFloat(e.target.value) || 0, 0, dur) })} />
          </div>
        </div>
      </div>

      <h2>Velocidade deste take</h2>
      <label className="check">
        <input type="checkbox" checked={take.speed != null} onChange={(e) => updateTake(takeId, { speed: e.target.checked ? project.speed : null })} />
        Ajuste próprio (senão usa a geral: {project.speed.toFixed(2)}x)
      </label>
      {take.speed != null && (
        <Slider label="Velocidade" value={take.speed} min={0.8} max={1.5} step={0.01} onChange={(v) => updateTake(takeId, { speed: v })} format={(v) => v.toFixed(2) + 'x'} />
      )}

      <h2>Rosto</h2>
      <div className="btn-group" style={{ marginBottom: 8 }}>
        {(['left', 'center', 'right'] as FaceAlign[]).map((al) => (
          <button key={al} className={take.face.align === al ? 'active' : ''} onClick={() => setTakeFace(takeId, { align: al, x: 0 })}>
            {al === 'left' ? 'Esquerda' : al === 'center' ? 'Centro' : 'Direita'}
          </button>
        ))}
      </div>
      <Slider label="Tamanho" value={take.face.scale} min={0.4} max={1.8} step={0.01} onChange={(v) => setTakeFace(takeId, { scale: v })} format={(v) => Math.round(v * 58) + '%'} />
      <div className="row" style={{ display: 'flex', gap: 6 }}>
        <button className="small" onClick={() => setTakeFace(takeId, { x: 0, y: 0 })}>
          Resetar posição
        </button>
        <button className="small" onClick={() => project.takes.forEach((t) => setTakeFace(t.id, { ...take.face }))} title="Copia posição/tamanho/alinhamento para todos os takes">
          Aplicar a todos
        </button>
      </div>

      <h2>Imagens deste take</h2>
      {block && block.images.length > 0 && take.images.length === 0 && <p className="note">Herdando a imagem do take anterior (sem imagem própria).</p>}
      {take.images.map((id, i) => {
        const img = assets[id]
        if (!img) return null
        return (
          <div key={id + i} className="card">
            <div className="card-head">
              <img className="thumb" src={img.url} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4 }} />
              <span className="name">{img.name}</span>
              <button className="small" onClick={() => select({ type: 'image', takeId, assetId: id })}>
                Ajustar
              </button>
              <button className="small danger" onClick={() => setTakeImages(takeId, take.images.filter((_, k) => k !== i))}>
                Tirar
              </button>
            </div>
          </div>
        )
      })}
      <div className="field">
        <label>Adicionar imagem a este take</label>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) setTakeImages(takeId, [...take.images, e.target.value])
          }}
        >
          <option value="">— escolher —</option>
          {images.map((img) => (
            <option key={img.id} value={img.id}>
              {img.name}
            </option>
          ))}
        </select>
      </div>
      {take.imagesLocked && (
        <button className="small" onClick={() => { updateTake(takeId, { imagesLocked: false }); setTimeout(reassign, 0) }}>
          Voltar à atribuição automática
        </button>
      )}
      <p className="note" style={{ marginTop: 8 }}>
        Arraste imagens entre takes na linha do tempo. Várias imagens no mesmo take dividem o tempo; arraste as linhas brancas pra mudar o ponto de troca.
      </p>
    </>
  )
}

function ImageProps({ takeId, assetId }: { takeId: string; assetId: string }) {
  const project = useStore((s) => s.project)
  const assets = useStore((s) => s.assets)
  const setImageTransform = useStore((s) => s.setImageTransform)
  const select = useStore((s) => s.select)
  const take = project.takes.find((t) => t.id === takeId)
  const img = assets[assetId]
  if (!take || !img) return <p className="note">Imagem não encontrada.</p>
  const t = take.imageTransforms[assetId] ?? { zoom: 1, x: 0, y: 0 }
  return (
    <>
      <h2>Imagem · take {project.takes.indexOf(take) + 1}</h2>
      <p className="note">
        {img.name} · {img.width}×{img.height}
        {img.warning ? ` · ⚠ ${img.warning}` : ''}
      </p>
      <img src={img.url} alt="" style={{ width: '100%', borderRadius: 6, marginBottom: 8 }} />
      <Slider label="Zoom" value={t.zoom} min={0.3} max={4} step={0.01} onChange={(v) => setImageTransform(takeId, assetId, { zoom: v })} format={(v) => v.toFixed(2) + 'x'} />
      <Slider label="Deslocamento horizontal" value={t.x} min={-1080} max={1080} step={1} onChange={(v) => setImageTransform(takeId, assetId, { x: v })} format={(v) => `${Math.round(v)}`} />
      <Slider label="Deslocamento vertical" value={t.y} min={-1920} max={1920} step={1} onChange={(v) => setImageTransform(takeId, assetId, { y: v })} format={(v) => `${Math.round(v)}`} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="small" onClick={() => setImageTransform(takeId, assetId, { zoom: 1, x: 0, y: 0 })}>
          Resetar
        </button>
        <button className="small" onClick={() => select({ type: 'take', id: takeId })}>
          Voltar ao take
        </button>
      </div>
      <p className="note" style={{ marginTop: 8 }}>Arraste a imagem no preview pra mover; roda do mouse dá zoom.</p>
    </>
  )
}

function clampN(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export type { Take }
