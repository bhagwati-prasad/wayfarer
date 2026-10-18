// Tests for src/core/client.js (composition root), src/core/context.js (ModuleContext builder),
// src/modules/index.js (factory registry), src/utils/index.js and src/index.js (entries). Network
// goes through the MSW server of test/setup.js (handlers added per test with server.use), storage is
// the memory driver unless a test says otherwise, and every client is destroyed after each test so
// no timer or listener leaks between tests.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { http as msw, HttpResponse, delay } from 'msw';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../setup.js';
import { createClient, VERSION } from '../../src/core/client.js';
import { createContext } from '../../src/core/context.js';
import { MODULE_FACTORIES, registerModule } from '../../src/modules/index.js';
import { DEFAULTS } from '../../src/core/config.js';
import * as sdk from '../../src/index.js';
import * as utils from '../../src/utils/index.js';
import {
  AbortError,
  ConfigError,
  NotFoundError,
  SdkError,
  UnsupportedError,
  ValidationError,
} from '../../src/errors/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const BASE = 'https://api.ota.com';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {Array<{ destroy: () => void }>} */
const clients = [];

afterEach(() => {
  while (clients.length) {
    const c = clients.pop();
    try {
      c.destroy();
    } catch {
      // already destroyed
    }
  }
  vi.useRealTimers();
});

/** A client with quiet, network-free defaults; destroyed automatically after the test. */
function make(overrides = {}) {
  const client = createClient({
    autoBootstrap: false,
    storage: 'memory',
    retries: 0,
    logger: { level: 'silent' },
    ...overrides,
  });
  clients.push(client);
  return client;
}

