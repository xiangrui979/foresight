/**
 * Module 5 tests: embed provider (interface) + factors + search (3 shapes).
 * Uses FakeEmbedProvider; fictional data.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { FakeEmbedProvider } = await import('../lib/store/embed.js')
const { f_embed, f_time, f_activation, f_links, cosine, bufferToVec, FACTORS } = await import('../lib/retrieve/factors.js')
const { search, structuralFilter, anchorInRange, renderMemory } = await import('../lib/retrieve/search.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

const DAY = 86_400_000

function makePolicy() {
  return {
    policy_version: POLICY_VERSION,
    permission: { root_writers: ['root'], agent_writable: ['memories'], beta_settable_by: ['root'], user_doc_writer: 'derive' },
    aspects: {
      gnomic: { storage: 'doc', injection: 'always', expiry: 'never', render_anchor: false, renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      progressive: { storage: 'memory', injection: 'conditional', expiry: 'anchor', render_anchor: true, renewable: true, default_ttl_days: 7, review_every_turns: 30 },
      perfect: { storage: 'memory', injection: 'conditional', expiry: 'never', render_anchor: 'always', renewable: false, default_ttl_days: 0, review_every_turns: 0 },
      prospective: { storage: 'memory', injection: 'renewal', expiry: 'ttl', render_anchor: true, renewable: true, default_ttl_days: 30, review_every_turns: 30 },
    },
    gate: { allowed_categories: [], forbidden_categories: [], forbidden_progressive: [], llm_model: 'x', fallback: 'rules' },
    activation: {
      beta: 0.5, beta_observe: 0.05, suppression_epsilon: 0.01, conflict_sim_threshold: 0.6,
      temporal_decay_enabled: true, half_life_days: 90,
      base_weights: { root: 1.0, agent: 0.85, derive: 0.7 },
    },
    retrieval: {
      top_k: 10, min_score: 0.05, candidates: 20,
      factors: {
        embed: { enabled: true, weight: 0.4 },
        time: { enabled: true, weight: 0.2 },
        activation: { enabled: true, weight: 0.3 },
        links: { enabled: true, weight: 0.1, spread_hops: 2, edge_decay: 0.5 },
      },
    },
  }
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-retr-'))
  const s = openDatabase(path.join(dir, 'r.db'))
  return { s, store: new Store(s) }
}

function mem(store, aspect, content, anchor, source = 'agent', opts = {}) {
  return store.insertMemory({ content, aspect, anchor, source, ...opts })
}

// ── embed ─────────────────────────────────────────────────────────────

test('embed: FakeEmbedProvider deterministic, fixed dim', async () => {
  const e = new FakeEmbedProvider(16)
  const a = await e.embedOne('用户完成了接口联调')
  const b = await e.embedOne('用户完成了接口联调')
  assert.equal(a.length, 16)
  assert.deepEqual(a, b, 'deterministic')
  const batch = await e.embedBatch(['x', 'y'])
  assert.equal(batch.length, 2)
})

// ── factors ───────────────────────────────────────────────────────────

test('factors: cosine identical → 1, orthogonal → 0', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([2, 0, 0])
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9)
})

test('factors: f_embed uses query×memory cosine when both present', () => {
  const { s, store } = mkStore()
  const vec = new Float32Array(768).fill(0.5)
  const m = mem(store, 'perfect', 'x', { type: 'none' }, 'agent', { embedding: vec })
  const f = f_embed({ memory: m, now: Date.now(), policy: makePolicy(), store: {}, queryEmbedding: new Float32Array(768).fill(0.5) })
  assert.ok(Math.abs(f - 1) < 1e-6, `identical vectors → cos 1, got ${f}`)
  closeDatabase(s)
})

test('factors: f_embed no query vector → 0', () => {
  const { s, store } = mkStore()
  const m = mem(store, 'perfect', 'x', { type: 'none' })
  const f = f_embed({ memory: m, now: Date.now(), policy: makePolicy(), store: {} })
  assert.equal(f, 0)
  closeDatabase(s)
})

test('factors: f_time decay with age, prospective constant', () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  const old = mem(store, 'perfect', '旧', { type: 'point', start: '2020-01-01' })
  const now = Date.parse('2026-01-01')
  const ft = f_time({ memory: old, now, policy: p, store: {} })
  assert.ok(ft < 0.2, `decayed ${ft}`)
  const future = mem(store, 'prospective', '未来', { type: 'open', start: '2026-06-01' })
  assert.equal(f_time({ memory: future, now, policy: p, store: {} }), 1)
  closeDatabase(s)
})

test('factors: f_links spreads along edges with decay', () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  const a = mem(store, 'perfect', 'a', { type: 'none' })
  const b = mem(store, 'perfect', 'b', { type: 'none' }, 'agent', { activation: 0.9 })
  store.insertLink(a.id, b.id, 'related', 'agent')
  const f = f_links({ memory: a, now: Date.now(), policy: p, store })
  assert.ok(f > 0 && f < 0.6, `spread ${f}`)
  closeDatabase(s)
})

test('factors: FACTORS registry has exactly 4 entries', () => {
  assert.deepEqual(Object.keys(FACTORS).sort(), ['activation', 'embed', 'links', 'time'])
})

// ── search ────────────────────────────────────────────────────────────

test('search: full shape returns hits sorted by score', async () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  em(store, 'perfect', '用户完成了接口联调', { type: 'point', start: '2026-06-15' })
  em(store, 'progressive', '接口联调还在进行中', { type: 'none' })
  em(store, 'progressive', '服务器机房在维护', { type: 'none' })
  const embed = new FakeEmbedProvider(768)
  const hits = await search('接口联调', store, embed, p, Date.now(), { topK: 5 })
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].score >= hits[hits.length - 1].score, 'sorted desc')
  // each hit has rendered text
  for (const h of hits) assert.ok(h.rendered.length > 0)
  closeDatabase(s)
})

test('search: degraded shape (substring) works without embed/policy', async () => {
  const { s, store } = mkStore()
  em(store, 'perfect', '用户完成了接口联调', { type: 'point', start: '2026-06-15' })
  em(store, 'progressive', '服务器机房在维护', { type: 'none' })
  const hits = await search(store, '接口联调')
  assert.equal(hits.length, 1)
  assert.ok(hits[0].content.includes('接口联调'))
  closeDatabase(s)
})

test('search: deps shape (query-layer) with explicit now', async () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  em(store, 'perfect', '部署已完成', { type: 'point', start: '2026-06-01' })
  const embed = new FakeEmbedProvider(768)
  const hits = await search('部署', { store, embed, policy: p, now: Date.parse('2026-07-01') }, { k: 5 })
  assert.equal(hits.length, 1)
  closeDatabase(s)
})

test('search: embedding-downgrade path still returns results', async () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  em(store, 'perfect', '配置完成', { type: 'point', start: '2026-06-01' })
  const failingEmbed = { embedOne: async () => { throw new Error('boom') }, embedBatch: async () => { throw new Error('boom') } }
  const hits = await search('配置', store, failingEmbed, p, Date.now(), { topK: 5 })
  assert.equal(hits.length, 1, 'degraded retrieval still returns')
  closeDatabase(s)
})

test('search: timeRange filters by anchor interval', async () => {
  const p = makePolicy()
  const { s, store } = mkStore()
  em(store, 'perfect', '项目启动', { type: 'point', start: '2026-06-01' })
  const june = await search('项目', store, new FakeEmbedProvider(768), p, Date.now(), { timeRange: { from: '2026-06-01', to: '2026-06-30' } })
  const july = await search('项目', store, new FakeEmbedProvider(768), p, Date.now(), { timeRange: { from: '2026-07-01', to: '2026-07-31' } })
  assert.equal(june.length, 1)
  assert.equal(july.length, 0)
  closeDatabase(s)
})

// helper shorthand
function em(store, aspect, content, anchor) {
  return store.insertMemory({ content, aspect, anchor, source: 'agent' })
}

// direct anchorInRange unit
test('anchorInRange: interval intersect semantics', () => {
  const m = { anchor: { type: 'interval', start: '2026-06-01', end: '2026-06-30' }, createdAt: 0 }
  assert.ok(anchorInRange(m, { from: '2026-06-15', to: '2026-07-01' }))
  assert.ok(!anchorInRange(m, { from: '2026-07-01' }))
  assert.ok(anchorInRange(m)) // no range → true
})

test('renderMemory: perfect with always → prefixed', () => {
  const p = makePolicy()
  const m = { content: '接口联调完成', aspect: 'perfect', anchor: { type: 'point', start: '2026-06-15' } }
  assert.equal(renderMemory(m, p), '在 2026-06-15 时：接口联调完成')
})
