/**
 * Test helper (docs/CONTRIBUTING.md §6): builds a **real** `ModuleContext` — and optionally a full
 * client — without any network, so each domain module can be tested in isolation.
 * `createTestContext()` assembles the same siblings `core/client.js` wires, in the same order and
 * with the same real factories (`defineConfig` → logger → memory storage → events → store with the
 * `prefs` / `bootstrap` slices → i18n → telemetry → features → endpoints → http → auth → access →
 * the default interceptor set → payments port) and hands them to `createContext`. Network goes
 * through `globalThis.fetch` at call time, so the MSW server of `test/setup.js` (`server.use(...)`)
 * answers it unless a `fetch` is injected. `ctx.modules.<name>` resolves the provided stubs, or
 * factories lazily (first read, same `ctx`), and the registry stays settable through `register`.
 * `authenticateAs()` uses `auth.setTokens()`, `asGuest()` / `guest: true` seed the guest identity
 * the way `createAuth` restores it, so neither touches the network. `destroy()` tears everything
 * down (modules, interceptors, auth, http, store, storage, listeners) and leaves no timer behind.
 * `createTestClient()` builds a real client through `createClient`, with the given factories merged
 * over `MODULE_FACTORIES` exactly as `config.modules` overrides are. Test code only: never imported
 * by `src/`; no `console.*`, no module‑level mutable state, SDK error classes only.
 */

import { defineConfig } from '../../src/core/config.js';
import { createEndpoints } from '../../src/core/endpoints.js';
import { createContext } from '../../src/core/context.js';
import { createClient, VERSION } from '../../src/core/client.js';
import { MODULE_FACTORIES } from '../../src/modules/index.js';
import { createHttp } from '../../src/http/client.js';
import { installDefaultInterceptors } from '../../src/http/interceptors.js';
import { createAuth } from '../../src/auth/session.js';
import { createAccess } from '../../src/auth/access.js';
import { createStore } from '../../src/state/store.js';
import { createEmitter } from '../../src/events/emitter.js';
import { createStorage } from '../../src/storage/adapters.js';
import { createI18n } from '../../src/utils/i18n.js';
import { createTelemetry, bindDomainEvents } from '../../src/utils/telemetry.js';
import { createFeatures } from '../../src/utils/features.js';
import { createLogger } from '../../src/utils/logger.js';
import { uuid } from '../../src/utils/id.js';
import { isPlainObject } from '../../src/utils/object.js';
import { ConfigError, UnsupportedError } from '../../src/errors/index.js';

/** @typedef {import('../../src/types.js').ClientConfig} ClientConfig */
/** @typedef {import('../../src/types.js').PaymentsPort} PaymentsPort */
/** @typedef {import('../../src/types.js').User} User */
/** @typedef {import('../../src/auth/session.js').Tokens} Tokens */
/** @typedef {import('../../src/core/context.js').ModuleContext} ModuleContext */
/** @typedef {import('../../src/core/context.js').ModuleTimers} ModuleTimers */
/** @typedef {import('../../src/modules/index.js').ModuleFactory} ModuleFactory */
/** @typedef {import('../../src/events/emitter.js').EventPayload} EventPayload */

/** Base URL every test context talks to (the MSW handlers of `test/setup.js` listen here). */
export const TEST_BASE_URL = 'https://api.ota.com';

/** The account `authenticateAs()` signs in by default. @type {Readonly<User>} */
export const TEST_USER = Object.freeze({
  id: 'u_test',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  verified: Object.freeze({ email: true, phone: false }),
  providers: Object.freeze([]),
  createdAt: '2026-01-01T00:00:00Z',
});

/** Tokens `authenticateAs()` applies by default (no expiry, so no refresh timer is armed). */
export const TEST_TOKENS = Object.freeze({ accessToken: 'acc_test', refreshToken: 'ref_test' });

/** Guest identity `asGuest()` / `guest: true` install by default. */
export const TEST_GUEST = Object.freeze({ guestId: 'g_test', guestToken: 'gt_test' });

/** Initial `prefs` slice, as `core/client.js` registers it (docs/README.md §5). */
const PREFS_INITIAL = Object.freeze({
  locale: null,
  currency: null,
  market: null,
  homeAirport: null,
  pricePer: 'pax',
  hour12: null,
});

