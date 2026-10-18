/**
 * Storage adapters (docs/api/02-state-events-errors.md §4): `createStorage` builds a namespaced,
 * TTL‑aware key/value facade over a driver (`memoryDriver`, `webStorageDriver` for localStorage /
 * sessionStorage, `cookieDriver`, or any custom `StorageAdapter` duck type) and falls back to memory
 * when the browser driver throws or fails its probe (private mode, quota, SSR), reporting it once
 * through `onUnavailable` and the `storage:unavailable` event. Values are stored as `{ v, e? }`
 * envelopes (`e` = expiry epoch ms); expired entries read as `undefined` and are deleted on read.
 * `subscribe` relays the window `storage` event (changes made by other tabs) for web storage drivers
 * only, and only while that driver is the active one — the memory driver cannot observe other tabs.
 * SSR‑safe: `window`, `document`, `localStorage` and `sessionStorage` are only looked up at call time
 * through `globalThis`, never at import time; no module‑level mutable state; no timers; no logging.
 * Errors are `ConfigError` / `ValidationError` / `StorageError` from `../errors/index.js` — driver
 * failures never escape to the caller, they trigger the memory fallback instead.
 */

import { ConfigError, StorageError, ValidationError, isSdkError, wrap } from '../errors/index.js';

/** @typedef {import('../types.js').StorageAdapter} StorageAdapter */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/**
 * Converts values to and from the raw strings a driver stores. Defaults to JSON.
 * @typedef {Object} StorageSerializer
 * @property {(value: unknown) => string} serialize   Must return a string.
 * @property {(raw: string) => unknown} deserialize   May throw on corrupt input (the entry is dropped).
 */

/**
 * Minimal event emitter the facade can report to (`client.events` or any `{ emit }` duck type).
 * @typedef {{ emit: (event: string, payload?: unknown) => void }} StorageEvents
 */

/**
 * Details passed to `onUnavailable` and carried on the `storage:unavailable` event.
 * @typedef {Object} StorageUnavailableInfo
 * @property {string} driver     Name of the driver that failed (`'local'`, `'session'`, `'cookie'`, …).
 * @property {'memory'} fallback The driver now in use.
 */

/**
 * @typedef {Object} StorageOptions
 * @property {'memory'|'local'|'session'|'cookie'|StorageAdapter|Storage} [driver='memory']
 *   Built‑in driver name, a custom adapter, or a DOM `Storage` area (wrapped with `webStorageDriver`).
 * @property {string} [namespace='wf']  Prefix for every key (`<namespace>:<key>`); `''` disables it.
 * @property {StorageSerializer} [serializer]  Defaults to JSON.
 * @property {number} [defaultTtlMs]  TTL applied when `set` is called without `ttlMs`; `0` = none.
 * @property {(error: StorageError, info: StorageUnavailableInfo) => void} [onUnavailable]
 *   Called once when the facade falls back to memory.
 * @property {StorageEvents} [events]  Receives `storage:unavailable` (and `error` for listener faults).
 * @property {() => number} [now]  Injectable clock in ms (defaults to `Date.now`).
 */

/**
 * Cross‑tab change listener registered with `storage.subscribe`.
 * @typedef {(value: unknown, previous: unknown, key: string) => void} StorageChangeListener
 */

/**
 * One `subscribe` registration. A distinct object per call, so the same function can subscribe
 * twice and each `off()` removes only its own registration.
 * @typedef {{ fn: StorageChangeListener }} Subscription
 */

