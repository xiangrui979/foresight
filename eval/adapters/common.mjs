/**
 * Shared adapter helpers (Task 1.6 / SPEC.md).
 *
 * Normalized item shape (all adapters produce this):
 * {
 *   id, sessions: [{session_id, date, turns: [{role, text, at, facts?}]}],
 *   question, answer, question_date, stale: [{old, new}],
 *   expected?: {accepted, stale_marked, probe_hit}
 * }
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE_MAX_TEXT = 2000

export function loadJsonl(file) {
  const text = fs.readFileSync(file, 'utf8')
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        throw new Error(`${file}:${i + 1} JSON 解析失败: ${e.message}`)
      }
    })
}

export function validateItem(item) {
  const errors = []
  if (!item?.id) errors.push('缺少 id')
  if (!Array.isArray(item?.sessions) || item.sessions.length === 0) errors.push('缺少 sessions')
  if (typeof item?.question !== 'string' || !item.question) errors.push('缺少 question')
  if (typeof item?.question_date !== 'string' || Number.isNaN(Date.parse(item.question_date))) errors.push('question_date 非法')
  for (const [i, s] of (item?.sessions ?? []).entries()) {
    if (!Array.isArray(s.turns)) errors.push(`sessions[${i}].turns 缺失`)
    for (const [j, t] of (s.turns ?? []).entries()) {
      if (!['user', 'assistant'].includes(t.role)) errors.push(`sessions[${i}].turns[${j}].role 非法`)
      if (typeof t.text !== 'string') errors.push(`sessions[${i}].turns[${j}].text 缺失`)
      if (t.at !== undefined && Number.isNaN(Date.parse(t.at))) errors.push(`sessions[${i}].turns[${j}].at 非法`)
    }
  }
  return errors
}

/**
 * Ingest one item. mode:
 *  - 'extract' (golden/offline): turns carry structured facts → direct write
 *  - 'gate' (real run): every turn through gateWrite with rules classifier
 * Returns {accepted, rejected, turns, acceptanceRate}
 */
export async function ingestTurns(store, policy, item, { mode = 'extract', gateWrite, buildClassifyFn, clock } = {}) {
  let accepted = 0
  let rejected = 0
  let turns = 0
  for (const s of item.sessions) {
    for (const t of s.turns) {
      turns += 1
      const sourceRef = `${t.role}:${s.session_id}`
      if (mode === 'extract') {
        if (clock && t.at) clock.set(Date.parse(t.at))
        const facts = Array.isArray(t.facts) ? t.facts : []
        if (facts.length === 0) {
          rejected += 1
          continue
        }
        for (const f of facts) {
          const text = String(f?.text ?? '').trim()
          if (!text || text.length > GATE_MAX_TEXT) {
            rejected += 1
            continue
          }
          store.insertMemory({
            content: text,
            aspect: f.aspect ?? 'perfect',
            anchor: f.anchor ?? { type: 'none' },
            source: 'agent',
            sourceRef,
            telicity: f.aspect === 'progressive' ? (f.telicity ?? 'unbounded') : null,
            modality: f.aspect === 'prospective' ? (f.modality ?? null) : null,
            metadata: f.predict_by ? { predict_by: f.predict_by } : {},
          })
          accepted += 1
        }
      } else {
        const at = t.at ? new Date(t.at) : undefined
        const r = await gateWrite(
          { text: t.text, source: 'agent', sourceRef, now: at },
          { policy, store, classifyFn: buildClassifyFn(policy, null) },
        )
        if (r.ok) accepted += 1
        else rejected += 1
      }
    }
  }
  return { accepted, rejected, turns, acceptanceRate: turns > 0 ? accepted / turns : 0 }
}

/**
 * Probe one item: assumes the caller has already set the clock to
 * question_date. Uses the shipped search + the unified budget renderer.
 */
export async function probeItem(store, policy, embed, item, { budgetTokens = 2000, countTokens, searchFn, sweepFn, renderBudgetFn, annotateStale } = {}) {
  if (sweepFn) sweepFn(store, policy, Date.parse(item.question_date))
  const hits = searchFn ? await searchFn(item.question) : await embedSearch(store, policy, embed, item)
  const items = hits.map((h) => ({ text: h.rendered ?? h.content, memory_id: h.id, content: h.content }))
  const budget = renderBudgetFn ? renderBudgetFn(items, budgetTokens, countTokens) : { included: items, tokens: 0 }
  const injected = budget.included.map((i) => ({ memory_id: i.memory_id, content: i.content }))
  const stale = annotateStale ? annotateStale(item, injected) : []
  return { hits, injected, tokens: budget.tokens, stale }
}

