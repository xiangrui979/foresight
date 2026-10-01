/**
 * Shared eval-system helpers (Task 1.5).
 *
 * Every system implements the SAME interface:
 *   create(ctx) → { name, query({query, now, groundTruth}) →
 *     { answer, injected:[{memory_id, content, tokens}], injected_tokens, calls, channel } }
 *
 * ctx = {
 *   policy, store, embed, clock,
 *   reader: async ({query, injected}) => ({ answer, calls? }),
 *   countTokens: (text) => number,
 *   budgetTokens: number,            // same for every system (H3)
 *   history: [{peer, content, createdAt}], // summary/fullcontext inputs
 *   llm: LlmClient | null,
 * }
 */

export function toInjected(items, countTokens) {
  return (items ?? []).map((i) => ({
    memory_id: String(i.memory_id),
    content: String(i.content ?? i.text ?? ''),
    tokens: countTokens(i.text ?? i.content ?? ''),
  }))
}

/** Active memories across the three injectable aspects. */
export function activeMemories(store) {
  const out = []
  for (const aspect of ['perfect', 'progressive', 'prospective']) {
    out.push(...store.listByAspectStatus(aspect, 'active'))
  }
  return out
}
