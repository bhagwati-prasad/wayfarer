/**
 * Composition root of the Wayfarer SDK (docs/api/01-core.md §1, docs/README.md §3): `createClient`
 * turns a `ClientConfig` into one `OtaClient` by wiring, in dependency order, `defineConfig` →
 * logger → storage factory (one facade per persistence kind) → events → store (`prefs` and
 * `bootstrap` slices live here, sanitised after hydration) → i18n → telemetry (+ `bindDomainEvents`)
 * → features → endpoints → http → auth → access → the default interceptor set → the payments port
 * (the host's, attached, or a null port whose methods reject with `UnsupportedError{feature:
 * 'payments'}`) → every factory of `MODULE_FACTORIES` (merged with `config.modules`) through a
 * `ModuleContext` → plugins (which already see `client.ready`, a promise settled after `client:ready`)
 * → the optional bootstrap (`GET /v1/config`, failures tolerated with a warning) → `client:ready`. It
 * also owns the presentation preferences (`setLocale` / `setCurrency` / `setMarket` → `prefs` slice +
 * storage + i18n + `prefs:change`), `snapshot` / `restore` (store only; tokens are never serialised;
 * restored `prefs` / `bootstrap` content is coerced to its documented shape), `use(plugin)` and
 * `destroy()` (abort requests, destroy modules, uninstall plugins, flush the store, clear listeners,
 * `client:destroyed`); whatever was built when composition fails half way is torn down the same way.
 * This script must not contain domain logic, must not call `fetch` (only `http` does), must not touch
 * `window` / `document` / `localStorage` (storage is injected and resolved at call time), keeps no
 * module‑level mutable state, never logs through `console` and never throws a plain `Error` (only the
 * classes of `src/errors/index.js`).
 */

import { defineConfig } from './config.js';
import { createEndpoints } from './endpoints.js';
import { createContext } from './context.js';
import { createHttp } from '../http/client.js';
import { installDefaultInterceptors } from '../http/interceptors.js';
import { createAuth } from '../auth/session.js';
import { createAccess } from '../auth/access.js';
import { createStore } from '../state/store.js';
import { createEmitter } from '../events/emitter.js';
import { createStorage } from '../storage/adapters.js';
import { createI18n } from '../utils/i18n.js';
import { createTelemetry, bindDomainEvents } from '../utils/telemetry.js';
import { createFeatures } from '../utils/features.js';
import { createLogger } from '../utils/logger.js';
import { uuid } from '../utils/id.js';
import { deepEqual, isPlainObject } from '../utils/object.js';
import { MODULE_FACTORIES } from '../modules/index.js';
import * as utils from '../utils/index.js';
import {
  AbortError,
  ConfigError,
  UnsupportedError,
  ValidationError,
  isSdkError,
  wrap,
} from '../errors/index.js';

/** @typedef {import('../types.js').ClientConfig} ClientConfig */
/** @typedef {import('../types.js').Plugin} Plugin */
/** @typedef {import('../types.js').PaymentsPort} PaymentsPort */
/** @typedef {import('../types.js').RequestOpts} RequestOpts */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('./context.js').ModuleContext} ModuleContext */
/** @typedef {import('./context.js').ModuleTimers} ModuleTimers */
/** @typedef {import('../modules/index.js').ModuleFactory} ModuleFactory */
/** @typedef {import('../state/store.js').StoreSnapshot} StoreSnapshot */
/** @typedef {import('../storage/adapters.js').StorageFacade} StorageFacade */
/** @typedef {import('../state/store.js').PersistKind} PersistKind */

/**
 * Presentation preferences (`prefs` slice, docs/README.md §5). `null` = not decided yet (the
 * bootstrap config fills gaps).
 * @typedef {Object} Prefs
 * @property {string|null} locale  BCP‑47 tag, canonicalised (`en-IN`).
 * @property {string|null} currency  ISO‑4217 code, upper‑cased.
 * @property {string|null} market  Point‑of‑sale market.
 * @property {string|null} homeAirport  IATA code.
 * @property {'pax'|'total'} pricePer  Price display mode.
 * @property {boolean|null} hour12  12‑hour clock; `null` = locale default.
 */

/**
 * Runtime configuration fetched by `client.bootstrap()` (`bootstrap` slice minus `loaded`). Unknown
 * members of the backend document are kept as they are.
 * @typedef {{
 *   flags: Record<string, boolean|string>,
 *   limits: Record<string, unknown>,
 *   markets: unknown[],
 *   currencies: unknown[],
 *   paymentMethods: unknown[],
 *   version: string|null,
 *   defaults?: Partial<Prefs>,
 *   [ext: string]: unknown
 * }} BootstrapConfig
 */

/**
 * The `bootstrap` slice.
 * @typedef {BootstrapConfig & { loaded: boolean }} BootstrapState
 */

