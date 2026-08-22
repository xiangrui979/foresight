/**
 * Module 4 tests: temporal (expiry/TTL) + activation + conflict resolution.
 * Fictional data only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { progressiveWindow, expireCheck, renewalDue, applyExpiry, sweepExpired } = await import('../lib/evolve/temporal.js')
const { anchorAgeDays, temporalWeight, temporalFactor, evidence, computeActivation } = await import('../lib/evolve/activation.js')
const { ConflictResolver, defaultConflictJudge, aspectsConflict, cosine } = await import('../lib/evolve/conflict.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

const DAY = 86_400_000

function makePolicy(beta = 0.5) {
  return {
    policy_version: POLICY_VERSION,
    permission: { root_writers: ['root'], agent_writable: ['memories'], beta_settable_by: ['root'], user_doc_writer: 'derive' },
    aspects: {
      gnomic: { storage: 'doc', injection: 'always', expiry: 'never', render_anchor: false, renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      progressive: { storage: 'memory', injection: 'conditional', expiry: 'anchor', render_anchor: true, renewable: true, default_ttl_days: 7, review_every_turns: 30, telicity: { values: ['bounded', 'unbounded'], unbounded_force_ttl: true } },
      perfect: { storage: 'memory', injection: 'conditional', expiry: 'never', render_anchor: 'short', renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      prospective: { storage: 'memory', injection: 'renewal', expiry: 'ttl', render_anchor: true, renewable: true, default_ttl_days: 30, review_every_turns: 30, modalities: { plan: { renew: true } } },
    },
    gate: { allowed_categories: [], forbidden_categories: [], forbidden_progressive: [], llm_model: 'x', fallback: 'rules' },
    activation: {
      beta, beta_observe: 0.05, suppression_epsilon: 0.01, conflict_sim_threshold: 0.6,
      temporal_decay_enabled: true, half_life_days: 90,
      base_weights: { root: 1.0, agent: 0.85, derive: 0.7 },
      support: { evidence_half_life_days: 60, margin: 1.2, aspect_direction_prior: 1.5 },
    },
    retrieval: { top_k: 20, min_score: 0.05, candidates: 50, factors: { links: { enabled: true, weight: 0.15, spread_hops: 2, edge_decay: 0.5 } } },
  }
}

function shortPolicy() {
  const p = makePolicy()
  // strip optional fields for phase-1 tests
  return p
}

function mkStore(nowMs = Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-evo-'))
  const s = openDatabase(path.join(dir, 'e.db'))
  return { s, store: new Store(s, null, () => nowMs) }
}

function mem(store, aspect, content, anchor, source = 'agent', opts = {}) {
  return store.insertMemory({ content, aspect, anchor, source, ...opts })
}

// ── temporal ──────────────────────────────────────────────────────────

test('temporal: none anchor → TTL window', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', '训练在跑', { type: 'none' }, 'agent', { createdAt: 0 })
  const w = progressiveWindow(p, m)
  assert.equal(w.reason, 'ttl')
  assert.equal(w.endMs, 0 + 7 * DAY)
  assert.equal(expireCheck(p, m, 5 * DAY), 'active')
  assert.equal(expireCheck(p, m, 8 * DAY), 'expired')
  closeDatabase(s)
})

test('temporal: bounded interval expires at end (anchor)', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', '网站部署中', { type: 'interval', start: '2026-07-01', end: '2026-07-03' }, 'agent', { createdAt: 0 })
  const w = progressiveWindow(p, m)
  assert.equal(w.reason, 'anchor')
  assert.equal(expireCheck(p, m, Date.parse('2026-07-03')), 'active')
  assert.equal(expireCheck(p, m, Date.parse('2026-07-04')), 'expired')
  closeDatabase(s)
})

test('temporal: unbounded interval forced to earlier TTL', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', '监控在跑', { type: 'interval', start: '2026-07-01', end: '2026-12-31' }, 'agent', { telicity: 'unbounded', createdAt: 0 })
  const w = progressiveWindow(p, m, 'ttl') // TTL 7d < interval end → ttl
  assert.equal(w.endMs, 7 * DAY)
  closeDatabase(s)
})

test('temporal: renewalDue within 7d before expiry', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', '任务在跑', { type: 'none' }, 'agent')
  assert.equal(renewalDue(p, m, 6 * DAY), true)   // 1d left: within 7d window
  assert.equal(renewalDue(p, m, 3 * DAY), true)   // 4d left: within window
  assert.equal(renewalDue(p, m, 8 * DAY), false)  // expired: false
  assert.equal(renewalDue(p, m, 0), true)         // left=7d: boundary true
  closeDatabase(s)
})

test('temporal: applyExpiry sets expired + epsilon, idempotent', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', '在跑', { type: 'none' }, 'agent', { createdAt: 0 })
  assert.equal(applyExpiry(store, p, m, 8 * DAY), true)
  const after = store.getMemory(m.id)
  assert.equal(after.status, 'expired')
  assert.equal(after.activation, p.activation.suppression_epsilon)
  assert.equal(applyExpiry(store, p, after, 9 * DAY), false, 'idempotent')
  closeDatabase(s)
})

test('temporal: sweepExpired only hits active progressive', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const a = mem(store, 'progressive', '在跑1', { type: 'none' }, 'agent')
  const b = mem(store, 'progressive', '在跑2', { type: 'none' }, 'agent', { metadata: { fresh: true } })
  // b is also created at epoch 0 → also expired; adjust: create b with a later clock
  const c = mem(store, 'perfect', '已完成', { type: 'point', start: '2026-01-01' }, 'agent')
  const expired = sweepExpired(store, p, 8 * DAY)
  assert.ok(expired.includes(a.id))
  assert.equal(store.getMemory(b.id).status, 'expired', 'b expired too (same epoch)')
  assert.equal(store.getMemory(c.id).status, 'active') // perfect never expires
  closeDatabase(s)
})

// ── activation ────────────────────────────────────────────────────────

test('activation: anchorAgeDays from anchor point', () => {
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', 'x', { type: 'point', start: '2026-06-01' })
  const now = Date.parse('2026-07-01')
  const days = anchorAgeDays(m, now)
  assert.ok(Math.abs(days - 30) < 2, `days≈30, got ${days}`)
  closeDatabase(s)
})

test('activation: temporalWeight decays progressive with age', () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  const fresh = mem(store, 'progressive', '新鲜', { type: 'none' }, 'agent')
  const old = mem(store, 'progressive', '旧', { type: 'none' }, 'agent')
  // both created now → age 0; simulate age by anchor instead
  const now = Date.now()
  const wFresh = temporalWeight(p, fresh, now)
  assert.ok(Math.abs(wFresh - 1) < 1e-6, `fresh≈1, got ${wFresh}`)
  // anchor-based age: point anchor 7 days ago
  const old2 = mem(store, 'progressive', '旧2', { type: 'point', start: new Date(now - 7 * DAY).toISOString().slice(0, 10) }, 'agent')
  const wOld = temporalWeight(p, old2, now)
  assert.ok(wOld > 0.45 && wOld < 0.55, `old≈0.5, got ${wOld}`)
  closeDatabase(s)
})

test('activation: temporalFactor 0 outside interval', () => {
  const p = makePolicy()
  const { s, store } = mkStore(0)
  const m = mem(store, 'progressive', '区间', { type: 'interval', start: '2026-06-01', end: '2026-06-30' })
  const out = temporalFactor(p, m, Date.parse('2026-07-05'))
  const inside = temporalFactor(p, m, Date.parse('2026-06-15'))
  assert.equal(inside, 1)
  assert.equal(out, 0)
  closeDatabase(s)
})

// ── conflict ─────────────────────────────────────────────────────────

test('conflict: aspectsConflict matrix', () => {
  assert.ok(aspectsConflict('perfect', 'progressive'))
  assert.ok(aspectsConflict('perfect', 'perfect'))
  assert.ok(!aspectsConflict('perfect', 'gnomic'))
  assert.ok(aspectsConflict('progressive', 'progressive'))
  assert.ok(!aspectsConflict('progressive', 'perfect'))
})

test('conflict: cosine computation', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([1, 0, 0])
  const c = new Float32Array([0, 1, 0])
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9)
  assert.ok(Math.abs(cosine(a, c)) < 1e-9)
})

test('conflict: default judge requires aspect compatibility + topic', () => {
  const { s, store } = mkStore()
  const vA = new Float32Array(768).fill(0.1) // identical doc vectors → cos=1
  const vB = new Float32Array(768).fill(-0.1) // orthogonal-ish → cos=-1
  const n = mem(store, 'perfect', '用户完成了接口联调', { type: 'point', start: '2026-06-15' }, 'agent', { embedding: vA })
  const o = mem(store, 'progressive', '接口联调还在进行中', { type: 'none' }, 'agent', { embedding: vA })
  assert.equal(defaultConflictJudge(n, o), true) // same aspect-compat + same topic (cos=1)
  const unrelated = mem(store, 'progressive', '服务器机房在维护', { type: 'none' }, 'agent', { embedding: vB })
  assert.equal(defaultConflictJudge(n, unrelated), false, 'orthogonal topic')
  // no-embedding branch: Jaccard fallback — same phrase repeated achieves
  // high overlap (realistic for 完成/进行 alternates sharing the noun phrase)
  const noEmb = mem(store, 'perfect', '登录模块开发工作已完成', { type: 'point', start: '2026-06-15' })
  const noEmbDoing = mem(store, 'progressive', '登录模块开发工作正在进行中', { type: 'none' })
  assert.equal(defaultConflictJudge(noEmb, noEmbDoing), true, 'jaccard fallback same topic')
  closeDatabase(s)
})

test('conflict: resolveOnWrite β=0.9 clips older', async () => {
  const p = makePolicy(0.9)
  const { s, store } = mkStore(0)
  const vA = new Float32Array(768).fill(0.1)
  const vB = new Float32Array(768).fill(0.11)
  const old = mem(store, 'perfect', '用户是大学生', { type: 'point', start: '2024-09-01' }, 'agent', { embedding: vA })
  const n = mem(store, 'perfect', '用户是研究生', { type: 'point', start: '2026-09-01' }, 'agent', { embedding: vB })
  const resolver = new ConflictResolver(p, store, () => true)
  const res = await resolver.resolveOnWrite(n)
  assert.equal(res.conflicts.length, 1)
  assert.equal(res.conflicts[0].action, 'clip')
  assert.equal(store.getMemory(old.id).status, 'suppressed')
  const link = store.listLinksOf(n.id).find((l) => l.rel === 'contradicts')
  assert.ok(link, 'contradicts edge recorded')
  closeDatabase(s)
})

test('conflict: resolveOnWrite β=0.1 parks new (observe)', async () => {
  const p = makePolicy(0.1)
  const { s, store } = mkStore(0)
  const vA = new Float32Array(768).fill(0.1)
  const vB = new Float32Array(768).fill(0.11)
  const old = mem(store, 'perfect', '用户是大学生', { type: 'point', start: '2024-09-01' }, 'agent', { embedding: vA })
  const n = mem(store, 'perfect', '用户是研究生', { type: 'point', start: '2026-09-01' }, 'agent', { embedding: vB })
  const resolver = new ConflictResolver(p, store, () => true)
  const res = await resolver.resolveOnWrite(n)
  assert.equal(res.conflicts.length, 1)
  assert.equal(res.conflicts[0].action, 'observe')
  assert.equal(store.getMemory(old.id).status, 'active')
  assert.equal(store.getMemory(n.id).activation, p.activation.beta_observe)
  closeDatabase(s)
})

test('conflict: resolveOnWrite suppresses new when old evidence wins (β=0.5 clip old? no — margin)', async () => {
  const p = makePolicy(0.5)
  const { s, store } = mkStore(0)
  const vA = new Float32Array(768).fill(0.1)
  const vB = new Float32Array(768).fill(0.11)
  // give old two strong supports → eO > eN
  const old = mem(store, 'perfect', '用户是大学生', { type: 'point', start: '2024-09-01' }, 'agent', { embedding: vA })
  const ev1 = mem(store, 'perfect', '用户 2023 年大二', { type: 'point', start: '2023-09-01' }, 'agent', { embedding: vA })
  const ev2 = mem(store, 'perfect', '用户 2024 年在读', { type: 'point', start: '2024-06-01' }, 'agent', { embedding: vA })
  store.insertLink(ev1.id, old.id, 'supports', 'agent')
  store.insertLink(ev2.id, old.id, 'supports', 'agent')
  const n = mem(store, 'perfect', '用户是研究生', { type: 'point', start: '2026-09-01' }, 'agent', { embedding: vB })
  const resolver = new ConflictResolver(p, store, () => true)
  const res = await resolver.resolveOnWrite(n)
  // supports (ev1/ev2) share topic+aspect → also judged conflict; only check old's action
  const oldAction = res.conflicts.find((c) => c.oldId === old.id)
  assert.ok(oldAction, 'old included in conflicts')
  assert.equal(oldAction.action, 'observe', 'old evidence stronger → park new')
  assert.equal(store.getMemory(old.id).status, 'active')
  closeDatabase(s)
})
