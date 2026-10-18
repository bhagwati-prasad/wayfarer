import { describe, it, expect, vi, afterEach } from 'vitest';
import { http as msw, HttpResponse, delay } from 'msw';
import { server } from '../setup.js';
import { createAuth } from '../../src/auth/session.js';
import { createHttp } from '../../src/http/client.js';
import { authInterceptor } from '../../src/http/interceptors.js';
import { createStore } from '../../src/state/store.js';
import { createEmitter } from '../../src/events/emitter.js';
import { createStorage } from '../../src/storage/adapters.js';
import { createEndpoints } from '../../src/core/endpoints.js';
import {
  AbortError,
  AuthError,
  ConfigError,
  RateLimitError,
  SdkError,
  ValidationError,
} from '../../src/errors/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const BASE = 'https://api.ota.com';
const USER = { id: 'u_1', email: 'ana@example.com', verified: { email: true, phone: false } };

afterEach(() => {
  vi.useRealTimers();
});

/** Let the store's microtask batch (and one re-scheduled batch) deliver notifications. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Resolve a promise and return `{ ok, value }` / `{ ok: false, error }` without throwing. */
async function settle(p) {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/** RFC 9457 problem response. */
function problem(status, doc) {
  return HttpResponse.json(
    { status, ...doc },
    { status, headers: { 'content-type': 'application/problem+json' } }
  );
}

/** Records every request a handler sees (`url`, `method`, `headers`, parsed JSON `body`). */
function recorder() {
  const calls = [];
  const record = async (request) => {
    const entry = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: null,
    };
    if (request.method !== 'GET') {
      try {
        entry.body = await request.json();
      } catch {
        entry.body = null;
      }
    }
    calls.push(entry);
    return entry;
  };
  return { calls, record };
}

/** Token payload the way the backend returns it. */
function tokens(overrides = {}) {
  return {
    accessToken: 'acc_1',
    refreshToken: 'ref_1',
    expiresIn: 3600,
    user: USER,
    ...overrides,
  };
}

/**
 * Build an auth instance on real `http` / `store` / `emitter` / `storage` siblings. `storage` may be
 * a prepared facade; `endpoints: null` exercises the standalone path table.
 */
function make({ config, storage, endpoints, timers, now, withInterceptor = false, logger } = {}) {
  const events = createEmitter();
  const facade = storage || createStorage({ driver: 'memory' });
  const store = createStore({ storage: facade });
  const http = createHttp({ baseUrl: BASE, retries: 0, events, now });
  const eps = endpoints === null ? null : endpoints || createEndpoints();
  const auth = createAuth({
    http,
    store,
    storage: facade,
    events,
    config: config || {},
    endpoints: eps,
    timers,
    now,
    logger,
  });
  if (withInterceptor) http.use(authInterceptor({ auth }));
  const seen = [];
  events.on('auth:*', (e) => seen.push(e));
  return {
    auth,
    http,
    store,
    storage: facade,
    events,
    endpoints: eps,
    seen,
    types: () => seen.map((e) => e.type),
    session: () => store.get('session'),
  };
}

// ── surface ──────────────────────────────────────────────────────────────────────────────────────

describe('createAuth', () => {
  it('returns every documented member', () => {
    const { auth } = make();
    const members = [
      'getAccessToken',
      'isAuthenticated',
      'getUser',
      'getSessionId',
      'setTokens',
      'clearTokens',
      'refresh',
      'ensureGuestSession',
      'isGuest',
      'getGuestToken',
      'claimAccount',
      'completeClaim',
      'register',
      'loginWithPassword',
      'requestOtp',
      'verifyOtp',
      'getProviderUrl',
      'loginWithProvider',
      'requestMagicLink',
      'consumeMagicLink',
      'mfa',
      'logout',
      'onChange',
      'willExpireWithin',
      'getExpiry',
      'destroy',
    ];
    expect(Object.keys(auth).sort()).toEqual(members.sort());
    expect(typeof auth.mfa.verify).toBe('function');
  });

  it('registers the session slice (secret) with the documented initial state', () => {
    const { auth, store, session } = make();
    expect(session()).toEqual({
      status: 'anonymous',
      user: null,
      guestId: null,
      accessExpiresAt: null,
      claim: null,
    });
    auth.setTokens({
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh',
      user: USER,
    });
    expect(store.snapshot().slices.session).toBeUndefined();
    expect(JSON.stringify(store.getState())).not.toContain('secret-');
    auth.destroy();
  });

  it('validates its dependencies with ConfigError', () => {
    const store = createStore();
    const http = createHttp({ baseUrl: BASE });
    expect(() => createAuth()).toThrow(ConfigError);
    expect(() => createAuth({ store })).toThrow(ConfigError);
    expect(() => createAuth({ http })).toThrow(ConfigError);
    expect(() => createAuth({ http, store, events: {} })).toThrow(ConfigError);
    expect(() => createAuth({ http, store, storage: { get() {} } })).toThrow(ConfigError);
    expect(() => createAuth({ http, store, endpoints: { get() {} } })).toThrow(ConfigError);
    expect(() => createAuth({ http, store, timers: {} })).toThrow(ConfigError);
    expect(() => createAuth({ http, store, now: 1 })).toThrow(ConfigError);
    expect(() => createAuth({ http, store, config: 'x' })).toThrow(ConfigError);
    expect(() => createAuth({ http, store })).not.toThrow();
  });

  it('seeds the missing auth.* endpoint keys with the documented /v1 paths', () => {
    const { endpoints } = make();
    expect(endpoints.get('auth.refresh')).toBe('/v1/auth/refresh');
    expect(endpoints.get('auth.loginWithPassword')).toBe('/v1/auth/login');
    expect(endpoints.get('auth.register')).toBe('/v1/auth/register');
    expect(endpoints.get('auth.requestOtp')).toBe('/v1/auth/otp/request');
    expect(endpoints.get('auth.verifyOtp')).toBe('/v1/auth/otp/verify');
    expect(endpoints.get('auth.getProviderUrl', { provider: 'google' })).toBe(
      '/v1/auth/providers/google/url'
    );
    expect(endpoints.get('auth.loginWithProvider', { provider: 'google' })).toBe(
      '/v1/auth/providers/google/callback'
    );
    expect(endpoints.get('auth.requestMagicLink')).toBe('/v1/auth/magic-link');
    expect(endpoints.get('auth.consumeMagicLink')).toBe('/v1/auth/magic-link/consume');
    expect(endpoints.get('auth.mfa.verify')).toBe('/v1/auth/mfa/verify');
    expect(endpoints.get('auth.logout')).toBe('/v1/auth/logout');
    expect(endpoints.get('auth.ensureGuestSession')).toBe('/v1/sessions/guest');
    expect(endpoints.get('auth.claimAccount')).toBe('/v1/auth/claim');
    expect(endpoints.get('auth.completeClaim')).toBe('/v1/auth/claim/complete');
    expect(endpoints.all()['auth.getProviderUrl'].method).toBe('GET');
  });

  it('keeps an auth.* path the endpoints owner already defined', () => {
    const endpoints = createEndpoints({ 'auth.loginWithPassword': '/v9/login' });
    make({ endpoints });
    expect(endpoints.get('auth.loginWithPassword')).toBe('/v9/login');
  });
});

