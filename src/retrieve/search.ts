/**
 * ForeSight retrieval main (design §8, acceptance V5).
 *
 * Flow: structural filter (status/activation/aspect/time-window) →
 * embed query → vector candidates → score = Σ(w_i·f_i)/Σw_i → min_score
 * cutoff → top_k → anchor render.
 *
 * Degradation: query embed failure does NOT block retrieval — skip f_embed,
 * other factors fuse normally. Time-range filtering is structural (exact
 * anchor interval judgement), not scoring.
 *
 * Three call shapes (dispatched at runtime):
 *   1. full:    search(query, store, embed, policy, now?, opts?)
 *   2. server:  search(store, query, opts?)          — degraded (§13 HTTP)
 *   3. query:   search(query, {store, embed, policy, now}, opts?) — §12 reasoning
 */
import type { Store, Memory } from '../store.js'
import type { EmbedProvider } from '../store/embed.js'
import type { Policy, Aspect } from '../policy.js'
import type { Anchor } from '../types.js'
import { behavior } from '../policy.js'
import { FACTORS, type FactorInput } from './factors.js'
import { lifecycleEligible } from '../evolve/temporal.js'
import { systemClock } from '../clock.js'

/** Structural activation floor: entries with activation ≤ this never enter
 *  candidates (suppressed ≈ 0.05 → filtered by design §11). */
const STRUCTURAL_ACTIVATION_FLOOR = 0.2

export interface TimeRange {
  from?: string
  to?: string
}

export interface SearchOptions {
  aspect?: Aspect | Aspect[]
  from?: string
  to?: string
  k?: number
  timeRange?: TimeRange
  topK?: number
  minScore?: number
  candidates?: number
}

export interface SearchHit {
  id: string
  content: string
  aspect: Aspect
  anchor: Anchor
  activation: number
  score: number
  createdAt: number
  memory: Memory
  factors: Record<string, number>
  rendered: string
}

export interface SearchDeps {
  store: Store
  embed: EmbedProvider
  policy: Policy
  now: number
}

/** Anchor interval vs query window intersection (in-memory exact; ISO parse). */
export function anchorInRange(m: Memory, range?: TimeRange): boolean {
  if (!range || (range.from === undefined && range.to === undefined)) return true
  let s = m.anchor.start ?? m.anchor.end
  let e = m.anchor.end ?? m.anchor.start
  if (s === undefined && e === undefined) {
    const iso = new Date(m.createdAt).toISOString()
    s = iso
    e = iso
  }
  const entryStart = s !== undefined ? Date.parse(s) : -Infinity
  const entryEnd = e !== undefined ? Date.parse(e) : Infinity
  const from = range.from !== undefined ? Date.parse(range.from) : -Infinity
  const to = range.to !== undefined ? Date.parse(range.to) : Infinity
  return entryStart <= to && entryEnd >= from
}

/** Structural filter via Store public methods (indexed by aspect+status). */
export function structuralFilter(store: Store, opts: SearchOptions): Memory[] {
  const aspects: Aspect[] = opts.aspect
    ? (Array.isArray(opts.aspect) ? opts.aspect : [opts.aspect])
    : ['progressive', 'perfect', 'prospective']
  const statuses = ['active', 'suppressed'] as const
  const out: Memory[] = []
  for (const aspect of aspects) {
    for (const status of statuses) {
      for (const m of store.listByAspectStatus(aspect, status)) {
        if (m.activation <= STRUCTURAL_ACTIVATION_FLOOR) continue
        if (!anchorInRange(m, opts.timeRange)) continue
        out.push(m)
      }
    }
  }
  return out
}

/**
 * Anchor render (P2 table lookup: behavior(aspect).render_anchor).
 * Supported values (C9 value-domain alignment):
 *   false / 'none' → plain; true / 'short' → short suffix;
 *   'always' → absolute-time prefix; 'endpoint' → end suffix.
 */
export function renderMemory(m: Memory, policy: Policy): string {
  const mode = behavior(policy, m.aspect).render_anchor
  if (mode === 'always' && m.anchor.start) {
    return `在 ${m.anchor.start} 时：${m.content}`
  }
  if (mode === 'endpoint' && m.anchor.end) {
    return `${m.content}（至 ${m.anchor.end}）`
  }
  if (mode === true || mode === 'short') {
    if (m.anchor.type === 'interval' && m.anchor.end) {
      return `${m.content}（至 ${m.anchor.end}）`
    }
    if (m.anchor.start) {
      return `${m.content}（${m.anchor.start} 起）`
    }
  }
  return m.content
}

function toHit(m: Memory, score: number, factors: Record<string, number>, policy: Policy): SearchHit {
  return {
    id: m.id,
    content: m.content,
    aspect: m.aspect,
    anchor: m.anchor,
    activation: m.activation,
    score,
    createdAt: m.createdAt,
    memory: m,
    factors,
    rendered: renderMemory(m, policy),
  }
}

