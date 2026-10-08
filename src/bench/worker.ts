/// <reference lib="webworker" />
/**
 * Worker do benchmark: roda MediaPipe + RVM fora da thread principal.
 * Protocolo: { type:'init', opts } -> { type:'ready', info } | { type:'error', message }
 *            { type:'frame', bitmap, w, h, ts } -> { type:'result', ...BenchFrameResult }
 *            { type:'reset' } ; { type:'close' }
 */
import { BenchEngine, type BenchInitOptions } from './engine'

type InMsg =
  | { type: 'init'; opts: BenchInitOptions }
  | { type: 'frame'; bitmap: ImageBitmap; w: number; h: number; ts: number }
  | { type: 'reset' }
  | { type: 'close' }

const engine = new BenchEngine()

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data
  try {
    if (msg.type === 'init') {
      const info = await engine.init(msg.opts)
      self.postMessage({ type: 'ready', info })
    } else if (msg.type === 'frame') {
      const r = await engine.frame(msg.bitmap, msg.w, msg.h, msg.ts)
      msg.bitmap.close()
      const transfer: Transferable[] = []
      if (r.mp) transfer.push(r.mp)
      if (r.rvm) transfer.push(r.rvm)
      self.postMessage({ type: 'result', ...r }, transfer)
    } else if (msg.type === 'reset') {
      engine.reset()
    } else if (msg.type === 'close') {
      engine.close()
      self.close()
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.stack || e.message : String(e) })
  }
}
