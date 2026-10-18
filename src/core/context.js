/**
 * `ModuleContext` of the Wayfarer SDK (docs/CONTRIBUTING.md §2): the typedef every domain factory
 * receives (`createSearchModule(ctx)`, …) and `createContext(parts)`, the builder `core/client.js`
 * uses to assemble it from the already‑created siblings — frozen `config`, `endpoints`, `http`,
 * `store`, `events`, `storage`, `auth`, `access`, `i18n`, `telemetry`, a `logger` scoped to the
 * module, `features`, the `payments` port, an injectable `now()` clock and `timers`. `modules` is a
 * lazy accessor whose property reads resolve from the registry map at call time, so a module can
 * call a sibling (`ctx.modules.offers.get(id)`) without import order mattering, as long as it does
 * so inside its functions and never in the factory body. This script creates nothing itself: no
 * network, no storage, no timers, no DOM, no module‑level mutable state, no logging, and it never
 * throws a plain `Error` (`ConfigError` for a malformed `parts`).
 */

import { ConfigError } from '../errors/index.js';
import { isPlainObject } from '../utils/object.js';

/** @typedef {import('../types.js').ClientConfig} ClientConfig */
/** @typedef {import('../types.js').PaymentsPort} PaymentsPort */

/**
 * Injectable timers handed to every module (fake‑timer friendly: the defaults look the globals up
 * at call time, never at import time).
 * @typedef {Object} ModuleTimers
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 * @property {(fn: () => void, ms: number) => unknown} setInterval
 * @property {(handle: unknown) => void} clearInterval
 */

/**
 * Registry the `modules` accessor reads from: module name → module API. A `Map` or a plain object.
 * @typedef {Map<string, unknown> | Record<string, unknown>} ModuleRegistry
 */

/**
 * Lazy view over the sibling module APIs: `ctx.modules.search` resolves the `'search'` entry of the
 * registry at the time of the read (`undefined` while it is not registered yet).
 * @typedef {Readonly<Record<string, any>>} ModulesAccessor
 */

/**
 * What every domain factory receives (docs/CONTRIBUTING.md §2). Built by `core/client.js`.
 * @typedef {Object} ModuleContext
 * @property {Readonly<ClientConfig>} config  Frozen client configuration (`defineConfig` output).
 * @property {import('./endpoints.js').Endpoints} endpoints  Endpoint key → path table (`createEndpoints()`).
 * @property {import('../http/client.js').Http} http  HTTP client (`createHttp()`); the only way to the network.
 * @property {import('../state/store.js').Store} store  Slice store (`createStore()`).
 * @property {import('../events/emitter.js').Emitter} events  Event bus (`createEmitter()`).
 * @property {import('../storage/adapters.js').StorageFacade} storage  Namespaced key/value facade (`createStorage()`).
 * @property {import('../auth/session.js').Auth} auth  Session manager (`createAuth()`).
 * @property {import('../auth/access.js').Access} access  Access gating (`createAccess()`); factories return `access.wrap(name, api)`.
 * @property {import('../utils/i18n.js').I18n} i18n  Translations (`createI18n()`).
 * @property {import('../utils/telemetry.js').Telemetry} telemetry  Telemetry hub (`createTelemetry()`).
 * @property {import('../utils/logger.js').Logger} logger  Logger scoped to the module (`createLogger().child(name)`).
 * @property {import('../utils/features.js').Features} features  Feature flags (`createFeatures()`).
 * @property {PaymentsPort} payments  The injected `PaymentsPort`, or the null port when none is configured.
 * @property {ModulesAccessor} modules  Lazy accessor to sibling module APIs (one getter per module name).
 * @property {() => number} now  Injectable clock in epoch milliseconds.
 * @property {ModuleTimers} timers  Injectable timers.
 */

/**
 * Input of `createContext`: every `ModuleContext` member (all optional, the client passes the full
 * set) plus the registry the `modules` accessor reads and an optional logger `scope`.
 * @typedef {Partial<Omit<ModuleContext, 'modules'>> & {
 *   registry?: ModuleRegistry,
 *   modules?: ModulesAccessor,
 *   scope?: string
 * }} ContextParts
 */

/** Members of `ModuleContext` copied from `parts` as they are. */
const MEMBERS = Object.freeze([
  'config',
  'endpoints',
  'http',
  'store',
  'events',
  'storage',
  'auth',
  'access',
  'i18n',
  'telemetry',
  'logger',
  'features',
  'payments',
]);

/** Keys never resolved through a registry (prototype‑pollution vectors). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Default timers: the globals, looked up at call time (SSR‑safe and fake‑timer friendly).
 * @returns {ModuleTimers}
 */
