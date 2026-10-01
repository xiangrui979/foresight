/**
 * ForeSight extraction layer: gate classifier (design §5).
 *
 * Classifies a candidate memory text into {category, aspect, anchor,
 * telicity, modality, text} — already the row schema, no intermediate state.
 *
 * Degradation chain (never silently pass):
 *   1. LLM (policy.gate.llm_model; JSON schema + few-shot per aspect)
 *   2. Chinese morphosyntactic rules (policy.chinese_markers strong signals)
 *   3. Still failing → null → gate declines (no silent pass)
 *
 * All few-shot examples are fictional, generic content.
 */
import type { Anchor, Aspect, Modality, Policy, Telicity } from '../types.js'

export interface ClassifyInput {
  now: Date
  text: string
}

export interface ClassifyResult {
  category: string | null
  aspect: Aspect
  anchor: Anchor
  telicity: Telicity | null
  modality: Modality | null
  predictBy: string | null
  text: string
  source: 'llm' | 'rules'
  reasoning?: string
}

export type ClassifyFn = (input: ClassifyInput) => Promise<ClassifyResult | null>

const ASPECTS: readonly Aspect[] = ['gnomic', 'progressive', 'perfect', 'prospective']
const MODALITIES: readonly Modality[] = ['prediction', 'intention', 'plan', 'commitment']

// ── Chinese morphosyntactic strong-signal subset (mechanical impl of
//    policy.chinese_markers). Conservative: ambiguous signals → null (decline).
const MARKER_HUI = /会/
const MARKER_YAO = /要/
const MARKER_DONE = /(了|过|已|完成|结束|做完|搞完)/
const MARKER_DOING = /(正在|进行中|在跑|在学|在写|在开发|在训练|在运行|在测试|在部署|持续中)/

export interface LlmCaller {
  call(req: {
    model: string
    system: string
    user: string
    json: boolean
    maxTokens?: number
  }): Promise<{ json: unknown }>
}

export function buildClassifyFn(policy: Policy, llm: LlmCaller | null): ClassifyFn {
  return async ({ now, text }): Promise<ClassifyResult | null> => {
    // Eval classifier switch (C5/DECISIONS §15): 'rules' = A (zero LLM);
    // 'llm' = B; undefined = legacy behavior (LLM when available).
    if (policy.gate.classifier === 'rules') return classifyByRules(policy, now, text)
    if (llm) {
      try {
        const resp = await llm.call({
          model: policy.gate.llm_model,
          system: buildSystemPrompt(policy),
          user: `当前时间: ${now.toISOString()}\n候选记忆条目: ${text}`,
          json: true,
          maxTokens: 1000,
        })
        const r = normalizeLlmResult(policy, resp.json)
        if (r) return { ...r, source: 'llm' }
      } catch {
        /* fall through to rules */
      }
    }
    return classifyByRules(policy, now, text)
  }
}

/** Rules classifier: 会/要/了过/在正在/none. Done+doing mixed → null (decline). */
export function classifyByRules(policy: Policy, now: Date, text: string): ClassifyResult | null {
  const t = text.trim()
  if (!t) return null
  const hui = MARKER_HUI.test(t)
  const yao = MARKER_YAO.test(t)
  const done = MARKER_DONE.test(t)
  const doing = MARKER_DOING.test(t)
  if (done && doing) return null // mixed: mechanics cannot decide
  const today = isoDateUTC(now)
  if (hui) {
    return {
      category: null, aspect: 'prospective',
      anchor: { type: 'open', start: today },
      telicity: null, modality: 'prediction',
      predictBy: extractDate(t, now), text: t, source: 'rules',
    }
  }
  if (yao) {
    return {
      category: null, aspect: 'prospective',
      anchor: { type: 'open', start: today },
      telicity: null, modality: 'intention',
      predictBy: null, text: t, source: 'rules',
    }
  }
  if (done) {
    return {
      category: null, aspect: 'perfect',
      anchor: { type: 'point', start: today },
      telicity: null, modality: null,
      predictBy: null, text: t, source: 'rules',
    }
  }
  if (doing) {
    return {
      category: null, aspect: 'progressive',
      anchor: { type: 'none' },
      telicity: 'unbounded', modality: null,
      predictBy: null, text: t, source: 'rules',
    }
  }
  // Unmarked plain statement → gnomic (gate declines & routes to SOUL/user)
  return {
    category: null, aspect: 'gnomic',
    anchor: { type: 'none' },
    telicity: null, modality: null,
    predictBy: null, text: t, source: 'rules',
  }
}

