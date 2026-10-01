#!/usr/bin/env node
/**
 * ForeSight eval cost model (D20).
 *
 * 自下而上（每个 unit = 一次 system × dataset × budget 跑）：
 *   calls = ingest_classify×turns + derive×(turns/N) + summary×sessions
 *         + judge×questions + reader×questions + nudge×(turns/N) + dialectic×reason_calls
 *
 * 约定：
 *  - 主单元 `--no-cache` 双跑按 runs=2 入模（D1/D20）；
 *  - fullcontext 的超长 prompt 通过 tokensPerCall.reader.prompt 传入真实长度（D9）；
 *  - 价格表（每 1M tokens，CNY）在执行日抄录入 eval/DECISIONS.md §10，不硬编码于本文件。
 *
 * 自检：node eval/lib/cost.mjs --selfcheck
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const div = (n, everyN) => (everyN > 0 ? Math.ceil(n / everyN) : 0)

/**
 * @param {object} unit
 * @param {number} [unit.turns]             对话 turn 数（= 消息对数）
 * @param {number} [unit.sessions]          session 数
 * @param {number} [unit.questions]         问题数（reader/judge 的主单元）
 * @param {number} [unit.reasonCalls]       dialectic 调用数
 * @param {number} [unit.classifyPerTurn]   0 = rules gate；1 = LLM gate（C5 方案 B）
 * @param {number} [unit.deriveEveryN]      derive 触发周期（0 = 关闭）
 * @param {number} [unit.nudgeEveryN]       nudge 触发周期（0 = 关闭）
 * @param {boolean} [unit.summarySystem]    是否 summary 基线（每 session 一次）
 * @param {number} [unit.judgePerQuestion]  确定性评分时为 0
 * @param {number} [unit.runs]              1 = 单跑；2 = 主表双跑（--no-cache）
 */
export function estimateCalls(unit = {}) {
  const {
    turns = 0,
    sessions = 0,
    questions = 0,
    reasonCalls = 0,
    classifyPerTurn = 0,
    deriveEveryN = 0,
    nudgeEveryN = 0,
    summarySystem = false,
    judgePerQuestion = 1,
    runs = 1,
  } = unit

  const perRun = {
    ingest_classify: turns * classifyPerTurn,
    derive: div(turns, deriveEveryN),
    summary: summarySystem ? sessions : 0,
    judge: questions * judgePerQuestion,
    reader: questions,
    nudge: div(turns, nudgeEveryN),
    dialectic: reasonCalls,
  }
  const perRunTotal = Object.values(perRun).reduce((a, b) => a + b, 0)
  return { perRun, perRunTotal, runs, total: perRunTotal * runs }
}

/**
 * @param {ReturnType<typeof estimateCalls>} calls
 * @param {Record<string,{prompt:number,completion:number}>} tokensPerCall
 */
export function estimateUsage(calls, tokensPerCall = {}) {
  const runs = calls.runs ?? 1
  const usage = {}
  for (const [type, n] of Object.entries(calls.perRun)) {
    const spec = tokensPerCall[type] ?? { prompt: 0, completion: 0 }
    usage[type] = {
      calls: n * runs,
      prompt: n * runs * spec.prompt,
      completion: n * runs * spec.completion,
    }
  }
  return usage
}

export function totalUsage(usage) {
  return Object.values(usage).reduce(
    (acc, u) => ({
      calls: acc.calls + u.calls,
      prompt: acc.prompt + u.prompt,
      completion: acc.completion + u.completion,
    }),
    { calls: 0, prompt: 0, completion: 0 }
  )
}

/**
 * @param {ReturnType<typeof estimateUsage>} usage
 * @param {Record<string,{inCny:number,outCny:number}>} priceTable 每 1M tokens 的 CNY 价格
 */
