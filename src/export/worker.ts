/// <reference lib="webworker" />
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo,
  type InputVideoTrack,
} from 'mediabunny'
import type { ExportJob, WorkerIn, WorkerOut } from './types'
import { CANVAS_H, CANVAS_W, FPS, defaultTransform } from '../types'
import { createScratch, drawFrame, type FrameParams, type FrameSources } from '../render/compositor'
import { Segmenter } from '../render/segmenter'
import { MaskReader } from '../cache/maskCache'
import { SR, applyGain, decodeRange, fadeEdges, limit, mixInto, stereo, timeStretch, type Stereo } from './audio'
import { measureLoudnessPlanar } from '../lib/loudness'
import { VOICE_TARGET_LUFS } from '../lib/silence'

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ? { transfer } : undefined)

let cancelled = false
let currentOutput: Output | null = null

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data
  if (msg.type === 'cancel') {
    cancelled = true
    try {
      await currentOutput?.cancel()
    } catch {
      /* ignora */
    }
    return
  }
  if (msg.type === 'start') {
    cancelled = false
    try {
      await runExport(msg.job, msg.handle)
    } catch (e) {
      if (!cancelled) post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}

interface VideoReader {
  input: Input
  track: InputVideoTrack
  sink: VideoSampleSink
  w: number
  h: number
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
}

async function openVideo(file: Blob): Promise<VideoReader> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('Arquivo sem trilha de vídeo')
  if (!(await track.canDecode())) throw new Error('Vídeo não decodificável: ' + (await track.getCodec()))
  const w = await track.getDisplayWidth()
  const h = await track.getDisplayHeight()
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  const sink = new VideoSampleSink(track, { hardwareAcceleration: 'no-preference' })
  return { input, track, sink, w, h, canvas, ctx }
}

