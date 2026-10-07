// Copia os binários wasm (MediaPipe e FFmpeg) de node_modules para public/,
// para tudo ser servido localmente, sem CDN. Roda no postinstall.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const copies = [
  ['node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe'],
  ['node_modules/@ffmpeg/core/dist/esm', 'public/ffmpeg'],
]

for (const [from, to] of copies) {
  const src = join(root, from)
  const dst = join(root, to)
  if (!existsSync(src)) {
    console.warn(`[prepare-assets] não encontrado: ${from}`)
    continue
  }
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true })
  console.log(`[prepare-assets] ${from} -> ${to}`)
}
