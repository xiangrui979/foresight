/**
 * Spike: node:sqlite + sqlite-vec viability for the ForeSight storage layer.
 *
 * Run under both runtimes:
 *   node scripts/spike-node-sqlite.mjs
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/spike-node-sqlite.mjs
 *
 * Works on a COPY of the given database file; never touches the original.
 *
 * Usage: node scripts/spike-node-sqlite.mjs <path-to-existing.db>
 */
import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const SRC = process.argv[2]
if (!SRC) {
  console.error('usage: node scripts/spike-node-sqlite.mjs <path-to-existing.db>')
  process.exit(2)
}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-spike-'))
fs.mkdirSync(WORK, { recursive: true })
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, path.join(WORK, 'spike.db' + ext))
}
const dbPath = path.join(WORK, 'spike.db')

const results = []
const check = (name, fn) => {
  try {
    const v = fn()
    results.push(['PASS', name, v === undefined ? '' : String(v)])
  } catch (e) {
    results.push(['FAIL', name, String((e && e.message) || e).slice(0, 180)])
  }
}

console.log('runtime:', JSON.stringify({ node: process.versions.node, electron: process.versions.electron, modules: process.versions.modules }))

let db
check('open with allowExtension', () => {
  db = new DatabaseSync(dbPath, { allowExtension: true })
  return 'opened'
})
check('enableLoadExtension(true)', () => { db.enableLoadExtension(true); return 'ok' })
check('loadExtension(sqlite-vec)', () => { db.loadExtension(sqliteVec.getLoadablePath()); return sqliteVec.getLoadablePath() })
check('sqlite_version', () => db.prepare('select sqlite_version() as v').get().v)
check('vec_version', () => db.prepare('select vec_version() as v').get().v)
check('journal_mode', () => JSON.stringify(db.prepare('pragma journal_mode').get()))
check('foreign_keys', () => JSON.stringify(db.prepare('pragma foreign_keys').get()))
check('user_version', () => JSON.stringify(db.prepare('pragma user_version').get()))
check('tables', () => db.prepare("select name from sqlite_master where type='table' order by name").all().map(r => r.name).join(','))
check('memories count', () => db.prepare('select count(*) as n from memories').get().n)
check('memories_vec count', () => db.prepare('select count(*) as n from memories_vec').get().n)
check('conversations count', () => db.prepare('select count(*) as n from conversations').get().n)
check('fts zh trigram query', () => db.prepare('select rowid from conversations_fts_zh where conversations_fts_zh match ? limit 3').all('的').length)
check('fts en query', () => db.prepare('select rowid from conversations_fts where conversations_fts match ? limit 3').all('test').length)
check('knn self-match on real data', () => {
  const row = db.prepare('select id, embedding from memories_vec limit 1').get()
  const hits = db.prepare('select id, distance from memories_vec where embedding match ? order by distance limit 3').all(row.embedding)
  return `n=${hits.length} top=${hits[0].id} distance=${hits[0].distance}`
})
check('named params style probe', () => {
  let bare = null
  let prefixed = null
  try { bare = db.prepare('select @a + @b as s').get({ a: 40, b: 2 }).s } catch (e) { bare = 'ERR:' + String(e.message).slice(0, 60) }
  try { prefixed = db.prepare('select @a + @b as s').get({ '@a': 40, '@b': 2 }).s } catch (e) { prefixed = 'ERR:' + String(e.message).slice(0, 60) }
  return `bare=${bare} prefixed=${prefixed}`
})
check('run() result shape', () => {
  const r = db.prepare('insert into events (ts, type, target, detail, clause) values (?,?,?,?,?)').run(Date.now(), 'spike', 'test', null, null)
  return JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v))
})
check('float32 bind + knn roundtrip', () => {
  const sql = db.prepare("select sql from sqlite_master where name='memories_vec'").get().sql
  const m = /float\[(\d+)\]/.exec(sql)
  const dim = Number(m[1])
  const vec = new Float32Array(dim).fill(0.01)
  let bind = 'float32'
  try {
    db.prepare('insert into memories_vec (id, embedding) values (?, ?)').run('spike-vec-1', vec)
  } catch (e1) {
    bind = 'uint8-fallback'
    try {
      db.prepare('insert into memories_vec (id, embedding) values (?, ?)').run('spike-vec-1', new Uint8Array(vec.buffer))
    } catch (e2) {
      throw new Error(`float32: ${e1.message.slice(0, 60)} | uint8: ${e2.message.slice(0, 60)}`)
    }
  }
  const hits = db.prepare('select id, distance from memories_vec where embedding match ? order by distance limit 1').all(vec)
  db.prepare('delete from memories_vec where id = ?').run('spike-vec-1')
  return `dim=${dim} bind=${bind} top=${hits[0].id} distance=${hits[0].distance}`
})
check('manual transaction begin/rollback', () => {
  db.exec('begin')
  db.prepare('insert into events (ts, type, target, detail, clause) values (?,?,?,?,?)').run(Date.now(), 'spike-tx', null, null, null)
  db.exec('rollback')
  const n = db.prepare("select count(*) as n from events where type='spike-tx'").get().n
  return 'after-rollback count=' + n
})
check('blob roundtrip (read embedding col as typed)', () => {
  const row = db.prepare('select embedding from memories where embedding is not null limit 1').get()
  const t = row && row.embedding
  return t ? `ctor=${t.constructor.name} byteLength=${t.byteLength}` : 'no-row'
})
check('close', () => { db.close(); return 'closed' })

console.log()
let failed = 0
for (const [st, name, info] of results) {
  if (st === 'FAIL') failed++
  console.log(`${st}  ${name}${info ? '  ::  ' + info : ''}`)
}
console.log(`\nSUMMARY: ${results.length - failed}/${results.length} pass`)
process.exit(failed ? 1 : 0)
