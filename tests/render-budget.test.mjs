/**
 * Unified budget renderer (Task 1.5 / H3 + D17): greedy inclusion with the
 * frozen counter; plugin-side renderMemories honors the same budget.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { ManualClock } = await import('../lib/clock.js')
const { renderMemories } = await import('../lib/inject/render.js')
const { renderWithinBudget } = await import('../eval/lib/render-budget.mjs')
const { estimateTokens } = await import('../eval/lib/tokens.mjs')
const { POLICY_VERSION } = await import('../lib/defaults.js')

function makePolicy() {
  return {
    policy_version: POLICY_VERSION,
    aspects: {
      gnomic: { storage: 'doc', injection: 'always', expiry: 'never', render_anchor: false, renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      progressive: { storage: 'memory', injection: 'conditional', expiry: 'anchor', render_anchor: true, renewable: true, default_ttl_days: 7, review_every_turns: 30 },
      perfect: { storage: 'memory', injection: 'conditional', expiry: 'never', render_anchor: 'short', renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      prospective: { storage: 'memory', injection: 'renewal', expiry: 'ttl', render_anchor: true, renewable: true, default_ttl_days: 30, review_every_turns: 30 },
    },
    activation: { beta: 0.5, beta_observe: 0.05, suppression_epsilon: 0.01, conflict_sim_threshold: 0.6, temporal_decay_enabled: true, half_life_days: 90, base_weights: { agent: 0.85 } },
    retrieval: { top_k: 20, min_score: 0.05, candidates: 50, factors: {} },
    injection: { soul_section: 's', user_section: 'u', memories_section: 'm', user_budget_chars: 100, memories_budget_tokens: 0 },
    lifecycle: { enabled: true },
  }
}

function mkStore(clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-budget-'))
  const s = openDatabase(path.join(dir, 'b.db'))
  return { s, store: new Store(s, null, clock) }
}

test('render-budget: greedy, skip oversized, unlimited when budget=0', () => {
  const items = [{ text: 'aaa' }, { text: 'bbbbbbbb' }, { text: 'cc' }]
  const count = (s) => s.length
  const r1 = renderWithinBudget(items, 7, count)
  assert.deepEqual(r1.included.map((i) => i.text), ['aaa', 'cc'])
  assert.deepEqual(r1.excluded.map((i) => i.text), ['bbbbbbbb'])
  assert.equal(r1.tokens, 5)
  const r0 = renderWithinBudget(items, 0, count)
  assert.equal(r0.included.length, 3)
  assert.equal(r0.excluded.length, 0)
})

test('render-budget: renderMemories honors policy.injection.memories_budget_tokens', () => {
  const p = makePolicy()
  p.injection.memories_budget_tokens = 8
  const clock = new ManualClock(0)
  const { s, store } = mkStore(clock)
  store.insertMemory({ content: '训练在跑', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent' })
  clock.advanceMs(1000)
  store.insertMemory({ content: '服务器在维护', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent' })
  const counter = (t) => [...t].length
  const text = renderMemories(store, p, new Date(1000), { countTokens: counter })
  assert.equal(text, '训练在跑', 'second line skipped (4+6 > 8)')
  const unlimited = renderMemories(store, p, new Date(1000), { budgetTokens: 0, countTokens: counter })
  assert.ok(unlimited.includes('服务器在维护'))
  closeDatabase(s)
})

test('render-budget: eval counter is the shared estimator (estimate@v1 fallback)', () => {
  assert.equal(typeof estimateTokens('训练任务在跑'), 'number')
  assert.ok(estimateTokens('训练任务在跑') >= 6)
  assert.equal(estimateTokens(''), 0)
})
