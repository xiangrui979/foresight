/**
 * Policy surface consistency (Task 1.2 / C3 + C9).
 *
 * Contract: the shipped template (templates/policy.yaml.example) is the
 * public policy surface. Every field in it must either have an executor in
 * code, or be explicitly registered as reserved/decorative in
 * eval/DECISIONS.md §13. Retrieval factor keys must match the FACTORS
 * registry exactly, and render_anchor values must be wired end-to-end.
 * Fictional data only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'

const YAML = (await import('js-yaml')).default
const { FACTORS } = await import('../lib/retrieve/factors.js')
const { renderMemory } = await import('../lib/retrieve/search.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

const templatePath = new URL('../templates/policy.yaml.example', import.meta.url)
const decisionsPath = new URL('../eval/DECISIONS.md', import.meta.url)

function templatePolicy() {
  return YAML.load(fs.readFileSync(templatePath, 'utf8')).foresight
}

function leaves(obj, prefix = '', out = []) {
  // Arrays are atomic at the policy-surface level (their shape is part of the
  // consuming code, e.g. derive.routes / chinese_markers.bounded).
  if (Array.isArray(obj)) {
    out.push(prefix)
    return out
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) leaves(v, prefix ? `${prefix}.${k}` : k, out)
    return out
  }
  out.push(prefix)
  return out
}

// Fields with an executor in code (prefix match). Everything else must be
// listed in DECORATIVE below AND documented in eval/DECISIONS.md §13.
const EXECUTED = [
  'policy_version',
  'permission.',
  'aspects.gnomic.render_anchor',
  'aspects.progressive.render_anchor',
  'aspects.perfect.render_anchor',
  'aspects.prospective.render_anchor',
  'aspects.progressive.renewable',
  'aspects.progressive.default_ttl_days',
  'aspects.progressive.telicity.values',
  'aspects.prospective.review_every_turns',
  'gate.allowed_categories',
  'gate.forbidden_categories',
  'gate.forbidden_progressive',
  'gate.llm_model',
  'activation.',
  'retrieval.',
  'injection.',
  'derive.enabled',
  'derive.model',
  'derive.max_new_per_batch',
  'derive.routes',
  'nudge.every_turns',
  'nudge.candidate_extraction',
  'nudge.candidate_max',
  'nudge.llm_model',
  'nudge.review_temporal',
  'nudge.review_conflicts',
  'nudge.include_session_timeline',
  'nudge.auto_resolve_prediction',
  'server.',
  'llm.model_classify',
  'llm.model_derive',
  'llm.model_dialectic',
  'llm.timeout_ms',
  'llm.max_retries',
  'audit.log_file',
]

const DECORATIVE = new Set([
  'gate.fallback',
  'aspects.gnomic.storage',
  'aspects.gnomic.injection',
  'aspects.gnomic.expiry',
  'aspects.gnomic.renewable',
  'aspects.gnomic.default_ttl_days',
  'aspects.gnomic.review_every_turns',
  'aspects.progressive.storage',
  'aspects.progressive.injection',
  'aspects.progressive.expiry',
  'aspects.progressive.review_every_turns',
  'aspects.progressive.telicity.unbounded_force_ttl',
  'aspects.progressive.modalities.prediction.renew',
  'aspects.progressive.modalities.intention.renew',
  'aspects.progressive.modalities.intention.review',
  'aspects.perfect.storage',
  'aspects.perfect.injection',
  'aspects.perfect.expiry',
  'aspects.perfect.renewable',
  'aspects.perfect.default_ttl_days',
  'aspects.perfect.review_every_turns',
  'aspects.prospective.storage',
  'aspects.prospective.injection',
  'aspects.prospective.expiry',
  'aspects.prospective.renewable',
  'aspects.prospective.default_ttl_days',
  'aspects.prospective.modalities.plan.renew',
  'aspects.prospective.modalities.plan.review',
  'aspects.prospective.modalities.commitment.renew',
  'aspects.prospective.modalities.commitment.review',
  'aspects.prospective.modalities.prediction.renew',
  'aspects.prospective.modalities.prediction.review',
  'derive.trigger',
  'derive.every_n_turns',
  'nudge.render',
  'llm.base_url',
  'audit.events_table',
  'audit.emit_session_events',
  'consistency_check',
  'chinese_markers.bounded',
])

const isExecuted = (p) => EXECUTED.some((x) => p === x || p.startsWith(x))

/** Documentation family for DECISIONS §13 (wildcards for repeated aspect fields). */
function familyOf(path) {
  if (path.startsWith('aspects.')) {
    const rest = path.split('.').slice(2).join('.')
    if (rest.startsWith('modalities.')) return 'aspects.*.modalities.*'
    if (['storage', 'injection', 'expiry', 'renewable', 'default_ttl_days', 'review_every_turns'].includes(rest)) {
      return `aspects.*.${rest}`
    }
    return path
  }
  return path
}

