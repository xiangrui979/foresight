/**
 * ForeSight Store �?CRUD over the four tables, soft delete, vector writes.
 * All writes funnel through this module (Node is single-threaded and
 * better-sqlite3 is synchronous, so writes are naturally serialized).
 */
import type { Schema } from './schema.js'
import type { Anchor, Aspect, MemorySource, MemoryStatus, LinkRel } from './types.js'
import { nanoid } from 'nanoid'
import * as fs from 'node:fs'
import { normalizeClock, systemClock, type Clock, type ClockLike } from './clock.js'

export interface Memory {
  id: string
  content: string
  aspect: Aspect
  anchor: Anchor
  category: string | null
  telicity: string | null
  modality: string | null
  activation: number
  baseWeight: number
  source: MemorySource
  sourceRef: string | null
  status: MemoryStatus
  metadata: Record<string, unknown>
  embedding: Buffer | null
  createdAt: number
  updatedAt: number
}

export interface MemoryInput {
  content: string
  aspect: Aspect
  anchor: Anchor
  category?: string | null
  telicity?: string | null
  modality?: string | null
  activation?: number
  baseWeight?: number
  source: MemorySource
  sourceRef?: string | null
  status?: MemoryStatus
  metadata?: Record<string, unknown>
  embedding?: Float32Array | null
}

function rowToMemory(r: Record<string, unknown>): Memory {
  return {
    id: r.id as string,
    content: r.content as string,
    aspect: r.aspect as Aspect,
    anchor: JSON.parse(r.anchor_json as string) as Anchor,
    category: (r.category as string) ?? null,
    telicity: (r.telicity as string) ?? null,
    modality: (r.modality as string) ?? null,
    activation: r.activation as number,
    baseWeight: r.base_weight as number,
    source: r.source as MemorySource,
    sourceRef: (r.source_ref as string) ?? null,
    status: r.status as MemoryStatus,
    metadata: JSON.parse((r.metadata as string) || '{}') as Record<string, unknown>,
    embedding: (r.embedding as Buffer) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }
}

export class Store {
  private clock: Clock

  constructor(
    private schema: Schema,
    private auditLogPath: string | null = null,
    /** Injectable clock (Clock object or legacy () => number). */
    clock: ClockLike = systemClock,
  ) {
    this.clock = normalizeClock(clock)
  }

  // ── memories ────────────────────────────────────────────────────────

  insertMemory(input: MemoryInput): Memory {
    const now = this.clock.now()
    const id = nanoid()
    this.schema.db
      .prepare(
        `INSERT INTO memories (id, content, aspect, anchor_json, category, telicity, modality,
           activation, base_weight, source, source_ref, status, metadata, embedding, created_at, updated_at)
         VALUES (@id, @content, @aspect, @anchor_json, @category, @telicity, @modality,
           @activation, @base_weight, @source, @source_ref, @status, @metadata, @embedding, @created_at, @updated_at)`,
      )
      .run({
        id,
        content: input.content,
        aspect: input.aspect,
        anchor_json: JSON.stringify(input.anchor),
        category: input.category ?? null,
        telicity: input.telicity ?? null,
        modality: input.modality ?? null,
        activation: input.activation ?? 1.0,
        base_weight: input.baseWeight ?? 1.0,
        source: input.source,
        source_ref: input.sourceRef ?? null,
        status: input.status ?? 'active',
        metadata: JSON.stringify(input.metadata ?? {}),
        embedding: input.embedding ? Buffer.from(input.embedding.buffer) : null,
        created_at: now,
        updated_at: now,
      })
    if (input.embedding) {
      this.schema.db
        .prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`)
        .run(id, Buffer.from(input.embedding.buffer))
    }
    return this.getMemory(id)!
  }

  getMemory(id: string): Memory | null {
    const r = this.schema.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id)
    return r ? rowToMemory(r as Record<string, unknown>) : null
  }

  updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'content' | 'activation' | 'baseWeight' | 'status' | 'metadata' | 'aspect' | 'anchor' | 'category' | 'telicity' | 'modality'>>,
  ): Memory | null {
    const fields: string[] = []
    const values: Record<string, unknown> = { id, updated_at: this.clock.now() }
    if (patch.content !== undefined) { fields.push('content = @content'); values.content = patch.content }
    if (patch.aspect !== undefined) { fields.push('aspect = @aspect'); values.aspect = patch.aspect }
    if (patch.anchor !== undefined) { fields.push('anchor_json = @anchor_json'); values.anchor_json = JSON.stringify(patch.anchor) }
    if (patch.category !== undefined) { fields.push('category = @category'); values.category = patch.category }
    if (patch.telicity !== undefined) { fields.push('telicity = @telicity'); values.telicity = patch.telicity }
    if (patch.modality !== undefined) { fields.push('modality = @modality'); values.modality = patch.modality }
    if (patch.activation !== undefined) { fields.push('activation = @activation'); values.activation = patch.activation }
    if (patch.baseWeight !== undefined) { fields.push('base_weight = @base_weight'); values.base_weight = patch.baseWeight }
    if (patch.status !== undefined) { fields.push('status = @status'); values.status = patch.status }
    if (patch.metadata !== undefined) { fields.push('metadata = @metadata'); values.metadata = JSON.stringify(patch.metadata) }
    fields.push('updated_at = @updated_at')
    const r = this.schema.db
      .prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = @id`)
      .run(values)
    return r.changes > 0 ? this.getMemory(id) : null
  }

