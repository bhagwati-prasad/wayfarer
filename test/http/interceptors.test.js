import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_PRIORITIES,
  apiKeyInterceptor,
  authInterceptor,
  cacheInterceptor,
  correlationInterceptor,
  csrfInterceptor,
  dedupeInterceptor,
  deviceInterceptor,
  envelopeInterceptor,
  idempotencyInterceptor,
  installDefaultInterceptors,
  localeInterceptor,
  loggingInterceptor,
  mockInterceptor,
  problemInterceptor,
  rateLimitInterceptor,
  telemetryInterceptor,
} from '../../src/http/interceptors.js';
import {
  AbortError,
  ApiError,
  AuthError,
  ConfigError,
  NetworkError,
  NotFoundError,
  OfferExpiredError,
  RateLimitError,
  ValidationError,
} from '../../src/errors/index.js';
import { idempotencyKey } from '../../src/utils/id.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A lifecycle ctx as `http/client.js` hands it to interceptors (docs/api/01-core.md §3.1). */
function ctxFor(spec, extra = {}) {
  const ctx = {
    id: 'req_1',
    spec,
    attempt: 1,
    startedAt: 1000,
    tag: spec.tag,
    meta: new Map(),
    setHeader: vi.fn((name, value) => {
      // mirrors http/client.js: any casing is replaced, `undefined` deletes
      const headers = { ...(spec.headers || {}) };
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
      }
      if (value !== undefined) headers[name] = value;
      spec.headers = headers;
    }),
    setQuery: vi.fn(),
    retry: vi.fn(async () => ({ data: 'retried', status: 200, attempts: 2 })),
    abort: vi.fn(),
    signal: new AbortController().signal,
    ...extra,
  };
  return ctx;
}

/** A `Map`‑backed `StorageLike` with the facade's read / write surface. */
function memoryStore() {
  const map = new Map();
  return {
    map,
    get: vi.fn((k) => map.get(k)),
    set: vi.fn((k, v) => {
      map.set(k, v);
    }),
    remove: vi.fn((k) => {
      map.delete(k);
    }),
    keys: vi.fn((prefix) => [...map.keys()].filter((k) => !prefix || k.startsWith(prefix))),
  };
}

function fakeAuth(overrides = {}) {
  return {
    getAccessToken: vi.fn(() => 'acc-1'),
    getGuestToken: vi.fn(() => null),
    isGuest: vi.fn(() => false),
    refresh: vi.fn(async () => ({ accessToken: 'acc-2' })),
    ...overrides,
  };
}

/** An auth whose refresh rotates the access token, as `auth/session.js` does. */
function rotatingAuth(initial = 'acc-1', next = 'acc-2') {
  let token = initial;
  return {
    getAccessToken: vi.fn(() => token),
    getGuestToken: vi.fn(() => null),
    isGuest: vi.fn(() => false),
    refresh: vi.fn(async () => {
      token = next;
      return { accessToken: token };
    }),
    setToken: (t) => {
      token = t;
    },
  };
}

