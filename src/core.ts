/**
 * ForeSight core service: assembles store/policy/embed/llm + layers,
 * exposes to dsh plugins (tools/inject/observer/nudge/server) via ctx.foresight.
 * Wiring: write = gate + embed + conflict; turnEnd = derive trigger.
 */
import { openDatabase, type Schema } from './schema.js'
import { Store } from './store.js'
import { OllamaEmbedProvider, type EmbedProvider } from './store/embed.js'
import { loadPolicyFromRoot, type Policy } from './policy.js'
import { LlmProvider, type LlmBackend, type LlmResponse } from './llm/provider.js'
export type { LlmResponse } from './llm/provider.js'
type LlmLike = { call(req: { model: string; system: string; user: string; json?: boolean; maxTokens?: number }): Promise<LlmResponse> }
import { gateWrite, type GateDeps, type GateWriteInput, type GateReceipt } from './gate/gate.js'
import { buildClassifyFn } from './gate/classify.js'
import { ConflictResolver } from './evolve/conflict.js'
import { search, type SearchHit, type SearchOptions } from './retrieve/search.js'
import { reason as dialecticReason, type ReasonDeps, type ReasonResult } from './dialectic/reason.js'
import { Deriver } from './derive/deriver.js'
import { resolveConfig, ensureDataDir, type Config } from './config.js'
import { normalizeClock, type Clock, type ClockLike } from './clock.js'
import { sweepExpired } from './evolve/temporal.js'
import * as path from 'node:path'

export interface ForeSightOptions extends Partial<Config> {
  /** Injectable clock (ManualClock in tests / eval time travel). */
  clock?: ClockLike
}

export interface Actor {
  name: string
  isRoot: boolean
}

export class ForeSight {
  readonly policy: Policy
  readonly store: Store
  readonly embed: EmbedProvider
  readonly llm: LlmLike
  readonly memoryRoot: string
  readonly clock: Clock
  private conflictResolver: ConflictResolver
  private deriver: Deriver | null = null
  private schema: Schema

  constructor(opts: ForeSightOptions = {}) {
    const cfg = resolveConfig(opts)
    ensureDataDir(cfg)
    this.memoryRoot = cfg.memoryRoot
    this.policy = loadPolicyFromRoot(this.memoryRoot)
    this.schema = openDatabase(path.join(this.memoryRoot, cfg.dbFile))
    this.clock = normalizeClock(opts.clock)
    const logFile = this.policy.audit.log_file
    this.store = new Store(this.schema, logFile ? path.join(this.memoryRoot, logFile) : null, this.clock)
    this.embed = new OllamaEmbedProvider({
      baseUrl: cfg.embedBaseUrl,
      model: cfg.embedModel,
    })
    const backend: LlmBackend = {
      baseUrl: cfg.llmBaseUrl,
      model: cfg.llmModel,
      timeoutMs: Number(this.policy.llm.timeout_ms ?? 60_000),
      maxRetries: Number(this.policy.llm.max_retries ?? 2),
    }
    this.llm = new LlmProvider(backend)
    this.conflictResolver = new ConflictResolver(this.policy, this.store, undefined, this.clock)
    if (this.policy.derive.enabled) {
      this.deriver = new Deriver(this.store, this.llm, this.policy, this.clock)
    }
  }

  /** Write gate single channel: gate + embed + conflict (fully wired). */
  async write(text: string, actor: Actor, sourceRef?: string): Promise<GateReceipt> {
    const deps: GateDeps = {
      policy: this.policy,
      store: this.store,
      classifyFn: buildClassifyFn(this.policy, this.llm),
      permission: { actor: actor.name, target: 'memories' },
      embedFn: (t) => this.embed.embedOne(t).catch(() => null),
      conflictResolver: {
        resolve: (n, _p) => this.conflictResolver.resolveOnWrite(n).then(() => undefined),
      },
      clock: this.clock,
    }
    const input: GateWriteInput = {
      text,
      source: actor.isRoot ? 'root' : 'agent',
      sourceRef: sourceRef ?? null,
    }
    return gateWrite(input, deps)
  }

  /** Retrieval: read-path lifecycle contract (C1) + scoring + anchor render. */
  async query(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    const now = this.clock.now()
    sweepExpired(this.store, this.policy, now)
    return search(query, this.store, this.embed, this.policy, now, opts)
  }

  /** Dialectic reasoning (LLM failure → evidence concat, never blocks). */
  async reason(query: string): Promise<ReasonResult> {
    return dialecticReason(query, {
      store: this.store,
      policy: this.policy,
      embed: this.embed,
      llm: this.llm,
      now: this.clock.now(),
    })
  }

  /** turnEnd hook (observer wiring): incremental derive per session. */
  async onTurnEnd(sessionId: string, _turn: number): Promise<void> {
    if (!this.deriver) return
    await this.deriver.run(sessionId, {
      userDocPath: path.join(this.memoryRoot, 'user.md'),
    })
  }

  /** Close underlying db (lifecycle). */
  close(): void {
    this.schema.db.close()
  }
}