/** Initial `bootstrap` slice, as `core/client.js` registers it. */
const BOOTSTRAP_INITIAL = Object.freeze({
  loaded: false,
  flags: Object.freeze({}),
  limits: Object.freeze({}),
  markets: Object.freeze([]),
  currencies: Object.freeze([]),
  paymentMethods: Object.freeze([]),
  version: null,
});

/** Module name syntax (`search`, `priceAlerts`); the prototype‑pollution vectors are refused. */
const NAME_RE = /^[A-Za-z_$][\w$]*$/;
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Path `auth.ensureGuestSession` posts to (`core/endpoints.js`). */
const GUEST_PATH = '/v1/sessions/guest';

/**
 * Options of `createTestContext`.
 * @typedef {Object} TestContextOptions
 * @property {Partial<ClientConfig>} [config]  Merged over the quiet test defaults (`baseUrl`
 *   `https://api.ota.com`, `autoBootstrap: false`, `retries: 0`, `logger.level: 'silent'`,
 *   `storage: 'local'`). `storage` only names the persistence kind the real code sees (auth keeps
 *   nothing in storage for `'memory'`); the backing facade is always the memory driver.
 * @property {Record<string, Record<string, any> | ModuleFactory>} [modules]  Sibling module stubs
 *   (plain objects) or factories (`(ctx) => api`, run lazily on the first `ctx.modules.<name>` read
 *   with this very `ctx`).
 * @property {typeof fetch} [fetch]  Fetch implementation handed to `http`; default `globalThis.fetch`
 *   looked up per request (MSW).
 * @property {(() => number) | number} [now]  Clock in epoch ms (a number is a frozen clock).
 * @property {ModuleTimers} [timers]  Injectable timers; default: the globals looked up at call time
 *   (so `vi.useFakeTimers()` applies).
 * @property {boolean} [authenticated]  Start signed in as `TEST_USER` with `TEST_TOKENS`.
 * @property {boolean | { guestId: string, guestToken: string }} [guest]  Start with a guest identity
 *   (`TEST_GUEST` or the given one), seeded in storage before `createAuth` restores it.
 * @property {PaymentsPort} [payments]  Payments port; default: a null port whose operations reject
 *   with `UnsupportedError{feature:'payments'}`.
 * @property {string} [name]  Logger scope of `ctx.logger` (default `'test'`).
 */

/**
 * What `createTestContext` returns.
 * @typedef {Object} TestContext
 * @property {ModuleContext} ctx  The frozen context to hand to a module factory.
 * @property {import('../../src/http/client.js').Http} http
 * @property {import('../../src/state/store.js').Store} store
 * @property {import('../../src/events/emitter.js').Emitter} events
 * @property {import('../../src/storage/adapters.js').StorageFacade} storage  The one memory‑driven
 *   facade every persistence kind (`'local'`, `'session'`, `'memory'`) maps to; seed / inspect keys
 *   such as `guestId` or `state:prefs` here.
 * @property {import('../../src/auth/session.js').Auth} auth
 * @property {import('../../src/auth/access.js').Access} access
 * @property {import('../../src/core/endpoints.js').Endpoints} endpoints
 * @property {Readonly<ClientConfig>} config
 * @property {Record<string, unknown>} registry  The module registry `ctx.modules` reads.
 * @property {(name: string, value: Record<string, any> | ModuleFactory) => void} register  Add or
 *   replace a sibling stub / factory after creation.
 * @property {(pattern?: string) => Array<{ type: string, payload: EventPayload }>} emitted  Every
 *   event emitted since the context was built (optionally filtered by an exact name or `'ns:*'`).
 * @property {(user?: User|null, tokens?: Partial<Tokens>) => User|null} authenticateAs  Sign in
 *   through `auth.setTokens` (no network); returns the user now in session.
 * @property {(identity?: { guestId: string, guestToken: string }) => Promise<{ guestId: string, guestToken: string }>} asGuest
 *   Make the session a guest one without network (an authenticated session is cleared first; an
 *   existing guest identity is kept).
 * @property {() => void} destroy  Tear everything down; leaves no timers or listeners.
 */

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObjectLike(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string|undefined} */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Run `fn`, swallowing whatever it throws (teardown must never break on a failing sibling).
 * @param {() => unknown} fn
 */
