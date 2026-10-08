// Copia os binários wasm (MediaPipe, FFmpeg e onnxruntime-web) de node_modules para public/,
// para tudo ser servido localmente, sem CDN. Roda no postinstall.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** [origem, destino, filtro opcional de nome de arquivo] */
const copies = [
  ['node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe'],
  ['node_modules/@ffmpeg/core/dist/esm', 'public/ffmpeg'],
  // onnxruntime-web (RVM): só o runtime wasm (+ jsep = WebGPU) e seus carregadores .mjs;
  // o JS principal vem pelo Vite (import 'onnxruntime-web').
  ['node_modules/onnxruntime-web/dist', 'public/ort', /^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/],
]

for (const [from, to, filter] of copies) {
  const src = join(root, from)
  const dst = join(root, to)
  if (!existsSync(src)) {
    console.warn(`[prepare-assets] não encontrado: ${from}`)
    continue
  }
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, {
    recursive: true,
    filter: filter ? (p) => p === src || filter.test(basename(p)) : undefined,
  })
  console.log(`[prepare-assets] ${from} -> ${to}`)
}
