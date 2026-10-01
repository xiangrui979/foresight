/**
 * ForeSight derivation layer (second-order facts, design §10).
 *
 * Async pipeline: session end (or every N turns) trigger, input =
 * conversations increment (store.listConversationsSince), output =
 * route-table-driven structured facts (policy.derive.routes):
 *   - conclusion       → memories (aspect_default=perfect × point)
 *   - user_trait       → user.md (gnomic profile; Root channel, budget-checked)
 *   - agent_reflection → memories (behavior reflection)
 *
 * Key points:
 *   - one prompt template per route (P2 table lookup, no scattered ifs)
 *   - LLM parse failure → skip batch + emit derive.failed, never crash
 *   - max_new_per_batch cap (cost bound; exceed → truncated + capped)
 *   - derived rows: source='derive', base_weight from policy
 *   - pure functions: buildPrompts / dispatchEntry independently testable
 */
import * as fs from 'node:fs'
import type { Anchor, Aspect, DeriveRoute, Policy } from '../policy.js'
import type { Store } from '../store.js'
import { normalizeClock, systemClock, type Clock, type ClockLike } from '../clock.js'

// ── public types ────────────────────────────────────────────────────

export interface ConversationMessage {
  id: number
  peer: string
  content: string
  createdAt: number
}

export interface LlmRequest {
  model: string
  system: string
  user: string
  json?: boolean
  maxTokens?: number
}
export interface LlmResponse {
  content: string
  json: unknown | null
}
export interface LlmCall {
  call(req: LlmRequest): Promise<LlmResponse>
}

export interface DeriveEntry {
  content: string
  aspect?: string
  anchor?: Anchor
}

export interface DispatchDeps {
  store: Store
  policy: Policy
  userDocPath: string
  sessionId: string
  now: number
  emit: (type: string, detail: Record<string, unknown>) => void
}

export interface DispatchResult {
  inserted: number
  evicted: number
  overBudget: boolean
}

export interface DeriveRunOptions {
  userDocPath: string
  now?: number
}

export interface DeriveBatchResult {
  route: string
  target: string
  count: number
  capped: boolean
}

export interface DeriveRunResult {
  sessionId: string
  messagesProcessed: number
  batches: DeriveBatchResult[]
  failedBatches: string[]
}

// ── Prompt templates (P2: per-source lookup, generic fallback) ───────

interface PromptTemplate {
  system: string
  fewShot: string
  instruction: string
}

const TEMPLATES: Record<string, PromptTemplate> = {
  conclusion: {
    system:
      '你是 ForeSight 记忆系统的「结论派生器」。任务：从对话增量中归纳出已完成的事实与结论（如"项目 X 用了 Y"、"用户决定了 Z"、"问题已解决"）。只输出 JSON 数组，不要任何多余文字。',
    fewShot: [
      '示例对话：',
      '[user] 我们把图片提取改成双通道了，质量好很多',
      '[user] 那就定下来用双通道方案',
      '示例输出：',
      '[{"content":"图片提取改为双通道方案，质量显著提升","aspect":"perfect","anchor":{"type":"point","start":"2026-08-01"}}]',
    ].join('\n'),
    instruction:
      '输出 JSON 数组（不要 markdown 围栏）。每条：content（必填，一句话中文完成事实）、aspect（可省略，默认 "perfect"）、anchor（可省略，默认 {"type":"point","start":"今天"}）。只写有明确发生时间点的完成事实，忽略寒暄与过程性讨论。',
  },

  user_trait: {
    system:
      '你是 ForeSight 记忆系统的「用户画像派生器」。任务：从对话增量中提炼用户的稳定画像——偏好、习惯、纠正、禁忌、技术栈、身份信息。这些是无时间性的规律（gnomic），将写入 user.md 长期注入。只输出 JSON 数组。',
    fewShot: [
      '示例对话：',
      '[user] 以后翻译文档记得术语表里的词不要动',
      '[user] 还有代码示例保留原状',
      '示例输出：',
      '[{"content":"文档翻译时术语表词汇不改动，代码示例保留原状","aspect":"gnomic"}]',
    ].join('\n'),
    instruction:
      '输出 JSON 数组（不要 markdown 围栏）。每条：content（必填，一句话中文画像）、aspect（可省略，默认 "gnomic"）、anchor（可省略）。只写稳定的偏好/习惯/纠正，一次性的具体任务细节不要写。',
  },

  agent_reflection: {
    system:
      '你是 ForeSight 记忆系统的「行为反思派生器」。任务：从对话增量中提炼 agent 自身行为的反思——哪些做法有效、哪些被用户纠正、后续应保持或避免什么。只输出 JSON 数组。',
    fewShot: [
      '示例对话：',
      '[user] 你刚才先讲机制再动手，这个方式很好，以后都这样',
      '示例输出：',
      '[{"content":"用户认可先讲机制再动手的做事方式，应保持","aspect":"perfect","anchor":{"type":"point","start":"2026-08-01"}}]',
    ].join('\n'),
    instruction:
      '输出 JSON 数组（不要 markdown 围栏）。每条：content（必填，一句话中文反思结论）、aspect（可省略，默认 "perfect"）、anchor（可省略，默认 {"type":"point","start":"今天"}）。',
  },

  generic: {
    system: '你是 ForeSight 记忆系统的「派生器」。从对话增量中提取结构化事实。只输出 JSON 数组。',
    fewShot: '示例输出：[{"content":"一句话事实","aspect":"perfect","anchor":{"type":"point","start":"2026-08-01"}}]',
    instruction:
      '输出 JSON 数组（不要 markdown 围栏）。每条含 content（必填，一句话中文）、aspect、anchor（可省略，将用路由默认）。',
  },
}

