/**
 * ForeSight system (full lifecycle, D17 choice ①: plugin-side budget via
 * the shared eval counter). Retrieval → unified budget render → reader.
 */
import { search } from '../../lib/retrieve/search.js'
import { sweepExpired } from '../../lib/evolve/temporal.js'
import { renderWithinBudget } from '../lib/render-budget.mjs'
import { toInjected } from './common.mjs'

export function create(ctx) {
  const { policy, store, embed, reader, countTokens, budgetTokens } = ctx
  return {
    name: 'foresight',
    channel: 'tool_retrieval',
    async query({ query, now }) {
      sweepExpired(store, policy, now)
      let hits = []
      try {
        hits = await search(query, store, embed, policy, now, {})
      } catch {
        hits = []
      }
      const items = hits.map((h) => ({ text: h.rendered, memory_id: h.id, content: h.content }))
      const budget = renderWithinBudget(items, budgetTokens, countTokens)
      const injected = toInjected(budget.included, countTokens)
      const r = await reader({ query, injected })
      return { answer: r.answer, injected, injected_tokens: budget.tokens, calls: r.calls ?? 0, channel: 'tool_retrieval' }
    },
  }
}
