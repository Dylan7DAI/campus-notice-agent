import { createHash } from 'node:crypto';

class ModelCallError extends Error {
  constructor(code, retryable = false, retryAfterMs) {
    super(code);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  const copyNumbers = (source, keys) => Object.fromEntries(keys.filter((key) => Number.isFinite(source?.[key]) && source[key] >= 0).map((key) => [key, source[key]]));
  Object.assign(result, copyNumbers(value, ['prompt_tokens', 'completion_tokens', 'total_tokens']));
  for (const [key, fields] of Object.entries({ prompt_tokens_details: ['cached_tokens', 'audio_tokens'], completion_tokens_details: ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'] })) {
    const details = copyNumbers(value[key], fields);
    if (Object.keys(details).length) result[key] = details;
  }
  return Object.keys(result).length ? result : undefined;
}

function retryAfter(value, now) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const duration = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/** Read-only model transport; injected timers let timeout regressions run without real waiting. */
export function createModelCaller({ endpoint, apiKey, model, thinking, fetchImpl = globalThis.fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  async function pause(duration, signal) {
    if (signal?.aborted) throw new ModelCallError('MODEL_CANCELLED');
    let timer;
    let cancel;
    try {
      await new Promise((resolve, reject) => {
        cancel = () => reject(new ModelCallError('MODEL_CANCELLED'));
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimer(resolve, duration);
      });
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function attemptRequest(messages, state, requestedModel, requestedThinking) {
    if (state.signal?.aborted) throw new ModelCallError('MODEL_CANCELLED');
    if (state.calls >= 3) throw new ModelCallError('MODEL_BUDGET_EXCEEDED');
    const started = now();
    const remaining = state.deadline - started;
    if (remaining <= 0) throw new ModelCallError('MODEL_RUN_TIMEOUT');
    state.calls += 1;
    const controller = new AbortController();
    const input = JSON.stringify(messages);
    const attempt = {
      stage: state.stage, model: requestedModel,
      ...(requestedThinking !== undefined ? { thinking: requestedThinking } : {}),
      input_sha256: createHash('sha256').update(input).digest('hex'),
      status: 'running', usage: null, duration_ms: 0,
      response_headers_ms: null, response_body_ms: null, http_status: null, failure_phase: null,
    };
    state.attempts.push(attempt);
    let phase = 'request';
    let bodyStarted;
    let timer;
    let cancel;
    try {
      const interrupted = new Promise((_resolve, reject) => {
        timer = setTimer(() => {
          reject(new ModelCallError('MODEL_TIMEOUT', true));
          controller.abort();
        }, Math.min(60_000, remaining));
        cancel = () => {
          reject(new ModelCallError('MODEL_CANCELLED'));
          controller.abort();
        };
        state.signal?.addEventListener('abort', cancel, { once: true });
      });
      // The race also bounds a stalled response body and non-cooperative fetch implementations.
      const result = await Promise.race([interrupted, (async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: requestedModel, messages, stream: false, max_tokens: 4_000, ...(requestedThinking !== undefined ? { thinking: { type: requestedThinking } } : {}) }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new ModelCallError('MODEL_TIMEOUT', true);
        attempt.response_headers_ms = Math.max(0, Math.round(now() - started));
        attempt.http_status = Number.isSafeInteger(response.status) ? response.status : null;
        phase = 'response_validation';
        if (!response.ok) {
          const status = attempt.http_status;
          throw new ModelCallError(status === null ? 'MODEL_UNAVAILABLE' : `MODEL_UNAVAILABLE:${status}`, status === 429 || status >= 500, retryAfter(response.headers?.get('Retry-After'), now()));
        }
        phase = 'response_body';
        bodyStarted = now();
        let raw;
        try { raw = await response.json(); } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw new ModelCallError('MODEL_INVALID_OUTPUT');
        }
        if (controller.signal.aborted) throw new ModelCallError('MODEL_TIMEOUT', true);
        attempt.response_body_ms = Math.max(0, Math.round(now() - bodyStarted));
        phase = 'response_validation';
        const content = raw?.choices?.[0]?.message?.content;
        const text = Array.isArray(content) ? content.map((part) => typeof part?.text === 'string' ? part.text : '').join('') : content;
        if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1_024) throw new ModelCallError('MODEL_INVALID_OUTPUT');
        const usage = safeUsage(raw?.usage);
        const finishReason = raw?.choices?.[0]?.finish_reason;
        attempt.status = 'received';
        attempt.output_sha256 = createHash('sha256').update(text).digest('hex');
        attempt.output_bytes = Buffer.byteLength(text);
        attempt.finish_reason = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'sensitive'].includes(finishReason) ? finishReason : null;
        attempt.usage = usage ?? null;
        return { text, usage };
      })()]);
      return result;
    } catch (error) {
      const safeError = error instanceof ModelCallError ? error : error?.name === 'AbortError' ? new ModelCallError('MODEL_TIMEOUT', true) : new ModelCallError('MODEL_UNAVAILABLE', true);
      attempt.status = 'error';
      attempt.error = safeError.message;
      attempt.failure_phase = phase;
      if (bodyStarted !== undefined && attempt.response_body_ms === null) attempt.response_body_ms = Math.max(0, Math.round(now() - bodyStarted));
      throw safeError;
    } finally {
      attempt.duration_ms = Math.max(0, Math.round(now() - started));
      clearTimer(timer);
      state.signal?.removeEventListener('abort', cancel);
    }
  }

  return async function call(messages, state, requestedModel = model, requestOptions = {}) {
    const requestedThinking = Object.hasOwn(requestOptions, 'thinking') ? requestOptions.thinking : thinking;
    while (true) {
      try { return await attemptRequest(messages, state, requestedModel, requestedThinking); } catch (error) {
        if (!error.retryable || state.retries >= 1 || state.calls >= 3) throw error;
        const waitMs = error.retryAfterMs ?? 300;
        // Never sleep through the remaining run budget or start a request past its deadline.
        if (state.deadline - now() <= waitMs) throw new ModelCallError('MODEL_RUN_TIMEOUT');
        state.retries += 1;
        await pause(waitMs, state.signal);
      }
    }
  };
}