test('policy-consistency: template factor names match FACTORS registry exactly (C3)', () => {
  const p = templatePolicy()
  assert.equal(p.policy_version, POLICY_VERSION)
  const configured = Object.keys(p.retrieval.factors).sort()
  const implemented = Object.keys(FACTORS).sort()
  assert.deepEqual(configured, implemented, '每个配置因子必须有实现；每个实现因子必须有配置')
  for (const [name, cfg] of Object.entries(p.retrieval.factors)) {
    assert.equal(typeof cfg.enabled, 'boolean', `${name}.enabled`)
    assert.equal(typeof cfg.weight, 'number', `${name}.weight`)
    assert.ok(cfg.weight > 0, `${name}.weight > 0`)
  }
})

test('policy-consistency: every template leaf is executed or registered decorative (C9)', () => {
  const p = templatePolicy()
  const paths = leaves(p)
  assert.ok(paths.length > 50, `template leaves walked: ${paths.length}`)
  const uncovered = []
  const overlap = []
  for (const path of paths) {
    const exec = isExecuted(path)
    const dec = DECORATIVE.has(path)
    if (exec && dec) overlap.push(path)
    if (!exec && !dec) uncovered.push(path)
  }
  assert.deepEqual(uncovered, [], `未接线且未登记 decorative 的字段: ${uncovered.join(', ')}`)
  assert.deepEqual(overlap, [], `同时被标记 executed 与 decorative: ${overlap.join(', ')}`)
})

test('policy-consistency: DECISIONS §13 documents every decorative family (C9)', () => {
  const decisions = fs.readFileSync(decisionsPath, 'utf8')
  const families = [...new Set([...DECORATIVE].map(familyOf))]
  for (const fam of families) {
    assert.ok(decisions.includes(fam), `eval/DECISIONS.md §13 未登记: ${fam}`)
  }
  assert.ok(decisions.includes('retrieval.factors'), 'DECISIONS 未记录因子权重冻结')
})

test('policy-consistency: retrieval factor weights frozen as pre-registered', () => {
  const p = templatePolicy()
  const weights = Object.fromEntries(Object.entries(p.retrieval.factors).map(([k, v]) => [k, v.weight]))
  assert.deepEqual(weights, { embed: 0.4, time: 0.2, activation: 0.25, links: 0.15 })
})

test('policy-consistency: render_anchor value domain wired end-to-end (C9)', () => {
  const p = templatePolicy()
  const allowed = [true, false, 'short', 'always', 'endpoint', 'none']
  for (const [aspect, cfg] of Object.entries(p.aspects)) {
    assert.ok(allowed.includes(cfg.render_anchor), `${aspect}.render_anchor=${String(cfg.render_anchor)} 不在值域内`)
  }
  const point = { content: '接口联调完成', aspect: 'perfect', anchor: { type: 'point', start: '2026-06-15' } }
  assert.equal(renderMemory(point, p), '接口联调完成（2026-06-15 起）', "perfect='short' 生效")
  const interval = { content: '部署进行中', aspect: 'progressive', anchor: { type: 'interval', start: '2026-06-01', end: '2026-06-30' } }
  assert.equal(renderMemory(interval, p), '部署进行中（至 2026-06-30）', 'progressive=true 生效')
  const gnomic = { content: '用户喜欢简洁', aspect: 'gnomic', anchor: { type: 'none' } }
  assert.equal(renderMemory(gnomic, p), '用户喜欢简洁', 'gnomic=false 不渲染锚')
  // legacy 'always' stays supported
  p.aspects.perfect.render_anchor = 'always'
  assert.equal(renderMemory(point, p), '在 2026-06-15 时：接口联调完成')
})
