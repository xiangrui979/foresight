/**
 * ForeSight service layer (§13): Node native HTTP REST API, multi-agent writes.
 *
 * - binds policy.server.host:port (default 127.0.0.1:9288), X-ForeSight-Token;
 * - writes go through the SAME full gate path gateWrite(input, deps)
 *   (P4: identical permissions & audit); peer becomes source_ref prefix and
 *   the gate permission actor;
 * - retrieval uses search shape 3 (f_embed auto-degrade);
 * - reasoning uses dialectic/reason (LLM failure → evidence concat, never blocks);
 * - no framework deps (node:http), no CORS; JSON parse fail 400;
 * - deps injectable (gateWrite/search/reason/embed/llm) for tests.
 *
 * Endpoints:
 *   GET  /v1/health            → {status:'ok'} (no auth)
 *   POST /v1/memories          → 200 {id} | 4xx {error, clause, message?, suggestion?}
 *   POST /v1/memories/search   → 200 {query, results}
 *   GET  /v1/memories/:id      → 200 memory | 404
 *   POST /v1/reason            → 200 {query, answer, citations, conflicts}
 */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Policy, Anchor, MemorySource } from '../policy.js'
import type { Store } from '../store.js'
import type { EmbedProvider } from '../store/embed.js'
import type { LlmLike } from '../dialectic/reason.js'
import { gateWrite } from '../gate/gate.js'
import { search, type SearchHit } from '../retrieve/search.js'
import { normalizeClock, type ClockLike } from '../clock.js'

export interface ServerDeps {
  policy: Policy
  store: Store
  host?: string
  port?: number
  embed?: EmbedProvider
  llm?: LlmLike
  gateWrite?: typeof gateWrite
  search?: typeof search
  reason?: (query: string, deps: unknown, opts?: unknown) => Promise<Record<string, unknown>>
  clock?: ClockLike
}

export interface StartedServer {
  port: number
  close(): Promise<void>
}

/** Peers are open-ended (any agent name); presence check only — policy decides
 *  permission (permission.actor = peer). */
const ASPECTS: readonly string[] = ['gnomic', 'progressive', 'perfect', 'prospective']
const SOURCES: readonly string[] = ['agent', 'root', 'derive']
const ANCHOR_TYPES: readonly string[] = ['none', 'point', 'interval', 'open']
const MAX_BODY_BYTES = 1_048_576

class HttpError extends Error {
  constructor(
    public status: number,
    public error: string,
    public clause?: string,
  ) {
    super(error)
  }
}

const FAILED_LLM: LlmLike = {
  call: async () => {
    throw new Error('LLM 不可用（API key 缺失）')
  },
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        cleanup()
        req.pause()
        reject(new HttpError(413, 'payload_too_large'))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (e: Error) => {
      cleanup()
      reject(e)
    }
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req)
  if (buf.length === 0) return {}
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'invalid_json')
    return v as Record<string, unknown>
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'invalid_json')
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  try {
    if (res.writableEnded) return
    const payload = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
  } catch {
    /* client gone */
  }
}

// ── endpoint implementations ─────────────────────────────────────────

async function handleWrite(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerCtx): Promise<void> {
  const body = await readJson(req)

  const content = body.content
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'content_required')
  const aspect = body.aspect
  if (aspect !== undefined && (typeof aspect !== 'string' || !ASPECTS.includes(aspect))) {
    throw new HttpError(400, 'invalid_aspect')
  }
  const anchor = body.anchor as Anchor | undefined
  if (anchor !== undefined && (typeof anchor !== 'object' || anchor === null || !ANCHOR_TYPES.includes(anchor.type))) {
    throw new HttpError(400, 'invalid_anchor')
  }
  const source = (body.source ?? 'agent') as string
  if (!SOURCES.includes(source)) throw new HttpError(400, 'invalid_source')
  const sourceRef = typeof body.sourceRef === 'string' ? body.sourceRef : undefined
  if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
    throw new HttpError(400, 'invalid_metadata')
  }
  const categoryHint = typeof body.categoryHint === 'string' ? body.categoryHint : undefined

  const peerRaw = header(req, 'x-foresight-peer')
  if (peerRaw !== undefined && peerRaw.length > 64) {
    throw new HttpError(400, 'invalid_peer')
  }
  const peer = peerRaw ?? 'agent'

  const gate = ctx.gateWrite ?? gateWrite
  const receipt = await gate(
    {
      text: content.trim(),
      source: source as MemorySource,
      sourceRef: sourceRef ? `${peer}:${sourceRef}` : peer,
      categoryHint: categoryHint ?? null,
    },
    { policy: ctx.policy, store: ctx.store, permission: { actor: peer } }
  )

  if (!receipt.ok || !receipt.memory) {
    const status = receipt.eventType === 'permission.deny' ? 403 : 422
    return json(res, status, {
      error: 'gate_rejected',
      clause: receipt.clause,
      message: receipt.message,
      suggestion: receipt.suggestion,
    })
  }
  return json(res, 200, { id: receipt.memory.id })
}

