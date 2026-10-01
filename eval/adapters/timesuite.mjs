#!/usr/bin/env node
/**
 * timesuite adapter (Task 1.6): the native normalized JSONL format.
 * CLI: --selfcheck | --check <file>
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadJsonl, validateItem, selfcheckBench } from './common.mjs'

export function load(file) {
  const items = loadJsonl(file)
  const bad = []
  items.forEach((it, i) => {
    const errs = validateItem(it)
    if (errs.length > 0) bad.push(`${it?.id ?? i}: ${errs.join('; ')}`)
  })
  if (bad.length > 0) throw new Error(`timesuite 数据校验失败:\n${bad.join('\n')}`)
  return items
}

function check(file) {
  const items = load(file)
  const withExpected = items.filter((i) => i.expected).length
  console.log(`timesuite: ${items.length} 题（含 expected: ${withExpected}）`)
  console.log(`  stale 题: ${items.filter((i) => (i.stale ?? []).length > 0).length}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--selfcheck')) {
    selfcheckBench('timesuite').then((code) => {
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
    console.log('timesuite.mjs — 使用 --selfcheck 或 --check <file>')
  }
}