// ── setTokens / clearTokens / reads ──────────────────────────────────────────────────────────────

describe('setTokens / clearTokens', () => {
  it('keeps the access token in the closure, mirrors the session and emits auth:login', () => {
    const now = () => Date.parse('2026-10-17T10:00:00Z');
    const { auth, session, seen, storage } = make({ now });
    auth.setTokens({
      accessToken: 'acc',
      refreshToken: 'ref',
      expiresAt: '2026-10-17T11:00:00+00:00',
      user: USER,
    });
    expect(auth.getAccessToken()).toBe('acc');
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getUser()).toEqual(USER);
    expect(auth.getExpiry()).toBe('2026-10-17T11:00:00+00:00');
    expect(auth.willExpireWithin(60 * 60 * 1000)).toBe(true);
    expect(auth.willExpireWithin(59 * 60 * 1000)).toBe(false);
    expect(session()).toMatchObject({
      status: 'authenticated',
      user: USER,
      accessExpiresAt: '2026-10-17T11:00:00+00:00',
    });
    expect(session()).not.toHaveProperty('accessToken');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'auth:login', user: USER, method: 'host' });
    // memory token storage: nothing persisted
    expect(storage.get('refreshToken')).toBeUndefined();
    auth.destroy();
  });

  it('persists the refresh token through storage when tokenStorage is local', () => {
    const { auth, storage } = make({ config: { auth: { tokenStorage: 'local' } } });
    auth.setTokens({ accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 60000 });
    expect(storage.get('refreshToken')).toBe('ref');
    auth.clearTokens();
    expect(storage.get('refreshToken')).toBeUndefined();
  });

  it('uses a storage factory per kind', () => {
    const local = createStorage({ driver: 'memory' });
    const session = createStorage({ driver: 'memory' });
    const factory = vi.fn((kind) => (kind === 'local' ? local : session));
    const { auth } = make({ storage: factory, config: { auth: { tokenStorage: 'session' } } });
    auth.setTokens({ accessToken: 'acc', refreshToken: 'ref' });
    expect(session.get('refreshToken')).toBe('ref');
    expect(local.get('refreshToken')).toBeUndefined();
    expect(factory).toHaveBeenCalledWith('session');
  });

  it('rejects invalid tokens with ValidationError', () => {
    const { auth } = make();
    expect(() => auth.setTokens()).toThrow(ValidationError);
    expect(() => auth.setTokens({})).toThrow(ValidationError);
    expect(() => auth.setTokens({ accessToken: 'a', expiresAt: 'nope' })).toThrow(ValidationError);
    expect(() => auth.setTokens({ accessToken: 'a', refreshToken: 1 })).toThrow(ValidationError);
    expect(() => auth.setTokens({ accessToken: 'a', user: 'x' })).toThrow(ValidationError);
    try {
      auth.setTokens({ accessToken: '' });
    } catch (e) {
      expect(e.issues).toEqual([
        { path: 'accessToken', code: 'required', message: 'accessToken is required' },
      ]);
    }
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('schedules a proactive refresh and clearTokens cancels it, emitting auth:logout', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { auth, session, types } = make({ now: () => Date.now() });
    auth.setTokens({ accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 60000 });
    expect(vi.getTimerCount()).toBe(1);
    auth.clearTokens();
    expect(vi.getTimerCount()).toBe(0);
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getExpiry()).toBeNull();
    expect(auth.willExpireWithin(0)).toBe(true);
    expect(session()).toMatchObject({ status: 'anonymous', user: null, accessExpiresAt: null });
    expect(types()).toEqual(['auth:login', 'auth:logout']);
  });

  it('willExpireWithin validates its argument and reads false without a known expiry', () => {
    const { auth } = make();
    expect(() => auth.willExpireWithin(-1)).toThrow(ValidationError);
    auth.setTokens({ accessToken: 'acc' });
    expect(auth.willExpireWithin(1000)).toBe(false);
    expect(auth.getExpiry()).toBeNull();
  });
});

// ── refresh ──────────────────────────────────────────────────────────────────────────────────────