/** A logger sink capturing every entry. */
function sink() {
  const entries = [];
  const fn = (entry) => entries.push(entry);
  return { entries, fn, warns: () => entries.filter((e) => e.level === 'warn') };
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

/** Serve `body` for GET `path`, recording requests. */
function serve(path, body, { status = 200 } = {}) {
  const r = recorder();
  server.use(
    msw.get(`${BASE}${path}`, async ({ request }) => {
      await r.record(request);
      return HttpResponse.json(body, { status });
    })
  );
  return r;
}

/** Let the store's microtask batch (and one re-scheduled batch) deliver notifications. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** A custom StorageAdapter kept in a Map (shared between clients in a test). */
function mapAdapter() {
  const map = new Map();
  return {
    name: 'test-map',
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    keys: () => Array.from(map.keys()),
  };
}

/** Record every event of a namespace. */
function recordEvents(client, pattern = '*') {
  const seen = [];
  client.on(pattern, (e) => seen.push(e));
  return { seen, types: () => seen.map((e) => e.type) };
}

const BOOTSTRAP_DOC = {
  flags: { splitResults: true, layout: 'b', maxLegs: 6 },
  limits: { maxPax: 9, maxLegs: 6 },
  markets: ['IN', 'AE'],
  currencies: ['INR', 'AED'],
  paymentMethods: [{ type: 'card' }, { type: 'upi' }],
  version: '2026.10',
  defaults: { locale: 'hi-IN', currency: 'inr', market: 'IN' },
  minAppVersion: '1.2.0',
};

// ── composition ──────────────────────────────────────────────────────────────────────────────────

describe('createClient — composition', () => {
  it('exposes every documented namespace, the version and a frozen config', () => {
    const client = make({ apiKey: 'pk_1', clientId: 'app_1' });
    for (const ns of [
      'http',
      'auth',
      'access',
      'store',
      'events',
      'storage',
      'i18n',
      'telemetry',
      'features',
      'logger',
      'endpoints',
      'payments',
      'utils',
    ]) {
      expect(client[ns], ns).toBeTruthy();
    }
    expect(client.version).toBe(VERSION);
    expect(client.version).toBe(sdk.VERSION);
    expect(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version).toBe(VERSION);
    const cfg = client.getConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(cfg.baseUrl).toBe(DEFAULTS.baseUrl);
    expect(cfg.apiKey).toBe('pk_1');
    expect(cfg.autoBootstrap).toBe(false);
    expect(client.utils).toBe(utils);
    expect(typeof client.utils.formatMoney).toBe('function');
    expect(typeof client.utils.money.add).toBe('function');
    expect(typeof client.isDestroyed).toBe('function');
    expect(client.isDestroyed()).toBe(false);
  });

  it('accepts no config at all (defaults, local storage falling back to memory under Node)', async () => {
    const logs = sink();
    const client = createClient({
      autoBootstrap: false,
      retries: 0,
      logger: { level: 'warn', sink: logs.fn },
    });
    clients.push(client);
    expect(client.getConfig().storage).toBe('local');
    expect(client.storage.driverName).toBe('memory');
    expect(client.storage.isAvailable()).toBe(false);
    expect(logs.warns().some((e) => /storage/.test(e.msg))).toBe(true);
    await client.ready;
  });

  it('registers the prefs, bootstrap and session slices with their documented initial state', () => {
    const client = make();
    expect(client.store.hasSlice('prefs')).toBe(true);
    expect(client.store.hasSlice('bootstrap')).toBe(true);
    expect(client.store.hasSlice('session')).toBe(true);
    expect(client.getPrefs()).toEqual({
      locale: null,
      currency: null,
      market: null,
      homeAirport: null,
      pricePer: 'pax',
      hour12: null,
    });
    expect(client.store.get('bootstrap')).toEqual({
      loaded: false,
      flags: {},
      limits: {},
      markets: [],
      currencies: [],
      paymentMethods: [],
      version: null,
    });
    expect(client.store.get('session.status')).toBe('anonymous');
  });

  it('seeds prefs from config (locale canonicalised, currency upper-cased) and i18n follows', () => {
    const client = make({ locale: 'en-in', currency: 'inr', market: 'IN' });
    expect(client.getPrefs()).toMatchObject({ locale: 'en-IN', currency: 'INR', market: 'IN' });
    expect(client.i18n.getLocale()).toBe('en-IN');
    expect(client.getConfig().currency).toBe('INR');
  });

  it('rejects an invalid configuration with ConfigError carrying issues', () => {
    expect(() => createClient({ baseUrl: 'not a url' })).toThrow(ConfigError);
    expect(() => createClient({ baseUrl: 'not a url' })).toThrow(/baseUrl/);
    expect(() => createClient(42)).toThrow(ConfigError);
    expect(() => createClient({ autoBootstrap: false, modules: [] })).toThrow(ConfigError);
    try {
      createClient({ timeoutMs: -1, storage: 'memory' });
    } catch (e) {
      expect(e).toBeInstanceOf(SdkError);
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });

  it('seeds the client.bootstrap endpoint and honours a config override', () => {
    const client = make();
    expect(client.endpoints.has('client.bootstrap')).toBe(true);
    expect(client.endpoints.get('client.bootstrap')).toBe('/v1/config');
    expect(client.endpoints.all()['client.bootstrap']).toEqual({
      method: 'GET',
      path: '/v1/config',
    });
    const overridden = make({ endpoints: { 'client.bootstrap': '/v2/runtime-config' } });
    expect(overridden.endpoints.get('client.bootstrap')).toBe('/v2/runtime-config');
    expect(overridden.endpoints.get('search.create')).toBe('/v2/shopping/flight-offers');
  });

  it('wires the access policy from config over the defaults', () => {
    const client = make({ access: { rules: { 'search.*': 'auth' } } });
    expect(client.access.levelOf('booking.create')).toBe('guest');
    expect(client.access.levelOf('search.create')).toBe('auth');
    expect(client.access.levelOf('places.search')).toBe('open');
  });

  it('wires auth onto the shared store, storage and events', async () => {
    const client = make();
    const events = recordEvents(client, 'auth:*');
    client.auth.setTokens({ accessToken: 'acc_1', expiresAt: Date.now() + 3_600_000 });
    expect(client.auth.isAuthenticated()).toBe(true);
    expect(client.store.get('session.status')).toBe('authenticated');
    expect(events.types()).toContain('auth:login');
    expect(client.snapshot().store.slices.session).toBeUndefined();
  });
});

// ── http wiring ──────────────────────────────────────────────────────────────────────────────────

describe('createClient — http wiring', () => {
  it('installs the default interceptors: locale, api key, correlation, device and client id headers', async () => {
    const client = make({
      apiKey: 'pk_test',
      clientId: 'app_42',
      locale: 'en-IN',
      currency: 'INR',
      market: 'IN',
    });
    const r = serve('/v1/ping', { ok: true });
    const res = await client.http.get('/v1/ping');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect(r.calls).toHaveLength(1);
    const h = r.calls[0].headers;
    expect(h['accept-language']).toBe('en-IN');
    expect(h['x-currency']).toBe('INR');
    expect(h['x-market']).toBe('IN');
    expect(h['x-api-key']).toBe('pk_test');
    expect(h['x-client-id']).toBe('app_42');
    expect(h['x-request-id']).toBeTruthy();
    expect(h['x-client-session']).toBeTruthy();
    expect(h['x-device-id']).toBeTruthy();
    expect(h.authorization).toBeUndefined();
    // The generated device id is persisted so later requests reuse it.
    expect(client.storage.get('deviceId')).toBe(h['x-device-id']);
    await client.http.get('/v1/ping');
    expect(r.calls[1].headers['x-device-id']).toBe(h['x-device-id']);
    expect(r.calls[1].headers['x-request-id']).not.toBe(h['x-request-id']);
  });

  it('sends no locale / currency / market headers while prefs are undecided', async () => {
    const client = make();
    const r = serve('/v1/ping', {});
    await client.http.get('/v1/ping');
    const h = r.calls[0].headers;
    // Node's fetch adds `accept-language: *` of its own; the SDK must not have set a locale.
    expect(['*', undefined]).toContain(h['accept-language']);
    expect(h['x-currency']).toBeUndefined();
    expect(h['x-market']).toBeUndefined();
    expect(h['x-api-key']).toBeUndefined();
  });

  it('attaches the bearer token through the auth interceptor once tokens are set', async () => {
    const client = make();
    client.auth.setTokens({ accessToken: 'acc_1', expiresAt: Date.now() + 3_600_000 });
    const r = serve('/v1/me', { id: 'u_1' });
    await client.http.get('/v1/me');
    expect(r.calls[0].headers.authorization).toBe('Bearer acc_1');
  });

  it('maps problem+json responses to the SdkError taxonomy (problem interceptor)', async () => {
    const client = make();
    server.use(
      msw.get(`${BASE}/v1/missing`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Not found', status: 404, detail: 'gone' },
          { status: 404, headers: { 'content-type': 'application/problem+json' } }
        )
      )
    );
    const err = await client.http.get('/v1/missing').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.problem.detail).toBe('gone');
  });

  it('registers config.interceptors and config.hooks', async () => {
    const beforeRequest = vi.fn();
    const onStateChange = vi.fn();
    const onAuthExpired = vi.fn();
    const onTokenRefreshed = vi.fn();
    const client = make({
      interceptors: {
        request: [
          (spec) => {
            spec.headers = { ...(spec.headers || {}), 'X-Host': 'yes' };
            return spec;
          },
        ],
        response: [(res) => ({ ...res, data: { ...res.data, touched: true } })],
      },
      hooks: { beforeRequest, onStateChange, onAuthExpired, onTokenRefreshed },
    });
    const r = serve('/v1/ping', { ok: true });
    const res = await client.http.get('/v1/ping');
    expect(r.calls[0].headers['x-host']).toBe('yes');
    expect(res.data).toEqual({ ok: true, touched: true });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(beforeRequest.mock.calls[0][0].spec.path).toBe('/v1/ping');

    client.setCurrency('USD');
    await flush();
    expect(onStateChange).toHaveBeenCalled();
    // documented as onStateChange(change); state and the previous state follow
    const call = onStateChange.mock.calls.find(([c]) => c.actions.includes('prefs/setCurrency'));
    expect(call).toBeTruthy();
    const [change, state, prev] = call;
    expect(change.slices).toContain('prefs');
    expect(state.prefs.currency).toBe('USD');
    expect(prev.prefs.currency).toBeNull();

    client.events.emit('auth:expired', { reason: 'test' });
    client.events.emit('auth:refreshed', { expiresAt: null });
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(onAuthExpired.mock.calls[0][0].type).toBe('auth:expired');
    expect(onTokenRefreshed).toHaveBeenCalledTimes(1);
  });

  it('uses the injected fetch and emits http:* events on the client bus', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ via: 'mock' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = make({ fetch: fetchMock, baseUrl: 'https://example.test' });
    const events = recordEvents(client, 'http:*');
    const res = await client.http.get('/v1/x', { query: { a: 1 } });
    expect(res.data).toEqual({ via: 'mock' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0].url || fetchMock.mock.calls[0][0])).toContain(
      'https://example.test/v1/x?a=1'
    );
    expect(events.types()).toEqual(['http:request', 'http:response']);
  });
});

