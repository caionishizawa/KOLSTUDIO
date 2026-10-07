import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { useTimeline } from '../state/useTimeline'
import { FilesPanel } from './FilesPanel'
import { PreviewPanel } from './PreviewPanel'
import { PropertiesPanel } from './PropertiesPanel'
import { TimelinePanel } from './TimelinePanel'
import { Exporter, buildJob, exportFileName, pickSaveHandle } from '../export/exporter'

export default function App() {
  const project = useStore((s) => s.project)
  const updateProject = useStore((s) => s.updateProject)
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotice)
  const exportState = useStore((s) => s.exportState)
  const setExportState = useStore((s) => s.setExportState)
  const notify = useStore((s) => s.notify)
  const timeline = useTimeline()
  const exporterRef = useRef<Exporter | null>(null)

  const startExport = useCallback(async () => {
    const { assets, analyses, project, playing } = useStore.getState()
    if (timeline.duration <= 0) {
      notify('Nada para exportar: adicione takes.', 'warn')
      return
    }
    if (playing) useStore.getState().setPlaying(false)
    const fileName = exportFileName(project.name)
    const picked = await pickSaveHandle(fileName)
    if (picked === 'cancelled') return
    const handle = picked
    const job = buildJob(project, timeline, assets, analyses, fileName)
    const exporter = new Exporter()
    exporterRef.current = exporter
    if (exportState.resultUrl) URL.revokeObjectURL(exportState.resultUrl)
    setExportState({
      running: true,
      progress: 0,
      frame: 0,
      totalFrames: Math.round(timeline.duration * 30),
      etaSec: null,
      message: 'Preparando…',
      error: null,
      resultUrl: null,
      resultName: fileName,
    })
    try {
      const buffer = await exporter.run(job, handle, {
        onProgress: (p) => {
          const frac = p.totalFrames ? p.frame / p.totalFrames : 0
          const eta = p.frame > 5 ? ((p.elapsedMs / 1000) * (1 - frac)) / frac : null
          setExportState({ progress: frac, frame: p.frame, totalFrames: p.totalFrames, etaSec: eta, message: p.stage })
        },
        onInfo: (text) => notify(text, 'info'),
      })
      if (buffer) {
        const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }))
        setExportState({ running: false, progress: 1, message: 'Pronto', resultUrl: url })
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        a.click()
      } else {
        setExportState({ running: false, progress: 1, message: 'Salvo em ' + fileName })
      }
      notify(`Exportado: ${fileName}`, 'info')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setExportState({ running: false, error: msg, message: 'Erro' })
      notify('Exportação falhou: ' + msg, 'error')
    }
  }, [timeline, notify, setExportState, exportState.resultUrl])

  const cancelExport = useCallback(() => {
    exporterRef.current?.cancel()
    setExportState({ running: false, message: 'Cancelado' })
  }, [setExportState])

  // atalhos: espaço = play/pause
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault()
        const s = useStore.getState()
        s.setPlaying(!s.playing)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ex = exportState
  return (
    <div className="app">
      <header className="header">
        <h1>Code KOL Studio</h1>
        <input
          className="project-name"
          type="text"
          value={project.name}
          onChange={(e) => updateProject({ name: e.target.value })}
          placeholder="Nome do projeto"
        />
        <div className="spacer" />
        {ex.running ? (
          <div className="export-box">
            <span>{ex.message}</span>
            <div className="progress">
              <div style={{ width: `${Math.round(ex.progress * 100)}%` }} />
            </div>
            <span>
              {Math.round(ex.progress * 100)}%{ex.etaSec != null ? ` · ~${Math.max(1, Math.round(ex.etaSec))}s` : ''}
            </span>
            <button className="small" onClick={cancelExport}>
              Cancelar
            </button>
          </div>
        ) : (
          <>
            {ex.resultUrl && (
              <a href={ex.resultUrl} download={ex.resultName ?? 'video.mp4'} className="note">
                Baixar de novo
              </a>
            )}
            <button className="primary" onClick={startExport} disabled={timeline.duration <= 0}>
              Exportar MP4
            </button>
          </>
        )}
      </header>
      <FilesPanel />
      <PreviewPanel timeline={timeline} />
      <PropertiesPanel timeline={timeline} />
      <TimelinePanel timeline={timeline} />
      <div className="notices">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.level}`}>
            <span style={{ flex: 1 }}>{n.text}</span>
            <button className="x" onClick={() => dismiss(n.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
