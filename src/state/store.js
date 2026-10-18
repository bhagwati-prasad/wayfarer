/**
 * Immutable slice store for the Wayfarer SDK (docs/api/02-state-events-errors.md §1; state shape and
 * persistence defaults in docs/README.md §5). `createStore` holds one frozen root object with one key
 * per registered slice. `set(slice, updater | partial, meta)` applies a change synchronously with
 * structural sharing (untouched slices keep their reference) and every commit runs through the
 * `use()` middleware chain; listener notification, `state:change` events and persistence are
 * batched per microtask (`queueMicrotask`), so several `set`s in one tick notify once, and `batch()`
 * flushes synchronously when its outermost call ends. `subscribe` has a plain form (whole state,
 * `useSyncExternalStore`‑compatible together with `getSnapshot`, which returns the same reference
 * until a commit) and a selector form (`equality`, `fireImmediately`); `select` memoises by selector
 * identity. `registerSlice` is idempotent, hydrates persisted slices from the injected storage
 * (`{ storage }` is a `StorageFacade` from storage/adapters.js or a factory `(kind) => StorageFacade`
 * so `'local'` / `'session'` / `'memory'` can differ) and honours `persist: { storage, ttlMs, pick,
 * migrate }`; writes are debounced through injectable timers. Stored and restored data can never
 * change a slice's shape: a plain‑object / array slice only accepts plain‑object / array data, and
 * `restore()` deep‑copies what it applies so a caller‑held snapshot is never aliased by the state.
 * `snapshot()` / `restore()` skip slices flagged `secret` (session tokens). `toObservable(selector?)`
 * follows the TC39 / RxJS observable contract (`subscribe(observer | next, error?, complete?) →
 * { unsubscribe }`, `Symbol.observable` when defined) and emits the current value on subscribe,
 * which also makes it the Svelte store contract (`store.subscribe` itself keeps the documented
 * `(selector, listener)` form, so Svelte binds to `toObservable()`). `devtools: true` logs every
 * commit through the optional logger. SSR‑safe: no `window` / `document` / `localStorage` access
 * (storage is injected), no module‑level mutable state, no `console.*`; errors are `ConfigError`
 * (install‑time options) and `ValidationError` (call arguments) from `../errors/index.js`, and
 * listener / selector / equality exceptions are routed to the `error` event / logger instead of
 * breaking a commit or escaping the notification microtask. Persistence failures never escape
 * either: they are logged and the state stands. After `destroy()` reads keep working and writes
 * still update the state, but nothing is retained for notification or persistence.
 */

import { ConfigError, ValidationError, isSdkError, wrap } from '../errors/index.js';
import { createStorage } from '../storage/adapters.js';
import {
  clone,
  get as getPath,
  isPlainObject,
  set as setPath,
  shallowEqual,
} from '../utils/object.js';

export { shallowEqual };

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../storage/adapters.js').StorageFacade} StorageFacade */
/** @typedef {import('../utils/logger.js').Logger} Logger */
/** @typedef {import('../errors/index.js').SdkError} SdkError */

/** Where a persisted slice lives (docs/README.md §5). @typedef {'local'|'session'|'memory'} PersistKind */

/**
 * The storage surface the store needs: a `StorageFacade` from storage/adapters.js or any duck type.
 * @typedef {Object} StorageLike
 * @property {(key: string) => unknown} get
 * @property {(key: string, value: unknown, options?: { ttlMs?: number }) => void} set
 * @property {(key: string) => void} remove
 */

/**
 * Factory giving one storage per persistence kind, so `'local'` and `'session'` slices can differ.
 * @typedef {(kind: PersistKind) => StorageLike} StorageFactory
 */

/**
 * Timers the persistence debounce uses (injectable for tests / schedulers).
 * @typedef {Object} StoreTimers
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/**
 * Minimal event emitter the store reports to (`client.events` or any `{ emit }` duck type).
 * @typedef {{ emit: (event: string, payload?: unknown) => void }} StoreEvents
 */

/**
 * Per‑slice persistence (`registerSlice(name, { persist })`).
 * @typedef {Object} SlicePersistOptions
 * @property {PersistKind} [storage]  Defaults to the store's `persist.storage` (`'local'`).
 * @property {number} [ttlMs]  Expiry handed to the storage facade; `0` / omitted = none.
 * @property {string[]} [pick]  Paths persisted (dotted paths allowed, e.g. `'current.id'`); omitted = whole slice.
 * @property {number} [version=1]  Schema version written next to the data.
 * @property {(old: unknown, version: number) => unknown} [migrate]  Converts data stored under another
 *   version; returning `undefined` drops it. Without it a version mismatch drops the stored data.
 * @property {number} [debounceMs]  Write debounce; defaults to the store's `persist.debounceMs`.
 */

/**
 * Options of `registerSlice`.
 * @typedef {Object} SliceOptions
 * @property {unknown} initial  Initial (and `reset`) value; frozen shallowly.
 * @property {boolean|SlicePersistOptions} [persist]  `true` = defaults.
 * @property {(old: unknown, version: number) => unknown} [migrate]  Same as `persist.migrate` (doc form).
 * @property {number} [version]  Same as `persist.version`.
 * @property {boolean} [secret]  Excluded from `snapshot()` / `restore()` and from devtools payloads.
 */

/**
 * Store‑wide persistence defaults (`createStore({ persist })`); `false` disables persistence.
 * @typedef {Object} StorePersistDefaults
 * @property {PersistKind} [storage='local']
 * @property {number} [debounceMs=200]
 * @property {string} [prefix='state']  Storage key prefix: `<prefix>:<slice>`.
 */

/**
 * One applied change.
 * @typedef {Object} SliceChange
 * @property {string} slice
 * @property {string} action
 * @property {unknown} prev
 * @property {unknown} next
 * @property {object} [meta]
 */

/**
 * What a batched notification describes (third argument of a plain listener).
 * @typedef {Object} StateChange
 * @property {string[]} slices  Distinct slices touched, in first‑touch order.
 * @property {string[]} actions  Every action in commit order.
 * @property {SliceChange[]} changes
 */

/** @typedef {Record<string, unknown>} State */

/**
 * @typedef {Object} MiddlewareContext
 * @property {string} slice
 * @property {string} action
 * @property {unknown} prev
 * @property {unknown} next
 * @property {object} [meta]
 */

/**
 * Wraps every commit. Call `proceed()` to apply it (optionally with a replacement `next`); not calling
 * it cancels the commit.
 * @typedef {(ctx: MiddlewareContext, proceed: (next?: unknown) => void) => void} Middleware
 */

