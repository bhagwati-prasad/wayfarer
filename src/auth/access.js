/**
 * Access policy resolver + guard (docs/api/01-core.md §1.1, docs/CONTRIBUTING.md §2, README §1
 * "Access gating"). Resolves every public function key (`'booking.create'`, `'trips.changes.quote'`,
 * …) against an `AccessPolicy` to `'open' | 'guest' | 'auth'` — exact key, then the nearest group
 * wildcard (`module.group.*`), then `module.*`, then `default` — and wraps module functions so that
 * `'guest'` silently ensures a guest session and `'auth'` rejects with
 * `AuthError{reason:'unauthenticated', key}` (emitting `auth:required`) **before** any network call.
 * The level is resolved at call time, so `setPolicy` takes effect for functions wrapped earlier.
 * `<module>.destroy` is never gated, so `client.destroy()` can always run. `wrap` walks nested plain
 * objects and function‑valued groups, gives every key its own wrapper, is cycle‑safe and never
 * writes through `__proto__`. Pure and SSR‑safe: no I/O, no DOM, no timers, no module‑level mutable
 * state. It never talks to the backend, never performs the guest login itself (that is
 * `auth.ensureGuestSession`, which is single‑flight) and never throws a plain `Error`
 * (`ValidationError` for bad arguments, `ConfigError` for a bad policy).
 */

import { AuthError, ConfigError, ValidationError } from '../errors/index.js';
import { deepFreeze, isPlainObject } from '../utils/object.js';

/** @typedef {import('../types.js').AccessLevel} AccessLevel */
/** @typedef {import('../types.js').AccessPolicy} AccessPolicy */

/**
 * The slice of `Auth` (docs/api/01-core.md §5) the guard relies on. Every member is optional so the
 * resolver can be created before auth exists (e.g. in tests): a missing `isAuthenticated` reads as
 * anonymous and a missing `ensureGuestSession` makes `'guest'` call through.
 * @typedef {Object} AccessAuth
 * @property {() => boolean} [isAuthenticated]
 * @property {() => boolean} [isGuest]
 * @property {(opts?: unknown) => (Promise<unknown>|unknown)} [ensureGuestSession]
 */

/**
 * The slice of the event emitter the resolver uses (`emit` only).
 * @typedef {Object} AccessEvents
 * @property {(event: string, payload?: unknown) => void} emit
 */

/**
 * @typedef {Object} AccessOptions
 * @property {AccessPolicy|null} [policy]  Policy to start from; `undefined`/`null` means
 *   `DEFAULT_ACCESS_POLICY`. Throws `ConfigError` when invalid.
 * @property {AccessAuth|null} [auth]  Auth session (read at call time).
 * @property {AccessEvents|null} [events]  Emitter for `auth:required` / `access:change`.
 */

/**
 * @typedef {Object} Access
 * @property {(key: string) => AccessLevel} levelOf  Resolve a concrete function key to its level.
 *   `<module>.destroy` is always `'open'`. Throws `ValidationError` for a malformed key (a wildcard
 *   is not a function key).
 * @property {<F extends (...args: any[]) => any>(key: string, fn: F) => F} guard  Wrap one function.
 *   `'open'` (and an authenticated or guest caller) calls through synchronously; `'guest'` without a
 *   session returns `ensureGuestSession().then(fn)`; `'auth'` while anonymous returns a rejected
 *   promise. Throws `ValidationError` for a bad key or non‑function.
 * @property {<T extends Record<string, any>>(moduleName: string, api: T) => T} wrap  Wrap a module
 *   API: the same shape with every function guarded under `moduleName.fnName` (nested plain
 *   objects → `moduleName.group.fnName`; a function's own enumerable properties are walked too).
 *   Non‑plain values (arrays, class instances, primitives) are kept by reference; the top‑level
 *   `destroy` is passed through untouched. Cyclic references resolve to the wrapper already being
 *   built. Throws `ValidationError` for a bad module name or a non‑plain‑object `api`.
 * @property {(key: string) => boolean} can  Whether calling `key` now would pass the access check
 *   (`'open'` / `'guest'` → `true`, `'auth'` → `auth.isAuthenticated()`).
 * @property {(policy?: AccessPolicy|null) => void} setPolicy  Replace the policy (validated,
 *   copied, frozen) and emit `access:change` `{ policy, previous }`. Throws `ConfigError` and keeps
 *   the current policy when the new one is invalid.
 * @property {() => Readonly<Required<AccessPolicy>>} policy  The current (frozen) policy.
 */