// ── LLM prompt ──────────────────────────────────────────────────────────

export function buildSystemPrompt(policy: Policy): string {
  const allowed = policy.gate.allowed_categories.join('|')
  const forbidden = policy.gate.forbidden_categories.join('|')
  return `你是记忆写入门控分类器。为一条候选记忆条目输出结构化分类字段（JSON，不输出其他内容）。
字段 schema:
{
  "category": "${allowed}"（或黑名单类别 ${forbidden}，如实标注）,
  "aspect": "gnomic|progressive|perfect|prospective",
  "anchor": {"type":"none"} | {"type":"point","start":"YYYY-MM-DD"} | {"type":"interval","start":"YYYY-MM-DD","end":"YYYY-MM-DD"} | {"type":"open","start":"YYYY-MM-DD"},
  "telicity": "bounded|unbounded|null",
  "modality": "prediction|intention|plan|commitment|null",
  "predict_by": "YYYY-MM-DD|null",
  "text": "条目正文（中文，准确陈述，含必要时态措辞）",
  "reasoning": "一句话分类理由"
}

分类规则:
1. category 内容类别（黑名单类别不禁止标注，由门控裁决去向）:
   - rule=约束行为自身的持久条款(称呼规则/安全红线/工作方式)
   - identity=用户稳定身份事实
   - environment=机器/路径/工具链/网络等环境事实
   - critical_reminder=不可丢失的重大警示
   - task_progress=具体任务的一次性进度(监控在跑/训练到第几轮)
   - project_state=项目细节/文件清单/配置快照
   - opinion=观点/评价/临时判断
   - session_log=会话流水/完成日志
2. aspect 体(事件的时间结构):
   - gnomic 恒常体: 无时间点,永远为真的规律/特征——无时间性内容归宿是 SOUL/user,不进记忆系统
   - progressive 进行体: 当前进行中、终将结束
   - perfect 完成体: 已完成、仍与当下相关
   - prospective 未然体: 意图/预测/计划,尚非事实
3. anchor 时间锚定: 无锚/时点/闭区间/开放区间。progressive 优先给区间;无区间可不给(系统 TTL 兜底)。
4. telicity 终结性(仅 progressive 需要,否则 null): bounded=有自然终点;unbounded=无自然终点。
5. modality 情态(仅 prospective 需要,否则 null):
   - prediction=断言式预测(可被未来证伪,须给 predict_by 期限)
   - intention=意图(想做,无真值)
   - plan=计划(可修订)
   - commitment=义务/承诺(不留在 prospective——长期行为约束改判 gnomic,有时限义务改判 progressive×interval)
6. 体-措辞一致(中文判据): 正文含"会X"→prediction;"要X"→intention;"在/正在"→progressive;"了/过"→perfect;无标记恒常陈述→gnomic。字段与措辞矛盾时以语义为准改措辞。
7. 认知情态豁免: "可能X""也许X"类推测 → category=opinion,不判为 prediction。
8. 预测的证伪: 只有断言式预测(prediction)需要 predict_by。"可能"类已在规则7豁免。

few-shot 示例（虚构示例，仅示范结构）:
输入: "网站的部署上线正在进行,预计本周五完成"
输出: {"category":"task_progress","aspect":"progressive","anchor":{"type":"interval","start":"2026-07-01","end":"2026-07-03"},"telicity":"bounded","modality":null,"predict_by":null,"text":"网站的部署上线正在进行,预计本周五完成","reasoning":"进行中有自然终点=bounded 区间进行体"}

输入: "训练任务还在跑,没有结束时间"
输出: {"category":"task_progress","aspect":"progressive","anchor":{"type":"none"},"telicity":"unbounded","modality":null,"predict_by":null,"text":"训练任务还在跑,没有结束时间","reasoning":"无终点的进行态任务进度=unbounded"}

输入: "开发者上个月完成了接口联调"
输出: {"category":"project_state","aspect":"perfect","anchor":{"type":"point","start":"2026-06-15"},"telicity":null,"modality":null,"predict_by":null,"text":"开发者上个月完成了接口联调","reasoning":"带时间点的已完成事件=完成体"}

输入: "团队上周通过了内部评审"
输出: {"category":"project_state","aspect":"perfect","anchor":{"type":"point","start":"2026-06-10"},"telicity":null,"modality":null,"predict_by":null,"text":"团队上周通过了内部评审","reasoning":"带时间点的已完成事件=完成体"}

输入: "用户计划下个月对系统做回归验证"
输出: {"category":"project_state","aspect":"prospective","anchor":{"type":"open","start":"2026-07-01"},"telicity":null,"modality":"plan","predict_by":null,"text":"用户计划下个月对系统做回归验证","reasoning":"可修订的计划=未然体plan"}

输入: "明天会下雨"
输出: {"category":"opinion","aspect":"prospective","anchor":{"type":"open","start":"2026-07-01"},"telicity":null,"modality":"prediction","predict_by":"2026-07-02","text":"明天会下雨","reasoning":"断言式预测,给证伪期限"}`
}

