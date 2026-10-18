import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULTS, defineConfig, validateConfig } from '../../src/core/config.js';
import { ConfigError, SdkError } from '../../src/errors/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A minimal custom StorageAdapter that keeps its state in an own property (must stay writable). */
function fakeAdapter() {
  return {
    name: 'fake',
    state: {},
    getItem(k) {
      return this.state[k] ?? null;
    },
    setItem(k, v) {
      this.state[k] = v;
    },
    removeItem(k) {
      delete this.state[k];
    },
  };
}

/** A minimal PaymentsPort duck type. */
function fakePort() {
  return { methods() {}, createIntent() {}, confirm() {}, pay() {}, clear() {} };
}

/** `defineConfig` wrapped so the thrown error can be inspected. */
function failure(partial) {
  try {
    defineConfig(partial);
  } catch (e) {
    return e;
  }
  throw new Error('expected defineConfig to throw');
}

/** `path:code` pairs of a ValidationResult / ConfigError, for compact assertions. */
const codes = (r) => r.issues.map((i) => `${i.path}:${i.code}`);

/** Recursively assert that every plain object / array reachable from `o` is frozen. */
function expectDeepFrozen(o, path = 'config') {
  expect(Object.isFrozen(o), `${path} should be frozen`).toBe(true);
  for (const key of Object.keys(o)) {
    const v = o[key];
    if (v && typeof v === 'object') expectDeepFrozen(v, `${path}.${key}`);
  }
}

// ── DEFAULTS ─────────────────────────────────────────────────────────────────────────────────────

describe('DEFAULTS', () => {
  it('matches docs/api/01-core.md §2 exactly', () => {
    expect(DEFAULTS.baseUrl).toBe('https://api.ota.com');
    expect(DEFAULTS.errorFormat).toBe('problem+json');
    expect(DEFAULTS.timeoutMs).toBe(20000);
    expect(DEFAULTS.retries).toBe(2);
    expect(DEFAULTS.auth.strategy).toBe('bearer');
    expect(DEFAULTS.auth.tokenStorage).toBe('memory');
    expect(DEFAULTS.auth.guest).toBe(true);
    expect(DEFAULTS.storage).toBe('local');
    expect(DEFAULTS.search.mode).toBe('poll');
    expect(DEFAULTS.search.pollIntervalMs).toBe(1500);
    expect(DEFAULTS.search.maxPollMs).toBe(45000);
    expect(DEFAULTS.logger.level).toBe('warn');
    expect(DEFAULTS.autoBootstrap).toBe(true);
  });

  it('defaults the result model to split (per_slice) — docs/QUESTIONS.md decision 5', () => {
    expect(DEFAULTS.search.resultMode).toBe('per_slice');
    expect(defineConfig().search.resultMode).toBe('per_slice');
    expect(defineConfig({ search: { mode: 'single' } }).search.resultMode).toBe('per_slice');
  });

  it('carries the default access policy of docs/api/01-core.md §1.1', () => {
    expect(DEFAULTS.access.default).toBe('open');
    const guest = [
      'itinerary.*',
      'ancillaries.*',
      'booking.*',
      'payments.*',
      'alerts.createGuest',
      'booking.retrieve',
      'trips.byReference',
    ];
    const auth = [
      'travelers.*',
      'trips.*',
      'account.*',
      'wallet.*',
      'alerts.*',
      'support.tickets.*',
      'payments.savedMethods.*',
    ];
    for (const key of guest) expect(DEFAULTS.access.rules[key], key).toBe('guest');
    for (const key of auth) expect(DEFAULTS.access.rules[key], key).toBe('auth');
    expect(Object.keys(DEFAULTS.access.rules)).toHaveLength(guest.length + auth.length);
  });

  it('leaves locale, currency and market to the bootstrap config', () => {
    expect(DEFAULTS.locale).toBeUndefined();
    expect(DEFAULTS.currency).toBeUndefined();
    expect(DEFAULTS.market).toBeUndefined();
    expect(DEFAULTS.payments).toBeUndefined();
    expect(DEFAULTS.fetch).toBeUndefined();
  });

  it('is deep-frozen and valid', () => {
    expectDeepFrozen(DEFAULTS, 'DEFAULTS');
    expect(() => {
      'use strict';
      DEFAULTS.search.resultMode = 'combined';
    }).toThrow(TypeError);
    expect(validateConfig(DEFAULTS)).toEqual({ valid: true, issues: [] });
  });
});

