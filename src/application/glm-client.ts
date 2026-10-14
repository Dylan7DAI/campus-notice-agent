export type ChatResult = { text: string; raw: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
export type TextMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type ImageMessage = { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> };
export class ModelClientError extends Error {
  constructor(public readonly code: 'MODEL_TIMEOUT' | 'MODEL_UNAVAILABLE' | 'MODEL_INVALID_OUTPUT', public readonly retryable: boolean, message: string = code, public readonly retryAfterMs?: number) { super(message); }
}
type GlmResponse = { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; error?: unknown; usage?: ChatResult['usage'] };

export class GlmClient {
  constructor(private readonly cfg: { apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number; thinking?: 'enabled' | 'disabled' }) {}
  async chat(prompt: string, signal?: AbortSignal): Promise<ChatResult> { return this.complete([{ role: 'user', content: prompt }], signal); }
  async chatWithImage(prompt: string, imageDataUrl: string, signal?: AbortSignal): Promise<ChatResult> {
    return this.complete([{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageDataUrl } }] }], signal);
  }
  private async complete(messages: TextMessage[] | ImageMessage[], signal?: AbortSignal): Promise<ChatResult> {
    if (signal?.aborted) throw new ModelClientError('MODEL_TIMEOUT', true);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 60000);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const res = await fetch(`${this.cfg.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4'}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.cfg.model ?? 'glm-4.5-flash', messages, stream: false, max_tokens: 4_000, ...(this.cfg.thinking ? { thinking: { type: this.cfg.thinking } } : {}) }), signal: controller.signal });
      let raw: GlmResponse; try { raw = await res.json() as GlmResponse; } catch { throw new ModelClientError('MODEL_INVALID_OUTPUT', false); }
      if (!res.ok) {
        const retryAfter = res.headers.get('Retry-After');
        const retryAfterMs = retryAfter ? /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : undefined;
        throw new ModelClientError('MODEL_UNAVAILABLE', res.status === 429 || res.status >= 500, `MODEL_UNAVAILABLE:${res.status}`, retryAfterMs && retryAfterMs > 0 ? retryAfterMs : undefined);
      }
      const content = raw.choices?.[0]?.message?.content; const text = Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content;
      if (typeof text !== 'string' || !text.trim()) throw new ModelClientError('MODEL_INVALID_OUTPUT', false);
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new ModelClientError('MODEL_INVALID_OUTPUT', false);
      return { text, raw, usage: raw.usage };
    } catch (error) {
      if (error instanceof ModelClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new ModelClientError('MODEL_TIMEOUT', true);
      throw new ModelClientError('MODEL_UNAVAILABLE', true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
