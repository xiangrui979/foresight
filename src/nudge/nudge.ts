/**
 * ForeSight nudge: periodic maintenance engine (design §11 ops face).
 *
 * Duties:
 *  1. maintenance reminder every every_turns (pure buildNudge, no dsh dep);
 *  2. temporal review questions: progressive near TTL → renewal confirm;
 *     prospective past review_every_turns → modality-branch question
 *     (prediction due / intention tri-question / plan revision);
 *  3. conflict review: list suppressed entries + contradicts edges
 *     (restore or confirm);
 *  4. candidate extraction: rules pattern-scan from recent session (zero LLM);
 *     llm mode uses LLM with rules fallback;
 *  5. session timeline one-liner (include_session_timeline).
 *
 * dsh scheduler shell NudgePlugin uses loose types (no @deepseek-ai/* import),
 * compiles without dsh; attach(ctx) only runs inside dsh.
 */
import type { Policy, Aspect, MemoryStatus } from '../policy.js'
import type { Memory } from '../store.js'

export type ReviewKind = 'renewal' | 'prospective' | 'conflict' | 'expiry_suggest'

export interface ReviewItem {
  type: ReviewKind
  memoryId: string
  text: string
}

export interface NudgeResult {
  trigger: boolean
  text: string | null
  reviewItems: ReviewItem[]
}

/** Narrow store interface (structural: real Store & test fakes both fit). */
export interface NudgeStore {
  listByAspectStatus(aspect: Aspect, status: MemoryStatus): Memory[]
  listLinksOf(id: string): Array<{ id: number; src: string; dst: string; rel: string; weight: number; source: string }>
  listConversationsSince?(sessionId: string, createdAfter: number, limit?: number): Array<{ id: number; peer: string; content: string; createdAt: number }>
  listRecentUserTexts?(since: number, limit?: number): string[]
  getMemory?(id: string): Memory | null
  emit?(type: string, target: string | null, detail: Record<string, unknown> | null): void
}

export interface NudgeDeps {
  store: NudgeStore
  policy: Policy
  now: number
  turnCount: number
  sessionStartTs: number
  sessionId?: string
  llm?: LlmLike
}

export interface LlmLike {
  call(req: {
    model: string
    system: string
    user: string
    json?: boolean
    maxTokens?: number
  }): Promise<{ content: string; json: unknown | null }>
}

const RENEWAL_DAYS_BEFORE = 7
const DAY_MS = 86_400_000

// ── temporal checks (mirrors evolve/temporal.ts contract) ────────────

export function expireCheck(memory: Memory, now: number): 'expired' | 'active' {
  if (memory.aspect !== 'progressive' || memory.status === 'expired') return memory.status === 'expired' ? 'expired' : 'active'
  const a = memory.anchor
  if (a.type === 'interval' && a.end) {
    if (Date.parse(a.end) <= now) return 'expired'
  }
  if (a.type === 'none' || memory.telicity === 'unbounded') {
    const ttlDays = ttlDaysOf(memory)
    if (ttlDays > 0 && now - memory.createdAt >= ttlDays * DAY_MS) return 'expired'
  }
  return 'active'
}

export function renewalDue(memory: Memory, now: number, daysBefore = RENEWAL_DAYS_BEFORE): boolean {
  if (memory.aspect !== 'progressive' || memory.status !== 'active') return false
  if (expireCheck(memory, now) === 'expired') return false
  const a = memory.anchor
  if (a.type === 'none' || memory.telicity === 'unbounded') {
    const ttlDays = ttlDaysOf(memory)
    if (ttlDays <= 0) return false
    const ageDays = (now - memory.createdAt) / DAY_MS
    return ageDays >= ttlDays - daysBefore
  }
  if (a.type === 'interval' && a.end) {
    return Date.parse(a.end) - now <= daysBefore * DAY_MS
  }
  return false
}

function ttlDaysOf(memory: Memory): number {
  return memory.anchor.type === 'none' ? 7 : 7
}

// ── candidate extraction (rules pattern scan, zero LLM) ──────────────

export function extractCandidatesByRules(messages: string[], max: number): string[] {
  const hits: string[] = []
  for (const msg of messages) {
    if (/(以后|从此|总是|必须|不要|偏好|习惯|要求|希望)/.test(msg) && msg.length >= 8) {
      if (!hits.includes(msg)) hits.push(msg)
    } else if (/(路径|版本|配置|安装|更新)了?/.test(msg) && /[A-Z]:[\\/]|[A-Za-z0-9._-]+\.[a-z]{2,4}/.test(msg)) {
      if (!hits.includes(msg)) hits.push(msg)
    }
    if (hits.length >= max) break
  }
  return hits.slice(0, max)
}