// ── LLM result normalization ──────────────────────────────────────────

function normalizeLlmResult(policy: Policy, json: unknown): Omit<ClassifyResult, 'source'> | null {
  if (typeof json !== 'object' || json === null) return null
  const g = json as Record<string, unknown>
  if (typeof g.aspect !== 'string' || !(ASPECTS as readonly string[]).includes(g.aspect)) return null
  const aspect = g.aspect as Aspect
  const category = typeof g.category === 'string' && g.category.length > 0 ? g.category : null
  const text = typeof g.text === 'string' ? g.text.trim() : ''
  if (!text) return null

  const anchor = normalizeAnchor(g.anchor) ?? { type: 'none' } as Anchor

  let telicity: Telicity | null = null
  if (aspect === 'progressive') {
    const allowed = policy.aspects.progressive.telicity?.values ?? ['bounded', 'unbounded']
    telicity = typeof g.telicity === 'string' && allowed.includes(g.telicity)
      ? g.telicity as Telicity : null
  }

  let modality: Modality | null = null
  if (aspect === 'prospective') {
    modality = typeof g.modality === 'string' && (MODALITIES as readonly string[]).includes(g.modality)
      ? g.modality as Modality : null
  }

  const rawPb = g.predict_by ?? g.predictBy
  const predictBy = typeof rawPb === 'string' && rawPb.length > 0 ? rawPb : null

  return {
    category, aspect, anchor, telicity, modality, predictBy, text,
    reasoning: typeof g.reasoning === 'string' ? g.reasoning : undefined,
  }
}

/** Anchor normalization: degrade half anchors, never keep a truncated one. */
function normalizeAnchor(raw: unknown): Anchor | null {
  if (typeof raw !== 'object' || raw === null) return null
  const a = raw as Record<string, unknown>
  const type = a.type
  if (type === 'none') return { type: 'none' }
  if (type === 'point') {
    const start = pickStr(a, ['start', 'at'])
    return start ? { type: 'point', start } : null
  }
  if (type === 'interval') {
    const start = pickStr(a, ['start', 'from'])
    const end = pickStr(a, ['end', 'to'])
    if (start && end) return { type: 'interval', start, end }
    if (start) return { type: 'open', start }
    return null
  }
  if (type === 'open') {
    const start = pickStr(a, ['start', 'from'])
    return start ? { type: 'open', start } : null
  }
  return null
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && (obj[k] as string).length > 0) return obj[k] as string
  }
  return null
}

// ── Mechanical date extraction (rules path) ─────────────────────────────

const DAY_MS = 86_400_000
const WEEKDAYS: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }

export function extractDate(text: string, now: Date): string | null {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  if (/明天/.test(text)) return isoDateUTC(new Date(now.getTime() + DAY_MS))
  if (/后天/.test(text)) return isoDateUTC(new Date(now.getTime() + 2 * DAY_MS))
  if (/今天/.test(text)) return isoDateUTC(now)
  const nw = text.match(/下周([一二三四五六日天])/)
  if (nw && nw[1] in WEEKDAYS) {
    const target = WEEKDAYS[nw[1]]
    // UTC weekday (C8): local timezone must never shift the anchor date.
    let diff = (target - now.getUTCDay() + 7) % 7
    if (diff === 0) diff = 7
    return isoDateUTC(new Date(now.getTime() + diff * DAY_MS))
  }
  const days = text.match(/(\d+)\s*天(?:后|之内)/)
  if (days) return isoDateUTC(new Date(now.getTime() + Number(days[1]) * DAY_MS))
  return null
}

/** UTC ISO date (YYYY-MM-DD); timezone-independent by contract (C8). */
export function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** @deprecated use isoDateUTC — kept as an alias for older callers. */
export const isoDate = isoDateUTC