function problemResponse(status, problem, headers = {}) {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/problem+json', ...headers }),
    problem,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── DEFAULT_PRIORITIES ───────────────────────────────────────────────────────────────────────────

describe('DEFAULT_PRIORITIES', () => {
  it('matches the documented installation order and is frozen', () => {
    expect(DEFAULT_PRIORITIES.request).toMatchObject({
      correlation: 10,
      apiKey: 20,
      locale: 30,
      device: 35,
      csrf: 40,
      auth: 50,
      idempotency: 60,
      cache: 70,
      dedupe: 80,
      logging: 90,
      telemetry: 95,
    });
    expect(DEFAULT_PRIORITIES.response).toMatchObject({ envelope: 10, problem: 20 });
    expect(DEFAULT_PRIORITIES.error).toMatchObject({ problem: 10, auth: 20, rateLimit: 30 });
    expect(Object.isFrozen(DEFAULT_PRIORITIES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PRIORITIES.request)).toBe(true);
  });

  it('every bundle exposes name, priority and per-stage priorities', () => {
    const b = authInterceptor({ auth: fakeAuth() });
    expect(b.name).toBe('auth');
    expect(b.priority).toBe(50);
    expect(b.priorities).toEqual({ request: 50, error: 20 });
    expect(typeof b.request).toBe('function');
    expect(typeof b.error).toBe('function');
    expect(b.response).toBeUndefined();
    const p = problemInterceptor();
    expect(p.priority).toBe(10);
    expect(p.priorities).toEqual({ response: 20, error: 10 });
  });
});

// ── authInterceptor ──────────────────────────────────────────────────────────────────────────────

describe('authInterceptor', () => {
  it('rejects a missing auth with ConfigError', () => {
    expect(() => authInterceptor()).toThrow(ConfigError);
    expect(() => authInterceptor({ auth: {} })).toThrow(ConfigError);
    expect(() => authInterceptor({ auth: fakeAuth(), exclude: 'nope' })).toThrow(ConfigError);
  });

  it('attaches a bearer token and injects ctx.auth', async () => {
    const auth = fakeAuth();
    const b = authInterceptor({ auth });
    const spec = { method: 'GET', path: '/v1/trips' };
    const ctx = ctxFor(spec);
    const out = await b.request(spec, ctx);
    expect(out.headers.Authorization).toBe('Bearer acc-1');
    expect(ctx.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer acc-1');
    expect(ctx.auth.getToken()).toBe('acc-1');
    await ctx.auth.refresh();
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it('attaches X-Guest-Token for guests and nothing for anonymous callers', async () => {
    const guest = fakeAuth({
      getAccessToken: () => null,
      getGuestToken: () => 'g-1',
      isGuest: () => true,
    });
    const spec = { method: 'POST', path: '/v1/itineraries' };
    expect((await authInterceptor({ auth: guest }).request(spec, ctxFor(spec))).headers).toEqual({
      'X-Guest-Token': 'g-1',
    });
    const anon = fakeAuth({ getAccessToken: () => null });
    const s2 = { method: 'GET', path: '/v1/places' };
    expect((await authInterceptor({ auth: anon }).request(s2, ctxFor(s2))).headers).toBeUndefined();
    const stale = fakeAuth({
      getAccessToken: () => null,
      getGuestToken: () => 'g-old',
      isGuest: () => false,
    });
    const s3 = { method: 'GET', path: '/v1/places' };
    expect(
      (await authInterceptor({ auth: stale }).request(s3, ctxFor(s3))).headers
    ).toBeUndefined();
  });

  it('skips spec.auth === false, excluded paths and caller-supplied Authorization', async () => {
    const b = authInterceptor({ auth: fakeAuth(), exclude: [/\/auth\//] });
    const off = { method: 'GET', path: '/v1/x', auth: false };
    expect((await b.request(off, ctxFor(off))).headers).toBeUndefined();
    const excluded = { method: 'POST', path: '/auth/login' };
    expect((await b.request(excluded, ctxFor(excluded))).headers).toBeUndefined();
    const own = { method: 'GET', path: '/v1/x', headers: { authorization: 'Basic abc' } };
    expect((await b.request(own, ctxFor(own))).headers).toEqual({ authorization: 'Basic abc' });
  });

  it('on 401 refreshes once, swaps the stale bearer on ctx.spec, then retries; a second 401 passes through', async () => {
    const auth = rotatingAuth();
    const b = authInterceptor({ auth });
    const spec = { method: 'GET', path: '/v1/trips' };
    const ctx = ctxFor(spec);
    await b.request(spec, ctx);
    expect(spec.headers.Authorization).toBe('Bearer acc-1');
    const err = new AuthError('expired', { reason: 'expired' });
    let headerAtRetry;
    ctx.retry.mockImplementation(async () => {
      headerAtRetry = ctx.spec.headers.Authorization;
      return { data: 'retried', status: 200, attempts: 2 };
    });
    const res = await b.error(err, ctx);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.retry).toHaveBeenCalledTimes(1);
    // ctx.retry() re-enters at the cache / dedupe stage, so the fresh token must already be on the spec
    expect(headerAtRetry).toBe('Bearer acc-2');
    expect(ctx.setHeader).toHaveBeenLastCalledWith('Authorization', 'Bearer acc-2');
    expect(res).toEqual({ data: 'retried', status: 200, attempts: 2 });
    // the client mirrors ctx.meta into response.meta (which the cache persists): no token in there
    expect([...ctx.meta.values()].join(' ')).not.toMatch(/acc-/);
    ctx.attempt = 2;
    expect(await b.error(err, ctx)).toBeUndefined();
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.retry).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between concurrent 401s and ctx.auth.refresh(), then releases it', async () => {
    let release;
    const auth = rotatingAuth();
    auth.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            auth.setToken('acc-2');
            resolve({ accessToken: 'acc-2' });
          };
        })
    );
    const b = authInterceptor({ auth });
    const specs = [1, 2, 3].map((i) => ({ method: 'GET', path: `/v1/r${i}` }));
    const ctxs = specs.map((s, i) => ctxFor(s, { id: `req_${i}` }));
    for (const [i, s] of specs.entries()) await b.request(s, ctxs[i]);
    const err = new AuthError('expired', { reason: 'expired' });
    const results = ctxs.map((c) => b.error(err, c));
    const extra = ctxs[0].auth.refresh();
    await Promise.resolve();
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([...results, extra]);
    for (const [i, c] of ctxs.entries()) {
      expect(c.retry).toHaveBeenCalledTimes(1);
      expect(specs[i].headers.Authorization).toBe('Bearer acc-2');
    }
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    // once settled the shared refresh is released: a later 401 refreshes again
    const late = { method: 'GET', path: '/v1/late' };
    const lctx = ctxFor(late);
    await b.request(late, lctx);
    auth.refresh.mockImplementation(async () => ({ accessToken: 'acc-3' }));
    await b.error(err, lctx);
    expect(auth.refresh).toHaveBeenCalledTimes(2);
  });

  it('retries without refreshing when the credentials already changed since the request was sent', async () => {
    const auth = rotatingAuth();
    const b = authInterceptor({ auth });
    const spec = { method: 'GET', path: '/v1/trips' };
    const ctx = ctxFor(spec);
    await b.request(spec, ctx);
    auth.setToken('acc-9'); // another request refreshed meanwhile
    await b.error(new AuthError('expired', { reason: 'expired' }), ctx);
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(ctx.retry).toHaveBeenCalledTimes(1);
    expect(spec.headers.Authorization).toBe('Bearer acc-9');
    // an anonymous request meeting a 401 once a token exists is retried with it, no refresh
    const anon = rotatingAuth(null, 'acc-2');
    const b2 = authInterceptor({ auth: anon });
    const s2 = { method: 'GET', path: '/v1/me' };
    const c2 = ctxFor(s2);
    await b2.request(s2, c2);
    expect(s2.headers).toBeUndefined();
    anon.setToken('acc-2');
    await b2.error(new AuthError(), c2);
    expect(anon.refresh).not.toHaveBeenCalled();
    expect(s2.headers.Authorization).toBe('Bearer acc-2');
    expect(c2.retry).toHaveBeenCalledTimes(1);
  });

  it('leaves a 401 on caller-supplied credentials alone and drops a stale bearer when the refresh yields none', async () => {
    const auth = rotatingAuth();
    const b = authInterceptor({ auth });
    const own = { method: 'GET', path: '/v1/x', headers: { authorization: 'Basic abc' } };
    const octx = ctxFor(own);
    await b.request(own, octx);
    expect(await b.error(new AuthError(), octx)).toBeUndefined();
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(octx.retry).not.toHaveBeenCalled();
    // cookie mode: the refresh renews the cookie and leaves no bearer behind
    const cookie = rotatingAuth('acc-old', null);
    const b2 = authInterceptor({ auth: cookie });
    const spec = { method: 'GET', path: '/v1/x' };
    const ctx = ctxFor(spec);
    await b2.request(spec, ctx);
    expect(spec.headers.Authorization).toBe('Bearer acc-old');
    await b2.error(new AuthError('expired', { reason: 'expired' }), ctx);
    expect(cookie.refresh).toHaveBeenCalledTimes(1);
    expect(spec.headers.Authorization).toBeUndefined();
    expect(ctx.setHeader).toHaveBeenLastCalledWith('Authorization', undefined);
    expect(ctx.retry).toHaveBeenCalledTimes(1);
  });

  it('uses ctx.response.status when the error carries no status', async () => {
    const auth = rotatingAuth();
    const b = authInterceptor({ auth });
    const spec = { method: 'GET', path: '/v1/trips' };
    const ctx = ctxFor(spec, { response: { status: 401, headers: new Headers() } });
    await b.request(spec, ctx);
    await b.error(new Error('raw'), ctx);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(ctx.retry).toHaveBeenCalledTimes(1);
  });

  it('keeps caller headers given as a Headers instance when writing its own', async () => {
    const b = authInterceptor({ auth: fakeAuth() });
    const spec = { method: 'GET', path: '/v1/x', headers: new Headers({ 'X-Own': '1' }) };
    const out = await b.request(spec, ctxFor(spec));
    expect(out.headers).toEqual({ 'x-own': '1', Authorization: 'Bearer acc-1' });
  });

  it('leaves non-401 errors, excluded paths and auth:false requests alone', async () => {
    const auth = fakeAuth();
    const b = authInterceptor({ auth, exclude: ['/auth/'] });
    const forbidden = new AuthError('no', { reason: 'forbidden' });
    expect(await b.error(forbidden, ctxFor({ method: 'GET', path: '/v1/x' }))).toBeUndefined();
    expect(
      await b.error(new NetworkError(), ctxFor({ method: 'GET', path: '/v1/x' }))
    ).toBeUndefined();
    const unauth = new AuthError();
    expect(
      await b.error(unauth, ctxFor({ method: 'POST', path: '/auth/refresh' }))
    ).toBeUndefined();
    expect(
      await b.error(unauth, ctxFor({ method: 'GET', path: '/v1/x', auth: false }))
    ).toBeUndefined();
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('rethrows the original error when the refresh fails', async () => {
    const auth = fakeAuth({ refresh: vi.fn(async () => Promise.reject(new NetworkError('down'))) });
    const b = authInterceptor({ auth });
    const spec = { method: 'GET', path: '/v1/trips' };
    const ctx = ctxFor(spec);
    await b.request(spec, ctx);
    const original = new AuthError('expired', { reason: 'expired' });
    await expect(b.error(original, ctx)).rejects.toBe(original);
    expect(ctx.retry).not.toHaveBeenCalled();
    expect(spec.headers.Authorization).toBe('Bearer acc-1');
  });
});

// ── apiKeyInterceptor ────────────────────────────────────────────────────────────────────────────

describe('apiKeyInterceptor', () => {
  it('adds the key header (custom name) and keeps caller headers', async () => {
    expect(() => apiKeyInterceptor({})).toThrow(ConfigError);
    const spec = { method: 'GET', path: '/v1/x' };
    expect((await apiKeyInterceptor({ key: 'pk_1' }).request(spec, ctxFor(spec))).headers).toEqual({
      'X-Api-Key': 'pk_1',
    });
    const s2 = { method: 'GET', path: '/v1/x', headers: { 'x-partner': 'own' } };
    const out = await apiKeyInterceptor({ key: 'pk', header: 'X-Partner' }).request(s2, ctxFor(s2));
    expect(out.headers).toEqual({ 'x-partner': 'own' });
  });
});

// ── localeInterceptor ────────────────────────────────────────────────────────────────────────────

describe('localeInterceptor', () => {
  it('maps prefs to headers, reading the store on every request', async () => {
    expect(() => localeInterceptor({ store: {} })).toThrow(ConfigError);
    const prefs = { locale: 'en-IN', currency: 'INR', market: 'IN' };
    const store = { get: vi.fn((path) => prefs[path.split('.')[1]]) };
    const b = localeInterceptor({ store });
    const spec = { method: 'GET', path: '/v1/x' };
    expect((await b.request(spec, ctxFor(spec))).headers).toEqual({
      'Accept-Language': 'en-IN',
      'X-Currency': 'INR',
      'X-Market': 'IN',
    });
    prefs.currency = 'USD';
    delete prefs.market;
    const s2 = { method: 'GET', path: '/v1/x' };
    expect((await b.request(s2, ctxFor(s2))).headers).toEqual({
      'Accept-Language': 'en-IN',
      'X-Currency': 'USD',
    });
  });

  it('falls back to the whole prefs object and adds nothing when empty', async () => {
    const b = localeInterceptor({
      get: undefined,
      store: { get: (p) => (p === 'prefs' ? { locale: 'de-DE' } : undefined) },
    });
    const spec = { method: 'GET', path: '/v1/x' };
    expect((await b.request(spec, ctxFor(spec))).headers).toEqual({ 'Accept-Language': 'de-DE' });
    const empty = localeInterceptor({ store: { get: () => undefined } });
    const s2 = { method: 'GET', path: '/v1/x' };
    expect((await empty.request(s2, ctxFor(s2))).headers).toBeUndefined();
  });
});

// ── correlationInterceptor ───────────────────────────────────────────────────────────────────────

describe('correlationInterceptor', () => {
  it('adds X-Request-Id = ctx.id and a persisted per-tab X-Client-Session', async () => {
    const storage = memoryStore();
    const b = correlationInterceptor({ storage });
    const spec = { method: 'GET', path: '/v1/x' };
    const out = await b.request(spec, ctxFor(spec, { id: 'req_abc' }));
    expect(out.headers['X-Request-Id']).toBe('req_abc');
    const session = out.headers['X-Client-Session'];
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.set).toHaveBeenCalledWith('clientSession', session);
    const s2 = { method: 'GET', path: '/v1/y' };
    const out2 = await b.request(s2, ctxFor(s2, { id: 'req_def' }));
    expect(out2.headers['X-Client-Session']).toBe(session);
    expect(storage.set).toHaveBeenCalledTimes(1);
  });

  it('reuses a stored session, works without storage and generates an id without ctx.id', async () => {
    const storage = memoryStore();
    storage.map.set('clientSession', 'tab-1');
    const spec = { method: 'GET', path: '/v1/x' };
    const out = await correlationInterceptor({ storage }).request(spec, ctxFor(spec));
    expect(out.headers['X-Client-Session']).toBe('tab-1');
    const b = correlationInterceptor({ header: 'X-Corr', sessionHeader: 'X-Tab' });
    const s2 = { method: 'GET', path: '/v1/x' };
    const o2 = await b.request(s2, { meta: new Map() });
    expect(o2.headers['X-Corr']).toMatch(/^req_/);
    const s3 = { method: 'GET', path: '/v1/x' };
    const o3 = await b.request(s3, { meta: new Map() });
    expect(o3.headers['X-Tab']).toBe(o2.headers['X-Tab']);
  });

  it('echoes the server X-Request-Id (else ctx.id) into errors', () => {
    const b = correlationInterceptor();
    const err = new ApiError('boom', { status: 500 });
    const ctx = ctxFor(
      { method: 'GET', path: '/v1/x' },
      { response: { status: 500, headers: new Headers({ 'X-Request-Id': 'srv-9' }) } }
    );
    expect(b.error(err, ctx)).toBeUndefined();
    expect(err.requestId).toBe('srv-9');
    const e2 = new NetworkError('down');
    b.error(e2, ctxFor({ method: 'GET', path: '/v1/x' }, { id: 'req_z' }));
    expect(e2.requestId).toBe('req_z');
    expect(b.error('not an object', ctxFor({}))).toBeUndefined();
  });
});

// ── idempotencyInterceptor ───────────────────────────────────────────────────────────────────────

describe('idempotencyInterceptor', () => {
  it('skips safe methods and specs without idempotencyKey', async () => {
    const b = idempotencyInterceptor();
    const get = { method: 'GET', path: '/v1/x', idempotencyKey: true };
    expect((await b.request(get, ctxFor(get))).headers).toBeUndefined();
    const post = { method: 'POST', path: '/v1/x', body: { a: 1 } };
    expect((await b.request(post, ctxFor(post))).headers).toBeUndefined();
  });

  it('uses a string key as is and derives one from path + body for `true`', async () => {
    const b = idempotencyInterceptor();
    const s1 = { method: 'POST', path: '/v1/booking', idempotencyKey: 'k-123' };
    expect((await b.request(s1, ctxFor(s1))).headers).toEqual({ 'Idempotency-Key': 'k-123' });
    const body = { offerId: 'o1', travelers: [{ id: 't1' }] };
    const s2 = { method: 'POST', path: '/v1/booking', body, idempotencyKey: true };
    const ctx = ctxFor(s2);
    const out = await b.request(s2, ctx);
    expect(out.headers['Idempotency-Key']).toBe(idempotencyKey('/v1/booking', body));
    expect(ctx.meta.get('idempotency:key')).toBe(out.headers['Idempotency-Key']);
    // the query is part of the request identity: a different query is a different create
    const q = {
      method: 'POST',
      path: '/v1/booking',
      query: { dry: 1 },
      body,
      idempotencyKey: true,
    };
    expect((await b.request(q, ctxFor(q))).headers['Idempotency-Key']).toBe(
      idempotencyKey('/v1/booking?dry=1', body)
    );
    const s3 = {
      method: 'POST',
      path: '/v1/booking',
      body: { travelers: [{ id: 't1' }], offerId: 'o1' },
      idempotencyKey: true,
    };
    expect((await b.request(s3, ctxFor(s3))).headers['Idempotency-Key']).toBe(
      out.headers['Idempotency-Key']
    );
    const s4 = {
      method: 'POST',
      path: '/v1/booking',
      body: { offerId: 'o2' },
      idempotencyKey: true,
    };
    expect((await b.request(s4, ctxFor(s4))).headers['Idempotency-Key']).not.toBe(
      out.headers['Idempotency-Key']
    );
  });

  it('respects a custom header name and an existing header', async () => {
    const b = idempotencyInterceptor({ header: 'X-Idem' });
    const s1 = { method: 'PUT', path: '/v1/x', idempotencyKey: 'a' };
    expect((await b.request(s1, ctxFor(s1))).headers).toEqual({ 'X-Idem': 'a' });
    const s2 = {
      method: 'PATCH',
      path: '/v1/x',
      idempotencyKey: 'b',
      headers: { 'x-idem': 'own' },
    };
    expect((await b.request(s2, ctxFor(s2))).headers).toEqual({ 'x-idem': 'own' });
  });
});

// ── envelopeInterceptor ──────────────────────────────────────────────────────────────────────────

describe('envelopeInterceptor', () => {
  it('unwraps { data, meta, dictionaries } once and keeps the raw envelope', () => {
    const b = envelopeInterceptor();
    const body = {
      data: [{ id: '1' }],
      meta: { count: 1 },
      dictionaries: { carriers: { AI: 'Air India' } },
    };
    const res = { data: body, status: 200, headers: new Headers() };
    const ctx = ctxFor({ method: 'GET', path: '/v2/shopping/flight-offers' });
    const out = b.response(res, ctx);
    // mutated in place, nothing returned: the client keeps this very object (and its `raw`)
    expect(out).toBeUndefined();
    expect(res.data).toEqual([{ id: '1' }]);
    expect(res.meta).toEqual({ count: 1, dictionaries: { carriers: { AI: 'Air India' } } });
    expect(res.raw).toBe(body);
    // a second pass on the same response object (data that happens to carry a `data` key) is a no-op
    res.data = { data: 'inner' };
    b.response(res, ctx);
    expect(res.data).toEqual({ data: 'inner' });
    // a retry's response is a new object on the same ctx and is unwrapped as well
    ctx.attempt = 2;
    const retried = { data: { data: { id: '2' }, meta: { count: 1 } }, status: 200 };
    b.response(retried, ctx);
    expect(retried.data).toEqual({ id: '2' });
    expect(retried.meta).toEqual({ count: 1 });
  });

  it('leaves bodies without a data key alone and supports custom keys', () => {
    const b = envelopeInterceptor();
    const plain = { data: { id: '1', items: [] }, status: 200 };
    b.response(plain, ctxFor({}));
    expect(plain.data).toEqual({ id: '1', items: [] });
    expect(plain.meta).toBeUndefined();
    const list = { data: [1, 2], status: 200 };
    b.response(list, ctxFor({}));
    expect(list.data).toEqual([1, 2]);
    const custom = envelopeInterceptor({
      dataKey: 'result',
      metaKey: 'page',
      dictionariesKey: 'dict',
    });
    const res = {
      data: { result: { ok: true }, page: { cursor: 'c' } },
      status: 200,
      meta: { x: 1 },
    };
    custom.response(res, ctxFor({}));
    expect(res.data).toEqual({ ok: true });
    expect(res.meta).toEqual({ x: 1, cursor: 'c' });
    expect(b.response(null, ctxFor({}))).toBeUndefined();
  });
});

// ── problemInterceptor ───────────────────────────────────────────────────────────────────────────

describe('problemInterceptor', () => {
  it('rejects a non-object map', () => {
    expect(() => problemInterceptor({ map: 'x' })).toThrow(ConfigError);
  });

  it('maps a problem+json failure to the right SdkError subclass', () => {
    const b = problemInterceptor();
    const problem = {
      type: 'https://api.ota.com/problems/offer-expired',
      title: 'Offer expired',
      status: 410,
      detail: 'The offer is no longer available',
    };
    const ctx = ctxFor(
      { method: 'POST', path: '/v1/shopping/flight-offers/pricing' },
      { response: problemResponse(410, problem), data: problem }
    );
    const out = b.error(new ApiError('raw', { status: 410 }), ctx);
    expect(out).toBeInstanceOf(OfferExpiredError);
    expect(out.problem).toMatchObject(problem);
    expect(out.requestId).toBe('req_1');
    expect(out.message).toBe('The offer is no longer available');
  });

  it('maps by status without a body, reads error.problem and honours `map`', () => {
    const b = problemInterceptor();
    const ctx = ctxFor(
      { method: 'GET', path: '/v1/x' },
      { response: { status: 401, headers: {} } }
    );
    expect(b.error(new Error('plain with response'), ctx)).toBeInstanceOf(AuthError);
    const carried = new ApiError('x', {
      status: 404,
      problem: { type: 'about:blank', title: 'Nope', status: 404 },
    });
    expect(b.error(carried, ctxFor({ method: 'GET', path: '/v1/x' }))).toBeInstanceOf(
      NotFoundError
    );
    class TeapotError extends ApiError {}
    const mapped = problemInterceptor({ map: { TEAPOT: TeapotError } });
    const ctx2 = ctxFor({}, { data: { code: 'TEAPOT', status: 418, title: 'short and stout' } });
    expect(mapped.error(new ApiError('x', { status: 418 }), ctx2)).toBeInstanceOf(TeapotError);
  });

  it('leaves non-API errors and already specific errors alone', () => {
    const b = problemInterceptor();
    const ctx = ctxFor({ method: 'GET', path: '/v1/x' });
    for (const err of [
      new NetworkError('offline'),
      new ValidationError('bad'),
      new Error('plain'),
      new NotFoundError('already mapped'),
      new RateLimitError('already mapped'),
      'string',
      undefined,
    ]) {
      expect(b.error(err, ctx)).toBeUndefined();
    }
    const ok = new ApiError('fine', { status: 200 });
    expect(b.error(ok, ctx)).toBeUndefined();
  });

  it('prefers the error’s own problem over stale ctx.data, honours map for mapped codes and the server id', () => {
    const b = problemInterceptor();
    // attempt 1 answered 2xx (left in ctx.data), attempt 2 failed with its own problem document
    const problem = { type: 'about:blank', title: 'Gone', status: 410, code: 'OFFER_EXPIRED' };
    const ctx = ctxFor(
      { method: 'POST', path: '/v1/x' },
      {
        attempt: 2,
        data: { data: [{ id: 'old' }] },
        response: { status: 410, headers: new Headers({ 'x-request-id': 'srv-7' }) },
      }
    );
    const out = b.error(new ApiError('raw', { status: 410, problem }), ctx);
    expect(out).toBeInstanceOf(OfferExpiredError);
    expect(out.problem).toMatchObject(problem);
    expect(out.requestId).toBe('srv-7');
    // an already specific error is left alone…
    expect(b.error(new NotFoundError('mapped'), ctx)).toBeUndefined();
    // …unless `map` names its code: the host's class wins, once
    class MyNotFound extends ApiError {
      constructor(message, options) {
        super(message, options);
        this.name = 'MyNotFound';
      }
    }
    const mapped = problemInterceptor({ map: { NOT_FOUND: MyNotFound } });
    const re = mapped.error(new NotFoundError('nope'), ctxFor({}));
    expect(re).toBeInstanceOf(MyNotFound);
    expect(re.status).toBe(404);
    expect(mapped.error(re, ctxFor({}))).toBeUndefined();
  });

  it('throws for 4xx responses or problem+json bodies at the response stage, passes 2xx', () => {
    const b = problemInterceptor();
    const ctx = ctxFor({ method: 'GET', path: '/v1/x' });
    const good = { status: 200, headers: new Headers(), data: { ok: true } };
    expect(b.response(good, ctx)).toBeUndefined();
    expect(() =>
      b.response({ status: 429, headers: new Headers({ 'retry-after': '3' }), data: '' }, ctx)
    ).toThrow(RateLimitError);
    expect(() =>
      b.response(
        {
          status: 200,
          headers: new Headers({ 'content-type': 'application/problem+json' }),
          data: { type: 'about:blank', title: 'Not found', status: 404 },
        },
        ctx
      )
    ).toThrow(NotFoundError);
  });
});

// ── rateLimitInterceptor ─────────────────────────────────────────────────────────────────────────

describe('rateLimitInterceptor', () => {
  it('validates options', () => {
    expect(() => rateLimitInterceptor({ maxWaitMs: -1 })).toThrow(ConfigError);
    expect(() => rateLimitInterceptor({ maxRetries: 'x' })).toThrow(ConfigError);
  });

  it('asks the client for a delayed retry (Retry-After → ctx.retry({ delayMs })), maxRetries times per request', async () => {
    const b = rateLimitInterceptor();
    const spec = { method: 'GET', path: '/v1/x' };
    const ctx = ctxFor(spec);
    const err = new RateLimitError('slow down', { retryAfterMs: 2000 });
    await expect(b.error(err, ctx)).resolves.toEqual({ data: 'retried', status: 200, attempts: 2 });
    expect(ctx.retry).toHaveBeenCalledTimes(1);
    expect(ctx.retry).toHaveBeenCalledWith({ delayMs: 2000 });
    expect(ctx.meta.get('rateLimit:retries')).toBe(1);
    expect(await b.error(err, ctx)).toBeUndefined();
    expect(ctx.retry).toHaveBeenCalledTimes(1);
    const twice = rateLimitInterceptor({ maxRetries: 2 });
    const c2 = ctxFor({ method: 'GET', path: '/v1/x' });
    await twice.error(err, c2);
    await twice.error(err, c2);
    expect(await twice.error(err, c2)).toBeUndefined();
    expect(c2.retry).toHaveBeenCalledTimes(2);
  });

  it('caps the delay at maxWaitMs, reads Retry-After as seconds or an HTTP date, falls back to defaultWaitMs', async () => {
    const b = rateLimitInterceptor({ maxWaitMs: 500, defaultWaitMs: 100 });
    const ctx = ctxFor(
      { method: 'GET', path: '/v1/x' },
      { response: { status: 429, headers: new Headers({ 'Retry-After': '60' }) } }
    );
    await expect(b.error(new Error('raw 429'), ctx)).resolves.toBeDefined();
    expect(ctx.retry).toHaveBeenCalledWith({ delayMs: 500 });
    const ctx2 = ctxFor({ method: 'GET', path: '/v1/x' });
    await b.error(new RateLimitError('no header'), ctx2);
    expect(ctx2.retry).toHaveBeenCalledWith({ delayMs: 100 });
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const dated = rateLimitInterceptor({ now: () => now });
    const ctx3 = ctxFor(
      { method: 'GET', path: '/v1/x' },
      {
        response: {
          status: 429,
          headers: new Headers({ 'Retry-After': new Date(now + 3000).toUTCString() }),
        },
      }
    );
    await dated.error(new RateLimitError('dated'), ctx3);
    expect(ctx3.retry).toHaveBeenCalledWith({ delayMs: 3000 });
    const ctx4 = ctxFor({});
    await dated.error(new RateLimitError('meta', { meta: { retryAfterMs: 250 } }), ctx4);
    expect(ctx4.retry).toHaveBeenCalledWith({ delayMs: 250 });
  });

  it('leaves other errors alone, never waits on a timer of its own and surfaces the client’s abort', async () => {
    vi.useFakeTimers();
    const b = rateLimitInterceptor();
    expect(await b.error(new NetworkError(), ctxFor({}))).toBeUndefined();
    expect(await b.error(new ApiError('x', { status: 500 }), ctxFor({}))).toBeUndefined();
    const noRetry = ctxFor({});
    delete noRetry.retry;
    expect(await b.error(new RateLimitError(), noRetry)).toBeUndefined();
    const ctx = ctxFor({ method: 'GET', path: '/v1/x' });
    const p = b.error(new RateLimitError('x', { retryAfterMs: 5000 }), ctx);
    expect(vi.getTimerCount()).toBe(0); // the wait belongs to the client (ctx.retry), not to us
    await expect(p).resolves.toBeDefined();
    // the client rejects ctx.retry() with AbortError when the request aborts during its wait
    const aborted = ctxFor({ method: 'GET', path: '/v1/x' });
    aborted.retry = vi.fn(async () => {
      throw new AbortError('Request aborted', { reason: 'aborted' });
    });
    await expect(b.error(new RateLimitError(), aborted)).rejects.toBeInstanceOf(AbortError);
  });
});

// ── cacheInterceptor ─────────────────────────────────────────────────────────────────────────────

describe('cacheInterceptor', () => {
  it('validates options', () => {
    expect(() => cacheInterceptor({ storage: {} })).toThrow(ConfigError);
    expect(() => cacheInterceptor({ defaultTtlMs: 0 })).toThrow(ConfigError);
    expect(() => cacheInterceptor({ methods: 'GET' })).toThrow(ConfigError);
  });

  it('stores a 2xx response under method+url+locale+currency and serves it until the TTL ends', async () => {
    let t = 10_000;
    const storage = memoryStore();
    const b = cacheInterceptor({ storage, now: () => t });
    const spec = {
      method: 'GET',
      path: '/v1/places',
      query: { q: 'DEL' },
      headers: { 'Accept-Language': 'en-IN', 'X-Currency': 'INR' },
      cache: { ttlMs: 1000 },
    };
    const ctx = ctxFor(spec);
    expect(await b.request(spec, ctx)).toBe(spec);
    const key = ctx.meta.get('cache:key');
    expect(key).toBe('cache:GET /v1/places?q=DEL|en-IN|INR');
    const res = {
      data: [{ code: 'DEL' }],
      status: 200,
      headers: new Headers({ etag: 'v1' }),
      // as the client builds it: the interceptors' ctx.meta bookkeeping is mirrored into meta
      meta: { count: 1, 'cache:key': key, 'dedupe:key': 'GET /v1/places?q=DEL|en-IN|INR' },
      fromCache: false,
      attempts: 1,
      durationMs: 12,
    };
    expect(b.response(res, ctx)).toBeUndefined();
    expect(storage.set).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ data: [{ code: 'DEL' }], status: 200, expiresAt: 11_000 }),
      { ttlMs: 1000 }
    );
    // only the response's own meta is persisted, never the bookkeeping keys
    expect(storage.map.get(key).meta).toEqual({ count: 1 });

    t = 10_500;
    const again = { ...spec, headers: { ...spec.headers } };
    const ctx2 = ctxFor(again, { id: 'req_2', attempt: 1 });
    const hit = await b.request(again, ctx2);
    expect(hit).toMatchObject({
      data: [{ code: 'DEL' }],
      status: 200,
      fromCache: true,
      requestId: 'req_2',
      attempts: 1,
      meta: { count: 1 },
    });
    expect(hit.headers.get('etag')).toBe('v1');
    // a cached response is never re-stored
    b.response(hit, ctx2);
    expect(storage.set).toHaveBeenCalledTimes(1);

    t = 11_000;
    const ctx3 = ctxFor(again);
    expect(await b.request(again, ctx3)).toBe(again);
    expect(storage.remove).toHaveBeenCalledWith(key);
  });

  it('keys differ by locale / currency and the key option, and skips uncacheable requests', async () => {
    const storage = memoryStore();
    const b = cacheInterceptor({ storage, defaultTtlMs: 5000 });
    const en = { method: 'GET', path: '/v1/x', headers: { 'accept-language': 'en' }, cache: true };
    const de = { method: 'GET', path: '/v1/x', headers: { 'accept-language': 'de' }, cache: true };
    const c1 = ctxFor(en);
    const c2 = ctxFor(de);
    await b.request(en, c1);
    await b.request(de, c2);
    expect(c1.meta.get('cache:key')).not.toBe(c2.meta.get('cache:key'));
    b.response({ data: 'EN', status: 200, headers: {} }, c1);
    expect(await b.request(de, ctxFor(de))).toBe(de);
    expect((await b.request(en, ctxFor(en))).data).toBe('EN');

    const custom = { method: 'GET', path: '/v1/x', cache: { ttlMs: 10, key: 'places:DEL' } };
    const c3 = ctxFor(custom);
    await b.request(custom, c3);
    expect(c3.meta.get('cache:key')).toBe('cache:places:DEL||');

    for (const spec of [
      { method: 'GET', path: '/v1/x' },
      { method: 'GET', path: '/v1/x', cache: false },
      { method: 'POST', path: '/v1/x', cache: { ttlMs: 10 } },
    ]) {
      const ctx = ctxFor(spec);
      expect(await b.request(spec, ctx)).toBe(spec);
      expect(ctx.meta.has('cache:key')).toBe(false);
    }
    // without a cache key nothing is stored; non-2xx are not stored either; no ttl → not stored
    b.response({ data: 1, status: 200 }, ctxFor({}));
    const err = ctxFor({ method: 'GET', path: '/v1/e', cache: { ttlMs: 10 } });
    await b.request(err.spec, err);
    b.response({ data: 1, status: 404 }, err);
    const noTtl = cacheInterceptor({ storage });
    const nt = ctxFor({ method: 'GET', path: '/v1/n', cache: true });
    await noTtl.request(nt.spec, nt);
    noTtl.response({ data: 1, status: 200 }, nt);
    expect(storage.map.size).toBe(1);
  });

  it('falls back to memory and exposes key / invalidate / clear', async () => {
    const b = cacheInterceptor({ defaultTtlMs: 1000 });
    const a = { method: 'GET', path: '/v1/a', cache: true };
    const c = { method: 'GET', path: '/v1/c', cache: true };
    for (const spec of [a, c]) {
      const ctx = ctxFor(spec);
      await b.request(spec, ctx);
      b.response({ data: spec.path, status: 200 }, ctx);
    }
    expect((await b.request({ ...a }, ctxFor({ ...a }))).fromCache).toBe(true);
    expect(b.key(a)).toBe('cache:GET /v1/a||');
    b.invalidate('GET /v1/a||');
    expect(await b.request({ ...a }, ctxFor({ ...a }))).toEqual({ ...a });
    expect((await b.request({ ...c }, ctxFor({ ...c }))).fromCache).toBe(true);
    b.clear(/\/v1\/zzz/);
    expect((await b.request({ ...c }, ctxFor({ ...c }))).fromCache).toBe(true);
    b.clear('/v1/c');
    expect(await b.request({ ...c }, ctxFor({ ...c }))).toEqual({ ...c });
    const ctx = ctxFor(a);
    await b.request(a, ctx);
    b.response({ data: 'again', status: 200 }, ctx);
    b.clear();
    expect(await b.request({ ...a }, ctxFor({ ...a }))).toEqual({ ...a });
  });

  it('keys cacheable non-GET requests by body and skips bodies without a stable text', async () => {
    const storage = memoryStore();
    const b = cacheInterceptor({ storage, defaultTtlMs: 1000, methods: ['POST'] });
    const a = { method: 'POST', path: '/v1/search', body: { from: 'DEL', to: 'BOM' }, cache: true };
    const same = {
      method: 'POST',
      path: '/v1/search',
      body: { to: 'BOM', from: 'DEL' },
      cache: true,
    };
    const other = {
      method: 'POST',
      path: '/v1/search',
      body: { from: 'DEL', to: 'GOI' },
      cache: true,
    };
    const ctx = ctxFor(a);
    await b.request(a, ctx);
    expect(ctx.meta.get('cache:key')).toBe('cache:POST /v1/search|||{"from":"DEL","to":"BOM"}');
    b.response({ data: 'DEL-BOM', status: 200 }, ctx);
    expect((await b.request(same, ctxFor(same))).data).toBe('DEL-BOM');
    expect(await b.request(other, ctxFor(other))).toBe(other);
    const binary = { method: 'POST', path: '/v1/search', body: new Blob(['x']), cache: true };
    const bctx = ctxFor(binary);
    expect(await b.request(binary, bctx)).toBe(binary);
    expect(bctx.meta.has('cache:key')).toBe(false);
    expect(b.key(binary)).toBeUndefined();
    const custom = { method: 'POST', path: '/v1/s', body: { a: 1 }, cache: { ttlMs: 1, key: 'k' } };
    expect(b.key(custom)).toBe('cache:k|||{"a":1}');
  });
});

