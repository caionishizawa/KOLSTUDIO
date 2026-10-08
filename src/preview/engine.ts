import type { Asset, Project, TakeAnalysis, Timeline } from '../types'
import { CANVAS_H, CANVAS_W, defaultTransform } from '../types'
import { locate, segmentIndexAt } from '../lib/timeline'
import { dbToGain, measureLoudness } from '../lib/loudness'
import { VOICE_TARGET_LUFS } from '../lib/silence'
import { createScratch, drawFrame, type FrameLayout, type FrameParams, type FrameSources, type Scratch } from '../render/compositor'
import { Segmenter } from '../render/segmenter'
import { MaskReader } from '../cache/maskCache'
import type { MaskInfo } from '../state/store'

export interface EngineData {
  project: Project
  assets: Record<string, Asset>
  analyses: Record<string, TakeAnalysis>
  timeline: Timeline
  masks: Record<string, MaskInfo>
}

const MASTER_DB = 2 // voz em -16 LUFS + 2 dB ≈ -14 LUFS no mix
const EPS = 0.02

export class PreviewEngine {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private scratch: Scratch = createScratch()
  private data: EngineData | null = null
  private videos = new Map<string, HTMLVideoElement>()
  private images = new Map<string, ImageBitmap>()
  private imageLoading = new Set<string>()
  private audioCtx: AudioContext | null = null
  private master: GainNode | null = null
  private voiceGains = new Map<string, GainNode>()
  private musicGain: GainNode | null = null
  private musicSource: AudioBufferSourceNode | null = null
  private musicBuffer: AudioBuffer | null = null
  private musicBufferFor: string | null = null
  private musicLoudness = -16
  private segmenter: Segmenter | null = null
  private segmenterFailed = false
  private readers = new Map<string, MaskReader>()
  private readersLoading = new Set<string>()
  private time = 0
  private playing = false
  private segIndex = -1
  private dirty = true
  private raf = 0
  private half = false
  lastLayout: FrameLayout | null = null
  onTime: ((t: number) => void) | null = null
  onEnded: (() => void) | null = null
  onSegmenter: ((info: string) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.setHalf(false)
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
    this.initSegmenter()
    if (import.meta.env.DEV) (globalThis as unknown as { __engine: unknown }).__engine = this
  }