/** @typedef {(state: State) => any} Selector */
/** @typedef {(state: State, prev: State | undefined, change: StateChange | undefined) => void} Listener */
/** @typedef {(value: any, prev: any) => void} SelectorListener */

/**
 * @typedef {Object} SubscribeOptions
 * @property {(a: any, b: any) => boolean} [equality=Object.is]  Selector form only.
 * @property {boolean} [fireImmediately=false]  Call the listener with the current value at once.
 */

/**
 * @typedef {Object} Observer
 * @property {(value: any) => void} [next]
 * @property {(error: unknown) => void} [error]
 * @property {() => void} [complete]
 */

/** @typedef {{ unsubscribe: () => void, readonly closed: boolean }} Subscription */

/**
 * TC39 / RxJS observable contract: `subscribe` emits the current value synchronously, then every
 * change of the selected value; `complete` fires on `store.destroy()`. Accepts an observer object or
 * the positional `(next?, error?, complete?)` form.
 * @typedef {{ subscribe: (observer?: Observer | ((value: any) => void) | null, error?: (error: unknown) => void, complete?: () => void) => Subscription }} Observable
 */

/**
 * Serialisable copy of the state (persisted + transient slices, minus `secret` ones).
 * @typedef {Object} StoreSnapshot
 * @property {number} version
 * @property {number} at
 * @property {Record<string, unknown>} slices
 */

/**
 * @typedef {Object} StorePersist
 * @property {() => Promise<void>} flush  Write every pending persisted slice now.
 * @property {(slice?: string) => Promise<void>} hydrate  Re‑read storage into the slice(s). Stored data
 *   replaces the slice and makes a write still pending for it obsolete; when nothing (valid) is stored
 *   the slice and its pending write are left alone. Rejects with `ValidationError` on an unknown slice.
 * @property {(slice?: string) => void} clear  Remove the persisted copy of the slice(s) and cancel pending writes.
 */

/**
 * @typedef {Object} StoreOptions
 * @property {Record<string, SliceOptions>} [slices]  Slices registered at creation.
 * @property {Middleware[]} [middleware]  Installed in order.
 * @property {boolean|StorePersistDefaults} [persist]  `false` disables persistence for every slice.
 * @property {boolean} [devtools]  Log every commit at `debug` through `logger`.
 * @property {StorageLike|StorageFactory} [storage]  Storage facade, or a factory per kind. Without it
 *   persistence goes to an internal memory facade (nothing survives the store).
 * @property {StoreEvents} [events]  Receives `state:change` `{ slice, action }` per commit and `error`.
 * @property {Partial<Logger>} [logger]  Devtools / persistence warnings / listener faults.
 * @property {Partial<StoreTimers>} [timers]  Defaults to the global timers, looked up at call time.
 * @property {() => number} [now]  Clock for `snapshot().at`.
 */

/**
 * @typedef {Object} Store
 * @property {() => State} getState
 * @property {(path?: string | Array<string|number>) => unknown} get
 * @property {<T>(selector: (state: State) => T, equality?: (a: T, b: T) => boolean) => T} select
 * @property {{
 *   (listener: Listener, options?: { fireImmediately?: boolean }): () => void,
 *   <T>(selector: (state: State) => T, listener: (value: T, prev: T | undefined) => void, options?: SubscribeOptions): () => void,
 * }} subscribe
 * @property {(slice: string, updater: object | ((s: any) => any), meta?: { action?: string } & Record<string, unknown>) => void} set
 * @property {(fn: () => void) => void} batch
 * @property {(slice?: string) => void} reset
 * @property {(name: string, options: SliceOptions) => void} registerSlice
 * @property {(name: string) => boolean} hasSlice
 * @property {(middleware: Middleware) => () => void} use
 * @property {StorePersist} persist
 * @property {() => StoreSnapshot} snapshot
 * @property {(snapshot: StoreSnapshot | { slices: Record<string, unknown> }) => void} restore
 * @property {() => State} getSnapshot
 * @property {(selector?: Selector) => Observable} toObservable
 * @property {() => void} destroy
 */

/** @typedef {{ kind: PersistKind, key: string, ttlMs: number, pick: string[] | null, version: number, migrate: ((old: unknown, version: number) => unknown) | undefined, debounceMs: number }} ResolvedPersist */
/** @typedef {{ name: string, initial: unknown, secret: boolean, persist: ResolvedPersist | null, timer: unknown, dirty: boolean }} SliceRecord */

const DEFAULT_PREFIX = 'state';
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_KIND = 'local';
const DEFAULT_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const KINDS = new Set(['local', 'session', 'memory']);
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Actions of the store's own commits (middleware can tell them apart by the `@@` prefix). */
const STORE_ACTIONS = Object.freeze({
  init: '@@init',
  hydrate: '@@hydrate',
  reset: '@@reset',
  restore: '@@restore',
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * @param {string} path @param {string} code @param {string} message
 * @returns {ValidationIssue}
 */
function issue(path, code, message) {
  return { path, code, message };
}

/**
 * @param {string} message @param {string} path @param {string} [code]
 * @returns {ValidationError}
 */
function invalid(message, path, code = 'invalid_type') {
  return new ValidationError(message, { issues: [issue(path, code, message)] });
}

/**
 * @param {unknown} fn @param {string} name
 * @returns {Function}
 */
function requireFn(fn, name) {
  if (typeof fn !== 'function') throw invalid(`store: ${name} must be a function`, name);
  return fn;
}

/**
 * Shallow freeze of plain objects / arrays (class instances are left alone). Returns the input.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function freeze(value) {
  if (
    value !== null &&
    typeof value === 'object' &&
    (isPlainObject(value) || Array.isArray(value)) &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
  }
  return value;
}

/** @param {() => void} fn */
function enqueueMicrotask(fn) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else Promise.resolve().then(fn);
}

/**
 * @param {unknown} value
 * @returns {value is StorageLike}
 */
function isStorageLike(value) {
  if (!value || typeof value !== 'object') return false;
  const s = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof s.get === 'function' && typeof s.set === 'function' && typeof s.remove === 'function'
  );
}

/** @returns {symbol | undefined} `Symbol.observable` when the runtime / a polyfill defines it. */
function observableSymbol() {
  const sym = /** @type {any} */ (Symbol).observable;
  return typeof sym === 'symbol' ? sym : undefined;
}

/**
 * Validates a persistence kind.
 * @param {unknown} kind @param {string} where
 * @returns {PersistKind}
 */
