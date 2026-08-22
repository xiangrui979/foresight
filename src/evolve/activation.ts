/**
 * ForeSight evolution layer: activation engine (design §11).
 *
 * Two computations:
 *
 * 1. activation(m, t): retrieval/injection activation =
 *    base_weight × temporal_factor × evidence_support.
 *    temporal_factor is 0/1 (progressive inside interval=1, outside=0).
 *
 * 2. support(m, now): objective evidence score for conflict arbitration
 *    (excludes β; β enters the arbitration formula as a prior):
 *
 *      evidence(m, now) = baseWeight × temporalWeight(m, now) × evidenceSupport(m, now)
 *
 *    β is a single continuous parameter ∈ [0,1] — closer to 1 accepts new
 *    facts more readily; closer to 0 keeps old facts. Mathematically it is
 *    the Bayesian prior P(new fact true); log space = logit(β) decision
 *    surface (logistic-regression isomorphic).
 *
 *    - temporalWeight: continuous time weight — progressive decays linearly
 *      with age/TTL (stale ongoing states are easier to overturn).
 *    - evidenceSupport: link diffusion, hopped ≤2, each evidence contributes
 *      with its own time decay (evidence_half_life_days) — old evidence
 *      supports less than new evidence.
 */
import type { Policy } from '../policy.js'
import type { Memory, Store } from '../store.js'
import { progressiveWindow } from './temporal.js'

/** Directional sign contribution of each rel for its endpoints (src=claimant). */
const REL_SIGN: Record<string, { src: number; dst: number }> = {
  supports: { src: 0.0, dst: 1.0 },
  contradicts: { src: 1.0, dst: -1.0 },
  refines: { src: 0.2, dst: 0.5 },
  precedes: { src: 0.1, dst: 0.1 },
  related: { src: 0.1, dst: 0.1 },
}

const ES_MIN = 0.05
const ES_MAX = 3.0

function decayFactor(ageDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1
  return Math.exp(-(Math.LN2 / halfLifeDays) * ageDays)
}

/** Anchor age in days (point/interval start preferred, else created_at). */
export function anchorAgeDays(m: Memory, now: number): number {
  const t = m.anchor?.start ?? m.anchor?.end
  const ref = t ? Date.parse(t) : m.createdAt
  if (!Number.isFinite(ref)) return 0
  return Math.max(0, (now - ref) / 86_400_000)
}

/** Evidence support via link diffusion (age-decayed). */
export function evidenceSupport(policy: Policy, store: Store, memoryId: string, now: number): number {
  const factors = policy.retrieval.factors.links
  const maxHops = Number(factors?.spread_hops ?? 2)
  const decay = Number(factors?.edge_decay ?? 0.5)
  const evHalfLife = policy.activation.support?.evidence_half_life_days ?? 365

  let total = 1.0
  const hop1: Array<{ id: string; sign: number }> = []

  for (const e of store.listLinksOf(memoryId)) {
    const dir = e.src === memoryId ? 'src' : 'dst'
    const s = REL_SIGN[e.rel]?.[dir] ?? 0
    if (s === 0) continue
    const nb = store.getMemory(e.src === memoryId ? e.dst : e.src)
    const age = nb ? anchorAgeDays(nb, now) : 0
    const contrib = s * e.weight * decayFactor(age, evHalfLife)
    total += contrib
    hop1.push({ id: e.src === memoryId ? e.dst : e.src, sign: contrib })
  }

  if (maxHops >= 2) {
    for (const h of hop1) {
      for (const e of store.listLinksOf(h.id)) {
        const other = e.src === h.id ? e.dst : e.src
        if (other === memoryId) continue
        const dir = e.src === h.id ? 'src' : 'dst'
        const s2 = REL_SIGN[e.rel]?.[dir] ?? 0
        const nb = store.getMemory(other)
        const age = nb ? anchorAgeDays(nb, now) : 0
        total += h.sign * s2 * e.weight * decay * decayFactor(age, evHalfLife)
      }
    }
  }

  return Math.min(ES_MAX, Math.max(ES_MIN, total))
}

/** Source base weight: policy first, stored column fallback. */
export function baseWeightFor(policy: Policy, m: Memory): number {
  const fromPolicy = policy.activation.base_weights[m.source]
  if (typeof fromPolicy === 'number') return fromPolicy
  return m.baseWeight ?? 1.0
}

/** temporal_factor: progressive in-window=1 / out=0; others 1. */
export function temporalFactor(policy: Policy, m: Memory, now: number): number {
  if (m.aspect !== 'progressive') return 1
  const w = progressiveWindow(policy, m)
  if (w.endMs === null) return 1
  if (w.startMs !== null && now < w.startMs) return 0
  return now <= w.endMs ? 1 : 0
}

/** temporal_weight: continuous time weight (arbitration face, not 0/1). */
export function temporalWeight(policy: Policy, m: Memory, now: number): number {
  if (m.aspect !== 'progressive') return 1
  const ttlDays = Number(policy.aspects.progressive.default_ttl_days ?? 7)
  const age = anchorAgeDays(m, now)
  if (age <= 0) return 1
  const ratio = Math.min(1, age / Math.max(1, ttlDays))
  return 1 - 0.5 * ratio // [0.5, 1] linear
}

/** Objective evidence (β-free); aspect_direction_prior when perfect clips progressive. */
export function evidence(policy: Policy, store: Store, m: Memory, now: number, conflictWith?: Memory): number {
  let v = baseWeightFor(policy, m)
    * temporalWeight(policy, m, now)
    * evidenceSupport(policy, store, m.id, now)
  if (conflictWith && m.aspect === 'perfect' && conflictWith.aspect === 'progressive') {
    v *= policy.activation.support?.aspect_direction_prior ?? 1.5
  }
  return Math.max(0.01, v)
}

/** Full activation (retrieval face): base × temporal_factor × evidence, clamp [0,1]. */
export function computeActivation(policy: Policy, store: Store, m: Memory, now: number): number {
  const v = baseWeightFor(policy, m) * temporalFactor(policy, m, now) * evidenceSupport(policy, store, m.id, now)
  return Math.min(1, Math.max(0, v))
}