  private async initSegmenter() {
    try {
      const model = new URLSearchParams(location.search).get('model') === 'small' ? 'small' : 'multiclass'
      this.segmenter = await Segmenter.create('GPU', model)
      if (import.meta.env.DEV) (globalThis as unknown as { __seg: unknown }).__seg = this.segmenter
      this.onSegmenter?.(`MediaPipe ${this.segmenter.info.model === 'multiclass' ? 'multiclasse' : 'simples'} (${this.segmenter.info.delegate})`)
      this.dirty = true
    } catch (e) {
      this.segmenterFailed = true
      this.onSegmenter?.('Recorte indisponível: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  setHalf(half: boolean) {
    this.half = half
    const s = half ? 0.5 : 1
    this.canvas.width = CANVAS_W * s
    this.canvas.height = CANVAS_H * s
    this.dirty = true
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.pause()
    for (const v of this.videos.values()) {
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
    this.videos.clear()
    for (const b of this.images.values()) b.close()
    this.images.clear()
    this.segmenter?.close()
    for (const r of this.readers.values()) r.close()
    this.readers.clear()
    this.audioCtx?.close()
  }

  setData(data: EngineData) {
    const prev = this.data
    this.data = data
    if (data.project.previewHalf !== this.half) this.setHalf(data.project.previewHalf)
    // ganhos de voz
    for (const [assetId, g] of this.voiceGains) {
      const a = data.analyses[assetId]
      g.gain.value = a?.gain ?? 1
    }
    // música
    const musicId = data.project.music.assetId
    if (musicId !== this.musicBufferFor) this.loadMusic(musicId)
    if (prev && prev.timeline !== data.timeline) {
      // a linha do tempo mudou: segmento atual pode ter mudado
      if (this.time > data.timeline.duration) this.time = Math.max(0, data.timeline.duration - EPS)
      if (this.playing) this.startSegmentAt(this.time)
    }
    this.dirty = true
  }

  get currentTime() {
    return this.time
  }

  get isPlaying() {
    return this.playing
  }

  // ---------- transporte ----------

  async play() {
    if (!this.data || this.data.timeline.duration <= 0) return
    this.ensureAudio()
    await this.audioCtx!.resume()
    if (this.time >= this.data.timeline.duration - EPS) this.time = 0
    this.playing = true
    await this.startSegmentAt(this.time)
    this.startMusic()
  }

  pause() {
    this.playing = false
    for (const v of this.videos.values()) if (!v.paused) v.pause()
    this.stopMusic()
    this.dirty = true
  }

  async seek(t: number) {
    if (!this.data) return
    this.segmenter?.reset()
    this.time = Math.max(0, Math.min(this.data.timeline.duration, t))
    this.onTime?.(this.time)
    if (this.playing) {
      this.stopMusic()
      await this.startSegmentAt(this.time)
      this.startMusic()
    } else {
      await this.seekSources(this.time)
      this.dirty = true
    }
  }

  // ---------- fontes ----------

  private ensureVideo(asset: Asset, muted: boolean): HTMLVideoElement {
    let v = this.videos.get(asset.url)
    if (!v) {
      v = document.createElement('video')
      v.src = asset.url
      v.preload = 'auto'
      v.playsInline = true
      v.muted = muted
      v.crossOrigin = 'anonymous'
      ;(v as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true
      v.addEventListener('seeked', () => (this.dirty = true))
      v.addEventListener('loadeddata', () => (this.dirty = true))
      this.videos.set(asset.url, v)
      if (!muted && this.audioCtx) this.connectVoice(asset.id, v)
    }
    return v
  }

  private connectVoice(assetId: string, v: HTMLVideoElement) {
    if (!this.audioCtx || !this.master) return
    if (this.voiceGains.has(assetId)) return
    const src = this.audioCtx.createMediaElementSource(v)
    const g = this.audioCtx.createGain()
    g.gain.value = this.data?.analyses[assetId]?.gain ?? 1
    src.connect(g).connect(this.master)
    this.voiceGains.set(assetId, g)
  }

  private ensureAudio() {
    if (this.audioCtx) return
    this.audioCtx = new AudioContext({ sampleRate: 48000 })
    const comp = this.audioCtx.createDynamicsCompressor()
    comp.threshold.value = -3
    comp.knee.value = 2
    comp.ratio.value = 20
    comp.attack.value = 0.002
    comp.release.value = 0.1
    this.master = this.audioCtx.createGain()
    this.master.gain.value = dbToGain(MASTER_DB)
    this.master.connect(comp).connect(this.audioCtx.destination)
    this.musicGain = this.audioCtx.createGain()
    this.musicGain.connect(this.master)
    // conecta vídeos já criados que têm áudio
    if (this.data) {
      for (const a of Object.values(this.data.assets)) {
        const v = this.videos.get(a.url)
        if (v && !v.muted) this.connectVoice(a.id, v)
      }
    }
  }

  private getImage(asset: Asset): ImageBitmap | null {
    const bmp = this.images.get(asset.url)
    if (bmp) return bmp
    if (!this.imageLoading.has(asset.url)) {
      this.imageLoading.add(asset.url)
      createImageBitmap(asset.file)
        .then((b) => {
          this.images.set(asset.url, b)
          this.dirty = true
        })
        .catch(() => {})
        .finally(() => this.imageLoading.delete(asset.url))
    }
    return null
  }

  private async loadMusic(assetId: string | null) {
    this.musicBufferFor = assetId
    this.musicBuffer = null
    this.stopMusic()
    if (!assetId || !this.data) return
    const asset = this.data.assets[assetId]
    if (!asset) return
    try {
      const buf = await asset.file.arrayBuffer()
      const ctx = new OfflineAudioContext(2, 2, 48000)
      const decoded = await ctx.decodeAudioData(buf)
      if (this.musicBufferFor !== assetId) return
      this.musicBuffer = decoded
      this.musicLoudness = measureLoudness(decoded)
      if (this.playing) this.startMusic()
    } catch (e) {
      console.warn('música não decodificada', e)
    }
  }

  // ---------- segmentos ----------

  private async startSegmentAt(t: number) {
    const d = this.data
    if (!d) return
    const tl = d.timeline
    const idx = segmentIndexAt(tl, t)
    if (idx !== this.segIndex) this.segmenter?.reset()
    this.segIndex = idx
    const seg = tl.segments[idx]
    if (!seg) return
    // pausa tudo
    for (const v of this.videos.values()) if (!v.paused) v.pause()
    const srcT = seg.srcStart + (t - seg.outStart) * seg.rate
    const asset = d.assets[seg.assetId]
    if (!asset) return
    const v = this.ensureVideo(asset, false)
    if (seg.kind === 'take') {
      const a = d.analyses[asset.id]
      const g = this.voiceGains.get(asset.id)
      if (g) g.gain.value = a?.gain ?? 1
    }
    v.playbackRate = seg.rate
    await seekVideo(v, Math.min(srcT, seg.srcEnd - 0.001))
    if (!this.playing) return
    v.play().catch(() => {})
    if (seg.kind === 'react' && d.project.reactionId) {
      const ra = d.assets[d.project.reactionId]
      if (ra) {
        const rv = this.ensureVideo(ra, true)
        rv.playbackRate = 1
        const rt = t - seg.outStart
        if (rt < (ra.duration ?? Infinity)) {
          await seekVideo(rv, rt)
          if (this.playing) rv.play().catch(() => {})
        } else {
          await seekVideo(rv, Math.max(0, (ra.duration ?? 0) - 0.01))
        }
      }
    }
    this.dirty = true
  }

  private async seekSources(t: number) {
    const d = this.data
    if (!d) return
    const loc = locate(d.timeline, t)
    const seg = loc.segment
    if (!seg) return
    const asset = d.assets[seg.assetId]
    if (!asset) return
    const v = this.ensureVideo(asset, false)
    await seekVideo(v, loc.srcTime)
    if (seg.kind === 'react' && d.project.reactionId) {
      const ra = d.assets[d.project.reactionId]
      if (ra) {
        const rv = this.ensureVideo(ra, true)
        await seekVideo(rv, Math.min(t - seg.outStart, Math.max(0, (ra.duration ?? 0) - 0.01)))
      }
    }
  }

  // ---------- música ----------

  private startMusic() {
    const d = this.data
    if (!d || !this.audioCtx || !this.musicGain || !this.musicBuffer || !this.playing) return
    this.stopMusic()
    const m = d.project.music
    const src = this.audioCtx.createBufferSource()
    src.buffer = this.musicBuffer
    src.loop = true
    const dur = this.musicBuffer.duration
    const offset = ((m.start + this.time) % dur + dur) % dur
    src.connect(this.musicGain)
    src.start(0, offset)
    this.musicSource = src
    this.updateMusicGain()
  }

  private stopMusic() {
    if (this.musicSource) {
      try {
        this.musicSource.stop()
      } catch {
        /* já parado */
      }
      this.musicSource.disconnect()
      this.musicSource = null
    }
  }

  private updateMusicGain() {
    const d = this.data
    if (!d || !this.musicGain || !this.audioCtx) return
    const m = d.project.music
    let db = VOICE_TARGET_LUFS + m.gainDb - (Number.isFinite(this.musicLoudness) ? this.musicLoudness : -16)
    let g = dbToGain(db)
    const remaining = d.timeline.duration - this.time
    if (remaining < 1) g *= Math.max(0, remaining)
    if (m.muteDuringReact && this.time < d.timeline.reactDuration) g = 0
    this.musicGain.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.05)
  }

  // ---------- loop ----------

  private loop() {
    this.raf = requestAnimationFrame(this.loop)
    const d = this.data
    if (!d) return
    if (this.playing) {
      const seg = d.timeline.segments[this.segIndex]
      if (!seg) {
        this.pause()
        return
      }
      const asset = d.assets[seg.assetId]
      const v = asset ? this.videos.get(asset.url) : undefined
      if (v) {
        const srcT = v.currentTime
        this.time = seg.outStart + (srcT - seg.srcStart) / seg.rate
        const atEnd = srcT >= seg.srcEnd - EPS || v.ended
        if (atEnd) {
          if (this.segIndex + 1 < d.timeline.segments.length) {
            this.time = d.timeline.segments[this.segIndex + 1].outStart
            this.segIndex++
            this.startSegmentAt(this.time)
          } else {
            this.time = d.timeline.duration
            this.pause()
            this.onEnded?.()
          }
        }
      }
      this.onTime?.(this.time)
      this.updateMusicGain()
      this.render()
    } else if (this.dirty) {
      this.render()
    }
  }

  private render() {
    const d = this.data
    if (!d) return
    this.dirty = false
    const loc = locate(d.timeline, this.time)
    const seg = loc.segment
    const project = d.project
    const sources: FrameSources = { clip: null, reaction: null, face: null, image: null }
    const params: FrameParams = {
      kind: 'empty',
      clipTransform: project.clip.transform,
      face: project.faceDefault,
      faceOnly: d.timeline.faceOnly,
      imageTransform: defaultTransform(),
      title: {
        text: project.title.text,
        show: project.title.enabled && (project.title.wholeVideo || seg?.kind === 'react' || !seg),
        x: project.title.x,
        y: project.title.y,
        width: project.title.width,
      },
      disclaimer: project.disclaimer,
    }
    const now = performance.now()
    if (seg?.kind === 'react') {
      params.kind = 'react'
      const clipAsset = d.assets[seg.assetId]
      if (clipAsset) {
        const v = this.ensureVideo(clipAsset, false)
        if (v.readyState >= 2) sources.clip = { source: v, w: v.videoWidth, h: v.videoHeight }
      }
      if (project.reactionId && d.assets[project.reactionId]) {
        const ra = d.assets[project.reactionId]
        const rv = this.ensureVideo(ra, true)
        if (rv.readyState >= 2)
          sources.reaction = {
            source: rv,
            w: rv.videoWidth,
            h: rv.videoHeight,
            mask: this.maskFor(rv, now, ra.id, this.time - seg.outStart),
          }
      }
    } else if (seg?.kind === 'take') {
      params.kind = 'take'
      const take = project.takes.find((t) => t.id === seg.takeId)
      if (take) params.face = take.face
      const asset = d.assets[seg.assetId]
      if (asset) {
        const v = this.ensureVideo(asset, false)
        if (v.readyState >= 2)
          sources.face = {
            source: v,
            w: v.videoWidth,
            h: v.videoHeight,
            mask: take?.cutout === false ? null : this.maskFor(v, now, asset.id, loc.srcTime),
          }
      }
      if (loc.image) {
        const img = d.assets[loc.image.assetId]
        if (img && img.type === 'image') {
          const bmp = this.getImage(img)
          if (bmp) sources.image = { source: bmp, w: bmp.width, h: bmp.height }
          params.imageTransform = take?.imageTransforms[img.id] ?? defaultTransform()
        }
      }
    }
    const ctx = this.ctx
    ctx.save()
    if (this.half) ctx.scale(0.5, 0.5)
    this.lastLayout = drawFrame(ctx, sources, params, this.scratch)
    ctx.restore()
  }

  /** Máscara do cache (pré-calculada) quando existe; senão, segmentação ao vivo. */
  private maskFor(v: HTMLVideoElement, now: number, assetId: string, srcTime: number): OffscreenCanvas | null {
    const info = this.data?.masks[assetId]
    if (info && info.status === 'done') {
      const reader = this.readers.get(info.key)
      if (reader) {
        const c = reader.peekCanvas(srcTime)
        reader.prefetch(srcTime + 1 / 30)
        if (c) return c
        // quadro ainda não lido: tenta de novo no próximo frame
        this.dirty = true
      } else if (!this.readersLoading.has(info.key)) {
        this.readersLoading.add(info.key)
        MaskReader.open(info.key)
          .then((r) => {
            if (r) this.readers.set(info.key, r)
            this.dirty = true
          })
          .catch(() => {})
          .finally(() => this.readersLoading.delete(info.key))
      }
    }
    if (!this.segmenter || this.segmenterFailed) return null
    try {
      return this.segmenter.segment(v, v.videoWidth, v.videoHeight, now)
    } catch (e) {
      console.warn('segmentação falhou', e)
      this.segmenterFailed = true
      this.onSegmenter?.('Recorte desligado após erro')
      return null
    }
  }
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, t)
    if (v.readyState >= 1 && Math.abs(v.currentTime - target) < 0.005) return resolve()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      v.removeEventListener('seeked', finish)
      v.removeEventListener('error', finish)
      resolve()
    }
    v.addEventListener('seeked', finish)
    v.addEventListener('error', finish)
    const doSeek = () => {
      v.currentTime = target
    }
    if (v.readyState >= 1) doSeek()
    else v.addEventListener('loadedmetadata', doSeek, { once: true })
    setTimeout(finish, 1500)
  })
}