// ── dedupeInterceptor ────────────────────────────────────────────────────────────────────────────

describe('dedupeInterceptor', () => {
  it('shares the leader response with identical in-flight GETs and releases the key', async () => {
    const b = dedupeInterceptor();
    const leader = { method: 'GET', path: '/v1/x', query: { a: 1 } };
    const follower = { method: 'get', path: '/v1/x', query: { a: 1 } };
    const lctx = ctxFor(leader, { id: 'req_l' });
    const fctx = ctxFor(follower, { id: 'req_f' });
    expect(await b.request(leader, lctx)).toBe(leader);
    expect(b.inflight()).toBe(1);
    const shared = b.request(follower, fctx);
    expect(shared).toBeInstanceOf(Promise);
    expect(fctx.meta.get('dedupe:follower')).toBe('GET /v1/x?a=1||');
    const res = {
      data: { ok: true },
      status: 200,
      headers: new Headers({ etag: 'v1' }),
      fromCache: false,
    };
    expect(b.response(res, lctx)).toBeUndefined();
    const got = await shared;
    expect(got).toMatchObject({ data: { ok: true }, status: 200, fromCache: false, deduped: true });
    // the follower owns its headers (they are mutable); `data` is shared by design
    expect(got.headers).not.toBe(res.headers);
    expect(got.headers.get('etag')).toBe('v1');
    expect(got.data).toBe(res.data);
    expect(b.inflight()).toBe(0);
    // after settling, a new identical request is a fresh leader
    const next = { method: 'GET', path: '/v1/x', query: { a: 1 } };
    expect(await b.request(next, ctxFor(next, { id: 'req_n' }))).toBe(next);
    expect(b.inflight()).toBe(1);
  });

  it('rejects followers only with a final leader error; a retryable one releases them to their own request', async () => {
    const b = dedupeInterceptor();
    // retryable failure with retry budget left: not the outcome → followers resume with their own spec
    const leader = { method: 'GET', path: '/v1/y', retries: 2 };
    const lctx = ctxFor(leader, { id: 'req_l' });
    await b.request(leader, lctx);
    const fspec = { method: 'GET', path: '/v1/y' };
    const shared = b.request(fspec, ctxFor(fspec, { id: 'req_f' }));
    // the leader re-enters the request stage on a retry: it stays the leader
    lctx.attempt = 2;
    expect(await b.request(leader, lctx)).toBe(leader);
    expect(b.inflight()).toBe(1);
    expect(b.error(new NetworkError('blip'), lctx)).toBeUndefined();
    expect(await shared).toBe(fspec);
    expect(b.inflight()).toBe(0);
    // retry budget exhausted: the same retryable error is final
    const l2 = { method: 'GET', path: '/v1/z', retries: 2 };
    const c2 = ctxFor(l2, { id: 'req_l2', attempt: 3 });
    await b.request(l2, c2);
    const f2 = b.request({ method: 'GET', path: '/v1/z' }, ctxFor({}, { id: 'req_f2' }));
    const exp2 = expect(f2).rejects.toBeInstanceOf(NetworkError);
    b.error(new NetworkError('down for good'), c2);
    await exp2;
    // a non-retryable error is final whatever the attempt
    const l3 = { method: 'GET', path: '/v1/w' };
    const c3 = ctxFor(l3, { id: 'req_l3' });
    await b.request(l3, c3);
    const f3 = b.request({ method: 'GET', path: '/v1/w' }, ctxFor({}, { id: 'req_f3' }));
    const exp3 = expect(f3).rejects.toBeInstanceOf(NotFoundError);
    b.error(new NotFoundError('gone'), c3);
    await exp3;
    // the leader's own abort is not the followers' problem: they are released
    const l4 = { method: 'GET', path: '/v1/v' };
    const c4 = ctxFor(l4, { id: 'req_l4' });
    await b.request(l4, c4);
    const s4 = { method: 'GET', path: '/v1/v' };
    const f4 = b.request(s4, ctxFor(s4, { id: 'req_f4' }));
    b.error(new AbortError('cancelled'), c4);
    expect(await f4).toBe(s4);
    expect(b.inflight()).toBe(0);
    // settling from a ctx that is not the owner is ignored
    const other = { method: 'GET', path: '/v1/o' };
    const octx = ctxFor(other, { id: 'req_o' });
    await b.request(other, octx);
    const stranger = ctxFor(other, { id: 'req_s' });
    stranger.meta.set('dedupe:key', 'GET /v1/o||');
    b.response({ data: 1, status: 200 }, stranger);
    expect(b.inflight()).toBe(1);
  });

  it('lets a waiting follower abort on its own signal without touching the leader', async () => {
    const b = dedupeInterceptor();
    const leader = { method: 'GET', path: '/v1/slow' };
    const lctx = ctxFor(leader, { id: 'req_l' });
    await b.request(leader, lctx);
    const ac = new AbortController();
    const fspec = { method: 'GET', path: '/v1/slow' };
    const waiting = b.request(fspec, ctxFor(fspec, { id: 'req_f', signal: ac.signal }));
    const expectation = expect(waiting).rejects.toBeInstanceOf(AbortError);
    ac.abort();
    await expectation;
    expect(b.inflight()).toBe(1);
    // the leader still completes and serves the next follower
    const next = b.request({ method: 'GET', path: '/v1/slow' }, ctxFor({}, { id: 'req_n' }));
    b.response({ data: 'late', status: 200, headers: {} }, lctx);
    expect((await next).data).toBe('late');
    // an already aborted follower rejects at once
    await b.request({ method: 'GET', path: '/v1/again' }, ctxFor({}, { id: 'req_l2' }));
    const already = ctxFor(fspec, { id: 'req_a', signal: AbortSignal.abort() });
    await expect(b.request({ method: 'GET', path: '/v1/again' }, already)).rejects.toBeInstanceOf(
      AbortError
    );
  });

  it('dedupes non-GET requests only on dedupe: true, keyed by body; unkeyable bodies pass through', async () => {
    const b = dedupeInterceptor();
    const post = { method: 'POST', path: '/v1/search', body: { q: 1 }, dedupe: true };
    const pctx = ctxFor(post, { id: 'req_p' });
    expect(await b.request(post, pctx)).toBe(post);
    expect(pctx.meta.get('dedupe:key')).toBe('POST /v1/search|||{"q":1}');
    const same = { method: 'POST', path: '/v1/search', body: { q: 1 }, dedupe: true };
    const shared = b.request(same, ctxFor(same, { id: 'req_s' }));
    const other = { method: 'POST', path: '/v1/search', body: { q: 2 }, dedupe: true };
    expect(await b.request(other, ctxFor(other, { id: 'req_o' }))).toBe(other);
    expect(b.inflight()).toBe(2);
    b.response({ data: 'one', status: 200, headers: {} }, pctx);
    expect((await shared).data).toBe('one');
    const form = { method: 'POST', path: '/v1/upload', body: new FormData(), dedupe: true };
    const fctx = ctxFor(form, { id: 'req_u' });
    expect(await b.request(form, fctx)).toBe(form);
    expect(fctx.meta.has('dedupe:key')).toBe(false);
  });

  it('skips non-GET requests, dedupe:false and distinct keys', async () => {
    const b = dedupeInterceptor();
    expect(() => dedupeInterceptor({ methods: 'GET' })).toThrow(ConfigError);
    const post = { method: 'POST', path: '/v1/x' };
    expect(await b.request(post, ctxFor(post))).toBe(post);
    const off = { method: 'GET', path: '/v1/x', dedupe: false };
    expect(await b.request(off, ctxFor(off))).toBe(off);
    expect(b.inflight()).toBe(0);
    const en = { method: 'GET', path: '/v1/x', headers: { 'Accept-Language': 'en' } };
    const de = { method: 'GET', path: '/v1/x', headers: { 'Accept-Language': 'de' } };
    expect(await b.request(en, ctxFor(en))).toBe(en);
    expect(await b.request(de, ctxFor(de))).toBe(de);
    expect(b.inflight()).toBe(2);
  });
});

