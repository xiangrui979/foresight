/**
 * closedbook baseline: no memory at all (D8). Measures parametric
 * knowledge / leakage floor.
 */
export function create(ctx) {
  const { reader } = ctx
  return {
    name: 'closedbook',
    channel: 'system_prompt',
    async query({ query }) {
      const r = await reader({ query, injected: [] })
      return { answer: r.answer, injected: [], injected_tokens: 0, calls: r.calls ?? 0, channel: 'system_prompt' }
    },
  }
}
