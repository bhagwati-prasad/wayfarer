import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http as msw, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { createHttp } from '../../src/http/client.js';
import { createEmitter } from '../../src/events/emitter.js';
import { createStorage } from '../../src/storage/adapters.js';
import {
  AbortError,
  ApiError,
  AuthError,
  ConfigError,
  ConflictError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  SdkError,
  TimeoutError,
  ValidationError,
} from '../../src/errors/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const BASE = 'https://api.ota.com';

/** A JSON `Response`. */
function json(body, { status = 200, headers = {} } = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An RFC 9457 problem `Response`. */
function problem(status, doc, headers = {}) {
  return new Response(JSON.stringify({ status, ...doc }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

/** A fetch mock that rejects with the signal's reason when aborted and never resolves otherwise. */
function hangingFetch() {
  return vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init && init.signal;
        if (signal && signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
}

/** Queue responses (or factories / errors) for successive fetch calls. */
function sequenceFetch(...items) {
  const queue = [...items];
  return vi.fn(async (url, init) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const fresh = typeof next === 'function';
    const value = fresh ? await next(url, init) : next;
    if (value instanceof Error) throw value;
    // A Response body can be read once: hand out clones of shared items so a sticky last item
    // stays reusable; factories already produce a fresh Response (and streams must not be tee'd).
    return !fresh && value instanceof Response ? value.clone() : value;
  });
}

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Record every `http:*` event. */
function recordEvents(events) {
  const seen = [];
  events.on('http:*', (e) => seen.push(e));
  return seen;
}

/**
 * Build a client with an injected fetch, a real emitter + memory storage and deterministic jitter.
 */
function make(overrides = {}) {
  const events = createEmitter();
  const logger = fakeLogger();
  const storage = createStorage({ driver: 'memory', namespace: 'test' });
  const http = createHttp({
    baseUrl: BASE,
    fetch: overrides.fetch || sequenceFetch(() => json({ ok: true })),
    events,
    logger,
    storage,
    random: () => 1, // jitter at its maximum → deterministic delays
    ...overrides,
  });
  return { http, events, logger, storage, fetch: overrides.fetch };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
/** Drain a long microtask chain (fetch mock → parse → stream reader) without touching timers. */
const settle = async (turns = 100) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};
const networkError = () => new TypeError('fetch failed');

// ── createHttp ───────────────────────────────────────────────────────────────────────────────────

describe('createHttp', () => {
  it('validates its options with ConfigError', () => {
    expect(() => createHttp({ fetch: 'nope' })).toThrow(ConfigError);
    expect(() => createHttp({ timeoutMs: -1 })).toThrow(ConfigError);
    expect(() => createHttp({ retries: 1.5 })).toThrow(ConfigError);
    expect(() => createHttp({ headers: [] })).toThrow(ConfigError);
    expect(() => createHttp({ timers: {} })).toThrow(ConfigError);
    expect(() => createHttp({ now: 1 })).toThrow(ConfigError);
    expect(() => createHttp({ baseUrl: 1 })).toThrow(ConfigError);
  });

  it('exposes the documented surface and has no effects until used', () => {
    const fetch = vi.fn();
    const { http } = make({ fetch });
    for (const key of [
      'request',
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'download',
      'upload',
      'stream',
      'use',
      'setHeader',
      'removeHeader',
      'setBaseUrl',
      'setFetch',
      'abort',
      'abortAll',
      'inflight',
      'lastRequestId',
      'destroy',
    ]) {
      expect(typeof http[key], key).toBe('function');
    }
    expect(typeof http.interceptors.request.use).toBe('function');
    expect(typeof http.interceptors.response.use).toBe('function');
    expect(typeof http.interceptors.error.use).toBe('function');
    expect(typeof http.hooks.on).toBe('function');
    expect(typeof http.cache.clear).toBe('function');
    expect(typeof http.cache.invalidate).toBe('function');
    expect(fetch).not.toHaveBeenCalled();
    expect(http.inflight()).toBe(0);
    expect(http.lastRequestId()).toBeUndefined();
  });

  it('falls back to globalThis.fetch at call time when no fetch is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ global: true }));
    const http = createHttp({ baseUrl: BASE });
    const res = await http.get('/v1/ping');
    expect(res.data).toEqual({ global: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── prepare + happy path ─────────────────────────────────────────────────────────────────────────

describe('request: prepare and resolve', () => {
  it('builds the URL from baseUrl + path + query via buildQuery and resolves an HttpResponse', async () => {
    const fetch = sequenceFetch(json({ hello: 'world' }, { headers: { 'x-request-id': 'srv-1' } }));
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const res = await http.get('/v1/places', {
      query: { q: 'DEL', types: ['airport', 'city'], skip: undefined, n: 2 },
      tag: 'places',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/places?q=DEL&types=airport&types=city&n=2`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.Accept).toMatch(/application\/json/);

    expect(res.data).toEqual({ hello: 'world' });
    expect(res.status).toBe(200);
    expect(res.headers).toBeInstanceOf(Headers);
    expect(res.headers.get('x-request-id')).toBe('srv-1');
    expect(res.requestId).toMatch(/^req_/);
    expect(res.fromCache).toBe(false);
    expect(res.attempts).toBe(1);
    expect(typeof res.durationMs).toBe('number');
    expect(res.meta).toEqual({});
    expect(http.lastRequestId()).toBe(res.requestId);

    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:response']);
    expect(seen[0]).toMatchObject({
      id: res.requestId,
      method: 'GET',
      url,
      tag: 'places',
      attempt: 1,
    });
    expect(seen[1]).toMatchObject({
      id: res.requestId,
      status: 200,
      attempts: 1,
      fromCache: false,
    });
    expect(typeof seen[1].at).toBe('number');
  });

  it('merges default headers (lazy functions per request) under per-request headers, case-insensitively', async () => {
    let token = 'a';
    const fetch = sequenceFetch(json({}));
    const { http } = make({
      fetch,
      headers: { 'X-Api-Key': 'key', Authorization: () => (token ? `Bearer ${token}` : undefined) },
    });
    http.setHeader('X-Currency', 'INR');
    await http.get('/v1/a', { headers: { 'x-currency': 'USD' } });
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      'X-Api-Key': 'key',
      Authorization: 'Bearer a',
      'x-currency': 'USD',
    });
    expect(Object.keys(fetch.mock.calls[0][1].headers)).not.toContain('X-Currency');
    token = 'b';
    await http.get('/v1/a');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer b');
    token = '';
    http.removeHeader('x-api-key');
    await http.get('/v1/a');
    expect(fetch.mock.calls[2][1].headers.Authorization).toBeUndefined();
    expect(fetch.mock.calls[2][1].headers['X-Api-Key']).toBeUndefined();
    expect(fetch.mock.calls[2][1].headers['X-Currency']).toBe('INR');
  });

  it('absolute url wins over baseUrl; setBaseUrl and setFetch take effect for later requests', async () => {
    const fetch1 = sequenceFetch(json({ n: 1 }));
    const fetch2 = sequenceFetch(json({ n: 2 }));
    const { http } = make({ fetch: fetch1 });
    await http.request({ method: 'GET', url: 'https://cdn.example.com/x?a=1', query: { b: 2 } });
    expect(fetch1.mock.calls[0][0]).toBe('https://cdn.example.com/x?a=1&b=2');
    http.setBaseUrl('https://staging.ota.com/');
    http.setFetch(fetch2);
    const res = await http.get('v1/ping');
    expect(fetch2.mock.calls[0][0]).toBe('https://staging.ota.com/v1/ping');
    expect(res.data).toEqual({ n: 2 });
    expect(() => http.setBaseUrl(1)).toThrow(ValidationError);
    expect(() => http.setFetch('x')).toThrow(ValidationError);
  });

  it('sugar methods set method and body; JSON bodies are encoded with content-type', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch });
    await http.post('/v1/a', { x: 1 }, { tag: 't' });
    await http.put('/v1/b', [1, 2]);
    await http.patch(
      '/v1/c',
      { y: 2 },
      { headers: { 'content-type': 'application/merge-patch+json' } }
    );
    await http.delete('/v1/d');
    const calls = fetch.mock.calls.map(([, init]) => init);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('{"x":1}');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[1].method).toBe('PUT');
    expect(calls[1].body).toBe('[1,2]');
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].headers['content-type']).toBe('application/merge-patch+json');
    expect(calls[2].headers['Content-Type']).toBeUndefined();
    expect(calls[3].method).toBe('DELETE');
    expect(calls[3].body).toBeUndefined();
  });

  it('passes raw bodies (FormData, Blob, string, URLSearchParams) through untouched', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch });
    const fd = new FormData();
    fd.append('file', new Blob(['abc']), 'a.txt');
    await http.post('/v1/up', fd);
    expect(fetch.mock.calls[0][1].body).toBe(fd);
    expect(fetch.mock.calls[0][1].headers['Content-Type']).toBeUndefined();
    await http.post('/v1/text', 'plain');
    expect(fetch.mock.calls[1][1].body).toBe('plain');
    expect(fetch.mock.calls[1][1].headers['Content-Type']).toMatch(/text\/plain/);
    const params = new URLSearchParams({ a: '1' });
    await http.post('/v1/form', params);
    expect(fetch.mock.calls[2][1].body).toBe(params);
  });

  it('rejects an invalid spec with ValidationError before any fetch', async () => {
    const fetch = vi.fn();
    const { http } = make({ fetch });
    await expect(http.request(null)).rejects.toBeInstanceOf(ValidationError);
    await expect(http.request({ path: '/x' })).rejects.toMatchObject({
      name: 'ValidationError',
      issues: [{ path: 'method', code: 'required', message: expect.any(String) }],
    });
    await expect(http.request({ method: 'GET' })).rejects.toBeInstanceOf(ValidationError);
    await expect(http.get('/x', { responseType: 'xml' })).rejects.toBeInstanceOf(ValidationError);
    await expect(http.get('/x', { timeoutMs: -5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(http.get('/x', { retries: 1.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(http.get('/x', { cache: { ttlMs: 0 } })).rejects.toBeInstanceOf(ValidationError);
    await expect(http.get('/x', { query: 'a=1' })).rejects.toBeInstanceOf(ValidationError);
    await expect(http.get('/x', { headers: 'x' })).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).not.toHaveBeenCalled();
    expect(http.inflight()).toBe(0);
  });

  it('parses by content type / responseType: json, +json, text, blob, 204, stream passthrough', async () => {
    const fetch = sequenceFetch(
      new Response('{"a":1}', { headers: { 'content-type': 'application/vnd.api+json' } }),
      new Response('hello', { headers: { 'content-type': 'text/plain' } }),
      new Response('raw-text', { headers: { 'content-type': 'application/json' } }),
      new Response(new Blob([new Uint8Array([1, 2, 3])]), {
        headers: { 'content-type': 'application/pdf' },
      }),
      new Response(null, { status: 204 }),
      () => new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    );
    const { http } = make({ fetch });
    expect((await http.get('/a')).data).toEqual({ a: 1 });
    expect((await http.get('/b')).data).toBe('hello');
    expect((await http.get('/c', { responseType: 'text' })).data).toBe('raw-text');
    const blob = await http.download('/d');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
    expect(fetch.mock.calls[3][1].headers.Accept).toBe('*/*');
    expect((await http.delete('/e')).data).toBeUndefined();
    const streamRes = await http.get('/f', { responseType: 'stream' });
    expect(streamRes.data).toBeInstanceOf(ReadableStream);
  });

  it('turns invalid JSON on a 2xx into an SdkError INVALID_RESPONSE (not retried)', async () => {
    const fetch = sequenceFetch(
      new Response('<html>', { headers: { 'content-type': 'application/json' } })
    );
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const err = await http.get('/bad').catch((e) => e);
    expect(err).toBeInstanceOf(SdkError);
    expect(err.code).toBe('INVALID_RESPONSE');
    expect(err.requestId).toMatch(/^req_/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:error']);
  });

  it('exposes spec.meta on ctx.meta (Map) and on the resolved response', async () => {
    const { http } = make();
    let metaSeen;
    http.interceptors.request.use((spec, ctx) => {
      metaSeen = ctx.meta;
      ctx.meta.set('added', true);
    });
    const res = await http.get('/v1/a', { meta: { feature: 'search' } });
    expect(metaSeen).toBeInstanceOf(Map);
    expect(metaSeen.get('feature')).toBe('search');
    expect(res.meta).toEqual({ feature: 'search', added: true });
  });

  it('never mutates the caller’s opts (headers, query, meta, cache), whatever interceptors do', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch });
    http.interceptors.request.use((spec, ctx) => {
      ctx.setHeader('X-Added', '1');
      ctx.setQuery('added', 1);
      spec.meta.touched = true;
      spec.cache.ttlMs = 1;
      spec.headers['X-Direct'] = 'd';
      ctx.meta.set('m', 1);
    });
    const opts = {
      headers: { 'X-Orig': 'a' },
      query: { q: 'DEL' },
      meta: { feature: 'x' },
      cache: { ttlMs: 1000 },
      tag: 't',
    };
    const before = JSON.stringify(opts);
    const res = await http.get('/v1/a', opts);
    expect(JSON.stringify(opts)).toBe(before);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/a?q=DEL&added=1`);
    expect(init.headers).toMatchObject({ 'X-Orig': 'a', 'X-Added': '1', 'X-Direct': 'd' });
    expect(res.meta).toEqual({ feature: 'x', m: 1 });
  });
});

// ── interceptors ─────────────────────────────────────────────────────────────────────────────────

describe('interceptors', () => {
  it('runs request interceptors by ascending priority, registration order for ties, and off() removes', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch });
    const order = [];
    http.interceptors.request.use(() => order.push('default-1'));
    const offB = http.interceptors.request.use(() => order.push('b'), { priority: 10, name: 'b' });
    http.interceptors.request.use(() => order.push('a'), { priority: 5 });
    http.interceptors.request.use(() => order.push('default-2'));
    await http.get('/x');
    expect(order).toEqual(['a', 'b', 'default-1', 'default-2']);
    order.length = 0;
    offB();
    await http.get('/x');
    expect(order).toEqual(['a', 'default-1', 'default-2']);
    expect(() => http.interceptors.request.use('nope')).toThrow(ValidationError);
    expect(() => http.interceptors.request.use(() => {}, { priority: 'x' })).toThrow(
      ValidationError
    );
  });

  it('request interceptors may mutate through ctx.setHeader / setQuery or return a replacement spec', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch });
    http.interceptors.request.use((spec, ctx) => {
      ctx.setHeader('authorization', 'Bearer t');
      ctx.setQuery('locale', 'en-IN');
      ctx.setQuery('drop', undefined);
      expect(ctx.id).toMatch(/^req_/);
      expect(ctx.attempt).toBe(1);
      expect(typeof ctx.startedAt).toBe('number');
      expect(ctx.tag).toBe('search');
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
    });
    http.interceptors.request.use((spec) => ({ ...spec, path: spec.path + '/rewritten' }));
    await http.get('/v1/a', {
      query: { drop: 1 },
      tag: 'search',
      headers: { Authorization: 'old' },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/a/rewritten?locale=en-IN`);
    expect(init.headers.authorization).toBe('Bearer t');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('a request interceptor returning an HttpResponse short-circuits (no fetch, no response interceptors)', async () => {
    const fetch = vi.fn();
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const responseInterceptor = vi.fn();
    http.interceptors.response.use(responseInterceptor);
    http.interceptors.request.use(() => ({ data: { cached: true }, status: 200 }), { priority: 1 });
    const later = vi.fn();
    http.interceptors.request.use(later, { priority: 2 });
    const res = await http.get('/v1/a');
    expect(fetch).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    expect(responseInterceptor).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      data: { cached: true },
      status: 200,
      fromCache: true,
      attempts: 1,
    });
    expect(res.headers).toBeInstanceOf(Headers);
    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:response']);
  });

  it('a request interceptor returning a native Response enters the pipeline at afterResponse', async () => {
    const fetch = vi.fn();
    const { http } = make({ fetch });
    const after = vi.fn();
    http.hooks.on('afterResponse', after);
    http.interceptors.response.use((res) => ({ ...res, data: { ...res.data, unwrapped: true } }));
    http.interceptors.request.use(() => json({ mocked: true }, { status: 201 }));
    const res = await http.get('/v1/a');
    expect(fetch).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ mocked: true, unwrapped: true });
    expect(res.fromCache).toBe(false);
  });

  it('response interceptors replace the response in order; throwing turns a 2xx into an error', async () => {
    const fetch = sequenceFetch(json({ data: { id: 1 }, meta: { page: 1 } }));
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    http.interceptors.response.use(
      (res) => ({ ...res, data: res.data.data, meta: { ...res.meta, page: 1 } }),
      {
        priority: 10,
      }
    );
    http.interceptors.response.use(
      (res) => {
        expect(res.data).toEqual({ id: 1 });
      },
      { priority: 20 }
    );
    const res = await http.get('/v1/a');
    expect(res.data).toEqual({ id: 1 });
    expect(res.meta).toEqual({ page: 1 });
    expect(res.attempts).toBe(1);

    const off = http.interceptors.response.use(() => {
      throw new ApiError('Soft failure', { status: 200, code: 'SOFT_FAIL' });
    });
    const err = await http.get('/v1/b').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('SOFT_FAIL');
    expect(seen.filter((e) => e.type === 'http:error')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2); // a 200 with code SOFT_FAIL is not retried
    off();
  });

  it('error interceptors may recover with an HttpResponse, replace the error, or throw a replacement', async () => {
    const fetch = sequenceFetch(problem(404, { title: 'Nope', type: 'about:blank' }));
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const calls = [];
    http.interceptors.error.use(
      (err, ctx) => {
        calls.push(['first', err.name, ctx.attempt]);
        return new AuthError('replaced', { reason: 'forbidden' });
      },
      { priority: 1 }
    );
    http.interceptors.error.use(
      (err) => {
        calls.push(['second', err.name]);
      },
      { priority: 2 }
    );
    const err = await http.get('/v1/a').catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.reason).toBe('forbidden');
    expect(err.requestId).toMatch(/^req_/);
    expect(calls).toEqual([
      ['first', 'NotFoundError', 1],
      ['second', 'AuthError'],
    ]);
    expect(seen.at(-1)).toMatchObject({ type: 'http:error' });
    expect(seen.at(-1).error).toBe(err);

    const { http: http2 } = make({ fetch: sequenceFetch(problem(500, { title: 'boom' })) });
    http2.interceptors.error.use(() => {
      throw new ConflictError('thrown replacement');
    });
    http2.interceptors.error.use((e) => ({ data: { recovered: e.name }, status: 200 }));
    const res = await http2.get('/v1/a');
    expect(res).toMatchObject({
      data: { recovered: 'ConflictError' },
      status: 200,
      fromCache: false,
    });
  });

  it('ctx.retry() from an error interceptor re-enters at the cache/dedupe stage and counts an attempt', async () => {
    const fetch = sequenceFetch(problem(401, { title: 'expired' }), json({ ok: true }));
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const refresh = vi.fn(async () => 'new-token');
    http.interceptors.request.use((spec, ctx) => {
      ctx.setHeader('Authorization', `Bearer ${ctx.meta.get('token') || 'old'}`);
    });
    http.interceptors.error.use(async (err, ctx) => {
      if (err instanceof AuthError && !ctx.meta.get('refreshed')) {
        ctx.meta.set('refreshed', true);
        const token = await refresh();
        ctx.setHeader('Authorization', `Bearer ${token}`);
        return ctx.retry();
      }
    });
    const res = await http.post('/v1/secure', { a: 1 });
    expect(res.data).toEqual({ ok: true });
    expect(res.attempts).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token');
    // one http:retry per retry, one http:response per request (the nested attempt's is the one)
    expect(seen.map((e) => e.type)).toEqual([
      'http:request',
      'http:retry',
      'http:request',
      'http:response',
    ]);
    expect(seen[1]).toMatchObject({ id: res.requestId, attempt: 2, delayMs: 0 });
    expect(seen[1].error).toBeInstanceOf(AuthError);
    expect(seen[3]).toMatchObject({ attempts: 2, status: 200 });
  });

  it('an error settled by a nested ctx.retry() is final: later interceptors and the policy do not run on it again', async () => {
    const fetch = sequenceFetch(problem(503, { title: 'busy' }));
    const { http, events } = make({ fetch, retries: 0 });
    const seen = recordEvents(events);
    const onRetry = vi.fn();
    http.hooks.on('onRetry', onRetry);
    const later = vi.fn();
    http.interceptors.error.use((err, ctx) => (ctx.attempt === 1 ? ctx.retry() : undefined), {
      priority: 1,
    });
    http.interceptors.error.use((err, ctx) => later(ctx.attempt, err.status), { priority: 2 });
    const err = await http.get('/v1/a').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
    // attempt 1 retried before `later` was reached; attempt 2 ran `later` exactly once
    expect(later.mock.calls).toEqual([[2, 503]]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][1]).toBe(0);
    expect(seen.map((e) => e.type)).toEqual([
      'http:request',
      'http:retry',
      'http:request',
      'http:error',
    ]);
    expect(seen[1]).toMatchObject({ attempt: 2, delayMs: 0 });
    expect(seen[1].error).toBeInstanceOf(ApiError);
    expect(seen.at(-1)).toMatchObject({ attempts: 2, status: 503 });
    expect(seen.at(-1).error).toBe(err);
  });

  it('ctx.retry() from a response interceptor runs the pipeline once more; the outer stage does not re-process the result', async () => {
    const fetch = sequenceFetch(
      json({ data: { stale: true }, meta: { stale: true } }),
      json({ data: { fresh: true } })
    );
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const unwrap = vi.fn((res) => ({ ...res, data: res.data.data }));
    http.interceptors.response.use(unwrap, { priority: 10 });
    http.interceptors.response.use(
      (res, ctx) => (res.data.stale && ctx.attempt === 1 ? ctx.retry() : undefined),
      { priority: 20 }
    );
    const res = await http.get('/v1/a');
    expect(res.data).toEqual({ fresh: true }); // unwrapped exactly once
    expect(res.attempts).toBe(2);
    expect(unwrap).toHaveBeenCalledTimes(2); // once per attempt
    expect(seen.map((e) => e.type)).toEqual([
      'http:request',
      'http:retry',
      'http:request',
      'http:response',
    ]);
  });

  it('ctx.retry({ delayMs, spec }) waits through the injected timers and uses the new spec', async () => {
    vi.useFakeTimers();
    try {
      const fetch = sequenceFetch(problem(503, { title: 'busy' }), json({ ok: true }));
      const { http } = make({ fetch, retries: 0 });
      http.interceptors.error.use((err, ctx) =>
        ctx.attempt === 1
          ? ctx.retry({ delayMs: 500, spec: { ...ctx.spec, path: '/v1/other' } })
          : undefined
      );
      const p = http.get('/v1/a');
      await tick(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await tick(499);
      expect(fetch).toHaveBeenCalledTimes(1);
      await tick(1);
      const res = await p;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][0]).toBe(`${BASE}/v1/other`);
      expect(res.attempts).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('use(bundle) registers all three stages at once and returns one off()', async () => {
    const fetch = sequenceFetch(json({ a: 1 }));
    const { http } = make({ fetch });
    const calls = [];
    const off = http.use(
      {
        request: [
          (s, ctx) => calls.push(`req:${ctx.attempt}`),
          { fn: () => calls.push('req2'), priority: 1 },
        ],
        response: (res) => calls.push(`res:${res.status}`),
        error: () => calls.push('err'),
      },
      { priority: 50, name: 'bundle' }
    );
    await http.get('/x');
    expect(calls).toEqual(['req2', 'req:1', 'res:200']);
    calls.length = 0;
    off();
    await http.get('/x');
    expect(calls).toEqual([]);
    expect(() => http.use(null)).toThrow(ValidationError);
    expect(() => http.use({ request: 'x' })).toThrow(ValidationError);
  });
});

// ── hooks ────────────────────────────────────────────────────────────────────────────────────────

describe('hooks', () => {
  it('beforeRequest / afterResponse observe; ctx.abort(reason) in beforeRequest rejects with AbortError', async () => {
    const fetch = sequenceFetch(json({}));
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const before = vi.fn();
    const after = vi.fn();
    const onAbort = vi.fn();
    const onError = vi.fn();
    http.hooks.on('beforeRequest', before);
    http.hooks.on('afterResponse', after);
    http.hooks.on('onAbort', onAbort);
    http.hooks.on('onError', onError);
    await http.get('/ok');
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][0].response).toBeInstanceOf(Response);

    const off = http.hooks.on('beforeRequest', (ctx) => ctx.abort('blocked-by-hook'));
    const err = await http.get('/blocked', { tag: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.reason).toBe('blocked-by-hook');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ type: 'http:abort', reason: 'blocked-by-hook', tag: 'x' });
    off();
    await expect(http.get('/ok')).resolves.toBeTruthy();
  });

  it('swallows and logs hook exceptions / rejections; rejects unknown hook names', async () => {
    const { http, logger } = make();
    http.hooks.on('beforeRequest', () => {
      throw new Error('hook bug');
    });
    http.hooks.on('afterResponse', async () => {
      throw new Error('async hook bug');
    });
    const res = await http.get('/ok');
    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledWith('http: hook beforeRequest threw', expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(
      'http: hook afterResponse rejected',
      expect.anything()
    );
    expect(() => http.hooks.on('onSomething', () => {})).toThrow(ValidationError);
    expect(() => http.hooks.on('onRetry', 'x')).toThrow(ValidationError);
  });
});

// ── errors ───────────────────────────────────────────────────────────────────────────────────────

describe('error mapping', () => {
  it('maps problem+json by status and keeps the document on error.problem', async () => {
    const fetch = sequenceFetch(
      problem(404, {
        title: 'Not here',
        type: 'https://api.ota.com/problems/not-found',
        detail: 'x',
      })
    );
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const onError = vi.fn();
    http.hooks.on('onError', onError);
    const err = await http.get('/v1/missing', { tag: 'ref' }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.problem).toMatchObject({ title: 'Not here', detail: 'x', status: 404 });
    expect(err.requestId).toMatch(/^req_/);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].error).toBe(err);
    expect(seen.at(-1)).toMatchObject({ type: 'http:error', status: 404, tag: 'ref', attempts: 1 });
    expect(seen.at(-1).error).toBe(err);
  });

  it('maps plain-text 5xx and legacy JSON bodies to ApiError', async () => {
    const fetch = sequenceFetch(
      new Response('upstream down', { status: 502, headers: { 'content-type': 'text/plain' } })
    );
    const { http } = make({ fetch, retries: 0 });
    const err = await http.get('/v1/a').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
  });

  it('wraps a TypeError from fetch into NetworkError (retried, then rejected)', async () => {
    const fetch = sequenceFetch(networkError());
    const { http } = make({ fetch, retries: 1, backoff: { baseMs: 0 } });
    const err = await http.get('/v1/a').catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects with UnsupportedError when no fetch exists in the runtime', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
      const http = createHttp({ baseUrl: BASE, retries: 0 });
      const err = await http.get('/v1/a').catch((e) => e);
      expect(err.name).toBe('UnsupportedError');
      expect(err.feature).toBe('fetch');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('a TypeError thrown by an interceptor is a programming error: SdkError, not NetworkError, not retried', async () => {
    const fetch = sequenceFetch(json({}));
    const { http, events } = make({ fetch, retries: 2, backoff: { baseMs: 0 } });
    const seen = recordEvents(events);
    http.interceptors.response.use(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'data')");
    });
    const err = await http.get('/v1/a').catch((e) => e);
    expect(err).toBeInstanceOf(SdkError);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(err.requestId).toMatch(/^req_/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:error']);
  });

  it('a body that dies mid-read is a NetworkError and is retried like any transport failure', async () => {
    const fetch = sequenceFetch(
      () =>
        new Response(chunkStream(['{"partial":'], { error: new TypeError('terminated') }), {
          headers: { 'content-type': 'application/json' },
        }),
      json({ whole: true })
    );
    const { http } = make({ fetch, retries: 1, backoff: { baseMs: 0 } });
    const res = await http.get('/v1/a');
    expect(res.data).toEqual({ whole: true });
    expect(res.attempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ── timeout ──────────────────────────────────────────────────────────────────────────────────────

describe('timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts the attempt after timeoutMs with TimeoutError, runs onTimeout + onError, leaves no timers', async () => {
    const fetch = hangingFetch();
    const { http, events } = make({ fetch, retries: 0, timeoutMs: 1000 });
    const seen = recordEvents(events);
    const onTimeout = vi.fn();
    const onError = vi.fn();
    http.hooks.on('onTimeout', onTimeout);
    http.hooks.on('onError', onError);
    const p = http.get('/slow', { timeoutMs: 250 });
    const settled = p.catch((e) => e);
    await tick(249);
    expect(http.inflight()).toBe(1);
    await tick(1);
    const err = await settled;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.timeoutMs).toBe(250);
    expect(err.requestId).toMatch(/^req_/);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:error']);
    expect(http.inflight()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout timer when the response arrives; timeoutMs 0 disables it', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch, timeoutMs: 5000 });
    await http.get('/fast');
    expect(vi.getTimerCount()).toBe(0);
    const hang = hangingFetch();
    http.setFetch(hang);
    const p = http.get('/never', { timeoutMs: 0, tag: 'z' });
    await tick(60000);
    expect(vi.getTimerCount()).toBe(0);
    expect(http.inflight('z')).toBe(1);
    http.abort('z');
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });

  it('after a timed-out attempt, error interceptors see the live request-level ctx.signal, not the fired timeout', async () => {
    const fetch = hangingFetch();
    const { http } = make({ fetch, retries: 0, timeoutMs: 100 });
    const seen = [];
    http.interceptors.error.use((err, ctx) => {
      seen.push([err.name, ctx.signal.aborted]);
    });
    const settled = http.get('/slow').catch((e) => e);
    await tick(100);
    expect(await settled).toBeInstanceOf(TimeoutError);
    expect(seen).toEqual([['TimeoutError', false]]);
  });
});

// ── retry policy ─────────────────────────────────────────────────────────────────────────────────

describe('retry policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries an idempotent GET on 5xx with exponential jittered backoff, emitting http:retry + onRetry', async () => {
    const fetch = sequenceFetch(
      problem(503, { title: 'busy' }),
      problem(500, { title: 'boom' }),
      json({ ok: true })
    );
    const { http, events } = make({ fetch, retries: 2, backoff: { baseMs: 300, maxMs: 10000 } });
    const seen = recordEvents(events);
    const onRetry = vi.fn();
    http.hooks.on('onRetry', onRetry);
    const p = http.get('/v1/a', { tag: 'r' });
    await tick(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(299); // first delay: 300 * (0.5 + 0.5 * random=1) = 300
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await tick(599); // second delay: 600
    expect(fetch).toHaveBeenCalledTimes(2);
    await tick(1);
    const res = await p;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(res.data).toEqual({ ok: true });
    expect(res.attempts).toBe(3);
    const retries = seen.filter((e) => e.type === 'http:retry');
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ attempt: 2, delayMs: 300, tag: 'r' });
    expect(retries[0].error).toBeInstanceOf(ApiError);
    expect(retries[1]).toMatchObject({ attempt: 3, delayMs: 600 });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toBe(300);
    expect(onRetry.mock.calls[0][0].id).toBe(res.requestId);
    expect(seen.map((e) => e.type)).toEqual([
      'http:request',
      'http:retry',
      'http:request',
      'http:retry',
      'http:request',
      'http:response',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('jitter uses the injected random source and the delay is capped at backoff.maxMs', async () => {
    const fetch = sequenceFetch(problem(503, { title: 'busy' }), json({}));
    const random = vi.fn(() => 0);
    const { http, events } = make({
      fetch,
      random,
      retries: 3,
      backoff: { baseMs: 20000, maxMs: 1000 },
    });
    const seen = recordEvents(events);
    const p = http.get('/v1/a');
    await tick(500); // cap 1000 → delay = 500 + 500 * 0 = 500
    await p;
    expect(random).toHaveBeenCalledTimes(1);
    expect(seen.find((e) => e.type === 'http:retry').delayMs).toBe(500);
  });

  it('gives up after `retries` attempts and rejects with the last error (attempts recorded)', async () => {
    const fetch = sequenceFetch(problem(503, { title: 'busy' }));
    const { http, events } = make({ fetch, retries: 2, backoff: { baseMs: 10 } });
    const seen = recordEvents(events);
    const settled = http.get('/v1/a').catch((e) => e);
    await tick(10);
    await tick(20);
    const err = await settled;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(seen.at(-1)).toMatchObject({ type: 'http:error', attempts: 3 });
    expect(http.inflight()).toBe(0);
  });

  it('does not retry non-idempotent methods unless an Idempotency-Key is present', async () => {
    const fetch = sequenceFetch(problem(503, { title: 'busy' }), json({ ok: true }));
    const { http } = make({ fetch, retries: 2, backoff: { baseMs: 10 } });
    const err = await http.post('/v1/orders', { a: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);

    const fetchKeyed = sequenceFetch(problem(503, { title: 'busy' }), json({ ok: true }));
    http.setFetch(fetchKeyed);
    const p = http.post('/v1/orders', { a: 1 }, { headers: { 'Idempotency-Key': 'k-1' } });
    await tick(10);
    expect((await p).attempts).toBe(2);
    expect(fetchKeyed).toHaveBeenCalledTimes(2);

    const fetch2 = sequenceFetch(networkError(), json({ ok: true }));
    http.setFetch(fetch2);
    const p2 = http.post('/v1/orders', { a: 1 }, { idempotencyKey: true });
    await tick(10);
    expect((await p2).attempts).toBe(2);
  });

  it('retries network errors and timeouts, never 4xx (other than 408 / 425 / 429) or aborts', async () => {
    const fetch = sequenceFetch(
      networkError(),
      problem(408, { title: 'slow' }),
      problem(425, { title: 'early' }),
      json({})
    );
    const { http } = make({ fetch, retries: 5, backoff: { baseMs: 1 } });
    const p = http.get('/v1/a');
    await tick(1); // 1 ms
    await tick(2); // 2 ms
    await tick(4); // 4 ms
    expect((await p).attempts).toBe(4);

    const fetch400 = sequenceFetch(problem(400, { title: 'bad' }));
    http.setFetch(fetch400);
    const err = await http.get('/v1/b').catch((e) => e);
    expect(err.status).toBe(400);
    expect(fetch400).toHaveBeenCalledTimes(1);

    const hang = hangingFetch();
    http.setFetch(hang);
    const settled = http.get('/v1/c', { timeoutMs: 100, retries: 1 }).catch((e) => e);
    await tick(100); // first timeout
    await tick(1); // backoff (base 1)
    await tick(100); // second timeout
    const terr = await settled;
    expect(terr).toBeInstanceOf(TimeoutError);
    expect(hang).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After on 429 (delta-seconds) and refuses to wait past backoff.maxMs', async () => {
    const fetch = sequenceFetch(
      problem(429, { title: 'slow down' }, { 'retry-after': '2' }),
      json({ ok: true })
    );
    const { http, events } = make({ fetch, retries: 2, backoff: { maxMs: 10000 } });
    const seen = recordEvents(events);
    const p = http.get('/v1/a');
    await tick(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await tick(1);
    expect((await p).attempts).toBe(2);
    const retry = seen.find((e) => e.type === 'http:retry');
    expect(retry.delayMs).toBe(2000);
    expect(retry.error).toBeInstanceOf(RateLimitError);

    const fetchLong = sequenceFetch(problem(429, { title: 'slow down' }, { 'retry-after': '120' }));
    http.setFetch(fetchLong);
    const err = await http.get('/v1/b').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(120000);
    expect(fetchLong).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 without Retry-After using backoff, and uses Retry-After on 503 too', async () => {
    const fetch = sequenceFetch(
      problem(429, { title: 'slow down' }),
      problem(503, { title: 'busy' }, { 'retry-after': '1' }),
      json({})
    );
    const { http, events } = make({ fetch, retries: 2, backoff: { baseMs: 100 } });
    const seen = recordEvents(events);
    const p = http.get('/v1/a');
    await tick(100);
    await tick(1000);
    expect((await p).attempts).toBe(3);
    expect(seen.filter((e) => e.type === 'http:retry').map((e) => e.delayMs)).toEqual([100, 1000]);
  });

  it('opts.retryOn overrides the default policy in both directions', async () => {
    const fetch = sequenceFetch(problem(500, { title: 'boom' }), json({ ok: true }));
    const { http } = make({ fetch, retries: 2, backoff: { baseMs: 1 } });
    const retryOn = vi.fn((err, attempt) => err.status === 500 && attempt === 1);
    const p = http.post('/v1/orders', { a: 1 }, { retryOn });
    await tick(1);
    expect((await p).attempts).toBe(2);
    expect(retryOn).toHaveBeenCalledTimes(1);
    expect(retryOn.mock.calls[0][0]).toBeInstanceOf(ApiError);
    expect(retryOn.mock.calls[0][1]).toBe(1);
    expect(retryOn.mock.calls[0][2].id).toMatch(/^req_/);

    const fetch2 = sequenceFetch(problem(503, { title: 'busy' }), json({}));
    http.setFetch(fetch2);
    const err = await http.get('/v1/a', { retryOn: () => false }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it('client-wide retryOn applies when the request has none; per-request wins', async () => {
    const fetch = sequenceFetch(problem(500, { title: 'boom' }), json({}));
    const { http } = make({ fetch, retries: 1, backoff: { baseMs: 1 }, retryOn: () => true });
    const p = http.post('/v1/x', {});
    await tick(1);
    expect((await p).attempts).toBe(2);
  });
});

// ── abort ────────────────────────────────────────────────────────────────────────────────────────

describe('abort', () => {
  it('a caller signal aborts the in-flight request with AbortError and emits http:abort', async () => {
    const fetch = hangingFetch();
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const ac = new AbortController();
    const settled = http.get('/v1/slow', { signal: ac.signal, tag: 'slow' }).catch((e) => e);
    await Promise.resolve();
    expect(http.inflight('slow')).toBe(1);
    ac.abort('user-left');
    const err = await settled;
    expect(err).toBeInstanceOf(AbortError);
    expect(err.reason).toBe('user-left');
    expect(err.requestId).toMatch(/^req_/);
    expect(http.inflight()).toBe(0);
    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:abort']);
    expect(seen[1]).toMatchObject({ reason: 'user-left', tag: 'slow' });
  });

  it('an already-aborted signal rejects before any fetch; abort(tag) / abortAll return counts', async () => {
    const fetch = hangingFetch();
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const ac = new AbortController();
    ac.abort();
    await expect(http.get('/v1/a', { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
    expect(fetch).not.toHaveBeenCalled();

    const a = http.get('/v1/a', { tag: 'search' }).catch((e) => e);
    const b = http.get('/v1/b', { tag: 'search' }).catch((e) => e);
    const c = http.get('/v1/c', { tag: 'booking' }).catch((e) => e);
    await Promise.resolve();
    expect(http.inflight()).toBe(3);
    expect(http.inflight('search')).toBe(2);
    expect(http.abort('search', 'new-search')).toBe(2);
    expect(http.abort('search')).toBe(0);
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea).toBeInstanceOf(AbortError);
    expect(ea.reason).toBe('new-search');
    expect(eb.reason).toBe('new-search');
    expect(http.inflight()).toBe(1);
    expect(http.abortAll()).toBe(1);
    expect((await c).reason).toBe('aborted');
    expect(seen.filter((e) => e.type === 'http:abort')).toHaveLength(4);
    expect(http.inflight()).toBe(0);
  });

  it('abort during a retry wait cancels the wait and leaves no timers', async () => {
    vi.useFakeTimers();
    try {
      const fetch = sequenceFetch(problem(503, { title: 'busy' }));
      const { http } = make({ fetch, retries: 3, backoff: { baseMs: 1000 } });
      const settled = http.get('/v1/a', { tag: 't' }).catch((e) => e);
      await tick(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      expect(http.abort('t')).toBe(1);
      const err = await settled;
      expect(err).toBeInstanceOf(AbortError);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abort while an error interceptor is running rejects with AbortError (http:abort, not http:error)', async () => {
    const fetch = sequenceFetch(problem(500, { title: 'boom' }));
    const { http, events } = make({ fetch, retries: 2 });
    const seen = recordEvents(events);
    const onAbort = vi.fn();
    const onError = vi.fn();
    http.hooks.on('onAbort', onAbort);
    http.hooks.on('onError', onError);
    let release;
    http.interceptors.error.use(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const settled = http.get('/v1/a', { tag: 't' }).catch((e) => e);
    await settle();
    expect(typeof release).toBe('function');
    expect(http.abort('t', 'navigated')).toBe(1);
    // even a recovery produced after the abort does not outrun it
    release({ data: { recovered: true }, status: 200 });
    const err = await settled;
    expect(err).toBeInstanceOf(AbortError);
    expect(err.reason).toBe('navigated');
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(seen.map((e) => e.type)).toEqual(['http:request', 'http:abort']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(http.inflight()).toBe(0);
  });

  it('destroy() aborts everything, drops interceptors and hooks, and later requests reject', async () => {
    const fetch = hangingFetch();
    const { http } = make({ fetch });
    const hook = vi.fn();
    http.hooks.on('beforeRequest', hook);
    const p = http.get('/v1/a').catch((e) => e);
    await Promise.resolve();
    http.destroy();
    expect((await p).reason).toBe('destroyed');
    expect(http.inflight()).toBe(0);
    const err = await http.get('/v1/b').catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

// ── dedupe ───────────────────────────────────────────────────────────────────────────────────────

describe('dedupe', () => {
  it('shares one fetch between identical in-flight GETs (method + url + body) and both resolve', async () => {
    const resolvers = [];
    const fetch = vi.fn(() => new Promise((r) => resolvers.push(r)));
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const a = http.get('/v1/places', { query: { q: 'DEL' } });
    const b = http.get('/v1/places', { query: { q: 'DEL' } });
    const c = http.get('/v1/places', { query: { q: 'BOM' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(http.inflight()).toBe(3);
    resolvers.forEach((r) => r(json({ list: [1] })));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.data).toEqual({ list: [1] });
    expect(rb.data).toEqual({ list: [1] });
    expect(rb.meta.deduped).toBe(true);
    expect(ra.meta.deduped).toBeUndefined();
    // the follower reports the correlation id the server actually saw
    expect(rb.requestId).toBe(ra.requestId);
    await c;
    expect(seen.filter((e) => e.type === 'http:request' && e.deduped)).toHaveLength(1);
    expect(seen.filter((e) => e.type === 'http:response')).toHaveLength(3);
    // the registry is released: a later identical GET fetches again
    const later = http.get('/v1/places', { query: { q: 'DEL' } });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    resolvers[2](json({ list: [2] }));
    expect((await later).data).toEqual({ list: [2] });
  });

  it('POSTs are not deduped unless dedupe: true; dedupe: false opts a GET out', async () => {
    const fetch = sequenceFetch(json({}));
    const { http } = make({ fetch });
    await Promise.all([http.post('/v1/x', { a: 1 }), http.post('/v1/x', { a: 1 })]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await Promise.all([
      http.post('/v1/x', { a: 1 }, { dedupe: true }),
      http.post('/v1/x', { a: 1 }, { dedupe: true }),
      http.post('/v1/x', { a: 2 }, { dedupe: true }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    await Promise.all([http.get('/v1/y', { dedupe: false }), http.get('/v1/y', { dedupe: false })]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('a follower aborting does not abort the leader; a failing leader fails its followers', async () => {
    const fetch = hangingFetch();
    const { http } = make({ fetch });
    const ac = new AbortController();
    const leader = http.get('/v1/a', { tag: 'leader' });
    const follower = http.get('/v1/a', { signal: ac.signal }).catch((e) => e);
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    expect(await follower).toBeInstanceOf(AbortError);
    expect(http.inflight()).toBe(1);
    const follower2 = http.get('/v1/a').catch((e) => e);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    http.abort('leader');
    expect(await leader.catch((e) => e)).toBeInstanceOf(AbortError);
    expect(await follower2).toBeInstanceOf(AbortError);
    expect(http.inflight()).toBe(0);
  });

  it('a leader whose retry changed the URL still serves its followers and releases its key (no later hang)', async () => {
    const fetch = sequenceFetch(problem(503, { title: 'busy' }), json({ ok: true }));
    const { http } = make({ fetch, retries: 0 });
    http.interceptors.error.use((err, ctx) =>
      ctx.attempt === 1 ? ctx.retry({ spec: { ...ctx.spec, path: '/v1/mirror' } }) : undefined
    );
    const leader = http.get('/v1/a');
    const follower = http.get('/v1/a');
    const [r1, r2] = await Promise.all([leader, follower]);
    expect(r1.data).toEqual({ ok: true });
    expect(r2.data).toEqual({ ok: true });
    expect(r2.meta.deduped).toBe(true);
    expect(r2.headers).not.toBe(r1.headers); // followers get their own Headers
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(`${BASE}/v1/mirror`);
    // the registry is clean: a later identical GET fetches instead of waiting behind a dead leader
    let timer;
    const later = await Promise.race([
      http.get('/v1/a'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('later GET hung behind a leaked key')), 2000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(later.fromCache).toBe(false);
    expect(later.meta.deduped).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(http.inflight()).toBe(0);
  });
});

// ── cache ────────────────────────────────────────────────────────────────────────────────────────

describe('cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores 2xx responses through storage when spec.cache is set and serves them until ttl expires', async () => {
    const fetch = sequenceFetch(json({ v: 1 }, { headers: { etag: '"a"' } }), json({ v: 2 }));
    const { http, storage, events } = make({ fetch });
    const seen = recordEvents(events);
    const first = await http.get('/v1/airports', { cache: { ttlMs: 1000 }, query: { q: 'DEL' } });
    expect(first.fromCache).toBe(false);
    expect(storage.keys('cache:')).toHaveLength(1);
    const second = await http.get('/v1/airports', { cache: { ttlMs: 1000 }, query: { q: 'DEL' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual({ v: 1 });
    expect(second.headers).toBeInstanceOf(Headers);
    expect(second.headers.get('etag')).toBe('"a"');
    expect(second.requestId).toBe(first.requestId);
    expect(seen.filter((e) => e.type === 'http:response' && e.fromCache)).toHaveLength(1);
    // without spec.cache the cache is bypassed
    await http.get('/v1/airports', { query: { q: 'DEL' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await tick(1000);
    const third = await http.get('/v1/airports', { cache: { ttlMs: 1000 }, query: { q: 'DEL' } });
    expect(third.fromCache).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('never caches errors; supports custom keys, invalidate(key) and clear(pattern)', async () => {
    const fetch = sequenceFetch(
      problem(500, { title: 'boom' }),
      json({ a: 1 }),
      json({ b: 2 }),
      json({ c: 3 })
    );
    const { http, storage } = make({ fetch, retries: 0 });
    await http.get('/v1/err', { cache: { ttlMs: 5000 } }).catch(() => {});
    expect(storage.keys('cache:')).toHaveLength(0);

    await http.get('/v1/a', { cache: { ttlMs: 5000, key: 'airports:DEL' } });
    await http.get('/v1/b', { cache: { ttlMs: 5000, key: 'airlines:all' } });
    await http.get('/v1/c', { cache: { ttlMs: 5000 } });
    expect(storage.keys('cache:')).toHaveLength(3);

    http.cache.invalidate('airports:DEL');
    expect(storage.keys('cache:')).toHaveLength(2);
    expect(
      (await http.get('/v1/b', { cache: { ttlMs: 5000, key: 'airlines:all' } })).fromCache
    ).toBe(true);

    http.cache.clear(/^GET .*\/v1\/c$/);
    expect(storage.keys('cache:')).toHaveLength(1);
    http.cache.clear('airlines');
    expect(storage.keys('cache:')).toHaveLength(0);

    await http.get('/v1/c', { cache: { ttlMs: 5000 } });
    http.cache.clear();
    expect(storage.keys('cache:')).toHaveLength(0);
    expect(() => http.cache.invalidate('')).toThrow(ValidationError);
  });

  it('uses an internal memory store when no storage is given', async () => {
    const fetch = sequenceFetch(json({ a: 1 }));
    const http = createHttp({ baseUrl: BASE, fetch });
    await http.get('/v1/a', { cache: { ttlMs: 100 } });
    expect((await http.get('/v1/a', { cache: { ttlMs: 100 } })).fromCache).toBe(true);
    await tick(100);
    expect((await http.get('/v1/a', { cache: { ttlMs: 100 } })).fromCache).toBe(false);
    http.cache.clear();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keys non-GET entries by body too (key-order independent); unkeyable bodies need an explicit key', async () => {
    const fetch = sequenceFetch(json({ v: 1 }), json({ v: 2 }), json({ v: 3 }), json({ v: 4 }));
    const { http, storage } = make({ fetch });
    const cache = { ttlMs: 5000 };
    const a = await http.post('/v1/search', { q: 'DEL', d: '2026-12-01' }, { cache });
    const b = await http.post('/v1/search', { q: 'BOM', d: '2026-12-01' }, { cache });
    expect(a.data).toEqual({ v: 1 });
    expect(b.data).toEqual({ v: 2 });
    expect(b.fromCache).toBe(false);
    const again = await http.post('/v1/search', { d: '2026-12-01', q: 'DEL' }, { cache });
    expect(again.fromCache).toBe(true);
    expect(again.data).toEqual({ v: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(storage.keys('cache:')).toHaveLength(2);
    // multipart bodies cannot be keyed: nothing is stored or served without a custom key
    const fd = new FormData();
    fd.append('a', '1');
    await http.post('/v1/up', fd, { cache });
    expect(storage.keys('cache:')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(3);
    await http.post('/v1/up', fd, { cache: { ttlMs: 5000, key: 'up:a' } });
    expect(storage.keys('cache:')).toHaveLength(3);
    expect((await http.post('/v1/up', fd, { cache: { ttlMs: 5000, key: 'up:a' } })).fromCache).toBe(
      true
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

// ── upload ───────────────────────────────────────────────────────────────────────────────────────

describe('upload', () => {
  it('POSTs multipart bodies untouched and reports best-effort progress', async () => {
    const fetch = sequenceFetch(json({ id: 'doc_1' }, { status: 201 }));
    const { http } = make({ fetch });
    const fd = new FormData();
    fd.append('file', new Blob(['abc']), 'a.txt');
    const onProgress = vi.fn();
    const res = await http.upload('/v1/documents', fd, { onProgress, tag: 'docs' });
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ id: 'doc_1' });
    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(fd);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0]).toEqual({
      loaded: 0,
      total: undefined,
      lengthComputable: false,
      done: false,
    });
    expect(onProgress.mock.calls[1][0]).toEqual({
      loaded: 1,
      total: 1,
      lengthComputable: false,
      done: true,
    });
    const blob = new Blob(['12345']);
    await http.upload('/v1/documents', blob, { onProgress, method: 'PUT' });
    expect(fetch.mock.calls[1][1].method).toBe('PUT');
    expect(onProgress.mock.calls[2][0]).toEqual({
      loaded: 0,
      total: 5,
      lengthComputable: true,
      done: false,
    });
    expect(onProgress.mock.calls[3][0]).toEqual({
      loaded: 5,
      total: 5,
      lengthComputable: true,
      done: true,
    });
  });
});

// ── stream ───────────────────────────────────────────────────────────────────────────────────────

/** A ReadableStream of UTF-8 chunks, optionally ending with an error. */
function chunkStream(chunks, { error } = {}) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      if (chunks.length === 0) {
        if (error) controller.error(error);
        else controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks.shift()));
    },
  });
}

function sse(chunks, extra = {}) {
  return new Response(chunkStream(chunks, extra), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function ndjson(chunks, extra = {}) {
  return new Response(chunkStream(chunks, extra), {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

describe('stream', () => {
  it('parses SSE events (multi-line data, event, id, retry, comments) with JSON decoding', async () => {
    const fetch = sequenceFetch(
      () =>
        sse([
          ': comment\nevent: offers\nid: 1\ndata: {"a":',
          '1}\n\n',
          'data: line one\ndata: line two\n\n',
          'retry: 50\nevent: done\ndata: {"complete":true}\n\n',
        ]),
      // after the clean end the SSE stream reconnects: hand it something that ends too
      () => sse([])
    );
    const { http, events } = make({ fetch });
    const seen = recordEvents(events);
    const s = http.stream('/v1/search/s1/stream', { tag: 'search', reconnect: false });
    const got = [];
    for await (const ev of s) {
      got.push(ev);
      if (ev.type === 'done') break;
    }
    expect(got).toEqual([
      {
        type: 'offers',
        data: { a: 1 },
        id: '1',
        lastEventId: '1',
        retry: undefined,
        raw: '{"a":1}',
      },
      {
        type: 'message',
        data: 'line one\nline two',
        id: undefined,
        lastEventId: '1',
        retry: undefined,
        raw: 'line one\nline two',
      },
      {
        type: 'done',
        data: { complete: true },
        id: undefined,
        lastEventId: '1',
        retry: 50,
        raw: '{"complete":true}',
      },
    ]);
    expect(s.closed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Accept).toMatch(/text\/event-stream/);
    expect(seen.filter((e) => e.type === 'http:request')).toHaveLength(1);
    expect(seen[0].tag).toBe('search');
  });

  it('parses NDJSON lines (skipping invalid ones) and completes when the body ends', async () => {
    const fetch = sequenceFetch(() => ndjson(['{"n":1}\n{"n"', ':2}\r\nnot json\n{"n":3}']));
    const { http, logger } = make({ fetch });
    const got = [];
    for await (const ev of http.stream('/v1/booking/b1/status')) got.push(ev.data);
    expect(got).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(logger.warn).toHaveBeenCalledWith(
      'http.stream: skipping invalid NDJSON line',
      expect.anything()
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reconnects with backoff and Last-Event-ID after a network failure until the signal aborts', async () => {
    vi.useFakeTimers();
    try {
      const fetch = sequenceFetch(
        () =>
          sse(['id: 7\ndata: {"first":true}\n\n'], { error: new TypeError('connection reset') }),
        networkError(),
        () => sse(['data: {"second":true}\n\n', 'id: 9\ndata: {"third":true}\n\n'])
      );
      const { http, events } = make({ fetch, random: () => 0, timeoutMs: 0 });
      const seen = recordEvents(events);
      const ac = new AbortController();
      const s = http.stream('/v1/live', {
        signal: ac.signal,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 5000,
      });
      const got = [];
      const consume = (async () => {
        for await (const ev of s) got.push(ev);
      })();
      await settle();
      expect(got.map((e) => e.data)).toEqual([{ first: true }]);
      expect(fetch).toHaveBeenCalledTimes(1);
      await tick(499); // first reconnect delay: 1000 * (0.5 + 0.5 * 0) = 500
      expect(fetch).toHaveBeenCalledTimes(1);
      await tick(1);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][1].headers['Last-Event-ID']).toBe('7');
      await tick(1000); // second delay: 2000 * 0.5 = 1000
      await settle();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(got.map((e) => e.data)).toEqual([{ first: true }, { second: true }, { third: true }]);
      expect(got[2].lastEventId).toBe('9');
      // the third connection ended cleanly → SSE reconnects again after backoff; abort instead
      ac.abort();
      await consume;
      expect(s.closed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(seen.filter((e) => e.type === 'http:request')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() stops the stream, aborts the connection and ends iteration; return() closes too', async () => {
    let controller;
    const body = new ReadableStream({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
      },
    });
    const fetch = vi.fn(async (_url, init) => {
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {
        once: true,
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const { http } = make({ fetch, timeoutMs: 0 });
    const s = http.stream('/v1/live');
    const first = await s.next();
    expect(first).toEqual({ done: false, value: expect.objectContaining({ data: { a: 1 } }) });
    const pending = s.next();
    s.close();
    expect(s.closed).toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(s.next()).resolves.toEqual({ done: true, value: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(http.inflight()).toBe(0);

    const s2 = http.stream('/v1/live2', { reconnect: false });
    await expect(s2.return()).resolves.toEqual({ done: true, value: undefined });
    expect(s2.closed).toBe(true);
  });

  it('a non-retryable failure (404 problem) rejects the iteration with the mapped SdkError', async () => {
    const fetch = sequenceFetch(problem(404, { title: 'no such session' }));
    const { http } = make({ fetch });
    const s = http.stream('/v1/search/missing/stream');
    await expect(s.next()).rejects.toBeInstanceOf(NotFoundError);
    // a subsequent next() keeps rejecting; nothing hangs
    await expect(s.next()).rejects.toBeInstanceOf(NotFoundError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops after maxReconnects and surfaces the last error', async () => {
    vi.useFakeTimers();
    try {
      const fetch = sequenceFetch(networkError());
      const { http } = make({ fetch, random: () => 0 });
      const s = http.stream('/v1/live', { maxReconnects: 2, reconnectBaseMs: 100 });
      const result = s.next().catch((e) => e);
      await tick(50);
      await tick(100);
      await tick(1000);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(await result).toBeInstanceOf(NetworkError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a connection that delivers events resets the reconnect budget and backoff (maxReconnects is consecutive)', async () => {
    vi.useFakeTimers();
    try {
      const dropped = () => new TypeError('terminated'); // what undici throws when a body dies
      const fetch = sequenceFetch(
        networkError(),
        () => sse(['data: {"n":1}\n\n'], { error: dropped() }),
        () => sse(['data: {"n":2}\n\n'], { error: dropped() }),
        networkError()
      );
      const { http } = make({ fetch, random: () => 0, timeoutMs: 0 });
      const s = http.stream('/v1/live', { maxReconnects: 1, reconnectBaseMs: 1000 });
      const got = [];
      const outcome = (async () => {
        for await (const ev of s) got.push(ev.data);
      })().catch((e) => e);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      await tick(500); // 1000 * 0.5: the single reconnect of the budget
      await settle();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(got).toEqual([{ n: 1 }]);
      // that connection delivered → budget and backoff restart (same 500 ms, not 1000)
      await tick(500);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(got).toEqual([{ n: 1 }, { n: 2 }]);
      await tick(500);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(4);
      // a failure without any progress exhausts the budget of 1
      expect(await outcome).toBeInstanceOf(NetworkError);
      expect(s.closed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers concurrent next() calls in order', async () => {
    let controller;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    );
    const { http } = make({ fetch, timeoutMs: 0 });
    const s = http.stream('/v1/live', { reconnect: false });
    const first = s.next();
    const second = s.next();
    const third = s.next();
    await settle();
    controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
    expect((await first).value.data).toBe(1);
    expect((await second).value.data).toBe(2);
    controller.close();
    await expect(third).resolves.toEqual({ done: true, value: undefined });
  });

  it('abort(tag) / abortAll() close open streams by tag (counted once) and end their iteration', async () => {
    let controller;
    const fetch = vi.fn(async (_url, init) => {
      const body = new ReadableStream({
        start(c) {
          controller = c;
          c.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
        },
      });
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {
        once: true,
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const { http } = make({ fetch, timeoutMs: 0 });
    const s = http.stream('/v1/live', { tag: 'live' });
    expect((await s.next()).value.data).toEqual({ a: 1 });
    expect(http.inflight()).toBe(0); // headers arrived: the stream is no longer an in-flight request
    const pending = s.next();
    expect(http.abort('other')).toBe(0);
    expect(s.closed).toBe(false);
    expect(http.abort('live')).toBe(1);
    expect(s.closed).toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(s.next()).resolves.toEqual({ done: true, value: undefined });
    // a stream still opening its connection is counted once, through its in-flight request
    const hang = hangingFetch();
    http.setFetch(hang);
    const s2 = http.stream('/v1/live2', { tag: 'x' });
    const pending2 = s2.next();
    await settle();
    expect(http.inflight('x')).toBe(1);
    expect(http.abortAll()).toBe(1);
    await expect(pending2).resolves.toEqual({ done: true, value: undefined });
    expect(s2.closed).toBe(true);
    expect(http.inflight()).toBe(0);
  });

  it('destroy() closes open streams and clears their reconnect timers', async () => {
    vi.useFakeTimers();
    try {
      const fetch = sequenceFetch(networkError());
      const { http } = make({ fetch, random: () => 0 });
      const s = http.stream('/v1/live', { reconnectBaseMs: 60000 });
      const pending = s.next();
      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1); // the reconnect wait
      http.destroy();
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      expect(s.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await tick(60000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── MSW round trips ──────────────────────────────────────────────────────────────────────────────

describe('real fetch through MSW', () => {
  it('performs a JSON round trip against https://api.ota.com with headers and query', async () => {
    const received = [];
    server.use(
      msw.post(`${BASE}/v1/echo`, async ({ request }) => {
        received.push({
          url: request.url,
          accept: request.headers.get('accept'),
          contentType: request.headers.get('content-type'),
          apiKey: request.headers.get('x-api-key'),
          body: await request.json(),
        });
        return HttpResponse.json(
          { echoed: true },
          { status: 201, headers: { 'x-request-id': 'srv-9' } }
        );
      })
    );
    const events = createEmitter();
    const http = createHttp({ baseUrl: BASE, events, headers: { 'X-Api-Key': 'pk_test' } });
    const res = await http.post('/v1/echo', { q: 'DEL' }, { query: { lang: 'en' } });
    expect(received).toEqual([
      {
        url: `${BASE}/v1/echo?lang=en`,
        accept: expect.stringContaining('application/json'),
        contentType: 'application/json',
        apiKey: 'pk_test',
        body: { q: 'DEL' },
      },
    ]);
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ echoed: true });
    expect(res.headers.get('x-request-id')).toBe('srv-9');
    expect(res.attempts).toBe(1);
  });

  it('maps an application/problem+json response to the right ApiError subclass', async () => {
    server.use(
      msw.get(`${BASE}/v1/itineraries/it_1`, () =>
        HttpResponse.json(
          {
            type: 'https://api.ota.com/problems/conflict',
            title: 'Itinerary already booked',
            status: 409,
            detail: 'The itinerary it_1 has already been booked',
            requestId: 'srv-409',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } }
        )
      )
    );
    const http = createHttp({ baseUrl: BASE, retries: 0 });
    const err = await http.get('/v1/itineraries/it_1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.problem).toMatchObject({ title: 'Itinerary already booked', requestId: 'srv-409' });
    expect(err.requestId).toMatch(/^req_/);
  });
});

// ── hygiene ──────────────────────────────────────────────────────────────────────────────────────

/** Injectable timers that remember every handle still pending. */
function trackedTimers() {
  const live = new Set();
  return {
    live,
    timers: {
      setTimeout(fn, ms) {
        const handle = setTimeout(() => {
          live.delete(handle);
          fn();
        }, ms);
        live.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        live.delete(handle);
        clearTimeout(handle);
      },
    },
  };
}

describe('hygiene', () => {
  it('leaves no timers or in-flight entries after success, failure, abort and retries', async () => {
    vi.useFakeTimers();
    try {
      const fetch = sequenceFetch(
        json({}),
        problem(503, { title: 'busy' }),
        json({}),
        networkError()
      );
      const tracked = trackedTimers();
      const { http, events } = make({
        fetch,
        retries: 1,
        backoff: { baseMs: 10 },
        timers: tracked.timers,
      });
      await http.get('/a');
      expect(tracked.live.size).toBe(0);
      const p = http.get('/b');
      await tick(10);
      await p;
      const settled = http.get('/c', { retries: 0 }).catch((e) => e);
      expect(await settled).toBeInstanceOf(NetworkError);
      const hang = hangingFetch();
      http.setFetch(hang);
      const aborted = http.get('/d', { tag: 'x' }).catch((e) => e);
      await tick(0);
      http.abort('x');
      expect(await aborted).toBeInstanceOf(AbortError);
      // Every timer the client created (timeouts, backoff waits) has been cleared or has fired.
      expect(tracked.live.size).toBe(0);
      expect(http.inflight()).toBe(0);
      expect(events.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch the global fetch, window or storage at import time (module is SSR-safe)', async () => {
    const mod = await import('../../src/http/client.js');
    expect(Object.keys(mod)).toEqual(['createHttp']);
    expect(typeof globalThis.window).toBe('undefined');
  });
});
