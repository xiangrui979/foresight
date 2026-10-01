#!/usr/bin/env node
/**
 * ForeSight eval trace v2: load, validate, recompute SIR-i/SIR.
 *
 * Ground-truth first: stale judgement comes from `stale_gt` written by the
 * adapter annotator (frozen rules, eval/DECISIONS.md §12), never from judge.
 *
 * CLI:
 *   node eval/lib/trace.mjs --validate <file.jsonl|file.json>
 *   node eval/lib/trace.mjs --sir <file...>
 *   node eval/lib/trace.mjs --help
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SCHEMA_PATH = path.resolve(HERE, '..', 'schema', 'trace.schema.json')

export function loadTraces(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (file.endsWith('.jsonl')) {
    return text
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
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** Minimal JSON Schema subset validator (type/required/properties/items/enum/anyOf/minimum/minLength). */
export function validateAgainstSchema(value, schema, pathStr = '$', errors = []) {
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => {
      const errs = []
      validateAgainstSchema(value, s, pathStr, errs)
      return errs
    })
    if (!branches.some((e) => e.length === 0)) {
      errors.push(`${pathStr}: 不满足 anyOf 任一分支`)
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathStr}: ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)}`)
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = types.some((t) => {
      if (t === 'null') return value === null
      if (t === 'integer') return Number.isInteger(value)
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value)
      if (t === 'array') return Array.isArray(value)
      if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
      return typeof value === t
    })
    if (!ok) {
      errors.push(`${pathStr}: 期望 ${types.join('|')}，实际 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)
      return errors
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pathStr}: ${value} < minimum ${schema.minimum}`)
    }
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${pathStr}: 字符串长度 < ${schema.minLength}`)
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${pathStr}: 缺少必需字段 "${key}"`)
    }
    const props = schema.properties ?? {}
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateAgainstSchema(value[key], sub, `${pathStr}.${key}`, errors)
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => validateAgainstSchema(v, schema.items, `${pathStr}[${i}]`, errors))
  }
  return errors
}

export function validateTraces(traces, schemaPath = SCHEMA_PATH) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  const errors = []
  traces.forEach((t, i) => validateAgainstSchema(t, schema, `$[${i}]`, errors))
  return errors
}

/** SIR-i / SIR per eval/DECISIONS.md §1 (ground truth `stale_gt`, included items only). */
export function sir(traces) {
  let injectedTotal = 0
  let staleInjected = 0
  let queries = 0
  let staleQueries = 0
  for (const t of traces) {
    queries += 1
    const included = (t.injected ?? []).filter((m) => m.included !== false)
    const stale = included.filter((m) => m.stale_gt === true)
    injectedTotal += included.length
    staleInjected += stale.length
    if (stale.length > 0) staleQueries += 1
  }
  return {
    queries,
    injected_total: injectedTotal,
    stale_injected: staleInjected,
    sir_i: injectedTotal === 0 ? null : staleInjected / injectedTotal,
    sir: queries === 0 ? null : staleQueries / queries
  }
}

function printHelp() {
  console.log(`ForeSight eval trace v2

用法:
  node eval/lib/trace.mjs --validate <file.jsonl|file.json>
  node eval/lib/trace.mjs --sir <file...>

说明:
  --validate  按 eval/schema/trace.schema.json 校验 JSONL/JSON 中的每条 trace
  --sir       以 ground truth（stale_gt）复算 SIR-i（主）与 SIR（次）`)
}

function main(argv) {
  const [cmd, ...files] = argv
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp()
    return 0
  }
  if (files.length === 0) {
    console.error('缺少输入文件。使用 --help 查看用法。')
    return 2
  }
  if (cmd === '--validate') {
    let bad = 0
    let count = 0
    for (const f of files) {
      const traces = loadTraces(f)
      const errors = validateTraces(traces)
      count += traces.length
      if (errors.length) {
        bad += 1
        console.error(`✘ ${f}: ${errors.length} 个校验错误`)
        for (const e of errors.slice(0, 20)) console.error(`  ${e}`)
      } else {
        console.log(`✔ ${f}: ${traces.length} 条 trace 校验通过`)
      }
    }
    console.log(`—— 共 ${count} 条，${bad === 0 ? '全部通过' : `${bad} 个文件失败`}`)
    return bad === 0 ? 0 : 1
  }
  if (cmd === '--sir') {
    console.log('file\tqueries\tinjected\tstale_injected\tSIR-i\tSIR')
    for (const f of files) {
      const s = sir(loadTraces(f))
      console.log(
        `${f}\t${s.queries}\t${s.injected_total}\t${s.stale_injected}\t${s.sir_i === null ? 'n/a' : s.sir_i.toFixed(4)}\t${s.sir === null ? 'n/a' : s.sir.toFixed(4)}`
      )
    }
    return 0
  }
  console.error(`未知命令: ${cmd}`)
  printHelp()
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
