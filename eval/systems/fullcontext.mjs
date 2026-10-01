/**
 * fullcontext baseline (upper-bound reference only — excluded from H3
 * dominance judgement, D9). Frozen truncation strategy: keep the most
 * recent messages that fit; drop oldest first.
 */
import { renderWithinBudget } from '../lib/render-budget.mjs'
import { toInjected } from './common.mjs'

export function create(ctx) {
  const { history = [], reader, countTokens, budgetTokens } = ctx
  return {
    name: 'fullcontext',
    channel: 'system_prompt',
    upperBound: true,
    async query({ query }) {
      const chronological = history.map((h, i) => ({
        text: `[${h.peer}] ${h.content}`,
        memory_id: `hist#${i}`,
        content: h.content,
      }))
      const newestFirst = [...chronological].reverse()
      const budget = renderWithinBudget(newestFirst, budgetTokens, countTokens)
      const included = budget.included.map((i) => i.memory_id)
      const ordered = chronological.filter((i) => included.includes(i.memory_id))
      const injected = toInjected(ordered, countTokens)
      const r = await reader({ query, injected })
      return { answer: r.answer, injected, injected_tokens: budget.tokens, calls: r.calls ?? 0, channel: 'system_prompt' }
    },
  }
}
