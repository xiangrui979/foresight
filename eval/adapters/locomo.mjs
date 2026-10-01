#!/usr/bin/env node
/**
 * LoCoMo adapter (Task 1.6 / SPEC §2: A→user, B→assistant; cat2 secondary).
 *
 * Official shape (locomo10.json): [{ conversation: {speaker_a, speaker_b,
 * session_N: [{speaker, text}], session_N_date_time: "..."}, qa: [...] }, ...]
 *
 * CLI: --selfcheck | --check <file>
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateItem, selfcheckBench } from './common.mjs'

/** "1:56 pm on 8 May, 2023" → ISO (best effort; unparseable → null). */
export function parseLocomoTime(s) {
  if (typeof s !== 'string') return null
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})/i)
  if (!m) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  const [, hh, mm, ap, dd, monthName, yyyy] = m
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const month = months.indexOf(monthName.toLowerCase()) + 1
  let hour = Number(hh) % 12
  if (ap.toLowerCase() === 'pm') hour += 12
  const d = new Date(Date.UTC(Number(yyyy), month - 1, Number(dd), hour, Number(mm)))
  return d.toISOString()
}

export function normalizeLocomo(raw, idx = 0) {
  const conv = raw.conversation ?? raw
  const a = conv.speaker_a ?? 'A'
  const sessions = []
  for (const key of Object.keys(conv)) {
    const m = /^session_(\d+)$/.exec(key)
    if (!m || !Array.isArray(conv[key])) continue
    const dt = parseLocomoTime(conv[`${key}_date_time`])
    sessions.push({
      session_id: key,
      date: dt ? dt.slice(0, 10) : null,
      turns: conv[key].map((t) => ({
        role: t.speaker === a ? 'user' : 'assistant',
        text: String(t.text ?? ''),
        at: dt ?? undefined,
      })),
    })
  }
  sessions.sort((x, y) => Number(/(\d+)/.exec(x.session_id)[1]) - Number(/(\d+)/.exec(y.session_id)[1]))
  const qa = Array.isArray(raw.qa) ? raw.qa[0] : (raw.qa ?? {})
  const lastDt = sessions.at(-1)?.date
  return {
    id: String(raw.sample_id ?? `locomo-${idx}`),
    sessions,
    question: String(qa.question ?? ''),
    answer: String(qa.answer ?? ''),
    question_date: lastDt ? `${lastDt}T00:00:00Z` : '',
    stale: raw.stale ?? [],
    expected: raw.expected,
    category: qa.category ?? null,
    evidence: qa.evidence ?? [],
  }
}

export function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const arr = Array.isArray(raw) ? raw : (raw.data ?? [])
  const items = arr.map((r, i) => normalizeLocomo(r, i))
  const bad = []
  items.forEach((it, i) => {
    const errs = validateItem(it)
    if (errs.length > 0) bad.push(`${it.id ?? i}: ${errs.join('; ')}`)
  })
  if (bad.length > 0) throw new Error(`LoCoMo 校验失败:\n${bad.join('\n')}`)
  return items
}

function check(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const arr = Array.isArray(raw) ? raw : (raw.data ?? [])
  const cats = {}
  let qaCount = 0
  for (const r of arr) {
    for (const qa of r.qa ?? []) {
      qaCount += 1
      const c = qa.category ?? 'unknown'
      cats[c] = (cats[c] ?? 0) + 1
    }
  }
  console.log(`LoCoMo: ${arr.length} 段对话，${qaCount} 条 QA`)
  console.log(`  category 分布: ${JSON.stringify(cats)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--selfcheck')) {
    selfcheckBench('locomo').then((code) => {
      process.exitCode = code
    })
  } else if (args[0] === '--check') {
    try {
      check(args[1])
    } catch (e) {
      console.error(`✘ ${e.message}`)
      process.exitCode = 1
    }
  } else {
    console.log('locomo.mjs — 使用 --selfcheck 或 --check <file>')
  }
}