// ── csrfInterceptor ──────────────────────────────────────────────────────────────────────────────

describe('csrfInterceptor', () => {
  it('copies the cookie into the header (read at call time) and includes credentials', async () => {
    expect(() => csrfInterceptor({})).toThrow(ConfigError);
    const b = csrfInterceptor({ cookieName: 'XSRF-TOKEN' });
    const ssr = { method: 'POST', path: '/v1/x' };
    expect(await b.request(ssr, ctxFor(ssr))).toMatchObject({ credentials: 'include' });
    expect(ssr.headers).toBeUndefined();
    vi.stubGlobal('document', { cookie: 'a=1; XSRF-TOKEN=tok%20en; b=2' });
    const spec = { method: 'POST', path: '/v1/x' };
    const out = await b.request(spec, ctxFor(spec));
    expect(out.headers).toEqual({ 'X-CSRF-Token': 'tok en' });
    expect(out.credentials).toBe('include');
    const own = { method: 'POST', path: '/v1/x', credentials: 'omit' };
    expect((await b.request(own, ctxFor(own))).credentials).toBe('omit');
    const custom = csrfInterceptor({ cookieName: 'b', header: 'X-B' });
    const s2 = { method: 'GET', path: '/v1/x' };
    expect((await custom.request(s2, ctxFor(s2))).headers).toEqual({ 'X-B': '2' });
  });
});

