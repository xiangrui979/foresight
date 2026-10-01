#!/usr/bin/env node
/**
 * seed 支持性探针（D19 / P0.6）
 *
 * 对 reader / judge 模型：同一 prompt + seed 重放 N 次，比较输出与 usage。
 * 用法：
 *   node eval/scripts/seed-probe.mjs --model deepseek-v4-flash
 *   node eval/scripts/seed-probe.mjs --model gpt-4o --endpoint https://api.openai.com/v1 --api-key-env OPENAI_API_KEY
 *
 * 退出码：0 探针完成；2 用法错误；3 缺少 API key；1 网络/接口错误。
 * 结论写回 eval/DECISIONS.md（§4 / Changelog / Deviations）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPT = '请随机列出 3 个颜色词，用英文逗号分隔，不要解释。'

function usage() {
  return `seed 支持性探针

用法:
  node eval/scripts/seed-probe.mjs [options]

选项:
  --model <name>         被测模型（默认 FORESIGHT_LLM_MODEL 或 deepseek-v4-flash）
  --endpoint <url>       OpenAI 兼容 endpoint（默认 FORESIGHT_LLM_BASE_URL 或 https://api.deepseek.com/v1）
  --api-key-env <VAR>    API key 环境变量名（默认 DEEPSEEK_API_KEY）
  --seed <int>           种子（默认 0）
  --runs <n>             重放次数（默认 3）
  --out <file>           结果 JSON 输出路径（默认 eval/results/seed-probe_<model>.json）
  --help, -h             显示帮助`
}

function parseArgs(argv) {
  const opts = {
    model: process.env.FORESIGHT_LLM_MODEL || 'deepseek-v4-flash',
    endpoint: (process.env.FORESIGHT_LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    seed: 0,
    runs: 3,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    const key = a.replace(/^--/, '')
    const value = argv[++i]
    if (value === undefined) throw new Error(`${a} 缺少取值`)
    if (key === 'model') opts.model = value
    else if (key === 'endpoint') opts.endpoint = value.replace(/\/+$/, '')
    else if (key === 'api-key-env') opts.apiKeyEnv = value
    else if (key === 'seed') opts.seed = Number(value)
    else if (key === 'runs') opts.runs = Number(value)
    else if (key === 'out') opts.out = value
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

async function callOnce({ endpoint, apiKey, model, seed }) {
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: PROMPT }],
      temperature: 0,
      seed,
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const json = JSON.parse(text)
  return { content: json.choices?.[0]?.message?.content ?? '', usage: json.usage ?? null }
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    console.error(`✘ ${e.message}`)
    console.error(usage())
    return 2
  }
  if (opts.help) {
    console.log(usage())
    return 0
  }
  const apiKey = process.env[opts.apiKeyEnv]
  if (!apiKey) {
    console.error(`✘ 缺少 API key：环境变量 ${opts.apiKeyEnv} 未设置。`)
    console.error('  设置后重跑；结果将用于 eval/DECISIONS.md §4 seed 结论。')
    return 3
  }

  const outputs = []
  const rawErrors = []
  for (let i = 0; i < opts.runs; i++) {
    try {
      outputs.push(await callOnce({ endpoint: opts.endpoint, apiKey, model: opts.model, seed: opts.seed }))
    } catch (e) {
      rawErrors.push(String(e.message ?? e))
    }
  }

  const contents = outputs.map((o) => o.content)
  const identical = contents.length > 0 && contents.every((c) => c === contents[0])
  let conclusion = 'seed_effective'
  let note = '各次输出存在差异；若 usage 亦不同，seed 未完全固定输出。'
  if (rawErrors.length > 0) {
    conclusion = 'api_error'
    note = `接口错误（可能是 seed 参数不被支持）：${rawErrors[0]}`
  } else if (identical) {
    conclusion = 'seed_effect_unobservable'
    note =
      'N 次输出完全一致。注意：这不能证明 seed 生效（温度 0 本身也可能稳定）；按预注册 D19，视为未验证，C-extension 使用扰动方案。'
  }

  const result = {
    probed_at: new Date().toISOString(),
    endpoint: opts.endpoint,
    model: opts.model,
    prompt: PROMPT,
    seed: opts.seed,
    runs: opts.runs,
    outputs_identical: identical,
    outputs: contents,
    usage: outputs.map((o) => o.usage),
    errors: rawErrors,
    conclusion,
    note,
  }

  const outFile = opts.out ?? path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'results', `seed-probe_${opts.model.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  console.log(`\n结果已写入 ${outFile}`)
  console.log('→ 把 conclusion 与 outputs_identical 抄入 eval/DECISIONS.md（§4 + Changelog）。')
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    console.error('✘ 探针异常:', e)
    process.exitCode = 1
  })