function defaultTimers() {
  return Object.freeze({
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(/** @type {any} */ (handle)),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(/** @type {any} */ (handle)),
  });
}

/**
 * @param {unknown} value
 * @returns {value is Map<string, unknown>}
 */
function isMap(value) {
  return value instanceof Map;
}

/**
 * Read one registry entry (`undefined` when absent or unsafe).
 * @param {ModuleRegistry} registry
 * @param {string} name
 * @returns {unknown}
 */
function lookup(registry, name) {
  if (UNSAFE_KEYS.has(name)) return undefined;
  if (isMap(registry)) return registry.get(name);
  return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
}

/**
 * Names currently registered.
 * @param {ModuleRegistry} registry
 * @returns {string[]}
 */
function names(registry) {
  if (isMap(registry)) return Array.from(registry.keys()).filter((k) => typeof k === 'string');
  return Object.keys(registry);
}

/**
 * Build the lazy `modules` accessor over `registry`: every property read resolves at call time, so
 * modules registered after the context was built are visible, and `Object.keys` / `in` reflect the
 * registry's current content. Writes are rejected (the registry belongs to the client).
 * @param {ModuleRegistry} registry
 * @returns {ModulesAccessor}
 */
function createModulesAccessor(registry) {
  return new Proxy(Object.create(null), {
    get(_target, key) {
      return typeof key === 'string' ? lookup(registry, key) : undefined;
    },
    has(_target, key) {
      return typeof key === 'string' && lookup(registry, key) !== undefined;
    },
    ownKeys() {
      return names(registry);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string') return undefined;
      const value = lookup(registry, key);
      if (value === undefined) return undefined;
      return { value, enumerable: true, configurable: true, writable: false };
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });
}

/**
 * Assemble a `ModuleContext` from already‑created siblings. `parts.logger` is scoped with
 * `logger.child(parts.scope)` when a `scope` is given and the logger supports it; `now` defaults to
 * `Date.now`; `timers` default to the globals (looked up at call time); `modules` is the lazy
 * accessor over `parts.registry` (a `Map` or plain object, read at call time) unless an accessor is
 * passed as `parts.modules`. Members the caller omits stay `undefined` (the client always passes the
 * full set; module tests may pass a subset). The result is frozen (shallowly).
 * Effects: none.
 * @param {ContextParts} parts
 * @returns {ModuleContext}
 * @throws {ConfigError} when `parts` is not a plain object or `registry` / `now` / `timers` / `scope` have the wrong shape
 */
export function createContext(parts) {
  if (!isPlainObject(parts)) {
    throw new ConfigError('createContext: parts must be a plain object', {
      details: { path: 'parts', received: parts === null ? 'null' : typeof parts },
    });
  }
  const p = /** @type {ContextParts} */ (parts);
  if (p.registry !== undefined && p.registry !== null && !isMap(p.registry)) {
    if (!isPlainObject(p.registry)) {
      throw new ConfigError('createContext: registry must be a Map or a plain object', {
        details: { path: 'registry' },
      });
    }
  }
  if (p.now !== undefined && typeof p.now !== 'function') {
    throw new ConfigError('createContext: now must be a function returning milliseconds', {
      details: { path: 'now' },
    });
  }
  if (
    p.timers !== undefined &&
    (p.timers === null ||
      typeof p.timers !== 'object' ||
      typeof p.timers.setTimeout !== 'function' ||
      typeof p.timers.clearTimeout !== 'function')
  ) {
    throw new ConfigError('createContext: timers must expose setTimeout and clearTimeout', {
      details: { path: 'timers' },
    });
  }
  if (p.scope !== undefined && typeof p.scope !== 'string') {
    throw new ConfigError('createContext: scope must be a string', { details: { path: 'scope' } });
  }

  /** @type {Record<string, unknown>} */
  const ctx = {};
  for (const key of MEMBERS) ctx[key] = p[key];

  if (p.scope && p.logger && typeof p.logger.child === 'function') {
    ctx.logger = p.logger.child(p.scope);
  }

  const base = p.timers || defaultTimers();
  ctx.timers = Object.freeze({
    setTimeout: base.setTimeout,
    clearTimeout: base.clearTimeout,
    setInterval:
      typeof base.setInterval === 'function'
        ? base.setInterval
        : (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval:
      typeof base.clearInterval === 'function'
        ? base.clearInterval
        : (handle) => globalThis.clearInterval(/** @type {any} */ (handle)),
  });
  ctx.now = p.now || (() => Date.now());
  ctx.modules =
    p.modules !== undefined && p.modules !== null
      ? p.modules
      : createModulesAccessor(p.registry || new Map());

  return Object.freeze(/** @type {ModuleContext} */ (/** @type {unknown} */ (ctx)));
}
