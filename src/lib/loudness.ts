import type { Interval } from '../types'

/**
 * Loudness integrado aproximado segundo ITU-R BS.1770 (K-weighting + gating),
 * funciona com Float32Array planar ou AudioBuffer.
 */

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Coeficientes de referência a 48 kHz (BS.1770-4), reescalados por frequência quando necessário.
  // Estágio 1: shelf de altas; estágio 2: high-pass.
  const f0 = 1681.974450955533
  const G = 3.999843853973347
  const Q = 0.7071752369554196
  const K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  const f1 = 38.13547087602444
  const Q1 = 0.5003270373238773
  const K1 = Math.tan((Math.PI * f1) / sampleRate)
  const a01 = 1 + K1 / Q1 + K1 * K1
  const hp: Biquad = {
    b0: 1 / a01,
    b1: -2 / a01,
    b2: 1 / a01,
    a1: (2 * (K1 * K1 - 1)) / a01,
    a2: (1 - K1 / Q1 + K1 * K1) / a01,
  }
  return [shelf, hp]
}

function applyBiquad(x: Float32Array, c: Biquad): Float32Array {
  const y = new Float32Array(x.length)
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

/**
 * Mede o loudness integrado (LUFS) de canais planar.
 * `regions` opcional: só considera esses trechos (em segundos) — útil para medir só a fala.
 */
export function measureLoudnessPlanar(channels: Float32Array[], sampleRate: number, regions?: Interval[]): number {
  if (channels.length === 0 || channels[0].length === 0) return -Infinity
  const [shelf, hp] = kWeighting(sampleRate)
  const filtered = channels.map((ch) => applyBiquad(applyBiquad(ch, shelf), hp))
  const block = Math.round(0.4 * sampleRate)
  const hop = Math.round(0.1 * sampleRate)
  const n = filtered[0].length
  const blockLoud: number[] = []
  const inRegion = (t: number) => !regions || regions.some((r) => t >= r.start && t <= r.end)
  for (let start = 0; start + block <= n; start += hop) {
    const mid = (start + block / 2) / sampleRate
    if (!inRegion(mid)) continue
    let sum = 0
    for (const ch of filtered) {
      let acc = 0
      for (let i = start; i < start + block; i++) acc += ch[i] * ch[i]
      sum += acc / block
    }
    blockLoud.push(-0.691 + 10 * Math.log10(sum + 1e-12))
  }
  if (blockLoud.length === 0) {
    // sinal curto: usa tudo
    let sum = 0
    for (const ch of filtered) {
      let acc = 0
      for (let i = 0; i < n; i++) acc += ch[i] * ch[i]
      sum += acc / n
    }
    return -0.691 + 10 * Math.log10(sum + 1e-12)
  }
  // gating absoluto -70 LUFS
  const abs = blockLoud.filter((l) => l > -70)
  if (abs.length === 0) return -Infinity
  const meanPow = (list: number[]) => list.reduce((a, l) => a + Math.pow(10, (l + 0.691) / 10), 0) / list.length
  const relGate = -0.691 + 10 * Math.log10(meanPow(abs)) - 10
  const gated = abs.filter((l) => l > relGate)
  if (gated.length === 0) return -Infinity
  return -0.691 + 10 * Math.log10(meanPow(gated))
}

export function measureLoudness(buffer: AudioBuffer, regions?: Interval[]): number {
  const chs: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c))
  return measureLoudnessPlanar(chs, buffer.sampleRate, regions)
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}
