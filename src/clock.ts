/**
 * ForeSight Clock (Task 1.1): the ONLY module allowed to read wall time.
 *
 * Every other module takes a `ClockLike` and resolves it through
 * `normalizeClock`, so tests can time-travel with `ManualClock` and the
 * eval harness can drive deterministic runs. Grep contract:
 *   rg -n "Date\.now\(\)|new Date\(\)" src/   → only src/clock.ts
 * (`new Date(arg)` / `Date.parse(arg)` are pure conversions and allowed
 * anywhere.)
 */

export interface Clock {
  now(): number
}

/** Legacy `() => number` stays accepted for backward compatibility. */
export type ClockLike = Clock | (() => number)

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

/** Shared default clock (stateless). */
export const systemClock: Clock = new SystemClock()

/** Test/harness clock with explicit time control. */
export class ManualClock implements Clock {
  private t: number

  constructor(startMs = 0) {
    this.t = startMs
  }

  now(): number {
    return this.t
  }

  set(ms: number): this {
    this.t = ms
    return this
  }

  advanceMs(ms: number): this {
    this.t += ms
    return this
  }

  advanceDays(days: number): this {
    this.t += days * 86_400_000
    return this
  }
}

export function normalizeClock(c?: ClockLike | null): Clock {
  if (c === undefined || c === null) return systemClock
  return typeof c === 'function' ? { now: c } : c
}
