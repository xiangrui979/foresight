#!/usr/bin/env node
/**
 * ForeSight smoke matrix (Task 1.10 / G1 gate, offline-capable).
 *
 * 20 synthetic timesuite-style dialogues × 7 systems, end-to-end through
 * per-question isolated worlds (adapters/common), deterministic stub reader,
 * unified budget. Produces trace JSONL, main table (score.mjs) and the
 * first RUNLOG entry; asserts the mechanism checklist (C1–C3/C5–C8/C10).
 *
 * LLM-dependent parts (real reader/judge/LLM arm) are NOT exercised here —
 * see DECISIONS deviations. CLI: node eval/smoke.mjs
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAY = 86_400_000
const BASE = Date.parse('2026-01-01T00:00:00Z')
const BUDGET = 2000

function iso(ms) {
  return new Date(ms).toISOString()
}

// ── 20 synthetic items ──────────────────────────────────────────────
// kind → expected behaviour encoded in `expect` for the checklist.
function buildItems() {
  const items = []
  const add = (id, kind, facts, question, groundTruth, qDay, extra = {}) => {
    const at = iso(BASE + (extra.startDay ?? 0) * DAY)
    items.push({
      id,
      kind,
      sessions: [
        {
          session_id: 's1',
          date: at.slice(0, 10),
          turns: [
            { role: 'user', text: facts[0]?.text ?? 'empty turn', at, facts },
            ...(extra.assistant ? [{ role: 'assistant', text: extra.assistant, at }] : []),
          ],
        },
      ],
      question,
      answer: groundTruth ?? '',
      groundTruth: groundTruth ?? null,
      question_date: iso(BASE + qDay * DAY),
      stale: extra.stale ?? [],
      expect: extra.expect ?? {},
    })
  }
  for (let i = 0; i < 3; i++) {
    add(`smoke-ttl-active-${i}`, 'ttl-active', [{ text: `训练任务 ${i} 在跑`, aspect: 'progressive', anchor: { type: 'none' } }], '训练任务状态？', `训练任务 ${i} 在跑`, 2, { startDay: 0 })
  }
  for (let i = 0; i < 3; i++) {
    add(`smoke-ttl-expired-${i}`, 'ttl-expired', [{ text: `迁移任务 ${i} 在跑`, aspect: 'progressive', anchor: { type: 'none' } }], '迁移任务状态？', null, 10, { startDay: 0, expect: { foresightEmpty: true, nolifecycleNonEmpty: true } })
  }
  add('smoke-point-active-0', 'point-active', [{ text: '报告撰写进行中', aspect: 'progressive', anchor: { type: 'point', start: '2026-01-01' } }], '报告状态？', '报告撰写进行中', 3, { startDay: 0 })
  add('smoke-point-expired-0', 'point-expired', [{ text: '部署任务进行中', aspect: 'progressive', anchor: { type: 'point', start: '2026-01-01' } }], '部署状态？', null, 12, { startDay: 0, expect: { foresightEmpty: true, nolifecycleNonEmpty: true } })
  for (let i = 0; i < 2; i++) {
    add(`smoke-not-started-${i}`, 'not-started', [{ text: `迭代 ${i} 从 2026-03-01 开始`, aspect: 'progressive', anchor: { type: 'interval', start: '2026-03-01', end: '2026-03-10' } }], '迭代开始了吗？', null, 5, { startDay: 0, expect: { foresightEmpty: true, nolifecycleNonEmpty: true } })
  }
  for (let i = 0; i < 2; i++) {
    add(`smoke-interval-active-${i}`, 'interval-active', [{ text: `评审 ${i} 在 2026-01-01 到 2026-01-20 期间进行中`, aspect: 'progressive', anchor: { type: 'interval', start: '2026-01-01', end: '2026-01-20' } }], '评审状态？', `评审 ${i}`, 5, { startDay: 0 })
  }
  for (let i = 0; i < 2; i++) {
    add(`smoke-update-${i}`, 'update', [
      { text: '用户是大学生', aspect: 'perfect', anchor: { type: 'point', start: '2024-09-01' } },
      { text: '用户是研究生', aspect: 'perfect', anchor: { type: 'point', start: '2026-01-01' } },
    ], '用户现在的学历？', '研究生', 5, { startDay: 0, stale: [{ old: '大学生', new: '研究生' }], expect: { staleInjected: 1 } })
  }
  for (let i = 0; i < 2; i++) {
    add(`smoke-prediction-${i}`, 'prediction-due', [{ text: `预测：稿子 ${i} 将于 2026-01-10 完成`, aspect: 'prospective', anchor: { type: 'none' }, modality: 'prediction', predict_by: '2026-01-10' }], '稿子完成了吗？', null, 15, { startDay: 0 })
  }
  add('smoke-control-empty-0', 'control-empty', [], '不存在的主题？', null, 5, { startDay: 0, expect: { allEmpty: true } })
  add('smoke-gate-reject-0', 'gate-reject', [], '无事实写入？', null, 5, { startDay: 0, expect: { ingestRejected: true } })
  add('smoke-multisession-0', 'multisession', [{ text: '接口联调已完成', aspect: 'perfect', anchor: { type: 'point', start: '2026-01-01' } }], '接口联调状态？', '接口联调已完成', 6, { startDay: 0, assistant: '好的，已记录。' })
  add('smoke-final-0', 'ttl-active', [{ text: '缓存服务在跑', aspect: 'progressive', anchor: { type: 'none' } }], '缓存服务状态？', '缓存服务在跑', 1, { startDay: 0 })
  return items
}

// ── main ────────────────────────────────────────────────────────────

const { ManualClock } = await import('../lib/clock.js')
const { openDatabase, closeDatabase } = await import('../lib/schema.js')
const { Store } = await import('../lib/store.js')
const { FakeEmbedProvider } = await import('../lib/store/embed.js')
const { loadPolicy } = await import('../lib/policy.js')
const { search } = await import('../lib/retrieve/search.js')
const { buildNudgeAsync } = await import('../lib/nudge/nudge.js')
const { extractDate } = await import('../lib/gate/classify.js')
const { loadTokenizer } = await import('./lib/tokens.mjs')
const { validateTraces, writeTraces } = await import('./lib/trace.mjs')
const { SYSTEM_FACTORIES } = await import('./systems/index.mjs')
const { ingestTurns } = await import('./adapters/common.mjs')
const { evaluateRules, loadItems } = await import('./gate-eval/label.mjs')

const tpl = fileURLToPath(new URL('../templates/policy.yaml.example', import.meta.url))
const { id: tokenizerId, count } = await loadTokenizer()
const embed = new FakeEmbedProvider(768)
const items = buildItems()
const ORDER = ['closedbook', 'summary', 'fullcontext', 'rag', 'recency', 'nolifecycle', 'foresight']
const traces = []
const ingestStats = {}

const repoCommit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'smoke-local'
  }
})()
const configHash = (policy) => createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)

for (const item of items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-smoke-'))
  fs.writeFileSync(path.join(dir, 'policy.yaml'), fs.readFileSync(tpl, 'utf8'))
  const policy = loadPolicy(path.join(dir, 'policy.yaml'))
  const clock = new ManualClock(BASE)
  const schema = openDatabase(path.join(dir, `${item.id}.db`))
  const store = new Store(schema, null, clock)
  const ingest = await ingestTurns(store, policy, item, { mode: 'extract', clock })
  ingestStats[item.id] = ingest
  clock.set(Date.parse(item.question_date))
  const history = item.sessions.flatMap((s) => s.turns.map((t) => ({ peer: t.role, content: t.text, createdAt: Date.parse(t.at ?? item.question_date) })))
  const reader = async ({ injected }) => ({ answer: injected.length ? injected.map((i) => i.content).join(' / ') : '（闭卷）', calls: 0 })
  const ctx = { policy, store, embed, clock, reader, countTokens: count, budgetTokens: BUDGET, history, llm: null }

  for (const name of ORDER) {
    const sys = SYSTEM_FACTORIES[name](ctx)
    let r
    try {
      r = await sys.query({ query: item.question, now: Date.parse(item.question_date) })
    } catch (e) {
      closeDatabase(schema)
      console.error(`✘ ${name}/${item.id} 运行失败: ${e.message}`)
      process.exitCode = 1
      process.exit(1)
    }
    const injected = r.injected.map((i) => {
      const m = store.getMemory(i.memory_id)
      return {
        memory_id: i.memory_id,
        aspect: m?.aspect ?? 'perfect',
        anchor_type: m?.anchor?.type ?? 'none',
        status: m?.status ?? 'active',
        expires_at_ms: null,
        suppressed_by: null,
        stale_gt: item.stale.some((p) => String(i.content).includes(p.old) && !String(i.content).includes(p.new)),
        stale_reason: null,
        created_at_ms: m?.createdAt ?? Date.parse(item.question_date),
        age_days: 0,
        score: 1,
        tokens: i.tokens,
        included: true,
      }
    })
    const answer = r.answer
    const correct = item.groundTruth === null ? injected.length === 0 : answer.includes(item.groundTruth)
    traces.push({
      run_id: `smoke-${repoCommit}-${name}-${item.id}`,
      system: name,
      bench: 'smoke',
      variant: 'smoke',
      item_id: `${name}-${item.id}`,
      query: item.question,
      query_time_ms: Date.parse(item.question_date),
      channel: r.channel,
      injected,
      candidate_count: injected.length,
      budget_tokens: BUDGET,
      injected_tokens: r.injected_tokens,
      answer,
      correct,
      judge: null,
      versions: {
        repo_commit: repoCommit,
        policy_version: policy.policy_version,
        config_hash: configHash(policy),
        node: process.version,
        embed_model: 'FakeEmbedProvider@768',
        llm_model: 'none (offline smoke)',
        tokenizer: tokenizerId,
        seed: 0,
        stale_annotator: 'rules@v1',
      },
      cost: { llm_calls: r.calls, prompt_tokens: 0, completion_tokens: 0, cny: 0, cache_hit: false },
      timing_ms: { ingest: 0, retrieve: 0, answer: 0 },
    })
  }
  closeDatabase(schema)
}

// ── outputs ─────────────────────────────────────────────────────────

const outDir = path.join(HERE, 'results', 'smoke')
const traceFile = path.join(outDir, 'traces.jsonl')
writeTraces(traceFile, traces)
const errors = validateTraces(traces)
if (errors.length > 0) {
  console.error(`✘ smoke trace 校验失败 (${errors.length}): ${errors[0]}`)
  process.exit(1)
}
execFileSync(process.execPath, [path.join(HERE, 'score.mjs'), '--traces', traceFile, '--out', path.join(outDir, 'summary.json'), '--md', path.join(outDir, 'summary.md'), '--pair', 'foresight,nolifecycle', '--pair', 'foresight,recency'], { stdio: 'inherit' })

// ── mechanism checklist (C1–C3/C5–C8/C10) ──────────────────────────

const checks = []
const bySystemItem = (system, id) => traces.find((t) => t.system === system && t.item_id === `${system}-${id}`)
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })

{
  let ok = true
  for (const item of items.filter((i) => i.kind === 'ttl-expired' || i.kind === 'point-expired')) {
    const f = bySystemItem('foresight', item.id)
    const n = bySystemItem('nolifecycle', item.id)
    if (f.injected.length !== 0 || n.injected.length === 0) ok = false
  }
  check('C1/C2 expired not injected (foresight) vs nolifecycle contrast', ok)
}
{
  let ok = true
  for (const item of items.filter((i) => i.kind === 'not-started')) {
    const f = bySystemItem('foresight', item.id)
    const n = bySystemItem('nolifecycle', item.id)
    if (f.injected.length !== 0 || n.injected.length === 0) ok = false
  }
  check('C10 not-started hidden by lifecycle', ok)
}
{
  const ok = traces.every((t) => t.injected_tokens <= BUDGET)
  check('C6 budget respected', ok, `budget=${BUDGET}`)
}
{
  const qv = new Float32Array(768).fill(0)
  qv[0] = 1
  const same = new Float32Array(768).fill(0)
  same[0] = 1
  const diff = new Float32Array(768).fill(0)
  diff[1] = 1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-smoke-c3-'))
  fs.writeFileSync(path.join(dir, 'policy.yaml'), fs.readFileSync(tpl, 'utf8'))
  const policy = loadPolicy(path.join(dir, 'policy.yaml'))
  const schema = openDatabase(path.join(dir, 'c3.db'))
  const store = new Store(schema, null, new ManualClock(0))
  const a = store.insertMemory({ content: '接口联调已完成', aspect: 'perfect', anchor: { type: 'point', start: '2026-01-01' }, source: 'agent', embedding: same })
  const b = store.insertMemory({ content: '无关的旧记录', aspect: 'perfect', anchor: { type: 'point', start: '2026-01-01' }, source: 'agent', embedding: diff })
  const hits = await search('接口联调', store, { embedOne: async () => qv, embedBatch: async (t) => t.map(() => qv) }, policy, Date.parse('2026-01-02'), {})
  const scoreOf = (id) => hits.find((h) => h.id === id)?.score ?? -1
  check('C3 f_embed participates in final score', scoreOf(a.id) > scoreOf(b.id))
  closeDatabase(schema)
}
{
  const evalItems = loadItems()
  const { metrics } = evaluateRules(evalItems)
  check('C5 gate-eval rules aspect ≥80%', metrics.aspect_acc >= 0.8, `${(metrics.aspect_acc * 100).toFixed(2)}%`)
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-smoke-c7-'))
  fs.writeFileSync(path.join(dir, 'policy.yaml'), fs.readFileSync(tpl, 'utf8'))
  const policy = loadPolicy(path.join(dir, 'policy.yaml'))
  policy.nudge.auto_resolve_prediction = true
  const schema = openDatabase(path.join(dir, 'c7.db'))
  const clock = new ManualClock(Date.parse('2026-02-01T00:00:00Z'))
  const store = new Store(schema, null, clock)
  store.insertMemory({ content: '预测：稿子将于 2026-01-10 完成', aspect: 'prospective', anchor: { type: 'none' }, modality: 'prediction', source: 'agent', metadata: { predict_by: '2026-01-10' } })
  let sawEvidence = false
  const llm = { call: async (req) => { sawEvidence = req.user.includes('证据') && req.user.includes('已完成'); return { content: '', json: { verdict: 'fulfilled' } } } }
  await buildNudgeAsync({ store, policy, now: clock.now(), turnCount: 10, sessionStartTs: 0, llm, evidenceFor: async () => ['会话证据：稿子已完成并提交'] })
  const mem = store.listByAspectStatus('prospective', 'active').length === 0
  check('C7 prediction evidence channel wired', sawEvidence && mem)
  closeDatabase(schema)
}
{
  const utc = extractDate('明天', new Date('2026-10-01T20:00:00Z'))
  check('C8 UTC-stable date extraction', utc === '2026-10-02', utc)
}

const failed = checks.filter((c) => !c.ok)
const runlog = [
  '# RUNLOG',
  '',
  '## smoke-offline-1 · 2026-10-01',
  '',
  `- commit: \`${repoCommit}\` · offline stub reader（无 LLM 调用；真实 reader/judge 需 key）`,
  `- ${items.length} items × ${ORDER.length} systems = ${traces.length} traces · budget=${BUDGET} tokens`,
  `- cost: calls=0 · ¥0（离线）· tokenizer=${tokenizerId}`,
  `- trace: eval/results/smoke/traces.jsonl（校验通过）· 主表: eval/results/smoke/summary.md`,
  `- ingest 接受: ${Object.entries(ingestStats).map(([k, v]) => `${k}:${v.accepted}/${v.turns}`).join(' ')}`,
  `- mechanism checklist: ${checks.map((c) => `${c.name}=${c.ok ? 'PASS' : 'FAIL'}`).join(' · ')}`,
  '',
].join('\n')
fs.writeFileSync(path.join(HERE, 'results', 'RUNLOG.md'), runlog)

console.log(`✔ smoke: ${items.length} items × ${ORDER.length} systems = ${traces.length} traces → ${traceFile}`)
for (const c of checks) console.log(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
if (failed.length > 0) process.exit(1)