describe('refresh', () => {
  it('is single-flight: two concurrent calls make one request and share the tokens', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, async ({ request }) => {
        await record(request);
        await delay(20);
        return HttpResponse.json(tokens({ accessToken: 'acc_2', refreshToken: 'ref_2' }));
      })
    );
    const { auth, session, seen } = make({ withInterceptor: true });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    const [a, b] = await Promise.all([auth.refresh(), auth.refresh()]);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ refreshToken: 'ref_1' });
    // credential-free: the auth interceptor must not attach the old bearer
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(a).toEqual(b);
    expect(a).toMatchObject({ accessToken: 'acc_2', refreshToken: 'ref_2', user: USER });
    expect(a.expiresAt).toEqual(expect.any(String));
    expect(auth.getAccessToken()).toBe('acc_2');
    expect(session().status).toBe('authenticated');
    const refreshed = seen.filter((e) => e.type === 'auth:refreshed');
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].expiresAt).toBe(a.expiresAt);
    // a later call is a new flight
    await auth.refresh();
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ refreshToken: 'ref_2' });
    auth.destroy();
  });

  it('rejects without network when there is nothing to refresh', async () => {
    const { auth, types } = make();
    const r = await settle(auth.refresh());
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('expired');
    expect(types()).toEqual([]);
  });

  it('passes through to a transient refresh status while in flight', async () => {
    let resolveRequest;
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, async () => {
        await new Promise((r) => (resolveRequest = r));
        return HttpResponse.json(tokens({ accessToken: 'acc_2' }));
      })
    );
    const { auth, session } = make();
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    const p = auth.refresh();
    expect(session().status).toBe('refreshing');
    await vi.waitFor(() => expect(typeof resolveRequest).toBe('function'));
    expect(session().status).toBe('refreshing');
    expect(auth.getAccessToken()).toBe('acc_1'); // old token stays usable while refreshing
    resolveRequest();
    await p;
    expect(session().status).toBe('authenticated');
    expect(auth.getAccessToken()).toBe('acc_2');
    expect(auth.isAuthenticated()).toBe(true);
    auth.destroy();
  });

  it('on a rejected refresh clears the session, removes the stored token and emits auth:expired', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, () =>
        problem(401, { title: 'Refresh token revoked', code: 'SESSION_EXPIRED' })
      )
    );
    const { auth, session, seen, storage } = make({ config: { auth: { tokenStorage: 'local' } } });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1', user: USER });
    expect(storage.get('refreshToken')).toBe('ref_1');
    const r = await settle(auth.refresh());
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('expired');
    expect(r.error.cause).toBeInstanceOf(AuthError);
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getUser()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
    expect(storage.get('refreshToken')).toBeUndefined();
    expect(session()).toEqual({
      status: 'anonymous',
      user: null,
      guestId: null,
      accessExpiresAt: null,
      claim: null,
    });
    const expired = seen.filter((e) => e.type === 'auth:expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].reason).toBe('refresh_rejected');
    expect(seen.some((e) => e.type === 'auth:refreshed')).toBe(false);
    // the refresh token is gone: nothing to retry
    const again = await settle(auth.refresh());
    expect(again.error.reason).toBe('expired');
    expect(seen.filter((e) => e.type === 'auth:expired')).toHaveLength(1);
  });

  it('keeps the session on a transient failure (5xx / network) and rethrows it', async () => {
    server.use(msw.post(`${BASE}/v1/auth/refresh`, () => problem(503, { title: 'busy' })));
    const { auth, session, types } = make();
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    const r = await settle(auth.refresh());
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(SdkError);
    expect(r.error).not.toBeInstanceOf(AuthError);
    expect(auth.getAccessToken()).toBe('acc_1');
    expect(session().status).toBe('authenticated');
    expect(types()).toEqual(['auth:login']);
    auth.destroy();
  });

  it('treats a token-less refresh response as expiry', async () => {
    server.use(msw.post(`${BASE}/v1/auth/refresh`, () => HttpResponse.json({ ok: true })));
    const { auth, types } = make();
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    const r = await settle(auth.refresh());
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('expired');
    expect(auth.isAuthenticated()).toBe(false);
    expect(types()).toEqual(['auth:login', 'auth:expired']);
  });

  it('honours config.auth.refreshPath and forwards opts', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v2/token`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens({ accessToken: 'acc_2' }));
      })
    );
    const { auth, endpoints } = make({ config: { auth: { refreshPath: '/v2/token' } } });
    expect(endpoints.get('auth.refresh')).toBe('/v2/token');
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    await auth.refresh({ headers: { 'X-Trace': 't-1' } });
    expect(calls[0].headers['x-trace']).toBe('t-1');
    expect(auth.getAccessToken()).toBe('acc_2');
    auth.destroy();
  });

  it('cookie strategy refreshes without a JS refresh token and sends credentials', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ accessToken: 'acc_c', expiresIn: 600, user: USER });
      })
    );
    const { auth, session } = make({ config: { auth: { strategy: 'cookie' } } });
    const out = await auth.refresh();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({});
    expect(out.accessToken).toBe('acc_c');
    expect(out.refreshToken).toBeNull();
    expect(session().status).toBe('authenticated');
    expect(auth.getUser()).toEqual(USER);
    auth.destroy();
  });

  it('works without an endpoints table (standalone paths)', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, () => HttpResponse.json(tokens({ accessToken: 'acc_2' })))
    );
    const { auth } = make({ endpoints: null });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    await auth.refresh();
    expect(auth.getAccessToken()).toBe('acc_2');
    auth.destroy();
  });
});

// ── scheduled refresh (fake timers) ──────────────────────────────────────────────────────────────

describe('scheduled refresh', () => {
  it('refreshes at expiresAt - autoRefreshSkewMs, reschedules, and destroy() clears the timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    let n = 0;
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, () => {
        n += 1;
        return HttpResponse.json(tokens({ accessToken: `acc_${n + 1}`, expiresIn: 60 }));
      })
    );
    const { auth, seen } = make({
      now: () => Date.now(),
      config: { auth: { autoRefreshSkewMs: 10000 } },
    });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1', expiresAt: Date.now() + 60000 });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(49999);
    expect(n).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(auth.getAccessToken()).toBe('acc_2'));
    expect(n).toBe(1);
    expect(seen.filter((e) => e.type === 'auth:refreshed')).toHaveLength(1);
    // the new 60 s token is scheduled again 10 s before its expiry
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50000);
    await vi.waitFor(() => expect(auth.getAccessToken()).toBe('acc_3'));
    expect(n).toBe(2);

    auth.destroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(n).toBe(2);
  });

  it('never schedules closer than one second, and not at all without an expiry', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { auth } = make({ now: () => Date.now() });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    expect(vi.getTimerCount()).toBe(0);
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1', expiresAt: Date.now() - 5000 });
    expect(vi.getTimerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    auth.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a scheduled refresh that is rejected expires the session quietly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    server.use(msw.post(`${BASE}/v1/auth/refresh`, () => problem(401, { title: 'nope' })));
    const { auth, types } = make({ now: () => Date.now() });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1', expiresAt: Date.now() + 31000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(auth.isAuthenticated()).toBe(false));
    expect(types()).toEqual(['auth:login', 'auth:expired']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores a persisted refresh token proactively on creation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/refresh`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens({ accessToken: 'acc_r', refreshToken: 'ref_r' }));
      })
    );
    const storage = createStorage({ driver: 'memory' });
    storage.set('refreshToken', 'ref_persisted');
    const { auth, session, types } = make({
      storage,
      now: () => Date.now(),
      config: { auth: { tokenStorage: 'local' } },
    });
    expect(auth.isAuthenticated()).toBe(false);
    expect(session().status).toBe('anonymous');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(auth.getAccessToken()).toBe('acc_r'));
    expect(calls[0].body).toEqual({ refreshToken: 'ref_persisted' });
    expect(storage.get('refreshToken')).toBe('ref_r');
    expect(session()).toMatchObject({ status: 'authenticated', user: USER });
    expect(types()).toEqual(['auth:refreshed']);
    auth.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── guest sessions ───────────────────────────────────────────────────────────────────────────────

