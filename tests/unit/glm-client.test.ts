import {GlmClient, ModelClientError} from '../../src/application/glm-client';
import {describe,it,expect,vi,afterEach} from 'vitest';

describe('GLM adapter',()=>{
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the unconfigured request body unchanged', async () => {
    const requests: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, request: RequestInit) => {
      requests.push(request);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic response' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await new GlmClient({ apiKey: 'synthetic', model: 'text-model' }).chat('synthetic notice');
    expect(requests[0].body).toBe(JSON.stringify({ model: 'text-model', messages: [{ role: 'user', content: 'synthetic notice' }], stream: false, max_tokens: 4_000 }));
  });

  it.each(['enabled', 'disabled'] as const)('sends explicitly configured %s thinking for text and image requests', async (thinking) => {
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, request: RequestInit) => {
      requests.push(request);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic response' } }] }), { status: 200 });
    }));
    const client = new GlmClient({ apiKey: 'synthetic', model: 'synthetic-model', thinking });
    await client.chat('synthetic notice');
    await client.chatWithImage('synthetic OCR', 'data:image/png;base64,c3ludGhldGlj');
    expect(requests.map((request) => JSON.parse(String(request.body)).thinking)).toEqual([{ type: thinking }, { type: thinking }]);
  });

  it('maps invalid endpoint response to error',async()=>{const c=new GlmClient({apiKey:'synthetic',baseUrl:'http://127.0.0.1:1',model:'glm-5.3',timeoutMs:50});await expect(c.chat('x')).rejects.toBeTruthy();});

  it('does not issue a request when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController(); controller.abort();
    const client = new GlmClient({ apiKey: 'synthetic' });
    await expect(client.chat('x', controller.signal)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a pending request at the default 60 second deadline without wall-clock waiting', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, request: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = request.signal;
      if (!signal) throw new Error('Expected an abortable request');
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GlmClient({ apiKey: 'synthetic' });
    const outcome = expect(client.chat('synthetic')).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(requestSignal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a response arrives before timeout', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, request: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = request.signal;
      if (!signal) throw new Error('Expected an abortable request');
      requestSignal = signal;
      const onAbort = () => reject(new DOMException('Request aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic response' } }] }), { status: 200 }));
      }, 100);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GlmClient({ apiKey: 'synthetic' });
    const pending = client.chat('synthetic');

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ text: 'synthetic response' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestSignal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards caller cancellation to a pending request and clears its deadline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, request: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = request.signal;
      if (!signal) throw new Error('Expected an abortable request');
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const client = new GlmClient({ apiKey: 'synthetic' });
    const outcome = expect(client.chat('synthetic', controller.signal)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });

    await vi.advanceTimersByTimeAsync(100);
    expect(requestSignal?.aborted).toBe(false);
    controller.abort();
    await outcome;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a 4k token cap and rejects oversized provider output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(70_000) } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GlmClient({ apiKey: 'synthetic' });
    await expect(client.chat('x')).rejects.toMatchObject({ code: 'MODEL_INVALID_OUTPUT' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { max_tokens?: number };
    expect(body.max_tokens).toBe(4_000);
  });

  it('exposes Retry-After for bounded runner backoff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })));
    const client = new GlmClient({ apiKey: 'synthetic' });
    await expect(client.chat('x')).rejects.toSatisfy((error: unknown) => error instanceof ModelClientError && error.code === 'MODEL_UNAVAILABLE' && error.retryable && error.retryAfterMs === 2_000);
  });
});