function collectCandidates(deps: NudgeDeps): string[] {
  if (deps.policy.nudge.candidate_extraction !== 'rules') return []
  const max = deps.policy.nudge.candidate_max ?? 5
  const texts = recentUserTexts(deps)
  return extractCandidatesByRules(texts, max)
}

function recentUserTexts(deps: NudgeDeps): string[] {
  if (deps.sessionId && deps.store.listConversationsSince) {
    return deps.store
      .listConversationsSince(deps.sessionId, deps.sessionStartTs, 200)
      .filter((m) => m.peer === 'user')
      .map((m) => m.content)
  } else if (deps.store.listRecentUserTexts) {
    return deps.store.listRecentUserTexts(deps.sessionStartTs, 200)
  }
  return []
}

async function extractCandidatesByLlm(deps: NudgeDeps, texts: string[]): Promise<string[]> {
  const max = deps.policy.nudge.candidate_max ?? 5
  if (!deps.llm || texts.length === 0) return extractCandidatesByRules(texts, max)
  try {
    const r = await deps.llm.call({
      model: deps.policy.nudge.llm_model ?? deps.policy.llm.model_classify,
      system:
        '你是记忆候选提取器。从用户消息中提取值得长期记忆的事实/偏好/规则候选，' +
        `输出 JSON 数组（每个元素为单条候选文本，原句或简洁改写，去重），最多 ${max} 条，无候选输出 []。`,
      user: texts.join('\n'),
      json: true,
      maxTokens: 512,
    })
    const arr = Array.isArray(r.json) ? r.json : []
    const hits: string[] = []
    for (const x of arr) {
      const s = typeof x === 'string' ? x.trim() : ''
      if (s.length > 0 && !hits.includes(s)) hits.push(s)
      if (hits.length >= max) break
    }
    return hits
  } catch {
    return extractCandidatesByRules(texts, max)
  }
}

async function collectCandidatesAsync(deps: NudgeDeps): Promise<string[]> {
  if (deps.policy.nudge.candidate_extraction === 'llm') {
    return extractCandidatesByLlm(deps, recentUserTexts(deps))
  }
  return collectCandidates(deps)
}

// ── review collection ────────────────────────────────────────────────

function collectTemporalReviews(deps: NudgeDeps): ReviewItem[] {
  const items: ReviewItem[] = []
  const policy = deps.policy
  const now = deps.now

  for (const m of deps.store.listByAspectStatus('progressive', 'active')) {
    if (expireCheck(m, now) === 'expired') continue
    if (!renewalDue(m, now)) continue
    const ttl = policy.aspects.progressive.default_ttl_days ?? 7
    const ageDays = Math.floor((now - m.createdAt) / DAY_MS)
    if (m.anchor.type === 'none' || m.telicity === 'unbounded') {
      items.push({
        type: 'renewal',
        memoryId: m.id,
        text: `[renewal:${m.id}] ${m.content.slice(0, 80)} —— 已存在 ${ageDays} 天（TTL ${ttl} 天）：仍在进行→续期；已结束→转完成体（perfect）。`,
      })
    } else {
      items.push({
        type: 'expiry_suggest',
        memoryId: m.id,
        text: `[expiry_suggest:${m.id}] ${m.content.slice(0, 80)} —— 有效期内注入，到期自动抑制：端点临近请确认→结束转完成体 / 延长区间（续期）。`,
      })
    }
  }

  const reviewEvery = policy.aspects.prospective.review_every_turns ?? 30
  for (const m of deps.store.listByAspectStatus('prospective', 'active')) {
    const lastReviewed = (m.metadata?.last_reviewed_turn as number | undefined) ?? 0
    const predictBy = m.metadata?.predict_by as string | undefined
    let due = false
    let branch = ''
    if (m.modality === 'prediction') {
      if (predictBy) {
        if (deps.now >= Date.parse(predictBy)) {
          due = true
          branch = `预测已到判定日（${predictBy}）：已实现→转完成体；未实现→证伪删除；仍存疑→延长判定日。`
        } else if (deps.turnCount - lastReviewed >= reviewEvery) {
          due = true
          const leftDays = Math.ceil((Date.parse(predictBy) - deps.now) / DAY_MS)
          branch = `预测中：判定日 ${predictBy}（约剩 ${leftDays} 天）—— 请确认预测是否仍成立。`
        }
      } else if (deps.turnCount - lastReviewed >= reviewEvery) {
        due = true
        branch = '预测未带判定日（policy 要求 prediction 必带 predict_by）：请补判定日或转其他 modality。'
      }
    } else {
      if (deps.turnCount - lastReviewed >= reviewEvery) {
        due = true
        if (m.modality === 'intention') {
          branch = '意图复审三问：实现→转完成体；放弃→转完成体（曾计划也是历史事实）；继续→保留。'
        } else if (m.modality === 'plan') {
          branch = '计划复审：完成→转完成体；修订→更新内容；继续→保留。'
        } else {
          branch = '复审：保留 / 转完成体 / 删除。'
        }
      }
    }
    if (!due) continue
    items.push({
      type: 'prospective',
      memoryId: m.id,
      text: `[prospective:${m.id}] ${m.content.slice(0, 80)} —— ${branch}`,
    })
  }
  return items
}