describe('ensureGuestSession', () => {
  it('creates a guest once (single-flight), persists it, updates the slice and emits auth:guest', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/sessions/guest`, async ({ request }) => {
        await record(request);
        await delay(10);
        return HttpResponse.json({ guestId: 'g_1', guestToken: 'gt_1' });
      })
    );
    const { auth, session, storage, seen } = make();
    const [a, b] = await Promise.all([auth.ensureGuestSession(), auth.ensureGuestSession()]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(a).toEqual({ guestId: 'g_1', guestToken: 'gt_1' });
    expect(b).toEqual(a);
    expect(auth.isGuest()).toBe(true);
    expect(auth.getGuestToken()).toBe('gt_1');
    expect(auth.getSessionId()).toBe('g_1');
    expect(auth.isAuthenticated()).toBe(false);
    expect(session()).toMatchObject({ status: 'guest', guestId: 'g_1' });
    expect(session()).not.toHaveProperty('guestToken');
    expect(storage.get('guestId')).toBe('g_1');
    expect(storage.get('guestToken')).toBe('gt_1');
    expect(seen.filter((e) => e.type === 'auth:guest')).toEqual([
      expect.objectContaining({ guestId: 'g_1', reused: false }),
    ]);
    // reuse: no further request
    expect(await auth.ensureGuestSession()).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it('reuses a guest persisted in storage without any request', async () => {
    const storage = createStorage({ driver: 'memory' });
    storage.set('guestId', 'g_old');
    storage.set('guestToken', 'gt_old');
    const { auth, session, types } = make({ storage });
    expect(session()).toMatchObject({ status: 'guest', guestId: 'g_old' });
    expect(auth.isGuest()).toBe(true);
    expect(await auth.ensureGuestSession()).toEqual({ guestId: 'g_old', guestToken: 'gt_old' });
    expect(types()).toEqual([]);
  });

  it('ignores a half-persisted guest', () => {
    const storage = createStorage({ driver: 'memory' });
    storage.set('guestId', 'g_old');
    const { auth, session } = make({ storage });
    expect(session().status).toBe('anonymous');
    expect(auth.isGuest()).toBe(false);
    expect(auth.getGuestToken()).toBeNull();
  });

  it('sends the guest token on guest requests through the auth interceptor', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/sessions/guest`, () =>
        HttpResponse.json({ id: 'g_2', token: 'gt_2', expiresAt: Date.now() + 3600000 })
      ),
      msw.post(`${BASE}/v1/itineraries`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ id: 'it_1' });
      })
    );
    const { auth, http } = make({ withInterceptor: true });
    await auth.ensureGuestSession();
    await http.post('/v1/itineraries', { offerId: 'o1' });
    expect(calls[0].headers['x-guest-token']).toBe('gt_2');
  });

  it('rejects with AuthError{forbidden} when guests are disabled', async () => {
    const { auth, types } = make({ config: { auth: { guest: false } } });
    const r = await settle(auth.ensureGuestSession());
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('forbidden');
    expect(types()).toEqual([]);
  });

  it('rejects an incomplete guest payload', async () => {
    server.use(msw.post(`${BASE}/v1/sessions/guest`, () => HttpResponse.json({ guestId: 'g' })));
    const { auth } = make();
    const r = await settle(auth.ensureGuestSession());
    expect(r.error).toBeInstanceOf(SdkError);
    expect(r.error.code).toBe('GUEST_SESSION_INVALID');
    expect(auth.isGuest()).toBe(false);
  });

  it('does not downgrade an authenticated session', async () => {
    server.use(
      msw.post(`${BASE}/v1/sessions/guest`, () =>
        HttpResponse.json({ guestId: 'g_3', guestToken: 'gt_3' })
      )
    );
    const { auth, session } = make();
    auth.setTokens({ accessToken: 'acc' });
    await auth.ensureGuestSession();
    expect(session()).toMatchObject({ status: 'authenticated', guestId: 'g_3' });
    expect(auth.isGuest()).toBe(false);
  });
});

// ── claim flow ───────────────────────────────────────────────────────────────────────────────────