async function handleSearch(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerCtx): Promise<void> {
  const body = await readJson(req)
  const query = body.query
  if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, 'query_required')
  const k =
    typeof body.k === 'number' && Number.isFinite(body.k)
      ? Math.min(100, Math.max(1, Math.floor(body.k)))
      : ctx.policy.retrieval.top_k
  const from = typeof body.from === 'string' ? body.from : undefined
  const to = typeof body.to === 'string' ? body.to : undefined

  const searchFn = ctx.search ?? search
  const hits = await searchFn(ctx.store, query.trim(), { from, to, k })
  return json(res, 200, { query: query.trim(), results: hits.map(hitToJson) })
}

function hitToJson(h: SearchHit): Record<string, unknown> {
  return {
    id: h.id,
    content: h.content,
    aspect: h.aspect,
    anchor: h.anchor,
    activation: h.activation,
    score: h.score,
    factors: h.factors,
    rendered: h.rendered,
    createdAt: h.createdAt,
  }
}

async function handleReason(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerCtx): Promise<void> {
  const body = await readJson(req)
  const query = body.query
  if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, 'query_required')

  const reasonFn = ctx.reason
  if (!reasonFn) throw new HttpError(501, 'reason_unavailable')
  const result = await reasonFn(query.trim(), {
    store: ctx.store,
    policy: ctx.policy,
    embed: ctx.embed,
    llm: ctx.llm,
    now: normalizeClock(ctx.clock).now(),
  })
  return json(res, 200, { query: query.trim(), ...result })
}

async function handleGet(_req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerCtx, id: string): Promise<void> {
  const mem = ctx.store.getMemory(id)
  if (!mem) return json(res, 404, { error: 'not_found', clause: null })
  return json(res, 200, {
    id: mem.id,
    content: mem.content,
    aspect: mem.aspect,
    anchor: mem.anchor,
    category: mem.category,
    telicity: mem.telicity,
    modality: mem.modality,
    activation: mem.activation,
    baseWeight: mem.baseWeight,
    source: mem.source,
    sourceRef: mem.sourceRef,
    status: mem.status,
    metadata: mem.metadata,
    createdAt: mem.createdAt,
    updatedAt: mem.updatedAt,
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerCtx): Promise<void> {
  try {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const pathname = u.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && pathname === '/v1/health') return json(res, 200, { status: 'ok' })

    if (!ctx.policy.server.enabled) return json(res, 503, { error: 'server_disabled', clause: null })
    const token = header(req, 'x-foresight-token')
    if (token !== ctx.policy.server.token) return json(res, 401, { error: 'unauthorized', clause: null })

    if (method === 'POST' && pathname === '/v1/memories') return await handleWrite(req, res, ctx)
    if (method === 'POST' && pathname === '/v1/memories/search') return await handleSearch(req, res, ctx)
    if (method === 'POST' && pathname === '/v1/reason') return await handleReason(req, res, ctx)
    const m = method === 'GET' ? /^\/v1\/memories\/([^/]+)$/.exec(pathname) : null
    if (m) return await handleGet(req, res, ctx, decodeURIComponent(m[1]))

    return json(res, 404, { error: 'not_found', clause: null })
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.error, clause: e.clause ?? null })
    console.error('[foresight:server] 未捕获异常:', e)
    return json(res, 500, { error: 'internal_error', clause: null })
  }
}

interface ServerCtx extends ServerDeps {
  embed: EmbedProvider
  llm: LlmLike
}

export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const host = deps.host ?? deps.policy.server.host
  const port = deps.port ?? deps.policy.server.port
  const ctx: ServerCtx = {
    ...deps,
    embed: deps.embed ?? {
      embedOne: async () => new Float32Array(768),
      embedBatch: async (t) => Array(t.length).fill(new Float32Array(768)) as unknown as Float32Array[],
    },
    llm: deps.llm ?? FAILED_LLM,
  }
  const srv = http.createServer((req, res) => {
    handle(req, res, ctx).catch((e) => {
      console.error('[foresight:server] 请求处理异常:', e)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, host, () => {
      srv.off('error', reject)
      resolve()
    })
  })
  const addr = srv.address() as AddressInfo
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        srv.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}

export const name = 'foresight-server'
export const inject = ['foresight']

export async function apply(ctx: unknown): Promise<() => void> {
  const fsight = (ctx as { foresight?: { policy?: Policy; store?: Store; embed?: EmbedProvider; llm?: LlmLike; reason?: ServerDeps['reason']; clock?: ClockLike } }).foresight
  if (!fsight?.policy || !fsight.store) {
    throw new Error('foresight-server 需要 foresight 服务（@foresight/memory 主插件）')
  }
  if (!fsight.policy.server.enabled) return () => {}
  const started = await startServer({
    policy: fsight.policy,
    store: fsight.store,
    embed: fsight.embed,
    llm: fsight.llm,
    reason: fsight.reason,
    clock: fsight.clock,
  })
  return () => { void started.close() }
}