/** @type {ReadonlySet<string>} */
const LEVELS = new Set(['open', 'guest', 'auth']);

/** A concrete function key: `module`, `module.fn`, `module.group.fn`, … (no wildcard). */
const KEY_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** A rule key: a function key, or a wildcard `module.*` / `module.group.*`. */
const RULE_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\.\*)?$/;

/** Segments that would collide with `Object.prototype` when used as plain‑object keys. */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** Top‑level module functions that are never gated: `client.destroy()` must always be able to run. */
const LIFECYCLE = new Set(['destroy']);

/**
 * Default policy from docs/api/01-core.md §1.1. Agencies override any key through `config.access`.
 * Everything not listed (pure helpers, reference data, search, content, …) is `'open'`.
 * @type {Readonly<Required<AccessPolicy>>}
 */
export const DEFAULT_ACCESS_POLICY = deepFreeze({
  default: 'open',
  rules: {
    'itinerary.*': 'guest',
    'ancillaries.*': 'guest',
    'booking.*': 'guest',
    'payments.*': 'guest',
    'alerts.createGuest': 'guest',
    'booking.retrieve': 'guest',
    'trips.byReference': 'guest',
    'travelers.*': 'auth',
    'trips.*': 'auth',
    'account.*': 'auth',
    'wallet.*': 'auth',
    'alerts.*': 'auth',
    'support.tickets.*': 'auth',
    'payments.savedMethods.*': 'auth',
  },
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} path
 * @param {string} code
 * @param {string} message
 * @returns {ValidationError}
 */
function invalid(path, code, message) {
  return new ValidationError(message, { issues: [{ path, code, message }] });
}

/**
 * @param {unknown} value
 * @returns {value is AccessLevel}
 */
function isLevel(value) {
  return typeof value === 'string' && LEVELS.has(value);
}

/**
 * @param {string} key
 * @returns {boolean} whether any dotted segment is a prototype‑pollution vector
 */
function hasReservedSegment(key) {
  return key.split('.').some((segment) => RESERVED.has(segment));
}

/**
 * @param {unknown} value
 * @returns {value is string} a concrete function key
 */
function isKey(value) {
  return typeof value === 'string' && KEY_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is string} a policy rule key (function key or `….*` wildcard), never reserved
 */
function isRuleKey(value) {
  return typeof value === 'string' && RULE_RE.test(value) && !hasReservedSegment(value);
}

/**
 * @param {unknown} key
 * @param {string} path
 * @returns {string}
 */
function assertKey(key, path) {
  if (!isKey(key)) {
    throw invalid(path, 'format', `${path} must be a dotted function key such as 'booking.create'`);
  }
  return key;
}

/**
 * @param {Record<string, unknown>} o
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * Define `key` on `target` as a plain own data property, even for `"__proto__"` (a plain assignment
 * would change the prototype instead).
 * @param {object} target
 * @param {string} key
 * @param {unknown} value
 */
function setOwn(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    /** @type {Record<string, unknown>} */ (target)[key] = value;
  }
}

/**
 * Whether `key` names a top‑level lifecycle function (`<module>.destroy`) that is never gated.
 * @param {string} key
 * @returns {boolean}
 */
function isLifecycle(key) {
  const parts = key.split('.');
  return parts.length === 2 && LIFECYCLE.has(parts[1]);
}

/**
 * Validate and freeze a policy. `undefined`/`null` means the default policy; a partial policy gets
 * `default: 'open'` and/or empty `rules`. The caller's object is copied, never kept or frozen.
 * @param {unknown} policy
 * @returns {Readonly<Required<AccessPolicy>>}
 */