function assertKind(kind, where) {
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new ConfigError(`${where}: storage must be 'local', 'session' or 'memory'`, {
      details: { storage: kind },
    });
  }
  return /** @type {PersistKind} */ (kind);
}

/**
 * Validates a non‑negative finite number of milliseconds.
 * @param {unknown} ms @param {string} where @param {string} field
 * @returns {number}
 */
function assertMs(ms, where, field) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new ConfigError(`${where}: ${field} must be a non-negative number of milliseconds`, {
      details: { [field]: ms },
    });
  }
  return ms;
}

/**
 * Normalises `createStore({ persist })`: `null` when disabled.
 * @param {StoreOptions['persist']} persist
 * @returns {{ storage: PersistKind, debounceMs: number, prefix: string } | null}
 */
function resolvePersistDefaults(persist) {
  if (persist === false) return null;
  if (persist === undefined || persist === true) {
    return { storage: DEFAULT_KIND, debounceMs: DEFAULT_DEBOUNCE_MS, prefix: DEFAULT_PREFIX };
  }
  if (!isPlainObject(persist)) {
    throw new ConfigError('createStore: persist must be a boolean or an options object', {
      details: { persist: typeof persist },
    });
  }
  const storage =
    persist.storage === undefined ? DEFAULT_KIND : assertKind(persist.storage, 'createStore');
  const debounceMs =
    persist.debounceMs === undefined
      ? DEFAULT_DEBOUNCE_MS
      : assertMs(persist.debounceMs, 'createStore', 'persist.debounceMs');
  const prefix = persist.prefix === undefined ? DEFAULT_PREFIX : persist.prefix;
  if (typeof prefix !== 'string') {
    throw new ConfigError('createStore: persist.prefix must be a string', {
      details: { prefix: typeof prefix },
    });
  }
  return { storage, debounceMs, prefix };
}

/**
 * @param {Partial<StoreTimers> | undefined} timers
 * @returns {StoreTimers}
 */
