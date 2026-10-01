/**
 * Unified budget renderer (Task 1.5 / C6 + D17).
 *
 * All eval systems inject through this helper with the SAME frozen token
 * counter and budget: greedy in the given order (systems sort by their own
 * score), skip items that do not fit, never partially include.
 * budget 0/absent = unlimited.
 */
import { estimateTokens } from './tokens.mjs'

/**
 * @param {Array<{text:string,[k:string]:unknown}>} items
 * @param {number} budgetTokens
 * @param {(text:string)=>number} [countTokens]
 * @returns {{included:Array<object>, excluded:Array<object>, tokens:number}}
 */
export function renderWithinBudget(items, budgetTokens, countTokens = estimateTokens) {
  const out = { included: [], excluded: [], tokens: 0 }
  if (!Array.isArray(items)) return out
  const budget = Number(budgetTokens ?? 0)
  for (const item of items) {
    const t = countTokens(item?.text ?? '')
    if (budget > 0 && out.tokens + t > budget) {
      out.excluded.push(item)
      continue
    }
    out.included.push(item)
    out.tokens += t
  }
  return out
}
