import type { Asset, Take } from '../types'
import { naturalCompare } from './classify'

/** "3a.png" -> { n: 3, sub: "a" }; "foo.png" -> null */
export function parseImageNumber(name: string): { n: number; sub: string } | null {
  const base = name.replace(/\.[^.]+$/, '')
  const m = /^(\d+)\s*([a-z]?)\b/i.exec(base.trim())
  if (!m) return null
  return { n: parseInt(m[1], 10), sub: m[2].toLowerCase() }
}

/**
 * Atribuição automática de imagens aos takes.
 * - Número no nome manda: "3.png" no take 3, "3a"/"3b" dividem o take 3.
 * - Sem número: preenchem, na ordem de envio, os takes que ficaram sem imagem.
 * - Sobras: vão para os takes mais longos (um por take, por ordem de duração).
 * Takes com imagesLocked não são alterados.
 * Retorna um mapa takeId -> lista de assetIds.
 */
export function autoAssignImages(
  takes: Take[],
  images: Asset[],
  takeDurations: Map<string, number>,
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const enabledTakes = takes.filter((t) => t.enabled)
  for (const t of takes) result.set(t.id, t.imagesLocked ? [...t.images] : [])

  // ordem de envio (como o usuário escolheu os arquivos); o número no nome, quando existe, manda
  const sorted = [...images].sort((a, b) => (a.uploadIndex ?? 0) - (b.uploadIndex ?? 0) || naturalCompare(a.name, b.name))
  const numbered: { asset: Asset; n: number; sub: string }[] = []
  const unnumbered: Asset[] = []
  for (const img of sorted) {
    const p = parseImageNumber(img.name)
    if (p) numbered.push({ asset: img, ...p })
    else unnumbered.push(img)
  }

  const usedAssets = new Set<string>()
  for (const t of takes) if (t.imagesLocked) t.images.forEach((id) => usedAssets.add(id))

  // numeradas
  numbered.sort((a, b) => a.n - b.n || naturalCompare(a.sub, b.sub))
  const leftovers: Asset[] = []
  for (const { asset, n } of numbered) {
    if (usedAssets.has(asset.id)) continue
    const take = enabledTakes[n - 1]
    if (!take || take.imagesLocked) {
      leftovers.push(asset)
      continue
    }
    result.get(take.id)!.push(asset.id)
    usedAssets.add(asset.id)
  }

  // sem número: takes vazios, em ordem
  const pool = [...unnumbered.filter((a) => !usedAssets.has(a.id)), ...leftovers]
  for (const t of enabledTakes) {
    if (pool.length === 0) break
    if (t.imagesLocked) continue
    const list = result.get(t.id)!
    if (list.length === 0) {
      const a = pool.shift()!
      list.push(a.id)
      usedAssets.add(a.id)
    }
  }

  // sobras: takes mais longos recebem mais uma imagem cada
  if (pool.length > 0) {
    const byLength = enabledTakes
      .filter((t) => !t.imagesLocked)
      .sort((a, b) => (takeDurations.get(b.id) ?? 0) - (takeDurations.get(a.id) ?? 0))
    let i = 0
    while (pool.length > 0 && byLength.length > 0) {
      const t = byLength[i % byLength.length]
      result.get(t.id)!.push(pool.shift()!.id)
      i++
    }
  }
  return result
}

/**
 * Herança: take sem imagem mostra a do take anterior; se o primeiro não tiver, usa a próxima disponível.
 * Recebe listas por take (na ordem dos takes ativos) e devolve listas resolvidas.
 */
export function resolveInheritance(lists: string[][]): string[][] {
  const out: string[][] = lists.map((l) => [...l])
  let last: string | null = null
  for (let i = 0; i < out.length; i++) {
    if (out[i].length > 0) {
      last = out[i][out[i].length - 1]
      continue
    }
    if (last) out[i] = [last]
    else {
      // procura a próxima
      const next = out.slice(i + 1).find((l) => l.length > 0)
      if (next) out[i] = [next[0]]
    }
  }
  return out
}

export const MIN_IMAGE_WIDTH = 720
