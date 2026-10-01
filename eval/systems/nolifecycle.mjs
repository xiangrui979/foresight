/**
 * nolifecycle baseline: identical core, lifecycle.enabled=false
 * (no sweep, no not-started filter, temporalFactor=1). Mechanism contrast
 * for H1.
 */
import { create as createForesight } from './foresight.mjs'

export function create(ctx) {
  const policy = structuredClone(ctx.policy)
  policy.lifecycle = { ...(policy.lifecycle ?? {}), enabled: false }
  const inner = createForesight({ ...ctx, policy })
  return { ...inner, name: 'nolifecycle' }
}
