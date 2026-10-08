import type { FaceSettings, Transform } from '../types'
import { CANVAS_H, CANVAS_W } from '../types'
import { CLIP_RECT, clipSourceRect, faceRect, imageRect, type Rect } from '../lib/layout'

export type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface VisualSource {
  source: CanvasImageSource
  w: number
  h: number
}

export interface FaceSource extends VisualSource {
  /** Máscara (alfa) cobrindo o quadro inteiro da fonte; null = sem recorte */
  mask: CanvasImageSource | null
}

export interface FrameSources {
  clip: VisualSource | null
  reaction: FaceSource | null
  face: FaceSource | null
  image: VisualSource | null
}

export interface TitleParams {
  text: string
  show: boolean
  x: number
  y: number
  width: number
}

export interface FrameParams {
  kind: 'react' | 'take' | 'empty'
  clipTransform: Transform
  face: FaceSettings
  faceOnly: boolean
  imageTransform: Transform
  title: TitleParams
  disclaimer: { text: string; enabled: boolean }
}

export interface Scratch {
  face: OffscreenCanvas
  faceCtx: OffscreenCanvasRenderingContext2D
}

export function createScratch(): Scratch {
  const face = new OffscreenCanvas(16, 16)
  const faceCtx = face.getContext('2d', { willReadFrequently: false })!
  return { face, faceCtx }
}

export interface FrameLayout {
  faceRect: Rect | null
  imageRect: Rect | null
  clipRect: Rect | null
  titleRect: Rect | null
}

/** Desenha um quadro completo (1080x1920) no contexto. O contexto já deve estar escalado se for meia resolução. */
export function drawFrame(ctx: AnyCtx, sources: FrameSources, p: FrameParams, scratch: Scratch): FrameLayout {
  const layout: FrameLayout = { faceRect: null, imageRect: null, clipRect: null, titleRect: null }
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (p.kind === 'react') {
    // clipe 16:9
    if (sources.clip) {
      const s = clipSourceRect(sources.clip.w, sources.clip.h, p.clipTransform)
      ctx.drawImage(sources.clip.source, s.x, s.y, s.w, s.h, CLIP_RECT.x, CLIP_RECT.y, CLIP_RECT.w, CLIP_RECT.h)
    } else {
      ctx.fillStyle = '#222'
      ctx.fillRect(CLIP_RECT.x, CLIP_RECT.y, CLIP_RECT.w, CLIP_RECT.h)
    }
    layout.clipRect = { ...CLIP_RECT }
    // rosto (reação)
    if (sources.reaction) {
      const r = faceRect(p.face, sources.reaction.w, sources.reaction.h, false)
      drawFace(ctx, sources.reaction, r, scratch)
      layout.faceRect = r
    }
  } else if (p.kind === 'take') {
    const faceSrc = sources.face
    const fr = faceSrc ? faceRect(p.face, faceSrc.w, faceSrc.h, p.faceOnly && !sources.image) : null
    if (sources.image) {
      const faceTop = fr ? fr.y : CANVAS_H
      const r = imageRect(sources.image.w, sources.image.h, faceTop, p.imageTransform)
      ctx.drawImage(sources.image.source, r.x, r.y, r.w, r.h)
      layout.imageRect = r
    }
    if (faceSrc && fr) {
      drawFace(ctx, faceSrc, fr, scratch)
      layout.faceRect = fr
    }
  }

  if (p.title.show && p.title.text.trim()) {
    layout.titleRect = drawTitle(ctx, p.title)
  }
  if (p.disclaimer.enabled && p.disclaimer.text.trim()) {
    drawDisclaimer(ctx, p.disclaimer.text)
  }
  ctx.restore()
  return layout
}

