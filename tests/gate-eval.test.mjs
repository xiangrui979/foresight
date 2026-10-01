/**
 * gate-eval threshold guard (Task 1.9 / C5): the shipped 400-item set must
 * keep rules aspect accuracy ≥ 80% (DECISIONS §15 G1 switch rule).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'

const { classifyByRules } = await import('../lib/gate/classify.js')

const ITEMS = new URL('../eval/gate-eval/items.jsonl', import.meta.url)
const NOW = new Date('2026-10-01T00:00:00Z')

test('gate-eval: 400 items (200 zh / 200 en), aspect ≥ 80%', () => {
  const items = fs
    .readFileSync(ITEMS, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  assert.equal(items.length, 400)
  assert.equal(items.filter((i) => i.lang === 'zh').length, 200)
  assert.equal(items.filter((i) => i.lang === 'en').length, 200)

  let ok = 0
  let anchorOk = 0
  for (const it of items) {
    const r = classifyByRules({}, NOW, it.text)
    if (r?.aspect === it.gold_aspect) ok += 1
    if (r?.anchor?.type === it.gold_anchor_type) anchorOk += 1
  }
  const aspectAcc = ok / items.length
  const anchorAcc = anchorOk / items.length
  assert.ok(aspectAcc >= 0.8, `rules aspect accuracy ${(aspectAcc * 100).toFixed(2)}% < 80% → G1 应切 B`)
  assert.ok(anchorAcc >= 0.8, `rules anchor accuracy ${(anchorAcc * 100).toFixed(2)}% < 80%`)
})