/**
 * What `client.snapshot()` returns and `client.restore()` accepts: the store snapshot (every
 * non‑secret slice; the `session` slice and therefore every token is excluded) with a version stamp.
 * @typedef {Object} ClientSnapshot
 * @property {number} version  Snapshot format version.
 * @property {number} at  Epoch ms when it was taken.
 * @property {StoreSnapshot} store  `store.snapshot()`.
 */

/**
 * Payload of `prefs:change` (the emitter adds `type` and `at`).
 * @typedef {Object} PrefsChange
 * @property {Readonly<Prefs>} prefs  Preferences after the change.
 * @property {Readonly<Prefs>} previous  Preferences before it.
 * @property {string[]} changed  Keys whose value differs.
 */

/**
 * What `config.payments.attach` receives when the port exposes `attach()`.
 * @typedef {Object} PaymentsAttachment
 * @property {import('../http/client.js').Http} http
 * @property {import('../state/store.js').Store} store
 * @property {import('../events/emitter.js').Emitter} events
 * @property {Readonly<ClientConfig>} config
 * @property {import('./endpoints.js').Endpoints} endpoints
 * @property {import('../auth/session.js').Auth} auth
 * @property {import('../auth/access.js').Access} access
 * @property {StorageFacade} storage
 * @property {import('../utils/logger.js').Logger} logger
 * @property {import('../utils/i18n.js').I18n} i18n
 * @property {import('../utils/telemetry.js').Telemetry} telemetry
 * @property {import('../utils/features.js').Features} features
 */

/**
 * The client returned by `createClient` (docs/api/01-core.md §1). Domain modules are attached under
 * their name (`client.search`, `client.booking`, …) as they are registered in `MODULE_FACTORIES`.
 * @typedef {Object} OtaClient
 * @property {string} version  SDK version.
 * @property {import('../http/client.js').Http} http
 * @property {import('../auth/session.js').Auth} auth
 * @property {import('../auth/access.js').Access} access
 * @property {import('../state/store.js').Store} store
 * @property {import('../events/emitter.js').Emitter} events
 * @property {StorageFacade} storage
 * @property {import('../utils/i18n.js').I18n} i18n
 * @property {import('../utils/telemetry.js').Telemetry} telemetry
 * @property {import('../utils/features.js').Features} features
 * @property {import('../utils/logger.js').Logger} logger
 * @property {import('./endpoints.js').Endpoints} endpoints
 * @property {PaymentsPort} payments  The injected `PaymentsPort`, or the null port.
 * @property {typeof utils} utils  `@wayfarer/sdk/utils`.
 * @property {Promise<OtaClient>} ready  Settles (never rejects) once `client:ready` has been emitted
 *   (or the client was destroyed first). Available from the moment plugins are installed.
 * @property {(opts?: RequestOpts) => Promise<BootstrapConfig>} bootstrap  Fetch the runtime config.
 * @property {(plugin: Plugin) => OtaClient} use  Install a plugin.
 * @property {(locale: string) => void} setLocale
 * @property {(code: string) => void} setCurrency
 * @property {(market: string) => void} setMarket
 * @property {() => Readonly<Prefs>} getPrefs
 * @property {() => Readonly<ClientConfig>} getConfig
 * @property {import('../events/emitter.js').Emitter['on']} on
 * @property {import('../events/emitter.js').Emitter['once']} once
 * @property {import('../events/emitter.js').Emitter['off']} off
 * @property {() => ClientSnapshot} snapshot
 * @property {(snapshot: ClientSnapshot | StoreSnapshot | { slices: Record<string, unknown> }) => void} restore
 * @property {() => void} destroy
 * @property {() => boolean} isDestroyed
 */

/** SDK version (kept in sync with `package.json`). */
export const VERSION = '0.1.0';

const SNAPSHOT_VERSION = 1;
const BOOTSTRAP_KEY = 'client.bootstrap';
const BOOTSTRAP_PATH = '/v1/config';
/** Persisted copy of the runtime config survives this long (docs/api/01-core.md §1 "storage bootstrap (ttl)"). */
const BOOTSTRAP_TTL_MS = 6 * 60 * 60 * 1000;
const CURRENCY_RE = /^[A-Za-z]{3}$/;
/** Keys never copied out of hydrated / restored / remote data (prototype‑pollution vectors). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @type {Readonly<Prefs>} */
const PREFS_INITIAL = Object.freeze({
  locale: null,
  currency: null,
  market: null,
  homeAirport: null,
  pricePer: 'pax',
  hour12: null,
});

/** The documented members of `prefs`, in slice order. */
const PREFS_KEYS = Object.freeze(Object.keys(PREFS_INITIAL));