export interface BuiltPrompt {
  route: DeriveRoute
  system: string
  user: string
}

/** Pure: route table → prompt list (one per route). */
export function buildPrompts(
  routes: DeriveRoute[],
  messages: ConversationMessage[],
  policy: Policy,
): BuiltPrompt[] {
  const transcript = messages.map((m) => `[${m.peer}] ${m.content}`).join('\n')
  const max = Number(policy.derive.max_new_per_batch)
  return routes.map((route) => {
    const tpl = TEMPLATES[route.source] ?? TEMPLATES.generic
    return {
      route,
      system: tpl.system,
      user: `${tpl.fewShot}\n\n本次对话增量（待派生的原始材料）：\n${transcript}\n\n${tpl.instruction}\n数量上限：${max} 条。`,
    }
  })
}

// ── parsing & validation ────────────────────────────────────────────

const ASPECTS: readonly Aspect[] = ['gnomic', 'progressive', 'perfect', 'prospective']
const ANCHOR_TYPES = ['none', 'point', 'interval', 'open'] as const

function validAspect(v: string | undefined): Aspect | undefined {
  if (v && (ASPECTS as readonly string[]).includes(v)) return v as Aspect
  return undefined
}

function isAnchor(v: unknown): v is Anchor {
  return typeof v === 'object' && v !== null && ANCHOR_TYPES.includes((v as Anchor).type)
}

function parseEntries(json: unknown): DeriveEntry[] | null {
  if (!Array.isArray(json)) return null
  const out: DeriveEntry[] = []
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.content !== 'string' || raw.content.trim() === '') continue
    out.push({
      content: raw.content.trim(),
      aspect: typeof raw.aspect === 'string' ? raw.aspect : undefined,
      anchor: isAnchor(raw.anchor) ? raw.anchor : undefined,
    })
  }
  return out.length > 0 ? out : null
}

function resolveAnchor(entryAnchor: unknown, routeDefault: Anchor | undefined, now: number): Anchor {
  if (isAnchor(entryAnchor)) return entryAnchor
  const def: Anchor = routeDefault
    ? (JSON.parse(JSON.stringify(routeDefault)) as Anchor)
    : { type: 'none' }
  if ((def.type === 'point' || def.type === 'interval') && !def.start) {
    def.start = new Date(now).toISOString().slice(0, 10)
  }
  return def
}

// ── dispatch (pure, testable) ───────────────────────────────────────

export function dispatchEntry(entry: DeriveEntry, route: DeriveRoute, deps: DispatchDeps): DispatchResult {
  if (route.target === 'user_doc') return appendUserDoc(entry, route, deps)
  return insertMemoryEntry(entry, route, deps)
}

function insertMemoryEntry(entry: DeriveEntry, route: DeriveRoute, deps: DispatchDeps): DispatchResult {
  const aspect = validAspect(entry.aspect) ?? route.aspect_default
  const anchor = resolveAnchor(entry.anchor, route.anchor_default, deps.now)
  deps.store.insertMemory({
    content: entry.content,
    aspect,
    anchor,
    category: route.source,
    source: 'derive',
    baseWeight: Number(deps.policy.activation.base_weights.derive),
    sourceRef: `derive:${route.source}:${deps.sessionId}:${deps.now}`,
    metadata: { route: route.source, session_id: deps.sessionId, derived_at: deps.now },
  })
  return { inserted: 1, evicted: 0, overBudget: false }
}

