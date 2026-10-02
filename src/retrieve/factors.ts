/**
 * ForeSight retrieval scoring factors (P3: composable scoring).
 *
 * score = Σ(w_i·f_i) / Σw_i. Every factor is a pure function:
 * { FactorInput } → [0,1]. policy.retrieval.factors.<name> controls
 * enabled/weight (P1 zero-hardcode). Adding a factor = 1 module + 1 FACTORS
 * entry + 1 policy line.
 */
import type { Memory, Store } from '../store.js'
import type { Policy } from '../policy.js'
import { blobToF32 } from '../f32.js'

const MS_PER_DAY = 86_400_000

export interface FactorInput {
  memory: Memory
  now: number
  policy: Policy
  store: Store
  /** Neighbor distance table (id → distance) from vectorNeighbors. */
  distances?: Map<string, number>
  queryEmbedding?: Float32Array | null
  /** Neighbor activation cache (f_links diffusion). */
  activationCache?: Map<string, number>
}

export type FactorFn = (input: FactorInput) => number

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** memories.embedding BLOB → Float32Array (alignment-safe across drivers). */
export function bufferToVec(buf: Uint8Array): Float32Array {
  return blobToF32(buf)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** f_embed: query × memory cosine (manual; vec0 default metric is L2). */
export function f_embed(input: FactorInput): number {
  if (input.queryEmbedding && input.memory.embedding) {
    return clamp01(cosine(input.queryEmbedding, bufferToVec(input.memory.embedding)))
  }
  const d = input.distances?.get(input.memory.id)
  if (d !== undefined) return clamp01(1 - d)
  return 0
}

/** f_time: anchor age exponential decay; prospective never decays. */
export function f_time(input: FactorInput): number {
  const policy = input.policy
  if (!policy.activation.temporal_decay_enabled) return 1
  if (input.memory.aspect === 'prospective') return 1
  const halfLifeDays = Number(policy.activation.half_life_days)
  if (!halfLifeDays || halfLifeDays <= 0) return 1
  const anchorStart = input.memory.anchor.start
  const startMs = anchorStart ? Date.parse(anchorStart) : NaN
  const ageMs = Number.isNaN(startMs) ? input.now - input.memory.createdAt : input.now - startMs
  const ageDays = Math.max(0, ageMs) / MS_PER_DAY
  const lambda = Math.LN2 / halfLifeDays
  return Math.exp(-lambda * ageDays)
}

/** f_activation: entry activation (suppressed ≈ 0 naturally). */
export function f_activation(input: FactorInput): number {
  return clamp01(input.memory.activation)
}

/** f_links: spreading activation along links (BFS, hop ≤ spread_hops). */
export function f_links(input: FactorInput): number {
  const cfg = input.policy.retrieval.factors.links
  if (!cfg || !cfg.enabled) return 0
  const spreadHops = typeof cfg.spread_hops === 'number' ? cfg.spread_hops : 2
  const edgeDecay = typeof cfg.edge_decay === 'number' ? cfg.edge_decay : 0.5
  const store = input.store
  const cache = input.activationCache ?? new Map<string, number>()
  const getActivation = (id: string): number => {
    let v = cache.get(id)
    if (v === undefined) {
      const m = store.getMemory(id)
      v = m ? clamp01(m.activation) : 0
      cache.set(id, v)
    }
    return v
  }
  const visited = new Set<string>([input.memory.id])
  let queue: Array<{ id: string; hop: number }> = [{ id: input.memory.id, hop: 0 }]
  let total = 0
  while (queue.length > 0) {
    const next: Array<{ id: string; hop: number }> = []
    for (const { id, hop } of queue) {
      for (const link of store.listLinksOf(id)) {
        const neighbor = link.src === id ? link.dst : link.src
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        const h = hop + 1
        if (h <= spreadHops) {
          total += getActivation(neighbor) * link.weight * Math.pow(edgeDecay, h)
          next.push({ id: neighbor, hop: h })
        }
      }
    }
    queue = next
  }
  return clamp01(total)
}

/** Factor registry: search.ts only iterates this table. */
export const FACTORS: Record<string, FactorFn> = {
  embed: f_embed,
  time: f_time,
  activation: f_activation,
  links: f_links,
}