function normalizePolicy(policy) {
  if (policy === undefined || policy === null) {
    return DEFAULT_ACCESS_POLICY;
  }
  if (!isPlainObject(policy)) {
    throw new ConfigError('access policy must be an object { default?, rules? }', {
      details: { path: 'access' },
    });
  }
  /** @type {Required<AccessPolicy>} */
  const out = { default: 'open', rules: {} };
  if (policy.default !== undefined) {
    if (!isLevel(policy.default)) {
      throw new ConfigError(`access.default must be one of ${[...LEVELS].join(' | ')}`, {
        details: { path: 'access.default', value: policy.default },
      });
    }
    out.default = policy.default;
  }
  if (policy.rules !== undefined) {
    if (!isPlainObject(policy.rules)) {
      throw new ConfigError('access.rules must be an object of key → level', {
        details: { path: 'access.rules' },
      });
    }
    for (const key of Object.keys(policy.rules)) {
      const level = policy.rules[key];
      if (!isRuleKey(key)) {
        throw new ConfigError(
          `access.rules has an invalid key '${key}' (expected 'module.fn' or 'module.*')`,
          { details: { path: `access.rules.${key}` } }
        );
      }
      if (!isLevel(level)) {
        throw new ConfigError(`access.rules['${key}'] must be one of ${[...LEVELS].join(' | ')}`, {
          details: { path: `access.rules.${key}`, value: level },
        });
      }
      out.rules[key] = level;
    }
  }
  return deepFreeze(out);
}

/**
 * Lifecycle → exact key → `module.group.*` → `module.*` → default.
 * @param {Readonly<Required<AccessPolicy>>} policy
 * @param {string} key
 * @returns {AccessLevel}
 */
function resolveLevel(policy, key) {
  if (isLifecycle(key)) return 'open';
  const rules = policy.rules;
  if (hasOwn(rules, key)) return rules[key];
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const pattern = `${parts.slice(0, i).join('.')}.*`;
    if (hasOwn(rules, pattern)) return rules[pattern];
  }
  return policy.default;
}

// ── factory ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Create the access resolver + guard for one client. Effects: none.
 * @param {AccessOptions} [options]
 * @returns {Access}
 * @throws {ConfigError} when `options.policy` is invalid
 */