async function runExport(job: ExportJob, handle: FileSystemFileHandle | null) {
  const t0 = performance.now()
  const { project, timeline, assets } = job
  const totalFrames = Math.max(1, Math.round(timeline.duration * FPS))
  const progress = (stage: string, frame: number) =>
    post({ type: 'progress', stage, frame, totalFrames, elapsedMs: performance.now() - t0 })

  // ---- capacidade de codecs ----
  let videoCodec: 'avc' | 'vp9' = 'avc'
  let audioCodec: 'aac' | 'opus' = 'aac'
  const videoOk = await canEncodeVideo('avc', { width: CANVAS_W, height: CANVAS_H, frameRate: FPS })
  const audioOk = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SR })
  if (!videoOk || !audioOk) {
    if (job.debugCodec === 'vp9') {
      videoCodec = 'vp9'
      audioCodec = 'opus'
      post({ type: 'info', text: 'Modo de teste: exportando em VP9 + Opus (este navegador não tem H.264/AAC).' })
    } else if (!videoOk) throw new Error('Este Chrome não codifica H.264 (AVC) em 1080x1920 via WebCodecs.')
    else throw new Error('Este Chrome não codifica AAC via WebCodecs.')
  }

  // ---- áudio (offline) ----
  progress('Mixando áudio', 0)
  const mix = await buildAudio(job)
  if (cancelled) return

  // ---- saída ----
  let writable: FileSystemWritableFileStream | null = null
  const target = handle ? new StreamTarget((writable = await handle.createWritable()), { chunked: true }) : new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: handle ? false : 'in-memory' }), target })
  currentOutput = output
  const videoSource = new VideoSampleSource({
    codec: videoCodec,
    bitrate: 12_000_000,
    keyFrameInterval: 2,
    hardwareAcceleration: 'no-preference',
    latencyMode: 'quality',
  })
  const audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: 192_000 })
  output.addVideoTrack(videoSource, { frameRate: FPS })
  output.addAudioTrack(audioSource)
  await output.start()

  // áudio em blocos de 100 ms
  const chunk = SR / 10
  for (let i = 0; i < mix.left.length; i += chunk) {
    if (cancelled) return
    const n = Math.min(chunk, mix.left.length - i)
    const data = new Float32Array(n * 2)
    data.set(mix.left.subarray(i, i + n), 0)
    data.set(mix.right.subarray(i, i + n), n)
    const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: SR, timestamp: i / SR })
    await audioSource.add(sample)
    sample.close()
  }
  audioSource.close()

  // ---- vídeo ----
  progress('Renderizando vídeo', 0)
  const canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H)
  const ctx = canvas.getContext('2d')!
  const scratch = createScratch()
  // máscaras pré-calculadas (cache OPFS); segmentação ao vivo só para o que faltar
  const readers = new Map<string, MaskReader>()
  for (const [assetId, key] of Object.entries(job.maskKeys ?? {})) {
    try {
      const r = await MaskReader.open(key)
      if (r) readers.set(assetId, r)
    } catch {
      /* sem cache: segmenta ao vivo */
    }
  }
  let segmenter = null as Segmenter | null
  let segmenterFailed = false
  const liveMask = async (assetId: string, source: OffscreenCanvas, w: number, h: number, srcTime: number, tsMs: number) => {
    const reader = readers.get(assetId)
    if (reader) {
      const c = await reader.canvasAt(srcTime)
      if (c) return c
    }
    if (segmenterFailed) return null
    if (!segmenter) {
      try {
        segmenter = await Segmenter.create('GPU', job.segModel ?? 'multiclass')
        post({ type: 'info', text: `Recorte ao vivo na exportação: MediaPipe ${segmenter.info.model === 'multiclass' ? 'multiclasse' : 'simples'} (${segmenter.info.delegate})` })
      } catch (e) {
        segmenterFailed = true
        post({ type: 'info', text: 'Recorte indisponível no worker, exportando sem recorte: ' + (e instanceof Error ? e.message : String(e)) })
        return null
      }
    }
    return segmenter.segment(source, w, h, tsMs)
  }
  if (readers.size > 0) post({ type: 'info', text: `Usando ${readers.size} máscara(s) pré-calculada(s) do cache.` })

  const videoReaders = new Map<string, VideoReader>()
  const getReader = async (assetId: string) => {
    let r = videoReaders.get(assetId)
    if (!r) {
      r = await openVideo(assets[assetId].file)
      videoReaders.set(assetId, r)
    }
    return r
  }
  const images = new Map<string, ImageBitmap>()
  const getImage = async (assetId: string) => {
    let b = images.get(assetId)
    if (!b) {
      b = await createImageBitmap(assets[assetId].file)
      images.set(assetId, b)
    }
    return b
  }

  const reactionAsset = project.reactionId ? assets[project.reactionId] : null
  let frame = 0
  let lastReport = 0

  try {
    for (const seg of timeline.segments) {
      if (cancelled) return
      const firstFrame = Math.ceil(seg.outStart * FPS - 1e-6)
      const lastFrame = Math.min(totalFrames - 1, Math.ceil(seg.outEnd * FPS - 1e-6) - 1)
      if (lastFrame < firstFrame) continue
      const times: number[] = []
      for (let f = firstFrame; f <= lastFrame; f++) times.push(f / FPS)
      const srcTimes = times.map((t) => Math.min(seg.srcEnd - 1e-4, seg.srcStart + (t - seg.outStart) * seg.rate))
      segmenter?.reset()
      const main = await getReader(seg.assetId)
      const mainIter = main.sink.samplesAtTimestamps(srcTimes)

      let reaction: VideoReader | null = null
      let reactionIter: AsyncGenerator<VideoSample | null> | null = null
      if (seg.kind === 'react' && reactionAsset) {
        reaction = await getReader(reactionAsset.id)
        const rDur = reactionAsset.duration ?? Infinity
        const rTimes = times.map((t) => Math.min(t - seg.outStart, Math.max(0, rDur - 0.05)))
        reactionIter = reaction.sink.samplesAtTimestamps(rTimes)
      }

      const take = seg.kind === 'take' ? project.takes.find((t) => t.id === seg.takeId) : undefined
      const spans = timeline.imageSpans.filter((s) => s.takeId === seg.takeId)

      for (let k = 0; k < times.length; k++) {
        if (cancelled) return
        const t = times[k]
        const sample = (await mainIter.next()).value as VideoSample | null | undefined
        if (sample) {
          sample.draw(main.ctx, 0, 0, main.w, main.h)
          sample.close()
        }
        let reactionSample: VideoSample | null = null
        if (reactionIter && reaction) {
          reactionSample = ((await reactionIter.next()).value as VideoSample | null | undefined) ?? null
          if (reactionSample) {
            reactionSample.draw(reaction.ctx, 0, 0, reaction.w, reaction.h)
            reactionSample.close()
          }
        }

        const sources: FrameSources = { clip: null, reaction: null, face: null, image: null }
        const params: FrameParams = {
          kind: seg.kind,
          clipTransform: project.clip.transform,
          face: take?.face ?? project.faceDefault,
          faceOnly: timeline.faceOnly,
          imageTransform: defaultTransform(),
          title: {
            text: project.title.text,
            show: project.title.enabled && (project.title.wholeVideo || seg.kind === 'react'),
            x: project.title.x,
            y: project.title.y,
            width: project.title.width,
            style: project.title.style,
            uppercase: project.title.uppercase,
            fontScale: project.title.fontScale,
          },
          disclaimer: project.disclaimer,
        }
        const tsMs = t * 1000
        if (seg.kind === 'react') {
          sources.clip = { source: main.canvas, w: main.w, h: main.h }
          if (reaction) {
            sources.reaction = {
              source: reaction.canvas,
              w: reaction.w,
              h: reaction.h,
              mask: reactionAsset ? await liveMask(reactionAsset.id, reaction.canvas, reaction.w, reaction.h, t - seg.outStart, tsMs) : null,
            }
          }
        } else {
          sources.face = {
            source: main.canvas,
            w: main.w,
            h: main.h,
            mask: take?.cutout !== false ? await liveMask(seg.assetId, main.canvas, main.w, main.h, srcTimes[k], tsMs) : null,
          }
          const span = spans.find((s) => t >= s.outStart && t < s.outEnd) ?? spans[spans.length - 1]
          if (span && assets[span.assetId]?.type === 'image') {
            const bmp = await getImage(span.assetId)
            sources.image = { source: bmp, w: bmp.width, h: bmp.height }
            params.imageTransform = take?.imageTransforms[span.assetId] ?? defaultTransform()
          }
        }
        drawFrame(ctx, sources, params, scratch)
        const vs = new VideoSample(canvas, { timestamp: frame / FPS, duration: 1 / FPS })
        await videoSource.add(vs)
        vs.close()
        frame++
        if (performance.now() - lastReport > 200) {
          lastReport = performance.now()
          progress('Renderizando vídeo', frame)
        }
      }
    }
    // garante o número exato de quadros (sem tela preta extra: repete o último quadro se faltar algum por arredondamento)
    while (frame < totalFrames) {
      const vs = new VideoSample(canvas, { timestamp: frame / FPS, duration: 1 / FPS })
      await videoSource.add(vs)
      vs.close()
      frame++
    }
    videoSource.close()
    progress('Finalizando arquivo', totalFrames)
    await output.finalize()
    if (writable) {
      post({ type: 'done', buffer: null })
    } else {
      const buf = (target as BufferTarget).buffer!
      post({ type: 'done', buffer: buf }, [buf])
    }
  } finally {
    for (const r of videoReaders.values()) r.input.dispose()
    for (const b of images.values()) b.close()
    for (const r of readers.values()) r.close()
    segmenter?.close()
    currentOutput = null
  }
}

