#!/usr/bin/env node
/**
 * ForeSight eval runner.
 *
 * P0.4 scaffold + P1.3 selfcheck: `--selfcheck` runs 5 deterministic
 * timesuite-style items against the real Store/search/render layers
 * (offline; FakeEmbedProvider + ManualClock), writes trace v2 JSONL,
 * validates it, and recomputes SIR-i/SIR for cross-checking with
 * `node eval/lib/trace.mjs --sir`.
 *
 * Full benchmark execution (`--bench --system`) lands in P1.5/P1.6.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const BENCHES = ['longmemeval', 'locomo', 'timesuite', 'smoke']
export const SYSTEMS = ['foresight', 'nolifecycle', 'recency', 'rag', 'summary', 'fullcontext', 'closedbook']

const DAY = 86_400_000
const HERE = path.dirname(fileURLToPath(import.meta.url))

export function usage() {
  return `ForeSight eval runner

用法:
  node eval/runner.mjs --bench <name> --system <name> --config <file> --out <file> [options]
  node eval/runner.mjs --selfcheck [--out <file>]

必选 (bench 运行):
  --bench <name>        数据集: ${BENCHES.join(' | ')}
  --system <name>       系统: ${SYSTEMS.join(' | ')}
  --config <file>       eval 配置 (如 eval/configs/foresight-full.yaml)
  --out <file>          结果输出 (trace JSONL)

自检 (P1.3，离线可跑):
  --selfcheck           5 题端到端自检: 真实 Store/search/render + trace v2 + SIR 复算
  --out <file>          自检输出 (默认 eval/results/selfcheck/traces.jsonl)

运行控制:
  --variant <v>         LME 变体: s | m | oracle (默认 s; C-extension 预留)
  --seed <int>          随机种子 (全链路参数化; 默认 0)
  --budget-tokens <n>   注入 token 预算 (预注册 3 档: 1000/2000/4000)
  --budget-usd <n>      成本护栏 (美元口径)
  --budget-cny <n>      成本护栏 (人民币口径; 与 EVAL_MAX_CNY 一致)
  --no-cache            禁用内容哈希缓存 (主表双跑强制)
  --drive-nudge         由 runner 驱动 turn 计数与 nudge (未然体验证路径)
  --estimate            估算调用数与成本, 不执行
  --dry-run             7 系统 × 3 条合成样例离线冒烟 (P1.5; 可配 --system 单跑)

其他:
  --help, -h            显示本帮助

环境变量:
  DEEPSEEK_API_KEY      reader/judge/LLM 调用
  EVAL_MAX_CNY          成本硬帽 (默认 300)
  EVAL_MAX_CALLS        调用数硬顶 (默认 50000)
  FORESIGHT_*           ForeSight 数据目录/embedding/LLM 覆盖
`
}

const SCHEMA = {
  bench: { kind: 'value', validate: (v) => BENCHES.includes(v) },
  system: { kind: 'value', validate: (v) => SYSTEMS.includes(v) },
  config: { kind: 'value' },
  out: { kind: 'value' },
  variant: { kind: 'value', validate: (v) => ['s', 'm', 'oracle'].includes(v) },
  seed: { kind: 'value', parse: Number },
  'budget-tokens': { kind: 'value', parse: Number },
  'budget-usd': { kind: 'value', parse: Number },
  'budget-cny': { kind: 'value', parse: Number },
  'no-cache': { kind: 'flag' },
  'drive-nudge': { kind: 'flag' },
  estimate: { kind: 'flag' },
  'dry-run': { kind: 'flag' },
  selfcheck: { kind: 'flag' },
  help: { kind: 'flag' },
  h: { kind: 'flag' },
}

export function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw new Error(`未知参数: ${raw}`)
    const key = raw.slice(2)
    const spec = SCHEMA[key]
    if (!spec) throw new Error(`未知参数: ${raw}`)
    if (spec.kind === 'flag') {
      opts[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`${raw} 缺少取值`)
    if (spec.validate && !spec.validate(value)) throw new Error(`${raw} 取值非法: ${value}`)
    opts[key] = spec.parse ? spec.parse(value) : value
  }
  return opts
}

// ── P1.3 selfcheck ──────────────────────────────────────────────────

function gitCommitCwd() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'selfcheck-local'
  }
}

function hashPolicy(policy) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
}

function baseVersions(policy, tokenizerId, { embedModel = 'FakeEmbedProvider@768', llmModel = 'none (offline)', staleAnnotator = 'rules@v1' } = {}) {
  return {
    repo_commit: gitCommitCwd(),
    policy_version: policy.policy_version,
    config_hash: hashPolicy(policy),
    node: process.version,
    embed_model: embedModel,
    llm_model: llmModel,
    tokenizer: tokenizerId,
    seed: 0,
    stale_annotator: staleAnnotator,
  }
}

async function runSelfCheck(opts) {
  const { ManualClock } = await import('../lib/clock.js')
  const { openDatabase, closeDatabase } = await import('../lib/schema.js')
  const { Store } = await import('../lib/store.js')
  const { FakeEmbedProvider } = await import('../lib/store/embed.js')
  const { loadPolicy } = await import('../lib/policy.js')
  const { search } = await import('../lib/retrieve/search.js')
  const { renderMemories } = await import('../lib/inject/render.js')
  const { loadTokenizer } = await import('./lib/tokens.mjs')
  const { validateTraces, sir, writeTraces } = await import('./lib/trace.mjs')
  const { guardEstimate, Ledger } = await import('./lib/budget.mjs')

  const base = Date.parse('2026-01-01T00:00:00Z')
  const clock = new ManualClock(base)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-selfcheck-'))
  fs.copyFileSync(fileURLToPath(new URL('../templates/policy.yaml.example', import.meta.url)), path.join(dir, 'policy.yaml'))
  const policy = loadPolicy(path.join(dir, 'policy.yaml'))
  const schema = openDatabase(path.join(dir, 'selfcheck.db'))
  const store = new Store(schema, null, clock)
  const fake = new FakeEmbedProvider(768)
  const act = policy.activation.base_weights.agent ?? 1

  const mk = (content, aspect, anchor, extra = {}) =>
    store.insertMemory({ content, aspect, anchor, source: 'agent', activation: act, ...extra })
  const running = mk('训练任务在跑', 'progressive', { type: 'none' })
  const future = mk('下一阶段迭代从 2026-03-01 开始', 'progressive', { type: 'interval', start: '2026-03-01', end: '2026-03-10' })
  const current = mk('用户是研究生', 'perfect', { type: 'point', start: '2025-12-01' }, { embedding: await fake.embedOne('用户 研究生 学历') })
  const stale = mk('用户是大学生', 'perfect', { type: 'point', start: '2025-03-01' }, { embedding: await fake.embedOne('用户 大学生 学历') })

  /** Render-path injection (system_prompt channel): progressive active, inside window. */
  const renderInjected = (now) => {
    const text = renderMemories(store, policy, new Date(now))
    const lines = text.split('\n').filter(Boolean)
    return store
      .listByAspectStatus('progressive', 'active')
      .filter((m) => lines.some((l) => l.includes(m.content)))
      .map((m) => m.id)
  }

  const items = [
    {
      id: 'selfcheck-1',
      at: base,
      channel: 'system_prompt',
      q: '渲染：进行中',
      staleIds: new Set(),
      injectedIds: () => renderInjected(base),
      check: (ids) => ids.has(running.id) && !ids.has(future.id),
      expect: 'running injected; future-start hidden (C10)',
    },
    {
      id: 'selfcheck-2',
      at: base + 8 * DAY,
      channel: 'system_prompt',
      q: '渲染：TTL 过期',
      staleIds: new Set([running.id]),
      injectedIds: () => renderInjected(base + 8 * DAY),
      check: (ids) => !ids.has(running.id),
      expect: 'expired progressive hidden (C1/C2)',
    },
    {
      id: 'selfcheck-3',
      at: base,
      channel: 'tool_retrieval',
      q: '用户身份 学历',
      staleIds: new Set([stale.id]),
      injectedIds: async () => {
        const hits = await search('用户身份 学历', store, fake, policy, base, { topK: 2 })
        return hits.map((h) => h.id)
      },
      check: (ids) => ids.has(current.id),
      expect: 'current fact retrieved; stale value carries stale_gt',
    },
    {
      id: 'selfcheck-4',
      at: base + 100 * DAY,
      channel: 'system_prompt',
      q: '渲染：全部过期后',
      staleIds: new Set(),
      injectedIds: () => renderInjected(base + 100 * DAY),
      check: (ids) => ids.size === 0,
      expect: 'all progressive expired → empty injection',
    },
    {
      id: 'selfcheck-5',
      at: base,
      channel: 'system_prompt',
      q: '渲染：已完成事实不应进系统提示',
      staleIds: new Set([stale.id, current.id]),
      injectedIds: () => renderInjected(base),
      check: (ids) => !ids.has(stale.id) && !ids.has(current.id),
      expect: 'perfect memories never in system-prompt section',
    },
  ]

  const { id: tokenizerId, count } = await loadTokenizer()
  const repoCommit = gitCommitCwd()
  const ledger = new Ledger()
  const traces = []

  for (const item of items) {
    const t0 = Date.now()
    const ids = await item.injectedIds()
    const retrieveMs = Date.now() - t0
    const all = [running, future, current, stale]
    const injected = all
      .filter((m) => ids.includes(m.id))
      .map((m) => ({
        memory_id: m.id,
        aspect: m.aspect,
        anchor_type: m.anchor.type,
        status: store.getMemory(m.id).status,
        expires_at_ms: null,
        suppressed_by: null,
        stale_gt: item.staleIds.has(m.id),
        stale_reason: item.staleIds.has(m.id) ? (m.id === stale.id ? 'pre_update_value' : 'ttl_expired') : null,
        created_at_ms: m.createdAt,
        age_days: Math.round(((item.at - m.createdAt) / DAY) * 10) / 10,
        score: 1,
        tokens: count(m.content),
        included: true,
      }))
    traces.push({
      run_id: `selfcheck-${repoCommit}-${item.id}`,
      system: 'selfcheck',
      bench: 'smoke',
      variant: 'selfcheck',
      item_id: item.id,
      query: item.q,
      query_time_ms: item.at,
      channel: item.channel,
      injected,
      candidate_count: injected.length,
      budget_tokens: 2000,
      injected_tokens: injected.reduce((a, b) => a + b.tokens, 0),
      answer: injected.length > 0 ? injected.map((i) => i.memory_id).join(',') : '（无相关记忆）',
      correct: item.check(new Set(ids)),
      judge: null,
      versions: baseVersions(policy, tokenizerId, { llmModel: 'none (offline selfcheck)', staleAnnotator: 'rules@v1 (selfcheck)' }),
      cost: { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0, cny: 0, cache_hit: false },
      timing_ms: { ingest: 0, retrieve: retrieveMs, answer: 0 },
    })
    ledger.add(item.id, { cny: 0, calls: 0 })
  }

  const out = opts.out ?? path.join(HERE, 'results', 'selfcheck', 'traces.jsonl')
  writeTraces(out, traces)
  const errors = validateTraces(traces)
  if (errors.length > 0) {
    console.error(`✘ selfcheck trace 校验失败 (${errors.length}):`)
    for (const e of errors.slice(0, 10)) console.error(`  ${e}`)
    closeDatabase(schema)
    return 1
  }
  const runtime = sir(traces)
  const guard = guardEstimate(ledger.totals())
  console.log(`✔ selfcheck: ${traces.length} 条 trace 校验通过 → ${out}`)
  console.log(`  注入条数=${runtime.injected_total}  stale=${runtime.stale_injected}  SIR-i=${runtime.sir_i.toFixed(4)}  SIR=${runtime.sir.toFixed(4)}`)
  console.log(`  ${ledger.report()} · guard=${guard.ok ? 'ok' : guard.violations.join('; ')}`)
  console.log('  复算: node eval/lib/trace.mjs --validate <out> && node eval/lib/trace.mjs --sir <out>')
  closeDatabase(schema)
  return 0
}

