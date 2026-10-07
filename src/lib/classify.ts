import type { AssetKind, MediaType } from '../types'

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i
const AUDIO_EXT = /\.(mp3|m4a|wav|aac|ogg|flac)$/i

export function mediaTypeOf(name: string, mime: string): MediaType | null {
  if (VIDEO_EXT.test(name) || mime.startsWith('video/')) return 'video'
  if (IMAGE_EXT.test(name) || mime.startsWith('image/')) return 'image'
  if (AUDIO_EXT.test(name) || mime.startsWith('audio/')) return 'audio'
  return null
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/**
 * Classifica um arquivo pela subpasta e pelo nome.
 * folder: caminho relativo (ex: "react/", "takes/", "imagens/")
 */
export function classify(name: string, folder: string, type: MediaType): AssetKind {
  const f = norm(folder)
  const n = norm(name.replace(/\.[^.]+$/, ''))

  if (type === 'audio') return 'music'
  if (type === 'image') return 'image'

  // vídeo
  if (/^reac|^reaction/.test(n) || /reacao|reaction/.test(f) && !/clip/.test(n)) return 'reaction'
  if (/^clip|^clipe/.test(n) || /clipe|clip/.test(f)) return 'clip'
  if (/react/.test(f)) {
    // dentro de react/: clipe.* e reacao.*
    if (/reac/.test(n)) return 'reaction'
    return 'clip'
  }
  if (/take/.test(f) || /^take/.test(n)) return 'take'
  if (/imagem|imagens|image|apoio|broll|b-roll/.test(f)) return 'image'
  if (/music|musica|audio|som/.test(f)) return 'music'
  // vídeo solto: provavelmente um take
  return 'take'
}

/** Ordem natural: take2 antes de take10 */
export const naturalCompare = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' }).compare

export function naturalSortBy<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)))
}

export interface DroppedFile {
  file: File
  /** caminho relativo da pasta de origem, com barra no fim ou vazio */
  folder: string
}

/** Lê arquivos e pastas arrastadas (DataTransferItemList com webkitGetAsEntry). */
export async function readDrop(dt: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  const items = Array.from(dt.items || [])
  const entries: FileSystemEntry[] = []
  for (const it of items) {
    if (it.kind !== 'file') continue
    const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
    else {
      const f = it.getAsFile()
      if (f) out.push({ file: f, folder: '' })
    }
  }
  if (entries.length === 0 && dt.files) {
    for (const f of Array.from(dt.files)) out.push({ file: f, folder: '' })
    return out
  }
  for (const e of entries) await walk(e, '', out)
  return out
}

async function walk(entry: FileSystemEntry, folder: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    if (file.name.startsWith('.')) return
    out.push({ file, folder })
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const all: FileSystemEntry[] = []
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (batch.length === 0) break
      all.push(...batch)
    }
    for (const child of all) await walk(child, folder + entry.name + '/', out)
  }
}

/** Para <input type=file webkitdirectory>: usa webkitRelativePath */
export function fromFileList(files: FileList | File[]): DroppedFile[] {
  return Array.from(files)
    .filter((f) => !f.name.startsWith('.'))
    .map((f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || ''
      const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
      return { file: f, folder }
    })
}