function collectConflictReviews(deps: NudgeDeps): ReviewItem[] {
  const items: ReviewItem[] = []
  for (const aspect of ['progressive', 'perfect', 'prospective'] as Aspect[]) {
    for (const m of deps.store.listByAspectStatus(aspect, 'suppressed')) {
      let peerText: string | null = null
      for (const link of deps.store.listLinksOf(m.id)) {
        if (link.rel !== 'contradicts') continue
        const peerId = link.src === m.id ? link.dst : link.src
        const peer = deps.store.getMemory?.(peerId) ?? null
        if (peer) { peerText = peer.content.slice(0, 80); break }
      }
      const why = peerText ? `被新事实「${peerText}」剪断（contradicts）` : '被证据抑制（无 contradicts 边详情）'
      items.push({
        type: 'conflict',
        memoryId: m.id,
        text: `[conflict:${m.id}] ${m.content.slice(0, 80)} —— ${why}：恢复（提权）或确认（保持抑制）。`,
      })
    }
  }
  return items
}

// ── text rendering ───────────────────────────────────────────────────

function renderPolicySummary(policy: Policy): string[] {
  const lines: string[] = []
  lines.push(`[记忆维护提醒] 依据 policy v${policy.policy_version}（条款见 memory/policy.yaml）`)
  const prog = policy.aspects.progressive
  const perf = policy.aspects.perfect
  const pros = policy.aspects.prospective
  lines.push('- 三体映射：')
  lines.push(`  progressive: storage=${prog.storage} · injection=${prog.injection}（有效期内注入，过期即抑制） · expiry=${prog.expiry} · renewable=${prog.renewable ?? false} · TTL=${prog.default_ttl_days ?? 7} 天`)
  lines.push(`  perfect: injection=${perf.injection}（检索注入，永不主动过期）`)
  lines.push(`  prospective: injection=${pros.injection}（不注入，nudge 周期复审）`)
  lines.push(`- 门控要点：允许类别 ${policy.gate.allowed_categories.join(' / ')}；progressive 拒绝 ${policy.gate.forbidden_progressive.join(' / ')}（黑名单语义：不入注入层，可转 perfect 检索）`)
  return lines
}

