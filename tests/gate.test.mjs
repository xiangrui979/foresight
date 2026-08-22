/**
 * Module 3 tests: permission + classify + gate.
 * All examples are fictional/generic; no real user data.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { canWrite, canSetBeta } = await import('../lib/govern/permission.js')
const { classifyByRules, extractDate, buildClassifyFn } = await import('../lib/gate/classify.js')
const { gateWrite, GATE_CLAUSES } = await import('../lib/gate/gate.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

// Minimal policy fixture — only fields the gate/classify paths read.
function makePolicy() {
  return {
    policy_version: POLICY_VERSION,
    permission: {
      root_writers: ['root', 'system'],
      agent_writable: ['memories'],
      beta_settable_by: ['root'],
      user_doc_writer: 'derive',
    },
    aspects: {
      gnomic: { storage: 'doc', injection: 'always', expiry: 'never', render_anchor: false, renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      progressive: { storage: 'memory', injection: 'conditional', expiry: 'anchor', render_anchor: true, renewable: true, default_ttl_days: 7, review_every_turns: 30, telicity: { values: ['bounded', 'unbounded'], unbounded_force_ttl: true } },
      perfect: { storage: 'memory', injection: 'conditional', expiry: 'never', render_anchor: 'short', renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      prospective: { storage: 'memory', injection: 'renewal', expiry: 'ttl', render_anchor: true, renewable: true, default_ttl_days: 30, review_every_turns: 30, modalities: { plan: { renew: true }, prediction: { renew: true } } },
    },
    gate: {
      allowed_categories: ['session_log', 'task_progress', 'environment', 'project_state', 'preference', 'rule'],
      forbidden_categories: ['guessing', 'speculation'],
      forbidden_progressive: ['project_state'],
      llm_model: 'test-model',
      fallback: 'rules',
    },
    activation: {
      beta: 0.5, beta_observe: 0.5, suppression_epsilon: 0.05, conflict_sim_threshold: 0.69,
      temporal_decay_enabled: false, half_life_days: 90,
      base_weights: { root: 1.0, agent: 0.85, derive: 0.7 },
    },
  }
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-gate-'))
  const s = openDatabase(path.join(dir, 'g.db'))
  return { s, store: new Store(s), dir }
}

// ── permission ─────────────────────────────────────────────────────────

test('permission: root writes anything, agent limited', () => {
  const p = makePolicy()
  assert.ok(canWrite('root', 'memories', p))
  assert.ok(canWrite('root', 'policy.yaml', p))
  assert.ok(canWrite('agent', 'memories', p))
  assert.ok(!canWrite('agent', 'policy.yaml', p)) // not in agent_writable
  assert.ok(!canWrite('agent', 'user_doc', p)) // only user_doc_writer
  assert.ok(canWrite('derive', 'user_doc', p))
})

test('permission: beta settable by configured actors only', () => {
  const p = makePolicy()
  assert.ok(canSetBeta('root', p))
  assert.ok(!canSetBeta('agent', p), 'beta only via Root')
  assert.ok(!canSetBeta('stranger', p))
})

// ── classify rules ─────────────────────────────────────────────────────

test('classify: done marker → perfect with point anchor', () => {
  const p = makePolicy()
  const r = classifyByRules(p, new Date('2026-07-01T00:00:00'), '用户完成了接口联调')
  assert.equal(r.aspect, 'perfect')
  assert.equal(r.anchor.type, 'point')
  assert.equal(r.source, 'rules')
})

test('classify: doing marker → progressive unbounded', () => {
  const p = makePolicy()
  const r = classifyByRules(p, new Date('2026-07-01T00:00:00'), '训练任务在跑')
  assert.equal(r.aspect, 'progressive')
  assert.equal(r.telicity, 'unbounded')
})

test('classify: 会 → prediction with extracted predict_by', () => {
  const p = makePolicy()
  const now = new Date('2026-07-01T00:00:00')
  const r = classifyByRules(p, now, '明天会下雨')
  assert.equal(r.aspect, 'prospective')
  assert.equal(r.modality, 'prediction')
  assert.equal(r.predictBy, '2026-07-02')
})

test('classify: 要 → intention, no predict_by', () => {
  const p = makePolicy()
  const r = classifyByRules(p, new Date('2026-07-01T00:00:00'), '用户要重构模块')
  assert.equal(r.aspect, 'prospective')
  assert.equal(r.modality, 'intention')
  assert.equal(r.predictBy, null)
})

test('classify: unmarked → gnomic', () => {
  const p = makePolicy()
  const r = classifyByRules(p, new Date('2026-07-01T00:00:00'), '用户称呼不区分助理')
  assert.equal(r.aspect, 'gnomic')
})

test('classify: done+doing mixed → null (decline)', () => {
  const p = makePolicy()
  const r = classifyByRules(p, new Date('2026-07-01T00:00:00'), '部署正在进行且已完成')
  assert.equal(r, null)
})

test('classify: LLM invalid json → falls back to rules', async () => {
  const p = makePolicy()
  const llm = { call: async () => ({ json: null }) }
  const fn = buildClassifyFn(p, llm)
  const r = await fn({ now: new Date('2026-07-01T00:00:00'), text: '任务在跑' })
  assert.equal(r.aspect, 'progressive')
  assert.equal(r.source, 'rules')
})

test('extractDate: ISO / 明天 / N天后 / 下周', () => {
  const now = new Date('2026-07-01T00:00:00')
  assert.equal(extractDate('2026-12-25 发布', now), '2026-12-25')
  assert.equal(extractDate('明天会下雨', now), '2026-07-02')
  assert.equal(extractDate('3天后到期', now), '2026-07-04')
  assert.equal(extractDate('后天截止', now), '2026-07-03')
})

// ── gate full path ─────────────────────────────────────────────────────

test('gate: empty text rejected with clause', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite({ text: '   ', source: 'agent' }, { policy: makePolicy(), store })
  assert.equal(r.ok, false)
  assert.equal(r.clause, GATE_CLAUSES.EMPTY)
  closeDatabase(s)
})

test('gate: gnomic rejected with suggestion to user route', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite({ text: '用户名字叫某名', source: 'agent' }, { policy: makePolicy(), store })
  assert.equal(r.ok, false)
  assert.equal(r.clause, GATE_CLAUSES.GNOMIC)
  assert.ok(r.suggestion.includes('user.md'))
  closeDatabase(s)
})

test('gate: permission deny for agent writing policy', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite(
    { text: '改配置', source: 'agent' },
    { policy: makePolicy(), store, permission: { actor: 'agent', target: 'policy.yaml' } },
  )
  assert.equal(r.ok, false)
  assert.equal(r.eventType, 'permission.deny')
  closeDatabase(s)
})

test('gate: perfect write succeeds, audit event emitted', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite(
    { text: '用户上周完成了接口联调', source: 'root', now: new Date('2026-07-01T00:00:00') },
    { policy: makePolicy(), store },
  )
  assert.equal(r.ok, true)
  assert.equal(r.memory.aspect, 'perfect')
  const ev = s.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type='memory.write'`).get()
  assert.equal(ev.c, 1)
  closeDatabase(s)
})

test('gate: aspect-text conflict (progressive text marked perfect) rejected', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite(
    { text: '部署已经在跑了', source: 'root' },
    { policy: makePolicy(), store, classifyFn: async () => ({
      category: null, aspect: 'perfect', anchor: { type: 'none' },
      telicity: null, modality: null, predictBy: null, text: '部署已经在跑了', source: 'rules' 
    }) },
  )
  assert.equal(r.ok, false)
  assert.equal(r.clause, GATE_CLAUSES.ASPECT_TEXT_CONFLICT)
  closeDatabase(s)
})

test('gate: prospective commitment rejected (not a fact)', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite(
    { text: '用户承诺每周汇报', source: 'root' },
    { policy: makePolicy(), store, classifyFn: async () => ({
      category: null, aspect: 'prospective', anchor: { type: 'open', start: '2026-07-01' },
      telicity: null, modality: 'commitment', predictBy: null, text: '用户承诺每周汇报', source: 'rules' 
    }) },
  )
  assert.equal(r.ok, false)
  assert.equal(r.clause, GATE_CLAUSES.COMMITMENT)
  closeDatabase(s)
})

test('gate: embed fn failure degrades to null, write still succeeds', async () => {
  const { s, store } = mkStore()
  const r = await gateWrite(
    { text: '用户上周完成了接口联调', source: 'root', now: new Date('2026-07-01T00:00:00') },
    { policy: makePolicy(), store, embedFn: async () => { throw new Error('embed down') } },
  )
  assert.equal(r.ok, true)
  assert.equal(r.memory.embedding, null)
  closeDatabase(s)
})
