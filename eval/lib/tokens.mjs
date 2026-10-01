/**
 * ForeSight eval tokenizer (Task 1.3 / H3 budget accounting).
 *
 * Preference order (frozen in eval/DECISIONS.md §5):
 *   1. tiktoken cl100k_base (optional dependency; exact, version pinned)
 *   2. provider usage deltas for LLM calls (handled by lib/llm.mjs in P1.4)
 *   3. local estimate@v1 — CJK ≈ 1 token/char, other ≈ 4 chars/token
 *
 * All systems must use the SAME counter in a run; the id is recorded in
 * trace.versions.tokenizer.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ESTIMATOR_ID = 'estimate@v1'

export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.max(1, cjk + Math.ceil(other / 4))
}

let cached = null

/**
 * @returns {Promise<{id:string, count:(t:string)=>number, free:()=>void}>}
 */
export async function loadTokenizer() {
  if (cached) return cached
  try {
    const mod = await import('tiktoken')
    const getEncoding = mod.get_encoding ?? mod.default?.get_encoding
    if (typeof getEncoding === 'function') {
      const enc = getEncoding('cl100k_base')
      cached = {
        id: 'cl100k_base@tiktoken',
        count: (t) => (t ? enc.encode(t).length : 0),
        free: () => enc.free?.(),
      }
      return cached
    }
  } catch {
    /* tiktoken not installed — estimator fallback */
  }
  cached = { id: `${ESTIMATOR_ID} (cl100k_base unavailable)`, count: estimateTokens, free: () => {} }
  return cached
}

export function countTokensSync(text) {
  return estimateTokens(text)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = process.argv.slice(2).join(' ') || 'ForeSight 记忆系统 token 计数自检'
  loadTokenizer().then((t) => {
    console.log(JSON.stringify({ tokenizer: t.id, text, tokens: t.count(text) }))
  })
}
