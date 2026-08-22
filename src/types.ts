/**
 * ForeSight domain types.
 *
 * The whole system is organized around one axis: 体 (ASPECT) × 锚定 (ANCHOR).
 * Every memory carries explicit temporal semantics derived from linguistic
 * aspect theory — see docs/design.md for the full taxonomy.
 */

export type Aspect = 'gnomic' | 'progressive' | 'perfect' | 'prospective'
export type AnchorType = 'none' | 'point' | 'interval' | 'open'
export type MemoryStatus = 'active' | 'suppressed' | 'expired' | 'deleted'
export type MemorySource = 'agent' | 'root' | 'derive'
export type Telicity = 'bounded' | 'unbounded'
export type Modality = 'prediction' | 'intention' | 'plan' | 'commitment'
export type LinkRel = 'supports' | 'contradicts' | 'refines' | 'precedes' | 'related'

export interface Anchor {
  type: AnchorType
  /** ISO date (YYYY-MM-DD) or ISO timestamp; meaning depends on type. */
  start?: string
  end?: string
}

/** Aspect → behavior lookup row (Policy P2). All scheduling logic reads this
 *  table, nothing else. Field names mirror policy.yaml (snake_case). */
export interface AspectBehavior {
  storage: 'memory' | 'doc' | 'none'
  injection: 'always' | 'conditional' | 'renewal' | 'never'
  expiry: 'ttl' | 'anchor' | 'never'
  render_anchor: boolean | string
  renewable: boolean
  default_ttl_days: number
  review_every_turns: number
  /** progressive only: telicity constraints */
  telicity?: { values: string[]; unbounded_force_ttl: boolean }
  /** prospective only: modality constraints */
  modalities?: Record<string, Record<string, unknown>>
}

export interface FactorConfig {
  enabled: boolean
  weight: number
  [key: string]: unknown
}

export interface DeriveRoute {
  source: string
  aspect_default: Aspect
  anchor_default?: Anchor
  target: 'memories' | 'user_doc'
  permission: 'derive' | 'root'
}

export interface Policy {
  policy_version: number
  permission: {
    root_writers: string[]
    agent_writable: string[]
    beta_settable_by: string[]
    user_doc_writer: string
  }
  aspects: Record<Aspect, AspectBehavior & Record<string, unknown>>
  gate: {
    allowed_categories: string[]
    forbidden_categories: string[]
    forbidden_progressive: string[]
    llm_model: string
    fallback: string
  }
  activation: {
    beta: number
    beta_observe: number
    suppression_epsilon: number
    conflict_sim_threshold: number
    temporal_decay_enabled: boolean
    half_life_days: number
    base_weights: Record<string, number>
    support?: {
      evidence_half_life_days: number
      margin: number
      aspect_direction_prior: number
    }
  }
  retrieval: {
    top_k: number
    min_score: number
    candidates: number
    factors: Record<string, FactorConfig>
  }
  injection: {
    soul_section: string
    user_section: string
    memories_section: string
    user_budget_chars: number
  }
  derive: {
    enabled: boolean
    trigger: string
    every_n_turns: number
    model: string
    max_new_per_batch: number
    routes: DeriveRoute[]
  }
  nudge: {
    every_turns: number
    candidate_extraction: string
    candidate_max: number
    llm_model: string
    render: string
    review_temporal: boolean
    review_conflicts: boolean
    include_session_timeline: boolean
  }
  dialectic: {
    model: string
    top_k: number
    include_contradictions: boolean
  }
  server: {
    enabled: boolean
    host: string
    port: number
    token: string
  }
  llm: {
    base_url: string
    model_classify: string
    model_derive: string
    model_dialectic: string
    timeout_ms: number
    max_retries: number
  }
  audit: {
    events_table: boolean
    emit_session_events: boolean
    log_file: string
  }
  consistency_check?: boolean
  chinese_markers?: Record<string, string>
}
