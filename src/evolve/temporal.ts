/**
 * ForeSight evolution layer: expiry / TTL / renewal (design §11).
 *
 * Time semantics (§7.1): anchor_json is content time (valid time),
 * created_at is record time (B-series audit) — orthogonal axes.
 * Expiry applies to progressive only (expiry=on_anchor_expiry);
 * perfect/prospective never auto-expire (expiry=never).
 *
 * TTL fallback (policy aspects.progressive.default_ttl_days):
 *   none/open anchor           → expiry = created_at + TTL
 *   point anchor               → expiry = anchor time + TTL
 *   interval + bounded         → expiry = interval end (natural end)
 *   interval + unbounded       → expiry = min(interval end, created_at + TTL)
 *   interval missing end       → expiry = created_at + TTL
 */
import type { Policy } from '../policy.js'
import type { Memory, Store } from '../store.js'

const MS_PER_DAY = 86400000

/** Renewal reminder window: nudge review within 7 days before expiry. */
export const RENEWAL_WINDOW_DAYS = 7

export interface ExpiryWindow {
  startMs: number | null
  endMs: number | null
  reason: 'anchor' | 'ttl' | null
}

function parseIso(s: string | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Progressive valid-time window (start / expiry / basis). */
export function progressiveWindow(policy: Policy, m: Memory): ExpiryWindow {
  const ttlDays = Number(policy.aspects.progressive?.default_ttl_days ?? 7)
  /** TTL fallback is always an absolute deadline (record-time based) ... */
  const createdTtlMs = m.createdAt + ttlDays * MS_PER_DAY
  const startMs = parseIso(m.anchor.start)

  if (m.anchor.type === 'none' || m.anchor.type === 'open') {
    return { startMs: null, endMs: createdTtlMs, reason: 'ttl' }
  }
  if (m.anchor.type === 'point') {
    // ... except point anchors: the TTL runs from the anchor time (C2),
    // never from createdAt + an already-absolute timestamp.
    const base = startMs ?? m.createdAt
    return { startMs: base, endMs: base + ttlDays * MS_PER_DAY, reason: 'ttl' }
  }
  const endMs = parseIso(m.anchor.end)
  if (endMs === null) {
    return { startMs, endMs: createdTtlMs, reason: 'ttl' }
  }
  if (m.telicity === 'unbounded') {
    return createdTtlMs <= endMs
      ? { startMs, endMs: createdTtlMs, reason: 'ttl' }
      : { startMs, endMs, reason: 'anchor' }
  }
  return { startMs, endMs, reason: 'anchor' }
}

/** Eval ablation switch (template `lifecycle.enabled`): false → no lifecycle. */
export function lifecycleEnabled(policy: Policy): boolean {
  return policy.lifecycle?.enabled !== false
}

/** Expiry check: mechanical time comparison; perfect/prospective always active. */
export function expireCheck(policy: Policy, m: Memory, now: number): 'expired' | 'active' {
  if (!lifecycleEnabled(policy)) return 'active'
  if (m.aspect !== 'progressive') return 'active'
  const w = progressiveWindow(policy, m)
  if (w.endMs === null) return 'active'
  return now > w.endMs ? 'expired' : 'active'
}

/** Renewal reminder: active renewable progressive within window → true. */
export function renewalDue(policy: Policy, m: Memory, now: number): boolean {
  if (!lifecycleEnabled(policy)) return false
  if (m.aspect !== 'progressive' || m.status !== 'active') return false
  if (!(policy.aspects.progressive?.renewable ?? false)) return false
  const w = progressiveWindow(policy, m)
  if (w.endMs === null) return false
  const left = w.endMs - now
  return left > 0 && left <= RENEWAL_WINDOW_DAYS * MS_PER_DAY
}

/**
 * Apply expiry: status='expired', activation=ε, emit memory.expire.
 * Idempotent: already-expired/deleted rows untouched.
 */
export function applyExpiry(store: Store, policy: Policy, m: Memory, now: number): boolean {
  if (expireCheck(policy, m, now) !== 'expired') return false
  if (m.status === 'expired' || m.status === 'deleted') return false
  const w = progressiveWindow(policy, m)
  store.updateMemory(m.id, { status: 'expired', activation: policy.activation.suppression_epsilon })
  store.emit('memory.expire', m.id, {
    aspect: m.aspect,
    reason: w.reason ?? 'anchor',
    expiredAt: now,
    endMs: w.endMs,
    telicity: m.telicity,
  })
  return true
}

/** Sweep all active progressive entries (call before injection render). */
export function sweepExpired(store: Store, policy: Policy, now: number): string[] {
  if (!lifecycleEnabled(policy)) return []
  const out: string[] = []
  for (const m of store.listByAspectStatus('progressive', 'active')) {
    if (applyExpiry(store, policy, m, now)) out.push(m.id)
  }
  return out
}

/**
 * Lifecycle read-path eligibility (C1 + C10): progressive is readable only
 * inside [startMs, endMs]. Expiry is normally already materialized by
 * `sweepExpired`; this predicate additionally hides "not started yet"
 * (C10) and keeps callers correct when they skip the sweep.
 * perfect/prospective/gnomic are time-unbounded → always eligible.
 */
export function lifecycleEligible(policy: Policy, m: Memory, now: number): boolean {
  if (!lifecycleEnabled(policy)) return true
  if (m.aspect !== 'progressive') return true
  const w = progressiveWindow(policy, m)
  if (w.startMs !== null && now < w.startMs) return false
  if (w.endMs !== null && now > w.endMs) return false
  return true
}