// ── deviceInterceptor ────────────────────────────────────────────────────────────────────────────

describe('deviceInterceptor', () => {
  it('adds X-Device-Id from a sync or async host function and persists it', async () => {
    expect(() => deviceInterceptor({})).toThrow(ConfigError);
    const storage = memoryStore();
    const getDeviceId = vi.fn(async () => 'dev-1');
    const b = deviceInterceptor({ getDeviceId, storage });
    const spec = { method: 'GET', path: '/v1/x' };
    expect((await b.request(spec, ctxFor(spec))).headers).toEqual({ 'X-Device-Id': 'dev-1' });
    expect(storage.set).toHaveBeenCalledWith('deviceId', 'dev-1');
    const s2 = { method: 'GET', path: '/v1/y' };
    await b.request(s2, ctxFor(s2));
    expect(getDeviceId).toHaveBeenCalledTimes(1);
    const sync = deviceInterceptor({ getDeviceId: () => 'dev-sync', header: 'X-Dev' });
    const s3 = { method: 'GET', path: '/v1/z' };
    expect((await sync.request(s3, ctxFor(s3))).headers).toEqual({ 'X-Dev': 'dev-sync' });
  });

  it('reuses a stored id and tolerates a failing or empty host function', async () => {
    const storage = memoryStore();
    storage.map.set('deviceId', 'stored-1');
    const getDeviceId = vi.fn(() => 'fresh');
    const b = deviceInterceptor({ getDeviceId, storage });
    const spec = { method: 'GET', path: '/v1/x' };
    expect((await b.request(spec, ctxFor(spec))).headers).toEqual({ 'X-Device-Id': 'stored-1' });
    expect(getDeviceId).not.toHaveBeenCalled();
    const failing = deviceInterceptor({
      getDeviceId: () => {
        throw new Error('no fingerprint');
      },
    });
    const s2 = { method: 'GET', path: '/v1/x' };
    expect((await failing.request(s2, ctxFor(s2))).headers).toBeUndefined();
    let ready = false;
    const lazy = vi.fn(() => (ready ? 'late' : undefined));
    const b2 = deviceInterceptor({ getDeviceId: lazy });
    const s3 = { method: 'GET', path: '/v1/x' };
    expect((await b2.request(s3, ctxFor(s3))).headers).toBeUndefined();
    ready = true;
    const s4 = { method: 'GET', path: '/v1/x' };
    expect((await b2.request(s4, ctxFor(s4))).headers).toEqual({ 'X-Device-Id': 'late' });
    expect(lazy).toHaveBeenCalledTimes(2);
  });

  it('asks the host once for concurrent first requests', async () => {
    let release;
    const getDeviceId = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve('dev-1');
        })
    );
    const storage = memoryStore();
    const b = deviceInterceptor({ getDeviceId, storage });
    const specs = [1, 2, 3].map((i) => ({ method: 'GET', path: `/v1/${i}` }));
    const pending = specs.map((s) => b.request(s, ctxFor(s)));
    expect(getDeviceId).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(pending);
    for (const s of specs) expect(s.headers).toEqual({ 'X-Device-Id': 'dev-1' });
    expect(storage.set).toHaveBeenCalledTimes(1);
    const s5 = { method: 'GET', path: '/v1/5' };
    await b.request(s5, ctxFor(s5));
    expect(getDeviceId).toHaveBeenCalledTimes(1);
  });
});

