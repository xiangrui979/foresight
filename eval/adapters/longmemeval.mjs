#!/usr/bin/env node
/**
 * LongMemEval adapter (Task 1.6 / SPEC §2-§3, D7).
 *
 * Official shape (cleaned 2025/09): array of items with
 *   { question_id, question, answer, question_date,
 *     haystack_sessions: [[{role, content}, ...], ...],
 *     haystack_dates: [...] }
 * Mapping: session i date → UTC; user+assistant both written (role tag);
 * assistant turns are secondary analysis only.
 *
 * CLI: --selfcheck | --check <file> [--variant s|m|oracle]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateItem, selfcheckBench } from './common.mjs'

export function normalizeLme(raw) {
  const id = String(raw.question_id ?? raw.id ?? 'unknown')
  const dates = raw.haystack_dates ?? []
  const sessions = (raw.haystack_sessions ?? []).map((turns, i) => {
    const date = dates[i] ?? raw.session_dates?.[i] ?? null
    const iso = typeof date === 'string' && date.length >= 10 ? `${date.slice(0, 10)}T00:00:00Z` : undefined
    return {
      session_id: `${id}-s${i}`,
      date: typeof date === 'string' ? date.slice(0, 10) : null,
      turns: (turns ?? []).map((t) => {
        const role = t.role === 'assistant' ? 'assistant' : 'user'
        return {
          role,
          text: String(t.content ?? t.text ?? ''),
          at: iso,
          ...(raw.facts?.[i] ? { facts: raw.facts[i] } : {}),
        }
      }),
    }
  })
  return {
    id,
    sessions,
    question: String(raw.question ?? ''),
    answer: String(raw.answer ?? ''),
    question_date: String(raw.question_date ?? raw.question_date_time ?? '').includes('T')
      ? String(raw.question_date ?? raw.question_date_time)
      : `${String(raw.question_date ?? '').slice(0, 10)}T00:00:00Z`,
    stale: raw.stale ?? [],
    expected: raw.expected,
  }
}

export function load(file, { variant = 's' } = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const arr = Array.isArray(raw) ? raw : (raw.data ?? raw.items ?? [])
  const items = arr.map(normalizeLme)
  const bad = []
  items.forEach((it, i) => {
    const errs = validateItem(it)
    if (errs.length > 0) bad.push(`${it.id ?? i}: ${errs.join('; ')}`)
  })
  if (bad.length > 0) throw new Error(`LongMemEval(${variant}) 校验失败:\n${bad.join('\n')}`)
  return items
}

function check(file, variant) {
  const items = load(file, { variant })
  const types = {}
  for (const it of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const t = it.question_type ?? it.type ?? 'unknown'
    types[t] = (types[t] ?? 0) + 1
  }
  console.log(`LongMemEval[${variant}]: ${items.length} 题`)
  console.log(`  题型: ${JSON.stringify(types)}`)
  console.log(`  双角色会话: ${items.filter((i) => i.sessions.some((s) => s.turns.some((t) => t.role === 'assistant'))).length} 题`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 's'
  if (args.includes('--selfcheck')) {
    selfcheckBench('longmemeval').then((code) => {
      process.exitCode = code
    })
  } else if (args[0] === '--check') {
    try {
      check(args[1], variant)
    } catch (e) {
      console.error(`✘ ${e.message}`)
      process.exitCode = 1
    }
  } else {
    console.log('longmemeval.mjs — 使用 --selfcheck 或 --check <file> [--variant s|m|oracle]')
  }
}