// ── defineConfig: happy paths ────────────────────────────────────────────────────────────────────

describe('defineConfig', () => {
  it('returns a fresh deep-frozen copy of DEFAULTS when called with nothing, null or {}', () => {
    for (const input of [undefined, null, {}]) {
      const cfg = defineConfig(input);
      expect(cfg).toEqual(DEFAULTS);
      expect(cfg).not.toBe(DEFAULTS);
      expectDeepFrozen(cfg);
    }
  });

  it('deep-merges nested objects over the defaults and keeps sibling defaults', () => {
    const cfg = defineConfig({
      search: { pollIntervalMs: 500 },
      auth: { strategy: 'cookie' },
      logger: { level: 'debug' },
    });
    expect(cfg.search).toEqual({
      mode: 'poll',
      resultMode: 'per_slice',
      pollIntervalMs: 500,
      maxPollMs: 45000,
    });
    expect(cfg.auth).toEqual({ ...DEFAULTS.auth, strategy: 'cookie' });
    expect(cfg.logger).toEqual({ level: 'debug', redact: [] });
    expect(cfg.timeoutMs).toBe(20000);
  });

  it('merges access rules into the default policy (agencies override single keys)', () => {
    const cfg = defineConfig({
      access: { default: 'guest', rules: { 'booking.create': 'auth', 'trips.*': 'guest' } },
    });
    expect(cfg.access.default).toBe('guest');
    expect(cfg.access.rules['booking.create']).toBe('auth');
    expect(cfg.access.rules['trips.*']).toBe('guest');
    expect(cfg.access.rules['account.*']).toBe('auth');
    expect(cfg.access.rules['itinerary.*']).toBe('guest');
  });

  it('replaces arrays instead of merging them and ignores undefined values', () => {
    const cfg = defineConfig({
      logger: { redact: ['secret'] },
      timeoutMs: undefined,
      search: { mode: undefined, maxPollMs: 1000 },
    });
    expect(cfg.logger.redact).toEqual(['secret']);
    expect(cfg.timeoutMs).toBe(20000);
    expect(cfg.search.mode).toBe('poll');
    expect(cfg.search.maxPollMs).toBe(1000);
  });

  it('strips trailing slashes and whitespace from baseUrl', () => {
    expect(defineConfig({ baseUrl: 'https://api.ota.com/' }).baseUrl).toBe('https://api.ota.com');
    expect(defineConfig({ baseUrl: 'https://api.ota.com///' }).baseUrl).toBe('https://api.ota.com');
    expect(defineConfig({ baseUrl: ' https://staging.ota.com/v1/ ' }).baseUrl).toBe(
      'https://staging.ota.com/v1'
    );
    expect(defineConfig({ baseUrl: 'http://localhost:8080' }).baseUrl).toBe(
      'http://localhost:8080'
    );
  });

  it('upper-cases the currency and keeps locale / market as given', () => {
    const cfg = defineConfig({ currency: 'inr', locale: 'en-IN', market: 'IN' });
    expect(cfg.currency).toBe('INR');
    expect(cfg.locale).toBe('en-IN');
    expect(cfg.market).toBe('IN');
  });

  it('accepts every documented enum value', () => {
    for (const strategy of ['bearer', 'cookie']) {
      expect(defineConfig({ auth: { strategy } }).auth.strategy).toBe(strategy);
    }
    for (const tokenStorage of ['memory', 'session', 'local']) {
      expect(defineConfig({ auth: { tokenStorage } }).auth.tokenStorage).toBe(tokenStorage);
    }
    for (const mode of ['poll', 'single', 'stream']) {
      expect(defineConfig({ search: { mode } }).search.mode).toBe(mode);
    }
    for (const resultMode of ['per_slice', 'combined', 'auto']) {
      expect(defineConfig({ search: { resultMode } }).search.resultMode).toBe(resultMode);
    }
    for (const storage of ['memory', 'local', 'session']) {
      expect(defineConfig({ storage }).storage).toBe(storage);
    }
    for (const errorFormat of ['problem+json', 'envelope']) {
      expect(defineConfig({ errorFormat }).errorFormat).toBe(errorFormat);
    }
    for (const level of ['silent', 'error', 'warn', 'info', 'debug']) {
      expect(defineConfig({ logger: { level } }).logger.level).toBe(level);
    }
    for (const level of ['open', 'guest', 'auth']) {
      expect(defineConfig({ access: { default: level } }).access.default).toBe(level);
    }
  });

  it('accepts a full, realistic configuration', () => {
    const sink = () => {};
    const fetchFn = () => Promise.resolve(new Response(null));
    const onError = () => {};
    const req = () => {};
    const cfg = defineConfig({
      baseUrl: 'https://api.ota.com',
      endpoints: { 'search.create': '/v2/shopping/flight-offers' },
      apiKey: 'pk_test',
      clientId: 'web',
      locale: 'en-IN',
      currency: 'INR',
      market: 'IN',
      fetch: fetchFn,
      timeoutMs: 0,
      retries: 0,
      auth: {
        strategy: 'bearer',
        refreshPath: '/auth/refresh',
        autoRefreshSkewMs: 0,
        guest: false,
      },
      storage: 'session',
      storageNamespace: '',
      persist: { drafts: true },
      interceptors: { request: [req], response: [], error: [] },
      hooks: { onError, beforeRequest: () => {} },
      search: { mode: 'stream', resultMode: 'combined', pollIntervalMs: 1, maxPollMs: 1 },
      payments: fakePort(),
      telemetry: { adapters: [{ name: 'ga4', track() {} }], enabled: false, sampleRate: 0.5 },
      features: { newResults: true, variant: 'b' },
      i18n: { messages: { en: { hello: 'Hello' } }, fallback: 'en' },
      logger: { level: 'info', sink, redact: ['password'] },
      autoBootstrap: false,
      plugins: [{ name: 'p', install() {} }],
      devtools: true,
    });
    expect(cfg.fetch).toBe(fetchFn);
    expect(cfg.logger.sink).toBe(sink);
    expect(cfg.hooks.onError).toBe(onError);
    expect(cfg.interceptors.request[0]).toBe(req);
    expect(cfg.storageNamespace).toBe('');
    expect(cfg.endpoints['search.create']).toBe('/v2/shopping/flight-offers');
    expect(validateConfig(cfg)).toEqual({ valid: true, issues: [] });
  });

  it('deep-freezes everything the SDK owns', () => {
    const cfg = defineConfig({
      endpoints: { 'search.create': '/x' },
      features: { a: true },
      i18n: { messages: { en: { k: 'v' } } },
      logger: { redact: ['x'] },
    });
    expectDeepFrozen(cfg);
    expect(() => {
      'use strict';
      cfg.search.resultMode = 'combined';
    }).toThrow(TypeError);
    expect(() => {
      'use strict';
      cfg.access.rules['booking.*'] = 'open';
    }).toThrow(TypeError);
    expect(() => {
      'use strict';
      cfg.logger.redact.push('y');
    }).toThrow(TypeError);
  });

  it('keeps host-owned objects by reference and never freezes or copies them', () => {
    const adapter = fakeAdapter();
    const port = fakePort();
    const plugin = { name: 'p', install() {}, calls: 0 };
    const tele = { name: 't', track() {}, buffer: [] };
    const fetchFn = () => {};
    const cfg = defineConfig({
      storage: adapter,
      payments: port,
      fetch: fetchFn,
      plugins: [plugin],
      telemetry: { adapters: [tele] },
    });
    expect(cfg.storage).toBe(adapter);
    expect(cfg.payments).toBe(port);
    expect(cfg.fetch).toBe(fetchFn);
    expect(cfg.plugins[0]).toBe(plugin);
    expect(cfg.telemetry.adapters[0]).toBe(tele);
    expect(Object.isFrozen(adapter)).toBe(false);
    expect(Object.isFrozen(adapter.state)).toBe(false);
    expect(Object.isFrozen(port)).toBe(false);
    expect(Object.isFrozen(plugin)).toBe(false);
    expect(Object.isFrozen(tele)).toBe(false);
    expect(Object.isFrozen(tele.buffer)).toBe(false);
    // the SDK-owned containers around them are frozen
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.plugins)).toBe(true);
    expect(Object.isFrozen(cfg.telemetry)).toBe(true);
    expect(Object.isFrozen(cfg.telemetry.adapters)).toBe(true);
    // the adapter still works afterwards
    adapter.setItem('k', 'v');
    expect(adapter.getItem('k')).toBe('v');
    plugin.calls += 1;
    expect(plugin.calls).toBe(1);
  });

  it('never mutates the partial it is given', () => {
    const partial = {
      baseUrl: 'https://api.ota.com/',
      currency: 'inr',
      search: { pollIntervalMs: 500 },
      access: { rules: { 'booking.create': 'auth' } },
      logger: { redact: ['a'] },
    };
    const snapshot = JSON.parse(JSON.stringify(partial));
    const cfg = defineConfig(partial);
    expect(partial).toEqual(snapshot);
    expect(Object.isFrozen(partial)).toBe(false);
    expect(Object.isFrozen(partial.search)).toBe(false);
    expect(Object.isFrozen(partial.logger.redact)).toBe(false);
    expect(cfg.search).not.toBe(partial.search);
    expect(cfg.logger.redact).not.toBe(partial.logger.redact);
  });

  it('is idempotent: a defined config can be passed back in', () => {
    const once = defineConfig({
      baseUrl: 'https://api.ota.com/',
      currency: 'usd',
      storage: fakeAdapter(),
      payments: fakePort(),
      plugins: [{ name: 'p', install() {} }],
    });
    const twice = defineConfig(once);
    expect(twice).toEqual(once);
    expect(twice.storage).toBe(once.storage);
    expect(twice.payments).toBe(once.payments);
    expect(twice.plugins[0]).toBe(once.plugins[0]);
    expect(validateConfig(twice)).toEqual({ valid: true, issues: [] });
  });

  it('is pure: no timers, no globals touched', () => {
    vi.useFakeTimers();
    try {
      defineConfig({ search: { pollIntervalMs: 10 } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
  });
});

// ── defineConfig: error paths ────────────────────────────────────────────────────────────────────

describe('defineConfig errors', () => {
  it('throws ConfigError (an SdkError) with code CONFIG_ERROR and the issues attached', () => {
    const err = failure({ timeoutMs: -1 });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(SdkError);
    expect(err.name).toBe('ConfigError');
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.issues).toEqual([
      {
        path: 'timeoutMs',
        code: 'min',
        message: 'timeoutMs must be at least 0',
        params: { min: 0, received: -1 },
      },
    ]);
    expect(err.details).toEqual({ issues: err.issues });
    expect(err.message).toBe('Invalid client config: timeoutMs must be at least 0');
    expect(err.toJSON().issues).toEqual(err.issues);
  });

  it('reports every problem at once and counts the rest in the message', () => {
    const err = failure({
      baseUrl: 'not a url',
      retries: 1.5,
      search: { mode: 'websocket', resultMode: 'both' },
      bogus: true,
    });
    expect(codes(err)).toEqual([
      'baseUrl:invalid_url',
      'retries:not_integer',
      'search.mode:invalid_enum',
      'search.resultMode:invalid_enum',
      'bogus:unknown_key',
    ]);
    expect(err.message).toBe(
      'Invalid client config: baseUrl must be an absolute http(s) URL (+4 more)'
    );
  });

  it('rejects a non-object partial', () => {
    for (const input of [[], 'https://api.ota.com', 42, true, () => {}, new Date()]) {
      const err = failure(input);
      expect(err).toBeInstanceOf(ConfigError);
      expect(codes(err)).toEqual([':invalid_type']);
    }
  });

  it('validates baseUrl as an absolute http(s) URL without query or fragment', () => {
    expect(codes(failure({ baseUrl: '' }))).toEqual(['baseUrl:invalid_type']);
    expect(codes(failure({ baseUrl: '   ' }))).toEqual(['baseUrl:invalid_type']);
    expect(codes(failure({ baseUrl: 42 }))).toEqual(['baseUrl:invalid_type']);
    expect(codes(failure({ baseUrl: null }))).toEqual(['baseUrl:invalid_type']);
    expect(codes(failure({ baseUrl: '/api' }))).toEqual(['baseUrl:invalid_url']);
    expect(codes(failure({ baseUrl: 'api.ota.com' }))).toEqual(['baseUrl:invalid_url']);
    expect(codes(failure({ baseUrl: 'ftp://api.ota.com' }))).toEqual(['baseUrl:invalid_url']);
    expect(codes(failure({ baseUrl: 'https://api.ota.com?x=1' }))).toEqual(['baseUrl:invalid_url']);
    expect(codes(failure({ baseUrl: 'https://api.ota.com/#top' }))).toEqual([
      'baseUrl:invalid_url',
    ]);
  });

  it('validates timeoutMs and retries as non-negative integers', () => {
    for (const key of ['timeoutMs', 'retries']) {
      expect(codes(failure({ [key]: -1 }))).toEqual([`${key}:min`]);
      expect(codes(failure({ [key]: 2.5 }))).toEqual([`${key}:not_integer`]);
      expect(codes(failure({ [key]: '2' }))).toEqual([`${key}:invalid_type`]);
      expect(codes(failure({ [key]: NaN }))).toEqual([`${key}:invalid_type`]);
      expect(codes(failure({ [key]: Infinity }))).toEqual([`${key}:not_integer`]);
      expect(codes(failure({ [key]: null }))).toEqual([`${key}:invalid_type`]);
      expect(defineConfig({ [key]: 0 })[key]).toBe(0);
    }
  });

  it('validates locale as a BCP-47-ish tag', () => {
    for (const locale of ['en', 'en-IN', 'en-US', 'pt-BR', 'zh-Hant-TW', 'sr-Latn-RS', 'ar-AE']) {
      expect(defineConfig({ locale }).locale).toBe(locale);
    }
    for (const locale of ['e', 'english', 'en_IN', 'en-', '-IN', 'en IN', 'en-toolongsubtag']) {
      expect(codes(failure({ locale })), locale).toEqual(['locale:invalid_format']);
    }
    expect(codes(failure({ locale: '' }))).toEqual(['locale:invalid_type']);
    expect(codes(failure({ locale: 7 }))).toEqual(['locale:invalid_type']);
  });

  it('validates currency as three letters', () => {
    for (const currency of ['IN', 'INRR', '123', 'IN1', 'I N']) {
      expect(codes(failure({ currency })), currency).toEqual(['currency:invalid_format']);
    }
    expect(codes(failure({ currency: '' }))).toEqual(['currency:invalid_type']);
    expect(codes(failure({ currency: 356 }))).toEqual(['currency:invalid_type']);
  });

  it('validates the auth block', () => {
    expect(codes(failure({ auth: { strategy: 'jwt' } }))).toEqual(['auth.strategy:invalid_enum']);
    expect(codes(failure({ auth: { tokenStorage: 'cookie' } }))).toEqual([
      'auth.tokenStorage:invalid_enum',
    ]);
    expect(codes(failure({ auth: { guest: 'yes' } }))).toEqual(['auth.guest:invalid_type']);
    expect(codes(failure({ auth: { refreshPath: '' } }))).toEqual([
      'auth.refreshPath:invalid_type',
    ]);
    expect(codes(failure({ auth: { autoRefreshSkewMs: -5 } }))).toEqual([
      'auth.autoRefreshSkewMs:min',
    ]);
    expect(codes(failure({ auth: { strategy: 'bearer', jwtSecret: 'x' } }))).toEqual([
      'auth.jwtSecret:unknown_key',
    ]);
    expect(codes(failure({ auth: 'bearer' }))).toEqual(['auth:invalid_type']);
  });

  it('validates the search block', () => {
    expect(codes(failure({ search: { mode: 'sync' } }))).toEqual(['search.mode:invalid_enum']);
    for (const resultMode of ['split', 'both', 'PER_SLICE', 1]) {
      expect(codes(failure({ search: { resultMode } }))).toEqual([
        'search.resultMode:invalid_enum',
      ]);
    }
    expect(codes(failure({ search: { pollIntervalMs: 0 } }))).toEqual([
      'search.pollIntervalMs:min',
    ]);
    expect(codes(failure({ search: { maxPollMs: 0.5 } }))).toEqual([
      'search.maxPollMs:not_integer',
    ]);
    expect(codes(failure({ search: { interval: 5 } }))).toEqual(['search.interval:unknown_key']);
    expect(codes(failure({ search: [] }))).toEqual(['search:invalid_type']);
  });

  it('validates storage as a driver name or a StorageAdapter duck type', () => {
    expect(codes(failure({ storage: 'cookie' }))).toEqual(['storage:invalid_enum']);
    expect(codes(failure({ storage: 'indexeddb' }))).toEqual(['storage:invalid_enum']);
    expect(codes(failure({ storage: 42 }))).toEqual(['storage:invalid_type']);
    expect(codes(failure({ storage: null }))).toEqual(['storage:invalid_type']);
    expect(codes(failure({ storage: [] }))).toEqual(['storage:invalid_type']);
    expect(codes(failure({ storage: { getItem() {}, setItem() {} } }))).toEqual([
      'storage.removeItem:invalid_type',
    ]);
    expect(codes(failure({ storage: { name: 'x' } }))).toEqual([
      'storage.getItem:invalid_type',
      'storage.setItem:invalid_type',
      'storage.removeItem:invalid_type',
    ]);
    class Adapter {
      getItem() {}
      setItem() {}
      removeItem() {}
    }
    const instance = new Adapter();
    expect(defineConfig({ storage: instance }).storage).toBe(instance);
  });

  it('validates access levels and formats rule keys with brackets', () => {
    expect(codes(failure({ access: { default: 'admin' } }))).toEqual([
      'access.default:invalid_enum',
    ]);
    const err = failure({ access: { rules: { 'booking.*': 'member', 'trips.*': 'auth' } } });
    expect(err.issues).toEqual([
      {
        path: 'access.rules[booking.*]',
        code: 'invalid_enum',
        message: "access.rules[booking.*] must be one of 'open', 'guest', 'auth'",
        params: { allowed: ['open', 'guest', 'auth'], received: 'member' },
      },
    ]);
    expect(codes(failure({ access: { rules: ['booking.*'] } }))).toEqual([
      'access.rules:invalid_type',
    ]);
    expect(codes(failure({ access: { level: 'open' } }))).toEqual(['access.level:unknown_key']);
    expect(codes(failure({ access: 'open' }))).toEqual(['access:invalid_type']);
  });

  it('validates errorFormat, booleans, identifiers and fetch', () => {
    expect(codes(failure({ errorFormat: 'json' }))).toEqual(['errorFormat:invalid_enum']);
    expect(codes(failure({ autoBootstrap: 'yes' }))).toEqual(['autoBootstrap:invalid_type']);
    expect(codes(failure({ devtools: 1 }))).toEqual(['devtools:invalid_type']);
    expect(codes(failure({ persist: { drafts: 'no' } }))).toEqual(['persist.drafts:invalid_type']);
    expect(codes(failure({ apiKey: '' }))).toEqual(['apiKey:invalid_type']);
    expect(codes(failure({ clientId: 12 }))).toEqual(['clientId:invalid_type']);
    expect(codes(failure({ market: '' }))).toEqual(['market:invalid_type']);
    expect(codes(failure({ storageNamespace: 1 }))).toEqual(['storageNamespace:invalid_type']);
    expect(codes(failure({ fetch: 'fetch' }))).toEqual(['fetch:invalid_type']);
    expect(codes(failure({ fetch: null }))).toEqual(['fetch:invalid_type']);
  });

  it('validates endpoints, hooks and interceptors', () => {
    expect(codes(failure({ endpoints: { 'search.create': '' } }))).toEqual([
      'endpoints[search.create]:invalid_type',
    ]);
    expect(codes(failure({ endpoints: ['/x'] }))).toEqual(['endpoints:invalid_type']);
    expect(codes(failure({ hooks: { onFoo() {} } }))).toEqual(['hooks.onFoo:unknown_key']);
    expect(codes(failure({ hooks: { onError: 'log' } }))).toEqual(['hooks.onError:invalid_type']);
    expect(codes(failure({ hooks: [] }))).toEqual(['hooks:invalid_type']);
    expect(codes(failure({ interceptors: { request: () => {} } }))).toEqual([
      'interceptors.request:invalid_type',
    ]);
    expect(codes(failure({ interceptors: { error: [() => {}, 'x'] } }))).toEqual([
      'interceptors.error[1]:invalid_type',
    ]);
    expect(codes(failure({ interceptors: { before: [] } }))).toEqual([
      'interceptors.before:unknown_key',
    ]);
  });

  it('validates plugins, telemetry, features, i18n and logger', () => {
    expect(codes(failure({ plugins: { name: 'p' } }))).toEqual(['plugins:invalid_type']);
    expect(codes(failure({ plugins: [{ name: 'p' }] }))).toEqual([
      'plugins[0].install:invalid_type',
    ]);
    expect(codes(failure({ plugins: [{ install() {} }] }))).toEqual([
      'plugins[0].name:invalid_type',
    ]);
    expect(codes(failure({ plugins: ['p'] }))).toEqual(['plugins[0]:invalid_type']);
    expect(codes(failure({ telemetry: { sampleRate: 1.5 } }))).toEqual([
      'telemetry.sampleRate:max',
    ]);
    expect(codes(failure({ telemetry: { sampleRate: -0.1 } }))).toEqual([
      'telemetry.sampleRate:min',
    ]);
    expect(codes(failure({ telemetry: { sampleRate: '1' } }))).toEqual([
      'telemetry.sampleRate:invalid_type',
    ]);
    expect(codes(failure({ telemetry: { enabled: 'on' } }))).toEqual([
      'telemetry.enabled:invalid_type',
    ]);
    expect(codes(failure({ telemetry: { adapters: [{ name: 'x' }] } }))).toEqual([
      'telemetry.adapters[0].track:invalid_type',
    ]);
    expect(codes(failure({ telemetry: { adapters: [null] } }))).toEqual([
      'telemetry.adapters[0]:invalid_type',
    ]);
    expect(codes(failure({ features: { flag: 1 } }))).toEqual(['features.flag:invalid_type']);
    expect(codes(failure({ features: ['flag'] }))).toEqual(['features:invalid_type']);
    expect(codes(failure({ i18n: { fallback: 'english' } }))).toEqual([
      'i18n.fallback:invalid_format',
    ]);
    expect(codes(failure({ i18n: { messages: 'en' } }))).toEqual(['i18n.messages:invalid_type']);
    expect(codes(failure({ logger: { level: 'verbose' } }))).toEqual(['logger.level:invalid_enum']);
    expect(codes(failure({ logger: { sink: console } }))).toEqual(['logger.sink:invalid_type']);
    expect(codes(failure({ logger: { redact: 'password' } }))).toEqual([
      'logger.redact:invalid_type',
    ]);
    expect(codes(failure({ logger: { redact: [1] } }))).toEqual(['logger.redact[0]:invalid_type']);
  });

  it('validates payments as a PaymentsPort duck type', () => {
    expect(codes(failure({ payments: 'stripe' }))).toEqual(['payments:invalid_type']);
    expect(codes(failure({ payments: null }))).toEqual(['payments:invalid_type']);
    const noPay = fakePort();
    delete noPay.pay;
    expect(codes(failure({ payments: noPay }))).toEqual(['payments.pay:invalid_type']);
  });

  it('flags unknown top-level keys such as casing typos', () => {
    expect(codes(failure({ baseURL: 'https://api.ota.com' }))).toEqual(['baseURL:unknown_key']);
    expect(codes(failure({ timeout: 5 }))).toEqual(['timeout:unknown_key']);
    const err = failure({ baseURL: 'https://api.ota.com' });
    expect(err.issues[0].params.allowed).toContain('baseUrl');
  });
});

