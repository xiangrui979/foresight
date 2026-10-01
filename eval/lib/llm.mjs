#!/usr/bin/env node
/**
 * ForeSight eval LLM client (Task 1.4 / D1 + D6).
 *
 * - content-hash cache: identical requests hit disk, zero API calls;
 * - `--no-cache` (noCache option): reads are bypassed for real double runs
 *   (main-table determinism check), writes still archived for recovery;
 * - retry with exponential backoff on 429/5xx/network, hard timeout;
 * - usage accounting (calls/cached/prompt/completion) for budget + RUNLOG;
 * - injectable fetchImpl so the selfcheck runs fully offline.
 *
 * Selfcheck: node eval/lib/llm.mjs --selfcheck
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function hashRequest(req) {
  const payload = JSON.stringify({
    model: req.model,
    system: req.system ?? '',
    user: req.user ?? '',
    json: !!req.json,
    maxTokens: req.maxTokens ?? null,
    temperature: req.temperature ?? null,
    seed: req.seed ?? null,
  })
  return createHash('sha256').update(payload).digest('hex')
}

function parseJsonContent(content) {
  if (!content) return null
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = m ? m[1] : content
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export class LlmClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.FORESIGHT_LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    this.apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null
    this.model = opts.model ?? process.env.FORESIGHT_LLM_MODEL ?? 'deepseek-flash'
    this.cacheDir = opts.cacheDir ?? path.resolve(process.env.EVAL_CACHE_DIR ?? path.join(process.cwd(), 'eval', '.cache', 'llm'))
    this.noCache = opts.noCache ?? false
    this.maxRetries = opts.maxRetries ?? 2
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.usage = { calls: 0, cached: 0, prompt_tokens: 0, completion_tokens: 0 }
    this.callLog = []
  }

  cachePath(req) {
    return path.join(this.cacheDir, hashRequest(req) + '.json')
  }

  async call(req) {
    const model = req.model ?? this.model
    const full = { ...req, model }
    const key = hashRequest(full)
    const file = this.cachePath(full)

    if (!this.noCache && fs.existsSync(file)) {
      const hit = JSON.parse(fs.readFileSync(file, 'utf8'))
      this.usage.cached += 1
      this.callLog.push({ key, cacheHit: true })
      return { ...hit, cacheHit: true }
    }
    if (!this.apiKey) {
      throw new Error(`缺少 API key（环境变量 DEEPSEEK_API_KEY）；缓存未命中且无法调用 ${model}`)
    }

    let lastErr = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              ...(full.system ? [{ role: 'system', content: full.system }] : []),
              { role: 'user', content: full.user ?? '' },
            ],
            temperature: full.temperature ?? 0,
            ...(full.seed !== undefined ? { seed: full.seed } : {}),
            ...(full.json ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: full.maxTokens ?? 1024,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`retryable HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        }
        const data = await res.json()
        const content = data.choices?.[0]?.message?.content ?? ''
        const usage = data.usage ?? null
        const out = {
          model,
          content,
          json: full.json ? parseJsonContent(content) : null,
          usage,
        }
        fs.mkdirSync(this.cacheDir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(out))
        this.usage.calls += 1
        this.usage.prompt_tokens += usage?.prompt_tokens ?? 0
        this.usage.completion_tokens += usage?.completion_tokens ?? 0
        this.callLog.push({ key, cacheHit: false })
        return { ...out, cacheHit: false }
      } catch (e) {
        lastErr = e
        if (attempt < this.maxRetries) await sleep(250 * 2 ** attempt)
      }
    }
    throw new Error(`LLM 调用失败（${model}，已重试 ${this.maxRetries} 次）: ${lastErr?.message ?? lastErr}`)
  }

  report() {
    const u = this.usage
    return `llm: calls=${u.calls} cached=${u.cached} prompt=${u.prompt_tokens} completion=${u.completion_tokens}`
  }
}

// ── selfcheck (offline) ─────────────────────────────────────────────

async function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selfcheck 失败: ${msg}`)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-llm-'))
  const req = { system: 'sys', user: 'hello', json: true, maxTokens: 32, seed: 0 }

  let fetches = 0
  const okFetch = async () => {
    fetches += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      text: async () => '',
    }
  }

  const c1 = new LlmClient({ apiKey: 'test', cacheDir: path.join(dir, 'a'), fetchImpl: okFetch })
  const r1 = await c1.call(req)
  const r2 = await c1.call(req)
  assert(fetches === 1, `二次相同请求应命中缓存（fetches=${fetches}）`)
  assert(r1.cacheHit === false && r2.cacheHit === true, 'cacheHit 标记')
  assert(r1.json.ok === true && r2.json.ok === true, 'JSON 解析')
  assert(c1.usage.calls === 1 && c1.usage.cached === 1, 'usage 记账')

  let fetches2 = 0
  const c2 = new LlmClient({ apiKey: 'test', cacheDir: path.join(dir, 'b'), noCache: true, fetchImpl: async () => { fetches2 += 1; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }), text: async () => '' } } })
  await c2.call({ ...req, json: false })
  await c2.call({ ...req, json: false })
  assert(fetches2 === 2, `--no-cache 双跑必须真实调用（fetches=${fetches2}）`)
  assert(c2.callLog.every((l) => !l.cacheHit), 'no-cache 无命中')

  const offline = new LlmClient({
    apiKey: 'test',
    cacheDir: path.join(dir, 'a'),
    fetchImpl: async () => { throw new Error('offline') },
  })
  const r3 = await offline.call(req)
  assert(r3.cacheHit === true, '断网重跑命中缓存')

  let attempts = 0
  const flaky = new LlmClient({
    apiKey: 'test',
    cacheDir: path.join(dir, 'c'),
    maxRetries: 2,
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }), text: async () => '' }
    },
  })
  const r4 = await flaky.call({ ...req, json: false })
  assert(attempts === 3 && r4.content === 'ok', `指数退避重试（attempts=${attempts}）`)

  console.log('✔ llm.mjs selfcheck 通过（缓存 0 调用 / --no-cache 真调用 / 断网命中 / 退避重试 / usage）')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selfcheck')) {
    selfCheck().catch((e) => {
      console.error(`✘ ${e.message}`)
      process.exitCode = 1
    })
  } else {
    console.log('llm.mjs — 使用 --selfcheck 运行离线自检；接口 LlmClient.call/hashRequest。')
  }
}
