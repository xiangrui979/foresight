/**
 * ForeSight write gate (design §5/§14).
 *
 * Flow:
 *   1. Precheck: non-empty / length cap / category blacklist (categoryHint early exit)
 *   2. Classify (injectable classifier; production = buildClassifyFn + rules fallback)
 *   3. Validate: gnomic reject → blacklist×progressive reject → prospective modality
 *      constraints → aspect-text strong signal check
 *   4. Pass → build MemoryInput (activation = policy.activation.base_weights[source])
 *      → store.insertMemory → audit event memory.write (clause code)
 *
 * Rejection emits gate.reject (clause); permission violation emits permission.deny.
 * Clause codes: `<block>.<category>.<seq>` (policy.yaml comment convention).
 */
import type { Aspect, Anchor, MemorySource, Modality, Policy, Telicity } from '../types.js'
import type { Memory, Store } from '../store.js'
import type { ClassifyFn, ClassifyResult } from './classify.js'
import { buildClassifyFn } from './classify.js'
import { canWrite } from '../govern/permission.js'

export const GATE_MAX_TEXT_CHARS = 2000

export const GATE_CLAUSES = {
  PERMISSION_DENY: 'permission.1.1',
  EMPTY: 'gate.1.1',
  TOO_LONG: 'gate.1.2',
  FORBIDDEN_CATEGORY: 'gate.1.3',
  CLASSIFY_FAILED: 'gate.2.1',
  GNOMIC: 'gate.3.1',
  FORBIDDEN_PROGRESSIVE: 'gate.4.1',
  PREDICTION_NO_DATE: 'gate.4.2',
  COMMITMENT: 'gate.4.3',
  ASPECT_TEXT_CONFLICT: 'gate.4.4',
  MODALITY_MISSING: 'gate.4.5',
  WRITE_OK: 'gate.5.1',
} as const

export interface GateWriteInput {
  text: string
  source: MemorySource
  sourceRef?: string | null
  categoryHint?: string | null
  now?: Date
}

export interface GateDeps {
  policy: Policy
  store: Store
  classifyFn?: ClassifyFn
  permission?: { actor: string; target?: string }
  emit?: (type: string, target: string | null, detail: Record<string, unknown> | null, clause?: string) => void
  embedFn?: (text: string) => Promise<Float32Array | null>
  conflictResolver?: ConflictResolverLike
}

export interface ConflictResolverLike {
  resolve(n: Memory, policy: Policy): Promise<void> | void
}

export interface GateReceipt {
  ok: boolean
  memory: Memory | null
  clause?: string
  message: string
  suggestion: string | null
  classification: ClassifyResult | null
  eventType: string
}

/** Strong completion/ongoing markers (aspect-text consistency, inherited from phase 1). */
const DONE_MARK = /(已完成|已经完成|已结束|结束了|做完了|搞定了|完成了|竣工|结项|收官)/
const DOING_MARK = /(正在|进行中|在跑|在学|在写|在开发|在训练|持续中|过程中)/