// ── telemetryInterceptor ─────────────────────────────────────────────────────────────────────────

describe('telemetryInterceptor', () => {
  it('tracks http_request for responses and errors', async () => {
    expect(() => telemetryInterceptor({ telemetry: {} })).toThrow(ConfigError);
    const telemetry = { track: vi.fn() };
    let t = 1000;
    const b = telemetryInterceptor({ telemetry, now: () => t });
    const spec = { method: 'post', url: 'https://api.ota.com/v1/booking/flight-orders?x=1' };
    const ctx = ctxFor(spec);
    expect(await b.request(spec, ctx)).toBe(spec);
    t = 1250;
    expect(b.response({ status: 201, data: {}, fromCache: false }, ctx)).toBeUndefined();
    expect(telemetry.track).toHaveBeenCalledWith('http_request', {
      path: '/v1/booking/flight-orders',
      method: 'POST',
      status: 201,
      durationMs: 250,
      ok: true,
      attempts: 1,
      fromCache: false,
    });
    const err = new RateLimitError('slow');
    ctx.attempt = 2;
    t = 1300;
    expect(b.error(err, ctx)).toBeUndefined();
    expect(telemetry.track).toHaveBeenLastCalledWith('http_request', {
      path: '/v1/booking/flight-orders',
      method: 'POST',
      status: 429,
      durationMs: 300,
      ok: false,
      code: 'RATE_LIMITED',
      attempts: 2,
    });
  });

  it('prefers the response durationMs, survives a throwing tracker and a bare ctx', () => {
    const telemetry = {
      track: vi.fn(() => {
        throw new Error('sink down');
      }),
    };
    const b = telemetryInterceptor({ telemetry, event: 'api_call' });
    const ctx = ctxFor({ method: 'GET', path: '/v1/x' });
    expect(() => b.response({ status: 200, durationMs: 42 }, ctx)).not.toThrow();
    expect(telemetry.track).toHaveBeenCalledWith(
      'api_call',
      expect.objectContaining({ durationMs: 42, status: 200 })
    );
    expect(() => b.error(new NetworkError(), undefined)).not.toThrow();
    expect(telemetry.track).toHaveBeenLastCalledWith(
      'api_call',
      expect.objectContaining({ ok: false, code: 'NETWORK_ERROR', status: 0, path: '' })
    );
  });
});

