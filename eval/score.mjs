#!/usr/bin/env node
/**
 * ForeSight scorer (Task 1.8 / P1.8).
 *
 * Deterministic-first: uses trace `correct` (timesuite expected behaviour /
 * judge). Summarises per-system accuracy, SIR-i/SIR (ground truth), injected
 * tokens (mean/p95), calls; emits JSON + markdown; pairs two systems on the
 * same items for McNemar + paired bootstrap (DECISIONS §6).
 *
 * CLI:
 *   node eval/score.mjs --traces <file...> [--out summary.json] [--md summary.md]
 *                       [--pair foresight,recency]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sir, loadTraces } from './lib/trace.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function percentile(sorted, q) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

export function summarize(traces) {
  const bySystem = new Map()
  for (const t of traces) {
    if (!bySystem.has(t.system)) bySystem.set(t.system, [])
    bySystem.get(t.system).push(t)
  }
  const out = {}
  for (const [system, rows] of bySystem) {
    const answered = rows.filter((r) => r.correct !== null && r.correct !== undefined)
    const tokens = rows.map((r) => r.injected_tokens ?? 0).sort((a, b) => a - b)
    const s = sir(rows)
    out[system] = {
      n: rows.length,
      answered: answered.length,
      accuracy: answered.length > 0 ? answered.filter((r) => r.correct).length / answered.length : null,
      sir_i: s.sir_i,
      sir: s.sir,
      injected_total: s.injected_total,
      stale_injected: s.stale_injected,
      tokens_mean: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
      tokens_p95: percentile(tokens, 0.95),
      llm_calls: rows.reduce((a, r) => a + (r.cost?.llm_calls ?? 0), 0),
    }
  }
  return out
}

export function pairKey(trace, system) {
  const id = String(trace.item_id ?? '')
  const prefix = `${system}-`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

export function pairSystems(traces, systemA, systemB, { stats, seed = 0 } = {}) {
  const a = new Map()
  const b = new Map()
  for (const t of traces) {
    if (t.system === systemA) a.set(pairKey(t, systemA), t)
    if (t.system === systemB) b.set(pairKey(t, systemB), t)
  }
  const keys = [...a.keys()].filter((k) => b.has(k))
  let bothRight = 0
  let bothWrong = 0
  let aOnly = 0
  let bOnly = 0
  const accuracyDiffs = []
  const sirDiffs = []
  for (const k of keys) {
    const ta = a.get(k)
    const tb = b.get(k)
    if (ta.correct !== null && tb.correct !== null) {
      if (ta.correct && tb.correct) bothRight += 1
      else if (!ta.correct && !tb.correct) bothWrong += 1
      else if (ta.correct) aOnly += 1
      else bOnly += 1
      accuracyDiffs.push(Number(ta.correct) - Number(tb.correct))
    }
    const sa = ta.injected?.filter((i) => i.included !== false && i.stale_gt).length ?? 0
    const ta2 = ta.injected?.filter((i) => i.included !== false).length ?? 0
    const sb = tb.injected?.filter((i) => i.included !== false && i.stale_gt).length ?? 0
    const tb2 = tb.injected?.filter((i) => i.included !== false).length ?? 0
    sirDiffs.push((ta2 === 0 ? 0 : sa / ta2) - (tb2 === 0 ? 0 : sb / tb2))
  }
  const result = {
    pair: [systemA, systemB],
    paired_items: keys.length,
    mcnemar: { a_only_correct: aOnly, b_only_correct: bOnly, both_correct: bothRight, both_wrong: bothWrong },
    odds_ratio: bOnly === 0 ? null : aOnly / bOnly,
  }
  if (stats) result.mcnemar_p = stats.mcnemarExact(aOnly, bOnly)
  const boot = stats ? stats.pairedBootstrapCI(accuracyDiffs, { seed }) : null
  result.accuracy_diff = boot ? { mean: boot.mean, ci95: [boot.lo, boot.hi], n: boot.n } : null
  const bootSir = stats ? stats.pairedBootstrapCI(sirDiffs, { seed: seed + 1 }) : null
  result.sir_i_diff = bootSir ? { mean: bootSir.mean, ci95: [bootSir.lo, bootSir.hi], n: bootSir.n } : null
  return result
}

function fmt(v, digits = 4) {
  return v === null || v === undefined ? 'n/a' : Number(v).toFixed(digits)
}

function markdown(summary, pairs) {
  const lines = ['# ForeSight eval summary', '']
  lines.push('| system | n | accuracy | SIR-i | SIR | tokens mean | tokens p95 | calls |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const [sys, m] of Object.entries(summary)) {
    lines.push(`| ${sys} | ${m.n} | ${fmt(m.accuracy)} | ${fmt(m.sir_i)} | ${fmt(m.sir)} | ${m.tokens_mean.toFixed(1)} | ${m.tokens_p95 ?? 'n/a'} | ${m.llm_calls} |`)
  }
  for (const p of pairs ?? []) {
    lines.push('', `## Pair ${p.pair[0]} vs ${p.pair[1]}（paired n=${p.paired_items}）`, '')
    lines.push(`- McNemar: a_only=${p.mcnemar.a_only_correct}, b_only=${p.mcnemar.b_only_correct}, both=${p.mcnemar.both_correct}/${p.mcnemar.both_wrong}, p=${fmt(p.mcnemar_p)}`)
    if (p.accuracy_diff) lines.push(`- accuracy diff (a−b): ${fmt(p.accuracy_diff.mean)}  95% CI [${fmt(p.accuracy_diff.ci95[0])}, ${fmt(p.accuracy_diff.ci95[1])}]`)
    if (p.sir_i_diff) lines.push(`- SIR-i diff (a−b): ${fmt(p.sir_i_diff.mean)}  95% CI [${fmt(p.sir_i_diff.ci95[0])}, ${fmt(p.sir_i_diff.ci95[1])}]`)
  }
  return lines.join('\n') + '\n'
}

function reviewSample(traces, n = 10) {
  const rows = traces.slice(0, n)
  const lines = ['# 人工抽查样本（Task 1.8：10 条待人工判定）', '', '| system | item | query | answer | injected | correct(机器) |', '|---|---|---|---|---|---|']
  for (const t of rows) {
    const inj = (t.injected ?? []).map((i) => i.memory_id).join(', ')
    lines.push(`| ${t.system} | ${t.item_id} | ${t.query.replace(/\|/g, '/')} | ${String(t.answer).replace(/\|/g, '/').slice(0, 60)} | ${inj} | ${t.correct} |`)
  }
  return lines.join('\n') + '\n'
}

async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const traceFiles = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--traces') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) traceFiles.push(argv[++i])
    }
  }
  if (traceFiles.length === 0) {
    console.error('用法: node eval/score.mjs --traces <file...> [--out json] [--md md] [--pair a,b]')
    return 2
  }
  const traces = traceFiles.flatMap((f) => loadTraces(f))
  const stats = await import('./lib/stats.mjs')
  const summary = summarize(traces)
  const pairArg = opt('--pair')
  const pairs = pairArg ? [pairSystems(traces, ...pairArg.split(','), { stats })] : []
  const out = opt('--out') ?? path.join(HERE, 'results', 'summary.json')
  const md = opt('--md') ?? path.join(HERE, 'results', 'summary.md')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), traces: traceFiles, summary, pairs }, null, 2) + '\n')
  fs.writeFileSync(md, markdown(summary, pairs))
  fs.writeFileSync(path.join(path.dirname(md), 'review_sample.md'), reviewSample(traces, 10))
  console.log(`✔ summary: ${out}`)
  console.log(`✔ markdown: ${md}（+ review_sample.md 10 条待人工抽查）`)
  for (const [sys, m] of Object.entries(summary)) {
    console.log(`  ${sys.padEnd(12)} n=${m.n} acc=${fmt(m.accuracy)} SIR-i=${fmt(m.sir_i)} tokens=${m.tokens_mean.toFixed(1)}`)
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => {
    process.exitCode = c
  })
}
