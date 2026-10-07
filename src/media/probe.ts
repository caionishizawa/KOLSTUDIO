import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'

export interface ProbeResult {
  type: 'video' | 'audio' | 'image'
  duration?: number
  width?: number
  height?: number
  rotation?: number
  hasAudio?: boolean
  videoCodec?: string | null
  /** O Chrome consegue decodificar o vídeo com WebCodecs? */
  canDecodeVideo?: boolean
  canDecodeAudio?: boolean
}

export async function probeImage(file: Blob): Promise<ProbeResult> {
  const bmp = await createImageBitmap(file)
  const r: ProbeResult = { type: 'image', width: bmp.width, height: bmp.height }
  bmp.close()
  return r
}

export async function probeMedia(file: Blob, type: 'video' | 'audio'): Promise<ProbeResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const result: ProbeResult = { type }
    const video = type === 'video' ? await input.getPrimaryVideoTrack() : null
    const audio = await input.getPrimaryAudioTrack()
    result.hasAudio = !!audio
    if (video) {
      result.width = await video.getDisplayWidth()
      result.height = await video.getDisplayHeight()
      result.rotation = await video.getRotation()
      result.videoCodec = await video.getCodec()
      result.canDecodeVideo = await video.canDecode()
    }
    if (audio) result.canDecodeAudio = await audio.canDecode()
    result.duration = await input.computeDuration()
    return result
  } finally {
    input.dispose()
  }
}

/** Tenta ler as dimensões/duração pelo <video>, como fallback do probe. */
export function probeWithVideoElement(url: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.src = url
    const done = () => {
      resolve({
        type: 'video',
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
        width: v.videoWidth,
        height: v.videoHeight,
        canDecodeVideo: v.videoWidth > 0,
      })
      v.src = ''
    }
    v.onloadedmetadata = done
    v.onerror = () => reject(new Error('Não foi possível ler o vídeo'))
  })
}