/**
 * The facade returned by `createStorage`.
 * @typedef {Object} StorageFacade
 * @property {<T = unknown>(key: string) => T | undefined} get  Expired entries read as `undefined` and are deleted.
 * @property {(key: string, value: unknown, options?: { ttlMs?: number }) => void} set
 *   `undefined` removes the key; `ttlMs: 0` (or `null`) overrides `defaultTtlMs` with "no expiry".
 * @property {(key: string) => void} remove
 * @property {(key: string) => boolean} has  `false` for missing or expired entries (expired ones are deleted).
 * @property {(prefix?: string) => string[]} keys
 *   Un‑namespaced keys, optionally filtered by prefix. A raw listing (no reads, no writes): an entry
 *   that expired but has not been read since is still listed until `get` / `has` / `clear` drops it.
 * @property {(prefix?: string) => void} clear  Removes every namespaced key (optionally by prefix); never touches foreign keys.
 * @property {() => boolean} isAvailable  `true` while the configured driver is in use (no fallback happened).
 * @property {string} driverName  Name of the driver currently in use (`'memory'` after a fallback).
 * @property {(key: string, fn: StorageChangeListener) => () => void} subscribe
 *   Cross‑tab notifications through the window `storage` event, for web storage drivers (`'local'`,
 *   `'session'`, `webStorageDriver`). Same‑tab writes never fire (browser semantics). With no window,
 *   with any other driver, or after a fallback to memory the returned `off()` is a no‑op and `fn`
 *   never runs; a fallback also releases every existing subscription.
 * @property {() => void} destroy  Removes every subscription and the window listener (data is kept).
 */

/**
 * @typedef {Object} CookieDriverOptions
 * @property {string} [domain]   `Domain=` attribute.
 * @property {boolean} [secure]  `Secure` attribute (forced on for `sameSite: 'none'`).
 * @property {'lax'|'strict'|'none'|'Lax'|'Strict'|'None'} [sameSite]  `SameSite=` attribute.
 * @property {string} [path='/']  `Path=` attribute.
 * @property {number} [maxAgeSec]
 *   `Max-Age=` in seconds (positive; fractions round up so a cookie never dies early); omitted =
 *   session cookie.
 */

const DEFAULT_NAMESPACE = 'wf';
const SEPARATOR = ':';
const PROBE_KEY = '__wf_probe__';
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';

/** @type {StorageSerializer} */
const JSON_SERIALIZER = Object.freeze({
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => JSON.parse(raw),
});

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} path @param {string} code @param {string} message
 * @returns {ValidationIssue}
 */
function issue(path, code, message) {
  return { path, code, message };
}

/**
 * Validates a storage key.
 * @param {unknown} key
 * @returns {string}
 */
function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ValidationError('Storage key must be a non-empty string', {
      issues: [issue('key', 'invalid_type', 'key must be a non-empty string')],
    });
  }
  return key;
}

/**
 * True when `value` looks like a `StorageAdapter`.
 * @param {unknown} value
 * @returns {value is StorageAdapter}
 */
function isAdapter(value) {
  if (!value || typeof value !== 'object') return false;
  const a = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof a.getItem === 'function' &&
    typeof a.setItem === 'function' &&
    typeof a.removeItem === 'function'
  );
}

/**
 * True when an adapter‑shaped value is a DOM `Storage` area (`key(i)` + `length`), such as
 * `localStorage` handed over directly as `driver`.
 * @param {StorageAdapter} value
 * @returns {boolean}
 */
function isStorageArea(value) {
  const a = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (value));
  return typeof a.key === 'function' && typeof a.length === 'number';
}

/**
 * Reads a global without throwing (Safari throws `SecurityError` on `localStorage` access when
 * cookies are blocked).
 * @param {string} name
 * @returns {any}
 */
function safeGlobal(name) {
  try {
    return /** @type {any} */ (globalThis)[name];
  } catch {
    return undefined;
  }
}

/**
 * Normalises anything thrown by a driver into a `StorageError`.
 * @param {unknown} e @param {string} driver
 * @returns {StorageError}
 */
function toStorageError(e, driver) {
  if (e instanceof StorageError) return e;
  const base = isSdkError(e) ? e : wrap(e);
  return new StorageError(`Storage driver '${driver}' is unavailable: ${base.message}`, {
    cause: e,
    details: { driver, code: base.code },
  });
}

// ── drivers ─────────────────────────────────────────────────────────────────────────────────────

/**
 * In‑memory driver backed by a `Map`. Never throws; nothing survives a page reload.
 * @returns {StorageAdapter}
 */
