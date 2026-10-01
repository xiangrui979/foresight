#!/usr/bin/env node
/**
 * Frozen fact extraction step (Task 1.6 / SPEC §2).
 *
 * 'scripted': structured facts already present on turns (golden/offline).
 * 'llm': extractor for real runs — LLM returns JSON [{text, aspect, anchor}];
 *        parse failure → no facts (turn not written; counted in acceptance).
 *
 * The extractor id is recorded in the run config; changing extraction is a
 * pre-registration deviation.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXTRACTOR_SCRIPTED_ID = 'scripted@v1'
export const EXTRACTOR_LLM_ID = 'llm-extract@v1'

const ASPECTS = ['gnomic', 'progressive', 'perfect', 'prospective']

/** Attach scripted facts (passthrough validation). */
export function extractScripted(item) {
  return item.sessions.map((s) => ({
    ...s,
    turns: s.turns.map((t) => ({
      ...t,
      facts: (t.facts ?? []).filter((f) => ASPECTS.includes(f?.aspect) && typeof f?.text === 'string' && f.text.trim()),
    })),
  }))
}

const SYSTEM = '你是记忆事实抽取器。从对话 turn 中抽取值得长期记忆的独立事实。只输出 JSON 数组：[{"text","aspect","anchor","telicity","modality","predict_by"}]。aspect ∈ gnomic|progressive|perfect|prospective。没有可抽取事实时输出 []。'

/** LLM extraction for one turn; returns validated facts ([] on failure). */
export async function extractByLlm(llm, turnText, { model, maxTokens = 512 } = {}) {
  try {
    const r = await llm.call({ model, system: SYSTEM, user: turnText, json: true, maxTokens })
    const arr = Array.isArray(r.json) ? r.json : []
    return arr
      .filter((f) => f && ASPECTS.includes(f.aspect) && typeof f.text === 'string' && f.text.trim())
      .map((f) => ({ text: String(f.text).trim(), aspect: f.aspect, anchor: f.anchor ?? { type: 'none' }, telicity: f.telicity ?? null, modality: f.modality ?? null, predict_by: f.predict_by ?? null }))
  } catch {
    return []
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`extract.mjs — ${EXTRACTOR_SCRIPTED_ID} / ${EXTRACTOR_LLM_ID}（由 adapter 调用）`)
}
