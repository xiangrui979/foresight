/**
 * ForeSight main plugin: registers the core service on the cordis context.
 * Other plugins (tools/inject/nudge/observer/server) inject this service.
 * Pure dsh/cordis boundary — all domain logic lives under src/ scope,
 * and nothing here imports user data.
 */
import { ForeSight, type ForeSightOptions } from './core.js'

export const name = 'foresight-core'

export interface ForesightPluginConfig extends Partial<ForeSightOptions> {
  memoryRoot?: string
}

export function apply(ctx: { provide: (key: string, value: unknown) => void }, config: ForesightPluginConfig = {}) {
  // memoryRoot default './memory' (relative to dsh cwd); production overrides
  // via profile-level cordis.patch.yml (see README → Configuration).
  const memoryRoot = config.memoryRoot ?? './memory'
  const fs = new ForeSight({
    memoryRoot,
    dbFile: config.dbFile,
    embedBaseUrl: config.embedBaseUrl,
    embedModel: config.embedModel,
  })
  ctx.provide('foresight', fs)
  return () => fs.close()
}

// Re-export domain types & the container for consumers.
export type { Policy, Aspect, Anchor, MemoryStatus, MemorySource } from './types.js'
export { ForeSight } from './core.js'
