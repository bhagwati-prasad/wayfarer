// Tests for test/helpers/ctx.js: a real, network-free ModuleContext (and client) for module tests.
// Network goes through the MSW server of test/setup.js (handlers added per test with server.use);
// every context and client is destroyed after each test so no timer or listener leaks.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { http as msw, HttpResponse } from 'msw';
import { server } from '../setup.js';
import {
  createTestContext,
  createTestClient,
  TEST_BASE_URL,
  TEST_USER,
  TEST_TOKENS,
  TEST_GUEST,
} from './ctx.js';
import { MODULE_FACTORIES, registerModule } from '../../src/modules/index.js';
import { AbortError, AuthError, ConfigError, UnsupportedError } from '../../src/errors/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const BASE = 'https://api.ota.com';

/** @type {Array<{ destroy: () => void }>} */
const cleanup = [];

afterEach(() => {
  while (cleanup.length) {
    const c = cleanup.pop();
    try {
      c.destroy();
    } catch {
      // already destroyed
    }
  }
  vi.useRealTimers();
});

/** A test context destroyed automatically after the test. */
function make(options) {
  const t = createTestContext(options);
  cleanup.push(t);
  return t;
}

/** A test client destroyed automatically after the test. */
function makeClient(options) {
  const client = createTestClient(options);
  cleanup.push(client);
  return client;
}