export function costOf(usage, priceTable) {
  let cny = 0
  const missing = []
  for (const [type, u] of Object.entries(usage)) {
    const price = priceTable[type]
    if (!price) {
      if (u.calls > 0) missing.push(type)
      continue
    }
    cny += (u.prompt * price.inCny + u.completion * price.outCny) / 1e6
  }
  return { cny, missing }
}

function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selfcheck 失败: ${msg}`)
  }

  const calls = estimateCalls({
    turns: 100,
    sessions: 10,
    questions: 60,
    reasonCalls: 2,
    classifyPerTurn: 0,
    deriveEveryN: 20,
    nudgeEveryN: 10,
    summarySystem: false,
    judgePerQuestion: 1,
    runs: 2,
  })
  assert(calls.perRun.ingest_classify === 0, `rules gate 应为 0 调用，得 ${calls.perRun.ingest_classify}`)
  assert(calls.perRun.derive === 5, `derive 100/20=5，得 ${calls.perRun.derive}`)
  assert(calls.perRun.nudge === 10, `nudge 100/10=10，得 ${calls.perRun.nudge}`)
  assert(calls.perRun.reader === 60 && calls.perRun.judge === 60, 'reader/judge 应各 60')
  assert(calls.perRunTotal === 137, `perRun 应为 137，得 ${calls.perRunTotal}`)
  assert(calls.total === 274, `双跑 ×2 应为 274，得 ${calls.total}`)

  const llmGate = estimateCalls({ turns: 100, classifyPerTurn: 1 })
  assert(llmGate.total === 100, `LLM gate 应按 turns 计 100，得 ${llmGate.total}`)

  const tokensPerCall = {
    reader: { prompt: 2000, completion: 200 },
    judge: { prompt: 1500, completion: 50 },
    derive: { prompt: 4000, completion: 300 },
    nudge: { prompt: 2500, completion: 150 },
    dialectic: { prompt: 3000, completion: 250 },
    summary: { prompt: 8000, completion: 400 },
  }
  const usage = estimateUsage(calls, tokensPerCall)
  const total = totalUsage(usage)
  assert(
    total.calls === 274 &&
      total.prompt === 2 * (5 * 4000 + 60 * 2000 + 60 * 1500 + 10 * 2500 + 2 * 3000) &&
      total.completion === 2 * (5 * 300 + 60 * 200 + 60 * 50 + 10 * 150 + 2 * 250),
    `token 汇总不符（双跑 ×2）: ${JSON.stringify(total)}`
  )

  const priceTable = {
    reader: { inCny: 1, outCny: 2 },
    judge: { inCny: 1, outCny: 2 },
    derive: { inCny: 1, outCny: 2 },
    nudge: { inCny: 1, outCny: 2 },
    dialectic: { inCny: 1, outCny: 2 },
  }
  const { cny, missing } = costOf(usage, priceTable)
  assert(missing.length === 0, `价格表不应缺项: ${missing}`)
  const expected =
    (2 *
      (5 * 4000 * 1 + 5 * 300 * 2 + 60 * 2000 * 1 + 60 * 200 * 2 + 60 * 1500 * 1 + 60 * 50 * 2 + 10 * 2500 * 1 + 10 * 150 * 2 + 2 * 3000 * 1 + 2 * 250 * 2)) /
    1e6
  assert(Math.abs(cny - expected) < 1e-9, `成本不符: ${cny} != ${expected}`)

  const missingPrice = costOf(usage, {})
  assert(missingPrice.missing.includes('reader'), '缺价格时必须报告 missing')

  console.log('✔ cost.mjs selfcheck 通过（公式 / 双跑 ×2 / LLM gate / 价格缺项）')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selfcheck')) {
    try {
      selfCheck()
    } catch (e) {
      console.error(`✘ ${e.message}`)
      process.exitCode = 1
    }
  } else {
    console.log('cost.mjs — 使用 --selfcheck 运行自检；API 见 eval/DECISIONS.md §10。')
  }
}
