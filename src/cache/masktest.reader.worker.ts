/// <reference lib="webworker" />
/** Mini worker de teste: abre o MaskReader dentro de um worker e devolve estatísticas de um quadro. */
import { MaskReader } from './maskCache'

self.onmessage = async (ev: MessageEvent<{ key: string; time: number; expectOpaque: number }>) => {
  const { key, time, expectOpaque } = ev.data
  try {
    const r = await MaskReader.open(key)
    if (!r) {
      ;(self as unknown as Worker).postMessage({ ok: false, error: 'reader null' })
      return
    }
    const bytes = await r.frameAt(time)
    if (!bytes) throw new Error('frameAt null')
    let opaque = 0
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 128) opaque++
    const frac = opaque / bytes.length
    const canvas = await r.canvasAt(time)
    ;(self as unknown as Worker).postMessage({
      ok: Math.abs(frac - expectOpaque) < 1e-6,
      frameCount: r.frameCount,
      width: r.width,
      height: r.height,
      opaque: +frac.toFixed(4),
      canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
      peek: r.peek(time) === bytes,
    })
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
