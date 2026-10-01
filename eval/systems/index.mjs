/** Eval system registry (Task 1.5): name → factory. */
import { create as foresight } from './foresight.mjs'
import { create as nolifecycle } from './nolifecycle.mjs'
import { create as recency } from './recency.mjs'
import { create as rag } from './rag.mjs'
import { create as summary } from './summary.mjs'
import { create as fullcontext } from './fullcontext.mjs'
import { create as closedbook } from './closedbook.mjs'

export const SYSTEM_FACTORIES = {
  foresight,
  nolifecycle,
  recency,
  rag,
  summary,
  fullcontext,
  closedbook,
}

export const SYSTEM_NAMES = Object.keys(SYSTEM_FACTORIES)