function drawFace(ctx: AnyCtx, src: FaceSource, r: Rect, scratch: Scratch) {
  if (!src.mask) {
    ctx.drawImage(src.source, r.x, r.y, r.w, r.h)
    return
  }
  const w = Math.max(2, Math.round(r.w))
  const h = Math.max(2, Math.round(r.h))
  if (scratch.face.width !== w || scratch.face.height !== h) {
    scratch.face.width = w
    scratch.face.height = h
  }
  const fc = scratch.faceCtx
  fc.save()
  fc.clearRect(0, 0, w, h)
  fc.imageSmoothingEnabled = true
  fc.imageSmoothingQuality = 'high'
  fc.drawImage(src.source, 0, 0, w, h)
  fc.globalCompositeOperation = 'destination-in'
  fc.filter = 'blur(2px)'
  fc.drawImage(src.mask, 0, 0, w, h)
  fc.filter = 'none'
  // degradê onde o corpo encosta na borda do vídeo original (ombro, braço): some a linha reta
  const fade = Math.round(w * 0.045)
  if (fade > 2) {
    const g = fc.createLinearGradient(0, 0, w, 0)
    const f = fade / w
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(f, 'rgba(0,0,0,1)')
    g.addColorStop(1 - f, 'rgba(0,0,0,1)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    fc.fillStyle = g
    fc.fillRect(0, 0, w, h)
    const gt = fc.createLinearGradient(0, 0, 0, h)
    gt.addColorStop(0, 'rgba(0,0,0,0)')
    gt.addColorStop(fade / h, 'rgba(0,0,0,1)')
    gt.addColorStop(1, 'rgba(0,0,0,1)')
    fc.fillStyle = gt
    fc.fillRect(0, 0, w, h)
  }
  fc.restore()
  ctx.drawImage(scratch.face, r.x, r.y, r.w, r.h)
}

const TITLE_FONT_MAX = 64
const TITLE_FONT_MIN = 34
const TITLE_PAD_X = 40
const TITLE_PAD_Y = 30
const TITLE_RADIUS = 28
const TITLE_FONT_FAMILY =
  '"Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'

export function layoutTitle(ctx: AnyCtx, text: string, maxWidth: number): { lines: string[]; font: number } {
  const inner = maxWidth - TITLE_PAD_X * 2
  const paragraphs = text.split(/\n/)
  for (let font = TITLE_FONT_MAX; font >= TITLE_FONT_MIN; font -= 2) {
    ctx.font = `bold ${font}px ${TITLE_FONT_FAMILY}`
    const lines: string[] = []
    let ok = true
    for (const para of paragraphs) {
      const words = para.split(/\s+/).filter(Boolean)
      let cur = ''
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w
        if (ctx.measureText(test).width <= inner) cur = test
        else {
          if (cur) lines.push(cur)
          cur = w
          if (ctx.measureText(w).width > inner) ok = false
        }
      }
      if (cur) lines.push(cur)
    }
    if (ok && lines.length <= 3) return { lines, font }
    if (font === TITLE_FONT_MIN) return { lines: lines.slice(0, 3), font }
  }
  return { lines: [text], font: TITLE_FONT_MIN }
}

export function drawTitle(ctx: AnyCtx, t: TitleParams): Rect {
  const { lines, font } = layoutTitle(ctx, t.text, t.width)
  const lineH = font * 1.22
  const boxH = lines.length * lineH + TITLE_PAD_Y * 2
  const boxW = t.width
  const x = t.x - boxW / 2
  const y = t.y - boxH / 2
  ctx.save()
  ctx.fillStyle = '#fff'
  roundRect(ctx, x, y, boxW, boxH, TITLE_RADIUS)
  ctx.fill()
  ctx.fillStyle = '#000'
  ctx.font = `bold ${font}px ${TITLE_FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((line, i) => {
    ctx.fillText(line, t.x, y + TITLE_PAD_Y + lineH * (i + 0.5))
  })
  ctx.restore()
  return { x, y, w: boxW, h: boxH }
}

function roundRect(ctx: AnyCtx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export function drawDisclaimer(ctx: AnyCtx, text: string) {
  const font = 24
  const maxW = CANVAS_W - 80
  ctx.save()
  ctx.font = `${font}px ${TITLE_FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w
    if (ctx.measureText(test).width <= maxW) cur = test
    else {
      if (cur) lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  const lineH = font * 1.3
  const bottom = CANVAS_H - 28
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 4
  lines.forEach((line, i) => {
    const y = bottom - (lines.length - 1 - i) * lineH
    ctx.fillText(line, CANVAS_W / 2, y)
  })
  ctx.restore()
}
