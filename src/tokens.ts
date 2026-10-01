/**
 * ForeSight token accounting (Task 1.5 / H3).
 *
 * Deterministic local estimator used by the plugin-side injection budget
 * (D17 choice ①). eval/lib/tokens.mjs prefers tiktoken cl100k_base and
 * otherwise mirrors this estimator, so every system in an eval run uses the
 * same frozen counter.
 */

export const TOKENIZER_ESTIMATE_ID = 'estimate@v1'

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.max(1, cjk + Math.ceil(other / 4))
}