/** Let the store's microtask batch (and one re-scheduled batch) deliver notifications. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Records every request a handler receives. */
function recorder() {
  const calls = [];
  const record = async (request) => {
    const entry = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: null,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
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

/** Serve `body` for `method` `path`, recording requests. */
function serve(method, path, body, { status = 200 } = {}) {
  const r = recorder();
  server.use(
    msw[method](`${BASE}${path}`, async ({ request }) => {
      await r.record(request);
      return HttpResponse.json(body, { status });
    })
  );
  return r;
}

/** A guest endpoint that records its calls. */
function serveGuest(identity = { guestId: 'g_1', guestToken: 'gt_1' }) {
  return serve('post', '/v1/sessions/guest', identity);
}

/** Resolve a promise and return `{ ok, value }` / `{ ok: false, error }` without throwing. */
async function settle(p) {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A minimal domain module the way docs/CONTRIBUTING.md §2 describes one. */
function createPlacesModule(ctx) {
  ctx.store.registerSlice('places', { initial: { items: [], status: 'idle' } });
  async function search(q, opts = {}) {
    ctx.store.set('places', (s) => ({ ...s, status: 'loading' }), { action: 'places/search' });
    const res = await ctx.http.get(ctx.endpoints.get('places.search'), {
      query: { q },
      tag: 'places',
      ...opts,
    });
    const items = Array.isArray(res.data) ? res.data : [];
    ctx.store.set('places', { items, status: 'ready' }, { action: 'places/loaded' });
    ctx.events.emit('places:loaded', { count: items.length });
    return items;
  }
  function current() {
    return ctx.store.get('places');
  }
  return ctx.access.wrap('places', { search, current, destroy() {} });
}

// ── surface ──────────────────────────────────────────────────────────────────────────────────────

describe('createTestContext · surface', () => {
  it('exports the helper, the client builder and the fixtures', () => {
    expect(typeof createTestContext).toBe('function');
    expect(typeof createTestClient).toBe('function');
    expect(TEST_BASE_URL).toBe('https://api.ota.com');
    expect(Object.isFrozen(TEST_USER)).toBe(true);
    expect(Object.isFrozen(TEST_TOKENS)).toBe(true);
    expect(Object.isFrozen(TEST_GUEST)).toBe(true);
  });

  it('returns the documented members around a frozen, complete ModuleContext', () => {
    const t = make();
    expect(Object.keys(t).sort()).toEqual(
      [
        'ctx',
        'http',
        'store',
        'events',
        'storage',
        'auth',
        'access',
        'endpoints',
        'config',
        'registry',
        'register',
        'emitted',
        'authenticateAs',
        'asGuest',
        'destroy',
      ].sort()
    );
    const { ctx } = t;
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.config).toBe(t.config);
    expect(ctx.http).toBe(t.http);
    expect(ctx.store).toBe(t.store);
    expect(ctx.events).toBe(t.events);
    expect(ctx.storage).toBe(t.storage);
    expect(ctx.auth).toBe(t.auth);
    expect(ctx.access).toBe(t.access);
    expect(ctx.endpoints).toBe(t.endpoints);
    for (const member of ['i18n', 'telemetry', 'logger', 'features', 'payments', 'modules']) {
      expect(ctx[member]).toBeDefined();
    }
    expect(typeof ctx.now()).toBe('number');
    for (const fn of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
      expect(typeof ctx.timers[fn]).toBe('function');
    }
    expect(ctx.logger.scope).toBe('test');
    expect(typeof ctx.i18n.t('search.title', {}, { default: 'x' })).toBe('string');
  });

  it('applies the quiet, network-free defaults on a memory storage', () => {
    const t = make();
    expect(Object.isFrozen(t.config)).toBe(true);
    expect(t.config.baseUrl).toBe('https://api.ota.com');
    expect(t.config.storage).toBe('local');
    expect(t.config.autoBootstrap).toBe(false);
    expect(t.config.retries).toBe(0);
    expect(t.config.logger.level).toBe('silent');
    expect(t.storage.driverName).toBe('memory');
    expect(t.storage.isAvailable()).toBe(true);
    // the core slices the client registers, plus auth's secret session slice
    expect(t.store.hasSlice('prefs')).toBe(true);
    expect(t.store.hasSlice('bootstrap')).toBe(true);
    expect(t.store.hasSlice('session')).toBe(true);
    expect(t.store.get('session')).toMatchObject({
      status: 'anonymous',
      user: null,
      guestId: null,
    });
    expect(t.store.get('prefs')).toMatchObject({ locale: null, currency: null, pricePer: 'pax' });
    expect(t.store.snapshot().slices).not.toHaveProperty('session');
    expect(t.endpoints.get('places.search')).toBe('/v1/places/search');
    expect(t.endpoints.get('auth.ensureGuestSession')).toBe('/v1/sessions/guest');
    expect(t.auth.isAuthenticated()).toBe(false);
    expect(t.auth.isGuest()).toBe(false);
    expect(t.access.levelOf('trips.list')).toBe('auth');
    expect(t.access.levelOf('booking.create')).toBe('guest');
    expect(t.access.levelOf('places.search')).toBe('open');
  });

  it('honours config (prefs, i18n, access policy, storage kind, logger scope name) on a memory driver', () => {
    const t = make({
      name: 'search',
      config: {
        locale: 'en-IN',
        currency: 'inr',
        market: 'IN',
        storage: 'session',
        access: { default: 'open', rules: { 'places.*': 'auth' } },
        features: { splitResults: true },
      },
    });
    expect(t.ctx.logger.scope).toBe('search');
    expect(t.config.storage).toBe('session');
    expect(t.storage.driverName).toBe('memory');
    expect(t.store.get('prefs')).toMatchObject({ locale: 'en-IN', currency: 'INR', market: 'IN' });
    expect(t.ctx.i18n.getLocale()).toBe('en-IN');
    expect(t.access.levelOf('places.search')).toBe('auth');
    // defineConfig deep-merges access.rules over the defaults, as createClient does
    expect(t.access.levelOf('booking.create')).toBe('guest');
    expect(t.ctx.features.isEnabled('splitResults')).toBe(true);
  });

  it('ships a null payments port unless one is injected', async () => {
    const t = make();
    expect(t.ctx.payments.isNull).toBe(true);
    const r = await settle(t.ctx.payments.methods('b_1'));
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(UnsupportedError);
    expect(r.error.feature).toBe('payments');
    expect(() => t.ctx.payments.gateways.get('stripe')).toThrow(UnsupportedError);
    expect(t.ctx.payments.gateways.list()).toEqual([]);

    const port = { methods: vi.fn(async () => []), clear() {} };
    const u = make({ payments: port });
    expect(u.ctx.payments).toBe(port);
  });

  it('rejects malformed options with ConfigError', () => {
    expect(() => createTestContext(null)).toThrow(ConfigError);
    expect(() => createTestContext({ modules: [] })).toThrow(ConfigError);
    expect(() => createTestContext({ fetch: 'nope' })).toThrow(ConfigError);
    expect(() => createTestContext({ now: 'later' })).toThrow(ConfigError);
    expect(() => createTestContext({ payments: 'stripe' })).toThrow(ConfigError);
    expect(() => createTestContext({ config: 'nope' })).toThrow(ConfigError);
    expect(() => createTestContext({ config: { baseUrl: 'not a url' } })).toThrow(ConfigError);
    expect(() => createTestContext({ guest: { guestId: 'g' } })).toThrow(ConfigError);
  });
});

// ── a module factory receives a working ctx ──────────────────────────────────────────────────────

describe('createTestContext · module factory', () => {
  it('lets a real factory register its slice, hit MSW, write state and emit events', async () => {
    const { calls } = serve('get', '/v1/places/search', [{ code: 'DEL' }, { code: 'BOM' }]);
    const t = make({ config: { locale: 'en-IN', currency: 'INR' } });
    const places = createPlacesModule(t.ctx);

    expect(t.store.get('places')).toEqual({ items: [], status: 'idle' });
    const items = await places.search('de');
    expect(items).toEqual([{ code: 'DEL' }, { code: 'BOM' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/places/search?q=de`);
    expect(places.current()).toEqual({ items, status: 'ready' });

    await flush();
    const types = t.emitted().map((e) => e.type);
    expect(types).toContain('http:request');
    expect(types).toContain('http:response');
    expect(types).toContain('places:loaded');
    expect(types).toContain('state:change');
    const loaded = t.emitted('places:loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].payload).toMatchObject({ type: 'places:loaded', count: 2 });
    expect(typeof loaded[0].payload.at).toBe('number');
    expect(t.emitted('places:*').map((e) => e.type)).toEqual(['places:loaded']);
  });

  it('maps a problem+json reply to the right SdkError before the module sees it', async () => {
    server.use(
      msw.get(`${BASE}/v1/places/search`, () =>
        HttpResponse.json(
          { status: 401, title: 'Unauthorized', code: 'UNAUTHENTICATED' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } }
        )
      )
    );
    const t = make();
    const places = createPlacesModule(t.ctx);
    const r = await settle(places.search('x'));
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.status).toBe(401);
  });
});

// ── http: MSW + default interceptors ─────────────────────────────────────────────────────────────

describe('createTestContext · http', () => {
  it('sends Accept-Language / X-Currency / X-Market from prefs and correlation headers', async () => {
    const { calls } = serve('get', '/v1/places/popular', { data: [] });
    const t = make({ config: { locale: 'en-IN', currency: 'INR', market: 'IN' } });
    const res = await t.http.get(t.endpoints.get('places.popular'));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const h = calls[0].headers;
    expect(h['accept-language']).toBe('en-IN');
    expect(h['x-currency']).toBe('INR');
    expect(h['x-market']).toBe('IN');
    expect(h['x-request-id']).toBeTruthy();
    expect(h.authorization).toBeUndefined();
  });

  it('follows prefs changes and adds the bearer token once authenticated', async () => {
    const { calls } = serve('get', '/v1/places/popular', []);
    const t = make();
    await t.http.get('/v1/places/popular');
    // nothing from the SDK while prefs are empty (Node's fetch adds its own `accept-language: *`)
    expect([undefined, '*']).toContain(calls[0].headers['accept-language']);
    expect(calls[0].headers['x-currency']).toBeUndefined();

    t.store.set('prefs', { locale: 'fr-FR', currency: 'EUR' }, { action: 'test' });
    t.authenticateAs();
    await t.http.get('/v1/places/popular');
    expect(calls[1].headers['accept-language']).toBe('fr-FR');
    expect(calls[1].headers['x-currency']).toBe('EUR');
    expect(calls[1].headers.authorization).toBe(`Bearer ${TEST_TOKENS.accessToken}`);
  });

  it('uses an injected fetch instead of the network', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const t = make({ fetch: fetchFn });
    const res = await t.http.get('/v1/places/popular');
    expect(res.data).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toBe(`${BASE}/v1/places/popular`);
  });
});

// ── access gating: 'auth' ────────────────────────────────────────────────────────────────────────

describe("createTestContext · access.wrap 'auth'", () => {
  it('rejects with AuthError, emits auth:required and never calls the function while anonymous', async () => {
    const t = make();
    const list = vi.fn(async () => ['t_1']);
    const trips = t.access.wrap('trips', { list, destroy() {} });

    const r = await settle(trips.list());
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(AuthError);
    expect(r.error.reason).toBe('unauthenticated');
    expect(r.error.key).toBe('trips.list');
    expect(list).not.toHaveBeenCalled();
    const required = t.emitted('auth:required');
    expect(required).toHaveLength(1);
    expect(required[0].payload).toMatchObject({ type: 'auth:required', key: 'trips.list' });
    expect(t.access.can('trips.list')).toBe(false);
  });

  it('authenticateAs() signs in through auth.setTokens without network', async () => {
    const t = make();
    const list = vi.fn(async () => ['t_1']);
    const trips = t.access.wrap('trips', { list, destroy() {} });

    const user = t.authenticateAs();
    expect(user).toEqual(TEST_USER);
    expect(t.auth.isAuthenticated()).toBe(true);
    expect(t.auth.getAccessToken()).toBe(TEST_TOKENS.accessToken);
    expect(t.auth.getUser()).toEqual(TEST_USER);
    expect(t.access.can('trips.list')).toBe(true);
    expect(t.emitted('auth:login')).toHaveLength(1);
    expect(t.emitted('auth:login')[0].payload).toMatchObject({ method: 'host' });
    await flush();
    expect(t.store.get('session')).toMatchObject({ status: 'authenticated', user: TEST_USER });

    await expect(trips.list()).resolves.toEqual(['t_1']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('accepts a custom user and tokens, and the authenticated option starts signed in', async () => {
    const other = { ...TEST_USER, id: 'u_2', email: 'two@example.com' };
    const t = make();
    t.authenticateAs(other, { accessToken: 'acc_2', refreshToken: null });
    expect(t.auth.getUser()).toEqual(other);
    expect(t.auth.getAccessToken()).toBe('acc_2');

    const u = make({ authenticated: true });
    expect(u.auth.isAuthenticated()).toBe(true);
    expect(u.auth.getUser()).toEqual(TEST_USER);
    await flush();
    expect(u.store.get('session').status).toBe('authenticated');
    // the sign-in happened while the starting state was built: not part of the recording
    expect(u.emitted('auth:*')).toEqual([]);
  });
});

// ── access gating: 'guest' ───────────────────────────────────────────────────────────────────────

describe("createTestContext · access.wrap 'guest'", () => {
  it('creates the guest session through the mocked POST /v1/sessions/guest, once', async () => {
    const { calls } = serveGuest({ guestId: 'g_1', guestToken: 'gt_1' });
    const t = make();
    const create = vi.fn(async (x) => `created:${x}`);
    const booking = t.access.wrap('booking', { create, destroy() {} });

    await expect(booking.create('a')).resolves.toBe('created:a');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(t.auth.isGuest()).toBe(true);
    expect(t.auth.getGuestToken()).toBe('gt_1');
    expect(t.auth.getSessionId()).toBe('g_1');
    expect(t.storage.get('guestId')).toBe('g_1');
    expect(t.storage.get('guestToken')).toBe('gt_1');
    expect(t.emitted('auth:guest')).toHaveLength(1);
    expect(t.emitted('auth:guest')[0].payload).toMatchObject({ guestId: 'g_1', reused: false });
    await flush();
    expect(t.store.get('session')).toMatchObject({ status: 'guest', guestId: 'g_1' });

    // the identity is reused: no second request
    await expect(booking.create('b')).resolves.toBe('created:b');
    expect(calls).toHaveLength(1);
  });

  it('asGuest() installs the guest identity without any network request', async () => {
    const { calls } = serveGuest();
    const { calls: popular } = serve('get', '/v1/places/popular', []);
    const t = make();

    const g = await t.asGuest();
    expect(g).toEqual(TEST_GUEST);
    expect(calls).toHaveLength(0);
    expect(t.auth.isGuest()).toBe(true);
    expect(t.auth.getGuestToken()).toBe(TEST_GUEST.guestToken);
    expect(t.storage.get('guestId')).toBe(TEST_GUEST.guestId);
    expect(t.storage.get('guestToken')).toBe(TEST_GUEST.guestToken);
    expect(t.emitted('auth:guest')).toHaveLength(1);
    await flush();
    expect(t.store.get('session')).toMatchObject({ status: 'guest', guestId: TEST_GUEST.guestId });

    // a 'guest' function now calls through directly
    const create = vi.fn(async () => 'ok');
    const booking = t.access.wrap('booking', { create, destroy() {} });
    await expect(booking.create()).resolves.toBe('ok');
    expect(calls).toHaveLength(0);

    // the configured fetch is back in place: ordinary requests reach MSW again
    await t.http.get('/v1/places/popular');
    expect(popular).toHaveLength(1);
  });

  it('asGuest() takes a custom identity, keeps an existing one and clears an authenticated session', async () => {
    const t = make();
    expect(await t.asGuest({ guestId: 'g_9', guestToken: 'gt_9' })).toEqual({
      guestId: 'g_9',
      guestToken: 'gt_9',
    });
    // already a guest: the current identity stays, no handshake
    expect(await t.asGuest()).toEqual({ guestId: 'g_9', guestToken: 'gt_9' });
    expect(t.emitted('auth:guest')).toHaveLength(1);

    const u = make({ authenticated: true });
    expect(u.auth.isAuthenticated()).toBe(true);
    await u.asGuest();
    expect(u.auth.isAuthenticated()).toBe(false);
    expect(u.auth.isGuest()).toBe(true);
    expect(u.emitted('auth:guest')).toHaveLength(1);
  });

  it('asGuest() works under fake timers and keeps an injected fetch for other requests', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const t = make({ fetch: fetchFn });
    await t.asGuest();
    expect(t.auth.isGuest()).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    await t.http.get('/v1/places/popular');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('the guest option seeds storage so createAuth restores the identity at creation', async () => {
    const t = make({ guest: true });
    expect(t.auth.isGuest()).toBe(true);
    expect(t.auth.getSessionId()).toBe(TEST_GUEST.guestId);
    expect(t.auth.getGuestToken()).toBe(TEST_GUEST.guestToken);
    expect(t.storage.get('guestId')).toBe(TEST_GUEST.guestId);
    expect(t.emitted('auth:*')).toEqual([]);
    await flush();
    expect(t.store.get('session')).toMatchObject({ status: 'guest', guestId: TEST_GUEST.guestId });

    const u = make({ guest: { guestId: 'g_7', guestToken: 'gt_7' } });
    expect(u.auth.getSessionId()).toBe('g_7');
    expect(await u.asGuest()).toEqual({ guestId: 'g_7', guestToken: 'gt_7' });
  });
});

// ── module registry ──────────────────────────────────────────────────────────────────────────────

describe('createTestContext · ctx.modules', () => {
  it('resolves stubs and runs factories lazily, once, with the same ctx', () => {
    const offers = { get: vi.fn(() => 'offer') };
    const factory = vi.fn((c) => ({ me: c, destroy: vi.fn() }));
    const t = make({ modules: { offers, sibling: factory } });
    const { ctx } = t;

    expect(factory).not.toHaveBeenCalled();
    expect(Object.keys(ctx.modules).sort()).toEqual(['offers', 'sibling']);
    expect('offers' in ctx.modules).toBe(true);
    expect(ctx.modules.offers).toBe(offers);
    expect(ctx.modules.offers.get()).toBe('offer');
    expect(ctx.modules.nope).toBeUndefined();

    const api = ctx.modules.sibling;
    expect(api.me).toBe(ctx);
    expect(ctx.modules.sibling).toBe(api);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(t.registry.sibling).toBe(api);

    t.destroy();
    expect(api.destroy).toHaveBeenCalledTimes(1);
  });

  it('is settable after creation through register()', () => {
    const t = make();
    expect(t.ctx.modules.late).toBeUndefined();
    t.register('late', { x: 1 });
    expect(t.ctx.modules.late.x).toBe(1);
    t.register('late', (c) => ({ x: 2, cfg: c.config }));
    expect(t.ctx.modules.late.x).toBe(2);
    expect(t.ctx.modules.late.cfg).toBe(t.config);
    expect(() => t.register('bad name', {})).toThrow(ConfigError);
    expect(() => t.register('__proto__', {})).toThrow(ConfigError);
    expect(() => t.register('x', 'nope')).toThrow(ConfigError);
  });

  it('reports a factory that returns no object or reads itself inside its body', () => {
    const t = make({
      modules: {
        empty: () => null,
        loop: (c) => ({ self: c.modules.loop }),
      },
    });
    expect(() => t.ctx.modules.empty).toThrow(ConfigError);
    expect(() => t.ctx.modules.loop).toThrow(ConfigError);
  });
});

// ── timers and clock ─────────────────────────────────────────────────────────────────────────────

describe('createTestContext · timers, clock, destroy', () => {
  it('fake timers flow through ctx.timers', () => {
    vi.useFakeTimers();
    const t = make();
    const once = vi.fn();
    const tick = vi.fn();
    t.ctx.timers.setTimeout(once, 1000);
    const interval = t.ctx.timers.setInterval(tick, 500);
    vi.advanceTimersByTime(999);
    expect(once).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(once).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(2);
    t.ctx.timers.clearInterval(interval);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('accepts injected timers and an injectable clock', () => {
    const custom = {
      setTimeout: vi.fn(() => 'h'),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => 'i'),
      clearInterval: vi.fn(),
    };
    const t = make({ timers: custom, now: 1700000000000 });
    expect(t.ctx.timers.setTimeout).toBe(custom.setTimeout);
    expect(t.ctx.timers.clearInterval).toBe(custom.clearInterval);
    expect(t.ctx.now()).toBe(1700000000000);
    t.events.emit('tick', { n: 1 });
    expect(t.emitted('tick')[0].payload.at).toBe(1700000000000);

    let ms = 5;
    const u = make({ now: () => ms });
    expect(u.ctx.now()).toBe(5);
    ms = 6;
    expect(u.ctx.now()).toBe(6);
  });

  it('destroy() clears module, auth and store timers, listeners and in-flight work', async () => {
    vi.useFakeTimers();
    const t = make({
      modules: {
        poller: (c) => {
          const handle = c.timers.setInterval(() => {}, 1000);
          c.store.registerSlice('poller', { initial: { n: 0 }, persist: true });
          return { destroy: () => c.timers.clearInterval(handle) };
        },
      },
    });
    expect(t.ctx.modules.poller).toBeDefined();
    t.store.set('poller', { n: 1 }, { action: 'poller/bump' }); // debounced persistence write
    t.authenticateAs(TEST_USER, { expiresAt: Date.now() + 3_600_000 }); // proactive refresh timer
    t.events.on('anything', () => {});
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(t.events.listenerCount()).toBeGreaterThan(0);

    t.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.events.listenerCount()).toBe(0);
    expect(t.http.inflight()).toBe(0);
    const r = await settle(t.http.get('/v1/places/popular'));
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(AbortError);
    t.destroy(); // idempotent
  });
});

// ── createTestClient ─────────────────────────────────────────────────────────────────────────────

describe('createTestClient', () => {
  it('builds a real client with the given module factories and quiet defaults', async () => {
    const destroy = vi.fn();
    const client = makeClient({
      modules: {
        echo: (ctx) => ({ say: (x) => x, scope: ctx.logger.scope, destroy }),
      },
    });
    expect(client.echo.say('x')).toBe('x');
    expect(client.echo.scope).toBe('echo');
    const cfg = client.getConfig();
    expect(cfg.baseUrl).toBe('https://api.ota.com');
    expect(cfg.autoBootstrap).toBe(false);
    expect(cfg.storage).toBe('memory');
    expect(cfg.retries).toBe(0);
    expect(cfg.logger.level).toBe('silent');
    await expect(client.ready).resolves.toBe(client);
    client.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('merges modules over MODULE_FACTORIES and can isolate the named ones', () => {
    expect(MODULE_FACTORIES).toEqual({});
    const unregister = registerModule('tmp', () => ({ who: 'registry', destroy() {} }));
    try {
      expect(makeClient().tmp.who).toBe('registry');
      const b = makeClient({ modules: { tmp: () => ({ who: 'override', destroy() {} }) } });
      expect(b.tmp.who).toBe('override');
      const c = makeClient({ modules: { tmp: null } });
      expect(c.tmp).toBeUndefined();
      const d = makeClient({ isolate: true, modules: { echo: () => ({ destroy() {} }) } });
      expect(d.tmp).toBeUndefined();
      expect(d.echo).toBeDefined();
      const e = makeClient({ isolate: true });
      expect(e.tmp).toBeUndefined();
    } finally {
      unregister();
    }
    expect(MODULE_FACTORIES).toEqual({});
  });

  it('passes config through, keeps the silent level under a custom logger and validates options', async () => {
    const entries = [];
    const client = makeClient({
      config: { locale: 'en-IN', currency: 'INR', logger: { sink: (e) => entries.push(e) } },
    });
    expect(client.getPrefs()).toMatchObject({ locale: 'en-IN', currency: 'INR' });
    expect(client.getConfig().logger.level).toBe('silent');
    const { calls } = serve('get', '/v1/places/popular', []);
    await client.http.get('/v1/places/popular');
    expect(calls[0].headers['accept-language']).toBe('en-IN');
    expect(calls[0].headers['x-currency']).toBe('INR');
    expect(entries).toEqual([]);

    expect(() => createTestClient(null)).toThrow(ConfigError);
    expect(() => createTestClient({ modules: [] })).toThrow(ConfigError);
    expect(() => createTestClient({ config: 'nope' })).toThrow(ConfigError);
    expect(() => createTestClient({ modules: { http: () => ({}) } })).toThrow(ConfigError);
  });
});