export function createAccess(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  /** @type {AccessAuth|null} */
  const auth = o.auth && typeof o.auth === 'object' ? o.auth : null;
  /** @type {AccessEvents|null} */
  const events = o.events && typeof o.events.emit === 'function' ? o.events : null;
  /** @type {Readonly<Required<AccessPolicy>>} */
  let current = normalizePolicy(o.policy);

  /** @param {string} event @param {unknown} payload */
  function emit(event, payload) {
    if (!events) return;
    try {
      events.emit(event, payload);
    } catch {
      // Access decisions must not depend on listeners; the emitter reports its own failures.
    }
  }

  /** @returns {boolean} */
  function isAuthenticated() {
    return Boolean(auth && typeof auth.isAuthenticated === 'function' && auth.isAuthenticated());
  }

  /** @returns {boolean} */
  function isGuest() {
    return Boolean(auth && typeof auth.isGuest === 'function' && auth.isGuest());
  }

  /** @returns {boolean} */
  function canEnsureGuest() {
    return Boolean(auth && typeof auth.ensureGuestSession === 'function');
  }

  /**
   * Call `auth.ensureGuestSession()` and always hand back a promise (a synchronous throw rejects).
   * @returns {Promise<unknown>}
   */
  function ensureGuest() {
    if (!auth || typeof auth.ensureGuestSession !== 'function') return Promise.resolve();
    try {
      return Promise.resolve(auth.ensureGuestSession());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** @type {Access['levelOf']} */
  function levelOf(key) {
    return resolveLevel(current, assertKey(key, 'key'));
  }

  /** @type {Access['can']} */
  function can(key) {
    const level = levelOf(key);
    if (level === 'auth') return isAuthenticated();
    return true;
  }

  /** @type {Access['guard']} */
  function guard(key, fn) {
    assertKey(key, 'key');
    if (typeof fn !== 'function') throw invalid('fn', 'type', 'fn must be a function');

    /**
     * @this {unknown}
     * @param {...any} args
     * @returns {any}
     */
    function guarded(...args) {
      const level = resolveLevel(current, key);
      if (level === 'open') return fn.apply(this, args);
      const authed = isAuthenticated();
      if (level === 'auth') {
        if (authed) return fn.apply(this, args);
        const error = new AuthError('Authentication required', {
          reason: 'unauthenticated',
          details: { key },
        });
        Object.assign(error, { key });
        emit('auth:required', { key });
        return Promise.reject(error);
      }
      // 'guest': call through when a session exists (or none can be created), else create one first
      if (authed || isGuest() || !canEnsureGuest()) return fn.apply(this, args);
      return ensureGuest().then(() => fn.apply(this, args));
    }

    try {
      Object.defineProperty(guarded, 'name', { value: fn.name || 'guarded', configurable: true });
    } catch {
      // Non‑configurable in exotic hosts; the name is cosmetic.
    }
    return /** @type {typeof fn} */ (/** @type {unknown} */ (guarded));
  }

  /**
   * Guard a function and carry over its own enumerable properties (`trips.disruptions` is both a
   * function and a group holding `respond`). `path` maps the values currently being wrapped to
   * their wrappers so a cyclic reference resolves instead of recursing forever.
   * @param {string} fullKey
   * @param {Function} fn
   * @param {Map<object, unknown>} path
   * @returns {Function}
   */
  function guardWithProps(fullKey, fn, path) {
    const seen = path.get(fn);
    if (seen !== undefined) return /** @type {Function} */ (seen);
    const guarded = guard(fullKey, fn);
    const props = Object.keys(fn);
    if (props.length === 0) return guarded;
    path.set(fn, guarded);
    for (const prop of props) {
      setOwn(
        guarded,
        prop,
        wrapValue(`${fullKey}.${prop}`, /** @type {Record<string, unknown>} */ (fn)[prop], path)
      );
    }
    path.delete(fn);
    return guarded;
  }

  /**
   * @param {string} fullKey
   * @param {unknown} value
   * @param {Map<object, unknown>} path
   * @returns {unknown}
   */
  function wrapValue(fullKey, value, path) {
    if (typeof value === 'function') return guardWithProps(fullKey, value, path);
    if (isPlainObject(value)) return wrapObject(fullKey, value, false, path);
    return value;
  }

  /**
   * @param {string} prefix
   * @param {Record<string, unknown>} obj
   * @param {boolean} top  Whether `obj` is the module API itself (its `destroy` is never gated).
   * @param {Map<object, unknown>} path
   * @returns {Record<string, unknown>}
   */
  function wrapObject(prefix, obj, top, path) {
    const seen = path.get(obj);
    if (seen !== undefined) return /** @type {Record<string, unknown>} */ (seen);
    /** @type {Record<string, unknown>} */
    const out = {};
    path.set(obj, out);
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (top && LIFECYCLE.has(key) && typeof value === 'function') {
        setOwn(out, key, value);
      } else {
        setOwn(out, key, wrapValue(`${prefix}.${key}`, value, path));
      }
    }
    path.delete(obj);
    return out;
  }

  /** @type {Access['wrap']} */
  function wrap(moduleName, api) {
    assertKey(moduleName, 'moduleName');
    if (!isPlainObject(api)) throw invalid('api', 'type', 'api must be a plain object');
    return /** @type {any} */ (wrapObject(moduleName, api, true, new Map()));
  }

  /** @type {Access['setPolicy']} */
  function setPolicy(policy) {
    const previous = current;
    current = normalizePolicy(policy);
    emit('access:change', { policy: current, previous });
  }

  /** @type {Access['policy']} */
  function policy() {
    return current;
  }

  return { levelOf, guard, wrap, can, setPolicy, policy };
}
