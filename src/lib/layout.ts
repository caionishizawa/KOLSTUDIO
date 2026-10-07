import type { FaceSettings, Transform } from '../types'
import { CANVAS_H, CANVAS_W } from '../types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const CLIP_RECT: Rect = { x: 0, y: 400, w: CANVAS_W, h: Math.round((CANVAS_W * 9) / 16) } // 1080x608
export const FACE_WIDTH_RATIO = 0.58

/** Retângulo do rosto recortado (vídeo vertical do celular) */
export function faceRect(face: FaceSettings, srcW: number, srcH: number, faceOnly = false): Rect {
  const aspect = srcW > 0 && srcH > 0 ? srcH / srcW : 16 / 9
  const w = CANVAS_W * (faceOnly ? 0.9 : FACE_WIDTH_RATIO) * face.scale
  const h = w * aspect
  let x: number
  if (faceOnly) x = (CANVAS_W - w) / 2
  else if (face.align === 'left') x = 0
  else if (face.align === 'right') x = CANVAS_W - w
  else x = (CANVAS_W - w) / 2
  const y = CANVAS_H - h
  return { x: x + face.x, y: y + face.y, w, h }
}

/**
 * Retângulo de uma imagem do take: largura toda; centralizada acima do rosto se couber,
 * senão encostada no topo (a parte de baixo passa por trás do rosto). Zoom/posição por imagem.
 */
export function imageRect(imgW: number, imgH: number, faceTop: number, t: Transform): Rect {
  const baseW = CANVAS_W
  const baseH = imgW > 0 ? (imgH / imgW) * baseW : CANVAS_H
  let y: number
  if (baseH <= faceTop) y = (faceTop - baseH) / 2
  else y = 0
  const w = baseW * t.zoom
  const h = baseH * t.zoom
  // zoom em volta do centro horizontal e do topo visível
  const x = (CANVAS_W - w) / 2 + t.x
  const yy = y - (h - baseH) / 2 + t.y
  return { x, y: yy, w, h }
}

/**
 * Retângulo de desenho do clipe da react em 16:9 (1080x608), com recorte "cover":
 * o vídeo preenche a área, e zoom/posição deslocam o conteúdo dentro dela.
 * Retorna o retângulo da fonte (em pixels da fonte) a desenhar dentro de CLIP_RECT.
 */
export function clipSourceRect(srcW: number, srcH: number, t: Transform): Rect {
  const target = CLIP_RECT.w / CLIP_RECT.h
  const srcAspect = srcW / srcH
  let w: number, h: number
  if (srcAspect > target) {
    h = srcH
    w = h * target
  } else {
    w = srcW
    h = w / target
  }
  w /= t.zoom
  h /= t.zoom
  const scale = srcW / CLIP_RECT.w // px fonte por px canvas (aprox., eixo x)
  let x = (srcW - w) / 2 - t.x * scale
  let y = (srcH - h) / 2 - t.y * scale
  x = Math.max(0, Math.min(srcW - w, x))
  y = Math.max(0, Math.min(srcH - h, y))
  return { x, y, w, h }
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}
