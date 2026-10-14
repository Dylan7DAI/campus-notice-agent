import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelCaller } from '../../scripts/eval-model-provider.mjs';

const messages = [{ role: 'user', content: 'Synthetic notice only.' }];
function state(deadline = Date.now() + 240_000) {
  return { calls: 0, retries: 0, attempts: [], stage: 'recognition', deadline };
}
function response(text = '{"text":"Synthetic OCR"}', options = {}) {
  return {
    ok: true, status: 200, headers: new globalThis.Headers(),
    json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ...options,
  };
}
function caller(fetchImpl) {
  return createModelCaller({ endpoint: 'https://synthetic.invalid/chat', apiKey: 'test-secret', model: 'test-model', fetchImpl });
}
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

describe('M4 provider timeout, retry and privacy boundaries', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => vi.useRealTimers());

  it('keeps the default evaluator request bytes unchanged', async () => {
    const fetchImpl = vi.fn(async (_endpoint, request) => {
      expect(request.body).toBe(JSON.stringify({ model: 'test-model', messages, stream: false, max_tokens: 4_000 }));
      return response();
    });
    await caller(fetchImpl)(messages, state());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('separates explicit vision thinking from text and repair thinking', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (_endpoint, request) => { requests.push(JSON.parse(request.body)); return response(); });
    const call = createModelCaller({ endpoint: 'http://127.0.0.1/synthetic', apiKey: 'test-secret', model: 'text-model', thinking: 'enabled', fetchImpl });
    const run = state();
    await call(messages, run, 'vision-model', { thinking: 'disabled' });
    run.stage = 'recognition_repair';
    await call(messages, run);
    run.stage = 'extraction';
    await call(messages, run, 'vision-model', { thinking: undefined });
    expect(requests.map((body) => body.thinking ?? null)).toEqual([{ type: 'disabled' }, { type: 'enabled' }, null]);
    expect(run.attempts.slice(0, 2).map((attempt) => attempt.thinking)).toEqual(['disabled', 'enabled']);
    expect(run.attempts[2]).not.toHaveProperty('thinking');
    expect(run.calls).toBe(3);
  });

  it('handles C28 OCR success then two extraction timeouts within three calls', async () => {
    const signals = [];
    const fetchImpl = vi.fn(async (_endpoint, request) => {
      signals.push(request.signal);
      if (signals.length === 1) return response();
      return new Promise(() => {});
    });
    const call = caller(fetchImpl);
    const run = state();
    await expect(call(messages, run, 'vision-model')).resolves.toMatchObject({ text: '{"text":"Synthetic OCR"}' });
    run.stage = 'extraction';
    const pending = settle(call(messages, run));
    await vi.advanceTimersByTimeAsync(120_300);
    expect((await pending).error.message).toBe('MODEL_TIMEOUT');
    expect(run).toMatchObject({ calls: 3, retries: 1 });
    expect(run.attempts.map((attempt) => attempt.stage)).toEqual(['recognition', 'extraction', 'extraction']);
    expect(run.attempts.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ error: 'MODEL_TIMEOUT', duration_ms: 60_000, response_headers_ms: null, failure_phase: 'request' }),
    ]));
    expect(signals.slice(1).every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a timed-out request with the single allowed retry', async () => {
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response());
    const run = state();
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(60_300);
    expect((await pending).value.text).toBe('{"text":"Synthetic OCR"}');
    expect(run).toMatchObject({ calls: 2, retries: 1 });
    expect(run.attempts.map((attempt) => attempt.status)).toEqual(['error', 'received']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry past the run deadline', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const run = state(60_000);
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).error.message).toBe('MODEL_RUN_TIMEOUT');
    expect(run).toMatchObject({ calls: 1, retries: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits for Retry-After and enforces the deadline before scheduling it', async () => {
    const unavailable = response('', { ok: false, status: 429, headers: new globalThis.Headers({ 'Retry-After': '4' }) });
    const fetchImpl = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValueOnce(response());
    const run = state();
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).value.text).toBe('{"text":"Synthetic OCR"}');
    expect(run.attempts[0]).toMatchObject({ http_status: 429, error: 'MODEL_UNAVAILABLE:429' });
    const limited = state(Date.now() + 1_000);
    const blockedFetch = vi.fn().mockResolvedValue(unavailable);
    await expect(caller(blockedFetch)(messages, limited)).rejects.toThrow('MODEL_RUN_TIMEOUT');
    expect(limited).toMatchObject({ calls: 1, retries: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a pending response body and records its phase', async () => {
    let signal;
    const fetchImpl = vi.fn(async (_endpoint, request) => {
      signal = request.signal;
      return response('', { json: () => new Promise(() => {}) });
    });
    const run = state();
    run.retries = 1;
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).error.message).toBe('MODEL_TIMEOUT');
    expect(signal.aborted).toBe(true);
    expect(run.attempts[0]).toMatchObject({ response_headers_ms: 0, response_body_ms: 60_000, failure_phase: 'response_body' });
  });

  it('cancels a pending body without retrying or leaking failure contents', async () => {
    const controller = new globalThis.AbortController();
    let requestSignal;
    const fetchImpl = vi.fn(async (_endpoint, request) => {
      requestSignal = request.signal;
      return response('', { json: () => new Promise(() => {}) });
    });
    const run = { ...state(), signal: controller.signal };
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort('test-secret');
    expect((await pending).error.message).toBe('MODEL_CANCELLED');
    expect(requestSignal.aborted).toBe(true);
    expect(run.retries).toBe(0);
    expect(JSON.stringify(run.attempts)).not.toContain('test-secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a terminal timeout immutable when a non-cooperative body resolves later', async () => {
    let resolveBody;
    const fetchImpl = vi.fn(async () => response('', { json: () => new Promise((resolve) => { resolveBody = resolve; }) }));
    const run = state();
    run.retries = 1;
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).error.message).toBe('MODEL_TIMEOUT');
    const terminal = JSON.stringify(run.attempts);
    resolveBody({ choices: [{ message: { content: 'late private body' }, finish_reason: 'stop' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(run.attempts)).toBe(terminal);
  });

  it('interprets HTTP-date Retry-After and records header/body latency separately', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response('', { ok: false, status: 503, headers: new globalThis.Headers({ 'Retry-After': new Date(2_000).toUTCString() }) })).mockImplementationOnce(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      return response('', { json: async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
        return { choices: [{ message: { content: 'candidate' }, finish_reason: 'stop' }] };
      } });
    });
    const run = state();
    const pending = settle(caller(fetchImpl)(messages, run));
    await vi.advanceTimersByTimeAsync(2_030);
    expect((await pending).value.text).toBe('candidate');
    expect(run.attempts[1]).toMatchObject({ duration_ms: 30, response_headers_ms: 10, response_body_ms: 20 });
  });

  it('uses the application token cap and records only safe response metadata', async () => {
    const fetchImpl = vi.fn(async (_endpoint, request) => {
      expect(JSON.parse(request.body)).toMatchObject({ model: 'text-model', stream: false, max_tokens: 4_000 });
      return response('candidate', { json: async () => ({ choices: [{ message: { content: 'candidate' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, total_tokens: 15, extra: 'test-secret' } }) });
    });
    const run = state();
    await expect(caller(fetchImpl)(messages, run, 'text-model')).resolves.toEqual({ text: 'candidate', usage: { prompt_tokens: 10, total_tokens: 15 } });
    expect(run.attempts[0]).toMatchObject({ model: 'text-model', output_bytes: 9, finish_reason: 'stop', http_status: 200, duration_ms: 0, response_headers_ms: 0, response_body_ms: 0 });
    expect(run.attempts[0].input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.attempts[0].output_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(run.attempts)).not.toContain('candidate');
    expect(JSON.stringify(run.attempts)).not.toContain('test-secret');
  });

  it('redacts network errors and refuses a fourth call before fetching', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('test-secret and private response body'); });
    const run = state();
    run.retries = 1;
    await expect(caller(fetchImpl)(messages, run)).rejects.toThrow('MODEL_UNAVAILABLE');
    expect(run.attempts[0].error).toBe('MODEL_UNAVAILABLE');
    expect(JSON.stringify(run.attempts)).not.toContain('test-secret');
    run.calls = 3;
    await expect(caller(fetchImpl)(messages, run)).rejects.toThrow('MODEL_BUDGET_EXCEEDED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