/** @type {Readonly<BootstrapState>} */
const BOOTSTRAP_INITIAL = Object.freeze({
  loaded: false,
  flags: Object.freeze({}),
  limits: Object.freeze({}),
  markets: Object.freeze([]),
  currencies: Object.freeze([]),
  paymentMethods: Object.freeze([]),
  version: null,
});

/** Hooks of `config.hooks` the HTTP client fires itself; the others are routed to events / store. */
const HTTP_HOOKS = new Set([
  'beforeRequest',
  'afterResponse',
  'onRetry',
  'onError',
  'onAbort',
  'onTimeout',
]);

/** Client members a domain module may never shadow. */
const RESERVED_NAMES = new Set([
  'version',
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
  'ready',
  'bootstrap',
  'use',
  'setLocale',
  'setCurrency',
  'setMarket',
  'getPrefs',
  'getConfig',
  'on',
  'once',
  'off',
  'snapshot',
  'restore',
  'destroy',
  'isDestroyed',
  'config',
  'modules',
  '__proto__',
  'constructor',
  'prototype',
]);

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObjectLike(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {v is Function} */
function isFn(v) {
  return typeof v === 'function';
}

/** @param {unknown} v @returns {string|undefined} */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * @param {string} path @param {string} code @param {string} message
 * @returns {ValidationError}
 */
function invalid(path, code, message) {
  /** @type {ValidationIssue[]} */
  const issues = [{ path, code, message }];
  return new ValidationError(message, { issues });
}

/**
 * Run `fn`, swallowing whatever it throws (teardown paths must never break on a failing sibling).
 * @param {() => unknown} fn
 * @param {(e: unknown) => void} [onError]
 */
function safe(fn, onError) {
  try {
    fn();
  } catch (e) {
    if (onError) onError(e);
  }
}

/**
 * Timers that resolve the globals at call time (SSR‑safe, `vi.useFakeTimers()` friendly).
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
 * A `PaymentsPort` for clients created without `config.payments`: every operation rejects with
 * `UnsupportedError{feature:'payments'}` (synchronous registry writes throw it), the synchronous
 * reads report an empty state, so booking flows stop cleanly at `pending_payment`.
 * @returns {PaymentsPort & { isNull: true }}
 */
function createNullPaymentsPort() {
  const unsupported = () =>
    new UnsupportedError(
      'Payments are not configured: pass createPayments(...) from @wayfarer/sdk/payments as config.payments',
      { feature: 'payments' }
    );
  const reject = () => Promise.reject(unsupported());
  const fail = () => {
    throw unsupported();
  };
  return Object.freeze({
    isNull: /** @type {true} */ (true),
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
  });
}

/**
 * Keep only well‑formed feature flags out of untrusted data (a backend document, a hydrated slice or
 * a restored snapshot): boolean / string values (finite numbers become strings), never a reserved
 * key, so `features.set` is guaranteed to accept the result.
 * @param {unknown} flags
 * @returns {Record<string, boolean|string>}
 */
function cleanFlags(flags) {
  /** @type {Record<string, boolean|string>} */
  const out = {};
  if (!isPlainObject(flags)) return out;
  for (const [k, v] of Object.entries(flags)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

/**
 * Coerce a `prefs`‑shaped value (hydrated from storage or restored from a snapshot, neither of which
 * is trusted) to the documented member types; anything else falls back to the initial value and
 * unknown members are dropped.
 * @param {unknown} value
 * @returns {Prefs}
 */
function sanitisePrefs(value) {
  const src = /** @type {Record<string, unknown>} */ (isPlainObject(value) ? value : {});
  const currency = str(src.currency);
  return {
    locale: str(src.locale) || null,
    currency: currency && CURRENCY_RE.test(currency) ? currency.toUpperCase() : null,
    market: str(src.market) || null,
    homeAirport: str(src.homeAirport) || null,
    pricePer: src.pricePer === 'total' ? 'total' : 'pax',
    hour12: typeof src.hour12 === 'boolean' ? src.hour12 : null,
  };
}

/**
 * Give a `bootstrap`‑shaped object (the backend document, a hydrated slice or a restored snapshot)
 * its documented member types — missing or malformed members get their empty value — keeping every
 * unknown member except reserved keys.
 * @param {Record<string, unknown>} doc
 * @returns {Omit<BootstrapConfig, 'defaults'>}
 */
function shapeBootstrap(doc) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!UNSAFE_KEYS.has(k)) out[k] = v;
  }
  out.flags = cleanFlags(doc.flags);
  out.limits = isPlainObject(doc.limits) ? doc.limits : {};
  out.markets = Array.isArray(doc.markets) ? doc.markets : [];
  out.currencies = Array.isArray(doc.currencies) ? doc.currencies : [];
  out.paymentMethods = Array.isArray(doc.paymentMethods) ? doc.paymentMethods : [];
  out.version = str(doc.version) || null;
  return /** @type {Omit<BootstrapConfig, 'defaults'>} */ (out);
}