/** Append profile line to user.md (one line per trait), budget-checked. */
function appendUserDoc(entry: DeriveEntry, route: DeriveRoute, deps: DispatchDeps): DispatchResult {
  const budget = Number(deps.policy.injection.user_budget_chars)
  const line = '- ' + entry.content.replace(/\s+/g, ' ').trim()
  const existing = fs.existsSync(deps.userDocPath) ? fs.readFileSync(deps.userDocPath, 'utf8') : ''
  let next = existing.replace(/\s+$/, '')
  next = next ? next + '\n' + line + '\n' : line + '\n'

  let evicted = 0
  while (next.length > budget) {
    const lines = next.split('\n')
    const idx = lines.findIndex((l) => /^-\s+/.test(l))
    if (idx === -1) break
    lines.splice(idx, 1)
    evicted++
    next = lines.join('\n')
  }
  const overBudget = next.length > budget
  fs.writeFileSync(deps.userDocPath, next, 'utf8')
  deps.emit('user_doc.write', {
    path: deps.userDocPath,
    route: route.source,
    added: 1,
    evicted,
    over_budget: overBudget,
  })
  return { inserted: 1, evicted, overBudget }
}

// ── Deriver main ────────────────────────────────────────────────────

/**
 * Derive pipeline. Lifecycle: construct (Store/LLM/Policy) → run(sessionId, opts).
 * Increment cursor lives in instance (in-process enough for now).
 */
export class Deriver {
  private lastId = new Map<string, number>()
  private lastCreatedAt = new Map<string, number>()
  private clock: Clock

  constructor(
    private store: Store,
    private llm: LlmCall,
    private policy: Policy,
    clock: ClockLike = systemClock,
  ) {
    this.clock = normalizeClock(clock)
  }

  /**
   * One derive pass: conversations increment → per-route prompt → LLM →
   * parse → dispatch. Failed batch emits derive.failed, continues others.
   */
  async run(sessionId: string, opts: DeriveRunOptions): Promise<DeriveRunResult> {
    const now = opts.now ?? this.clock.now()
    const since = this.lastCreatedAt.get(sessionId) ?? 0
    const seenId = this.lastId.get(sessionId) ?? 0
    const fetched = this.store.listConversationsSince(sessionId, since)
    const unseen = fetched.filter((m) => m.id > seenId)
    if (unseen.length === 0) {
      return { sessionId, messagesProcessed: 0, batches: [], failedBatches: [] }
    }
    if (!this.policy.derive.enabled) {
      return { sessionId, messagesProcessed: unseen.length, batches: [], failedBatches: [] }
    }
    this.lastId.set(sessionId, Math.max(...unseen.map((m) => m.id)))
    this.lastCreatedAt.set(sessionId, Math.max(...unseen.map((m) => m.createdAt)))

    const max = Number(this.policy.derive.max_new_per_batch)
    const prompts = buildPrompts(this.policy.derive.routes, unseen, this.policy)
    const deps: DispatchDeps = {
      store: this.store,
      policy: this.policy,
      userDocPath: opts.userDocPath,
      sessionId,
      now,
      emit: (type, detail) => this.store.emit(type, null, detail),
    }

    const batches: DeriveBatchResult[] = []
    const failedBatches: string[] = []
    for (const p of prompts) {
      const { route } = p
      try {
        const resp = await this.llm.call({
          model: this.policy.llm.model_derive,
          system: p.system,
          user: p.user,
          json: true,
        })
        const entries = parseEntries(resp.json)
        if (!entries) {
          this.store.emit('derive.failed', null, {
            route: route.source,
            sessionId,
            reason: 'LLM 输出无法解析为 JSON 数组，跳过该批',
          })
          failedBatches.push(route.source)
          continue
        }
        const capped = entries.length > max
        const picked = entries.slice(0, max)
        let count = 0
        for (const entry of picked) {
          count += dispatchEntry(entry, route, deps).inserted
        }
        this.store.emit('derive.batch', null, {
          route: route.source,
          target: route.target,
          count,
          capped,
          sessionId,
        })
        batches.push({ route: route.source, target: route.target, count, capped })
      } catch (e) {
        this.store.emit('derive.failed', null, {
          route: route.source,
          sessionId,
          reason: e instanceof Error ? e.message : String(e),
        })
        failedBatches.push(route.source)
      }
    }
    return { sessionId, messagesProcessed: unseen.length, batches, failedBatches }
  }
}