export function renderNudgeText(opts: {
  policy: Policy
  reviewItems: ReviewItem[]
  candidates: string[]
  turnCount: number
  now: number
  sessionStartTs: number
}): string {
  const lines: string[] = []
  lines.push('<system-reminder>')
  lines.push(...renderPolicySummary(opts.policy))

  if (opts.reviewItems.length > 0) {
    lines.push('')
    lines.push('时间性复审问询（逐条回答：续期/删除/实现/放弃/继续/恢复/确认）：')
    for (const item of opts.reviewItems) lines.push(`  - ${item.text}`)
  }

  if (opts.candidates.length > 0) {
    lines.push('')
    lines.push('本窗口候选记忆（供确认，写入仍过门控）：')
    for (const c of opts.candidates) lines.push(`  - ${c.slice(0, 120)}`)
  }

  if (opts.policy.nudge.include_session_timeline) {
    const spanH = Math.max(1, Math.round((opts.now - opts.sessionStartTs) / 3_600_000))
    lines.push('')
    lines.push(`会话时间轴：开始于 ${new Date(opts.sessionStartTs).toISOString()}，当前 ${new Date(opts.now).toISOString()}（跨度约 ${spanH}h / 共 ${opts.turnCount} 轮）`)
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}

// ── main entry ───────────────────────────────────────────────────────

export function buildNudge(deps: NudgeDeps): NudgeResult {
  const every = deps.policy.nudge.every_turns
  if (every <= 0 || deps.turnCount <= 0 || deps.turnCount % every !== 0) {
    return { trigger: false, text: null, reviewItems: [] }
  }
  return buildNudgeCore(deps, collectCandidates(deps))
}

export async function buildNudgeAsync(deps: NudgeDeps): Promise<NudgeResult> {
  const every = deps.policy.nudge.every_turns
  if (every <= 0 || deps.turnCount <= 0 || deps.turnCount % every !== 0) {
    return { trigger: false, text: null, reviewItems: [] }
  }
  return buildNudgeCore(deps, await collectCandidatesAsync(deps))
}

function buildNudgeCore(deps: NudgeDeps, candidates: string[]): NudgeResult {
  const reviewItems: ReviewItem[] = []
  if (deps.policy.nudge.review_temporal) reviewItems.push(...collectTemporalReviews(deps))
  if (deps.policy.nudge.review_conflicts) reviewItems.push(...collectConflictReviews(deps))

  const text = renderNudgeText({
    policy: deps.policy,
    reviewItems,
    candidates,
    turnCount: deps.turnCount,
    now: deps.now,
    sessionStartTs: deps.sessionStartTs,
  })
  return { trigger: true, text, reviewItems }
}

// ── dsh scheduler shell (loose types; compiles without dsh) ──────────

export interface NudgePluginOptions {
  store: NudgeStore
  policy: Policy
  sessionIdOf?: (session: unknown) => string | undefined
  hook?: string
  llm?: LlmLike
}

export class NudgePlugin {
  private turnCount = 0
  private sessionStartTs: number | undefined
  private lastNudgedTurn = -1
  private recentUserTexts: string[] = []
  private lastSessionId: string | undefined

  constructor(private opts: NudgePluginOptions) {}

  attach(ctx: unknown): void {
    const c = ctx as { on?: (ev: string, fn: (...args: unknown[]) => unknown) => unknown }
    if (!c?.on) {
      throw new Error('NudgePlugin.attach 需要 dsh ctx（含 on 方法）；无 dsh 环境请用 onSessionEvent/maybeNudge 手动驱动')
    }
    c.on('session/event', (...args: unknown[]) => this.onSessionEvent(args[1], args[0]))
    c.on(this.opts.hook ?? 'agent/pre-step', (...args: unknown[]) =>
      this.maybeNudge(args[0], args[1] as () => Promise<unknown>),
    )
  }

  onSessionEvent(event: unknown, session?: unknown): void {
    const e = event as { type?: string; data?: unknown }
    if (e?.type === 'turn/end') {
      this.turnCount++
      if (this.sessionStartTs === undefined) this.sessionStartTs = Date.now()
      this.lastSessionId = this.opts.sessionIdOf?.(session)
    } else if (e?.type === 'user/message') {
      const data = e.data as { content?: Array<{ type?: string; text?: string }> } | undefined
      for (const block of data?.content ?? []) {
        if (block?.type === 'text' && block.text !== undefined) {
          this.recentUserTexts.push(block.text)
          if (this.recentUserTexts.length > 20) this.recentUserTexts.shift()
        }
      }
    }
  }

  async maybeNudge(payload: unknown, next: () => Promise<unknown>): Promise<unknown> {
    const decision = await next()
    const d = decision as { kind?: string; messages?: unknown[] } | null
    if (!d || d.kind === 'reject' || !Array.isArray(d.messages)) return decision
    const p = payload as { step?: number; messages?: unknown[] }
    if (p?.step !== 1) return decision

    const every = this.opts.policy.nudge.every_turns
    const due = every > 0 && this.turnCount > 0 && this.turnCount % every === 0 && this.turnCount !== this.lastNudgedTurn
    if (!due) return decision
    this.lastNudgedTurn = this.turnCount

    const now = Date.now()
    const result = await buildNudgeAsync({
      store: this.opts.store,
      policy: this.opts.policy,
      now,
      turnCount: this.turnCount,
      sessionStartTs: this.sessionStartTs ?? now,
      sessionId: this.lastSessionId,
      llm: this.opts.llm,
    })
    if (!result.trigger || !result.text) return decision

    const nudgeMessage = {
      role: 'user',
      content: [{ type: 'text', text: result.text }],
      source: { kind: 'plugin', plugin: 'foresight-nudge', form: 'notice', summary: '记忆维护提醒：续期/意图复审/冲突复核' },
    }
    const claimed = d.messages.findLastIndex((m: unknown) => (p.messages as unknown[] | undefined)?.includes(m))
    this.opts.store.emit?.('nudge.inject', null, { turn: this.turnCount, items: result.reviewItems.map((i) => i.type) })
    return {
      kind: 'enter',
      messages: d.messages.toSpliced(claimed + 1, 0, nudgeMessage),
    }
  }
}

// ── cordis plugin entry (dsh loader convention: name + apply) ────────

export const name = 'foresight-nudge'
export const inject = ['foresight']

/** dsh assembly: construct NudgePlugin from ctx.foresight and attach. */
export function apply(ctx: unknown): () => void {
  const fsight = (ctx as { foresight?: { store?: NudgeStore; policy?: Policy; llm?: LlmLike } }).foresight
  if (!fsight?.store || !fsight.policy) {
    throw new Error('foresight-nudge 需要 foresight 服务（@foresight/memory 主插件）')
  }
  const plugin = new NudgePlugin({ store: fsight.store, policy: fsight.policy, llm: fsight.llm })
  plugin.attach(ctx)
  return () => { /* nudge has no resource cleanup */ }
}
