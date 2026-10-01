#!/usr/bin/env node
/**
 * stale_gt annotator (Task 1.6 / D14) — rules-first, frozen version.
 *
 * Definition (DECISIONS §12): for knowledge-update items, an injected
 * memory is stale when it contains the pre-update value `old` of an update
 * pair and does not contain the updated `new` value.
 *
 * Contract:
 *  - annotateStale(item, memories) → [{memory_id, stale_gt, stale_reason}]
 *  - never reads/uses the item answer for memory-side writes (leak control)
 *  - STALE_ANNOTATOR_ID is recorded in trace.versions.stale_annotator
 *
 * Selfcheck: node eval/lib/stale.mjs --selfcheck
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STALE_ANNOTATOR_ID = 'rules@v1'

export function annotateStale(item, memories) {
  const out = []
  const pairs = Array.isArray(item?.stale) ? item.stale : []
  if (pairs.length === 0) return out
  for (const m of memories ?? []) {
    const content = String(m.content ?? '')
    for (const pair of pairs) {
      const oldV = String(pair?.old ?? '')
      const newV = String(pair?.new ?? '')
      if (oldV && content.includes(oldV) && (!newV || !content.includes(newV))) {
        out.push({ memory_id: m.id ?? m.memory_id, stale_gt: true, stale_reason: 'pre_update_value' })
        break
      }
    }
  }
  return out
}

export function staleIdSet(item, memories) {
  return new Set(annotateStale(item, memories).map((m) => m.memory_id))
}

/** SIR-i computed from annotated marks over included entries. */
export function annotateTrace(item, injected) {
  const stale = staleIdSet(item, injected)
  return {
    annotator: STALE_ANNOTATOR_ID,
    injected: injected.map((e) => ({
      ...e,
      stale_gt: stale.has(e.memory_id ?? e.id),
      stale_reason: stale.has(e.memory_id ?? e.id) ? 'pre_update_value' : null,
    })),
  }
}

async function selfCheck() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selfcheck 失败: ${msg}`)
  }
  const item = { stale: [{ old: '大学生', new: '研究生' }] }
  const memories = [
    { id: 'm1', content: '用户是大学生' },
    { id: 'm2', content: '用户是研究生' },
    { id: 'm3', content: '用户喜欢咖啡' },
  ]
  const marks = annotateStale(item, memories)
  assert(marks.length === 1 && marks[0].memory_id === 'm1', '只标记旧值记忆')
  assert(marks[0].stale_reason === 'pre_update_value', 'reason 口径')
  const t = annotateTrace(item, memories.map((m) => ({ memory_id: m.id, content: m.content })))
  assert(t.injected.find((e) => e.memory_id === 'm1').stale_gt === true, 'trace 注入标注')
  assert(t.injected.find((e) => e.memory_id === 'm2').stale_gt === false, '当前值不标')
  assert(STALE_ANNOTATOR_ID === 'rules@v1', '版本冻结')
  console.log('✔ stale.mjs selfcheck 通过（rules@v1 / 旧值匹配 / trace 标注）')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selfcheck')) {
    selfCheck().catch((e) => {
      console.error(`✘ ${e.message}`)
      process.exitCode = 1
    })
  } else {
    console.log('stale.mjs — 使用 --selfcheck；接口 annotateStale/staleIdSet/annotateTrace。')
  }
}
