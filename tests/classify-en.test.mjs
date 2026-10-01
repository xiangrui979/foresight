/**
 * Bilingual rules extension tests (Task 1.9 / C5, DECISIONS §15).
 * English tense/date parsing + mixed CN/EN; UTC-stable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { classifyByRules, extractDate, isoDateUTC } = await import('../lib/gate/classify.js')

const NOW = new Date('2026-10-01T00:00:00Z') // Thursday UTC
const P = {}

test('rules-en: will/going to → prospective prediction + predictBy', () => {
  const a = classifyByRules(P, NOW, 'I will submit the report tomorrow')
  assert.equal(a.aspect, 'prospective')
  assert.equal(a.modality, 'prediction')
  assert.equal(a.predictBy, '2026-10-02')
  const b = classifyByRules(P, NOW, 'I am going to visit the client next Monday')
  assert.equal(b.aspect, 'prospective')
  assert.equal(b.predictBy, '2026-10-05')
})

test('rules-en: plan/pending → prospective', () => {
  const a = classifyByRules(P, NOW, 'The team plans to refactor the module next week')
  assert.equal(a.aspect, 'prospective')
  assert.equal(a.modality, 'plan')
  const b = classifyByRules(P, NOW, 'She has not started the migration yet')
  assert.equal(b.aspect, 'prospective')
})

test('rules-en: perfect (have+PP / strong past)', () => {
  assert.equal(classifyByRules(P, NOW, 'I have finished the report').aspect, 'perfect')
  assert.equal(classifyByRules(P, NOW, 'The user moved to Berlin').aspect, 'perfect')
  const c = classifyByRules(P, NOW, 'The service was deployed on March 5')
  assert.equal(c.aspect, 'perfect')
  assert.deepEqual(c.anchor, { type: 'point', start: '2026-03-05' })
})

test('rules-en: progressive (be+ing / been-ing / currently)', () => {
  assert.equal(classifyByRules(P, NOW, 'The database migration is running').aspect, 'progressive')
  assert.equal(classifyByRules(P, NOW, 'It was snowing all day').aspect, 'progressive')
  const c = classifyByRules(P, NOW, 'She has been working on the paper since 2026-01-05')
  assert.equal(c.aspect, 'progressive')
  assert.deepEqual(c.anchor, { type: 'open', start: '2026-01-05' })
})

test('rules-en: unmarked present / negation → gnomic', () => {
  assert.equal(classifyByRules(P, NOW, 'The user likes green tea').aspect, 'gnomic')
  assert.equal(classifyByRules(P, NOW, 'The user does not drink coffee').aspect, 'gnomic')
})

test('rules-en: mixed perfect+progressive → decline (null)', () => {
  assert.equal(classifyByRules(P, NOW, 'I finished the report and am writing the summary'), null)
  assert.equal(classifyByRules(P, NOW, '部署正在进行且已完成'), null)
})

test('rules-en: explicit ISO range → interval anchor', () => {
  const c = classifyByRules(P, NOW, 'The release was completed from 2026-01-01 to 2026-01-05')
  assert.equal(c.aspect, 'perfect')
  assert.deepEqual(c.anchor, { type: 'interval', start: '2026-01-01', end: '2026-01-05' })
})

test('rules-en: mixed CN/EN markers', () => {
  const a = classifyByRules(P, NOW, '我们 will 上线新版本')
  assert.equal(a.aspect, 'prospective')
  const b = classifyByRules(P, NOW, '部署已经 completed')
  assert.equal(b.aspect, 'perfect')
})

test('rules-en: English relative/absolute date extraction (UTC)', () => {
  assert.equal(extractDate('done yesterday', NOW), '2026-09-30')
  assert.equal(extractDate('in 3 days', NOW), '2026-10-04')
  assert.equal(extractDate('3 days ago', NOW), '2026-09-28')
  assert.equal(extractDate('next Friday', NOW), '2026-10-02')
  assert.equal(extractDate('on July 4, 2026', NOW), '2026-07-04')
  assert.equal(extractDate('by 4 July', NOW), '2026-07-04')
  assert.equal(isoDateUTC(NOW), '2026-10-01')
})