export function memoryDriver() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    name: 'memory',
    getItem: (key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => Array.from(map.keys()),
  };
}

/**
 * Builds a web storage driver with an explicit name (used for `'local'` / `'session'`).
 * @param {Storage | undefined} area @param {string} name
 * @returns {StorageAdapter & { area?: Storage }}
 */
function webDriver(area, name) {
  const usable = !!area && typeof area.getItem === 'function' && typeof area.setItem === 'function';
  /** @returns {Storage} */
  const ensure = () => {
    if (!usable) {
      throw new StorageError(`Web storage area '${name}' is not available in this runtime`, {
        details: { driver: name },
      });
    }
    return /** @type {Storage} */ (area);
  };
  /** @type {StorageAdapter & { area?: Storage }} */
  const driver = {
    name,
    getItem: (key) => ensure().getItem(key),
    setItem: (key, value) => {
      ensure().setItem(key, value);
    },
    removeItem: (key) => {
      ensure().removeItem(key);
    },
    keys: () => {
      const store = ensure();
      /** @type {string[]} */
      const out = [];
      const length = typeof store.length === 'number' ? store.length : 0;
      for (let i = 0; i < length; i += 1) {
        const key = store.key(i);
        if (key != null) out.push(key);
      }
      return out;
    },
  };
  if (usable) driver.area = area;
  return driver;
}

/**
 * Driver over a DOM `Storage` area (`localStorage` / `sessionStorage`). Named `'local'` or
 * `'session'` when `area` is the matching global, `'web'` otherwise. An unusable `area` (SSR) yields a
 * driver whose operations throw `StorageError`, so `createStorage` falls back to memory.
 * @param {Storage} area
 * @returns {StorageAdapter}
 */
export function webStorageDriver(area) {
  let name = 'web';
  if (area && area === safeGlobal('localStorage')) name = 'local';
  else if (area && area === safeGlobal('sessionStorage')) name = 'session';
  return webDriver(area, name);
}

/**
 * Driver over `document.cookie`. Keys and values are `encodeURIComponent`‑encoded; `domain`, `secure`,
 * `sameSite`, `path` and `maxAgeSec` are written as cookie attributes on every write and removal.
 * Writes are verified by reading back, so a rejected cookie (size, `Secure` on http) throws
 * `StorageError` and lets `createStorage` fall back. Without a `document` (SSR) every operation throws
 * `StorageError`. Invalid options throw `ConfigError` at construction.
 * @param {CookieDriverOptions} [options]
 * @returns {StorageAdapter}
 */
