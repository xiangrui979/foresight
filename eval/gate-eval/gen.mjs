#!/usr/bin/env node
/**
 * gate-eval item generator (Task 1.9 / C5).
 *
 * Deterministic: slot rotation only — regenerating MUST produce byte-identical
 * items.jsonl (frozen artifact; change = new pre-registration deviation).
 * 400 items = 200 zh + 200 en, covering 4 aspects × anchor types +
 * negation/pending/gnomic boundaries + English tense.
 *
 * CLI: node eval/gate-eval/gen.mjs [--out items.jsonl]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ITEMS_PATH = path.join(HERE, 'items.jsonl')

const ZH_S = ['部署任务', '接口联调', '模型训练', '数据库迁移', '文档撰写', '回归测试', '页面重构', '数据标注', '缓存服务', '日志系统']
const ZH_V = ['发布新版本', '开始测试', '迁移数据', '重构模块', '调整配置', '更新文档', '清理缓存', '扩容集群']
const ZH_X = ['深色主题', '简洁的报告', '中文回复', '单元测试', '类型标注', '本地模型']
const ZH_P = ['张工', '李工', '王工', '赵工']
const D = ['2026-01-05', '2026-02-10', '2026-03-15', '2026-04-20', '2026-05-25', '2026-06-30', '2026-07-04', '2026-08-09', '2026-09-14', '2026-10-19']

const EN_T = ['the deployment', 'the migration', 'the training run', 'the report', 'the release', 'the refactor', 'the review', 'the integration', 'the backup', 'the import']
const EN_C = ['Berlin', 'Lisbon', 'Osaka', 'Toronto', 'Helsinki']
const EN_MD = ['March 5', 'April 12', 'July 4', 'September 21', 'November 2']

function rotate(arr, i) {
  return arr[i % arr.length]
}

function buildZh() {
  const items = []
  const push = (text, aspect, anchor, hard = false) =>
    items.push({ id: `gzh-${String(items.length + 1).padStart(3, '0')}`, lang: 'zh', text, gold_aspect: aspect, gold_anchor_type: anchor, hard })
  for (let i = 0; i < 15; i++) push(`${rotate(ZH_S, i)}正在进行中`, 'progressive', 'none')
  for (let i = 0; i < 10; i++) push(`${rotate(ZH_S, i + 3)}还在跑`, 'progressive', 'none')
  for (let i = 0; i < 15; i++) push(`${rotate(ZH_S, i)}在 ${rotate(D, i)} 到 ${rotate(D, i + 1)} 期间进行中`, 'progressive', 'interval', true)
  for (let i = 0; i < 10; i++) push(`自 ${rotate(D, i)} 以来 ${rotate(ZH_S, i)} 持续进行`, 'progressive', 'open', true)
  for (let i = 0; i < 10; i++) push(`${rotate(ZH_S, i)}已完成`, 'perfect', 'point')
  for (let i = 0; i < 15; i++) push(`${rotate(ZH_S, i)}已于 ${rotate(D, i)} 完成`, 'perfect', 'point')
  for (let i = 0; i < 10; i++) push(`${rotate(ZH_S, i)}在 ${rotate(D, i)} 到 ${rotate(D, i + 2)} 期间完成`, 'perfect', 'interval', true)
  for (let i = 0; i < 5; i++) push(`${rotate(ZH_S, i)}做过`, 'perfect', 'point')
  for (let i = 0; i < 10; i++) push(`${rotate(ZH_S, i)}已经结束`, 'perfect', 'point')
  for (let i = 0; i < 15; i++) push(`明天会${rotate(ZH_V, i)}`, 'prospective', 'open')
  for (let i = 0; i < 5; i++) push(`${rotate(ZH_S, i)}将于 ${rotate(D, i)} 进行`, 'prospective', 'open', true)
  for (let i = 0; i < 10; i++) push(`用户计划 ${rotate(D, i)} ${rotate(ZH_V, i)}`, 'prospective', 'open')
  for (let i = 0; i < 10; i++) push(`用户打算${rotate(ZH_V, i + 2)}`, 'prospective', 'open')
  for (let i = 0; i < 10; i++) push(`迭代还没开始`, 'prospective', 'open', true)
  for (let i = 0; i < 10; i++) push(`用户喜欢${rotate(ZH_X, i)}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`用户不喝${i % 2 === 0 ? '咖啡' : '奶茶'}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`${rotate(ZH_S, i)}的负责人是${rotate(ZH_P, i)}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`用户习惯使用${rotate(ZH_X, i)}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`系统默认语言是${i % 2 === 0 ? '中文' : '英文'}`, 'gnomic', 'none')
  // adversarial：表面标记误导（rules 已知盲点，计入 hard；不修规则，如实计错）
  for (let i = 0; i < 10; i++) push(`用户不要${rotate(ZH_X, i)}`, 'gnomic', 'none', true)
  for (let i = 0; i < 10; i++) push(`${rotate(ZH_S, i)}即将上线`, 'prospective', 'open', true)
  return items
}

function buildEn() {
  const items = []
  const push = (text, aspect, anchor, hard = false) =>
    items.push({ id: `gen-${String(items.length + 1).padStart(3, '0')}`, lang: 'en', text, gold_aspect: aspect, gold_anchor_type: anchor, hard })
  for (let i = 0; i < 15; i++) push(`${rotate(EN_T, i)} is running`, 'progressive', 'none')
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i + 3)} was running`, 'progressive', 'none')
  for (let i = 0; i < 15; i++) push(`${rotate(EN_T, i)} is running from ${rotate(D, i)} to ${rotate(D, i + 1)}`, 'progressive', 'interval', true)
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i)} has been running since ${rotate(D, i)}`, 'progressive', 'open', true)
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i)} has been completed`, 'perfect', 'point')
  for (let i = 0; i < 15; i++) push(`${rotate(EN_T, i)} was completed on ${rotate(EN_MD, i)}`, 'perfect', 'point')
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i)} was completed from ${rotate(D, i)} to ${rotate(D, i + 2)}`, 'perfect', 'interval', true)
  for (let i = 0; i < 5; i++) push(`The user moved to ${rotate(EN_C, i)}`, 'perfect', 'point')
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i)} finished yesterday`, 'perfect', 'point')
  for (let i = 0; i < 15; i++) push(`${rotate(EN_T, i)} will start tomorrow`, 'prospective', 'open')
  for (let i = 0; i < 5; i++) push(`${rotate(EN_T, i)} will be deployed on ${rotate(EN_MD, i)}`, 'prospective', 'open', true)
  for (let i = 0; i < 10; i++) push(`The team plans to run ${rotate(EN_T, i)} next week`, 'prospective', 'open')
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i)} is going to run next Monday`, 'prospective', 'open')
  for (let i = 0; i < 10; i++) push(`${rotate(EN_T, i)} has not started yet`, 'prospective', 'open', true)
  for (let i = 0; i < 10; i++) push(`The user likes ${i % 2 === 0 ? 'green tea' : 'dark mode'}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`The user does not drink ${i % 2 === 0 ? 'coffee' : 'alcohol'}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`${rotate(EN_T, i)} runs every night`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`The user prefers ${i % 2 === 0 ? 'concise reports' : 'Chinese replies'}`, 'gnomic', 'none')
  for (let i = 0; i < 5; i++) push(`The user works as a ${i % 2 === 0 ? 'teacher' : 'designer'}`, 'gnomic', 'none')
  // adversarial：will 名词 / going to + 地点（表面标记误导；如实计错）
  const EN_PLACE = ['the gym', 'the office', 'the market', 'the lab', 'the studio']
  const EN_WILLNOUN = ['improve', 'win', 'change', 'learn', 'grow']
  for (let i = 0; i < 10; i++) push(`The user is going to ${rotate(EN_PLACE, i)}`, 'progressive', 'none', true)
  for (let i = 0; i < 10; i++) push(`The will to ${rotate(EN_WILLNOUN, i)} remains`, 'gnomic', 'none', true)
  return items
}

export function generateItems() {
  return [...buildZh(), ...buildEn()]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : ITEMS_PATH
  const items = generateItems()
  fs.writeFileSync(out, items.map((i) => JSON.stringify(i)).join('\n') + '\n')
  const byLang = items.reduce((a, i) => ((a[i.lang] = (a[i.lang] ?? 0) + 1), a), {})
  const byAspect = items.reduce((a, i) => ((a[i.gold_aspect] = (a[i.gold_aspect] ?? 0) + 1), a), {})
  console.log(`✔ gate-eval items: ${items.length} → ${out}`)
  console.log(`  lang=${JSON.stringify(byLang)} aspect=${JSON.stringify(byAspect)} hard=${items.filter((i) => i.hard).length}`)
}