/** Monta o áudio final: voz dos takes (com stretch) + áudio do clipe + música, normalizado para -14 LUFS. */
async function buildAudio(job: ExportJob): Promise<Stereo> {
  const { project, timeline, assets, gains } = job
  const totalFrames = Math.round(timeline.duration * SR)
  const voice = stereo(totalFrames)

  // cache de áudio decodificado por asset (takes inteiros são curtos)
  const cache = new Map<string, Stereo>()
  const getAudio = async (assetId: string, start: number, end: number): Promise<Stereo> => {
    const a = assets[assetId]
    const key = assetId
    let full = cache.get(key)
    if (!full) {
      full = await decodeRange(a.file, 0, a.duration ?? end)
      cache.set(key, full)
    }
    const s = Math.max(0, Math.round(start * SR))
    const e = Math.min(full.left.length, Math.round(end * SR))
    return { left: full.left.slice(s, e), right: full.right.slice(s, e) }
  }

  for (const seg of timeline.segments) {
    if (cancelled) return voice
    const asset = assets[seg.assetId]
    if (!asset) continue
    let piece = await getAudio(seg.assetId, seg.srcStart, seg.srcEnd)
    applyGain(piece, gains[seg.assetId] ?? 1)
    if (seg.kind === 'take') {
      fadeEdges(piece, 8)
      piece = timeStretch(piece, seg.rate)
    }
    const at = Math.round(seg.outStart * SR)
    const len = Math.round((seg.outEnd - seg.outStart) * SR)
    mixInto(voice, piece, at, 1, len)
  }
  cache.clear()

  // normaliza a voz para o alvo e depois o mix para -14 LUFS
  const voiceLufs = measureLoudnessPlanar([voice.left, voice.right], SR)
  const voiceGain = Number.isFinite(voiceLufs) ? Math.pow(10, Math.max(-12, Math.min(12, VOICE_TARGET_LUFS - voiceLufs)) / 20) : 1
  applyGain(voice, voiceGain)

  // música
  const m = project.music
  if (m.assetId && assets[m.assetId]) {
    const ma = assets[m.assetId]
    const mDur = ma.duration ?? 0
    if (mDur > 0.5) {
      // mede o loudness da música nos primeiros 60 s
      const probe = await decodeRange(ma.file, 0, Math.min(mDur, 60))
      const mLufs = measureLoudnessPlanar([probe.left, probe.right], SR)
      const targetDb = VOICE_TARGET_LUFS + m.gainDb
      const mGain = Number.isFinite(mLufs) ? Math.pow(10, (targetDb - mLufs) / 20) : Math.pow(10, m.gainDb / 20)
      const music = stereo(totalFrames)
      let outPos = 0
      let srcPos = ((m.start % mDur) + mDur) % mDur
      while (outPos < totalFrames) {
        if (cancelled) return voice
        const needSec = (totalFrames - outPos) / SR
        const takeSec = Math.min(needSec, mDur - srcPos)
        const part = srcPos === 0 && takeSec >= Math.min(mDur, 60) && probe.left.length >= Math.round(takeSec * SR)
          ? { left: probe.left.slice(0, Math.round(takeSec * SR)), right: probe.right.slice(0, Math.round(takeSec * SR)) }
          : await decodeRange(ma.file, srcPos, srcPos + takeSec)
        mixInto(music, part, outPos, 1)
        outPos += part.left.length || Math.round(takeSec * SR)
        srcPos = 0 // repete do início
        if (part.left.length === 0) break
      }
      // ganho, silêncio na react, fade de 1 s no fim
      const reactEnd = Math.round(timeline.reactDuration * SR)
      const fadeStart = totalFrames - SR
      for (let i = 0; i < totalFrames; i++) {
        let g = mGain
        if (m.muteDuringReact) {
          if (i < reactEnd) g = 0
          else if (i < reactEnd + SR * 0.5) g *= (i - reactEnd) / (SR * 0.5)
        }
        if (i > fadeStart) g *= Math.max(0, (totalFrames - i) / SR)
        music.left[i] *= g
        music.right[i] *= g
      }
      mixInto(voice, music, 0, 1)
    }
  }

  // alvo final -14 LUFS
  const lufs = measureLoudnessPlanar([voice.left, voice.right], SR)
  if (Number.isFinite(lufs)) applyGain(voice, Math.pow(10, Math.max(-6, Math.min(6, -14 - lufs)) / 20))
  limit(voice, 0.97)
  return voice
}
