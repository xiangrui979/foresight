#!/usr/bin/env node
/**
 * gate-eval labeling + metrics (Task 1.9 / C5).
 *
 * Rules arm = offline (classifyByRules). LLM arm = optional, requires
 * DEEPSEEK_API_KEY (skipped + reported pending otherwise).
 *
 * CLI: node eval/gate-eval/label.mjs [--items items.jsonl] [--llm]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClassifyFn, classifyByRules } from '../../lib/gate/classify.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ITEMS_PATH = path.join(HERE, 'items.jsonl')
export const EVAL_NOW = new Date('2026-10-01T00:00:00Z')

export function loadItems(file = ITEMS_PATH) {
  return fs
    .readFileSync(file, 'utf8')
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

function accuracy(rows, key) {
  return rows.length === 0 ? null : rows.filter(key).length / rows.length
}

export function computeMetrics(rows) {
  const subset = (sel) => ({
    n: sel.length,
    aspect_acc: accuracy(sel, (r) => r.aspect_ok),
    anchor_acc: accuracy(sel, (r) => r.anchor_ok),
    joint_acc: accuracy(sel, (r) => r.aspect_ok && r.anchor_ok),
  })
  const confusionAspect = {}
  const confusionAnchor = {}
  for (const r of rows) {
    const aKey = `${r.gold_aspect ?? 'null'}→${r.pred_aspect ?? 'null'}`
    confusionAspect[aKey] = (confusionAspect[aKey] ?? 0) + 1
    const nKey = `${r.gold_anchor_type ?? 'null'}→${r.pred_anchor ?? 'null'}`
    confusionAnchor[nKey] = (confusionAnchor[nKey] ?? 0) + 1
  }
  return {
    ...subset(rows),
    by_lang: { zh: subset(rows.filter((r) => r.lang === 'zh')), en: subset(rows.filter((r) => r.lang === 'en')) },
    hard: subset(rows.filter((r) => r.hard)),
    confusion_aspect: confusionAspect,
    confusion_anchor: confusionAnchor,
  }
}

export function evaluateRules(items, now = EVAL_NOW) {
  const rows = items.map((it) => {
    const r = classifyByRules({}, now, it.text)
    const pred_aspect = r?.aspect ?? null
    const pred_anchor = r?.anchor?.type ?? null
    return { ...it, pred_aspect, pred_anchor, pred_source: r?.source ?? null, aspect_ok: pred_aspect === it.gold_aspect, anchor_ok: pred_anchor === it.gold_anchor_type }
  })
  return { arm: 'rules', rows, metrics: computeMetrics(rows) }
}

/** Optional LLM arm; requires a key-backed client (see lib/llm.mjs). */
export async function evaluateLlm(items, { client, policy, now = EVAL_NOW } = {}) {
  const llmPolicy = structuredClone(policy)
  llmPolicy.gate = { ...llmPolicy.gate, classifier: 'llm' }
  const fn = buildClassifyFn(llmPolicy, client)
  const rows = []
  for (const it of items) {
    let pred_aspect = null
    let pred_anchor = null
    let source = null
    try {
      const r = await fn({ now, text: it.text })
      pred_aspect = r?.aspect ?? null
      pred_anchor = r?.anchor?.type ?? null
      source = r?.source ?? null
    } catch {
      /* counted as null */
    }
    rows.push({ ...it, pred_aspect, pred_anchor, pred_source: source, aspect_ok: pred_aspect === it.gold_aspect, anchor_ok: pred_anchor === it.gold_anchor_type })
  }
  return { arm: 'llm', rows, metrics: computeMetrics(rows) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const items = loadItems()
  const { metrics } = evaluateRules(items)
  console.log(`rules: n=${metrics.n} aspect_acc=${metrics.aspect_acc.toFixed(4)} anchor_acc=${metrics.anchor_acc.toFixed(4)} joint=${metrics.joint_acc.toFixed(4)}`)
  console.log(`  zh aspect=${metrics.by_lang.zh.aspect_acc.toFixed(4)} · en aspect=${metrics.by_lang.en.aspect_acc.toFixed(4)} · hard aspect=${metrics.hard.aspect_acc.toFixed(4)}`)
}