/**
 * Shape a backend `/v1/config` document into a `BootstrapConfig`: known members get their documented
 * types (missing ones their empty value), everything else is kept, and the preference defaults
 * (`defaults` / `prefs` / top‑level `locale`, `currency`, `market`) are lifted into `defaults`.
 * @param {unknown} data
 * @returns {BootstrapConfig}
 * @throws {ValidationError} when the document is not a JSON object
 */
function normaliseBootstrap(data) {
  if (!isPlainObject(data)) {
    throw invalid('bootstrap', 'invalid_type', 'bootstrap config must be a JSON object');
  }
  const doc = /** @type {Record<string, any>} */ (data);
  const source = isPlainObject(doc.defaults)
    ? doc.defaults
    : isPlainObject(doc.prefs)
      ? doc.prefs
      : doc;
  /** @type {Partial<Prefs>} */
  const defaults = {};
  const locale = str(source.locale);
  const currency = str(source.currency);
  const market = str(source.market);
  if (locale) defaults.locale = locale;
  if (currency && CURRENCY_RE.test(currency)) defaults.currency = currency.toUpperCase();
  if (market) defaults.market = market;
  return { ...shapeBootstrap(doc), defaults };
}

// ── factory ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Compose http, auth, store, events, storage, i18n, telemetry, features and every domain module
 * into one client; install plugins; hydrate persisted slices; optionally bootstrap.
 * `config.modules` (name → factory) overrides or adds domain module factories for this client.
 * Effects: state all slices (initial) · storage read (hydrate) · emit `client:ready` · net
 * `GET /v1/config` only when `autoBootstrap`.
 * @param {Partial<ClientConfig> & { modules?: Record<string, ModuleFactory> }} [config]
 * @returns {OtaClient}
 * @throws {ConfigError} on an invalid configuration, module or plugin
 */
