/**
 * ForeSight evolution layer: β conflict resolution (design §11).
 *
 * Flow: new fact n written → vector neighbors → cosine similarity ≥
 * conflict_sim_threshold → judgement (injectable LLM hook; default rules:
 * aspect compatibility + same topic) → allocate per β:
 *
 *   β→0 conservative: n.activation = beta_observe (parked), o unchanged;
 *   β→1 aggressive:  n takes over (activation=1.0), o → suppressed;
 *   middle: weighted by evidence_support (β≥0.5 clips o).
 *
 * True conflicts always get a links rel='contradicts' edge (evidence trail).
 * Suppression is SOFT: suppressed rows remain, retrieval f_activation≈0,
 * nudge can restore — the β safety valve.
 */
import type { Aspect, MemoryStatus, Policy } from '../types.js'
import type { Memory, Store } from '../store.js'
import { computeActivation, evidence } from './activation.js'
import { normalizeClock, systemClock, type Clock, type ClockLike } from '../clock.js'

export type ConflictJudge = (n: Memory, o: Memory) => boolean | Promise<boolean>

/** Topic similarity thresholds (embedding cosine; Jaccard fallback). */
const TOPIC_COS_THRESHOLD = 0.6
const TOPIC_TOKEN_JACCARD = 0.3

/** Aspect compatibility: which new×old pairs may conflict. */
export function aspectsConflict(nAspect: Aspect, oAspect: Aspect): boolean {
  if (nAspect === 'progressive') return oAspect === 'progressive'
  if (nAspect === 'perfect') return oAspect === 'progressive' || oAspect === 'perfect' || oAspect === 'prospective'
  if (nAspect === 'prospective') return oAspect === 'prospective'
  return false
}

function embeddingCosine(a: Buffer, b: Buffer): number {
  const n = Math.floor(a.byteLength / 4)
  const va = new Float32Array(a.buffer, a.byteOffset, n)
  const vb = new Float32Array(b.buffer, b.byteOffset, n)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += va[i] * vb[i]
    na += va[i] * va[i]
    nb += vb[i] * vb[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Lightweight topic tokens: ASCII words (≥3 chars) + CJK chunks & bigrams. */
function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3) out.add(w)
  }
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const chunk of cjk) {
    if (chunk.length >= 2) {
      out.add(chunk)
      for (let i = 0; i + 2 <= chunk.length; i++) out.add(chunk.slice(i, i + 2))
    }
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** Default judge (rules path): aspect compatible + same topic. */
export function defaultConflictJudge(n: Memory, o: Memory): boolean {
  if (!aspectsConflict(n.aspect, o.aspect)) return false
  if (n.embedding && o.embedding) {
    return embeddingCosine(n.embedding, o.embedding) >= TOPIC_COS_THRESHOLD
  }
  return jaccard(tokens(n.content), tokens(o.content)) >= TOPIC_TOKEN_JACCARD
}

export interface ConflictAction {
  oldId: string
  oldStatus: MemoryStatus
  newActivation: number
  oldActivation: number
  action: 'observe' | 'weighted' | 'clip'
}

export interface ConflictResolution {
  checked: boolean
  conflicts: ConflictAction[]
}

/** β conflict resolver: call resolveOnWrite after inserting new memory. β runtime-adjustable. */
export class ConflictResolver {
  private beta: number
  private judge: ConflictJudge
  private clock: Clock

  constructor(
    private policy: Policy,
    private store: Store,
    judge?: ConflictJudge,
    clock: ClockLike = systemClock,
  ) {
    this.beta = policy.activation.beta
    this.judge = judge ?? defaultConflictJudge
    this.clock = normalizeClock(clock)
  }

  /** Runtime β (Root tool), clamped [0,1], audit beta.set. */
  setBeta(v: number): void {
    this.beta = Math.min(1, Math.max(0, v))
    this.store.emit('beta.set', null, { beta: this.beta })
  }

  getBeta(): number {
    return this.beta
  }

  async resolveOnWrite(n: Memory, now = this.clock.now()): Promise<ConflictResolution> {
    const cfg = this.policy.activation
    if (!n.embedding) return { checked: false, conflicts: [] }
    const vec = toF32(n.embedding)
    const neighbors = this.store.vectorNeighbors(vec, this.policy.retrieval.candidates)
    const conflicts: ConflictAction[] = []
    for (const nb of neighbors) {
      const o = this.store.getMemory(nb.id)
      if (!o || o.id === n.id || o.status !== 'active') continue
      // Manual cosine: vec0 default metric is L2; nb.distance is not cosine.
      const sim = o.embedding ? cosine(vec, toF32(o.embedding)) : 0
      if (sim < cfg.conflict_sim_threshold) continue
      const isConflict = await this.judge(n, o)
      if (!isConflict) continue
      conflicts.push(this.applyConflict(n, o, now))
    }
    return { checked: true, conflicts }
  }

  /**
   * Arbitration (Bayesian odds form):
   *
   *   keep new ⟺ eN·β > eO·(1−β)   (equiv: (eN/eO)·(β/(1−β)) > 1)
   *
   * e = evidence(m) (β-free objective score), β = prior P(new true) ∈ [0,1].
   * margin = hysteresis band (policy activation.support.margin): ratio inside
   * band → not significant → park new (conservative default; clipping is
   * destructive and needs significant evidence). Clipped side is soft-suppressed
   * (activation=ε, status=suppressed), nudge can restore.
   */
  private applyConflict(n: Memory, o: Memory, now: number): ConflictAction {
    const cfg = this.policy.activation
    const beta = this.beta

    // Compute evidence BEFORE writing the contradicts edge: the edge between
    // the pair is a *product* of the arbitration, not external evidence —
    // writing it first would let evidence dominate and β become inert.
    const eN = evidence(this.policy, this.store, n, now, o)
    const eO = evidence(this.policy, this.store, o, now)
    const margin = cfg.support?.margin ?? 1.2

    const wN = eN * beta
    const wO = eO * (1 - beta)
    let action: ConflictAction['action']
    if (wN > wO * margin) {
      action = 'clip'
    } else if (wO > wN * margin) {
      action = 'observe'
    } else {
      action = 'observe'
    }

    this.store.insertLink(n.id, o.id, 'contradicts', n.source)

    let nAct: number
    if (action === 'observe') {
      nAct = cfg.beta_observe
    } else {
      nAct = Math.min(1, Math.max(cfg.suppression_epsilon, computeActivation(this.policy, this.store, n, now)))
    }

    let oldStatus: MemoryStatus = o.status
    let oldActivation = o.activation
    if (action === 'clip') {
      this.store.updateMemory(o.id, { activation: cfg.suppression_epsilon, status: 'suppressed' })
      this.store.emit('memory.suppress', o.id, { by: n.id, beta, action, eN: round2(eN), eO: round2(eO) })
      oldStatus = 'suppressed'
      oldActivation = cfg.suppression_epsilon
    }
    this.store.updateMemory(n.id, { activation: nAct })
    return { oldId: o.id, oldStatus, newActivation: nAct, oldActivation: oldActivation, action }
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function toF32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/** Manual cosine similarity (vec0 default L2 metric — distance is NOT cosine). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}