export async function gateWrite(input: GateWriteInput, deps: GateDeps): Promise<GateReceipt> {
  const { policy, store } = deps
  const emit = deps.emit ?? ((t, tg, d, c) => store.emit(t, tg, d, c))
  const actor = deps.permission?.actor ?? input.source
  const target = deps.permission?.target ?? 'memories'
  const now = input.now ?? new Date()
  const text = (input.text ?? '').trim()

  // ── 0. Permission precheck: violation → permission.deny audit + decline
  if (!canWrite(actor, target, policy)) {
    const message = `写入方 ${actor} 无权写入目标 ${target}：Root 可写一切；agent 仅可写 ${policy.permission.agent_writable.join('/')} 与 links；user.md 唯一入口是 derive user_trait 路由`
    return reject(emit, 'permission.deny', GATE_CLAUSES.PERMISSION_DENY, message, null, null)
  }

  // ── 1. Precheck
  if (!text) {
    return reject(emit, 'gate.reject', GATE_CLAUSES.EMPTY, '记忆内容为空，拒绝写入', null, null)
  }
  if (text.length > GATE_MAX_TEXT_CHARS) {
    return reject(
      emit, 'gate.reject', GATE_CLAUSES.TOO_LONG,
      `文本超长（${text.length} > ${GATE_MAX_TEXT_CHARS} 字符），请分块写入`, null, null,
    )
  }
  if (input.categoryHint && policy.gate.forbidden_categories.includes(input.categoryHint)) {
    return reject(
      emit, 'gate.reject', GATE_CLAUSES.FORBIDDEN_CATEGORY,
      `类别 ${input.categoryHint} 在黑名单（仅可作完成事实入 perfect 检索层）`,
      '改写为完成事实（转 perfect）后写入', null,
    )
  }

  // ── 2. Classify (extract-as-annotate; degradation: LLM → rules → null)
  const classifyFn = deps.classifyFn ?? buildClassifyFn(policy, null)
  const classification = await classifyFn({ now, text })
  if (!classification) {
    return reject(
      emit, 'gate.reject', GATE_CLAUSES.CLASSIFY_FAILED,
      '分类失败（LLM 与规则判据均不可用），拒绝写入——绝不静默放行', null, null,
    )
  }

  // ── 3. Validate
  const violation = aspectViolation(
    {
      aspect: classification.aspect,
      category: classification.category,
      modality: classification.modality,
      predictBy: classification.predictBy,
      text: classification.text,
    },
    policy,
  )
  if (violation) {
    return reject(emit, 'gate.reject', violation.clause, violation.message, violation.suggestion, classification)
  }

  // ── 4. Anchor fallback + field refinement
  const c = classification
  const anchor: Anchor = c.anchor.type === 'none' ? anchorFallback(c.aspect, now) : c.anchor
  const telicity: Telicity | null = c.aspect === 'progressive'
    ? (c.telicity ?? 'unbounded')
    : null
  const modality: Modality | null = c.aspect === 'prospective' ? c.modality : null

  // ── 5. Embed on write (fail → null: degrade, never block)
  let embedding: Float32Array | null = null
  if (deps.embedFn) {
    try {
      embedding = await deps.embedFn(c.text)
    } catch {
      embedding = null
    }
  }

  // ── 6. Persist
  const activation = policy.activation.base_weights[input.source] ?? 1.0
  const memory = store.insertMemory({
    content: c.text,
    aspect: c.aspect as Aspect,
    anchor,
    category: c.category ?? input.categoryHint ?? null,
    telicity,
    modality,
    activation,
    baseWeight: activation,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    metadata: c.predictBy ? { predict_by: c.predictBy } : {},
    embedding,
  })

  // ── 7. Conflict resolution (design §11): may suppress the new entry
  let conflictNote: string | null = null
  if (deps.conflictResolver) {
    try {
      await deps.conflictResolver.resolve(memory, policy)
      const after = store.getMemory(memory.id)
      if (after && after.status === 'suppressed') {
        conflictNote = '冲突消解：本条被既有更强证据剪断（suppressed）'
      }
    } catch {
      conflictNote = null
    }
  }

  emit(
    'memory.write', memory.id,
    {
      aspect: c.aspect, category: c.category, telicity, modality,
      source: input.source, activation, classify_source: c.source,
      embedded: embedding !== null,
      conflict: conflictNote ?? null,
    },
    GATE_CLAUSES.WRITE_OK,
  )
  return {
    ok: true, memory, clause: GATE_CLAUSES.WRITE_OK,
    message: conflictNote ? `写入成功（已过门控）；${conflictNote}` : '写入成功（已过门控）',
    suggestion: null,
    classification: c, eventType: 'memory.write',
  }
}

