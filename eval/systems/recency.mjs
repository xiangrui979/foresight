/**
 * recency baseline: most recent memories first, no lifecycle filtering,
 * N scanned under the same token budget (H3 practical contrast).
 */
import { renderWithinBudget } from '../lib/render-budget.mjs'
import { activeMemories, toInjected } from './common.mjs'

export function create(ctx) {
  const { store, reader, countTokens, budgetTokens } = ctx
  return {
    name: 'recency',
    channel: 'system_prompt',
    async query({ query }) {
      const items = activeMemories(store)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((m) => ({ text: m.content, memory_id: m.id, content: m.content }))
      const budget = renderWithinBudget(items, budgetTokens, countTokens)
      const injected = toInjected(budget.included, countTokens)
      const r = await reader({ query, injected })
      return { answer: r.answer, injected, injected_tokens: budget.tokens, calls: r.calls ?? 0, channel: 'system_prompt' }
    },
  }
}
