/**
 * ForeSight tools plugin: exposes memory operations as dsh tools.
 * Thin bridge over the core service (ctx.foresight) — all domain logic in core.
 */
import { ForeSight } from './core.js'
import type { Actor } from './core.js'

export const name = 'foresight-tools'
export const inject = ['foresight']

export function apply(ctx: { foresight: ForeSight }) {
  const fsight = ctx.foresight
  // Tool surface — a documented, narrow set. Each call maps to a core method.
  return {
    memoryWrite: (text: string, sourceRef?: string) =>
      fsight.write(text, { name: 'agent', isRoot: false }, sourceRef),
    memoryQuery: (query: string, k = 10) => fsight.query(query, { topK: k }),
    memoryReason: (query: string) => fsight.reason(query),
  }
}