describe('claimAccount / completeClaim', () => {
  function guestStorage() {
    const storage = createStorage({ driver: 'memory' });
    storage.set('guestId', 'g_1');
    storage.set('guestToken', 'gt_1');
    return storage;
  }

  it('requires a guest session', async () => {
    const { auth } = make();
    const r = await settle(auth.claimAccount({ channel: 'email' }));
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('forbidden');
    auth.setTokens({ accessToken: 'acc' });
    const r2 = await settle(auth.claimAccount({ channel: 'email' }));
    expect(r2.error.reason).toBe('forbidden');
  });

  it('validates the request', async () => {
    const { auth } = make({ storage: guestStorage() });
    const r = await settle(auth.claimAccount({ channel: 'pigeon' }));
    expect(r.error).toBeInstanceOf(ValidationError);
    expect(r.error.issues[0]).toMatchObject({ path: 'channel', code: 'enum' });
    expect((await settle(auth.claimAccount())).error).toBeInstanceOf(ValidationError);
  });

  it('sends the claim (credential-free, guest token in the body), stores it and emits auth:claimSent', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/claim`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          sentTo: 'a***@example.com',
          expiresAt: '2026-10-17T10:10:00+00:00',
          challengeId: 'ch_1',
        });
      })
    );
    const { auth, session, seen } = make({ storage: guestStorage(), withInterceptor: true });
    const out = await auth.claimAccount({ channel: 'email', bookingId: 'b_1' });
    expect(out).toEqual({
      sentTo: 'a***@example.com',
      expiresAt: '2026-10-17T10:10:00+00:00',
      challengeId: 'ch_1',
    });
    expect(calls[0].body).toEqual({
      guestId: 'g_1',
      guestToken: 'gt_1',
      channel: 'email',
      bookingId: 'b_1',
    });
    expect(calls[0].headers['x-guest-token']).toBeUndefined();
    expect(session().claim).toEqual({
      challengeId: 'ch_1',
      channel: 'email',
      sentTo: 'a***@example.com',
      expiresAt: '2026-10-17T10:10:00+00:00',
      bookingId: 'b_1',
    });
    expect(seen.filter((e) => e.type === 'auth:claimSent')).toEqual([
      expect.objectContaining({ challengeId: 'ch_1', channel: 'email' }),
    ]);
  });

  it('surfaces RateLimitError from the backend', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/claim`, () =>
        problem(429, { title: 'Slow down', code: 'RATE_LIMITED', retryAfterMs: 5000 })
      )
    );
    const { auth, session } = make({ storage: guestStorage() });
    const r = await settle(auth.claimAccount({ channel: 'sms', destination: '+919999999999' }));
    expect(r.error).toBeInstanceOf(RateLimitError);
    expect(session().claim).toBeNull();
  });

  it('completeClaim validates password policy and the token / otp pair', async () => {
    const { auth } = make({ storage: guestStorage() });
    const r = await settle(auth.completeClaim({ otp: '123456' }));
    expect(r.error).toBeInstanceOf(ValidationError);
    expect(r.error.issues.map((i) => i.path)).toEqual(['password', 'token']);
    const short = await settle(auth.completeClaim({ token: 't', password: 'short' }));
    expect(short.error.issues[0]).toMatchObject({ path: 'password', code: 'minLength' });
    const noOtp = await settle(auth.completeClaim({ challengeId: 'ch', password: 'longenough1' }));
    expect(noOtp.error.issues[0]).toMatchObject({ path: 'otp', code: 'required' });
  });

  it('converts the guest into an account: tokens applied, guest removed, account.user set, events emitted', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/claim`, () =>
        HttpResponse.json({ sentTo: 'x', expiresAt: null, challengeId: 'ch_1' })
      ),
      msw.post(`${BASE}/v1/auth/claim/complete`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens({ accessToken: 'acc_claimed' }));
      })
    );
    const storage = guestStorage();
    const { auth, store, session, storage: facade, types } = make({ storage });
    store.registerSlice('account', { initial: { user: null, preferences: null } });
    await auth.claimAccount({ channel: 'email' });
    const user = await auth.completeClaim({ otp: '123456', password: 'longenough1' });
    expect(user).toEqual(USER);
    // challengeId falls back to the pending claim; the guest identity travels in the body
    expect(calls[0].body).toEqual({
      guestId: 'g_1',
      guestToken: 'gt_1',
      challengeId: 'ch_1',
      otp: '123456',
      password: 'longenough1',
    });
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.isGuest()).toBe(false);
    expect(auth.getGuestToken()).toBeNull();
    expect(auth.getAccessToken()).toBe('acc_claimed');
    expect(facade.get('guestId')).toBeUndefined();
    expect(facade.get('guestToken')).toBeUndefined();
    expect(session()).toMatchObject({
      status: 'authenticated',
      user: USER,
      guestId: null,
      claim: null,
    });
    expect(store.get('account.user')).toEqual(USER);
    expect(types()).toEqual(['auth:claimSent', 'auth:claimed', 'auth:login']);
    auth.destroy();
  });

  it('a magic-link token completes the claim without a guest state and maps OTP problems', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/claim/complete`, async ({ request }) => {
        const entry = await record(request);
        if (entry.body.token === 'bad') {
          return problem(401, { title: 'Code expired', code: 'OTP_EXPIRED' });
        }
        return HttpResponse.json(tokens());
      })
    );
    const { auth } = make();
    const bad = await settle(auth.completeClaim({ token: 'bad', password: 'longenough1' }));
    expect(bad.error).toBeInstanceOf(AuthError);
    expect(bad.error.reason).toBe('otp_expired');
    expect(auth.isAuthenticated()).toBe(false);
    const user = await auth.completeClaim({
      token: 'good',
      password: 'longenough1',
      consents: { terms: 'v3' },
    });
    expect(user).toEqual(USER);
    expect(calls[1].body).toEqual({
      token: 'good',
      password: 'longenough1',
      consents: { terms: 'v3' },
    });
    auth.destroy();
  });
});

// ── register / login variants ────────────────────────────────────────────────────────────────────