// ── loggingInterceptor ───────────────────────────────────────────────────────────────────────────

describe('loggingInterceptor', () => {
  it('debug-logs redacted request, response and error', async () => {
    expect(() => loggingInterceptor({ logger: {} })).toThrow(ConfigError);
    expect(() => loggingInterceptor({ logger: { debug() {} }, redact: 'x' })).toThrow(ConfigError);
    const logger = { debug: vi.fn() };
    const b = loggingInterceptor({ logger });
    const spec = {
      method: 'POST',
      path: '/auth/login',
      headers: new Headers({ Authorization: 'Bearer secret', 'X-Api-Key': 'pk' }),
      body: {
        identifier: 'me',
        password: 'hunter2',
        card: { pan: '4111' },
        cardNumber: '4111 1111 1111 1111',
        nested: [{ documents: 1, travelerDocuments: [] }],
      },
    };
    const ctx = ctxFor(spec, { tag: 'auth' });
    expect(await b.request(spec, ctx)).toBe(spec);
    const [msg, data] = logger.debug.mock.calls[0];
    expect(msg).toBe('http request');
    expect(data).toMatchObject({
      id: 'req_1',
      method: 'POST',
      url: '/auth/login',
      tag: 'auth',
      headers: { authorization: '[redacted]', 'x-api-key': 'pk' },
      body: {
        identifier: 'me',
        password: '[redacted]',
        card: '[redacted]',
        cardNumber: '[redacted]',
        nested: [{ documents: '[redacted]', travelerDocuments: '[redacted]' }],
      },
    });
    expect(spec.body.password).toBe('hunter2');
    // a hostile body cannot reshape the log record
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    await b.request({ method: 'POST', path: '/v1/x', body: hostile }, ctxFor({}));
    const logged = logger.debug.mock.calls.at(-1)[1].body;
    expect(logged).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(logged)).toBe(Object.prototype);
    expect('polluted' in logged).toBe(false);
    expect(
      b.response({ status: 200, durationMs: 5, data: { token: 't', password: 'x' } }, ctx)
    ).toBeUndefined();
    expect(logger.debug).toHaveBeenLastCalledWith('http response', {
      id: 'req_1',
      method: 'POST',
      url: '/auth/login',
      tag: 'auth',
      attempt: 1,
      status: 200,
      durationMs: 5,
      fromCache: false,
      attempts: undefined,
      headers: undefined,
      data: { token: 't', password: '[redacted]' },
    });
    expect(b.error(new AuthError('bad', { reason: 'invalid_credentials' }), ctx)).toBeUndefined();
    expect(logger.debug).toHaveBeenLastCalledWith(
      'http error',
      expect.objectContaining({ name: 'AuthError', code: 'INVALID_CREDENTIALS', status: 401 })
    );
  });

  it('supports custom redact keys / level, circular data and a throwing logger', async () => {
    const logger = { info: vi.fn() };
    const b = loggingInterceptor({ logger, redact: ['secret'], level: 'info' });
    const body = { secret: 1, clientSecret: 2, password: 'kept' };
    body.self = body;
    const spec = { method: 'POST', path: '/v1/x', body, headers: { Authorization: 'kept too' } };
    await b.request(spec, ctxFor(spec));
    expect(logger.info.mock.calls[0][1].body).toEqual({
      secret: '[redacted]',
      clientSecret: '[redacted]',
      password: 'kept',
      self: '[circular]',
    });
    expect(logger.info.mock.calls[0][1].headers).toEqual({ Authorization: 'kept too' });
    const throwing = loggingInterceptor({
      logger: {
        debug: () => {
          throw new Error('sink');
        },
      },
    });
    expect(await throwing.request(spec, ctxFor(spec))).toBe(spec);
  });
});

// ── mockInterceptor ──────────────────────────────────────────────────────────────────────────────

describe('mockInterceptor', () => {
  it('validates handlers and options', () => {
    expect(() => mockInterceptor('x')).toThrow(ConfigError);
    expect(() => mockInterceptor([{ path: '/x' }])).toThrow(ConfigError);
    expect(() => mockInterceptor([{ path: 1, reply: () => ({}) }])).toThrow(ConfigError);
    expect(() => mockInterceptor([], { delayMs: -1 })).toThrow(ConfigError);
  });

  it('short-circuits matching requests with an HttpResponse and passes others through', async () => {
    const reply = vi.fn((spec, { params }) => ({
      status: 200,
      body: { id: params.id, q: spec.query?.q },
      headers: { 'x-mock': '1' },
    }));
    const b = mockInterceptor([
      { method: 'GET', path: '/v1/trips/:id', reply },
      { path: /^\/v1\/places\/(?<code>[A-Z]{3})$/, reply: (_s, m) => ({ body: m.params }) },
      { method: 'GET', path: '/v1/exact', reply: () => ({ body: 'exact' }) },
    ]);
    const spec = { method: 'GET', path: '/v1/trips/T1?x=1', query: { q: 'y' } };
    const ctx = ctxFor(spec, { id: 'req_m' });
    const res = await b.request(spec, ctx);
    expect(res).toMatchObject({
      data: { id: 'T1', q: 'y' },
      status: 200,
      requestId: 'req_m',
      fromCache: false,
      attempts: 1,
      mocked: true,
    });
    expect(res.headers.get('x-mock')).toBe('1');
    expect(reply).toHaveBeenCalledWith(spec, { params: { id: 'T1' }, ctx });
    const abs = { method: 'POST', url: 'https://api.ota.com/v1/places/DEL' };
    expect((await b.request(abs, ctxFor(abs))).data).toEqual({ code: 'DEL' });
    const post = { method: 'POST', path: '/v1/trips/T1' };
    expect(await b.request(post, ctxFor(post))).toBe(post);
    const other = { method: 'GET', path: '/v1/exact/not' };
    expect(await b.request(other, ctxFor(other))).toBe(other);
    const exact = { method: 'GET', path: '/v1/exact' };
    expect((await b.request(exact, ctxFor(exact))).data).toBe('exact');
  });

  it('delays replies on the injectable timers and maps error statuses to SdkErrors', async () => {
    vi.useFakeTimers();
    const b = mockInterceptor(
      [
        { path: '/v1/slow', reply: async () => ({ body: 'ok' }) },
        {
          path: '/v1/missing',
          reply: () => ({
            status: 404,
            body: { type: 'about:blank', title: 'Not found', status: 404 },
            headers: { 'content-type': 'application/problem+json' },
          }),
        },
      ],
      { delayMs: 50 }
    );
    const slow = { method: 'GET', path: '/v1/slow' };
    const p = b.request(slow, ctxFor(slow));
    let settled = false;
    p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).data).toBe('ok');
    const missing = { method: 'GET', path: '/v1/missing' };
    const failing = b.request(missing, ctxFor(missing, { id: 'req_404' }));
    const expectation = expect(failing).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      requestId: 'req_404',
    });
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
    expect(vi.getTimerCount()).toBe(0);
    const timers = {
      setTimeout: vi.fn((fn) => {
        fn();
        return 1;
      }),
      clearTimeout: vi.fn(),
    };
    const injected = mockInterceptor([{ path: '/v1/slow', reply: () => ({ body: 1 }) }], {
      delayMs: 10,
      timers,
    });
    expect((await injected.request({ method: 'GET', path: '/v1/slow' }, ctxFor({}))).data).toBe(1);
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10);
  });
});