// ── P1.5 dry-run: 7 systems × 3 synthetic items, offline ────────────

async function runDryRun(opts) {
  const { ManualClock } = await import('../lib/clock.js')
  const { openDatabase, closeDatabase } = await import('../lib/schema.js')
  const { Store } = await import('../lib/store.js')
  const { FakeEmbedProvider } = await import('../lib/store/embed.js')
  const { loadPolicy } = await import('../lib/policy.js')
  const { loadTokenizer } = await import('./lib/tokens.mjs')
  const { validateTraces, writeTraces } = await import('./lib/trace.mjs')
  const { SYSTEM_FACTORIES, SYSTEM_NAMES } = await import('./systems/index.mjs')

  const base = Date.parse('2026-01-01T00:00:00Z')
  const clock = new ManualClock(base)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-dryrun-'))
  fs.copyFileSync(fileURLToPath(new URL('../templates/policy.yaml.example', import.meta.url)), path.join(dir, 'policy.yaml'))
  const policy = loadPolicy(path.join(dir, 'policy.yaml'))
  const schema = openDatabase(path.join(dir, 'dryrun.db'))
  const store = new Store(schema, null, clock)
  const embed = new FakeEmbedProvider(768)
  const act = policy.activation.base_weights.agent ?? 1
  const mk = (content, aspect, anchor, extra = {}) =>
    store.insertMemory({ content, aspect, anchor, source: 'agent', activation: act, ...extra })
  mk('训练任务在跑', 'progressive', { type: 'none' })
  mk('用户是研究生', 'perfect', { type: 'point', start: '2025-12-01' }, { embedding: await embed.embedOne('用户 研究生') })
  mk('用户是大学生', 'perfect', { type: 'point', start: '2025-03-01' }, { embedding: await embed.embedOne('用户 大学生') })
  const history = [
    { peer: 'user', content: '我们决定采用双通道方案', createdAt: base - 3 * DAY },
    { peer: 'assistant', content: '好的，已记录双通道方案', createdAt: base - 3 * DAY + 1000 },
    { peer: 'user', content: '论文初稿已经完成', createdAt: base - 2 * DAY },
  ]
  for (const h of history) store.insertConversation('dryrun', h.peer, h.content)

  const { id: tokenizerId, count } = await loadTokenizer()
  const budgetTokens = Number(opts['budget-tokens'] ?? 0) || 2000
  const reader = async ({ injected }) => ({
    answer: injected.length > 0 ? injected.map((i) => i.content).join(' / ') : '（闭卷）',
    calls: 0,
  })
  const ctx = { policy, store, embed, clock, reader, countTokens: count, budgetTokens, history, llm: null }
  const items = [
    { id: 'dry-1', q: '训练任务', now: base, groundTruth: '训练任务在跑' },
    { id: 'dry-2', q: '用户身份', now: base, groundTruth: '研究生' },
    { id: 'dry-3', q: '下一阶段迭代', now: base, groundTruth: null },
  ]
  const names = opts.system ? [opts.system] : SYSTEM_NAMES
  const traces = []
  for (const name of names) {
    const factory = SYSTEM_FACTORIES[name]
    if (!factory) {
      console.error(`✘ 未知 system: ${name}`)
      closeDatabase(schema)
      return 2
    }
    let sys
    try {
      sys = factory(ctx)
    } catch (e) {
      console.error(`✘ ${name} 装配失败: ${e.message}`)
      closeDatabase(schema)
      return 1
    }
    for (const item of items) {
      let r
      try {
        r = await sys.query({ query: item.q, now: item.now })
      } catch (e) {
        console.error(`✘ ${name}/${item.id} 运行失败: ${e.message}`)
        closeDatabase(schema)
        return 1
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
          stale_gt: false,
          stale_reason: null,
          created_at_ms: m?.createdAt ?? item.now,
          age_days: 0,
          score: 1,
          tokens: i.tokens,
          included: true,
        }
      })
      traces.push({
        run_id: `dryrun-${baseVersions(policy, tokenizerId).repo_commit}-${name}-${item.id}`,
        system: name,
        bench: 'timesuite',
        variant: 'dryrun',
        item_id: `${name}-${item.id}`,
        query: item.q,
        query_time_ms: item.now,
        channel: r.channel,
        injected,
        candidate_count: injected.length,
        budget_tokens: budgetTokens,
        injected_tokens: r.injected_tokens,
        answer: r.answer,
        correct:
          item.groundTruth === null
            ? r.injected.length === 0
            : r.injected.map((i) => i.content).join(' ').includes(item.groundTruth),
        judge: null,
        versions: baseVersions(policy, tokenizerId),
        cost: { llm_calls: r.calls, prompt_tokens: 0, completion_tokens: 0, cny: 0, cache_hit: false },
        timing_ms: { ingest: 0, retrieve: 0, answer: 0 },
      })
    }
  }

  const out = opts.out ?? path.join(HERE, 'results', 'dryrun', 'traces.jsonl')
  writeTraces(out, traces)
  const errors = validateTraces(traces)
  if (errors.length > 0) {
    console.error(`✘ dry-run trace 校验失败 (${errors.length}):`)
    for (const e of errors.slice(0, 10)) console.error(`  ${e}`)
    closeDatabase(schema)
    return 1
  }
  console.log(`✔ dry-run: ${names.length} 系统 × ${items.length} 题 = ${traces.length} trace → ${out}`)
  for (const name of names) {
    const mine = traces.filter((t) => t.system === name)
    console.log(`  ${name.padEnd(12)} injected=${mine.reduce((a, t) => a + t.injected.length, 0)} tokens=${mine.reduce((a, t) => a + t.injected_tokens, 0)}`)
  }
  closeDatabase(schema)
  return 0
}

// ── main ────────────────────────────────────────────────────────────

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    console.error(`✘ ${e.message}`)
    console.error('使用 --help 查看用法。')
    return 2
  }
  if (opts.help || opts.h || argv.length === 0) {
    console.log(usage())
    return 0
  }
  if (opts.selfcheck) {
    try {
      return await runSelfCheck(opts)
    } catch (e) {
      console.error('✘ selfcheck 异常:', e)
      return 1
    }
  }
  if (opts['dry-run']) {
    try {
      return await runDryRun(opts)
    } catch (e) {
      console.error('✘ dry-run 异常:', e)
      return 1
    }
  }
  for (const req of ['bench', 'system', 'config', 'out']) {
    if (!opts[req]) {
      console.error(`✘ 缺少必选参数 --${req}`)
      console.error('使用 --help 查看用法。')
      return 2
    }
  }
  console.error('真实 bench 运行需要 systems/adapters（P1.5/P1.6）；当前可用 --selfcheck。')
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
