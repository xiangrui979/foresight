#!/usr/bin/env node
/**
 * gate-eval report (Task 1.9 / C5, G1 decision material).
 *
 * Rules arm always runs (offline). LLM arm runs only with
 * DEEPSEEK_API_KEY; otherwise recorded as pending (key-dependent deviation).
 *
 * CLI: node eval/gate-eval/report.mjs [--items items.jsonl] [--llm] [--out dir]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ITEMS_PATH, loadItems, evaluateRules, evaluateLlm } from './label.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const THRESHOLD = 0.8

function pct(v) {
  return v === null ? 'n/a' : (v * 100).toFixed(2) + '%'
}

function fmtSubset(name, m) {
  return `- ${name}: n=${m.n} aspect=${pct(m.aspect_acc)} anchor=${pct(m.anchor_acc)} joint=${pct(m.joint_acc)}`
}

function markdown(report) {
  const lines = ['# ForeSight gate-eval report（C5）', '']
  lines.push(`- items: ${report.items}（zh ${report.by_lang.zh} / en ${report.by_lang.en}）· hard ${report.hard} · now=${report.now}`)
  lines.push(`- rules aspect 准确率: **${pct(report.rules.metrics.aspect_acc)}**（阈值 ${THRESHOLD * 100}% → ${report.rules.pass ? 'PASS（维持方案 A）' : 'FAIL（G1 按 D16 切 B）'}）`)
  lines.push('')
  lines.push('## Rules arm')
  lines.push(fmtSubset('overall', report.rules.metrics))
  lines.push(fmtSubset('zh', report.rules.metrics.by_lang.zh))
  lines.push(fmtSubset('en', report.rules.metrics.by_lang.en))
  lines.push(fmtSubset('hard', report.rules.metrics.hard))
  lines.push('', '### aspect confusion (gold→pred)', '', '```', JSON.stringify(report.rules.metrics.confusion_aspect, null, 2), '```')
  lines.push('### anchor confusion (gold→pred)', '', '```', JSON.stringify(report.rules.metrics.confusion_anchor, null, 2), '```')
  lines.push('', '## LLM arm')
  if (report.llm.status === 'ok') {
    lines.push(fmtSubset('overall', report.llm.metrics))
    lines.push(fmtSubset('zh', report.llm.metrics.by_lang.zh))
    lines.push(fmtSubset('en', report.llm.metrics.by_lang.en))
  } else {
    lines.push(`- status: **${report.llm.status}**（${report.llm.note}）`)
  }
  lines.push('', '## 与第二标注者一致性（κ/AC1）', `- ${report.inter_annotator}`)
  return lines.join('\n') + '\n'
}

async function main() {
  const args = process.argv.slice(2)
  const itemsFile = args.includes('--items') ? args[args.indexOf('--items') + 1] : ITEMS_PATH
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(HERE, 'report')
  const wantLlm = args.includes('--llm')

  const items = loadItems(itemsFile)
  const rules = evaluateRules(items)
  rules.pass = rules.metrics.aspect_acc !== null && rules.metrics.aspect_acc >= THRESHOLD

  let llm = { status: 'pending', note: 'DEEPSEEK_API_KEY 未设置；LLM 对照臂待 key（偏离已登记）' }
  if (wantLlm && process.env.DEEPSEEK_API_KEY) {
    try {
      const { LlmClient } = await import('../lib/llm.mjs')
      const { loadPolicy } = await import('../../lib/policy.js')
      const policy = loadPolicy(fileURLToPath(new URL('../../templates/policy.yaml.example', import.meta.url)))
      const client = new LlmClient({ noCache: false })
      const res = await evaluateLlm(items, { client, policy })
      llm = { status: 'ok', metrics: res.metrics, usage: client.usage }
    } catch (e) {
      llm = { status: 'error', note: e.message }
    }
  } else if (wantLlm) {
    llm = { status: 'pending', note: '--llm 指定但 DEEPSEEK_API_KEY 缺失' }
  }

  const report = {
    generated_at: new Date().toISOString(),
    items: items.length,
    by_lang: { zh: items.filter((i) => i.lang === 'zh').length, en: items.filter((i) => i.lang === 'en').length },
    hard: items.filter((i) => i.hard).length,
    now: '2026-10-01T00:00:00Z',
    threshold: THRESHOLD,
    rules,
    llm,
    inter_annotator: '未采集第二标注者（R14 计划：G1 前人工抽检 40 条；κ/AC1 待补）',
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report))
  console.log(markdown(report))
  console.log(`✔ report → ${path.join(outDir, 'report.md')}`)
  return 0
}

main()
  .then((c) => {
    process.exitCode = c
  })
  .catch((e) => {
    console.error(`✘ ${e.message}`)
    process.exitCode = 1
  })