// ── validateConfig ───────────────────────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a ValidationResult and never throws, whatever it is given', () => {
    for (const input of [undefined, null, 42, 'x', [], () => {}, new Map()]) {
      const result = validateConfig(input);
      expect(result.valid).toBe(false);
      expect(result.issues).toEqual([
        {
          path: '',
          code: 'invalid_type',
          message: 'config must be a plain object',
          params: { expected: 'object', received: expect.any(String) },
        },
      ]);
    }
  });

  it('accepts partial configs (absent keys are filled by defaults later)', () => {
    expect(validateConfig({})).toEqual({ valid: true, issues: [] });
    expect(validateConfig({ search: { resultMode: 'combined' } })).toEqual({
      valid: true,
      issues: [],
    });
    expect(validateConfig({ timeoutMs: undefined, auth: { guest: undefined } })).toEqual({
      valid: true,
      issues: [],
    });
  });

  it('accepts a baseUrl with a trailing slash (defineConfig normalises it)', () => {
    expect(validateConfig({ baseUrl: 'https://api.ota.com/' }).valid).toBe(true);
    expect(validateConfig({ baseUrl: 'https://api.ota.com' }).valid).toBe(true);
  });

  it('collects every issue with path, code, message and params', () => {
    const result = validateConfig({
      baseUrl: 'nope',
      timeoutMs: -1,
      currency: 'RUPEES',
      search: { resultMode: 'both' },
    });
    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual([
      'baseUrl:invalid_url',
      'timeoutMs:min',
      'currency:invalid_format',
      'search.resultMode:invalid_enum',
    ]);
    for (const i of result.issues) {
      expect(typeof i.path).toBe('string');
      expect(typeof i.code).toBe('string');
      expect(typeof i.message).toBe('string');
      expect(i.message.startsWith(i.path)).toBe(true);
      expect(i.params).toBeTypeOf('object');
    }
    expect(result.issues[3].params).toEqual({
      allowed: ['per_slice', 'combined', 'auto'],
      received: 'both',
    });
  });

  it('treats null as a reported value, not as "use the default"', () => {
    expect(codes(validateConfig({ timeoutMs: null }))).toEqual(['timeoutMs:invalid_type']);
    expect(codes(validateConfig({ search: null }))).toEqual(['search:invalid_type']);
  });

  it('does not mutate or freeze its input and never logs', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = { baseUrl: 'https://api.ota.com/', search: { resultMode: 'both' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    validateConfig(input);
    expect(input).toEqual(snapshot);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.search)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('agrees with defineConfig: valid input defines, invalid input throws the same issues', () => {
    const good = { search: { resultMode: 'per_slice' }, currency: 'eur' };
    expect(validateConfig(good).valid).toBe(true);
    expect(() => defineConfig(good)).not.toThrow();
    const bad = { retries: -2, logger: { level: 'loud' } };
    expect(failure(bad).issues).toEqual(validateConfig(bad).issues);
  });
});
