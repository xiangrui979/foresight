/**
 * summary baseline: rolling summary of history (LLM when available,
 * deterministic fallback offline), then reader. Same token budget.
 */
import { renderWithinBudget } from '../lib/render-budget.mjs'
import { toInjected } from './common.mjs'

export function create(ctx) {
  const { history = [], reader, countTokens, budgetTokens, llm } = ctx
  return {
    name: 'summary',
    channel: 'system_prompt',
    async query({ query }) {
      let text = ''
      if (history.length > 0) {
        if (llm) {
          try {
            const r = await llm.call({
              system: '将以下对话历史压缩为简洁摘要，保留事实、时间与结论。只输出摘要正文。',
              user: history.map((h) => `[${h.peer}] ${h.content}`).join('\n'),
              maxTokens: 512,
            })
            text = r.content ?? ''
          } catch {
            text = ''
          }
        }
        if (!text) {
          text = history.map((h) => `[${h.peer}] ${h.content}`).join('；')
        }
      }
      const budget = renderWithinBudget([{ text, memory_id: 'summary#0', content: text }], budgetTokens, countTokens)
      const injected = toInjected(budget.included, countTokens)
      const r = await reader({ query, injected })
      return { answer: r.answer, injected, injected_tokens: budget.tokens, calls: r.calls ?? 0, channel: 'system_prompt' }
    },
  }
}
