/**
 * Stats skeleton tests (Task 1.8): pre-registered analysis primitives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { mcnemarExact, pairedBootstrapCI, holm, bh, cohensH, oddsRatio, mulberry32 } = await import('../eval/lib/stats.mjs')

test('stats: McNemar exact two-sided', () => {
  assert.ok(Math.abs(mcnemarExact(10, 2) - 0.038574) < 1e-5)
  assert.equal(mcnemarExact(0, 0), 1)
  assert.ok(mcnemarExact(5, 5) > 0.9)
})

test('stats: paired bootstrap CI reproducible with seed', () => {
  const diffs = [1, 1, 0, 1, 0, 0, 1, 1, 1, 0]
  const a = pairedBootstrapCI(diffs, { seed: 7, iterations: 1000 })
  const b = pairedBootstrapCI(diffs, { seed: 7, iterations: 1000 })
  assert.equal(a.mean, 0.6)
  assert.deepEqual([a.lo, a.hi], [b.lo, b.hi])
  assert.ok(a.lo <= a.mean && a.mean <= a.hi)
})

test('stats: Holm and BH corrections', () => {
  const h = holm([0.01, 0.04, 0.03])
  assert.ok(Math.abs(h[1] - 0.06) < 1e-12 && Math.abs(h[2] - 0.06) < 1e-12)
  const b = bh([0.01, 0.04, 0.03])
  assert.ok(b[0] <= b[1] && b[0] <= b[2])
})

test('stats: effect sizes + seeded rng', () => {
  assert.ok(Math.abs(cohensH(0.7, 0.5) - 0.4115) < 1e-3)
  assert.equal(oddsRatio(10, 2), 5)
  const r1 = mulberry32(42)
  const r2 = mulberry32(42)
  assert.equal(r1(), r2())
})