describe('register', () => {
  it('validates before any request', async () => {
    const { auth } = make();
    const cases = [
      [undefined, ''],
      [{ consents: {} }, 'email'],
      [{ email: 'nope', consents: {} }, 'email'],
      [{ phone: '12', consents: {} }, 'phone'],
      [{ email: 'a@b.co', password: 'short', consents: {} }, 'password'],
      [{ email: 'a@b.co' }, 'consents'],
      [{ email: 'a@b.co', firstName: '', consents: {} }, 'firstName'],
    ];
    for (const [input, path] of cases) {
      const r = await settle(auth.register(input));
      expect(r.error).toBeInstanceOf(ValidationError);
      expect(r.error.issues[0].path).toBe(path);
    }
  });

  it('creates the account, logs in and mirrors account.user', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/register`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens());
      })
    );
    const { auth, store, session, types, http } = make({ withInterceptor: true });
    store.registerSlice('account', { initial: { user: null } });
    http.setHeader('Authorization', 'Bearer stale');
    const user = await auth.register({
      email: 'ana@example.com',
      password: 'longenough1',
      firstName: 'Ana',
      consents: { terms: 'v3', marketing: false },
    });
    expect(user).toEqual(USER);
    expect(calls[0].body).toEqual({
      email: 'ana@example.com',
      password: 'longenough1',
      firstName: 'Ana',
      consents: { terms: 'v3', marketing: false },
    });
    expect(session()).toMatchObject({ status: 'authenticated', user: USER });
    expect(store.get('account.user')).toEqual(USER);
    expect(auth.getAccessToken()).toBe('acc_1');
    expect(types()).toEqual(['auth:login']);
    auth.destroy();
  });
});

describe('loginWithPassword', () => {
  it('validates input', async () => {
    const { auth } = make();
    expect((await settle(auth.loginWithPassword({ identifier: 'a' }))).error).toBeInstanceOf(
      ValidationError
    );
    expect(
      (await settle(auth.loginWithPassword({ identifier: 'a', password: 'b', remember: 'yes' })))
        .error
    ).toBeInstanceOf(ValidationError);
  });

  it('logs in credential-free, emits auth:login and includes the guest id for merging', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/sessions/guest`, () =>
        HttpResponse.json({ guestId: 'g_1', guestToken: 'gt_1' })
      ),
      msw.post(`${BASE}/v1/auth/login`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens({ sessionId: 'sess_1' }));
      })
    );
    const { auth, session, seen } = make({ withInterceptor: true });
    await auth.ensureGuestSession();
    const user = await auth.loginWithPassword({ identifier: 'ana@example.com', password: 'pw' });
    expect(user).toEqual(USER);
    expect(calls[0].body).toEqual({
      identifier: 'ana@example.com',
      password: 'pw',
      guestId: 'g_1',
    });
    expect(calls[0].headers['x-guest-token']).toBeUndefined();
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(session()).toMatchObject({ status: 'authenticated', user: USER, guestId: 'g_1' });
    expect(auth.getSessionId()).toBe('sess_1');
    expect(auth.isGuest()).toBe(false);
    expect(seen.at(-1)).toMatchObject({ type: 'auth:login', method: 'password', user: USER });
    auth.destroy();
  });

  it('remember: false keeps the refresh token out of storage', async () => {
    server.use(msw.post(`${BASE}/v1/auth/login`, () => HttpResponse.json(tokens())));
    const { auth, storage } = make({ config: { auth: { tokenStorage: 'local' } } });
    await auth.loginWithPassword({ identifier: 'ana', password: 'pw', remember: false });
    expect(storage.get('refreshToken')).toBeUndefined();
    await auth.loginWithPassword({ identifier: 'ana', password: 'pw', remember: true });
    expect(storage.get('refreshToken')).toBe('ref_1');
    auth.destroy();
  });

  it('maps backend problems to AuthError reasons', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/login`, () =>
        problem(401, { title: 'Bad credentials', code: 'INVALID_CREDENTIALS' })
      )
    );
    const { auth, types } = make();
    const r = await settle(auth.loginWithPassword({ identifier: 'ana', password: 'wrong' }));
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('invalid_credentials');
    expect(auth.isAuthenticated()).toBe(false);
    expect(types()).toEqual([]);
  });

  it('emits auth:mfaRequired and rejects with mfa_required (200 challenge body)', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/login`, () =>
        HttpResponse.json({ mfaRequired: true, challengeId: 'mfa_1', methods: ['totp'] })
      )
    );
    const { auth, seen } = make();
    const r = await settle(auth.loginWithPassword({ identifier: 'ana', password: 'pw' }));
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('mfa_required');
    expect(r.error.details).toEqual({ challengeId: 'mfa_1', methods: ['totp'] });
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'auth:mfaRequired',
        challengeId: 'mfa_1',
        methods: ['totp'],
      }),
    ]);
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('emits auth:mfaRequired for an MFA_REQUIRED problem too', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/login`, () =>
        problem(401, { title: 'MFA', code: 'MFA_REQUIRED', challengeId: 'mfa_2' })
      )
    );
    const { auth, seen } = make();
    const r = await settle(auth.loginWithPassword({ identifier: 'ana', password: 'pw' }));
    expect(r.error.reason).toBe('mfa_required');
    expect(seen[0]).toMatchObject({ type: 'auth:mfaRequired', challengeId: 'mfa_2' });
  });
});

describe('OTP', () => {
  it('requestOtp validates and returns the challenge', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/otp/request`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          challengeId: 'otp_1',
          expiresAt: '2026-10-17T10:05:00+00:00',
          resendAfterMs: 30000,
        });
      })
    );
    const { auth } = make();
    const bad = await settle(
      auth.requestOtp({ channel: 'fax', identifier: 'x', purpose: 'login' })
    );
    expect(bad.error).toBeInstanceOf(ValidationError);
    const badPurpose = await settle(
      auth.requestOtp({ channel: 'sms', identifier: 'x', purpose: 'nope' })
    );
    expect(badPurpose.error.issues[0].path).toBe('purpose');
    const out = await auth.requestOtp({
      channel: 'sms',
      identifier: '+919999999999',
      purpose: 'login',
    });
    expect(out).toEqual({
      challengeId: 'otp_1',
      expiresAt: '2026-10-17T10:05:00+00:00',
      resendAfterMs: 30000,
    });
    expect(calls[0].body).toEqual({
      channel: 'sms',
      identifier: '+919999999999',
      purpose: 'login',
    });
  });

  it('verifyOtp logs in, or reports that registration is required', async () => {
    server.use(
      msw.post(`${BASE}/v1/auth/otp/verify`, async ({ request }) => {
        const body = await request.json();
        if (body.code === '000000') return problem(401, { title: 'bad', code: 'OTP_INVALID' });
        if (body.code === '111111')
          return HttpResponse.json({ challengeId: 'otp_1', requires: 'register' });
        return HttpResponse.json(tokens());
      })
    );
    const { auth, types } = make();
    expect((await settle(auth.verifyOtp({ challengeId: 'otp_1' }))).error).toBeInstanceOf(
      ValidationError
    );
    const bad = await settle(auth.verifyOtp({ challengeId: 'otp_1', code: '000000' }));
    expect(bad.error).toBeInstanceOf(AuthError);
    expect(bad.error.reason).toBe('otp_invalid');
    expect(await auth.verifyOtp({ challengeId: 'otp_1', code: '111111' })).toEqual({
      challengeId: 'otp_1',
      requires: 'register',
    });
    expect(auth.isAuthenticated()).toBe(false);
    expect(await auth.verifyOtp({ challengeId: 'otp_1', code: '123456' })).toEqual(USER);
    expect(auth.isAuthenticated()).toBe(true);
    expect(types()).toEqual(['auth:login']);
    auth.destroy();
  });
});