// ── installDefaultInterceptors ───────────────────────────────────────────────────────────────────

describe('installDefaultInterceptors', () => {
  function stagedHttp() {
    const calls = { request: [], response: [], error: [] };
    const offs = [];
    const stage = (name) => ({
      use: vi.fn((fn, opts) => {
        calls[name].push({ fn, ...opts });
        const off = vi.fn();
        offs.push(off);
        return off;
      }),
    });
    return {
      interceptors: {
        request: stage('request'),
        response: stage('response'),
        error: stage('error'),
      },
      calls,
      offs,
    };
  }

  const fullDeps = () => ({
    auth: fakeAuth(),
    store: { get: () => undefined },
    storage: memoryStore(),
    apiKey: 'pk_1',
    logger: { debug: vi.fn() },
    telemetry: { track: vi.fn() },
    getDeviceId: () => 'dev',
    csrf: { cookieName: 'XSRF' },
  });

  it('rejects an http without a registration surface', () => {
    expect(() => installDefaultInterceptors()).toThrow(ConfigError);
    expect(() => installDefaultInterceptors({})).toThrow(ConfigError);
    expect(() => installDefaultInterceptors({ interceptors: { request: { use() {} } } })).toThrow(
      ConfigError
    );
  });

  it('installs the documented set in the documented order with per-stage priorities', () => {
    const http = stagedHttp();
    const off = installDefaultInterceptors(http, fullDeps());
    const names = (stage) => http.calls[stage].map((c) => c.name);
    const priorities = (stage) => http.calls[stage].map((c) => c.priority);
    expect(names('request')).toEqual([
      'correlation',
      'apiKey',
      'locale',
      'device',
      'csrf',
      'auth',
      'idempotency',
      'cache',
      'dedupe',
      'logging',
      'telemetry',
    ]);
    expect(priorities('request')).toEqual([10, 20, 30, 35, 40, 50, 60, 70, 80, 90, 95]);
    expect(names('response')).toEqual([
      'cache',
      'dedupe',
      'logging',
      'telemetry',
      'envelope',
      'problem',
    ]);
    const byPriority = (stage) =>
      [...http.calls[stage]].sort((a, b) => a.priority - b.priority).map((c) => c.name);
    expect(byPriority('response')).toEqual([
      'envelope',
      'problem',
      'cache',
      'dedupe',
      'logging',
      'telemetry',
    ]);
    expect(byPriority('error')).toEqual([
      'problem',
      'correlation',
      'auth',
      'rateLimit',
      'dedupe',
      'logging',
      'telemetry',
    ]);
    expect(off.bundles.map((b) => b.name)).toEqual([
      'correlation',
      'apiKey',
      'locale',
      'device',
      'csrf',
      'auth',
      'idempotency',
      'cache',
      'dedupe',
      'logging',
      'telemetry',
      'envelope',
      'problem',
      'rateLimit',
    ]);
    for (const stage of ['request', 'response', 'error']) {
      for (const call of http.calls[stage]) expect(typeof call.fn).toBe('function');
    }
    off();
    for (const fn of http.offs) expect(fn).toHaveBeenCalledTimes(1);
    off();
    for (const fn of http.offs) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips optional pieces whose dependency is missing', () => {
    const http = stagedHttp();
    const off = installDefaultInterceptors(http, {});
    expect(off.bundles.map((b) => b.name)).toEqual([
      'correlation',
      'idempotency',
      'cache',
      'dedupe',
      'envelope',
      'problem',
      'rateLimit',
    ]);
    expect(http.calls.error.map((c) => c.name)).toEqual([
      'correlation',
      'dedupe',
      'problem',
      'rateLimit',
    ]);
  });

  it('skips cache and dedupe when http runs the §3.1 cache / dedupe stage itself', () => {
    // `createHttp` exposes `http.cache` + `http.inflight()`: its own stage already caches and dedupes.
    const http = { ...stagedHttp(), cache: { clear() {}, invalidate() {} }, inflight: () => 0 };
    const off = installDefaultInterceptors(http, {});
    expect(off.bundles.map((b) => b.name)).toEqual([
      'correlation',
      'idempotency',
      'envelope',
      'problem',
      'rateLimit',
    ]);
    off();
  });

  it('skips cache and dedupe for a real createHttp client', async () => {
    const { createHttp } = await import('../../src/http/client.js');
    const http = createHttp({ baseUrl: 'https://api.ota.com' });
    const off = installDefaultInterceptors(http, {});
    const names = off.bundles.map((b) => b.name);
    expect(names).not.toContain('cache');
    expect(names).not.toContain('dedupe');
    off();
    http.destroy();
  });

  it('lets deps.cache / deps.dedupe force either bundle on or off', () => {
    const native = { ...stagedHttp(), cache: { clear() {}, invalidate() {} }, inflight: () => 0 };
    const forced = installDefaultInterceptors(native, { cache: true, dedupe: true });
    expect(forced.bundles.map((b) => b.name)).toContain('cache');
    expect(forced.bundles.map((b) => b.name)).toContain('dedupe');
    forced();
    const plain = installDefaultInterceptors(stagedHttp(), { cache: false, dedupe: false });
    expect(plain.bundles.map((b) => b.name)).not.toContain('cache');
    expect(plain.bundles.map((b) => b.name)).not.toContain('dedupe');
    plain();
  });

  it('falls back to http.use(bundle, opts) and reports the stage priorities there', () => {
    const offs = [];
    const http = {
      use: vi.fn(() => {
        const off = vi.fn();
        offs.push(off);
        return off;
      }),
    };
    const deps = fullDeps();
    const off = installDefaultInterceptors(http, deps);
    expect(http.use).toHaveBeenCalledTimes(14);
    const [bundle, opts] = http.use.mock.calls[5];
    expect(bundle.name).toBe('auth');
    expect(opts).toEqual({ priority: 50, name: 'auth', priorities: { request: 50, error: 20 } });
    const [problem, problemOpts] = http.use.mock.calls[12];
    expect(problem.name).toBe('problem');
    expect(problemOpts).toEqual({
      priority: 10,
      name: 'problem',
      priorities: { response: 20, error: 10 },
    });
    off();
    for (const fn of offs) expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the installed bundles work end to end on one request', async () => {
    const http = stagedHttp();
    const deps = fullDeps();
    deps.store = { get: (p) => ({ 'prefs.locale': 'en-IN', 'prefs.currency': 'INR' })[p] };
    vi.stubGlobal('document', { cookie: 'XSRF=c1' });
    installDefaultInterceptors(http, deps);
    const spec = {
      method: 'POST',
      path: '/v1/booking/flight-orders',
      body: { a: 1 },
      idempotencyKey: true,
    };
    const ctx = ctxFor(spec, { id: 'req_e2e' });
    const ordered = [...http.calls.request].sort((a, b) => a.priority - b.priority);
    let current = spec;
    for (const { fn } of ordered) {
      const out = await fn(current, ctx);
      if (out !== undefined) current = out;
    }
    expect(current).toBe(spec);
    expect(spec.headers).toEqual({
      'X-Request-Id': 'req_e2e',
      'X-Client-Session': expect.any(String),
      'X-Api-Key': 'pk_1',
      'Accept-Language': 'en-IN',
      'X-Currency': 'INR',
      'X-Device-Id': 'dev',
      'X-CSRF-Token': 'c1',
      Authorization: 'Bearer acc-1',
      'Idempotency-Key': idempotencyKey('/v1/booking/flight-orders', { a: 1 }),
    });
    expect(spec.credentials).toBe('include');
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'http request',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: '[redacted]' }) })
    );
    const res = {
      data: { data: { id: 'B1' }, meta: { v: 2 } },
      status: 201,
      headers: new Headers(),
    };
    for (const { fn } of [...http.calls.response].sort((a, b) => a.priority - b.priority)) {
      await fn(res, ctx);
    }
    expect(res.data).toEqual({ id: 'B1' });
    expect(res.meta).toEqual({ v: 2 });
    expect(deps.telemetry.track).toHaveBeenCalledWith(
      'http_request',
      expect.objectContaining({ status: 201, ok: true, method: 'POST' })
    );
  });
});
