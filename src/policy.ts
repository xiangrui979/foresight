/**
 * ForeSight policy loader — reads memoryRoot/policy.yaml, validates version,
 * exports behavior lookup helpers. Single source of truth for tunables.
 */
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Aspect, AspectBehavior, Policy } from './types.js'
import { POLICY_VERSION } from './defaults.js'

// Re-export domain types so consumers can `import type { Policy } from '@foresight/memory/policy'`
export type { Aspect, AspectBehavior, Policy } from './types.js'

export function loadPolicy(policyPath: string): Policy {
  const raw = yaml.load(fs.readFileSync(policyPath, 'utf8')) as { foresight: Policy }
  const p = raw.foresight
  if (!p || p.policy_version !== POLICY_VERSION) {
    throw new Error(
      `policy version mismatch: expected ${POLICY_VERSION}, got ${p?.policy_version} (file: ${policyPath})`,
    )
  }
  return p
}

export function loadPolicyFromRoot(memoryRoot: string): Policy {
  return loadPolicy(path.join(memoryRoot, 'policy.yaml'))
}

/** Aspect → behavior lookup table (P2). All scheduling logic reads this. */
export function behavior(policy: Policy, aspect: Aspect): AspectBehavior {
  const a = policy.aspects[aspect]
  return {
    storage: (a.storage as AspectBehavior['storage']) ?? 'memory',
    injection: (a.injection as AspectBehavior['injection']) ?? 'conditional',
    expiry: (a.expiry as AspectBehavior['expiry']) ?? 'never',
    render_anchor: (a.render_anchor as AspectBehavior['render_anchor']) ?? false,
    renewable: a.renewable ?? false,
    default_ttl_days: Number(a.default_ttl_days ?? 0),
    review_every_turns: Number(a.review_every_turns ?? 30),
  }
}
