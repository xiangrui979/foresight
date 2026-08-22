/**
 * ForeSight injection layer: three-section table render + SOUL/user static
 * injection (design §9).
 *
 * System prompt section sources:
 *   - soul     = SOUL.md verbatim (Root static; mtime cached)
 *   - user     = user.md verbatim (Root-maintained; mtime cached)
 *   - memories = progressive(active) lookup + anchor-expiry mechanical filter:
 *                interval → '（至 {end}）' (stable absolute date)
 *                point   → '（{start} 起）'
 *                none → unmarked; perfect/prospective not injected (§9 table)
 *
 * renderSections is pure (testable without dsh); registerSections mounts
 * onto systemPrompt.section (orders: soul -50 / user 10 / memories 20).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Store } from '../store.js'
import type { Policy, Anchor } from '../policy.js'

export interface RenderDeps {
  store: Store
  policy: Policy
  memoryRoot: string
  now?: Date
}

export interface RenderResult {
  soul: string
  user: string
  memories: string
}

interface FileCacheEntry {
  mtimeMs: number
  content: string
}

const fileCache = new Map<string, FileCacheEntry>()

/** Read a text file under memoryRoot (mtime-cached). Missing/failed → ''. */
export function readTextFile(memoryRoot: string, filename: string): string {
  const p = path.join(memoryRoot, filename)
  try {
    const st = fs.statSync(p)
    const hit = fileCache.get(p)
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs) return hit.content
    const content = fs.readFileSync(p, 'utf8')
    fileCache.set(p, { mtimeMs: st.mtimeMs, content })
    return content
  } catch {
    return ''
  }
}

/** Anchor expiry (mechanical; parse failure → not expired, conservative). */
export function anchorExpired(anchor: Anchor, now: Date): boolean {
  if (anchor.type === 'interval' && typeof anchor.end === 'string' && anchor.end.length > 0) {
    const end = Date.parse(anchor.end)
    return Number.isFinite(end) && end < now.getTime()
  }
  return false
}

/** Single progressive render: stable absolute-date suffix per anchor type. */
export function renderAnchorSuffix(content: string, anchor: Anchor): string {
  if (anchor.type === 'interval' && typeof anchor.end === 'string' && anchor.end.length > 0) {
    return `${content}（至 ${anchor.end}）`
  }
  if (anchor.type === 'point' && typeof anchor.start === 'string' && anchor.start.length > 0) {
    return `${content}（${anchor.start} 起）`
  }
  return content
}

/** memories render: progressive(active) table → drop expired → one per line. */
export function renderMemories(store: Store, now: Date): string {
  const rows = store.listByAspectStatus('progressive', 'active')
  const lines: string[] = []
  for (const m of rows) {
    if (anchorExpired(m.anchor, now)) continue
    lines.push(renderAnchorSuffix(m.content, m.anchor))
  }
  return lines.join('\n')
}

/** Three-section render (pure). */
export function renderSections(deps: RenderDeps): RenderResult {
  const now = deps.now ?? new Date()
  return {
    soul: readTextFile(deps.memoryRoot, 'SOUL.md'),
    user: readTextFile(deps.memoryRoot, 'user.md'),
    memories: renderMemories(deps.store, now),
  }
}

/**
 * dsh registration: mount three sections onto ctx.systemPrompt.section.
 * text is a function → re-reads/re-renders each assemble (live edits/expiry).
 * order aligned: soul -50, user 10, memories 20. Names from policy.injection.
 */
export function registerSections(ctx: unknown, deps: RenderDeps): () => void {
  const sp = (ctx as { systemPrompt?: { section?: (s: unknown) => unknown } }).systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    throw new Error('foresight-inject: ctx.systemPrompt 不可用（需要 dsh-system-prompt 服务）')
  }
  const disposers: Array<() => void> = []

  const mount = (name: string, order: number, pick: (r: RenderResult) => string): void => {
    disposers.push(
      sp.section!({
        name,
        order,
        text: () =>
          pick(
            renderSections({
              store: deps.store,
              policy: deps.policy,
              memoryRoot: deps.memoryRoot,
              now: new Date(),
            })
          ),
      }) as () => void
    )
  }

  mount(deps.policy.injection.soul_section, -50, (r) => r.soul)
  mount(deps.policy.injection.user_section, 10, (r) => r.user)
  mount(deps.policy.injection.memories_section, 20, (r) => r.memories)

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

// ── cordis plugin entry ─────────────────────────────────────────────

export interface InjectCtx {
  systemPrompt?: { section?: (s: unknown) => unknown }
}

export const name = 'foresight-inject'
export const inject = ['foresight', 'systemPrompt']

/**
 * Plugin entry: resolve store/policy/memoryRoot from injected ctx.foresight,
 * mount three sections. Throws on missing deps (fail-fast, never silent).
 */
export function apply(ctx: InjectCtx): () => void {
  const fsight = (ctx as unknown as { foresight?: { store?: Store; policy?: Policy; memoryRoot?: string } }).foresight
  const store = fsight?.store
  const policy = fsight?.policy
  const memoryRoot = fsight?.memoryRoot
  if (!store || !policy || !memoryRoot) {
    throw new Error('foresight-inject: 缺少 ctx.foresight（需 foresight-core 先加载）')
  }
  if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    throw new Error('foresight-inject: ctx.systemPrompt 不可用（需要 dsh-system-prompt 服务）')
  }
  return registerSections(ctx, { store, policy, memoryRoot })
}
