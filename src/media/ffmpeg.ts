/**
 * Fallback com FFmpeg.wasm para vídeos que o Chrome não decodifica (ex.: HEVC de iPhone).
 * O core é servido localmente de /ffmpeg (copiado de node_modules pelo script prepare-assets).
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg'

let instance: Promise<FFmpeg> | null = null

async function getFFmpeg(): Promise<FFmpeg> {
  if (!instance) {
    instance = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg')
      const ff = new FFmpeg()
      await ff.load({
        coreURL: new URL('/ffmpeg/ffmpeg-core.js', location.origin).href,
        wasmURL: new URL('/ffmpeg/ffmpeg-core.wasm', location.origin).href,
      })
      return ff
    })()
    instance.catch(() => (instance = null))
  }
  return instance
}

/**
 * Converte para H.264 + AAC (MP4), 30 fps constante, respeitando a rotação.
 * Retorna um novo File.
 */
export async function transcodeToH264(file: File, onProgress?: (p: number) => void): Promise<File> {
  const ff = await getFFmpeg()
  const { fetchFile } = await import('@ffmpeg/util')
  const inName = 'in_' + Math.random().toString(36).slice(2) + '.' + (file.name.split('.').pop() || 'mov')
  const outName = inName.replace(/\.[^.]+$/, '') + '.mp4'
  const handler = ({ progress }: { progress: number }) => onProgress?.(Math.max(0, Math.min(1, progress)))
  ff.on('progress', handler)
  try {
    await ff.writeFile(inName, await fetchFile(file))
    const code = await ff.exec([
      '-i',
      inName,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-vsync',
      'cfr',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outName,
    ])
    if (code !== 0) throw new Error('FFmpeg falhou (código ' + code + ')')
    const data = (await ff.readFile(outName)) as Uint8Array
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    await ff.deleteFile(inName).catch(() => {})
    await ff.deleteFile(outName).catch(() => {})
    return new File([copy], file.name.replace(/\.[^.]+$/, '') + '.converted.mp4', { type: 'video/mp4' })
  } finally {
    ff.off('progress', handler)
  }
}