function anchorFallback(aspect: string, now: Date): Anchor {
  const today = now.toISOString().slice(0, 10)
  if (aspect === 'perfect') return { type: 'point', start: today }
  if (aspect === 'prospective') return { type: 'open', start: today }
  return { type: 'none' }
}

function reject(
  emit: GateDeps['emit'],
  eventType: string,
  clause: string,
  message: string,
  suggestion: string | null,
  classification: ClassifyResult | null,
): GateReceipt {
  emit?.(
    eventType, null,
    {
      clause, message, suggestion,
      classification: classification
        ? { aspect: classification.aspect, category: classification.category, text: classification.text }
        : null,
    },
    clause,
  )
  return { ok: false, memory: null, clause, message, suggestion, classification, eventType }
}

// ── Aspect-text / category / modality validation (shared shape) ─────────

interface Validatable {
  aspect: Aspect
  category: string | null
  modality: Modality | null
  predictBy: string | null
  text: string
}

/**
 * Aspect-level validation: returns {clause, message, suggestion} or null (pass).
 * Order: gnomic → blacklist×progressive → prospective modality → aspect-text strong signals.
 * Ambiguous (not in strong signal set) → pass, nudge review later.
 */
function aspectViolation(c: Validatable, policy: Policy): { clause: string; message: string; suggestion: string } | null {
  if (c.aspect === 'gnomic') {
    return {
      clause: GATE_CLAUSES.GNOMIC,
      message: '无时间性内容请提交用户确认——写入 SOUL/user 的通道是 derive user_trait 路由（gnomic 不入 memories）',
      suggestion: '提交画像/规则给用户，或由派生管线的 user_trait 路由写入 user.md',
    }
  }
  if (c.aspect === 'progressive' && c.category !== null && policy.gate.forbidden_progressive.includes(c.category)) {
    return {
      clause: GATE_CLAUSES.FORBIDDEN_PROGRESSIVE,
      message: `类别 ${c.category} 处于进行中状态，不适合持续注入（progressive 目标被拒）`,
      suggestion: '改写为完成事实（转 perfect）后写入，可入检索层',
    }
  }
  if (c.aspect === 'prospective') {
    if (c.modality === null) {
      return {
        clause: GATE_CLAUSES.MODALITY_MISSING,
        message: 'prospective 条目必须给 modality（prediction/intention/plan）',
        suggestion: '补充 modality 后重写',
      }
    }
    if (c.modality === 'prediction' && !c.predictBy) {
      return {
        clause: GATE_CLAUSES.PREDICTION_NO_DATE,
        message: 'prediction（断言式预测）必须给出证伪期限 predict_by，否则到期无法证伪判定',
        suggestion: '补充预测期限日期后重写',
      }
    }
    if (c.modality === 'commitment') {
      return {
        clause: GATE_CLAUSES.COMMITMENT,
        message: 'commitment（义务/承诺）不留在 prospective——义务不是事实',
        suggestion: '作为 rule 提交用户确认（长期约束），或改写为有时限义务（progressive×interval）',
      }
    }
  }
  if (c.aspect === 'progressive' && DONE_MARK.test(c.text)) {
    return {
      clause: GATE_CLAUSES.ASPECT_TEXT_CONFLICT,
      message: `体-措辞矛盾：aspect=progressive 但文本含完成标记（"${DONE_MARK.exec(c.text)?.[1] ?? ''}"）——完成义文本应判 perfect`,
      suggestion: '改判 aspect=perfect 后写入',
    }
  }
  if (c.aspect === 'perfect' && DOING_MARK.test(c.text)) {
    return {
      clause: GATE_CLAUSES.ASPECT_TEXT_CONFLICT,
      message: `体-措辞矛盾：aspect=perfect 但文本含进行标记（"${DOING_MARK.exec(c.text)?.[1] ?? ''}"）——进行义文本应判 progressive`,
      suggestion: '改判 aspect=progressive 后写入',
    }
  }
  return null
}
