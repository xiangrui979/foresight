/**
 * Module 1 tests: schema + store.
 * Runs against a temp database; all data is fictional.
 * Command: npm test (node --test tests/)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openDatabase, closeDatabase } from '../lib/schema.js'
import { Store } from '../lib/store.js'

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-test-'))
  return path.join(dir, 'test.db')
}

test('schema: open creates tables and stays idempotent', () => {
  const p = tmpDbPath()
  const s1 = openDatabase(p)
  const tables = s1.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name`).all()
  const names = tables.map((t) => t.name)
  for (const expected of ['memories', 'links', 'conversations', 'events', 'conversations_fts', 'conversations_fts_zh', 'memories_vec']) {
    assert.ok(names.includes(expected), `table ${expected} present`)
  }
  // idempotent reopen
  closeDatabase(s1)
  const s2 = openDatabase(p)
  const v = s2.db.prepare('PRAGMA user_version').get().user_version
  assert.equal(v, 1)
  closeDatabase(s2)
})

test('store: insert + get roundtrip with anchor json', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  const m = store.insertMemory({
    content: 'Alice started project X on 2024-09-01',
    aspect: 'perfect',
    anchor: { type: 'point', start: '2024-09-01' },
    source: 'agent',
    metadata: { migrated: 'test' },
  })
  assert.ok(m.id.length > 0)
  const got = store.getMemory(m.id)
  assert.equal(got.content, 'Alice started project X on 2024-09-01')
  assert.equal(got.aspect, 'perfect')
  assert.deepEqual(got.anchor, { type: 'point', start: '2024-09-01' })
  assert.equal(got.status, 'active')
  closeDatabase(s)
})

test('store: update patches fields and refreshes updated_at', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  const m = store.insertMemory({ content: 'beta default', aspect: 'gnomic', anchor: { type: 'none' }, source: 'root' })
  const before = m.updatedAt
  const u = store.updateMemory(m.id, { activation: 0.42, status: 'suppressed' })
  assert.ok(u)
  assert.equal(u.activation, 0.42)
  assert.equal(u.status, 'suppressed')
  assert.ok(u.updatedAt >= before)
  closeDatabase(s)
})

test('store: soft delete keeps row, removes vector', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  const m = store.insertMemory({
    content: 'to be deleted', aspect: 'progressive', anchor: { type: 'none' },
    source: 'agent', embedding: new Float32Array(768).fill(0.1),
  })
  assert.ok(store.softDelete(m.id))
  const got = store.getMemory(m.id)
  assert.equal(got.status, 'deleted')
  const vec = s.db.prepare(`SELECT COUNT(*) AS c FROM memories_vec WHERE id = ?`).get(m.id)
  assert.equal(vec.c, 0)
  // second delete is a no-op
  assert.equal(store.softDelete(m.id), false)
  closeDatabase(s)
})

test('store: vector neighbors return cosine-sorted ids', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  const v1 = new Float32Array(768).fill(0.1)
  const v2 = new Float32Array(768).fill(0.2) // same direction, larger norm → closer
  const a = store.insertMemory({ content: 'A', aspect: 'perfect', anchor: { type: 'none' }, source: 'agent', embedding: v1 })
  const b = store.insertMemory({ content: 'B', aspect: 'perfect', anchor: { type: 'none' }, source: 'agent', embedding: v2 })
  const nb = store.vectorNeighbors(v2, 2)
  assert.equal(nb.length, 2)
  assert.equal(nb[0].id, b.id, 'self-similar first (distance 0)')
  assert.ok(nb.some((n) => n.id === a.id))
  closeDatabase(s)
})

test('store: setEmbedding replaces existing vector', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  const v0 = new Float32Array(768).fill(0.0)
  const m = store.insertMemory({ content: 'no vec', aspect: 'progressive', anchor: { type: 'none' }, source: 'agent', embedding: v0 })
  const v1 = new Float32Array(768).fill(0.5)
  assert.equal(store.setEmbedding(m.id, v1), true)
  const got = store.getMemory(m.id)
  assert.ok(got.embedding)
  const rows = s.db.prepare(`SELECT COUNT(*) AS c FROM memories_vec WHERE id = ?`).get(m.id)
  assert.equal(rows.c, 1, 'delete-then-insert keeps exactly one vector row')
  closeDatabase(s)
})

test('store: links connect memories in both directions', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  const a = store.insertMemory({ content: 'fact 1', aspect: 'perfect', anchor: { type: 'point', start: '2024-01-01' }, source: 'agent' })
  const b = store.insertMemory({ content: 'fact 2', aspect: 'perfect', anchor: { type: 'point', start: '2024-06-01' }, source: 'agent' })
  store.insertLink(a.id, b.id, 'supports', 'agent')
  const ofA = store.listLinksOf(a.id)
  assert.equal(ofA.length, 1)
  assert.equal(ofA[0].rel, 'supports')
  closeDatabase(s)
})

test('store: conversations FTS search CJK + Latin + short fallback', () => {
  const s = openDatabase(tmpDbPath())
  const store = new Store(s)
  store.insertConversation('sess-1', 'user', 'Alice 提到她本周会提交论文')
  store.insertConversation('sess-1', 'user', 'Bob prefers concise commands')
  // CJK trigram path
  const zh = store.searchConversations('论文', 10)
  assert.ok(zh.some((r) => r.content.includes('论文')))
  // Latin FTS path
  const en = store.searchConversations('concise', 10)
  assert.ok(en.some((r) => r.content.includes('concise')))
  // short query LIKE fallback
  const like = store.searchConversations('A', 10)
  assert.ok(like.length >= 1)
  // since-filter
  const since = store.listConversationsSince('sess-1', Date.now() - 1000)
  assert.equal(since.length, 2)
  closeDatabase(s)
})

test('store: events write to table and JSONL best-effort', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-test-'))
  const logPath = path.join(dir, 'audit.log')
  const s = openDatabase(path.join(dir, 'e.db'))
  const store = new Store(s, logPath)
  store.emit('memory.write', 'm1', { aspect: 'perfect' }, '1.1')
  const rows = s.db.prepare(`SELECT COUNT(*) AS c FROM events`).get()
  assert.equal(rows.c, 1)
  const log = fs.readFileSync(logPath, 'utf8')
  assert.ok(log.includes('memory.write'))
  closeDatabase(s)
})
