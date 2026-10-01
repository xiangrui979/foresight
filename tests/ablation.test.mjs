/**
 * Ablation switches (Task 1.5): lifecycle.enabled / conflict_enabled /
 * gate.classifier — each walked through policy lookup, no scattered flags.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { ManualClock } = await import('../lib/clock.js')
const { sweepExpired, lifecycleEligible, expireCheck } = await import('../lib/evolve/temporal.js')
const { temporalFactor } = await import('../lib/evolve/activation.js')
const { renderMemories } = await import('../lib/inject/render.js')
const { ConflictResolver } = await import('../lib/evolve/conflict.js')
const { buildClassifyFn } = await import('../lib/gate/classify.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

const DAY = 86_400_000

function makePolicy() {
  return {
    policy_version: POLICY_VERSION,
    aspects: {
      gnomic: { storage: 'doc', injection: 'always', expiry: 'never', render_anchor: false, renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      progressive: { storage: 'memory', injection: 'conditional', expiry: 'anchor', render_anchor: true, renewable: true, default_ttl_days: 7, review_every_turns: 30 },
      perfect: { storage: 'memory', injection: 'conditional', expiry: 'never', render_anchor: 'short', renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      prospective: { storage: 'memory', injection: 'renewal', expiry: 'ttl', render_anchor: true, renewable: true, default_ttl_days: 30, review_every_turns: 30 },
    },
    gate: { allowed_categories: [], forbidden_categories: [], forbidden_progressive: [], llm_model: 'x', fallback: 'rules', classifier: 'rules' },
    activation: {
      beta: 0.9, beta_observe: 0.05, suppression_epsilon: 0.01, conflict_sim_threshold: 0.6,
      temporal_decay_enabled: true, half_life_days: 90, conflict_enabled: true,
      base_weights: { root: 1.0, agent: 0.85, derive: 0.7 },
      support: { evidence_half_life_days: 60, margin: 1.2, aspect_direction_prior: 1.5 },
    },
    retrieval: { top_k: 20, min_score: 0.05, candidates: 50, factors: { activation: { enabled: true, weight: 1 } } },
    injection: { soul_section: 's', user_section: 'u', memories_section: 'm', user_budget_chars: 500, memories_budget_tokens: 0 },
    lifecycle: { enabled: true },
  }
}

function mkStore(clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-ablate-'))
  const s = openDatabase(path.join(dir, 'a.db'))
  return { s, store: new Store(s, null, clock) }
}

test('ablation: lifecycle.enabled=false keeps expired progressive readable', () => {
  const p = makePolicy()
  p.lifecycle.enabled = false
  const clock = new ManualClock(0)
  const { s, store } = mkStore(clock)
  const m = store.insertMemory({ content: '训练在跑', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent' })
  const at = 8 * DAY
  assert.equal(expireCheck(p, m, at), 'active')
  assert.equal(lifecycleEligible(p, m, at), true)
  assert.equal(temporalFactor(p, m, at), 1)
  assert.deepEqual(sweepExpired(store, p, at), [], 'nolifecycle sweeps nothing')
  assert.ok(renderMemories(store, p, new Date(at)).includes('训练在跑'))
  assert.equal(store.getMemory(m.id).status, 'active', 'status untouched')
  closeDatabase(s)
})

test('ablation: conflict_enabled=false skips write conflict resolution', async () => {
  const p = makePolicy()
  p.activation.conflict_enabled = false
  const clock = new ManualClock(0)
  const { s, store } = mkStore(clock)
  const vA = new Float32Array(768).fill(0.1)
  const vB = new Float32Array(768).fill(0.11)
  const old = store.insertMemory({ content: '用户是大学生', aspect: 'perfect', anchor: { type: 'point', start: '2024-09-01' }, source: 'agent', embedding: vA })
  const fresh = store.insertMemory({ content: '用户是研究生', aspect: 'perfect', anchor: { type: 'point', start: '2026-09-01' }, source: 'agent', embedding: vB })
  const resolver = new ConflictResolver(p, store, () => true, clock)
  const res = await resolver.resolveOnWrite(fresh)
  assert.equal(res.checked, false)
  assert.equal(store.getMemory(old.id).status, 'active', 'no suppression when conflict-off')
  assert.equal(store.listLinksOf(fresh.id).length, 0, 'no contradicts edge')
  closeDatabase(s)
})

test("ablation: gate.classifier='rules' makes zero LLM calls", async () => {
  const p = makePolicy()
  let called = 0
  const llm = { call: async () => { called += 1; return { json: null } } }
  const fn = buildClassifyFn(p, llm)
  const r = await fn({ now: new Date('2026-07-01T00:00:00Z'), text: '训练任务在跑' })
  assert.equal(called, 0, 'rules classifier must not call the LLM')
  assert.equal(r.aspect, 'progressive')
  assert.equal(r.source, 'rules')
})

test("ablation: gate.classifier='llm' uses the classifier result", async () => {
  const p = makePolicy()
  p.gate.classifier = 'llm'
  const llm = {
    call: async () => ({
      json: { category: null, aspect: 'perfect', anchor: { type: 'point', start: '2026-07-01' }, telicity: null, modality: null, predict_by: null, text: '部署已完成' },
    }),
  }
  const fn = buildClassifyFn(p, llm)
  const r = await fn({ now: new Date('2026-07-01T00:00:00Z'), text: '部署已完成' })
  assert.equal(r.aspect, 'perfect')
  assert.equal(r.source, 'llm')
})