async function embedSearch(store, policy, embed, item) {
  const { search } = await import('../../lib/retrieve/search.js')
  return search(item.question, store, embed, policy, Date.parse(item.question_date), { topK: 20 })
}

/** Per-item isolated world: temp root + policy + DB + store (ManualClock). */
export async function makeIsolatedWorld({ item, policyTemplatePath, at }) {
  const { ManualClock } = await import('../../lib/clock.js')
  const { openDatabase } = await import('../../lib/schema.js')
  const { Store } = await import('../../lib/store.js')
  const { loadPolicy } = await import('../../lib/policy.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-adapter-'))
  const tpl = fs.readFileSync(policyTemplatePath, 'utf8')
  fs.writeFileSync(path.join(dir, 'policy.yaml'), tpl)
  const policy = loadPolicy(path.join(dir, 'policy.yaml'))
  const clock = new ManualClock(at ?? 0)
  const schema = openDatabase(path.join(dir, `${item.id}.db`))
  const store = new Store(schema, null, clock)
  return { dir, policy, clock, schema, store }
}

/**
 * Golden selfcheck: load golden/<bench>.jsonl, run every item through the
 * isolated extract→probe path, assert accepted / stale_marked / probe_hit.
 */
export async function selfcheckBench(bench, { goldenPath, policyTemplatePath } = {}) {
  const golden = goldenPath ?? fileURLToPath(new URL(`./golden/${bench}.jsonl`, import.meta.url))
  const items = loadJsonl(golden)
  const { loadTokenizer } = await import('../lib/tokens.mjs')
  const { annotateStale } = await import('../lib/stale.mjs')
  const { renderWithinBudget } = await import('../lib/render-budget.mjs')
  const { sweepExpired } = await import('../../lib/evolve/temporal.js')
  const { closeDatabase } = await import('../../lib/schema.js')
  const { FakeEmbedProvider } = await import('../../lib/store/embed.js')
  const { count } = await loadTokenizer()
  const tpl = policyTemplatePath ?? fileURLToPath(new URL('../../templates/policy.yaml.example', import.meta.url))
  const embed = new FakeEmbedProvider(768)

  let pass = 0
  const failures = []
  for (const item of items) {
    const errors = validateItem(item)
    if (errors.length > 0) {
      failures.push(`${item.id}: ${errors.join('; ')}`)
      continue
    }
    const first = item.sessions[0]
    const at = Date.parse(first.turns[0]?.at ?? `${first.date}T00:00:00Z`)
    const world = await makeIsolatedWorld({ item, policyTemplatePath: tpl, at })
    const ing = await ingestTurns(world.store, world.policy, item, { mode: 'extract', clock: world.clock })
    world.clock.set(Date.parse(item.question_date))
    const probe = await probeItem(world.store, world.policy, embed, item, {
      budgetTokens: 2000,
      countTokens: count,
      sweepFn: sweepExpired,
      renderBudgetFn: renderWithinBudget,
      annotateStale,
    })
    const checks = []
    if (item.expected?.accepted !== undefined) checks.push([`accepted=${ing.accepted}`, ing.accepted === item.expected.accepted])
    if (item.expected?.stale_marked !== undefined) checks.push([`stale_marked=${probe.stale.length}`, probe.stale.length === item.expected.stale_marked])
    if (item.expected?.probe_hit !== undefined) checks.push([`probe_hit=${probe.injected.length > 0}`, (probe.injected.length > 0) === item.expected.probe_hit])
    closeDatabase(world.schema)
    const bad = checks.filter(([, ok]) => !ok)
    if (bad.length === 0) pass += 1
    else failures.push(`${item.id}: ${bad.map(([s]) => s).join(', ')}`)
  }
  const total = items.length
  if (failures.length === 0 && total === 5) {
    console.log(`✔ adapter/${bench} selfcheck: golden ${pass}/${total} 通过`)
    return 0
  }
  console.error(`✘ adapter/${bench} selfcheck: ${pass}/${total} 通过`)
  for (const f of failures) console.error(`  - ${f}`)
  return 1
}