describe('providers', () => {
  it('getProviderUrl fetches the redirect URL with the query and loginWithProvider logs in', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.get(`${BASE}/v1/auth/providers/google/url`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' });
      }),
      msw.post(`${BASE}/v1/auth/providers/google/callback`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens());
      })
    );
    const { auth, types } = make();
    expect((await settle(auth.getProviderUrl('google', {}))).error).toBeInstanceOf(ValidationError);
    expect((await settle(auth.getProviderUrl('', { redirectUri: 'x' }))).error).toBeInstanceOf(
      ValidationError
    );
    const url = await auth.getProviderUrl('google', {
      redirectUri: 'https://ota.com/cb',
      state: 's1',
    });
    expect(url).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
    const q = new URL(calls[0].url).searchParams;
    expect(q.get('redirectUri')).toBe('https://ota.com/cb');
    expect(q.get('state')).toBe('s1');

    expect((await settle(auth.loginWithProvider({ provider: 'google' }))).error).toBeInstanceOf(
      ValidationError
    );
    const user = await auth.loginWithProvider({
      provider: 'google',
      code: 'c1',
      redirectUri: 'https://ota.com/cb',
    });
    expect(user).toEqual(USER);
    expect(calls[1].body).toEqual({ code: 'c1', redirectUri: 'https://ota.com/cb' });
    expect(types()).toEqual(['auth:login']);
    auth.destroy();
  });

  it('getProviderUrl rejects a payload without a URL', async () => {
    server.use(msw.get(`${BASE}/v1/auth/providers/apple/url`, () => HttpResponse.json({})));
    const { auth } = make();
    const r = await settle(auth.getProviderUrl('apple', { redirectUri: 'https://ota.com/cb' }));
    expect(r.error).toBeInstanceOf(SdkError);
    expect(r.error.code).toBe('PROVIDER_URL_MISSING');
  });
});

describe('magic link and MFA', () => {
  it('requestMagicLink / consumeMagicLink', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/magic-link`, async ({ request }) => {
        await record(request);
        return new HttpResponse(null, { status: 204 });
      }),
      msw.post(`${BASE}/v1/auth/magic-link/consume`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens());
      })
    );
    const { auth, types } = make();
    expect(
      (await settle(auth.requestMagicLink({ email: 'nope', redirectUri: 'x' }))).error
    ).toBeInstanceOf(ValidationError);
    await expect(
      auth.requestMagicLink({ email: 'ana@example.com', redirectUri: 'https://ota.com/ml' })
    ).resolves.toBeUndefined();
    expect(calls[0].body).toEqual({ email: 'ana@example.com', redirectUri: 'https://ota.com/ml' });
    expect((await settle(auth.consumeMagicLink(''))).error).toBeInstanceOf(ValidationError);
    expect(await auth.consumeMagicLink('ml_tok')).toEqual(USER);
    expect(calls[1].body).toEqual({ token: 'ml_tok' });
    expect(types()).toEqual(['auth:login']);
    auth.destroy();
  });

  it('mfa.verify completes the login', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/mfa/verify`, async ({ request }) => {
        await record(request);
        return HttpResponse.json(tokens());
      })
    );
    const { auth, seen } = make();
    expect((await settle(auth.mfa.verify({ challengeId: 'mfa_1' }))).error).toBeInstanceOf(
      ValidationError
    );
    const user = await auth.mfa.verify({ challengeId: 'mfa_1', code: '654321', method: 'totp' });
    expect(user).toEqual(USER);
    expect(calls[0].body).toEqual({ challengeId: 'mfa_1', code: '654321', method: 'totp' });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ type: 'auth:login', method: 'mfa' });
    auth.destroy();
  });
});

// ── logout ───────────────────────────────────────────────────────────────────────────────────────

