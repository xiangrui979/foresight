/**
 * ForeSight ingestion layer: session observer plugin (design §4).
 *
 * Listens to cordis 'session/event':
 *  - user/message: only source.kind === 'user' real human input
 *    (filters plugin/tool synthesized messages)
 *  - assistant/message: model output (peer=assistant)
 *  - turn/end: async batch flush to store.insertConversation
 *    (20k/chunk, [continued] marker)
 *
 * Degradation: flush failure logs warn, never blocks; canonical transcript
 * stays in dsh logs. Loose types (ObserverCtx) so it compiles/testing without dsh.
 */
import type { Store } from '../store.js'

export const MAX_CHARS = 20000

export interface PendingMessage {
  role: 'user' | 'assistant'
  peer: 'user' | string
  content: string
  sessionId: string
}

export interface ObserverDeps {
  store: Store
  onTurnEnd?: (sessionId: string, turn: number) => Promise<void> | void
}

export interface ObserverCtx {
  on(event: string, listener: (...args: unknown[]) => unknown): unknown
  logger?: {
    info?: (msg: string, ...args: unknown[]) => void
    warn?: (msg: string, ...args: unknown[]) => void
  }
}

/** Extract plain text from content blocks (loose parse; non-text blocks ignored). */
export function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as Array<Record<string, unknown>>)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** Long-text chunking: first chunk verbatim, later chunks prefixed '[continued] '. */
export function chunkText(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    out.push(rest.slice(0, max))
    rest = `[continued] ${rest.slice(max)}`
  }
  if (rest.length > 0) out.push(rest)
  return out
}

export class ForeSightObserver {
  private pending: PendingMessage[] = []
  private flushBusy = false
  private loggerInfo: ((msg: string, ...args: unknown[]) => void) | undefined
  private loggerWarn: ((msg: string, ...args: unknown[]) => void) | undefined

  constructor(private readonly deps: ObserverDeps) {}

  apply(ctx: ObserverCtx): () => void {
    // cordis LoggerService prototype methods call this internally — an
    // unbound extraction loses this (boot fatal historically). Bind first.
    const logger = ctx.logger
    this.loggerInfo = logger?.info ? logger.info.bind(logger) : undefined
    this.loggerWarn = logger?.warn ? logger.warn.bind(logger) : undefined
    const disposers: Array<() => void> = []

    disposers.push(
      ctx.on('session/event', (session: unknown, event: unknown) => {
        this.handleSessionEvent(session, event)
      }) as () => void
    )
    disposers.push(
      ctx.on('session/flush', () => {
        void this.flushAsync(-1)
      }) as () => void
    )

    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
    }
  }

  private handleSessionEvent(session: unknown, event: unknown): void {
    const e = event as { type?: string; data?: Record<string, unknown> } | null | undefined
    if (!e || typeof e.type !== 'string') return

    const sessionId = this.sessionIdOf(session)

    if (e.type === 'user/message') {
      const source = e.data?.source as Record<string, unknown> | undefined
      if (source?.kind !== 'user') return
      const text = textOf(e.data?.content)
      if (text.trim().length === 0) return
      this.pending.push({ role: 'user', peer: 'user', content: text, sessionId })
    } else if (e.type === 'assistant/message') {
      const message = e.data?.message as Record<string, unknown> | undefined
      const text = textOf(message?.content)
      if (text.trim().length === 0) return
      this.pending.push({ role: 'assistant', peer: 'assistant', content: text, sessionId })
    } else if (e.type === 'turn/end') {
      const turn = (e.data?.turn as number | undefined) ?? -1
      void this.flushAsync(turn)
    }
  }

  private sessionIdOf(session: unknown): string {
    if (session && typeof session === 'object' && 'id' in session) {
      const id = (session as { id: unknown }).id
      if (id !== undefined && id !== null) return String(id)
    }
    return 'unknown'
  }

  async flushAsync(turn: number): Promise<void> {
    if (this.flushBusy || this.pending.length === 0) return
    this.flushBusy = true
    const batch = this.pending
    this.pending = []
    try {
      const rows: PendingMessage[] = []
      for (const m of batch) {
        for (const c of chunkText(m.content)) {
          rows.push({ role: m.role, peer: m.peer, content: c, sessionId: m.sessionId })
        }
      }
      for (const r of rows) {
        this.deps.store.insertConversation(r.sessionId, r.peer, r.content)
      }
      this.log('info', 'foresight-observer: turn %s 同步 %s 条消息 → conversations', turn, rows.length)
      if (this.deps.onTurnEnd && rows.length > 0) {
        const sid = rows[0].sessionId
        try {
          await this.deps.onTurnEnd(sid, turn)
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 200) : String(e)
          this.log('warn', 'foresight-observer: 派生触发失败（降级）: %s', msg)
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e)
      this.log('warn', 'foresight-observer: 同步失败（降级）: %s', msg)
    } finally {
      this.flushBusy = false
    }
  }

  private log(level: 'info' | 'warn', msg: string, ...args: unknown[]): void {
    if (level === 'info') {
      const i = this.loggerInfo ?? console.info.bind(console)
      i(msg, ...args)
    } else {
      const w = this.loggerWarn ?? console.warn.bind(console)
      w(msg, ...args)
    }
  }
}

export const name = 'foresight-observer'
export const inject = ['foresight']

function resolveStore(ctx: ObserverCtx, config?: { store?: Store }): Store {
  if (config?.store) return config.store
  const fsight = (ctx as unknown as { foresight?: { store?: Store } }).foresight
  const s = fsight?.store
  if (s && typeof (s as Store).insertConversation === 'function') return s as Store
  throw new Error('foresight-observer: 缺少 store（config.store / ctx.foresight.store）')
}

/**
 * cordis plugin entry: apply(ctx, config). config.store preferred;
 * fallback ctx.foresight.store. Turn-end hook: ctx.foresight.onTurnEnd
 * if present (design §10), called with the service as receiver (binding-safe).
 */
export function apply(ctx: ObserverCtx, config?: { store?: Store }): () => void {
  const store = resolveStore(ctx, config)
  const anyCtx = ctx as unknown as Record<string, unknown>
  const fsight = anyCtx.foresight as Record<string, unknown> | undefined
  const onTurnEnd = fsight?.onTurnEnd
  const hook = typeof onTurnEnd === 'function'
    ? (sid: string, turn: number) => { void (onTurnEnd as (sid: string, turn: number) => unknown).call(fsight, sid, turn) }
    : undefined
  return new ForeSightObserver({ store, onTurnEnd: hook }).apply(ctx)
}
