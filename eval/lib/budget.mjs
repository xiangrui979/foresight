#!/usr/bin/env node
/**
 * ForeSight eval budget guard (D20).
 *
 * 统一命名：EVAL_MAX_CNY（人民币口径，默认 300）+ EVAL_MAX_CALLS（硬顶，默认 50000）。
 * 主表双跑必须 --no-cache；成本按双跑 ×2 入模（见 cost.mjs）。
 * runner `--estimate` 先行；RUNLOG 每单元对账。
 *
 * 自检：node eval/lib/budget.mjs --selfcheck
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_MAX_CNY = Number(process.env.EVAL_MAX_CNY ?? 300)
export const DEFAULT_MAX_CALLS = Number(process.env.EVAL_MAX_CALLS ?? 50000)

/**
 * @param {{cny?:number, calls?:number}} estimate
 * @param {{maxCny?:number, maxCalls?:number}} [limits]
 */
export function guardEstimate(estimate, limits = {}) {
  const maxCny = limits.maxCny ?? DEFAULT_MAX_CNY
  const maxCalls = limits.maxCalls ?? DEFAULT_MAX_CALLS
  const violations = []
  if ((estimate.cny ?? 0) > maxCny) {
    violations.push(`成本 ${estimate.cny.toFixed(2)} CNY > EVAL_MAX_CNY=${maxCny}`)
  }
  if ((estimate.calls ?? 0) > maxCalls) {
    violations.push(`调用数 ${estimate.calls} > EVAL_MAX_CALLS=${maxCalls}`)
  }
  return { ok: violations.length === 0, violations, maxCny, maxCalls }
}

export class Ledger {
  constructor(limits = {}) {
    this.maxCny = limits.maxCny ?? DEFAULT_MAX_CNY
    this.maxCalls = limits.maxCalls ?? DEFAULT_MAX_CALLS
    this.entries = []
  }

  add(unit, { cny = 0, calls = 0, cacheHit = false } = {}) {
    this.entries.push({ unit, cny, calls, cacheHit, at: new Date().toISOString() })
  }

  totals() {
    return this.entries.reduce(
      (acc, e) => ({ cny: acc.cny + e.cny, calls: acc.calls + e.calls }),
      { cny: 0, calls: 0 }
    )
  }

  check() {
    return guardEstimate(this.totals(), { maxCny: this.maxCny, maxCalls: this.maxCalls })
  }

  report() {
    const t = this.totals()
    return `ledger: ${this.entries.length} 单元 · ${t.calls} 调用 · ¥${t.cny.toFixed(2)} / 帽 ¥${this.maxCny} · ${t.calls}/${this.maxCalls}`
  }
}

function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selfcheck 失败: ${msg}`)
  }

  const ok = guardEstimate({ cny: 250, calls: 40000 })
  assert(ok.ok, '未超帽应通过')
  assert(ok.violations.length === 0, '未超帽不应有 violation')

  const over = guardEstimate({ cny: 301, calls: 50001 })
  assert(!over.ok && over.violations.length === 2, '超帽应报 2 条 violation')

  const boundary = guardEstimate({ cny: 300, calls: 50000 })
  assert(boundary.ok, '恰好等于帽值不算超（<=）')

  const ledger = new Ledger({ maxCny: 10, maxCalls: 100 })
  ledger.add('lme-ku/foresight/1k', { cny: 4, calls: 40 })
  ledger.add('lme-ku/recency/1k', { cny: 4, calls: 40, cacheHit: false })
  assert(ledger.totals().cny === 8 && ledger.totals().calls === 80, 'ledger 汇总错误')
  assert(ledger.check().ok, 'ledger 未超帽应通过')
  ledger.add('timesuite/foresight/1k', { cny: 3, calls: 30 })
  assert(!ledger.check().ok, 'ledger 超帽应失败')

  console.log(`✔ budget.mjs selfcheck 通过（默认帽 ¥${DEFAULT_MAX_CNY} / ${DEFAULT_MAX_CALLS} 调用）`)
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
    console.log('budget.mjs — 使用 --selfcheck 运行自检；接口 guardEstimate / Ledger。')
  }
}
