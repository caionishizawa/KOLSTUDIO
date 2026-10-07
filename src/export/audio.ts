/**
 * Utilidades de áudio offline usadas na exportação (rodam no worker).
 * Tudo em 48 kHz, estéreo planar (Float32Array[2]).
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import { SimpleFilter, SoundTouch } from 'soundtouchjs'

export const SR = 48000

export interface Stereo {
  left: Float32Array
  right: Float32Array
}

export function stereo(frames: number): Stereo {
  return { left: new Float32Array(Math.max(0, frames)), right: new Float32Array(Math.max(0, frames)) }
}

/** Decodifica o trecho [start, end) de um arquivo para estéreo 48 kHz. */
export async function decodeRange(file: Blob, start: number, end: number): Promise<Stereo> {
  const frames = Math.max(0, Math.round((end - start) * SR))
  const out = stereo(frames)
  if (frames === 0) return out
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return out
    const sink = new AudioSampleSink(track)
    for await (const sample of sink.samples(Math.max(0, start - 0.05), end + 0.05)) {
      const ch = sample.numberOfChannels
      const n = sample.numberOfFrames
      const rate = sample.sampleRate
      const planes: Float32Array[] = []
      for (let c = 0; c < Math.min(ch, 2); c++) {
        const buf = new Float32Array(n)
        sample.copyTo(buf, { planeIndex: c, format: 'f32-planar' })
        planes.push(buf)
      }
      if (planes.length === 1) planes.push(planes[0])
      // posição deste sample na saída (em frames de 48 kHz)
      const offsetSec = sample.timestamp - start
      const ratio = SR / rate
      const outStart = Math.round(offsetSec * SR)
      const outLen = Math.round(n * ratio)
      for (let i = 0; i < outLen; i++) {
        const o = outStart + i
        if (o < 0 || o >= frames) continue
        const srcPos = i / ratio
        const i0 = Math.floor(srcPos)
        const i1 = Math.min(n - 1, i0 + 1)
        const f = srcPos - i0
        out.left[o] = planes[0][i0] * (1 - f) + planes[0][i1] * f
        out.right[o] = planes[1][i0] * (1 - f) + planes[1][i1] * f
      }
      sample.close()
    }
  } finally {
    input.dispose()
  }
  return out
}

export function applyGain(s: Stereo, gain: number) {
  for (let i = 0; i < s.left.length; i++) {
    s.left[i] *= gain
    s.right[i] *= gain
  }
}

/** Fade linear de `ms` ms no início e no fim (evita estalos nos cortes). */
export function fadeEdges(s: Stereo, ms = 8) {
  const n = Math.min(s.left.length >> 1, Math.round((ms / 1000) * SR))
  for (let i = 0; i < n; i++) {
    const g = i / n
    s.left[i] *= g
    s.right[i] *= g
    const j = s.left.length - 1 - i
    s.left[j] *= g
    s.right[j] *= g
  }
}

/** Muda a velocidade preservando o tom (SoundTouch). rate > 1 = mais rápido. */
export function timeStretch(s: Stereo, rate: number): Stereo {
  if (Math.abs(rate - 1) < 1e-3 || s.left.length === 0) return s
  const st = new SoundTouch()
  st.tempo = rate
  st.pitch = 1
  const total = s.left.length
  const source = {
    extract(target: Float32Array, numFrames: number, position: number): number {
      const avail = Math.max(0, Math.min(numFrames, total - position))
      for (let i = 0; i < avail; i++) {
        target[i * 2] = s.left[position + i]
        target[i * 2 + 1] = s.right[position + i]
      }
      return avail
    },
  }
  const filter = new SimpleFilter(source, st)
  const expected = Math.round(total / rate)
  const out = stereo(expected)
  const chunk = new Float32Array(4096 * 2)
  let pos = 0
  for (;;) {
    const got = filter.extract(chunk, 4096)
    if (got <= 0) break
    for (let i = 0; i < got && pos < expected; i++, pos++) {
      out.left[pos] = chunk[i * 2]
      out.right[pos] = chunk[i * 2 + 1]
    }
    if (pos >= expected) break
  }
  return out
}

/** Soma `src` em `dst` a partir do frame `at`, com ganho */
export function mixInto(dst: Stereo, src: Stereo, at: number, gain = 1, maxFrames = Infinity) {
  const n = Math.min(src.left.length, maxFrames, dst.left.length - at)
  for (let i = 0; i < n; i++) {
    dst.left[at + i] += src.left[i] * gain
    dst.right[at + i] += src.right[i] * gain
  }
}

/** Limitador de pico simples: nunca passa de `ceiling` (linear). */
export function limit(s: Stereo, ceiling = 0.97) {
  const block = 256
  const n = s.left.length
  let env = 1
  const release = Math.exp(-block / (0.08 * SR))
  let prevGain = 1
  for (let b = 0; b < n; b += block) {
    const end = Math.min(n, b + block)
    let peak = 0
    for (let i = b; i < end; i++) {
      const a = Math.abs(s.left[i])
      const c = Math.abs(s.right[i])
      if (a > peak) peak = a
      if (c > peak) peak = c
    }
    const target = peak > ceiling ? ceiling / peak : 1
    env = target < env ? target : env + (1 - release) * (target - env)
    // interpola o ganho dentro do bloco para não estalar
    for (let i = b; i < end; i++) {
      const f = (i - b) / (end - b)
      const g = prevGain + (env - prevGain) * f
      s.left[i] *= g
      s.right[i] *= g
    }
    prevGain = env
  }
}
