#!/usr/bin/env node
/**
 * ForeSight eval statistics (Task 1.8, skeleton; P2/P4 fill in).
 *
 * Implements the pre-registered analysis plan (DECISIONS §6):
 *  - McNemar exact test for paired binary metrics;
 *  - paired bootstrap percentile CI (NO Wilson/Newcombe for paired diffs);
 *  - Holm / Benjamini-Hochberg multiplicity corrections;
 *  - effect sizes: Cohen's h, odds ratio;
 *  - seeded RNG so every number is reproducible from traces.
 *
 * Selfcheck: node eval/lib/stats.mjs --selfcheck
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Deterministic RNG (mulberry32) — seed recorded in the run config. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function binomPmf(k, n, p) {
  let logp = 0
  for (let i = 1; i <= k; i++) logp += Math.log((n - k + i) / i)
  logp += k * Math.log(p) + (n - k) * Math.log(1 - p)
  return Math.exp(logp)
}

/** Two-sided exact McNemar test. b/c = discordant pair counts. */
export function mcnemarExact(b, c) {
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  let cdf = 0
  for (let i = 0; i <= k; i++) cdf += binomPmf(i, n, 0.5)
  return Math.min(1, 2 * cdf)
}

/** Paired bootstrap percentile CI for the mean difference. */
export function pairedBootstrapCI(diffs, { iterations = 10000, seed = 0, alpha = 0.05 } = {}) {
  const n = diffs.length
  if (n === 0) return { mean: null, lo: null, hi: null, n: 0 }
  const mean = diffs.reduce((a, b) => a + b, 0) / n
  const rnd = mulberry32(seed)
  const means = new Array(iterations)
  for (let i = 0; i < iterations; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += diffs[(rnd() * n) | 0]
    means[i] = s / n
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor((alpha / 2) * iterations)]
  const hi = means[Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1)]
  return { mean, lo, hi, n }
}

function adjusted(pvals, method) {
  const m = pvals.length
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const out = new Array(m)
  let prev = 0
  if (method === 'holm') {
    order.forEach((o, rank) => {
      prev = Math.max(prev, Math.min(1, o.p * (m - rank)))
      out[o.i] = prev
    })
  } else {
    for (let rank = m - 1; rank >= 0; rank--) {
      const o = order[rank]
      const v = Math.min(1, o.p * (m / (rank + 1)))
      prev = rank === m - 1 ? v : Math.min(prev, v)
      out[o.i] = prev
    }
  }
  return out
}

export function holm(pvals) {
  return adjusted(pvals, 'holm')
}

export function bh(pvals) {
  return adjusted(pvals, 'bh')
}

/** Cohen's h for two proportions. */
export function cohensH(p1, p2) {
  return 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2))
}

/** Odds ratio from McNemar discordant pairs: b/c. */
export function oddsRatio(b, c) {
  if (c === 0) return b === 0 ? 1 : Infinity
  return b / c
}

// ── selfcheck ───────────────────────────────────────────────────────

function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selfcheck 失败: ${msg}`)
  }
  const p = mcnemarExact(10, 2)
  assert(Math.abs(p - 0.038574) < 1e-5, `McNemar exact 10/2 ≈ 0.03857, got ${p}`)
  assert(mcnemarExact(0, 0) === 1, 'empty → p=1')

  const ci = pairedBootstrapCI([1, 1, 0, 1, 0, 0, 1, 1, 1, 0], { seed: 42, iterations: 2000 })
  assert(ci.mean === 0.6, `mean=0.6, got ${ci.mean}`)
  assert(ci.lo <= ci.mean && ci.mean <= ci.hi, 'CI 包含均值')
  const ci2 = pairedBootstrapCI([1, 1, 0, 1, 0, 0, 1, 1, 1, 0], { seed: 42, iterations: 2000 })
  assert(ci.lo === ci2.lo && ci.hi === ci2.hi, '同 seed 可复现')

  const h = holm([0.01, 0.04, 0.03])
  assert(Math.abs(h[0] - 0.03) < 1e-12 && Math.abs(h[1] - 0.06) < 1e-12 && Math.abs(h[2] - 0.06) < 1e-12, `holm: ${h}`)
  const b = bh([0.01, 0.04, 0.03])
  assert(b[0] <= b[2] && b[2] <= b[1] + 1e-12, `bh 单调: ${b}`)

  assert(Math.abs(cohensH(0.7, 0.5) - 0.4115) < 1e-3, `cohensH: ${cohensH(0.7, 0.5)}`)
  assert(oddsRatio(10, 2) === 5, 'OR=b/c')

  console.log('✔ stats.mjs selfcheck 通过（McNemar exact / bootstrap CI / Holm / BH / 效应量 / seeded）')
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
    console.log('stats.mjs — 使用 --selfcheck；接口 mcnemarExact/pairedBootstrapCI/holm/bh/cohensH/oddsRatio。')
  }
}