export function cookieDriver(options = {}) {
  const { domain, path = '/', maxAgeSec } = options || {};
  let sameSite;
  if (options && options.sameSite != null) {
    const s = String(options.sameSite).toLowerCase();
    if (s !== 'lax' && s !== 'strict' && s !== 'none') {
      throw new ConfigError(`cookieDriver: invalid sameSite '${String(options.sameSite)}'`, {
        details: { sameSite: options.sameSite },
      });
    }
    sameSite = s.charAt(0).toUpperCase() + s.slice(1);
  }
  const secure = options && options.secure === true ? true : sameSite === 'None';
  if (
    maxAgeSec != null &&
    !(typeof maxAgeSec === 'number' && Number.isFinite(maxAgeSec) && maxAgeSec > 0)
  ) {
    // `Max-Age=0` (or negative) deletes the cookie on write: the read-back check would then fail and
    // the facade would silently fall back to memory, so reject it here instead.
    throw new ConfigError('cookieDriver: maxAgeSec must be a positive finite number of seconds', {
      details: { maxAgeSec },
    });
  }
  const maxAgeAttr = maxAgeSec != null ? `Max-Age=${Math.ceil(maxAgeSec)}` : undefined;

  /** @returns {Document} */
  const doc = () => {
    const d = safeGlobal('document');
    if (!d || typeof d.cookie !== 'string') {
      throw new StorageError('Cookies are not available in this runtime', {
        details: { driver: 'cookie' },
      });
    }
    return d;
  };

  /** @returns {Map<string, string>} decoded name → decoded value */
  const parse = () => {
    /** @type {Map<string, string>} */
    const out = new Map();
    const raw = doc().cookie;
    if (!raw) return out;
    for (const part of raw.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      const rawName = eq === -1 ? trimmed : trimmed.slice(0, eq);
      const rawValue = eq === -1 ? '' : trimmed.slice(eq + 1);
      let name;
      let value;
      try {
        name = decodeURIComponent(rawName);
        value = decodeURIComponent(rawValue);
      } catch {
        continue; // foreign cookie with a different encoding
      }
      if (!out.has(name)) out.set(name, value);
    }
    return out;
  };

  /** @param {string[]} attributes @returns {string} */
  const attrs = (attributes) => {
    const parts = [...attributes, `Path=${path}`];
    if (domain) parts.push(`Domain=${domain}`);
    if (sameSite) parts.push(`SameSite=${sameSite}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
  };

  return {
    name: 'cookie',
    getItem: (key) => {
      const found = parse().get(key);
      return found === undefined ? null : found;
    },
    setItem: (key, value) => {
      const d = doc();
      const str = String(value);
      const extra = maxAgeAttr ? [maxAgeAttr] : [];
      d.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(str)}; ${attrs(extra)}`;
      if (parse().get(key) !== str) {
        throw new StorageError('Cookie write was rejected by the browser', {
          details: { driver: 'cookie', key, size: str.length },
        });
      }
    },
    removeItem: (key) => {
      const d = doc();
      d.cookie = `${encodeURIComponent(key)}=; ${attrs(['Max-Age=0', `Expires=${EPOCH}`])}`;
    },
    keys: () => Array.from(parse().keys()),
  };
}

// ── facade ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the `driver` option into an adapter. Built‑in names look their area up lazily (call
 * time, never import time); a DOM `Storage` area is wrapped with `webStorageDriver` (so key
 * enumeration and cross‑tab events work); other custom adapters are validated as the
 * `StorageAdapter` duck type.
 * @param {StorageOptions['driver']} driver
 * @returns {StorageAdapter & { area?: Storage }}
 */
function resolveDriver(driver) {
  if (driver === undefined || driver === 'memory') return memoryDriver();
  if (driver === 'local') return webDriver(safeGlobal('localStorage'), 'local');
  if (driver === 'session') return webDriver(safeGlobal('sessionStorage'), 'session');
  if (driver === 'cookie') return cookieDriver();
  if (isAdapter(driver)) {
    if (typeof driver.name === 'string' && driver.name) return driver;
    if (isStorageArea(driver)) {
      return webStorageDriver(/** @type {Storage} */ (/** @type {unknown} */ (driver)));
    }
    /** @type {StorageAdapter} */
    const named = {
      name: 'custom',
      getItem: (key) => driver.getItem(key),
      setItem: (key, value) => driver.setItem(key, value),
      removeItem: (key) => driver.removeItem(key),
    };
    if (typeof driver.keys === 'function')
      named.keys = () => /** @type {() => string[]} */ (driver.keys)();
    return named;
  }
  throw new ConfigError(
    "createStorage: driver must be 'memory', 'local', 'session', 'cookie' or a StorageAdapter",
    { details: { driver: typeof driver === 'string' ? driver : typeof driver } }
  );
}

/**
 * Namespaced, TTL‑aware key/value facade over a storage driver. Probes the driver with one write
 * and falls back to memory when it throws (private mode, quota, SSR), calling `onUnavailable` and
 * emitting `storage:unavailable` on `events` exactly once; later driver failures degrade the same
 * way, so callers never see driver exceptions.
 * Effects: storage probe write · emit `storage:unavailable` on fallback.
 * @param {StorageOptions} [options]
 * @returns {StorageFacade}
 */