// ── preferences ──────────────────────────────────────────────────────────────────────────────────

describe('createClient — preferences', () => {
  it('setLocale updates prefs, i18n and the Accept-Language header, and emits prefs:change', async () => {
    const client = make({ locale: 'en-IN' });
    const events = recordEvents(client, 'prefs:change');
    client.setLocale('hi-in');
    expect(client.getPrefs().locale).toBe('hi-IN');
    expect(client.i18n.getLocale()).toBe('hi-IN');
    expect(events.seen).toHaveLength(1);
    expect(events.seen[0]).toMatchObject({
      type: 'prefs:change',
      changed: ['locale'],
      previous: { locale: 'en-IN' },
      prefs: { locale: 'hi-IN' },
    });
    expect(typeof events.seen[0].at).toBe('number');
    const r = serve('/v1/ping', {});
    await client.http.get('/v1/ping');
    expect(r.calls[0].headers['accept-language']).toBe('hi-IN');
  });

  it('setCurrency upper-cases and validates; setMarket trims; unchanged values emit nothing', () => {
    const client = make();
    const events = recordEvents(client, 'prefs:change');
    client.setCurrency('usd');
    client.setMarket(' AE ');
    expect(client.getPrefs()).toMatchObject({ currency: 'USD', market: 'AE' });
    expect(events.types()).toEqual(['prefs:change', 'prefs:change']);
    client.setCurrency('USD');
    client.setMarket('AE');
    expect(events.seen).toHaveLength(2);
    expect(() => client.setCurrency('rupees')).toThrow(ValidationError);
    expect(() => client.setCurrency('')).toThrow(ValidationError);
    expect(() => client.setLocale('')).toThrow(ValidationError);
    expect(() => client.setLocale(null)).toThrow(ValidationError);
    expect(() => client.setMarket('   ')).toThrow(ValidationError);
    try {
      client.setCurrency('x');
    } catch (e) {
      expect(e.issues[0].path).toBe('currency');
    }
    expect(client.getPrefs()).toMatchObject({ currency: 'USD', market: 'AE' });
  });

  it('a direct client.i18n.setLocale() flows back into prefs exactly once', () => {
    const client = make({ locale: 'en' });
    const events = recordEvents(client, 'prefs:change');
    client.i18n.setLocale('fr');
    expect(client.getPrefs().locale).toBe('fr');
    expect(events.seen).toHaveLength(1);
    expect(events.seen[0].changed).toEqual(['locale']);
  });

  it('persists prefs through the configured storage so a later client restores them', async () => {
    const adapter = mapAdapter();
    const first = make({ storage: adapter });
    first.setCurrency('USD');
    first.setLocale('de-DE');
    await flush();
    first.destroy();
    expect(Array.from(adapter.map.keys()).some((k) => /prefs/.test(k))).toBe(true);

    const second = make({ storage: adapter });
    expect(second.getPrefs()).toMatchObject({ currency: 'USD', locale: 'de-DE' });
    expect(second.i18n.getLocale()).toBe('de-DE');

    // Explicit config values are authoritative; the persisted copy fills the gaps.
    const third = make({ storage: adapter, currency: 'EUR' });
    expect(third.getPrefs()).toMatchObject({ currency: 'EUR', locale: 'de-DE' });
  });

  it('getPrefs returns the frozen store slice', () => {
    const client = make({ locale: 'en' });
    const prefs = client.getPrefs();
    expect(Object.isFrozen(prefs)).toBe(true);
    expect(prefs).toBe(client.store.get('prefs'));
  });

  it('malformed persisted prefs are coerced on hydration and never reach the headers', async () => {
    const adapter = mapAdapter();
    const first = make({ storage: adapter });
    first.setCurrency('USD');
    first.setMarket('IN');
    await flush();
    first.destroy();
    const [key, raw] = Array.from(adapter.map.entries()).find(([k]) => /prefs/.test(k));
    expect(raw).toContain('"USD"');
    // Tampered storage: a number where a currency code belongs, an empty market, a junk pricePer.
    adapter.map.set(
      key,
      raw.replace('"USD"', '42').replace('"IN"', '""').replace('"pax"', '"whatever"')
    );
    const second = make({ storage: adapter });
    expect(second.getPrefs()).toEqual({
      locale: null,
      currency: null,
      market: null,
      homeAirport: null,
      pricePer: 'pax',
      hour12: null,
    });
    const r = serve('/v1/ping', {});
    await second.http.get('/v1/ping');
    expect(r.calls[0].headers['x-currency']).toBeUndefined();
    expect(r.calls[0].headers['x-market']).toBeUndefined();
  });
});

// ── bootstrap ────────────────────────────────────────────────────────────────────────────────────

