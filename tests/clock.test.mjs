/**
 * Clock injection tests (Task 1.1 / C8): ManualClock + normalizeClock +
 * Store compatibility with both Clock objects and legacy () => number.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { ManualClock, systemClock, normalizeClock } = await import('../lib/clock.js')

const DAY = 86_400_000

function mkDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-clock-'))
  return openDatabase(path.join(dir, 'c.db'))
}

test('clock: ManualClock set / advanceMs / advanceDays', () => {
  const c = new ManualClock(1000)
  assert.equal(c.now(), 1000)
  c.set(5000)
  assert.equal(c.now(), 5000)
  c.advanceMs(500)
  assert.equal(c.now(), 5500)
  c.advanceDays(2)
  assert.equal(c.now(), 5500 + 2 * DAY)
})

test('clock: normalizeClock: undefined → system; function and object pass through', () => {
  assert.equal(normalizeClock(undefined), systemClock)
  const fn = normalizeClock(() => 42)
  assert.equal(fn.now(), 42)
  const m = new ManualClock(7)
  assert.equal(normalizeClock(m), m)
})

test('clock: Store accepts Clock object and legacy function clock', () => {
  const db = mkDb()
  const clock = new ManualClock(1000)
  const store = new Store(db, null, clock)
  const m = store.insertMemory({
    content: 'x',
    aspect: 'perfect',
    anchor: { type: 'none' },
    source: 'agent',
  })
  assert.equal(m.createdAt, 1000)
  clock.advanceDays(1)
  store.updateMemory(m.id, { activation: 0.5 })
  assert.equal(store.getMemory(m.id).updatedAt, 1000 + DAY)

  const legacy = new Store(db, null, () => 42)
  const m2 = legacy.insertMemory({
    content: 'y',
    aspect: 'perfect',
    anchor: { type: 'none' },
    source: 'agent',
  })
  assert.equal(m2.createdAt, 42)
  closeDatabase(db)
})