export function createStorage(options = {}) {
  const opts = options || {};
  const namespace = opts.namespace === undefined ? DEFAULT_NAMESPACE : opts.namespace;
  if (typeof namespace !== 'string') {
    throw new ConfigError('createStorage: namespace must be a string', {
      details: { namespace: typeof namespace },
    });
  }
  const serializer = opts.serializer === undefined ? JSON_SERIALIZER : opts.serializer;
  if (
    !serializer ||
    typeof serializer.serialize !== 'function' ||
    typeof serializer.deserialize !== 'function'
  ) {
    throw new ConfigError('createStorage: serializer needs serialize() and deserialize()');
  }
  const defaultTtlMs = normaliseTtl(opts.defaultTtlMs, 'defaultTtlMs', true);
  if (opts.onUnavailable !== undefined && typeof opts.onUnavailable !== 'function') {
    throw new ConfigError('createStorage: onUnavailable must be a function');
  }
  if (opts.now !== undefined && typeof opts.now !== 'function') {
    throw new ConfigError('createStorage: now must be a function returning milliseconds');
  }
  const now = opts.now || Date.now;
  const events = opts.events && typeof opts.events.emit === 'function' ? opts.events : undefined;
  const prefix = namespace ? `${namespace}${SEPARATOR}` : '';
  const probeKey = prefix + PROBE_KEY;

  const requested = resolveDriver(opts.driver);
  /** @type {StorageAdapter & { area?: Storage }} */
  let active = requested;
  let available = true;
  /** Keys written through this facade, for drivers without `keys()`. @type {Set<string>} */
  const known = new Set();
  /** @type {Map<string, Set<Subscription>>} */
  const subscribers = new Map();
  /** @type {any} */
  let listeningWindow = null;

  // ── fallback ──

  /** @param {unknown} cause */
  function degrade(cause) {
    if (!available) return;
    available = false;
    const error = toStorageError(cause, requested.name);
    const memory = memoryDriver();
    try {
      for (const key of rawKeys(requested)) {
        const value = requested.getItem(key);
        if (value != null) memory.setItem(key, value);
      }
    } catch {
      // best effort: whatever could be read survives the switch
    }
    active = memory;
    // Memory cannot observe other tabs: the old driver's cross-tab subscriptions are released.
    subscribers.clear();
    stopListening();
    /** @type {StorageUnavailableInfo} */
    const info = { driver: requested.name, fallback: 'memory' };
    if (typeof opts.onUnavailable === 'function') {
      try {
        opts.onUnavailable(error, info);
      } catch {
        // a reporting hook must never break storage
      }
    }
    emit('storage:unavailable', { ...info, error });
  }

  /** @param {string} event @param {unknown} payload */
  function emit(event, payload) {
    if (!events) return;
    try {
      events.emit(event, payload);
    } catch {
      // the emitter is observe-only
    }
  }

  /**
   * Runs a driver operation, degrading to memory (and retrying there) when it throws.
   * @template T
   * @param {(driver: StorageAdapter & { area?: Storage }) => T} op
   * @param {T} fallback
   * @returns {T}
   */
  function withDriver(op, fallback) {
    try {
      return op(active);
    } catch (e) {
      if (available) {
        degrade(e);
        try {
          return op(active);
        } catch {
          return fallback;
        }
      }
      return fallback;
    }
  }

  /**
   * Raw (namespaced) keys of a driver: its own `keys()` (any iterable is accepted) or the facade's
   * bookkeeping. The probe key is never listed, even when a failed probe could not clean it up.
   * @param {StorageAdapter} driver
   * @returns {string[]}
   */
  function rawKeys(driver) {
    const list =
      typeof driver.keys === 'function' ? Array.from(driver.keys() ?? []) : Array.from(known);
    return list.filter((k) => typeof k === 'string' && k.startsWith(prefix) && k !== probeKey);
  }

  // ── envelopes ──

  /** @param {string} key @returns {string} */
  const full = (key) => prefix + assertKey(key);
  /** @param {string} raw @returns {string} */
  const strip = (raw) => raw.slice(prefix.length);

  /**
   * Decodes a raw driver value: `{ ok: false }` when corrupt, `{ ok: true, value, expired }` otherwise.
   * @param {string} raw
   * @returns {{ ok: boolean, value?: unknown, expired?: boolean }}
   */
  function decode(raw) {
    let parsed;
    try {
      parsed = serializer.deserialize(raw);
    } catch {
      return { ok: false };
    }
    if (isEnvelope(parsed)) {
      const expiresAt = /** @type {{ e?: unknown }} */ (parsed).e;
      const expired = typeof expiresAt === 'number' && now() >= expiresAt;
      return { ok: true, value: /** @type {{ v: unknown }} */ (parsed).v, expired };
    }
    return { ok: true, value: parsed, expired: false }; // foreign / legacy raw value
  }

  // ── public API ──

  /** @type {StorageFacade['get']} */
  function get(key) {
    const k = full(key);
    const raw = withDriver((d) => d.getItem(k), null);
    if (raw == null) return undefined;
    const decoded = decode(String(raw));
    if (!decoded.ok || decoded.expired) {
      removeRaw(k);
      return undefined;
    }
    return /** @type {any} */ (decoded.value);
  }

  /** @type {StorageFacade['set']} */
  function set(key, value, setOptions = {}) {
    const k = full(key);
    if (value === undefined) {
      removeRaw(k);
      return;
    }
    const ttl =
      setOptions && setOptions.ttlMs !== undefined
        ? normaliseTtl(setOptions.ttlMs, 'ttlMs', false)
        : defaultTtlMs;
    const envelope = ttl > 0 ? { v: value, e: now() + ttl } : { v: value };
    let raw;
    try {
      raw = serializer.serialize(envelope);
    } catch (e) {
      throw new StorageError(`Could not serialise value for key '${key}'`, {
        cause: e,
        details: { key },
      });
    }
    if (typeof raw !== 'string') {
      throw new StorageError(`Serializer must return a string for key '${key}'`, {
        details: { key, type: typeof raw },
      });
    }
    withDriver((d) => {
      d.setItem(k, raw);
    }, undefined);
    // Bookkeeping is only needed for drivers that cannot enumerate their own keys.
    if (typeof active.keys !== 'function') known.add(k);
  }

  /** @param {string} k namespaced key */
  function removeRaw(k) {
    withDriver((d) => {
      d.removeItem(k);
    }, undefined);
    known.delete(k);
  }

  /** @type {StorageFacade['remove']} */
  function remove(key) {
    removeRaw(full(key));
  }

  /** @type {StorageFacade['has']} */
  function has(key) {
    return get(key) !== undefined;
  }

  /** @type {StorageFacade['keys']} */
  function keys(keyPrefix) {
    if (keyPrefix !== undefined && typeof keyPrefix !== 'string') {
      throw new ValidationError('Storage key prefix must be a string', {
        issues: [issue('prefix', 'invalid_type', 'prefix must be a string')],
      });
    }
    const list = withDriver((d) => rawKeys(d), /** @type {string[]} */ ([])).map(strip);
    return keyPrefix ? list.filter((k) => k.startsWith(keyPrefix)) : list;
  }

  /** @type {StorageFacade['clear']} */
  function clear(keyPrefix) {
    for (const key of keys(keyPrefix)) removeRaw(prefix + key);
  }

  /** @type {StorageFacade['isAvailable']} */
  function isAvailable() {
    return available;
  }

  // ── cross-tab subscriptions ──

  /**
   * Shared window `storage` listener. Only events for the active web storage area are relayed
   * (an event without `storageArea`, as some polyfills send, is accepted).
   * @param {any} event the window `storage` event
   */
  function onStorageEvent(event) {
    if (!event || !active.area) return;
    if (event.storageArea && event.storageArea !== active.area) return;
    if (event.key == null) {
      // `clear()` in another tab: every subscriber hears "gone".
      for (const [k, set] of subscribers) notify(set, undefined, undefined, strip(k));
      return;
    }
    const set = subscribers.get(event.key);
    if (!set) return;
    notify(set, valueOf(event.newValue), valueOf(event.oldValue), strip(event.key));
  }

  /** @param {unknown} raw @returns {unknown} */
  function valueOf(raw) {
    if (raw == null) return undefined;
    const decoded = decode(String(raw));
    return decoded.ok && !decoded.expired ? decoded.value : undefined;
  }

  /**
   * @param {Set<Subscription>} set
   * @param {unknown} value @param {unknown} previous @param {string} key
   */
  function notify(set, value, previous, key) {
    for (const { fn } of Array.from(set)) {
      try {
        fn(value, previous, key);
      } catch (e) {
        emit('error', { error: wrap(e) });
      }
    }
  }

  /** @returns {any} the window when it can take listeners, else `undefined` */
  function getWindow() {
    const win = safeGlobal('window');
    return win && typeof win.addEventListener === 'function' ? win : undefined;
  }

  /** Detaches the shared window `storage` listener, if attached. */
  function stopListening() {
    if (!listeningWindow) return;
    try {
      listeningWindow.removeEventListener('storage', onStorageEvent);
    } catch {
      // nothing to clean up
    }
    listeningWindow = null;
  }

  /** @type {StorageFacade['subscribe']} */
  function subscribe(key, fn) {
    const k = full(key);
    if (typeof fn !== 'function') {
      throw new ValidationError('Storage subscriber must be a function', {
        issues: [issue('fn', 'invalid_type', 'fn must be a function')],
      });
    }
    const win = getWindow();
    // Only a web storage area emits cross-tab `storage` events; anything else gets an inert off().
    if (!win || !active.area) return () => {};
    /** @type {Subscription} */
    const entry = { fn };
    let set = subscribers.get(k);
    if (!set) {
      set = new Set();
      subscribers.set(k, set);
    }
    set.add(entry);
    if (!listeningWindow) {
      win.addEventListener('storage', onStorageEvent);
      listeningWindow = win;
    }
    return () => {
      const current = subscribers.get(k);
      if (!current || !current.delete(entry)) return; // already removed (off(), destroy(), fallback)
      if (current.size === 0) subscribers.delete(k);
      if (subscribers.size === 0) stopListening();
    };
  }

  /** @type {StorageFacade['destroy']} */
  function destroy() {
    subscribers.clear();
    stopListening();
  }

  probe();

  return {
    get,
    set,
    remove,
    has,
    keys,
    clear,
    isAvailable,
    get driverName() {
      return active.name;
    },
    subscribe,
    destroy,
  };

  /**
   * One write / read / remove round trip on the requested driver; any failure switches to memory.
   * @returns {void}
   */
  function probe() {
    try {
      requested.setItem(probeKey, '1');
      const back = requested.getItem(probeKey);
      requested.removeItem(probeKey);
      if (back !== '1') {
        throw new StorageError(
          `Storage driver '${requested.name}' did not persist the probe value`,
          {
            details: { driver: requested.name },
          }
        );
      }
    } catch (e) {
      degrade(e);
    }
  }
}

/**
 * True for the `{ v, e? }` envelope shape written by `set`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.includes('v')) return false;
  return keys.every((k) => k === 'v' || k === 'e');
}

/**
 * Validates a TTL: `undefined` / `null` / `0` / `Infinity` mean "no expiry" (returns 0); a positive
 * finite number is returned as is; anything else is rejected.
 * @param {unknown} ttlMs @param {string} path @param {boolean} config `ConfigError` instead of `ValidationError`
 * @returns {number}
 */
function normaliseTtl(ttlMs, path, config) {
  if (ttlMs == null || ttlMs === 0 || ttlMs === Infinity) return 0;
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) return ttlMs;
  const message = `${path} must be a positive number of milliseconds (or 0 for no expiry)`;
  if (config) throw new ConfigError(`createStorage: ${message}`, { details: { [path]: ttlMs } });
  throw new ValidationError(message, {
    issues: [issue(path, 'invalid_ttl', message)],
  });
}