function safe(fn) {
  try {
    fn();
  } catch {
    // teardown is best effort
  }
}

/**
 * Timers that resolve the globals at call time (`vi.useFakeTimers()` friendly).
 * @returns {ModuleTimers}
 */
function globalTimers() {
  return Object.freeze({
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(/** @type {any} */ (h)),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(/** @type {any} */ (h)),
  });
}

/**
 * A `PaymentsPort` whose operations reject with `UnsupportedError{feature:'payments'}` (what
 * `createClient` installs when no port is configured).
 * @returns {PaymentsPort & { isNull: true }}
 */
function nullPaymentsPort() {
  const unsupported = () =>
    new UnsupportedError('Payments are not configured in this test context', {
      feature: 'payments',
    });
  const reject = () => Promise.reject(unsupported());
  const fail = () => {
    throw unsupported();
  };
  return /** @type {any} */ (
    Object.freeze({
      isNull: true,
      methods: reject,
      quote: reject,
      credits: Object.freeze({ apply: reject, remove: reject, applied: () => [] }),
      emiPlans: reject,
      createIntent: reject,
      mount: reject,
      tokenize: reject,
      confirm: reject,
      handleAction: reject,
      waitForResult: reject,
      pay: reject,
      resumeAfterRedirect: reject,
      cancel: reject,
      retry: reject,
      intent: () => null,
      status: () => null,
      quoteState: () => null,
      savedMethods: Object.freeze({ list: reject, remove: reject, setDefault: reject }),
      receipt: reject,
      refunds: reject,
      gateways: Object.freeze({ register: fail, get: fail, list: () => [] }),
      clear: () => {},
    })
  );
}

/**
 * Validate a module name.
 * @param {unknown} name
 * @returns {string}
 */
function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || UNSAFE_NAMES.has(name)) {
    throw new ConfigError(
      `createTestContext: module name must be an identifier such as 'search' (received ${String(name)})`,
      { details: { path: 'modules', received: name } }
    );
  }
  return name;
}

/**
 * Normalise a guest identity option.
 * @param {unknown} value
 * @returns {{ guestId: string, guestToken: string }}
 */
function guestIdentity(value) {
  if (value === true || value === undefined || value === null) return { ...TEST_GUEST };
  const v = /** @type {Record<string, unknown>} */ (isPlainObject(value) ? value : {});
  const guestId = str(v.guestId);
  const guestToken = str(v.guestToken);
  if (!guestId || !guestToken) {
    throw new ConfigError('createTestContext: guest must be true or { guestId, guestToken }', {
      details: { path: 'guest' },
    });
  }
  return { guestId, guestToken };
}

/**
 * Quiet, network‑free config: the test defaults under the caller's, `logger` merged one level deep
 * so a `sink` does not drop the `'silent'` level. `storage` defaults to `'local'` — the persistence
 * kind a browser run uses, which is what makes `createAuth` persist and restore the guest identity
 * (`'memory'` means "closure only" to it) — while the backing facade is always the memory driver.
 * @param {Partial<ClientConfig>|undefined} config
 * @returns {Readonly<ClientConfig>}
 */
function testConfig(config) {
  if (config !== undefined && config !== null && !isPlainObject(config)) {
    throw new ConfigError('createTestContext: config must be a plain object', {
      details: { path: 'config' },
    });
  }
  const given = /** @type {Record<string, any>} */ (config || {});
  return defineConfig({
    baseUrl: TEST_BASE_URL,
    autoBootstrap: false,
    retries: 0,
    storage: 'local',
    ...given,
    logger: { level: 'silent', ...(isPlainObject(given.logger) ? given.logger : {}) },
  });
}

/**
 * Whether an event `type` matches `pattern` (`'*'`, `'ns:*'` or an exact name).
 * @param {string} type
 * @param {string} pattern
 * @returns {boolean}
 */
function matches(type, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) return type.startsWith(pattern.slice(0, -1));
  return type === pattern;
}

// ── createTestContext ────────────────────────────────────────────────────────────────────────────

/**
 * Build a real `ModuleContext` (and its siblings) without network. Effects: storage (memory) seeded
 * with the guest identity when `guest` is set · state `prefs`, `bootstrap`, `session` · emit
 * `auth:login` when `authenticated` (before the recorder starts).
 * @param {TestContextOptions} [options]
 * @returns {TestContext}
 * @throws {ConfigError} for an invalid option, module name, factory or config
 */