describe('logout', () => {
  const SLICES = {
    account: { user: null, preferences: null },
    travelers: { profiles: [], loaded: false },
    trips: { byId: {} },
    wallet: { balance: null },
    alerts: { items: [] },
    search: { history: [] },
  };

  function populated() {
    const made = make({ withInterceptor: true, config: { auth: { tokenStorage: 'local' } } });
    for (const [name, initial] of Object.entries(SLICES)) {
      made.store.registerSlice(name, { initial });
    }
    made.store.set('account', { user: USER });
    made.store.set('travelers', { profiles: [{ id: 't1' }], loaded: true });
    made.store.set('trips', { byId: { b1: {} } });
    made.store.set('wallet', { balance: { amount: '1', currency: 'INR' } });
    made.store.set('alerts', { items: [{ id: 'a1' }] });
    made.store.set('search', { history: [{ id: 'h1' }] });
    return made;
  }

  it('calls the backend, aborts authed requests, resets the documented slices and clears storage', async () => {
    const { calls, record } = recorder();
    server.use(
      msw.post(`${BASE}/v1/auth/logout`, async ({ request }) => {
        await record(request);
        return new HttpResponse(null, { status: 204 });
      }),
      msw.get(`${BASE}/v1/trips`, async () => {
        await delay('infinite');
      })
    );
    const { auth, http, store, storage, session, types } = populated();
    auth.setTokens({ accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 60000 });
    storage.set('guestId', 'g_1');
    storage.set('guestToken', 'gt_1');
    const hanging = http.get('/v1/trips', { tag: 'authed' }).catch((e) => e);
    await flush();
    expect(http.inflight('authed')).toBe(1);

    await auth.logout({ everywhere: true });

    expect(calls[0].body).toEqual({ everywhere: true });
    expect(calls[0].headers.authorization).toBe('Bearer acc');
    expect(await hanging).toBeInstanceOf(AbortError);
    expect(http.inflight('authed')).toBe(0);
    expect(auth.getAccessToken()).toBeNull();
    expect(auth.getGuestToken()).toBeNull();
    expect(auth.isGuest()).toBe(false);
    expect(auth.getSessionId()).toBeNull();
    expect(storage.get('refreshToken')).toBeUndefined();
    expect(storage.get('guestId')).toBeUndefined();
    expect(storage.get('guestToken')).toBeUndefined();
    expect(session()).toEqual({
      status: 'anonymous',
      user: null,
      guestId: null,
      accessExpiresAt: null,
      claim: null,
    });
    for (const name of ['account', 'travelers', 'trips', 'wallet', 'alerts']) {
      expect(store.get(name)).toEqual(SLICES[name]);
    }
    expect(store.get('search')).toEqual({ history: [{ id: 'h1' }] });
    expect(types()).toEqual(['auth:login', 'auth:logout']);
    expect(await settle(auth.refresh())).toMatchObject({ ok: false });
  });

  it('is best effort: a failing backend call still logs out locally', async () => {
    server.use(msw.post(`${BASE}/v1/auth/logout`, () => problem(500, { title: 'boom' })));
    const { auth, session, types } = make();
    auth.setTokens({ accessToken: 'acc', refreshToken: 'ref' });
    await expect(auth.logout()).resolves.toBeUndefined();
    expect(auth.isAuthenticated()).toBe(false);
    expect(session().status).toBe('anonymous');
    expect(types()).toEqual(['auth:login', 'auth:logout']);
  });

  it('skips the network when nothing is logged in and validates options', async () => {
    const { auth, types } = make();
    await expect(auth.logout()).resolves.toBeUndefined();
    expect(types()).toEqual(['auth:logout']);
    expect((await settle(auth.logout({ everywhere: 'all' }))).error).toBeInstanceOf(
      ValidationError
    );
  });

  it('clears a scheduled refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { auth } = make({ now: () => Date.now() });
    auth.setTokens({ accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 60000 });
    expect(vi.getTimerCount()).toBe(1);
    server.use(msw.post(`${BASE}/v1/auth/logout`, () => new HttpResponse(null, { status: 204 })));
    await auth.logout();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── onChange / destroy / integration with the auth interceptor ───────────────────────────────────

describe('onChange and destroy', () => {
  it('notifies on session changes until off() or destroy()', async () => {
    const { auth, store } = make();
    const fn = vi.fn();
    const other = vi.fn();
    const off = auth.onChange(fn);
    auth.onChange(other);
    expect(() => auth.onChange('x')).toThrow(ValidationError);
    auth.setTokens({ accessToken: 'acc', user: USER });
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toMatchObject({ status: 'authenticated', user: USER });
    // unrelated slices do not notify
    store.registerSlice('prefs', { initial: { locale: 'en' } });
    store.set('prefs', { locale: 'fr' });
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    auth.clearTokens();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    auth.destroy();
    auth.setTokens({ accessToken: 'acc2' });
    await flush();
    expect(other).toHaveBeenCalledTimes(2);
    expect(auth.onChange(vi.fn())).toEqual(expect.any(Function));
  });

  it('a 401 on an authed request is recovered through the shared single-flight refresh', async () => {
    // Two different authed requests (identical GETs would be deduped by http) both hit a 401; the
    // interceptor calls auth.refresh() for each and the single flight makes that one request.
    const counts = { me: 0, trips: 0, refresh: 0 };
    const once401 = (name, body) => () => {
      counts[name] += 1;
      if (counts[name] === 1) return problem(401, { title: 'expired', code: 'SESSION_EXPIRED' });
      return HttpResponse.json(body);
    };
    server.use(
      msw.get(`${BASE}/v1/me`, once401('me', USER)),
      msw.get(`${BASE}/v1/trips`, once401('trips', { items: [] })),
      msw.post(`${BASE}/v1/auth/refresh`, async () => {
        counts.refresh += 1;
        await delay(10);
        return HttpResponse.json(tokens({ accessToken: 'acc_2' }));
      })
    );
    const { auth, http, types } = make({ withInterceptor: true });
    auth.setTokens({ accessToken: 'acc_1', refreshToken: 'ref_1' });
    const [a, b] = await Promise.all([
      http.get('/v1/me', { tag: 'authed' }),
      http.get('/v1/trips', { tag: 'authed' }),
    ]);
    expect(a.data).toEqual(USER);
    expect(b.data).toEqual({ items: [] });
    expect(counts).toEqual({ me: 2, trips: 2, refresh: 1 });
    expect(auth.getAccessToken()).toBe('acc_2');
    expect(types()).toEqual(['auth:login', 'auth:refreshed']);
    auth.destroy();
  });

  it('survives a throwing event listener and a broken storage', async () => {
    const events = createEmitter();
    const storage = {
      get: () => {
        throw new Error('down');
      },
      set: () => {
        throw new Error('down');
      },
      remove: () => {
        throw new Error('down');
      },
    };
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const store = createStore();
    const http = createHttp({ baseUrl: BASE, retries: 0 });
    const auth = createAuth({
      http,
      store,
      storage,
      events,
      logger,
      config: { auth: { tokenStorage: 'local' } },
    });
    events.on('auth:login', () => {
      throw new Error('listener boom');
    });
    expect(() => auth.setTokens({ accessToken: 'acc', refreshToken: 'ref' })).not.toThrow();
    expect(auth.isAuthenticated()).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    auth.destroy();
  });
});
