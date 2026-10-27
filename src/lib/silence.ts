import type { Interval, SilenceIntensity, TakeAnalysis } from '../types'
import { SILENCE_PRESETS } from '../types'
import { measureLoudness } from './loudness'

const WINDOW_SEC = 0.01
/** Ruídos de fala mais curtos que isso (estalo, batida) são ignorados */
const MIN_SPEECH_SEC = 0.12
/** Alvo de loudness da voz (LUFS). O mix final é ajustado depois para -14. */
export const VOICE_TARGET_LUFS = -16

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return -100
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[i]
}

/** Converte um AudioBuffer em mono Float32Array */
export function toMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length
  const out = new Float32Array(n)
  const ch = buffer.numberOfChannels
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += d[i] / ch
  }
  return out
}

/** RMS em dBFS por janela de 10 ms */
export function computeRms(mono: Float32Array, sampleRate: number, windowSec = WINDOW_SEC): Float32Array {
  const win = Math.max(1, Math.round(windowSec * sampleRate))
  const count = Math.ceil(mono.length / win)
  const out = new Float32Array(count)
  for (let w = 0; w < count; w++) {
    const start = w * win
    const end = Math.min(mono.length, start + win)
    let acc = 0
    for (let i = start; i < end; i++) acc += mono[i] * mono[i]
    const rms = Math.sqrt(acc / Math.max(1, end - start))
    out[w] = 20 * Math.log10(rms + 1e-9)
  }
  return out
}

/**
 * Limiar adaptativo a partir do ruído de fundo: piso = percentil 20 das janelas,
 * teto = percentil 95. O limiar fica entre eles, nunca menos de 8 dB acima do piso.
 */
export function adaptiveThreshold(rms: Float32Array): { noiseFloorDb: number; thresholdDb: number } {
  const sorted = Float32Array.from(rms).sort()
  const floor = percentile(sorted, 0.2)
  const peak = percentile(sorted, 0.95)
  const range = Math.max(0, peak - floor)
  const thresholdDb = Math.max(floor + 8, Math.min(floor + range * 0.4, peak - 6, -18))
  return { noiseFloorDb: floor, thresholdDb }
}

/** Janelas acima do limiar -> intervalos brutos de fala (sem margem), ignorando ruídos curtos */
export function detectSpeech(rms: Float32Array, windowSec: number, thresholdDb: number, mergeGap: number): Interval[] {
  const raw: Interval[] = []
  let cur: Interval | null = null
  for (let i = 0; i < rms.length; i++) {
    const loud = rms[i] > thresholdDb
    const t = i * windowSec
    if (loud) {
      if (!cur) cur = { start: t, end: t + windowSec }
      else cur.end = t + windowSec
    } else if (cur) {
      raw.push(cur)
      cur = null
    }
  }
  if (cur) raw.push(cur)

  // junta pedaços próximos (gaps curtos dentro de uma frase são fala)
  const merged = mergeIntervals(raw, mergeGap)
  // ignora ruídos curtos que não são fala
  return merged.filter((iv) => iv.end - iv.start >= MIN_SPEECH_SEC)
}

export function mergeIntervals(list: Interval[], gap: number): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv.start - last.end <= gap) last.end = Math.max(last.end, iv.end)
    else out.push({ ...iv })
  }
  return out
}

export function analyzeTake(buffer: AudioBuffer): TakeAnalysis {
  const mono = toMono(buffer)
  const rms = computeRms(mono, buffer.sampleRate)
  const { noiseFloorDb, thresholdDb } = adaptiveThreshold(rms)
  // detecção base com gap pequeno; a intensidade do corte entra depois
  const speech = detectSpeech(rms, WINDOW_SEC, thresholdDb, 0.12)
  const loudness = measureLoudness(buffer, speech)
  const gain = Number.isFinite(loudness) ? Math.min(8, Math.pow(10, (VOICE_TARGET_LUFS - loudness) / 20)) : 1
  return { speech, rms, windowSec: WINDOW_SEC, noiseFloorDb, thresholdDb, gain, loudness, duration: buffer.duration }
}

/**
 * Trechos mantidos de um take, no tempo do arquivo original.
 * - aplica trims
 * - remove silêncio maior que minSilence, deixando margem antes e depois da fala
 * - aparar silêncio do início e do fim
 * - cortes e restaurações manuais
 */
export function keptIntervals(
  analysis: TakeAnalysis | undefined,
  duration: number,
  intensity: SilenceIntensity,
  trimStart: number,
  trimEnd: number,
  manualCuts: Interval[],
  manualKeeps: Interval[],
): Interval[] {
  const lo = Math.max(0, trimStart)
  const hi = Math.max(lo, duration - Math.max(0, trimEnd))
  let kept: Interval[]
  if (intensity === 'off' || !analysis || analysis.speech.length === 0) {
    kept = [{ start: lo, end: hi }]
  } else {
    const { minSilence, margin } = SILENCE_PRESETS[intensity]
    // fala com margem
    const padded = analysis.speech.map((s) => ({ start: s.start - margin, end: s.end + margin }))
    // silêncio menor que minSilence (medido entre falas já com margem) é mantido
    kept = mergeIntervals(padded, minSilence)
  }
  // restaurações manuais
  if (manualKeeps.length) kept = mergeIntervals([...kept, ...manualKeeps], 0)
  // cortes manuais
  for (const cut of manualCuts) kept = subtract(kept, cut)
  // trims
  kept = kept
    .map((iv) => ({ start: Math.max(lo, iv.start), end: Math.min(hi, iv.end) }))
    .filter((iv) => iv.end - iv.start > 0.02)
  if (kept.length === 0) kept = [{ start: lo, end: Math.min(hi, lo + 0.1) }]
  return kept
}

export function subtract(list: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = []
  for (const iv of list) {
    if (cut.end <= iv.start || cut.start >= iv.end) {
      out.push(iv)
      continue
    }
    if (cut.start > iv.start) out.push({ start: iv.start, end: cut.start })
    if (cut.end < iv.end) out.push({ start: cut.end, end: iv.end })
  }
  return out
}

/** Decodifica um arquivo de áudio/vídeo para AudioBuffer usando o Web Audio */
export async function decodeAudioFile(file: Blob): Promise<AudioBuffer | null> {
  const buf = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 48000)
  try {
    return await ctx.decodeAudioData(buf)
  } catch {
    return null
  }
}