  /** Soft delete: status=deleted, row retained (recoverable). */
  softDelete(id: string): boolean {
    const r = this.schema.db
      .prepare(`UPDATE memories SET status='deleted', updated_at=? WHERE id=? AND status!='deleted'`)
      .run(this.clock.now(), id)
    this.schema.db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id)
    return r.changes > 0
  }

  listByAspectStatus(aspect: Aspect, status: MemoryStatus): Memory[] {
    const rows = this.schema.db
      .prepare(`SELECT * FROM memories WHERE aspect=? AND status=? ORDER BY created_at`)
      .all(aspect, status) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  /** Vector KNN (sqlite-vec brute-force cosine; tens of thousands of
   *  embeddings are fine). */
  vectorNeighbors(embedding: Float32Array, k: number): Array<{ id: string; distance: number }> {
    const rows = this.schema.db
      .prepare(`SELECT id, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
      .all(Buffer.from(embedding.buffer), k) as Array<{ id: string; distance: number }>
    return rows
  }

  /** Set/replace embedding (vec0 has no upsert: delete-then-insert). */
  setEmbedding(id: string, vec: Float32Array): boolean {
    const buf = Buffer.from(vec.buffer)
    const r = this.schema.db
      .prepare(`UPDATE memories SET embedding = ?, updated_at = ? WHERE id = ?`)
      .run(buf, this.clock.now(), id)
    if (r.changes === 0) return false
    this.schema.db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id)
    this.schema.db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(id, buf)
    return true
  }

  // ── links ───────────────────────────────────────────────────────────

  insertLink(src: string, dst: string, rel: LinkRel, source: string, weight = 1.0): number {
    const r = this.schema.db
      .prepare(`INSERT INTO links (src, dst, rel, weight, source, created_at) VALUES (?,?,?,?,?,?)`)
      .run(src, dst, rel, weight, source, this.clock.now())
    return Number(r.lastInsertRowid)
  }

  listLinksOf(id: string): Array<{ id: number; src: string; dst: string; rel: LinkRel; weight: number; source: string }> {
    return this.schema.db
      .prepare(`SELECT * FROM links WHERE src=? OR dst=?`)
      .all(id, id) as never
  }

  // ── conversations ───────────────────────────────────────────────────

  insertConversation(sessionId: string, peer: string, content: string): number {
    const r = this.schema.db
      .prepare(`INSERT INTO conversations (session_id, peer, content, created_at) VALUES (?,?,?,?)`)
      .run(sessionId, peer, content, this.clock.now())
    const id = Number(r.lastInsertRowid)
    this.schema.db.prepare(`INSERT INTO conversations_fts (rowid, content) VALUES (?,?)`).run(id, content)
    this.schema.db.prepare(`INSERT INTO conversations_fts_zh (rowid, content) VALUES (?,?)`).run(id, content)
    return id
  }

  /** Session increment (input for derive/extract): messages after createdAfter. */
  listConversationsSince(sessionId: string, createdAfter: number, limit = 200): Array<{ id: number; peer: string; content: string; createdAt: number }> {
    return this.schema.db
      .prepare(`SELECT id, peer, content, created_at FROM conversations WHERE session_id=? AND created_at>? ORDER BY id LIMIT ?`)
      .all(sessionId, createdAfter, limit) as never
  }

  /** Full-text search over conversations: trigram FTS for CJK + tokenizer FTS
   *  for Latin; merge, dedupe. Short queries (<3 chars) fall back to LIKE. */
  searchConversations(query: string, limit = 20): Array<{ id: number; content: string }> {
    const seen = new Set<number>()
    const out: Array<{ id: number; content: string }> = []
    if ([...query].length < 3) {
      return this.schema.db
        .prepare(`SELECT id, content FROM conversations WHERE content LIKE ? ORDER BY id DESC LIMIT ?`)
        .all(`%${query}%`, limit) as Array<{ id: number; content: string }>
    }
    const zh = this.schema.db
      .prepare(`SELECT rowid AS id, content FROM conversations_fts_zh WHERE conversations_fts_zh MATCH ? LIMIT ?`)
      .all(`"${query.replaceAll('"', '""')}"`, limit) as Array<{ id: number; content: string }>
    for (const r of zh) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r) } }
    if (out.length < limit) {
      const en = this.schema.db
        .prepare(`SELECT rowid AS id, content FROM conversations_fts WHERE conversations_fts MATCH ? LIMIT ?`)
        .all(`"${query.replaceAll('"', '""')}"`, limit - out.length) as Array<{ id: number; content: string }>
      for (const r of en) { if (!seen.has(r.id)) { seen.add(r.id); out.push(r) } }
    }
    return out
  }

  // ── events ──────────────────────────────────────────────────────────

  /** Audit trail. events table is the primary channel; JSONL file (if
   *  configured) is best-effort and never blocks the write path. */
  emit(type: string, target: string | null, detail: Record<string, unknown> | null, clause?: string): void {
    this.schema.db
      .prepare(`INSERT INTO events (ts, type, target, detail, clause) VALUES (?,?,?,?,?)`)
      .run(this.clock.now(), type, target, detail ? JSON.stringify(detail) : null, clause ?? null)
    if (this.auditLogPath) {
      try {
        fs.appendFileSync(
          this.auditLogPath,
          JSON.stringify({ ts: this.clock.now(), type, target, detail, clause }) + '\n',
          'utf8',
        )
      } catch {
        /* JSONL degrade: events table unaffected */
      }
    }
  }
}
