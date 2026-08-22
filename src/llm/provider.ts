/**
 * ForeSight LLM unified provider (P5).
 * OpenAI-compatible chat completions (DeepSeek default), JSON output,
 * retry + timeout. Consumers: classify/derive/dialectic/nudge — all through
 * this interface. Backend URL/model come from policy.llm (config or env).
 */

export interface LlmRequest {
  model: string
  system: string
  user: string
  json?: boolean
  maxTokens?: number
}

export interface LlmResponse {
  content: string
  /** parsed JSON when json=true (null on failure; caller degrades) */
  json: unknown | null
}

export interface LlmBackend {
  baseUrl: string
  model: string
  timeoutMs: number
  maxRetries: number
}

export class LlmProvider {
  private apiKey: string

  constructor(private backend: LlmBackend) {
    this.apiKey = process.env.FORESIGHT_LLM_API_KEY ?? ''
    // Construction never throws; call() fails on missing key so uplayers
    // degrade (classify→rules, derive→derive.failed, dialectic→evidence concat).
  }

  async call(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error('LLM API key 缺失：设置 FORESIGHT_LLM_API_KEY')
    const result = await this.attempts(req)
    if (result instanceof Error) throw result
    return result
  }

  private async attempts(req: LlmRequest): Promise<LlmResponse | Error> {
    let lastErr: Error | null = null
    const maxRetries = this.backend.maxRetries
    for (let i = 0; i <= maxRetries; i++) {
      try {
        const body: Record<string, unknown> = {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens ?? 4096,
          stream: false,
        }
        if (req.json) body.response_format = { type: 'json_object' }
        const resp = await fetch(`${this.backend.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.backend.timeoutMs),
        })
        if (!resp.ok) {
          throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
        }
        const data = await resp.json() as {
          choices: Array<{ message: { content: string } }>
        }
        const content = data.choices?.[0]?.message?.content ?? ''
        let json: unknown | null = null
        if (req.json) {
          try {
            json = JSON.parse(extractJson(content))
          } catch {
            json = null
          }
        }
        return { content, json }
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e))
        if (i < maxRetries) await sleep(1000 * (i + 1))
      }
    }
    return lastErr ?? new Error('LLM call failed')
  }
}

/** From possibly-fenced output, extract the JSON payload. */
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