async function searchFull(
  query: string,
  store: Store,
  embed: EmbedProvider,
  policy: Policy,
  now: number,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const merged: SearchOptions = {
    ...opts,
    timeRange:
      opts.timeRange ?? (opts.from !== undefined || opts.to !== undefined ? { from: opts.from, to: opts.to } : undefined),
    topK: opts.topK ?? opts.k,
  }

  // Lifecycle read-path filter (C1/C10): callers are expected to sweep first
  // (ForeSight.query does); this also hides not-started progressive rows.
  const filtered = structuralFilter(store, merged).filter((m) => lifecycleEligible(policy, m, now))

  let queryVec: Float32Array | null = null
  try {
    queryVec = await embed.embedOne(query)
  } catch (e) {
    console.warn(`[retrieve] query embed failed, degrades f_embed: ${(e as Error).message}`)
  }

  // Candidates: vector neighbors (4x for safety) intersecting the filtered set;
  // fall back to activation-sorted rest so retrieval never goes blind on
  // empty/零向量 stores.
  const candidatesN = Math.max(1, Number(merged.candidates ?? policy.retrieval.candidates))
  const distances = new Map<string, number>()
  const candidates: Memory[] = []
  if (queryVec) {
    const near = store.vectorNeighbors(queryVec, Math.max(candidatesN * 4, candidatesN))
    const byId = new Map(filtered.map((m) => [m.id, m]))
    for (const n of near) {
      if (!byId.has(n.id)) continue
      if (distances.has(n.id)) continue
      distances.set(n.id, n.distance)
      candidates.push(byId.get(n.id)!)
      if (candidates.length >= candidatesN) break
    }
  }
  if (candidates.length < candidatesN) {
    const have = new Set(candidates.map((c) => c.id))
    const rest = [...filtered]
      .filter((m) => !have.has(m.id))
      .sort((a, b) => b.activation - a.activation)
    for (const m of rest) {
      candidates.push(m)
      if (candidates.length >= candidatesN) break
    }
  }

  const activationCache = new Map<string, number>()
  const scored: SearchHit[] = candidates.map((memory) => {
    const factors: Record<string, number> = {}
    let sumW = 0
    let sumWF = 0
    const input: FactorInput = {
      memory,
      now,
      policy,
      store,
      distances,
      queryEmbedding: queryVec,
      activationCache,
    }
    for (const [name, fn] of Object.entries(FACTORS)) {
      const cfg = policy.retrieval.factors[name]
      if (!cfg || !cfg.enabled) continue
      const f = fn(input)
      factors[name] = f
      sumW += Number(cfg.weight)
      sumWF += Number(cfg.weight) * f
    }
    const score = sumW > 0 ? sumWF / sumW : 0
    return toHit(memory, score, factors, policy)
  })

  scored.sort((a, b) => b.score - a.score)
  const minScore = merged.minScore ?? policy.retrieval.min_score
  const topK = merged.topK ?? policy.retrieval.top_k
  return scored.filter((h) => h.score >= minScore).slice(0, topK)
}

/** Degraded search (shape 2: no embed/policy context — substring + structure). */
async function searchDegraded(store: Store, query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const timeRange =
    opts.timeRange ?? (opts.from !== undefined || opts.to !== undefined ? { from: opts.from, to: opts.to } : undefined)
  const hits = structuralFilter(store, { ...opts, timeRange })
    .filter((m) => m.content.includes(query))
    .sort((a, b) => b.activation - a.activation)
    .slice(0, opts.k ?? 10)
  return hits.map((m) => ({
    id: m.id,
    content: m.content,
    aspect: m.aspect,
    anchor: m.anchor,
    activation: m.activation,
    score: m.activation,
    createdAt: m.createdAt,
    memory: m,
    factors: { activation: m.activation },
    rendered: m.content,
  }))
}

function isStore(v: unknown): v is Store {
  return typeof v === 'object' && v !== null && 'listByAspectStatus' in v
}

function isSearchDeps(v: unknown): v is SearchDeps {
  return (
    typeof v === 'object' &&
    v !== null &&
    'store' in v &&
    'embed' in v &&
    'policy' in v &&
    'now' in v
  )
}

/** Retrieval main entry (three shapes, see header). */
export async function search(
  query: string,
  store: Store,
  embed: EmbedProvider,
  policy: Policy,
  now?: number,
  opts?: SearchOptions,
): Promise<SearchHit[]>
export async function search(store: Store, query: string, opts?: SearchOptions): Promise<SearchHit[]>
export async function search(query: string, deps: SearchDeps, opts?: SearchOptions): Promise<SearchHit[]>
export async function search(
  a: string | Store,
  b: Store | string | SearchDeps,
  c?: EmbedProvider | SearchOptions,
  d?: Policy,
  e?: number,
  f: SearchOptions = {},
): Promise<SearchHit[]> {
  if (typeof a === 'string') {
    if (isStore(b)) {
      return searchFull(a, b, c as EmbedProvider, d as Policy, e ?? systemClock.now(), f)
    }
    const deps = b as SearchDeps
    return searchFull(a, deps.store, deps.embed, deps.policy, deps.now, (c as SearchOptions) ?? {})
  }
  return searchDegraded(a, b as string, (c as SearchOptions) ?? {})
}