export function createClient(config = {}) {
  const raw = config === null || config === undefined ? {} : config;
  if (!isPlainObject(raw)) {
    throw new ConfigError('createClient: config must be a plain object', {
      details: { path: 'config', received: raw === null ? 'null' : typeof raw },
    });
  }
  // `modules` is a composition concern of this script, not a ClientConfig member.
  const { modules: moduleOverrides, ...configInput } = /** @type {Record<string, any>} */ (raw);
  if (moduleOverrides !== undefined && !isPlainObject(moduleOverrides)) {
    throw new ConfigError('createClient: modules must be an object of name → factory', {
      details: { path: 'modules' },
    });
  }
  const cfg = defineConfig(configInput);
  const now = () => Date.now();
  const timers = globalTimers();
  let destroyed = false;

  // ── logger ──
  /** @type {import('../utils/logger.js').LoggerOptions} */
  const loggerOptions = { level: cfg.logger.level };
  if (cfg.logger.sink !== undefined) loggerOptions.sink = /** @type {any} */ (cfg.logger.sink);
  if (Array.isArray(cfg.logger.redact)) loggerOptions.redact = [...cfg.logger.redact];
  const logger = createLogger(loggerOptions);
  const log = logger.child('client');

  // ── teardown bookkeeping (declared first so a half‑built client can be undone) ──

  /** Listener / interceptor removers to run on destroy, in registration order. @type {Array<() => void>} */
  const offs = [];
  /** @type {Map<string, (() => void) | null>} plugin name → uninstaller */
  const plugins = new Map();
  /** @type {Map<string, Record<string, any>>} module name → API */
  const registry = new Map();
  /** Disposers of the core parts, in creation order (run in reverse). @type {Array<() => unknown>} */
  const disposers = [];
  /** @type {import('../http/client.js').Http|null} */
  let httpRef = null;
  /** @type {import('../events/emitter.js').Emitter|null} */
  let eventsRef = null;

  /** Undo everything built so far (used when composition fails half way and by `destroy`). */
  function teardown() {
    if (httpRef) {
      const http = httpRef;
      safe(() => http.abortAll('destroyed'));
    }
    for (const [name, api] of Array.from(registry).reverse()) {
      if (isFn(api.destroy)) {
        safe(
          () => api.destroy(),
          (e) => log.warn(`module '${name}' failed to destroy`, { error: e })
        );
      }
    }
    registry.clear();
    for (const [name, uninstall] of Array.from(plugins).reverse()) {
      if (uninstall) {
        safe(uninstall, (e) => log.warn(`plugin '${name}' failed to uninstall`, { error: e }));
      }
    }
    plugins.clear();
    while (offs.length) safe(/** @type {() => void} */ (offs.pop()));
    while (disposers.length) safe(/** @type {() => unknown} */ (disposers.pop()));
  }

  try {
    // ── events ──
    const events = createEmitter({ logger: logger.child('events'), now });
    eventsRef = events;

    // ── storage factory: one facade per persistence kind, created on first use ──
    /** @type {Map<PersistKind, StorageFacade>} */
    const facades = new Map();
    disposers.push(() => {
      for (const facade of facades.values()) safe(() => facade.destroy());
      facades.clear();
    });

    /**
     * Driver for a persistence kind: `config.storage` decides. `'local'` keeps local / session apart,
     * `'session'` and `'memory'` pull everything into that driver, a custom adapter serves both
     * browser kinds; `'memory'` is always memory.
     * @param {PersistKind} kind
     * @returns {import('../storage/adapters.js').StorageOptions['driver']}
     */
    function driverFor(kind) {
      if (kind === 'memory') return 'memory';
      const s = cfg.storage;
      if (s === 'memory' || s === 'session') return s;
      if (s === 'local' || s === undefined) return kind;
      return /** @type {import('../types.js').StorageAdapter} */ (s);
    }

    /**
     * @param {PersistKind} kind
     * @returns {StorageFacade}
     */
    function storageFor(kind) {
      const k = kind === 'session' || kind === 'memory' ? kind : 'local';
      const hit = facades.get(k);
      if (hit) return hit;
      const facade = createStorage({
        driver: driverFor(k),
        namespace: cfg.storageNamespace,
        events,
        now,
        onUnavailable: (error, info) =>
          log.warn(`storage '${info.driver}' unavailable, using memory`, { error }),
      });
      facades.set(k, facade);
      return facade;
    }

    const storage = storageFor('local');

    // ── store + core slices ──
    const store = createStore({
      storage: storageFor,
      events,
      logger: logger.child('store'),
      devtools: cfg.devtools === true,
      timers,
      now,
    });
    disposers.push(() => store.destroy());
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: { storage: 'local' } });
    store.registerSlice('bootstrap', {
      initial: BOOTSTRAP_INITIAL,
      persist: { storage: 'local', ttlMs: BOOTSTRAP_TTL_MS },
    });

    /** @returns {Readonly<Prefs>} */
    const prefs = () => /** @type {Readonly<Prefs>} */ (store.get('prefs'));

    /**
     * Rewrite the `prefs` and `bootstrap` slices when what was hydrated or restored into them does
     * not have the documented shape (storage and snapshots are not trusted). No‑op when clean.
     * @param {string} action
     */
    function sanitiseCoreSlices(action) {
      const p = prefs();
      const cleanPrefs = sanitisePrefs(p);
      if (!deepEqual(p, cleanPrefs)) store.set('prefs', () => cleanPrefs, { action });
      const b = store.get('bootstrap');
      const cleanBootstrap = isPlainObject(b)
        ? {
            ...shapeBootstrap(/** @type {Record<string, unknown>} */ (b)),
            loaded: b.loaded === true,
          }
        : { ...BOOTSTRAP_INITIAL };
      if (!deepEqual(b, cleanBootstrap)) store.set('bootstrap', () => cleanBootstrap, { action });
    }

    sanitiseCoreSlices('client/sanitise');

    // Explicit config values are authoritative; the persisted copy fills the gaps.
    /** @type {Partial<Prefs>} */
    const configPrefs = {};
    if (str(cfg.locale)) configPrefs.locale = /** @type {string} */ (str(cfg.locale));
    if (str(cfg.currency)) configPrefs.currency = /** @type {string} */ (str(cfg.currency));
    if (str(cfg.market)) configPrefs.market = /** @type {string} */ (str(cfg.market));
    if (Object.keys(configPrefs).length > 0) {
      store.set('prefs', (s) => ({ ...s, ...configPrefs }), { action: 'prefs/config' });
    }

    // ── i18n ──
    /** @type {import('../utils/i18n.js').I18nOptions} */
    const i18nOptions = {};
    const initialLocale = prefs().locale || cfg.i18n.fallback;
    if (initialLocale) i18nOptions.locale = initialLocale;
    if (cfg.i18n.fallback) i18nOptions.fallback = cfg.i18n.fallback;
    if (isPlainObject(cfg.i18n.messages)) {
      i18nOptions.messages = /** @type {any} */ (cfg.i18n.messages);
    }
    let i18n;
    try {
      i18n = createI18n(i18nOptions);
    } catch (e) {
      // A corrupt persisted locale must not take the client down: fall back to the defaults.
      log.warn('invalid persisted locale ignored', { error: e, locale: initialLocale });
      delete i18nOptions.locale;
      i18n = createI18n(i18nOptions);
    }
    disposers.push(() => i18n.destroy());
    if (prefs().locale && prefs().locale !== i18n.getLocale()) {
      store.set('prefs', { locale: i18n.getLocale() }, { action: 'prefs/canonical' });
    }

    // ── telemetry ──
    const telemetry = createTelemetry({
      adapters: [...cfg.telemetry.adapters],
      enabled: cfg.telemetry.enabled,
      sampleRate: cfg.telemetry.sampleRate,
      context: { sdk: 'wayfarer', sdkVersion: VERSION },
      events,
      logger: logger.child('telemetry'),
    });
    disposers.push(() => telemetry.flush());
    disposers.push(bindDomainEvents(telemetry, events));

    // ── features (persisted flags under the host's) ──
    /** `features.load()` runs the bootstrap; bound once `bootstrap()` exists below. @type {() => Promise<BootstrapConfig>} */
    let runBootstrap = () =>
      Promise.reject(new ConfigError('features.load: the client is not composed yet'));
    const features = createFeatures({
      initial: { ...cleanFlags(store.get('bootstrap.flags')), ...cfg.features },
      source: () => runBootstrap(),
      events,
      store,
    });
    disposers.push(() => features.destroy());

    // ── endpoints ──
    const endpoints = createEndpoints(cfg.endpoints);
    if (!endpoints.has(BOOTSTRAP_KEY)) {
      endpoints.set(BOOTSTRAP_KEY, { method: 'GET', path: BOOTSTRAP_PATH });
    }

    // ── http ──
    /** @type {Record<string, string>} */
    const defaultHeaders = {};
    if (str(cfg.clientId)) {
      defaultHeaders['X-Client-Id'] = /** @type {string} */ (str(cfg.clientId));
    }
    const http = createHttp({
      baseUrl: cfg.baseUrl,
      fetch: cfg.fetch,
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
      headers: defaultHeaders,
      events,
      logger: logger.child('http'),
      storage,
      now,
      timers,
    });
    httpRef = http;
    disposers.push(() => http.destroy());

    // ── host interceptors and hooks ──
    for (const stage of /** @type {const} */ (['request', 'response', 'error'])) {
      const list = cfg.interceptors && cfg.interceptors[stage];
      if (!Array.isArray(list)) continue;
      for (const fn of list) {
        offs.push(http.interceptors[stage].use(/** @type {any} */ (fn), { name: 'config' }));
      }
    }
    for (const [name, fn] of Object.entries(cfg.hooks || {})) {
      if (!isFn(fn)) continue;
      if (HTTP_HOOKS.has(name)) {
        offs.push(http.hooks.on(/** @type {any} */ (name), fn));
      } else if (name === 'onAuthExpired') {
        offs.push(events.on('auth:expired', (payload) => fn(payload)));
      } else if (name === 'onTokenRefreshed') {
        offs.push(events.on('auth:refreshed', (payload) => fn(payload)));
      } else if (name === 'onStateChange') {
        offs.push(store.subscribe((state, prev, change) => fn(change, state, prev)));
      }
    }

    // ── auth + access ──
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
    disposers.push(() => auth.destroy());
    const access = createAccess({ policy: cfg.access, auth, events });

    // ── default interceptor set ──
    offs.push(
      installDefaultInterceptors(http, {
        auth,
        store,
        storage,
        apiKey: cfg.apiKey,
        logger: logger.child('http'),
        telemetry,
        getDeviceId: () => uuid(),
      })
    );

    // ── payments port ──
    /** @type {PaymentsPort} */
    let payments;
    if (cfg.payments) {
      const port = /** @type {PaymentsPort & { attach?: Function }} */ (cfg.payments);
      if (isFn(port.attach)) {
        const attached = port.attach(
          /** @type {PaymentsAttachment} */ ({
            http,
            store,
            events,
            config: cfg,
            endpoints,
            auth,
            access,
            storage,
            logger: logger.child('payments'),
            i18n,
            telemetry,
            features,
          })
        );
        payments = isObjectLike(attached) ? attached : port;
      } else {
        payments = port;
      }
    } else {
      payments = createNullPaymentsPort();
    }

    // ── preferences ──

    /** `true` while `applyPrefs` pushes a locale into i18n, so its change notification is not echoed back. */
    let syncingLocale = false;

    /**
     * Canonical locale through i18n (`en-in` → `en-IN`); falls back to the raw tag when i18n rejects it.
     * @param {string} locale
     * @returns {string}
     */
    function syncLocale(locale) {
      syncingLocale = true;
      try {
        i18n.setLocale(locale);
        return i18n.getLocale();
      } catch (e) {
        log.warn('locale not applied to i18n', { error: e, locale });
        return locale;
      } finally {
        syncingLocale = false;
      }
    }

    /**
     * Merge `partial` into the `prefs` slice, keep i18n in step and emit `prefs:change` when
     * anything differs. With `onlyGaps`, keys already decided are left alone.
     * Effects: state `prefs` · storage `prefs` · emit `prefs:change`.
     * @param {Partial<Prefs>} partial
     * @param {string} action
     * @param {boolean} [onlyGaps=false]
     */
    function applyPrefs(partial, action, onlyGaps = false) {
      const previous = prefs();
      /** @type {Record<string, unknown>} */
      const next = { ...previous };
      /** @type {string[]} */
      const changed = [];
      for (const key of Object.keys(partial)) {
        let value = /** @type {Record<string, unknown>} */ (partial)[key];
        if (value === undefined) continue;
        const current = /** @type {Record<string, unknown>} */ (previous)[key];
        if (onlyGaps && current !== null && current !== undefined) continue;
        if (key === 'locale' && typeof value === 'string') value = syncLocale(value);
        if (Object.is(current, value)) continue;
        next[key] = value;
        changed.push(key);
      }
      if (changed.length === 0) return;
      store.set('prefs', next, { action });
      events.emit('prefs:change', {
        prefs: /** @type {Readonly<Prefs>} */ (store.get('prefs')),
        previous,
        changed,
      });
    }

    // Direct `client.i18n.setLocale()` calls flow back into prefs (docs/api/03-utils.md §9).
    offs.push(
      i18n.onChange((change) => {
        if (syncingLocale || change.type !== 'locale') return;
        if (change.locale === prefs().locale) return;
        applyPrefs({ locale: change.locale }, 'i18n/setLocale');
      })
    );

    /** @type {OtaClient['setLocale']} */
    function setLocale(locale) {
      if (!str(locale)) throw invalid('locale', 'required', 'locale must be a non-empty string');
      applyPrefs({ locale: /** @type {string} */ (str(locale)) }, 'prefs/setLocale');
    }

    /** @type {OtaClient['setCurrency']} */
    function setCurrency(code) {
      const c = str(code);
      if (!c || !CURRENCY_RE.test(c)) {
        throw invalid(
          'currency',
          'format',
          "currency must be a 3-letter ISO-4217 code such as 'INR'"
        );
      }
      applyPrefs({ currency: c.toUpperCase() }, 'prefs/setCurrency');
    }

    /** @type {OtaClient['setMarket']} */
    function setMarket(market) {
      const m = str(market);
      if (!m) throw invalid('market', 'required', 'market must be a non-empty string');
      applyPrefs({ market: m }, 'prefs/setMarket');
    }

    // ── bootstrap ──

    /**
     * Fetch the runtime config (markets, currencies, limits, flags, payment method catalogue, min
     * app version) and apply it: `bootstrap` slice, `prefs` gaps, feature flags. Nothing is applied
     * when the client was destroyed while the request was in flight.
     * Effects: net `GET /v1/config` · state `bootstrap`, `prefs` (fills gaps) · emit
     * `bootstrap:loaded`, `features:change` · storage `bootstrap` (ttl).
     * @param {RequestOpts} [opts]
     * @returns {Promise<BootstrapConfig>}
     * @throws {AbortError} when the client is destroyed · {ValidationError} when the document is not an object
     */
    async function bootstrap(opts = {}) {
      if (destroyed) {
        throw new AbortError('Client destroyed', { reason: 'destroyed' });
      }
      const requestOpts = isPlainObject(opts) ? opts : {};
      const response = await http.get(endpoints.get(BOOTSTRAP_KEY), {
        tag: 'bootstrap',
        ...requestOpts,
      });
      const doc = normaliseBootstrap(response.data);
      if (destroyed) return doc;
      const { defaults, ...rest } = doc;
      store.set('bootstrap', (s) => ({ ...s, ...rest, loaded: true }), {
        action: 'bootstrap/loaded',
      });
      if (defaults) applyPrefs(defaults, 'bootstrap/prefs', true);
      features.set(doc.flags);
      events.emit('bootstrap:loaded', { config: doc });
      return doc;
    }

    runBootstrap = bootstrap;

    // ── snapshot / restore ──

    /** @type {OtaClient['snapshot']} */
    function snapshot() {
      return { version: SNAPSHOT_VERSION, at: now(), store: store.snapshot() };
    }

    /**
     * Apply a snapshot (`client.snapshot()` output or a bare store snapshot): the store is restored,
     * the `prefs` / `bootstrap` slices are coerced to their documented shape, i18n follows the
     * restored locale (the fallback when none) and the feature flags are reloaded from the slice.
     * Effects: state all (restore) · emit `state:change`, `prefs:change`, `features:change`.
     * @type {OtaClient['restore']}
     */
    function restore(snap) {
      if (!isPlainObject(snap)) {
        throw invalid('snapshot', 'invalid_type', 'snapshot must be an object');
      }
      const s = /** @type {Record<string, any>} */ (snap);
      const storeSnap = isPlainObject(s.store) && isPlainObject(s.store.slices) ? s.store : s;
      if (!isPlainObject(storeSnap.slices)) {
        throw invalid('snapshot', 'invalid_type', 'snapshot must carry a store snapshot (slices)');
      }
      const previous = prefs();
      store.restore(storeSnap);
      sanitiseCoreSlices('client/restore');
      const current = prefs();
      const changed = PREFS_KEYS.filter(
        (k) =>
          !Object.is(
            /** @type {Record<string, unknown>} */ (current)[k],
            /** @type {Record<string, unknown>} */ (previous)[k]
          )
      );
      if (changed.includes('locale')) {
        const target = current.locale || cfg.i18n.fallback;
        if (target) {
          const canonical = syncLocale(target);
          if (current.locale && canonical !== current.locale) {
            store.set('prefs', { locale: canonical }, { action: 'prefs/canonical' });
          }
        }
      }
      if (changed.length > 0) {
        events.emit('prefs:change', { prefs: prefs(), previous, changed });
      }
      features.set(cleanFlags(store.get('bootstrap.flags')));
    }

    // ── plugins ──

    /** @type {OtaClient['use']} */
    function use(plugin) {
      if (destroyed) {
        throw new ConfigError('client.use: the client has been destroyed', {
          details: { path: 'plugin' },
        });
      }
      if (!isObjectLike(plugin) || !str(plugin.name) || !isFn(plugin.install)) {
        throw new ConfigError('client.use: plugin must be { name, install(client) }', {
          details: { path: 'plugin' },
        });
      }
      const name = /** @type {string} */ (str(plugin.name));
      if (plugins.has(name)) {
        throw new ConfigError(`client.use: plugin '${name}' is already installed`, {
          details: { path: 'plugin.name', name },
        });
      }
      const uninstall = plugin.install(client);
      plugins.set(name, isFn(uninstall) ? /** @type {() => void} */ (uninstall) : null);
      return client;
    }

    // ── destroy ──

    /** @type {OtaClient['destroy']} */
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      teardown();
      events.emit('client:destroyed', { version: VERSION });
      events.clear();
    }

    // ── ready: a promise plugins can already hold at install time ──

    /** @type {(client: OtaClient) => void} */
    let resolveReady = () => {};
    /** @type {Promise<OtaClient>} */
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });

    // ── the client ──

    /** @type {OtaClient} */
    const client = {
      version: VERSION,
      http,
      auth,
      access,
      store,
      events,
      storage,
      i18n,
      telemetry,
      features,
      logger,
      endpoints,
      payments,
      utils,
      ready,
      bootstrap,
      use,
      setLocale,
      setCurrency,
      setMarket,
      getPrefs: () => prefs(),
      getConfig: () => cfg,
      on: (event, fn) => events.on(event, fn),
      once: (event, fn) => events.once(event, fn),
      off: (event, fn) => events.off(event, fn),
      snapshot,
      restore,
      destroy,
      isDestroyed: () => destroyed,
    };

    // ── domain modules ──
    /** @type {Record<string, ModuleFactory>} */
    const factories = { ...MODULE_FACTORIES, ...(moduleOverrides || {}) };
    /** @type {Omit<import('./context.js').ContextParts, 'scope'>} */
    const contextBase = {
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
    };
    for (const [name, factory] of Object.entries(factories)) {
      if (factory === undefined || factory === null) continue;
      if (RESERVED_NAMES.has(name)) {
        throw new ConfigError(`module name '${name}' is reserved by the client`, {
          details: { path: `modules.${name}` },
        });
      }
      if (!isFn(factory)) {
        throw new ConfigError(`modules.${name} must be a factory function (ctx) => api`, {
          details: { path: `modules.${name}`, received: typeof factory },
        });
      }
      const ctx = createContext({ ...contextBase, scope: name });
      const api = factory(ctx);
      if (!isObjectLike(api)) {
        throw new ConfigError(`module '${name}' factory must return its API object`, {
          details: { path: `modules.${name}`, received: api === null ? 'null' : typeof api },
        });
      }
      registry.set(name, api);
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (client))[name] = api;
    }

    // ── plugins from config ──
    for (const plugin of cfg.plugins || []) use(plugin);

    // ── bootstrap + ready ──
    const warmup = cfg.autoBootstrap
      ? bootstrap().then(
          () => undefined,
          (e) => {
            if (destroyed) return;
            const error = isSdkError(e) ? e : wrap(e);
            log.warn('bootstrap failed; continuing with defaults', { error });
          }
        )
      : Promise.resolve();
    warmup.then(() => {
      if (!destroyed) {
        safe(
          () =>
            events.emit('client:ready', {
              version: VERSION,
              bootstrapped: store.get('bootstrap.loaded') === true,
            }),
          (e) => log.warn('client:ready could not be emitted', { error: e })
        );
      }
      resolveReady(client);
    });

    return client;
  } catch (e) {
    destroyed = true;
    teardown();
    if (eventsRef) {
      const events = eventsRef;
      safe(() => events.clear());
    }
    throw isSdkError(e)
      ? e
      : wrap(e, { code: 'CLIENT_INIT_FAILED', message: 'createClient failed' });
  }
}