describe('createClient — bootstrap', () => {
  it('bootstrap() fetches GET /v1/config, fills state, flags and prefs gaps and emits events', async () => {
    const client = make({ currency: 'AED' });
    const r = serve('/v1/config', BOOTSTRAP_DOC);
    const events = recordEvents(client);
    const doc = await client.bootstrap();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe(`${BASE}/v1/config`);
    expect(doc).toMatchObject({
      flags: { splitResults: true, layout: 'b', maxLegs: '6' },
      limits: { maxPax: 9 },
      markets: ['IN', 'AE'],
      version: '2026.10',
      minAppVersion: '1.2.0',
      defaults: { locale: 'hi-IN', currency: 'INR', market: 'IN' },
    });
    expect(client.store.get('bootstrap')).toMatchObject({
      loaded: true,
      flags: { splitResults: true, layout: 'b', maxLegs: '6' },
      limits: { maxPax: 9, maxLegs: 6 },
      currencies: ['INR', 'AED'],
      paymentMethods: [{ type: 'card' }, { type: 'upi' }],
      version: '2026.10',
    });
    expect(client.store.get('bootstrap.defaults')).toBeUndefined();
    expect(client.features.isEnabled('splitResults')).toBe(true);
    expect(client.features.variant('layout')).toBe('b');
    // prefs: gaps filled, the configured currency kept
    expect(client.getPrefs()).toMatchObject({ locale: 'hi-IN', currency: 'AED', market: 'IN' });
    expect(client.i18n.getLocale()).toBe('hi-IN');
    const types = events.types();
    expect(types).toContain('bootstrap:loaded');
    expect(types).toContain('features:change');
    expect(types).toContain('prefs:change');
    expect(types.indexOf('prefs:change')).toBeLessThan(types.indexOf('bootstrap:loaded'));
    const loaded = events.seen.find((e) => e.type === 'bootstrap:loaded');
    expect(loaded.config.version).toBe('2026.10');
  });

  it('drops reserved / malformed flags and invalid defaults from the document instead of failing half-way', async () => {
    const client = make();
    // Raw JSON so the parsed document carries an own `__proto__` key (JSON.parse creates one).
    server.use(
      msw.get(
        `${BASE}/v1/config`,
        () =>
          new HttpResponse(
            '{"flags":{"__proto__":true,"ok":true,"n":3,"bad":[1],"constructor":"x"},' +
              '"limits":[],"markets":"IN","version":2026,' +
              '"locale":"de","currency":"rupees","market":"DE","__proto__":{"polluted":true}}',
            { headers: { 'content-type': 'application/json' } }
          )
      )
    );
    const events = recordEvents(client);
    const doc = await client.bootstrap();
    expect(doc.flags).toEqual({ ok: true, n: '3' });
    expect(doc.limits).toEqual({});
    expect(doc.markets).toEqual([]);
    expect(doc.version).toBeNull();
    // top-level locale / currency / market are an accepted defaults source; bad codes are ignored
    expect(doc.defaults).toEqual({ locale: 'de', market: 'DE' });
    expect(client.getPrefs()).toMatchObject({ locale: 'de', currency: null, market: 'DE' });
    expect(client.i18n.getLocale()).toBe('de');
    expect(client.store.get('bootstrap')).toMatchObject({
      loaded: true,
      flags: { ok: true, n: '3' },
    });
    expect(Object.keys(client.store.get('bootstrap'))).not.toContain('__proto__');
    expect(client.features.isEnabled('ok')).toBe(true);
    expect(client.features.get('bad')).toBeUndefined();
    expect(events.types()).toContain('bootstrap:loaded');
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
  });

  it('destroy() during a bootstrap aborts it quietly: AbortError, no warning, no state, no client:ready', async () => {
    const logs = sink();
    server.use(
      msw.get(`${BASE}/v1/config`, async () => {
        await delay(50);
        return HttpResponse.json(BOOTSTRAP_DOC);
      })
    );
    const client = make({ autoBootstrap: true, logger: { level: 'warn', sink: logs.fn } });
    const ready = vi.fn();
    const loaded = vi.fn();
    client.on('client:ready', ready);
    client.on('bootstrap:loaded', loaded);
    const own = client.bootstrap();
    client.destroy();
    const err = await own.catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    await client.ready;
    expect(ready).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
    expect(client.store.get('bootstrap.loaded')).toBe(false);
    expect(logs.warns().filter((e) => /bootstrap/.test(e.msg))).toEqual([]);
  });

  it('forwards request opts and rejects a non-object body with ValidationError', async () => {
    const client = make();
    const r = serve('/v1/config', ['nope']);
    const err = await client.bootstrap({ headers: { 'X-Trace': 't1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(r.calls[0].headers['x-trace']).toBe('t1');
    expect(client.store.get('bootstrap.loaded')).toBe(false);
  });

  it('autoBootstrap runs GET /v1/config on creation and client:ready follows it', async () => {
    const r = serve('/v1/config', BOOTSTRAP_DOC);
    const client = make({ autoBootstrap: true });
    const ready = vi.fn();
    client.on('client:ready', ready);
    expect(ready).not.toHaveBeenCalled();
    const resolved = await client.ready;
    expect(resolved).toBe(client);
    expect(r.calls).toHaveLength(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0]).toMatchObject({
      type: 'client:ready',
      version: VERSION,
      bootstrapped: true,
    });
    expect(client.store.get('bootstrap.loaded')).toBe(true);
  });

  it('tolerates a failing autoBootstrap with a warning and still becomes ready', async () => {
    const logs = sink();
    server.use(
      msw.get(`${BASE}/v1/config`, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Boom', status: 500 },
          { status: 500, headers: { 'content-type': 'application/problem+json' } }
        )
      )
    );
    const client = make({ autoBootstrap: true, logger: { level: 'warn', sink: logs.fn } });
    const ready = vi.fn();
    client.on('client:ready', ready);
    await client.ready;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].bootstrapped).toBe(false);
    expect(client.store.get('bootstrap.loaded')).toBe(false);
    const warn = logs.warns().find((e) => /bootstrap/.test(e.msg));
    expect(warn).toBeTruthy();
    // the logger hands the sink a redacted clone of the data
    expect(warn.data.error.name).toBe('ApiError');
    expect(warn.data.error.status).toBe(500);
    expect(client.isDestroyed()).toBe(false);
  });

  it('emits client:ready on the next microtask when autoBootstrap is off', async () => {
    const client = make();
    const ready = vi.fn();
    client.on('client:ready', ready);
    expect(ready).not.toHaveBeenCalled();
    await client.ready;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].bootstrapped).toBe(false);
  });

  it('features.load() is wired to the bootstrap request', async () => {
    const client = make();
    const r = serve('/v1/config', BOOTSTRAP_DOC);
    await client.features.load();
    expect(r.calls).toHaveLength(1);
    expect(client.features.isEnabled('splitResults')).toBe(true);
    expect(client.store.get('bootstrap.loaded')).toBe(true);
  });

  it('persisted flags are restored into features while the host flags win', () => {
    const adapter = mapAdapter();
    const first = make({ storage: adapter });
    first.features.set({ fromServer: true, shared: 'server' });
    first.destroy();
    const second = make({ storage: adapter, features: { shared: 'host', local: 'x' } });
    expect(second.features.get('fromServer')).toBe(true);
    expect(second.features.get('shared')).toBe('host');
    expect(second.features.get('local')).toBe('x');
    expect(second.store.get('bootstrap.flags')).toEqual({
      fromServer: true,
      shared: 'host',
      local: 'x',
    });
  });
});

// ── plugins ──────────────────────────────────────────────────────────────────────────────────────

