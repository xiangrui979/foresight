/**
 * ForeSight embedding layer — provider interface + Ollama implementation.
 *
 * The embedding backend is the ONLY external runtime dependency of the core.
 * It is behind a small interface so any embedder can be plugged in
 * (Ollama, local model, HTTP API); the default is Ollama with its standard
 * endpoints. Users override via config/env (see README → Configuration).
 */
export interface EmbedProvider {
  embedOne(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

export interface EmbedConfig {
  baseUrl: string
  model: string
  /** Timeout for a single embed call (ms). */
  timeoutMs?: number
}

export class OllamaEmbedProvider implements EmbedProvider {
  constructor(private cfg: EmbedConfig) {}

  async embedOne(text: string): Promise<Float32Array> {
    const resp = await fetch(`${this.cfg.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, prompt: text }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    })
    if (!resp.ok) throw new Error(`embed HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const data = await resp.json() as { embedding: number[] }
    return new Float32Array(data.embedding)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const resp = await fetch(`${this.cfg.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
    })
    if (!resp.ok) throw new Error(`embed HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const data = await resp.json() as { embeddings: number[][] }
    return data.embeddings.map((e) => new Float32Array(e))
  }

  /** Batch pipeline with backoff retry. */
  async embedWithRetry(texts: string[], maxRetries = 2): Promise<Float32Array[]> {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await this.embedBatch(texts)
      } catch (e) {
        if (i === maxRetries) throw e
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
      }
    }
    throw new Error('unreachable')
  }
}

/** Deterministic fake embedder for tests — vectors from a simple hash. */
export class FakeEmbedProvider implements EmbedProvider {
  constructor(private dim = 8) {}

  async embedOne(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim)
    let h = 0
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0
    for (let i = 0; i < this.dim; i++) {
      v[i] = ((h >> (i % 5)) & 0xFF) / 255 - 0.5
    }
    return v
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embedOne(t)))
  }
}
