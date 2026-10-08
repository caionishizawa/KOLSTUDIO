/// <reference lib="webworker" />
/**
 * Worker de pré-cálculo: decodifica o vídeo quadro a quadro (Mediabunny), roda o segmentador e
 * grava a máscara de cada quadro no OPFS via MaskWriter. Nunca acumula quadros na memória.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSample, VideoSampleSink } from 'mediabunny'
import { MaskWriter, createMaskScratch, maskCanvasToBytes, maskHeightFor } from './maskCache'
import { createSegmenter, type MaskSegmenter } from './segmenterFactory'
import type { PrecomputeIn, PrecomputeOut, PrecomputeStart } from './protocol'

const post = (m: PrecomputeOut) => (self as unknown as Worker).postMessage(m)
const PROGRESS_EVERY = 15
const DEFAULT_INPUT_WIDTH = 720

let currentJob = -1
let cancelled = false
/** Segmentador reaproveitado entre jobs do mesmo modelo (carregar o MediaPipe custa ~1 s). */
let segmenter: MaskSegmenter | null = null
let segmenterModel: string | null = null

self.onmessage = async (ev: MessageEvent<PrecomputeIn>) => {
  const msg = ev.data
  if (msg.type === 'cancel') {
    if (msg.jobId === currentJob) cancelled = true
    return
  }
  if (msg.type === 'start') {
    currentJob = msg.jobId
    cancelled = false
    try {
      await run(msg)
    } catch (e) {
      if (cancelled) post({ type: 'cancelled', jobId: msg.jobId })
      else post({ type: 'error', jobId: msg.jobId, message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (currentJob === msg.jobId) currentJob = -1
    }
  }
}

async function getSegmenter(model: PrecomputeStart['model'], delegate: 'GPU' | 'CPU'): Promise<MaskSegmenter> {
  const id = `${model}/${delegate}`
  if (segmenter && segmenterModel === id) return segmenter
  segmenter?.close()
  segmenter = null
  segmenter = await createSegmenter(model, { delegate })
  segmenterModel = id
  return segmenter
}

async function run(msg: PrecomputeStart) {
  const t0 = performance.now()
  const fps = msg.fps > 0 ? msg.fps : 30
  const maskWidth = msg.maskWidth > 0 ? msg.maskWidth : 192

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(msg.file) })
  let writer: MaskWriter | null = null
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('Arquivo sem trilha de vídeo')
    if (!(await track.canDecode())) throw new Error('Vídeo não decodificável: ' + (await track.getCodec()))
    const dispW = await track.getDisplayWidth()
    const dispH = await track.getDisplayHeight()
    const duration = await track.computeDuration()
    const total = Math.max(1, Math.round(duration * fps))

    // quadro de entrada do segmentador: resolução de exibição reduzida (o modelo reduz mais ainda)
    const inputWidth = msg.inputWidth === 0 ? dispW : Math.min(dispW, msg.inputWidth ?? DEFAULT_INPUT_WIDTH)
    const inW = Math.max(16, Math.round(inputWidth))
    const inH = Math.max(16, Math.round((inW * dispH) / dispW))
    const canvas = new OffscreenCanvas(inW, inH)
    const ctx = canvas.getContext('2d')!

    const maskH = maskHeightFor(dispW, dispH, maskWidth)
    const scratch = createMaskScratch(maskWidth, maskH)
    const seg = await getSegmenter(msg.model, msg.delegate ?? 'GPU')
    seg.reset()
    if (cancelled) throw new Error('cancelado')

    writer = await MaskWriter.open(msg.key, { width: maskWidth, height: maskH, fps })
    const sink = new VideoSampleSink(track, { hardwareAcceleration: 'no-preference' })
    const times = (function* () {
      for (let f = 0; f < total; f++) yield f / fps
    })()
    const iter = sink.samplesAtTimestamps(times)

    let frame = 0
    let last: Uint8Array | null = null
    let haveFrame = false
    const timing = { decodeMs: 0, segmentMs: 0, writeMs: 0 }
    for (let f = 0; f < total; f++) {
      if (cancelled) throw new Error('cancelado')
      let t = performance.now()
      const sample = (await iter.next()).value as VideoSample | null | undefined
      if (sample) {
        sample.draw(ctx, 0, 0, inW, inH)
        sample.close()
        haveFrame = true
      }
      timing.decodeMs += performance.now() - t
      let bytes: Uint8Array | null = null
      if (haveFrame) {
        t = performance.now()
        const mask = await seg.segment(canvas, inW, inH, (f * 1000) / fps)
        if (mask) bytes = maskCanvasToBytes(mask, maskWidth, maskH, scratch)
        timing.segmentMs += performance.now() - t
      }
      t = performance.now()
      if (!bytes) {
        // sem máscara neste quadro: repete o anterior (ou transparente no começo)
        if (!last) last = new Uint8Array(maskWidth * maskH)
        bytes = last
      } else {
        last = bytes
      }
      await writer.append(bytes)
      timing.writeMs += performance.now() - t
      frame++
      if (frame % PROGRESS_EVERY === 0) post({ type: 'progress', jobId: msg.jobId, frame, total })
    }
    const header = await writer.finish()
    writer = null
    post({
      type: 'done',
      jobId: msg.jobId,
      key: msg.key,
      frameCount: header.frameCount,
      width: header.width,
      height: header.height,
      elapsedMs: performance.now() - t0,
      timing,
    })
  } finally {
    if (writer) await writer.abort()
    input.dispose()
  }
}
