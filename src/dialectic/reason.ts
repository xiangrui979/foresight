/**
 * ForeSight query layer: dialectic reasoning (design §12).
 *
 * Flow: retrieve (f_time time-deweight built into retrieval) →
 * collect evidence (hits with rendered anchors) → conflict detection
 * (contradicts pairs within evidence set, presented as-is, never adjudicated)
 * → synthesize via LLM (model_dialectic, json) → degrade to evidence concat
 * on LLM failure (never blocks).
 */
import type { Policy, Anchor } from '../policy.js'
import type { Store } from '../store.js'
import type { EmbedProvider } from '../store/embed.js'
import { search } from '../retrieve/search.js'

export interface SearchHit {
  id: string
  content: string
  aspect: string
  anchor: Anchor
  activation: number
  score: number
  rendered: string
}

export interface SearchOpts {
  aspect?: string
  from?: string
  to?: string
  k?: number
}

export interface SearchDeps {
  store: Store
  embed: EmbedProvider
  policy: Policy
  now: number
}

export type SearchFn = (
  query: string,
  deps: SearchDeps,
  opts?: SearchOpts,
) => Promise<SearchHit[]>

export interface LlmLike {
  call(req: {
    model: string
    system: string
    user: string
    json?: boolean
    maxTokens?: number
  }): Promise<{ content: string; json: unknown | null }>
}

export interface ReasonDeps {
  store: Store
  policy: Policy
  embed: EmbedProvider
  llm: LlmLike
  now: number
  search?: SearchFn
}

export interface Citation {
  id: string
  anchor: Anchor
  content: string
}

export interface ConflictPair {
  a: string
  b: string
}

export interface ReasonResult {
  answer: string
  citations: Citation[]
  conflicts: ConflictPair[]
}

const SYSTEM_PROMPT =
  '你是记忆系统的辩证推理器。基于给定证据回答，引用证据 id 与时间锚；遇到冲突证据如实呈现双方，不自行裁决。'

export async function reason(query: string, deps: ReasonDeps): Promise<ReasonResult> {
  const { policy } = deps
  const searchFn = deps.search ?? search

  const hits = await searchFn(
    query,
    { store: deps.store, embed: deps.embed, policy, now: deps.now },
    { k: policy.dialectic.top_k },
  )

  const citations: Citation[] = hits.map((h) => ({
    id: h.id,
    anchor: h.anchor,
    content: h.content,
  }))

  const conflicts = policy.dialectic.include_contradictions
    ? findConflicts(deps.store, hits)
    : []

  if (hits.length === 0) {
    return { answer: '未检索到相关证据。', citations, conflicts }
  }

  const user = buildPrompt(query, hits, conflicts)

  let answer: string
  try {
    const res = await deps.llm.call({
      model: policy.llm.model_dialectic,
      system: SYSTEM_PROMPT,
      user,
      json: true,
      maxTokens: 1024,
    })
    answer = parseAnswer(res.json) ?? fallbackAnswer(hits)
  } catch {
    answer = fallbackAnswer(hits)
  }

  return { answer, citations, conflicts }
}

function findConflicts(store: Store, hits: SearchHit[]): ConflictPair[] {
  const ids = new Set(hits.map((h) => h.id))
  const seen = new Set<string>()
  const out: ConflictPair[] = []
  for (const h of hits) {
    for (const link of store.listLinksOf(h.id)) {
      if (link.rel !== 'contradicts') continue
      if (!ids.has(link.src) || !ids.has(link.dst)) continue
      const key = link.src < link.dst ? `${link.src}|${link.dst}` : `${link.dst}|${link.src}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: link.src, b: link.dst })
    }
  }
  return out
}

function buildPrompt(query: string, hits: SearchHit[], conflicts: ConflictPair[]): string {
  const lines = hits.map(
    (h, i) => `[${i + 1}] id=${h.id} | 时间锚=${h.rendered} | ${h.content}`,
  )
  let prompt = `证据列表：\n${lines.join('\n')}`
  if (conflicts.length > 0) {
    prompt +=
      `\n\n冲突说明（以下证据对互相矛盾，回答时必须如实呈现双方观点，不自行裁决）：\n` +
      conflicts.map((c) => `- id=${c.a} ↔ id=${c.b}`).join('\n')
  }
  prompt += `\n\n用户问题：${query}`
  return prompt
}

function parseAnswer(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const a = (json as Record<string, unknown>).answer
    if (typeof a === 'string' && a.trim().length > 0) return a
  }
  return null
}

function fallbackAnswer(hits: SearchHit[]): string {
  return hits.map((h) => `[${h.id}] ${h.rendered ?? h.content}`).join('\n')
}