describe('createClient — plugins', () => {
  it('use() installs, is chainable and runs the uninstaller on destroy', () => {
    const uninstall = vi.fn();
    const install = vi.fn(() => uninstall);
    const client = make();
    const out = client.use({ name: 'p1', install }).use({ name: 'p2', install: () => {} });
    expect(out).toBe(client);
    expect(install).toHaveBeenCalledWith(client);
    expect(uninstall).not.toHaveBeenCalled();
    client.destroy();
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('installs config.plugins at creation, in order', () => {
    const order = [];
    const client = make({
      plugins: [
        { name: 'a', install: () => order.push('a') },
        { name: 'b', install: (c) => order.push(`b:${c.version}`) },
      ],
    });
    expect(order).toEqual(['a', `b:${client.version}`]);
  });

  it('client.ready is already a promise while config.plugins install and resolves to the client', async () => {
    let seen;
    const client = make({
      plugins: [
        {
          name: 'early',
          install: (c) => {
            seen = c.ready;
          },
        },
      ],
    });
    expect(seen).toBeInstanceOf(Promise);
    expect(seen).toBe(client.ready);
    await expect(seen).resolves.toBe(client);
  });

  it('a config.plugins install that throws tears down modules and earlier plugins, leaving no timers', () => {
    vi.useFakeTimers();
    const destroyA = vi.fn();
    const uninstallA = vi.fn();
    let timersWhileInstalling = 0;
    let err;
    try {
      make({
        locale: 'en',
        modules: { a: () => ({ destroy: destroyA }) },
        plugins: [
          { name: 'a', install: () => uninstallA },
          {
            name: 'b',
            install: (c) => {
              // a proactive refresh timer that only auth.destroy() clears
              c.auth.setTokens({
                accessToken: 'acc',
                refreshToken: 'r1',
                expiresAt: Date.now() + 3_600_000,
              });
              timersWhileInstalling = vi.getTimerCount();
              throw new TypeError('nope');
            },
          },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SdkError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(destroyA).toHaveBeenCalledTimes(1);
    expect(uninstallA).toHaveBeenCalledTimes(1);
    expect(timersWhileInstalling).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('use() does not register a plugin whose install throws', () => {
    const client = make();
    expect(() =>
      client.use({
        name: 'p',
        install() {
          throw new TypeError('boom');
        },
      })
    ).toThrow(TypeError);
    const install = vi.fn();
    client.use({ name: 'p', install });
    expect(install).toHaveBeenCalledWith(client);
  });

  it('rejects malformed and duplicate plugins, and installation after destroy', () => {
    const client = make();
    expect(() => client.use(null)).toThrow(ConfigError);
    expect(() => client.use({ install() {} })).toThrow(ConfigError);
    expect(() => client.use({ name: 'x' })).toThrow(ConfigError);
    client.use({ name: 'dup', install() {} });
    expect(() => client.use({ name: 'dup', install() {} })).toThrow(ConfigError);
    client.destroy();
    expect(() => client.use({ name: 'late', install() {} })).toThrow(ConfigError);
  });
});

// ── modules ──────────────────────────────────────────────────────────────────────────────────────

describe('createClient — domain modules', () => {
  function greeterFactory(ctx) {
    ctx.store.registerSlice('greeter', { initial: { count: 0 } });
    return ctx.access.wrap('greeter', {
      hello: (name) => `${ctx.i18n.getLocale()}:${name}`,
      bump: () =>
        ctx.store.set('greeter', (s) => ({ count: s.count + 1 }), { action: 'greeter/bump' }),
      sibling: () => ctx.modules.echo,
      destroy: vi.fn(),
    });
  }

  it('instantiates config.modules factories with a full ModuleContext and exposes their APIs', () => {
    let seenCtx;
    let siblingDuringFactory = 'unset';
    const client = make({
      locale: 'en-IN',
      modules: {
        greeter: (ctx) => {
          seenCtx = ctx;
          siblingDuringFactory = ctx.modules.echo;
          return greeterFactory(ctx);
        },
        echo: (ctx) => ({ say: (x) => x, logScope: ctx.logger.scope, destroy() {} }),
      },
    });
    expect(client.greeter.hello('ana')).toBe('en-IN:ana');
    expect(client.echo.say('x')).toBe('x');
    expect(client.echo.logScope).toBe('echo');
    // lazily resolved sibling: undefined inside the factory body, available at call time
    expect(siblingDuringFactory).toBeUndefined();
    expect(client.greeter.sibling()).toBe(client.echo);
    expect(Object.keys(seenCtx.modules).sort()).toEqual(['echo', 'greeter']);
    expect('echo' in seenCtx.modules).toBe(true);
    expect(seenCtx.modules.nope).toBeUndefined();

    expect(seenCtx.config).toBe(client.getConfig());
    expect(seenCtx.http).toBe(client.http);
    expect(seenCtx.store).toBe(client.store);
    expect(seenCtx.events).toBe(client.events);
    expect(seenCtx.storage).toBe(client.storage);
    expect(seenCtx.auth).toBe(client.auth);
    expect(seenCtx.access).toBe(client.access);
    expect(seenCtx.i18n).toBe(client.i18n);
    expect(seenCtx.telemetry).toBe(client.telemetry);
    expect(seenCtx.features).toBe(client.features);
    expect(seenCtx.endpoints).toBe(client.endpoints);
    expect(seenCtx.payments).toBe(client.payments);
    expect(seenCtx.logger.scope).toBe('greeter');
    expect(typeof seenCtx.now()).toBe('number');
    for (const t of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
      expect(typeof seenCtx.timers[t]).toBe('function');
    }
    expect(Object.isFrozen(seenCtx)).toBe(true);

    client.greeter.bump();
    expect(client.store.get('greeter.count')).toBe(1);
    client.destroy();
    expect(client.greeter.destroy).toHaveBeenCalledTimes(1);
  });

  it('picks factories up from MODULE_FACTORIES (registerModule) and lets config.modules override', () => {
    expect(MODULE_FACTORIES).toEqual({});
    const unregister = registerModule('echo', () => ({ who: 'registry', destroy() {} }));
    try {
      expect(typeof MODULE_FACTORIES.echo).toBe('function');
      const a = make();
      expect(a.echo.who).toBe('registry');
      const b = make({ modules: { echo: () => ({ who: 'override', destroy() {} }) } });
      expect(b.echo.who).toBe('override');
      const c = make({ modules: { echo: null } });
      expect(c.echo).toBeUndefined();
    } finally {
      unregister();
    }
    expect(MODULE_FACTORIES).toEqual({});
    unregister(); // idempotent
    expect(() => registerModule('bad name', () => ({}))).toThrow(ConfigError);
    expect(() => registerModule('__proto__', () => ({}))).toThrow(ConfigError);
    expect(() => registerModule('ok', 'nope')).toThrow(ConfigError);
  });

  it('refuses reserved names, non-function factories and factories returning no object', () => {
    expect(() => make({ modules: { http: () => ({}) } })).toThrow(ConfigError);
    expect(() => make({ modules: { destroy: () => ({}) } })).toThrow(ConfigError);
    expect(() => make({ modules: { x: 'nope' } })).toThrow(ConfigError);
    expect(() => make({ modules: { x: () => null } })).toThrow(ConfigError);
  });

  it('tears down what was built when a factory throws, rethrowing an SdkError', () => {
    const destroyA = vi.fn();
    let err;
    try {
      make({
        modules: {
          a: () => ({ destroy: destroyA }),
          b: () => {
            throw new TypeError('kaboom');
          },
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SdkError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(destroyA).toHaveBeenCalledTimes(1);
  });
});

// ── payments port ────────────────────────────────────────────────────────────────────────────────

describe('createClient — payments port', () => {
  it('installs a null port whose operations reject with UnsupportedError{feature:"payments"}', async () => {
    const client = make();
    const p = client.payments;
    expect(p.isNull).toBe(true);
    for (const call of [
      () => p.methods(),
      () => p.quote(undefined, { method: 'card' }),
      () => p.credits.apply(undefined, {}),
      () => p.credits.remove(undefined, 'wallet'),
      () => p.emiPlans(),
      () => p.createIntent(undefined, { method: 'card' }),
      () => p.mount(),
      () => p.tokenize(),
      () => p.confirm(),
      () => p.handleAction(),
      () => p.waitForResult(),
      () => p.pay(undefined, { method: 'card' }),
      () => p.resumeAfterRedirect(),
      () => p.cancel(),
      () => p.retry(undefined, { method: 'card' }),
      () => p.savedMethods.list(),
      () => p.savedMethods.remove('m1'),
      () => p.savedMethods.setDefault('m1'),
      () => p.receipt(),
      () => p.refunds(),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(UnsupportedError);
      expect(err.feature).toBe('payments');
    }
    expect(() => p.gateways.register({ name: 'x' })).toThrow(UnsupportedError);
    expect(() => p.gateways.get('x')).toThrow(UnsupportedError);
    expect(p.gateways.list()).toEqual([]);
    expect(p.intent()).toBeNull();
    expect(p.status()).toBeNull();
    expect(p.quoteState()).toBeNull();
    expect(p.credits.applied()).toEqual([]);
    expect(p.clear()).toBeUndefined();
  });

  it('uses the configured port as-is when it has no attach()', () => {
    const port = { methods: vi.fn(), createIntent: vi.fn(), confirm: vi.fn(), pay: vi.fn() };
    const client = make({ payments: port });
    expect(client.payments).toBe(port);
  });

  it('calls port.attach({ http, store, events, config, … }) and exposes what it returns', () => {
    const attached = { methods: vi.fn(), createIntent: vi.fn(), confirm: vi.fn(), pay: vi.fn() };
    const attach = vi.fn(() => attached);
    const port = {
      methods: vi.fn(),
      createIntent: vi.fn(),
      confirm: vi.fn(),
      pay: vi.fn(),
      attach,
    };
    const client = make({ payments: port, modules: { m: (ctx) => ({ port: ctx.payments }) } });
    expect(attach).toHaveBeenCalledTimes(1);
    const deps = attach.mock.calls[0][0];
    expect(deps.http).toBe(client.http);
    expect(deps.store).toBe(client.store);
    expect(deps.events).toBe(client.events);
    expect(deps.config).toBe(client.getConfig());
    expect(deps.endpoints).toBe(client.endpoints);
    expect(deps.auth).toBe(client.auth);
    expect(client.payments).toBe(attached);
    expect(client.m.port).toBe(attached);

    const selfPort = {
      methods: vi.fn(),
      createIntent: vi.fn(),
      confirm: vi.fn(),
      pay: vi.fn(),
      attach: vi.fn(),
    };
    const other = make({ payments: selfPort });
    expect(other.payments).toBe(selfPort);
  });
});

// ── events, snapshot / restore ───────────────────────────────────────────────────────────────────

describe('createClient — events, snapshot and restore', () => {
  it('on / once / off are shortcuts to client.events', () => {
    const client = make();
    const fn = vi.fn();
    const onceFn = vi.fn();
    const off = client.on('custom:x', fn);
    client.once('custom:x', onceFn);
    client.events.emit('custom:x', { n: 1 });
    client.events.emit('custom:x', { n: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onceFn).toHaveBeenCalledTimes(1);
    off();
    client.events.emit('custom:x', { n: 3 });
    expect(fn).toHaveBeenCalledTimes(2);
    client.on('custom:y', fn);
    client.off('custom:y', fn);
    client.events.emit('custom:y', {});
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('snapshot() carries every non-secret slice and restore() applies it, syncing prefs and i18n', () => {
    const source = make({ locale: 'en-IN', currency: 'INR' });
    source.setMarket('IN');
    source.features.set({ beta: true });
    const snap = source.snapshot();
    expect(snap.version).toBe(1);
    expect(typeof snap.at).toBe('number');
    expect(Object.keys(snap.store.slices).sort()).toEqual(['bootstrap', 'prefs']);
    expect(snap.store.slices.session).toBeUndefined();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);

    const target = make();
    const events = recordEvents(target, 'prefs:change');
    target.restore(JSON.parse(JSON.stringify(snap)));
    expect(target.getPrefs()).toMatchObject({ locale: 'en-IN', currency: 'INR', market: 'IN' });
    expect(target.i18n.getLocale()).toBe('en-IN');
    expect(target.features.isEnabled('beta')).toBe(true);
    expect(events.seen).toHaveLength(1);
    expect(events.seen[0].changed.sort()).toEqual(['currency', 'locale', 'market']);
    // restoring the same snapshot again changes nothing and emits nothing
    target.restore(JSON.parse(JSON.stringify(snap)));
    expect(events.seen).toHaveLength(1);

    // a bare store snapshot is accepted too
    const third = make();
    third.restore(snap.store);
    expect(third.getPrefs().currency).toBe('INR');
  });

  it('restore() coerces malformed prefs / bootstrap content and re-syncs i18n to the fallback', () => {
    const client = make({ locale: 'fr', currency: 'EUR' });
    client.features.set({ old: true });
    const events = recordEvents(client, 'prefs:change');
    // A snapshot from an untrusted redirect round-trip: wrong types everywhere, an own __proto__ key.
    const hostile = JSON.parse(
      '{"slices":{"prefs":{"locale":42,"currency":"rupees","market":"","pricePer":"x","hour12":"yes","extra":1},' +
        '"bootstrap":{"loaded":"yes","flags":{"ok":true,"bad":{},"__proto__":{"polluted":true}},' +
        '"limits":"nope","markets":{},"version":7}}}'
    );
    client.restore(hostile);
    expect(client.getPrefs()).toEqual({
      locale: null,
      currency: null,
      market: null,
      homeAirport: null,
      pricePer: 'pax',
      hour12: null,
    });
    expect(client.i18n.getLocale()).toBe('en');
    expect(events.seen).toHaveLength(1);
    expect(events.seen[0].changed.sort()).toEqual(['currency', 'locale']);
    expect(events.seen[0].previous).toMatchObject({ locale: 'fr', currency: 'EUR' });
    expect(client.store.get('bootstrap')).toEqual({
      loaded: false,
      flags: { ok: true, old: true },
      limits: {},
      markets: [],
      currencies: [],
      paymentMethods: [],
      version: null,
    });
    expect(client.features.isEnabled('ok')).toBe(true);
    expect(client.features.get('bad')).toBeUndefined();
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();

    // Restoring a locale brings i18n along and canonicalises it in the slice.
    client.restore({ slices: { prefs: { locale: 'de-de' } } });
    expect(client.getPrefs().locale).toBe('de-DE');
    expect(client.i18n.getLocale()).toBe('de-DE');
    expect(events.seen).toHaveLength(2);
    expect(events.seen[1].changed).toEqual(['locale']);
  });

  it('restore() rejects malformed snapshots with ValidationError', () => {
    const client = make();
    expect(() => client.restore(null)).toThrow(ValidationError);
    expect(() => client.restore({})).toThrow(ValidationError);
    expect(() => client.restore({ store: { nope: 1 } })).toThrow(ValidationError);
  });
});

// ── destroy ──────────────────────────────────────────────────────────────────────────────────────

describe('createClient — destroy', () => {
  it('aborts in-flight requests, destroys modules, uninstalls plugins, emits client:destroyed and clears listeners', async () => {
    server.use(
      msw.get(`${BASE}/v1/slow`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      })
    );
    const moduleDestroy = vi.fn();
    const uninstall = vi.fn();
    const client = make({ modules: { m: () => ({ destroy: moduleDestroy }) } });
    client.use({ name: 'p', install: () => uninstall });
    const destroyed = vi.fn();
    client.on('client:destroyed', destroyed);
    client.on('custom:*', () => {});
    const pending = client.http.get('/v1/slow');
    await new Promise((r) => setTimeout(r, 20));
    expect(client.http.inflight()).toBe(1);

    client.destroy();

    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(client.http.inflight()).toBe(0);
    expect(moduleDestroy).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(destroyed.mock.calls[0][0].type).toBe('client:destroyed');
    expect(client.events.listenerCount()).toBe(0);
    expect(client.isDestroyed()).toBe(true);
    // idempotent
    client.destroy();
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(moduleDestroy).toHaveBeenCalledTimes(1);
    // later work is refused
    const late = await client.bootstrap().catch((e) => e);
    expect(late).toBeInstanceOf(AbortError);
    expect(() => client.use({ name: 'x', install() {} })).toThrow(ConfigError);
  });

  it('flushes persistence on destroy', async () => {
    const adapter = mapAdapter();
    const client = make({ storage: adapter });
    client.setCurrency('USD');
    await flush();
    client.destroy();
    const raw = Array.from(adapter.map.entries()).find(([k]) => /prefs/.test(k));
    expect(raw).toBeTruthy();
    expect(raw[1]).toContain('USD');
  });

  it('leaves no timers behind (fake timers)', async () => {
    vi.useFakeTimers();
    const client = make({ locale: 'en' });
    client.auth.setTokens({ accessToken: 'acc', expiresAt: Date.now() + 3_600_000 });
    client.setLocale('fr');
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    client.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.events.listenerCount()).toBe(0);
  });

  it('a client:ready still pending when destroy() runs is swallowed', async () => {
    const client = make();
    const ready = vi.fn();
    client.on('client:ready', ready);
    client.destroy();
    await client.ready;
    expect(ready).not.toHaveBeenCalled();
  });
});

// ── createContext ────────────────────────────────────────────────────────────────────────────────

describe('createContext', () => {
  it('copies the siblings, scopes the logger, defaults now / timers and resolves modules lazily', () => {
    const registry = new Map();
    const logger = utils.createLogger({ level: 'silent' });
    const parts = {
      config: Object.freeze({ baseUrl: 'x' }),
      http: { get() {} },
      store: {},
      events: {},
      storage: {},
      auth: {},
      access: {},
      i18n: {},
      telemetry: {},
      logger,
      features: {},
      payments: {},
      endpoints: {},
      registry,
      scope: 'search',
    };
    const ctx = createContext(parts);
    expect(Object.isFrozen(ctx)).toBe(true);
    for (const key of [
      'config',
      'http',
      'store',
      'events',
      'storage',
      'auth',
      'access',
      'i18n',
      'telemetry',
      'features',
      'payments',
      'endpoints',
    ]) {
      expect(ctx[key]).toBe(parts[key]);
    }
    expect(ctx.logger.scope).toBe('search');
    expect(typeof ctx.now()).toBe('number');
    expect(typeof ctx.timers.setTimeout).toBe('function');
    expect(typeof ctx.timers.clearInterval).toBe('function');

    expect(ctx.modules.offers).toBeUndefined();
    expect('offers' in ctx.modules).toBe(false);
    const offers = { get() {} };
    registry.set('offers', offers);
    expect(ctx.modules.offers).toBe(offers);
    expect('offers' in ctx.modules).toBe(true);
    expect(Object.keys(ctx.modules)).toEqual(['offers']);
    expect(ctx.modules.__proto__).toBeUndefined();
    expect(() => {
      ctx.modules.offers = 1;
    }).toThrow();
  });

  it('accepts a plain-object registry, a prebuilt accessor, and injected now / timers', () => {
    const now = () => 42;
    const timers = { setTimeout: vi.fn(), clearTimeout: vi.fn() };
    const ctx = createContext({ registry: { a: 1 }, now, timers });
    expect(ctx.modules.a).toBe(1);
    expect(ctx.now()).toBe(42);
    expect(ctx.timers.setTimeout).toBe(timers.setTimeout);
    expect(typeof ctx.timers.setInterval).toBe('function');
    const accessor = { ready: true };
    expect(createContext({ modules: accessor }).modules).toBe(accessor);
    expect(createContext({}).modules.anything).toBeUndefined();
  });

  it('rejects malformed parts with ConfigError', () => {
    expect(() => createContext()).toThrow(ConfigError);
    expect(() => createContext(null)).toThrow(ConfigError);
    expect(() => createContext({ registry: 3 })).toThrow(ConfigError);
    expect(() => createContext({ registry: [] })).toThrow(ConfigError);
    expect(() => createContext({ now: 'later' })).toThrow(ConfigError);
    expect(() => createContext({ timers: {} })).toThrow(ConfigError);
    expect(() => createContext({ timers: null })).toThrow(ConfigError);
    expect(() => createContext({ timers: { setTimeout() {} } })).toThrow(ConfigError);
    expect(() => createContext({ scope: 1 })).toThrow(ConfigError);
    expect(() => createContext({ scope: '' })).not.toThrow();
  });
});

// ── entries ──────────────────────────────────────────────────────────────────────────────────────

describe('public entries', () => {
  it('src/index.js exposes the documented factories, error classes, utils namespace and VERSION', () => {
    for (const name of [
      'createClient',
      'defineConfig',
      'validateConfig',
      'createEndpoints',
      'createHttp',
      'installDefaultInterceptors',
      'authInterceptor',
      'apiKeyInterceptor',
      'localeInterceptor',
      'correlationInterceptor',
      'idempotencyInterceptor',
      'envelopeInterceptor',
      'problemInterceptor',
      'rateLimitInterceptor',
      'cacheInterceptor',
      'dedupeInterceptor',
      'csrfInterceptor',
      'deviceInterceptor',
      'telemetryInterceptor',
      'loggingInterceptor',
      'mockInterceptor',
      'createAuth',
      'createAccess',
      'createStore',
      'createSelector',
      'createEmitter',
      'createStorage',
      'createI18n',
      'createTelemetry',
      'bindDomainEvents',
      'ga4Adapter',
      'gtmAdapter',
      'segmentAdapter',
      'consoleAdapter',
      'beaconAdapter',
      'createFeatures',
      'createLogger',
      'isSdkError',
      'errorFromProblem',
      'wrap',
    ]) {
      expect(typeof sdk[name], name).toBe('function');
    }
    for (const cls of ['SdkError', 'ConfigError', 'ValidationError', 'ApiError', 'AuthError']) {
      expect(typeof sdk[cls], cls).toBe('function');
    }
    expect(sdk.DEFAULTS).toBe(DEFAULTS);
    expect(sdk.DEFAULT_ACCESS_POLICY.default).toBe('open');
    expect(typeof sdk.DEFAULT_ENDPOINTS['search.create']).toBe('object');
    expect(sdk.VERSION).toBe(VERSION);
    expect(sdk.utils).toBe(utils);
    expect(sdk.default).toBeUndefined();
  });

  it('src/utils/index.js re-exports every utils script by namespace plus flat helpers', () => {
    for (const ns of [
      'money',
      'datetime',
      'format',
      'validation',
      'async',
      'object',
      'id',
      'url',
      'i18n',
      'telemetry',
      'logger',
      'features',
    ]) {
      expect(typeof utils[ns], ns).toBe('object');
    }
    expect(utils.money.formatMoney).toBe(utils.formatMoney);
    expect(utils.datetime.formatDuration).toBe(utils.formatDuration);
    expect(utils.object.deepMerge).toBe(utils.deepMerge);
    expect(utils.id.uuid).toBe(utils.uuid);
    expect(utils.url.encodeSearchParams).toBe(utils.encodeSearchParams);
    expect(utils.i18n.createI18n).toBe(utils.createI18n);
    expect(utils.formatMoney({ amount: '10.00', currency: 'USD' }, { locale: 'en-US' })).toBe(
      '$10.00'
    );
  });

  it('src/umd.js re-exports the public entry', async () => {
    const umd = await import('../../src/umd.js');
    expect(umd.createClient).toBe(sdk.createClient);
    expect(umd.VERSION).toBe(VERSION);
    expect(umd.utils).toBe(utils);
    expect(typeof umd.ui.createUI).toBe('function');
    expect(typeof umd.payments.createPayments).toBe('function');
  });
});

// ── declaration emit ─────────────────────────────────────────────────────────────────────────────

describe('npm run types still emits', () => {
  it('tsc -p tsconfig.types.json succeeds and declares createClient / createContext / registerModule', () => {
    const outDir = resolve(tmpdir(), 'wf-client-types');
    rmSync(outDir, { recursive: true, force: true });
    let output;
    let ok = true;
    try {
      output = execSync(`npx tsc -p tsconfig.types.json --outDir ${JSON.stringify(outDir)}`, {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      ok = false;
      output = `${error.stdout || ''}${error.stderr || ''}`;
    }
    expect(ok, output).toBe(true);
    expect(output.trim()).toBe('');
    const client = readFileSync(resolve(outDir, 'core/client.d.ts'), 'utf8');
    expect(client).toMatch(/export (declare )?function createClient\(/);
    expect(client).toMatch(/export type OtaClient = \{/);
    expect(client).toMatch(/export (declare )?const VERSION(: string| = "0\.1\.0");/);
    const context = readFileSync(resolve(outDir, 'core/context.d.ts'), 'utf8');
    expect(context).toMatch(/export (declare )?function createContext\(/);
    expect(context).toMatch(/export type ModuleContext = \{/);
    const modules = readFileSync(resolve(outDir, 'modules/index.d.ts'), 'utf8');
    expect(modules).toMatch(/export (declare )?function registerModule\(/);
    expect(modules).toMatch(/export (declare )?const MODULE_FACTORIES/);
    expect(existsSync(resolve(outDir, 'index.d.ts'))).toBe(true);
    expect(existsSync(resolve(outDir, 'utils/index.d.ts'))).toBe(true);
  }, 120_000);
});
