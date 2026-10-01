#!/usr/bin/env node
/**
 * ForeSight judge infrastructure (Task 1.4 / D6).
 *
 * - Prompt files are immutable artifacts: the filename MUST start with the
 *   first 8 hex chars of sha256(content). `assertFrozenPrompt` fails loudly
 *   if a frozen prompt is edited without re-freezing (chain of custody).
 * - judge_id = `<model>@<promptHash12>` is recorded in every trace.
 * - Pluggable: createJudge({client, model, promptFile}) — the C-extension
 *   double-judge instantiates a second judge with another model/prompt.
 *
 * CLI:
 *   node eval/lib/judge.mjs --freeze <src.md> [outDir]
 *   node eval/lib/judge.mjs --selfcheck
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export function promptHash(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function loadJudgePrompt(file) {
  const content = fs.readFileSync(file, 'utf8')
  return { file, content, hash: promptHash(content) }
}

/** Verify filename hash prefix matches content; returns {content, hash}. */
export function assertFrozenPrompt(file) {
  const { content, hash } = loadJudgePrompt(file)
  const base = path.basename(file)
  const m = base.match(/^([0-9a-f]{8})-/)
  if (!m) {
    throw new Error(`judge prompt 文件名缺少 hash 前缀（<hash8>-name.md）: ${base}`)
  }
  if (m[1] !== hash.slice(0, 8)) {
    throw new Error(`judge prompt 内容已变更但文件名未更新: ${base}（当前内容 hash 前缀 ${hash.slice(0, 8)}）`)
  }
  return { content, hash }
}

/** Copy a draft prompt into the frozen namespace with its hash prefix. */
export function freezePrompt(srcFile, outDir) {
  const content = fs.readFileSync(srcFile, 'utf8')
  const hash = promptHash(content)
  fs.mkdirSync(outDir, { recursive: true })
  const dest = path.join(outDir, `${hash.slice(0, 8)}-${path.basename(srcFile)}`)
  fs.writeFileSync(dest, content)
  return { file: dest, hash }
}

/**
 * @param {{client:{call:Function}, promptFile:string, model:string}} opts
 */
export function createJudge({ client, promptFile, model }) {
  const { content, hash } = assertFrozenPrompt(promptFile)
  const promptHashShort = hash.slice(0, 12)
  const judgeId = `${model}@${promptHashShort}`
  return {
    judgeId,
    model,
    promptHash: promptHashShort,
    async judge({ query, answer, groundTruth, evidence = [] }) {
      const r = await client.call({
        model,
        system: content,
        user: JSON.stringify({ question: query, answer, ground_truth: groundTruth, evidence }),
        json: true,
        maxTokens: 256,
      })
      const raw = r.json?.label
      const label = raw === 'correct' || raw === 'incorrect' || raw === 'unknown' ? raw : 'unknown'
      return {
        judge_id: judgeId,
        model,
        prompt_hash: promptHashShort,
        label,
        reason: typeof r.json?.reason === 'string' ? r.json.reason : '',
        cache_hit: r.cacheHit,
      }
    },
  }
}

// ── selfcheck (offline) ─────────────────────────────────────────────

async function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selfcheck 失败: ${msg}`)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-judge-'))
  const src = path.join(dir, 'correctness.md')
  fs.writeFileSync(src, 'Judge prompt v1: output JSON {"label":"correct"|"incorrect"}.')
  const frozen = freezePrompt(src, path.join(dir, 'frozen'))
  assert(/^[0-9a-f]{8}-correctness\.md$/.test(path.basename(frozen.file)), `冻结文件名: ${path.basename(frozen.file)}`)
  assertFrozenPrompt(frozen.file)

  const client = {
    call: async (req) => {
      assert(req.system.includes('Judge prompt v1'), '系统提示来自冻结文件')
      return { json: { label: 'correct', reason: '匹配' }, cacheHit: false, content: '{}' }
    },
  }
  const judge = createJudge({ client, promptFile: frozen.file, model: 'gpt-4o' })
  assert(judge.judgeId === `gpt-4o@${frozen.hash.slice(0, 12)}`, `judge_id=${judge.judgeId}`)
  const r = await judge.judge({ query: 'q', answer: 'a', groundTruth: 'a' })
  assert(r.label === 'correct' && r.prompt_hash === frozen.hash.slice(0, 12), '判定结果字段')
  assert(r.judge_id === judge.judgeId, 'judge_id 入结果')

  const tampered = path.join(dir, 'frozen', path.basename(frozen.file))
  fs.appendFileSync(tampered, '\nmodified')
  let threw = false
  try {
    assertFrozenPrompt(tampered)
  } catch {
    threw = true
  }
  assert(threw, '冻结文件被修改后必须报错')

  console.log('✔ judge.mjs selfcheck 通过（冻结 hash 前缀 / judge_id / 篡改检测 / 可插拔）')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--selfcheck')) {
    selfCheck().catch((e) => {
      console.error(`✘ ${e.message}`)
      process.exitCode = 1
    })
  } else if (args[0] === '--freeze') {
    const srcFile = args[1]
    const outDir = args[2] ?? path.dirname(srcFile)
    if (!srcFile) {
      console.error('用法: node eval/lib/judge.mjs --freeze <src.md> [outDir]')
      process.exitCode = 2
    } else {
      const r = freezePrompt(srcFile, outDir)
      console.log(`✔ frozen: ${r.file}\n  sha256: ${r.hash}\n  judge_id 前缀: ${r.hash.slice(0, 12)}`)
    }
  } else {
    console.log('judge.mjs — 使用 --selfcheck / --freeze <src.md> [outDir]')
  }
}