export function createTestContext(options = {}) {
  if (!isPlainObject(options)) {
    throw new ConfigError('createTestContext: options must be a plain object', {
      details: { path: 'options' },
    });
  }
  const o = /** @type {TestContextOptions} */ (options);
  if (o.modules !== undefined && !isPlainObject(o.modules)) {
    throw new ConfigError('createTestContext: modules must be an object of name → api | factory', {
      details: { path: 'modules' },
    });
  }
  if (o.fetch !== undefined && typeof o.fetch !== 'function') {
    throw new ConfigError('createTestContext: fetch must be a function', {
      details: { path: 'fetch' },
    });
  }
  if (o.now !== undefined && typeof o.now !== 'function' && typeof o.now !== 'number') {
    throw new ConfigError('createTestContext: now must be a function or a number (ms)', {
      details: { path: 'now' },
    });
  }
  if (o.payments !== undefined && !isObjectLike(o.payments)) {
    throw new ConfigError('createTestContext: payments must be a PaymentsPort object', {
      details: { path: 'payments' },
    });
  }

  const cfg = testConfig(o.config);
  const fixed = typeof o.now === 'number' ? o.now : null;
  const now = typeof o.now === 'function' ? o.now : fixed !== null ? () => fixed : () => Date.now();
  const timers = o.timers || globalTimers();
  const fetchImpl = o.fetch || cfg.fetch;
  let destroyed = false;

  // ── logger ──
  /** @type {import('../../src/utils/logger.js').LoggerOptions} */
  const loggerOptions = { level: cfg.logger.level };
  if (cfg.logger.sink !== undefined) loggerOptions.sink = /** @type {any} */ (cfg.logger.sink);
  if (Array.isArray(cfg.logger.redact)) loggerOptions.redact = [...cfg.logger.redact];
  const logger = createLogger(loggerOptions);

  // ── events, storage (one memory facade for every persistence kind) ──
  const events = createEmitter({ logger: logger.child('events'), now });
  const storage = createStorage({
    driver: 'memory',
    namespace: cfg.storageNamespace,
    events,
    now,
  });
  const storageFor = () => storage;

  // ── store + core slices ──
  const store = createStore({
    storage: storageFor,
    events,
    logger: logger.child('store'),
    devtools: cfg.devtools === true,
    timers,
    now,
  });
  store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: { storage: 'local' } });
  store.registerSlice('bootstrap', { initial: BOOTSTRAP_INITIAL });
  /** @type {Record<string, string>} */
  const configPrefs = {};
  if (str(cfg.locale)) configPrefs.locale = /** @type {string} */ (str(cfg.locale));
  if (str(cfg.currency)) configPrefs.currency = /** @type {string} */ (str(cfg.currency));
  if (str(cfg.market)) configPrefs.market = /** @type {string} */ (str(cfg.market));
  if (Object.keys(configPrefs).length > 0) {
    store.set('prefs', (s) => ({ ...s, ...configPrefs }), { action: 'prefs/config' });
  }

  // ── i18n (canonical locale flows back into prefs, as in the client) ──
  /** @type {import('../../src/utils/i18n.js').I18nOptions} */
  const i18nOptions = {};
  const initialLocale = configPrefs.locale || cfg.i18n.fallback;
  if (initialLocale) i18nOptions.locale = initialLocale;
  if (cfg.i18n.fallback) i18nOptions.fallback = cfg.i18n.fallback;
  if (isPlainObject(cfg.i18n.messages))
    i18nOptions.messages = /** @type {any} */ (cfg.i18n.messages);
  const i18n = createI18n(i18nOptions);
  if (configPrefs.locale && configPrefs.locale !== i18n.getLocale()) {
    store.set('prefs', { locale: i18n.getLocale() }, { action: 'prefs/canonical' });
  }

  // ── telemetry, features, endpoints ──
  const telemetry = createTelemetry({
    adapters: [...cfg.telemetry.adapters],
    enabled: cfg.telemetry.enabled,
    sampleRate: cfg.telemetry.sampleRate,
    context: { sdk: 'wayfarer', sdkVersion: VERSION },
    events,
    logger: logger.child('telemetry'),
  });
  const unbindTelemetry = bindDomainEvents(telemetry, events);
  const features = createFeatures({ initial: { ...cfg.features }, events, store });
  const endpoints = createEndpoints(cfg.endpoints);

  // ── http ──
  /** @type {Record<string, string>} */
  const defaultHeaders = {};
  if (str(cfg.clientId)) defaultHeaders['X-Client-Id'] = /** @type {string} */ (str(cfg.clientId));
  const http = createHttp({
    baseUrl: cfg.baseUrl,
    fetch: fetchImpl,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
    headers: defaultHeaders,
    events,
    logger: logger.child('http'),
    storage,
    now,
    timers,
  });

  // ── auth (a seeded guest identity is restored at creation, as a reload would) ──
  if (o.guest) {
    const g = guestIdentity(o.guest);
    storage.set('guestId', g.guestId);
    storage.set('guestToken', g.guestToken);
  }
  const auth = createAuth({
    http,
    store,
    storage: storageFor,
    events,
    config: cfg,
    endpoints,
    now,
    timers,
    logger: logger.child('auth'),
  });
  const access = createAccess({ policy: cfg.access, auth, events });

  // ── default interceptor set (same deps as the client) ──
  const uninstallInterceptors = installDefaultInterceptors(http, {
    auth,
    store,
    storage,
    apiKey: cfg.apiKey,
    logger: logger.child('http'),
    telemetry,
    getDeviceId: () => uuid(),
  });

  const payments = /** @type {PaymentsPort} */ (o.payments || nullPaymentsPort());

  // ── module registry: stubs as data, factories as lazy getters resolved on first read ──
  /** @type {Record<string, unknown>} */
  const registry = {};
  /** Names whose factory is running (a sibling read inside a factory body is a contract breach). */
  const resolving = new Set();
  /** @type {Map<string, Record<string, any>>} resolved APIs in resolution order (destroyed in reverse) */
  const resolved = new Map();
  /** @type {ModuleContext} */
  let ctx;

  /** @type {TestContext['register']} */
  function register(name, value) {
    const n = assertName(name);
    if (typeof value === 'function') {
      const factory = /** @type {ModuleFactory} */ (value);
      Object.defineProperty(registry, n, {
        enumerable: true,
        configurable: true,
        get() {
          if (resolving.has(n)) {
            throw new ConfigError(
              `createTestContext: module '${n}' reads itself through ctx.modules inside its factory`,
              { details: { path: `modules.${n}` } }
            );
          }
          resolving.add(n);
          let api;
          try {
            api = factory(ctx);
          } finally {
            resolving.delete(n);
          }
          if (!isObjectLike(api)) {
            throw new ConfigError(`createTestContext: module '${n}' factory must return its API`, {
              details: { path: `modules.${n}`, received: api === null ? 'null' : typeof api },
            });
          }
          Object.defineProperty(registry, n, {
            value: api,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          resolved.set(n, api);
          return api;
        },
      });
      resolved.delete(n);
      return;
    }
    if (!isObjectLike(value)) {
      throw new ConfigError(`createTestContext: modules.${n} must be an API object or a factory`, {
        details: { path: `modules.${n}`, received: value === null ? 'null' : typeof value },
      });
    }
    Object.defineProperty(registry, n, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    resolved.set(n, /** @type {Record<string, any>} */ (value));
  }
  for (const [name, value] of Object.entries(o.modules || {})) register(name, value);

  ctx = createContext({
    config: cfg,
    endpoints,
    http,
    store,
    events,
    storage,
    auth,
    access,
    i18n,
    telemetry,
    logger,
    features,
    payments,
    registry,
    now,
    timers,
    scope: str(o.name) || 'test',
  });

  // ── session helpers ──

  /** @type {TestContext['authenticateAs']} */
  function authenticateAs(user = TEST_USER, tokens = {}) {
    auth.setTokens({ ...TEST_TOKENS, ...(isPlainObject(tokens) ? tokens : {}), user });
    return auth.getUser();
  }

  /** @type {TestContext['asGuest']} */
  async function asGuest(identity = TEST_GUEST) {
    const g = guestIdentity(identity);
    if (auth.isAuthenticated()) auth.clearTokens();
    if (auth.isGuest()) return auth.ensureGuestSession();
    // Run the real handshake in process: the one `POST /v1/sessions/guest` is answered by a stub
    // fetch, everything else keeps going to the configured fetch (MSW by default).
    const previous = fetchImpl;
    const guestUrl = `${cfg.baseUrl}${GUEST_PATH}`;
    /** @type {typeof fetch} */
    const stub = (input, init) => {
      const url =
        typeof input === 'string' ? input : String(input && input.url ? input.url : input);
      if (url.split('?')[0] === guestUrl) {
        return Promise.resolve(
          new Response(JSON.stringify(g), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      const fallback = previous || globalThis.fetch;
      return fallback(input, init);
    };
    http.setFetch(stub);
    try {
      return await auth.ensureGuestSession();
    } finally {
      http.setFetch(previous);
    }
  }

  if (o.authenticated) authenticateAs();

  // ── event recorder (everything after the starting state) ──
  /** @type {Array<{ type: string, payload: EventPayload }>} */
  const records = [];
  const offRecorder = events.on('*', (payload) => {
    records.push({ type: payload.type, payload });
  });

  /** @type {TestContext['emitted']} */
  function emitted(pattern = '*') {
    if (typeof pattern !== 'string' || pattern === '') return records.slice();
    return records.filter((r) => matches(r.type, pattern));
  }

  // ── destroy ──

  /** @type {TestContext['destroy']} */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    safe(() => http.abortAll('destroyed'));
    for (const [, api] of Array.from(resolved).reverse()) {
      if (typeof api.destroy === 'function') safe(() => api.destroy());
    }
    resolved.clear();
    safe(offRecorder);
    safe(uninstallInterceptors);
    safe(() => auth.destroy());
    safe(() => http.destroy());
    safe(() => features.destroy());
    safe(unbindTelemetry);
    safe(() => telemetry.flush());
    safe(() => i18n.destroy());
    safe(() => store.destroy());
    safe(() => storage.destroy());
    safe(() => events.clear());
  }

  return {
    ctx,
    http,
    store,
    events,
    storage,
    auth,
    access,
    endpoints,
    config: cfg,
    registry,
    register,
    emitted,
    authenticateAs,
    asGuest,
    destroy,
  };
}

// ── createTestClient ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a real client through `createClient` with quiet, network‑free defaults (`autoBootstrap:
 * false`, `storage: 'memory'`, `retries: 0`, `logger.level: 'silent'`). `modules` is passed as
 * `config.modules`, so `createClient` merges it over `MODULE_FACTORIES` (a name present in both is
 * replaced; `null` drops a registered one). With `isolate: true` every registered factory the caller
 * did not name is dropped, so only the given modules are instantiated. Effects: those of
 * `createClient` (state, storage hydrate, `client:ready`).
 * @param {{ modules?: Record<string, ModuleFactory|null>, config?: Partial<ClientConfig>, isolate?: boolean }} [options]
 * @returns {import('../../src/core/client.js').OtaClient}
 * @throws {ConfigError} as `createClient` does
 */
export function createTestClient(options = {}) {
  if (!isPlainObject(options)) {
    throw new ConfigError('createTestClient: options must be a plain object', {
      details: { path: 'options' },
    });
  }
  const { modules, config, isolate } = /** @type {Record<string, any>} */ (options);
  if (modules !== undefined && !isPlainObject(modules)) {
    throw new ConfigError('createTestClient: modules must be an object of name → factory', {
      details: { path: 'modules' },
    });
  }
  if (config !== undefined && config !== null && !isPlainObject(config)) {
    throw new ConfigError('createTestClient: config must be a plain object', {
      details: { path: 'config' },
    });
  }
  /** @type {Record<string, ModuleFactory|null>} */
  const overrides = { ...(modules || {}) };
  if (isolate === true) {
    for (const name of Object.keys(MODULE_FACTORIES)) {
      if (!Object.prototype.hasOwnProperty.call(overrides, name)) overrides[name] = null;
    }
  }
  const given = /** @type {Record<string, any>} */ (config || {});
  return createClient({
    baseUrl: TEST_BASE_URL,
    autoBootstrap: false,
    storage: 'memory',
    retries: 0,
    ...given,
    logger: { level: 'silent', ...(isPlainObject(given.logger) ? given.logger : {}) },
    modules: overrides,
  });
}
