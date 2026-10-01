/**
 * Lifecycle read-path contract tests (Task 1.1 / C1/C2/C7/C8/C10/C11).
 *
 * Time travel covers five classes: TTL expiry, renewal, prospective
 * verification, conflict suppression, and "not started yet".
 * Fictional data only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { ManualClock } = await import('../lib/clock.js')
const { progressiveWindow, expireCheck, renewalDue, lifecycleEligible } = await import('../lib/evolve/temporal.js')
const { temporalFactor } = await import('../lib/evolve/activation.js')
const { buildNudge, buildNudgeAsync } = await import('../lib/nudge/nudge.js')
const { renderMemories, renderSections } = await import('../lib/inject/render.js')
const { search } = await import('../lib/retrieve/search.js')
const { FakeEmbedProvider } = await import('../lib/store/embed.js')
const { ConflictResolver } = await import('../lib/evolve/conflict.js')
const { ForeSight } = await import('../lib/core.js')
const { extractDate, isoDateUTC } = await import('../lib/gate/classify.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

const DAY = 86_400_000

function makePolicy(beta = 0.5) {
  return {
    policy_version: POLICY_VERSION,
    permission: { root_writers: ['root'], agent_writable: ['memories'], beta_settable_by: ['root'], user_doc_writer: 'derive' },
    aspects: {
      gnomic: { storage: 'doc', injection: 'always', expiry: 'never', render_anchor: false, renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      progressive: { storage: 'memory', injection: 'conditional', expiry: 'anchor', render_anchor: true, renewable: true, default_ttl_days: 7, review_every_turns: 30, telicity: { values: ['bounded', 'unbounded'], unbounded_force_ttl: true } },
      perfect: { storage: 'memory', injection: 'conditional', expiry: 'never', render_anchor: 'always', renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      prospective: { storage: 'memory', injection: 'renewal', expiry: 'ttl', render_anchor: true, renewable: true, default_ttl_days: 30, review_every_turns: 30, modalities: { plan: { renew: true } } },
    },
    gate: { allowed_categories: [], forbidden_categories: [], forbidden_progressive: [], llm_model: 'x', fallback: 'rules' },
    activation: {
      beta, beta_observe: 0.05, suppression_epsilon: 0.01, conflict_sim_threshold: 0.6,
      temporal_decay_enabled: true, half_life_days: 90,
      base_weights: { root: 1.0, agent: 0.85, derive: 0.7 },
      support: { evidence_half_life_days: 60, margin: 1.2, aspect_direction_prior: 1.5 },
    },
    retrieval: { top_k: 20, min_score: 0.05, candidates: 50, factors: { embed: { enabled: true, weight: 0.4 }, time: { enabled: true, weight: 0.2 }, activation: { enabled: true, weight: 0.3 }, links: { enabled: true, weight: 0.15, spread_hops: 2, edge_decay: 0.5 } } },
    injection: { soul_section: 'fs:soul', user_section: 'fs:user', memories_section: 'fs:memories', user_budget_chars: 500 },
    nudge: { every_turns: 3, candidate_extraction: 'rules', candidate_max: 3, llm_model: 'x', render: 'dialog', review_temporal: true, review_conflicts: false, include_session_timeline: false, auto_resolve_prediction: false },
  }
}

function mkStore(clock = new ManualClock(0)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-life-'))
  const s = openDatabase(path.join(dir, 'l.db'))
  return { s, store: new Store(s, null, clock), dir }
}

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-life-root-'))
  const tpl = fs.readFileSync(new URL('../templates/policy.yaml.example', import.meta.url), 'utf8')
  fs.writeFileSync(path.join(dir, 'policy.yaml'), tpl)
  return dir
}

// ── TTL expiry via the wired read path (C1) ─────────────────────────

test('lifecycle: ForeSight.query sweeps TTL-expired progressive (C1)', async () => {
  const clock = new ManualClock(0)
  const root = mkRoot()
  const f = new ForeSight({
    memoryRoot: root,
    dbFile: 't.db',
    embedBaseUrl: 'http://127.0.0.1:1',
    llmBaseUrl: 'http://127.0.0.1:1',
    clock,
  })
  const m = f.store.insertMemory({ content: '训练任务在跑', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent' })
  const before = await f.query('训练任务', { topK: 5 })
  assert.ok(before.some((h) => h.id === m.id), 'active before expiry')

  clock.advanceDays(8)
  const after = await f.query('训练任务', { topK: 5 })
  assert.ok(!after.some((h) => h.id === m.id), 'expired progressive must not be retrieved')
  assert.equal(f.store.getMemory(m.id).status, 'expired', 'read path swept expired rows')
  f.close()
})

test('lifecycle: renderMemories excludes TTL-expired progressive (C1)', () => {
  const p = makePolicy()
  const clock = new ManualClock(0)
  const { s, store } = mkStore(clock)
  const m = store.insertMemory({ content: '训练在跑', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent' })
  assert.ok(renderMemories(store, p, new Date(0)).includes('训练在跑'))
  assert.equal(store.getMemory(m.id).status, 'active', 'not yet due at t=0')
  assert.equal(renderMemories(store, p, new Date(8 * DAY)), '')
  assert.equal(store.getMemory(m.id).status, 'expired', 'render swept expired rows')
  closeDatabase(s)
})

// ── not started yet (C10) ───────────────────────────────────────────

test('lifecycle: future-start progressive is not injected or retrieved (C10)', async () => {
  const p = makePolicy()
  const clock = new ManualClock(0)
  const { s, store } = mkStore(clock)
  const m = store.insertMemory({
    content: '下周开始的迭代',
    aspect: 'progressive',
    anchor: { type: 'interval', start: '1970-01-02', end: '1970-01-10' },
    source: 'agent',
  })
  assert.equal(lifecycleEligible(p, m, 0), false)
  assert.equal(renderMemories(store, p, new Date(0)), '')
  const hits = await search('迭代', store, new FakeEmbedProvider(768), p, 0, { topK: 5 })
  assert.equal(hits.length, 0, 'not-started must not be retrieved')
  assert.equal(store.getMemory(m.id).status, 'active', 'not-started is not expired — simply hidden')
  closeDatabase(s)
})

// ── point anchor TTL formula (C2/C11) ───────────────────────────────

test('lifecycle: point anchor TTL = anchor time + TTL days (C2)', () => {
  const p = makePolicy()
  const base = Date.parse('2026-01-01T00:00:00Z')
  const clock = new ManualClock(base)
  const { s, store } = mkStore(clock)
  const m = store.insertMemory({
    content: '报告撰写进行中',
    aspect: 'progressive',
    anchor: { type: 'point', start: '2026-01-01' },
    telicity: 'bounded',
    source: 'agent',
  })
  const w = progressiveWindow(p, m)
  assert.equal(w.startMs, base)
  assert.equal(w.endMs, base + 7 * DAY, 'C2: end = base + ttlDays, not base + createdAt + ttlDays')
  assert.equal(expireCheck(p, m, base + 8 * DAY), 'expired')
  assert.equal(lifecycleEligible(p, m, base + 8 * DAY), false)
  assert.equal(temporalFactor(p, m, base + 8 * DAY), 0, 'C11 regression: conflict/temporal input')
  closeDatabase(s)
})

// ── renewal detection unified with evolve/temporal (C2) ─────────────

test('lifecycle: point-anchor progressive near expiry triggers nudge (unified renewalDue)', () => {
  const p = makePolicy()
  const base = Date.parse('2026-01-01T00:00:00Z')
  const clock = new ManualClock(base)
  const { s, store } = mkStore(clock)
  const point = store.insertMemory({
    content: '报告撰写进行中',
    aspect: 'progressive',
    anchor: { type: 'point', start: '2026-01-01' },
    source: 'agent',
  })
  assert.equal(renewalDue(p, point, base + 6 * DAY), true, '1 day left → due')
  const r = buildNudge({ store, policy: p, now: base + 6 * DAY, turnCount: 3, sessionStartTs: base })
  assert.ok(r.reviewItems.some((i) => i.memoryId === point.id), 'point-anchor due item emitted (was dropped by duplicate impl)')
  closeDatabase(s)
})

test('lifecycle: renewal item + expiry handling share temporal contract', () => {
  const p = makePolicy()
  const base = Date.parse('2026-01-01T00:00:00Z')
  const clock = new ManualClock(base)
  const { s, store } = mkStore(clock)
  const running = store.insertMemory({ content: '训练在跑', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent' })
  const r = buildNudge({ store, policy: p, now: base + 6 * DAY, turnCount: 3, sessionStartTs: base })
  assert.ok(r.reviewItems.some((i) => i.type === 'renewal' && i.memoryId === running.id))
  // expired entries are already swept by the nudge check, never listed
  const r2 = buildNudge({ store, policy: p, now: base + 8 * DAY, turnCount: 3, sessionStartTs: base })
  assert.ok(!r2.reviewItems.some((i) => i.memoryId === running.id))
  closeDatabase(s)
})

// ── conflict suppression visible on read path (C1/C4) ───────────────

test('lifecycle: suppressed conflict loser is not retrieved/rendered', async () => {
  const p = makePolicy(0.9)
  const base = Date.parse('2026-01-01T00:00:00Z')
  const clock = new ManualClock(base)
  const { s, store } = mkStore(clock)
  const vA = new Float32Array(768).fill(0.1)
  const vB = new Float32Array(768).fill(0.11)
  const old = store.insertMemory({ content: '用户是大学生', aspect: 'perfect', anchor: { type: 'point', start: '2024-09-01' }, source: 'agent', embedding: vA })
  const fresh = store.insertMemory({ content: '用户是研究生', aspect: 'perfect', anchor: { type: 'point', start: '2026-09-01' }, source: 'agent', embedding: vB })
  const resolver = new ConflictResolver(p, store, () => true, clock)
  const res = await resolver.resolveOnWrite(fresh)
  assert.equal(res.conflicts.length, 1)
  const hits = await search('用户', store, new FakeEmbedProvider(768), p, base, { topK: 10 })
  assert.ok(!hits.some((h) => h.id === old.id), 'suppressed loser filtered structurally')
  closeDatabase(s)
})

// ── prospective verification with evidence channel (C7) ─────────────

function duePrediction(store) {
  return store.insertMemory({
    content: '预测：用户论文初稿将于 2026-08-20 完成',
    aspect: 'prospective',
    modality: 'prediction',
    anchor: { type: 'none' },
    source: 'agent',
    metadata: { predict_by: '2026-08-20' },
  })
}

test('lifecycle: verdictFor receives session evidence (C7)', async () => {
  const p = makePolicy()
  p.nudge.auto_resolve_prediction = true
  const base = Date.parse('2026-09-01T00:00:00Z')
  const clock = new ManualClock(base)
  const { s, store } = mkStore(clock)
  const m = duePrediction(store)
  store.insertConversation('s1', 'user', '论文初稿已经完成并提交给导师')
  const calls = []
  const llm = { call: async (req) => { calls.push(req); return { content: '', json: { verdict: 'fulfilled' } } } }
  await buildNudgeAsync({ store, policy: p, now: base, turnCount: 3, sessionStartTs: base - 1000, sessionId: 's1', llm })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].user.includes('论文初稿已经完成'), 'evidence injected into verdict prompt')
  assert.ok(calls[0].user.includes('证据'), 'prompt has evidence section')
  const after = store.getMemory(m.id)
  assert.equal(after.aspect, 'perfect')
  assert.equal(after.metadata.verdict, 'fulfilled')
  closeDatabase(s)
})

test('lifecycle: no evidence → conservative instruction; no LLM → uncertain (C7)', async () => {
  const p = makePolicy()
  p.nudge.auto_resolve_prediction = true
  const base = Date.parse('2026-09-01T00:00:00Z')
  const clock = new ManualClock(base)
  const { s, store } = mkStore(clock)
  const m = duePrediction(store)
  const calls = []
  const llm = { call: async (req) => { calls.push(req); return { content: '', json: { verdict: 'uncertain' } } } }
  await buildNudgeAsync({ store, policy: p, now: base, turnCount: 3, sessionStartTs: base - 1000, llm })
  assert.ok(calls[0].user.includes('无证据'), 'empty evidence marked explicitly')
  assert.ok(calls[0].system.includes('uncertain'), 'conservative rule present')
  assert.equal(store.getMemory(m.id).metadata.verdict, 'uncertain')

  const { s: s2, store: store2 } = mkStore(new ManualClock(base))
  const m2 = duePrediction(store2)
  await buildNudgeAsync({ store: store2, policy: p, now: base, turnCount: 3, sessionStartTs: base - 1000 })
  assert.equal(store2.getMemory(m2.id).metadata.verdict, 'uncertain')
  assert.equal(store2.getMemory(m2.id).status, 'active', 'never delete without evidence')
  closeDatabase(s)
  closeDatabase(s2)
})

// ── UTC date semantics (C8) ─────────────────────────────────────────

test('lifecycle: date extraction is UTC-stable across timezones (C8)', () => {
  const now = new Date('2026-10-01T20:00:00.000Z') // Asia/Shanghai wall time = Oct 2
  assert.equal(isoDateUTC(now), '2026-10-01')
  assert.equal(extractDate('明天交报告', now), '2026-10-02')
  assert.equal(extractDate('今天交报告', now), '2026-10-01')
  assert.equal(extractDate('下周一开会', now), '2026-10-05') // Thu Oct 1 UTC → next Mon
})