function resolveTimers(timers) {
  const t = timers && typeof timers === 'object' ? timers : {};
  return {
    setTimeout:
      typeof t.setTimeout === 'function' ? t.setTimeout : (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout:
      typeof t.clearTimeout === 'function'
        ? t.clearTimeout
        : (handle) => globalThis.clearTimeout(/** @type {any} */ (handle)),
  };
}

/**
 * True for the `{ v, d }` envelope written by the store.
 * @param {unknown} value
 * @returns {value is { v: number, d: unknown }}
 */
function isEnvelope(value) {
  return (
    isPlainObject(value) &&
    typeof (/** @type {any} */ (value).v) === 'number' &&
    hasOwn(value, 'd') &&
    Object.keys(value).length === 2
  );
}

/**
 * Normalises the arguments of `subscribe`: an observer object, or the positional
 * `(next?, error?, complete?)` functions of the TC39 / RxJS contract.
 * @param {unknown} observer @param {unknown} [error] @param {unknown} [complete]
 * @returns {Observer}
 */
function toObserver(observer, error, complete) {
  if (observer && typeof observer === 'object') return /** @type {Observer} */ (observer);
  if (observer !== undefined && observer !== null && typeof observer !== 'function') {
    throw invalid(
      'toObservable: subscribe needs an observer object or a next function',
      'observer'
    );
  }
  /** @type {Observer} */
  const out = {};
  if (typeof observer === 'function') out.next = /** @type {(v: any) => void} */ (observer);
  if (typeof error === 'function') out.error = /** @type {(e: unknown) => void} */ (error);
  if (typeof complete === 'function') out.complete = /** @type {() => void} */ (complete);
  if (!out.next && !out.error && !out.complete) {
    throw invalid(
      'toObservable: subscribe needs an observer object or a next function',
      'observer'
    );
  }
  return out;
}

/**
 * Whether `data` may stand in for `current`: a plain‑object slice only accepts plain objects, an array
 * slice only arrays (so tampered storage or a foreign snapshot can never change a slice's shape);
 * picked paths are read from a plain object; any other slice value accepts anything.
 * @param {unknown} current @param {unknown} data @param {string[] | null} pick
 * @returns {boolean}
 */
function compatible(current, data, pick) {
  if (pick) return isPlainObject(data);
  if (isPlainObject(current)) return isPlainObject(data);
  if (Array.isArray(current)) return Array.isArray(data);
  return true;
}

// ── store ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Immutable, slice‑based store. Registers `slices`, installs `middleware` and hydrates persisted
 * slices from `storage` (a `StorageFacade` or a factory `(kind) => StorageFacade`).
 * Effects: storage read (hydrate persisted slices).
 * @param {StoreOptions} [options]
 * @returns {Store}
 * @throws {ConfigError} on invalid options
 */
export function createStore(options = {}) {
  const opts = options || {};
  if (
    opts.storage !== undefined &&
    typeof opts.storage !== 'function' &&
    !isStorageLike(opts.storage)
  ) {
    throw new ConfigError(
      'createStore: storage must be a Storage facade or a factory (kind) => Storage',
      {
        details: { storage: typeof opts.storage },
      }
    );
  }
  if (opts.slices !== undefined && !isPlainObject(opts.slices)) {
    throw new ConfigError('createStore: slices must be an object of slice options');
  }
  if (opts.middleware !== undefined && !Array.isArray(opts.middleware)) {
    throw new ConfigError('createStore: middleware must be an array of functions');
  }
  if (opts.events !== undefined && (!opts.events || typeof opts.events.emit !== 'function')) {
    throw new ConfigError('createStore: events must expose emit()');
  }
  const persistDefaults = resolvePersistDefaults(opts.persist);
  const devtools = opts.devtools === true;
  const logger = opts.logger && typeof opts.logger === 'object' ? opts.logger : undefined;
  const events = opts.events;
  const timers = resolveTimers(opts.timers);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  /** @type {State} */
  let state = Object.freeze({});
  /** @type {Map<string, SliceRecord>} */
  const slices = new Map();
  /** @type {Middleware[]} */
  const middlewares = [];
  /** @type {Set<{ fn: Listener }>} */
  const listeners = new Set();
  /** @type {Set<{ selector: Selector, listener: SelectorListener, equality: (a: any, b: any) => boolean, last: unknown }>} */
  const selected = new Set();
  /** @type {Set<{ selector: Selector, observer: Observer, last: unknown, closed: boolean }>} */
  const observers = new Set();
  /** @type {WeakMap<Function, { state: State, value: unknown }>} */
  const selectCache = new WeakMap();
  /** @type {SliceChange[]} */
  let pending = [];
  /** @type {State | null} state before the first pending change */
  let prevState = null;
  let scheduled = false;
  let batchDepth = 0;
  let destroyed = false;
  /** @type {Map<PersistKind, StorageLike>} */
  const storages = new Map();
  /** @type {StorageLike | undefined} */
  let memoryStorage;
  /** Snapshot slices restored before their slice registered. @type {Map<string, unknown>} */
  const pendingRestore = new Map();

  // ── reporting ──

  /** @param {string} message @param {unknown} data */
  function warn(message, data) {
    if (logger && typeof logger.warn === 'function') {
      try {
        logger.warn(`[store] ${message}`, data);
      } catch {
        // a logger must never break the store
      }
    }
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

  /** Routes a listener exception to the `error` event, else the logger. @param {unknown} e */
  function report(e) {
    const error = isSdkError(e) ? e : wrap(e);
    if (events) emit('error', { error });
    else if (logger && typeof logger.error === 'function') {
      try {
        logger.error('[store] listener failed', { error });
      } catch {
        // nothing left to report to
      }
    }
  }

  /** @param {() => void} fn */
  function safeCall(fn) {
    try {
      fn();
    } catch (e) {
      report(e);
    }
  }

  // ── storage ──

  /**
   * Storage for a kind: factory result (cached per kind), the single facade, or an internal memory
   * facade (always for `'memory'` when no factory is given, so nothing meant to be transient leaks
   * into a browser area).
   * @param {PersistKind} kind
   * @returns {StorageLike}
   */
  function storageFor(kind) {
    const cached = storages.get(kind);
    if (cached) return cached;
    /** @type {StorageLike} */
    let storage;
    if (typeof opts.storage === 'function') {
      try {
        storage = /** @type {StorageFactory} */ (opts.storage)(kind);
      } catch (e) {
        if (e instanceof ConfigError) throw e;
        throw new ConfigError(`createStore: storage factory threw for '${kind}'`, {
          cause: e,
          details: { kind },
        });
      }
      if (!isStorageLike(storage)) {
        throw new ConfigError(`createStore: storage factory must return a Storage for '${kind}'`, {
          details: { kind },
        });
      }
    } else if (opts.storage && kind !== 'memory') {
      storage = opts.storage;
    } else {
      if (!memoryStorage) memoryStorage = createStorage({ driver: 'memory' });
      storage = memoryStorage;
    }
    storages.set(kind, storage);
    return storage;
  }

  // ── slices ──

  /**
   * A usable slice name: non‑empty, addressable through `get('<slice>.<path>')` (no dots or brackets)
   * and never an `Object.prototype` member (`__proto__`, `constructor`, `toString`, …), so a slice can
   * neither pollute nor be shadowed by the prototype of the root object.
   * @param {unknown} name
   * @returns {name is string}
   */
  function isValidName(name) {
    return (
      typeof name === 'string' &&
      name.length > 0 &&
      !/[.[\]]/.test(name) &&
      !UNSAFE_NAMES.has(name) &&
      !(name in Object.prototype)
    );
  }

  /**
   * @param {unknown} name
   * @returns {string}
   */
  function assertName(name) {
    if (!isValidName(name)) {
      throw invalid(
        'store: slice name must be a non-empty string without dots or brackets and not an Object.prototype member',
        'slice'
      );
    }
    return name;
  }

  /**
   * @param {unknown} name @param {string} op
   * @returns {SliceRecord}
   */
  function requireSlice(name, op) {
    const record = slices.get(assertName(name));
    if (!record) {
      throw invalid(
        `store.${op}: unknown slice '${String(name)}' (registerSlice first)`,
        'slice',
        'unknown_slice'
      );
    }
    return record;
  }

  /**
   * @param {string} name @param {SliceOptions} sliceOptions
   * @returns {ResolvedPersist | null}
   */
  function resolvePersist(name, sliceOptions) {
    const p = sliceOptions.persist;
    if (p === undefined || p === false || p === null || !persistDefaults) return null;
    const where = `registerSlice('${name}')`;
    const conf = p === true ? {} : p;
    if (!isPlainObject(conf)) {
      throw new ConfigError(`${where}: persist must be true or an options object`, {
        details: { persist: typeof p },
      });
    }
    const kind =
      conf.storage === undefined ? persistDefaults.storage : assertKind(conf.storage, where);
    let ttlMs = 0;
    if (conf.ttlMs !== undefined && conf.ttlMs !== null && conf.ttlMs !== Infinity) {
      ttlMs = assertMs(conf.ttlMs, where, 'persist.ttlMs');
    }
    /** @type {string[] | null} */
    let pick = null;
    if (conf.pick !== undefined) {
      if (!Array.isArray(conf.pick) || conf.pick.some((k) => typeof k !== 'string' || !k)) {
        throw new ConfigError(`${where}: persist.pick must be an array of non-empty paths`, {
          details: { pick: conf.pick },
        });
      }
      for (const path of conf.pick) {
        // Same parser as the writes: an empty or prototype-polluting path fails here, not later.
        try {
          setPath({}, path, null);
        } catch (e) {
          throw new ConfigError(`${where}: persist.pick path '${path}' is not allowed`, {
            cause: e,
            details: { pick: path },
          });
        }
      }
      pick = conf.pick.slice();
    }
    const rawVersion = sliceOptions.version !== undefined ? sliceOptions.version : conf.version;
    const version = rawVersion === undefined ? DEFAULT_VERSION : rawVersion;
    if (!Number.isInteger(version) || version < 0) {
      throw new ConfigError(`${where}: version must be a non-negative integer`, {
        details: { version: rawVersion },
      });
    }
    const migrate = sliceOptions.migrate !== undefined ? sliceOptions.migrate : conf.migrate;
    if (migrate !== undefined && typeof migrate !== 'function') {
      throw new ConfigError(`${where}: migrate must be a function`);
    }
    const debounceMs =
      conf.debounceMs === undefined
        ? persistDefaults.debounceMs
        : assertMs(conf.debounceMs, where, 'persist.debounceMs');
    const key = persistDefaults.prefix ? `${persistDefaults.prefix}:${name}` : name;
    // Resolve the storage now: a broken factory must fail the registration before any state changes.
    storageFor(kind);
    return { kind, key, ttlMs, pick, version, migrate, debounceMs };
  }

  /**
   * Register a slice with its initial value; idempotent (a second call with any options is ignored).
   * Hydrates the slice from storage when `persist` is set and applies a snapshot restored before the
   * slice existed. Effects: state (initial) · storage read.
   * @param {string} name
   * @param {SliceOptions} sliceOptions
   * @returns {void}
   * @throws {ConfigError} on invalid options · {ValidationError} on an invalid name
   */
  function registerSlice(name, sliceOptions) {
    assertName(name);
    if (slices.has(name)) return;
    if (!sliceOptions || typeof sliceOptions !== 'object') {
      throw new ConfigError(`registerSlice('${name}'): options object with initial is required`);
    }
    if (sliceOptions.initial === undefined) {
      throw new ConfigError(`registerSlice('${name}'): initial is required`);
    }
    /** @type {SliceRecord} */
    const record = {
      name,
      initial: freeze(sliceOptions.initial),
      secret: sliceOptions.secret === true,
      persist: resolvePersist(name, sliceOptions),
      timer: null,
      dirty: false,
    };
    slices.set(name, record);
    commit(name, record.initial, STORE_ACTIONS.init, undefined);
    if (record.persist) hydrateSlice(record);
    if (pendingRestore.has(name)) {
      const value = pendingRestore.get(name);
      pendingRestore.delete(name);
      if (!record.secret) applyRestore(record, value);
    }
  }

  /** @param {string} name @returns {boolean} */
  function hasSlice(name) {
    return typeof name === 'string' && slices.has(name);
  }

  // ── commits ──

  /**
   * Runs the middleware chain for one commit and applies it when the chain proceeds.
   * @param {string} name @param {unknown} next @param {string} action @param {object | undefined} meta
   */
  function commit(name, next, action, meta) {
    /** @type {MiddlewareContext} */
    const ctx = { slice: name, action, prev: current(name), next: freeze(next) };
    if (meta !== undefined) ctx.meta = meta;
    const chain = middlewares.slice();
    /** @param {number} i @param {MiddlewareContext} c */
    const run = (i, c) => {
      if (i === chain.length) {
        apply(c);
        return;
      }
      let proceeded = false;
      chain[i](c, (override) => {
        if (proceeded) return;
        proceeded = true;
        run(i + 1, override === undefined ? c : { ...c, next: freeze(override) });
      });
    };
    run(0, ctx);
  }

  /**
   * The current value of a slice; `undefined` when it is not in the state yet (never an inherited
   * `Object.prototype` member).
   * @param {string} name
   * @returns {unknown}
   */
  function current(name) {
    return hasOwn(state, name) ? state[name] : undefined;
  }

  /** @param {MiddlewareContext} c */
  function apply(c) {
    if (hasOwn(state, c.slice) && Object.is(c.next, c.prev)) return;
    if (!destroyed && pending.length === 0) prevState = state;
    state = Object.freeze({ ...state, [c.slice]: c.next });
    const record = slices.get(c.slice);
    if (devtools && logger && typeof logger.debug === 'function') {
      const payload =
        record && record.secret
          ? { slice: c.slice, action: c.action, secret: true }
          : { slice: c.slice, action: c.action, prev: c.prev, next: c.next };
      try {
        logger.debug(`[store] ${c.action}`, payload);
      } catch {
        // devtools logging is best effort
      }
    }
    // After destroy() the state still updates for reads, but nothing is retained: no listener,
    // event or write will ever consume a pending change again.
    if (destroyed) return;
    /** @type {SliceChange} */
    const change = { slice: c.slice, action: c.action, prev: c.prev, next: c.next };
    if (c.meta !== undefined) change.meta = c.meta;
    pending.push(change);
    if (
      record &&
      record.persist &&
      c.action !== STORE_ACTIONS.init &&
      c.action !== STORE_ACTIONS.hydrate &&
      c.action !== STORE_ACTIONS.reset
    ) {
      record.dirty = true;
    }
    if (batchDepth === 0 && !scheduled) {
      scheduled = true;
      enqueueMicrotask(onMicrotask);
    }
  }

  /** Microtask entry point: nothing may escape it (an exception here would be uncatchable). */
  function onMicrotask() {
    scheduled = false;
    if (batchDepth > 0) return;
    try {
      flush();
    } catch (e) {
      report(e);
    }
  }

  /** Notifies listeners / observers / events once for every pending change and schedules writes. */
  function flush() {
    if (pending.length === 0) return;
    const changes = pending;
    pending = [];
    const prev = /** @type {State} */ (prevState);
    prevState = null;
    const next = state;
    /** @type {string[]} */
    const touched = [];
    for (const c of changes) if (!touched.includes(c.slice)) touched.push(c.slice);
    /** @type {StateChange} */
    const change = Object.freeze({
      slices: Object.freeze(touched),
      actions: Object.freeze(changes.map((c) => c.action)),
      changes: Object.freeze(changes),
    });

    for (const name of touched) {
      const record = slices.get(name);
      if (record && record.persist && record.dirty) {
        try {
          schedulePersist(record);
        } catch (e) {
          // an injected timer that throws must not take the notification down with it
          warn(`could not schedule the write of slice '${name}'`, {
            error: isSdkError(e) ? e : wrap(e),
          });
        }
      }
    }

    for (const entry of Array.from(listeners)) {
      if (!listeners.has(entry)) continue;
      safeCall(() => entry.fn(next, prev, change));
    }
    for (const sub of Array.from(selected)) {
      if (!selected.has(sub)) continue;
      let value;
      let same;
      try {
        value = sub.selector(next);
        same = sub.equality(value, sub.last);
      } catch (e) {
        report(e);
        continue;
      }
      if (same) continue;
      const last = sub.last;
      sub.last = value;
      safeCall(() => sub.listener(value, last));
    }
    for (const ob of Array.from(observers)) {
      if (ob.closed) continue;
      let value;
      try {
        value = ob.selector(next);
      } catch (e) {
        ob.closed = true;
        observers.delete(ob);
        safeCall(() => {
          if (typeof ob.observer.error === 'function') ob.observer.error(e);
        });
        continue;
      }
      if (Object.is(value, ob.last)) continue;
      ob.last = value;
      safeCall(() => {
        if (typeof ob.observer.next === 'function') ob.observer.next(value);
      });
    }
    for (const c of changes) emit('state:change', { slice: c.slice, action: c.action });
  }

  /**
   * Commit a change to one slice: a partial object is merged shallowly, an updater receives the
   * current slice state and returns the next (structural sharing elsewhere). Nothing happens when the
   * result is identical. Reads see the change synchronously; notification is batched per microtask.
   * Effects: state `slice` · emit `state:change` `{ slice, action }` · storage (if slice persisted, debounced).
   * @param {string} slice
   * @param {object | ((s: any) => any)} updater
   * @param {{ action?: string } & Record<string, unknown>} [meta]  `action` defaults to `<slice>/set`.
   * @returns {void}
   * @throws {ValidationError} on an unknown slice, a bad `meta` (checked before the updater runs), a
   *   bad updater or an updater returning `undefined`
   */
  function set(slice, updater, meta) {
    const record = requireSlice(slice, 'set');
    if (meta !== undefined && (meta === null || typeof meta !== 'object')) {
      throw invalid(`store.set('${record.name}'): meta must be an object`, 'meta');
    }
    const prev = current(record.name);
    let next;
    if (typeof updater === 'function') {
      next = updater(prev);
      if (next === undefined) {
        throw invalid(
          `store.set('${record.name}'): updater must return the next slice state (never mutate in place)`,
          'updater',
          'invalid_return'
        );
      }
    } else if (isPlainObject(updater)) {
      if (!isPlainObject(prev)) {
        next = updater;
      } else {
        let changed = false;
        for (const k of Object.keys(updater)) {
          if (!hasOwn(prev, k) || !Object.is(prev[k], updater[k])) {
            changed = true;
            break;
          }
        }
        if (!changed) return;
        next = { ...prev, ...updater };
      }
    } else {
      throw invalid(
        `store.set('${record.name}'): updater must be a function or a partial object`,
        'updater'
      );
    }
    if (Object.is(next, prev)) return;
    const action =
      meta && typeof meta.action === 'string' && meta.action ? meta.action : `${record.name}/set`;
    commit(record.name, next, action, meta);
  }

  /**
   * Group several `set`s into one notification, delivered synchronously when the outermost batch
   * ends (even when `fn` throws). Effects: as the inner sets.
   * @param {() => void} fn
   * @returns {void}
   */
  function batch(fn) {
    requireFn(fn, 'fn');
    batchDepth += 1;
    try {
      fn();
    } finally {
      batchDepth -= 1;
      if (batchDepth === 0 && !destroyed) flush();
    }
  }

  /**
   * Back to the initial state (all slices when omitted) and drop the persisted copy.
   * Effects: state · storage remove · emit `state:change`.
   * @param {string} [slice]
   * @returns {void}
   */
  function reset(slice) {
    if (slice !== undefined) {
      resetSlice(requireSlice(slice, 'reset'));
      return;
    }
    for (const record of slices.values()) resetSlice(record);
  }

  /** @param {SliceRecord} record */
  function resetSlice(record) {
    clearPersisted(record);
    commit(record.name, record.initial, STORE_ACTIONS.reset, undefined);
  }

  // ── persistence ──

  /** @param {SliceRecord} record */
  function cancelTimer(record) {
    if (record.timer !== null) {
      timers.clearTimeout(record.timer);
      record.timer = null;
    }
  }

  /**
   * The value written for a slice: whole slice or the picked paths, in a versioned envelope.
   * @param {SliceRecord} record @param {ResolvedPersist} p
   * @returns {{ v: number, d: unknown }}
   */
  function envelopeFor(record, p) {
    const value = current(record.name);
    let data = value;
    if (p.pick) {
      data = {};
      for (const path of p.pick) {
        const v = getPath(value, path);
        if (v !== undefined) data = setPath(data, path, v);
      }
    }
    return { v: p.version, d: data };
  }

  /** @param {SliceRecord} record */
  function writeSlice(record) {
    const p = record.persist;
    cancelTimer(record);
    record.dirty = false;
    if (!p) return;
    try {
      storageFor(p.kind).set(p.key, envelopeFor(record, p), p.ttlMs > 0 ? { ttlMs: p.ttlMs } : {});
    } catch (e) {
      warn(`could not persist slice '${record.name}'`, { error: isSdkError(e) ? e : wrap(e) });
    }
  }

  /** @param {SliceRecord} record */
  function schedulePersist(record) {
    const p = record.persist;
    if (!p || destroyed) return;
    if (p.debounceMs <= 0) {
      writeSlice(record);
      return;
    }
    cancelTimer(record);
    record.timer = timers.setTimeout(() => {
      record.timer = null;
      if (record.dirty) writeSlice(record);
    }, p.debounceMs);
  }

  /** Cancels pending writes and removes the stored copy. @param {SliceRecord} record */
  function clearPersisted(record) {
    const p = record.persist;
    cancelTimer(record);
    record.dirty = false;
    if (!p) return;
    try {
      storageFor(p.kind).remove(p.key);
    } catch (e) {
      warn(`could not clear persisted slice '${record.name}'`, {
        error: isSdkError(e) ? e : wrap(e),
      });
    }
  }

  /**
   * Merges stored data into the current slice state: picked paths only when `pick` is set, else a
   * shallow merge over the current object (so fields added since survive), else a replacement.
   * @param {unknown} current @param {unknown} data @param {string[] | null} pick
   * @returns {unknown}
   */
  function mergePersisted(current, data, pick) {
    if (pick) {
      if (!isPlainObject(data)) return current;
      let next = current;
      for (const path of pick) {
        const v = getPath(data, path);
        if (v !== undefined) next = setPath(/** @type {any} */ (next), path, v);
      }
      return next;
    }
    if (isPlainObject(current) && isPlainObject(data)) return { ...current, ...data };
    return data;
  }

  /**
   * Reads the persisted copy of a slice into the state. Version mismatches go through `migrate`
   * (or drop the data); corrupt data, data of another shape than the slice and throwing migrations
   * are logged and dropped. A write still pending for the slice is cancelled only when stored data
   * actually replaces the slice (it is obsolete then); otherwise it is left to go through, so an
   * explicit `persist.hydrate()` on an empty storage never loses a local change.
   * @param {SliceRecord} record
   * @returns {boolean} whether the state changed
   */
  function hydrateSlice(record) {
    const p = record.persist;
    if (!p) return false;
    const storage = storageFor(p.kind);
    let stored;
    try {
      stored = storage.get(p.key);
    } catch (e) {
      warn(`could not read persisted slice '${record.name}'`, {
        error: isSdkError(e) ? e : wrap(e),
      });
      return false;
    }
    if (stored === undefined || stored === null) return false;
    let data;
    let version;
    if (isEnvelope(stored)) {
      data = stored.d;
      version = stored.v;
    } else {
      data = stored;
      version = 0;
    }
    if (version !== p.version) {
      if (!p.migrate) {
        drop(record, storage, p, `stored version ${version} does not match ${p.version}`);
        return false;
      }
      try {
        data = p.migrate(data, version);
      } catch (e) {
        drop(record, storage, p, 'migrate threw', isSdkError(e) ? e : wrap(e));
        return false;
      }
      if (data === undefined) {
        drop(record, storage, p, 'migrate returned undefined');
        return false;
      }
    }
    const value = current(record.name);
    if (!compatible(value, data, p.pick)) {
      drop(record, storage, p, 'stored data does not match the shape of the slice');
      return false;
    }
    const next = mergePersisted(value, data, p.pick);
    if (Object.is(next, value)) return false;
    cancelTimer(record);
    record.dirty = false;
    commit(record.name, next, STORE_ACTIONS.hydrate, undefined);
    return true;
  }

  /**
   * @param {SliceRecord} record @param {StorageLike} storage @param {ResolvedPersist} p
   * @param {string} why @param {unknown} [error]
   */
  function drop(record, storage, p, why, error) {
    warn(`dropped persisted slice '${record.name}': ${why}`, error ? { error } : undefined);
    try {
      storage.remove(p.key);
    } catch {
      // best effort
    }
  }

  /**
   * Writes are synchronous; the Promise shape is the documented contract, so errors reject and are
   * never thrown synchronously out of `flush()` / `hydrate()`.
   * @type {StorePersist}
   */
  const persist = {
    flush() {
      try {
        for (const record of slices.values()) {
          if (record.persist && (record.dirty || record.timer !== null)) writeSlice(record);
        }
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    },
    hydrate(slice) {
      try {
        if (slice !== undefined) hydrateSlice(requireSlice(slice, 'persist.hydrate'));
        else for (const record of slices.values()) hydrateSlice(record);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    },
    clear(slice) {
      if (slice !== undefined) clearPersisted(requireSlice(slice, 'persist.clear'));
      else for (const record of slices.values()) clearPersisted(record);
    },
  };

  // ── reads ──

  /** @returns {State} */
  function getState() {
    return state;
  }

  /**
   * Synchronous read by path (`get('search.filters.stops')`); the whole state without a path.
   * @param {string | Array<string|number>} [path]
   * @returns {unknown}
   */
  function get(path) {
    if (path === undefined) return state;
    if (typeof path !== 'string' && !Array.isArray(path)) {
      throw invalid('store.get: path must be a string or an array of segments', 'path');
    }
    return getPath(state, path);
  }

  /**
   * Memoised read: the selector runs once per state reference, and `equality` (default `Object.is`)
   * keeps the previous result when the new one is equal. Effects: none.
   * @template T
   * @param {(state: State) => T} selector
   * @param {(a: T, b: T) => boolean} [equality]
   * @returns {T}
   */
  function select(selector, equality = Object.is) {
    requireFn(selector, 'selector');
    requireFn(equality, 'equality');
    const cached = selectCache.get(selector);
    if (cached && cached.state === state) return /** @type {T} */ (cached.value);
    const value = selector(state);
    if (cached && equality(/** @type {T} */ (cached.value), value)) {
      cached.state = state;
      return /** @type {T} */ (cached.value);
    }
    selectCache.set(selector, { state, value });
    return value;
  }

  // ── subscriptions ──

  /**
   * Plain form `subscribe(listener, { fireImmediately? })`: called after each batched commit with
   * `(state, prev, change)`. Selector form `subscribe(selector, listener, { equality?,
   * fireImmediately? })`: called with `(value, prev)` only when the selected value changes.
   * Returns an idempotent `off()`. Effects: none.
   * @param {Listener | Selector} a
   * @param {SelectorListener | { fireImmediately?: boolean }} [b]
   * @param {SubscribeOptions} [c]
   * @returns {() => void}
   */
  function subscribe(a, b, c) {
    if (typeof b === 'function') {
      return subscribeSelector(/** @type {Selector} */ (a), b, c);
    }
    return subscribeAll(/** @type {Listener} */ (a), b);
  }

  /**
   * @param {Listener} listener @param {{ fireImmediately?: boolean } | undefined} options
   * @returns {() => void}
   */
  function subscribeAll(listener, options) {
    requireFn(listener, 'listener');
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw invalid('store.subscribe: options must be an object', 'options');
    }
    if (destroyed) return () => {};
    const entry = { fn: listener };
    listeners.add(entry);
    if (options && options.fireImmediately) listener(state, undefined, undefined);
    return () => {
      listeners.delete(entry);
    };
  }

  /**
   * @param {Selector} selector @param {SelectorListener} listener @param {SubscribeOptions | undefined} options
   * @returns {() => void}
   */
  function subscribeSelector(selector, listener, options) {
    requireFn(selector, 'selector');
    requireFn(listener, 'listener');
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw invalid('store.subscribe: options must be an object', 'options');
    }
    const equality = options && options.equality !== undefined ? options.equality : Object.is;
    requireFn(equality, 'equality');
    if (destroyed) return () => {};
    const sub = { selector, listener, equality, last: selector(state) };
    selected.add(sub);
    if (options && options.fireImmediately) listener(sub.last, undefined);
    return () => {
      selected.delete(sub);
    };
  }

  /** `useSyncExternalStore` snapshot: the same reference until a commit. @returns {State} */
  function getSnapshot() {
    return state;
  }

  /**
   * TC39 / RxJS observable over the (selected) state: emits the current value on subscribe and then
   * on every change of the selected value (`Object.is`); completes on `destroy()`; a throwing selector
   * errors the observer. `subscribe` takes an observer object or the positional `(next?, error?,
   * complete?)` functions; a throwing `next` is reported like a listener fault, never thrown back.
   * Exposes `Symbol.observable` when the runtime defines it (and `'@@observable'`), so RxJS `from()`,
   * Vue `from()`, the Angular `async` pipe and Svelte's store contract accept it. Effects: none.
   * @param {Selector} [selector]
   * @returns {Observable}
   */
  function toObservable(selector) {
    const sel =
      selector === undefined ? (s) => s : /** @type {Selector} */ (requireFn(selector, 'selector'));
    /** @type {Observable & Record<string | symbol, unknown>} */
    const observable = {
      subscribe(observerOrNext, error, complete) {
        const observer = toObserver(observerOrNext, error, complete);
        if (destroyed) {
          if (typeof observer.complete === 'function') observer.complete();
          return { unsubscribe() {}, closed: true };
        }
        let value;
        try {
          value = sel(state);
        } catch (e) {
          if (typeof observer.error === 'function') observer.error(e);
          return { unsubscribe() {}, closed: true };
        }
        const entry = { selector: sel, observer, last: value, closed: false };
        observers.add(entry);
        /** @type {Subscription} */
        const subscription = {
          get closed() {
            return entry.closed;
          },
          unsubscribe() {
            entry.closed = true;
            observers.delete(entry);
          },
        };
        if (typeof observer.next === 'function') {
          const first = value;
          safeCall(() => observer.next(first));
        }
        return subscription;
      },
    };
    observable['@@observable'] = () => observable;
    const sym = observableSymbol();
    if (sym) observable[sym] = () => observable;
    return observable;
  }

  // ── middleware ──

  /**
   * Wrap every commit (logging, analytics, devtools). Returns `off()`. Effects: none.
   * @param {Middleware} middleware
   * @returns {() => void}
   */
  function use(middleware) {
    requireFn(middleware, 'middleware');
    middlewares.push(middleware);
    return () => {
      const i = middlewares.indexOf(middleware);
      if (i !== -1) middlewares.splice(i, 1);
    };
  }

  // ── snapshot / restore ──

  /**
   * Serialisable deep copy of every non‑`secret` slice. Effects: none.
   * @returns {StoreSnapshot}
   */
  function snapshot() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, record] of slices) {
      if (!record.secret) out[name] = clone(state[name]);
    }
    return { version: SNAPSHOT_VERSION, at: now(), slices: out };
  }

  /**
   * Apply a snapshot: each non‑`secret` slice is merged over its initial value; slices not registered
   * yet are applied when they register. Values are deep‑copied, so the caller's snapshot is never
   * aliased by the state; a value whose shape does not match the slice's initial value (an object
   * slice given a string, an array slice given an object) and unusable slice names are ignored with a
   * warning. Effects: state (restore) · emit `state:change`.
   * @param {StoreSnapshot | { slices: Record<string, unknown> }} snap
   * @returns {void}
   * @throws {ValidationError} when `snap` is not `{ slices: object }`
   */
  function restore(snap) {
    if (!snap || typeof snap !== 'object' || !isPlainObject(snap.slices)) {
      throw invalid('store.restore: snapshot must be an object with a slices map', 'snapshot');
    }
    for (const [name, value] of Object.entries(snap.slices)) {
      if (!isValidName(name)) {
        warn(`ignored snapshot slice '${name}': unusable slice name`, undefined);
        continue;
      }
      const copy = clone(value);
      const record = slices.get(name);
      if (!record) {
        pendingRestore.set(name, copy);
        continue;
      }
      if (record.secret) continue;
      applyRestore(record, copy);
    }
  }

  /** @param {SliceRecord} record @param {unknown} value */
  function applyRestore(record, value) {
    if (!compatible(record.initial, value, null)) {
      warn(`ignored snapshot slice '${record.name}': value does not match the shape of the slice`, {
        received: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
      });
      return;
    }
    const next =
      isPlainObject(record.initial) && isPlainObject(value)
        ? { ...record.initial, ...value }
        : value;
    commit(record.name, next, STORE_ACTIONS.restore, undefined);
  }

  // ── lifecycle ──

  /**
   * Flush persistence, cancel its timers, drop every listener / subscription and complete observers.
   * Reads keep working; later writes update the state silently. Effects: storage flush · listeners cleared.
   * @returns {void}
   */
  function destroy() {
    if (destroyed) return;
    persist.flush().catch(() => {
      // writes never throw (they are logged); nothing can be done at teardown anyway
    });
    destroyed = true;
    for (const record of slices.values()) cancelTimer(record);
    listeners.clear();
    selected.clear();
    const open = Array.from(observers);
    observers.clear();
    for (const ob of open) {
      ob.closed = true;
      safeCall(() => {
        if (typeof ob.observer.complete === 'function') ob.observer.complete();
      });
    }
    pending = [];
    prevState = null;
    pendingRestore.clear();
  }

  // ── install options ──

  if (opts.middleware) for (const m of opts.middleware) use(m);
  if (opts.slices) {
    for (const [name, sliceOptions] of Object.entries(opts.slices))
      registerSlice(name, sliceOptions);
  }

  return {
    getState,
    get,
    select,
    subscribe,
    set,
    batch,
    reset,
    registerSlice,
    hasSlice,
    use,
    persist,
    snapshot,
    restore,
    getSnapshot,
    toObservable,
    destroy,
  };
}

