/**
 * rag baseline: vector top-k over memories, k scanned under the same token
 * budget; no lifecycle semantics.
 */
import { renderWithinBudget } from '../lib/render-budget.mjs'
import { toInjected } from './common.mjs'

export function create(ctx) {
  const { store, embed, reader, countTokens, budgetTokens } = ctx
  return {
    name: 'rag',
    channel: 'tool_retrieval',
    async query({ query }) {
      let items = []
      try {
        const vec = await embed.embedOne(query)
        const near = store.vectorNeighbors(vec, 50)
        items = near
          .map((n) => store.getMemory(n.id))
          .filter((m) => m && m.status === 'active')
          .map((m) => ({ text: m.content, memory_id: m.id, content: m.content }))
      } catch {
        items = []
      }
      const budget = renderWithinBudget(items, budgetTokens, countTokens)
      const injected = toInjected(budget.included, countTokens)
      const r = await reader({ query, injected })
      return { answer: r.answer, injected, injected_tokens: budget.tokens, calls: r.calls ?? 0, channel: 'tool_retrieval' }
    },
  }
}