// ── selectors ───────────────────────────────────────────────────────────────────────────────────

/**
 * Compose a memoised selector (reselect‑style): `inputs` run on every call, `combiner` only when one
 * of their results changed (`Object.is`, last‑arguments memo). Inputs may also be passed as one
 * array. The selector exposes `resultFunc`, `dependencies`, `recomputations()` and
 * `resetRecomputations()`. Effects: none.
 * @param {...Function} args  `...inputs, combiner`
 * @returns {((...args: any[]) => any) & { resultFunc: Function, dependencies: Function[], recomputations: () => number, resetRecomputations: () => void }}
 * @throws {ValidationError} without inputs or when any argument is not a function
 */
export function createSelector(...args) {
  const combiner = args[args.length - 1];
  let inputs = args.slice(0, -1);
  if (inputs.length === 1 && Array.isArray(inputs[0])) inputs = inputs[0];
  if (typeof combiner !== 'function') {
    throw invalid('createSelector: the last argument must be a combiner function', 'combiner');
  }
  if (inputs.length === 0) {
    throw invalid('createSelector: at least one input selector is required', 'inputs', 'required');
  }
  inputs.forEach((fn, i) => {
    if (typeof fn !== 'function') {
      throw invalid(`createSelector: input selector ${i} is not a function`, `inputs[${i}]`);
    }
  });
  /** @type {unknown[] | null} */
  let lastArgs = null;
  /** @type {unknown} */
  let lastResult;
  let recomputations = 0;

  /** @param {...any} rest */
  function selector(...rest) {
    const values = inputs.map((fn) => fn(...rest));
    if (
      lastArgs &&
      lastArgs.length === values.length &&
      values.every((v, i) => Object.is(v, lastArgs[i]))
    ) {
      return lastResult;
    }
    lastResult = combiner(...values);
    lastArgs = values;
    recomputations += 1;
    return lastResult;
  }
  selector.resultFunc = combiner;
  selector.dependencies = inputs.slice();
  selector.recomputations = () => recomputations;
  selector.resetRecomputations = () => {
    recomputations = 0;
  };
  return selector;
}
