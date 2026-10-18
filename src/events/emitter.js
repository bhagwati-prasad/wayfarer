/**
 * Event bus for the Wayfarer SDK (docs/api/02-state-events-errors.md §2): `createEmitter` returns an
 * `Emitter` with `on` / `once` / `off` / `emit` / `waitFor` / `listenerCount` / `clear`. Listeners
 * subscribe to exact names (`'search:start'`), namespace wildcards (`'search:*'` — every event whose
 * name begins with `search:`) or `'*'` (everything), and run synchronously in registration order.
 * The emitter owns the payload envelope of docs/README.md §6: every listener receives
 * `{ type, at, ...data }`, where `type` is the emitted name and `at` comes from the injectable
 * `now()` clock (default `Date.now`). A throwing listener never breaks `emit`: the exception is
 * wrapped into an `SdkError` and re‑emitted as `'error'` `{ error, event }`; an `'error'` listener
 * that throws is logged through the optional `logger` and dropped, so fan‑out can never recurse
 * forever. `waitFor` resolves with the next matching payload and rejects with `TimeoutError`
 * (`timeoutMs`) or `AbortError` (`signal`, or `clear()` with `reason: 'cleared'`), releasing its
 * listener, timer and abort hook as soon as it settles. This module must not touch `window`,
 * `document`, `navigator` or storage, must not keep module‑level mutable state, must not log outside
 * the injected logger, and must never throw a plain `Error` (only `ConfigError` for bad factory
 * options and `ValidationError` for bad arguments).
 */

import {
  AbortError,
  ConfigError,
  TimeoutError,
  ValidationError,
  isSdkError,
  wrap,
} from '../errors/index.js';

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../errors/index.js').SdkError} SdkError */

/**
 * What every listener receives: the emitted name as `type`, the clock reading as `at`, and the
 * caller's data spread on top. A plain‑object payload contributes its own enumerable fields; an
 * `Error` payload is carried as `error`; any other value (primitive, array, class instance) is
 * carried as `data`.
 * @typedef {{ type: string, at: number } & Record<string, unknown>} EventPayload
 */

/**
 * Listener signature. The event name is `payload.type`, so wildcard listeners can tell events apart.
 * @typedef {(payload: EventPayload) => void} Listener
 */

/**
 * Removes the subscription(s) made by the `on` / `once` call that returned it. Idempotent.
 * @typedef {() => void} Off
 */

/**
 * Subset of `Logger` (`utils/logger.js`) the emitter writes to when it has to drop an exception:
 * `error` is preferred, `warn` is the fallback; a logger with neither is a silent sink.
 * @typedef {{ error?: (msg: string, data?: unknown) => void, warn?: (msg: string, data?: unknown) => void }} EmitterLogger
 */

/**
 * @typedef {Object} EmitterOptions
 * @property {EmitterLogger} [logger]  Receives listener exceptions that cannot be re‑emitted.
 * @property {() => number} [now]      Clock for `payload.at` (ms). Defaults to `Date.now`.
 */

/**
 * @typedef {Object} WaitForOptions
 * @property {number} [timeoutMs]  Reject with `TimeoutError{ timeoutMs }` when no matching event
 *   arrives in time. `undefined` / `Infinity` = wait forever.
 * @property {(payload: EventPayload) => boolean} [filter]  Only a payload for which this returns
 *   truthy settles the wait; a throwing filter rejects the wait with the wrapped exception.
 * @property {AbortSignal} [signal]  Reject with `AbortError` when aborted (immediately when it
 *   already is). An `SdkError` used as the abort `reason` is rethrown as is.
 */

/**
 * @typedef {Object} Emitter
 * @property {(event: string | string[], fn: Listener) => Off} on  Subscribe to one or several
 *   exact names / wildcards (`'ns:*'`, `'*'`). The returned `off` removes every subscription made by
 *   the call.
 * @property {(event: string | string[], fn: Listener) => Off} once  Like `on`, but the listener
 *   runs at most once in total and is removed before it runs.
 * @property {(event: string | string[], fn?: Listener) => void} off  Remove `fn` from the given
 *   name(s) / pattern(s), or every listener registered under them when `fn` is omitted.
 * @property {(event: string, payload?: unknown) => void} emit  Synchronous fan‑out of
 *   `{ type, at, ...payload }` to exact, namespace and `'*'` listeners in registration order.
 * @property {(event: string | string[], options?: WaitForOptions) => Promise<EventPayload>} waitFor
 *   Resolve with the next matching payload.
 * @property {(event?: string) => number} listenerCount  Without an argument, every listener; for a
 *   plain name, every listener that would receive it (exact + namespace + `'*'`); for a wildcard
 *   pattern, the listeners registered under exactly that pattern.
 * @property {() => void} clear  Drop every listener and reject every pending `waitFor` with
 *   `AbortError{ reason: 'cleared' }`, clearing their timers.
 */

/**
 * One registration: a listener bound to one pattern.
 * @typedef {Object} Entry
 * @property {Listener} fn        The function `emit` calls (already wrapped for `once`).
 * @property {Listener} original  The listener the caller passed (what `off(event, fn)` compares).
 * @property {string} pattern     Pattern key the entry lives under.
 * @property {boolean} active     `false` once removed; a snapshot taken mid‑emit skips it.
 * @property {number} seq         Registration order across every pattern.
 */

/**
 * One pending `waitFor`, kept so `clear()` can settle it.
 * @typedef {{ cancel: (error: SdkError) => void }} Waiter
 */

const ALL = '*';
const NS_SUFFIX = ':*';

// ── validation ──────────────────────────────────────────────────────────────────────────────────

/**
 * Build a `ValidationError` carrying one issue.
 * @param {string} path
 * @param {string} code
 * @param {string} message
 * @returns {ValidationError}
 */
function invalid(path, code, message) {
  /** @type {ValidationIssue[]} */
  const issues = [{ path, code, message }];
  return new ValidationError(message, { issues });
}

/**
 * Whether `name` is a usable event / pattern string (non‑empty, not only whitespace).
 * @param {unknown} name
 * @returns {name is string}
 */
function isName(name) {
  return typeof name === 'string' && name.trim() !== '';
}

/**
 * Validate a subscription pattern: an exact name, `'ns:*'` or `'*'`. Any other use of `*` is a
 * mistake the caller should hear about.
 * @param {unknown} pattern
 * @param {string} path
 * @returns {string}
 */
function assertPattern(pattern, path) {
  if (!isName(pattern)) {
    throw invalid(path, 'type', `${path} must be a non-empty event name`);
  }
  if (pattern.includes('*') && pattern !== ALL) {
    const star = pattern.indexOf('*');
    if (!pattern.endsWith(NS_SUFFIX) || star !== pattern.length - 1 || pattern === NS_SUFFIX) {
      throw invalid(
        path,
        'pattern',
        `${path} may only use a wildcard as '*' or as a namespace suffix ('search:*'), got '${pattern}'`
      );
    }
  }
  return pattern;
}

/**
 * Normalise `event` (string or array of strings) to a de‑duplicated list of validated patterns.
 * @param {unknown} event
 * @param {string} path
 * @returns {string[]}
 */
function assertPatterns(event, path) {
  if (Array.isArray(event)) {
    if (event.length === 0) throw invalid(path, 'required', `${path} must list at least one event`);
    /** @type {string[]} */
    const out = [];
    event.forEach((e, i) => {
      const p = assertPattern(e, `${path}[${i}]`);
      if (!out.includes(p)) out.push(p);
    });
    return out;
  }
  return [assertPattern(event, path)];
}

/**
 * Validate a name given to `emit`: a concrete event, never a pattern.
 * @param {unknown} event
 * @returns {string}
 */
function assertEventName(event) {
  if (!isName(event)) throw invalid('event', 'type', 'event must be a non-empty event name');
  if (event.includes('*')) {
    throw invalid('event', 'pattern', `cannot emit a wildcard pattern ('${event}')`);
  }
  return event;
}

/**
 * @param {unknown} fn
 * @param {string} path
 * @returns {Listener}
 */
function assertListener(fn, path) {
  if (typeof fn !== 'function') throw invalid(path, 'type', `${path} must be a function`);
  return /** @type {Listener} */ (fn);
}

/**
 * Validate `waitFor` options; returns the parsed timeout (`Infinity` = none).
 * @param {unknown} options
 * @returns {{ timeoutMs: number, filter?: (payload: EventPayload) => boolean, signal?: AbortSignal }}
 */
function assertWaitForOptions(options) {
  if (options === undefined || options === null) return { timeoutMs: Infinity };
  if (typeof options !== 'object') {
    throw invalid('options', 'type', 'options must be an object');
  }
  const o = /** @type {Record<string, unknown>} */ (options);
  let timeoutMs = Infinity;
  if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
    const n = o.timeoutMs;
    if (typeof n !== 'number' || Number.isNaN(n) || n < 0) {
      throw invalid(
        'options.timeoutMs',
        'range',
        'options.timeoutMs must be a non-negative number of milliseconds'
      );
    }
    timeoutMs = n;
  }
  /** @type {((payload: EventPayload) => boolean) | undefined} */
  let filter;
  if (o.filter !== undefined && o.filter !== null) {
    if (typeof o.filter !== 'function') {
      throw invalid('options.filter', 'type', 'options.filter must be a function');
    }
    filter = /** @type {(payload: EventPayload) => boolean} */ (o.filter);
  }
  /** @type {AbortSignal | undefined} */
  let signal;
  if (o.signal !== undefined && o.signal !== null) {
    const s = /** @type {any} */ (o.signal);
    if (
      typeof s !== 'object' ||
      typeof s.aborted !== 'boolean' ||
      typeof s.addEventListener !== 'function' ||
      typeof s.removeEventListener !== 'function'
    ) {
      throw invalid('options.signal', 'type', 'options.signal must be an AbortSignal');
    }
    signal = s;
  }
  return { timeoutMs, filter, signal };
}

// ── payload envelope ────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Build the `{ type, at, ...data }` envelope (see `EventPayload`). `type` and `at` are always the
 * emitter's: same‑named fields in `payload` are overwritten.
 * @param {string} type
 * @param {unknown} payload
 * @param {number} at
 * @returns {EventPayload}
 */
function envelope(type, payload, at) {
  /** @type {Record<string, unknown>} */
  let data;
  if (payload === undefined) data = {};
  else if (isPlainObject(payload)) data = payload;
  else if (payload instanceof Error) data = { error: payload };
  else data = { data: payload };
  return /** @type {EventPayload} */ ({ ...data, type, at });
}

/**
 * `AbortError` for an aborted signal: an `SdkError` reason is passed through, a string reason
 * becomes `reason`, anything else becomes `cause`.
 * @param {AbortSignal} signal
 * @param {string} [fallbackReason='aborted']
 * @returns {SdkError}
 */
function abortErrorFrom(signal, fallbackReason = 'aborted') {
  const reason = /** @type {unknown} */ (signal.reason);
  if (isSdkError(reason)) return /** @type {SdkError} */ (reason);
  /** @type {{ reason: string, cause?: unknown }} */
  const options = { reason: typeof reason === 'string' && reason ? reason : fallbackReason };
  if (reason !== undefined) options.cause = reason;
  return new AbortError('Operation aborted', options);
}

// ── factory ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create an event emitter. `logger` (optional, `{ error?, warn? }`) receives listener exceptions
 * that cannot be re‑emitted as `'error'`; `now` (optional, default `Date.now`) stamps `payload.at`.
 * Effects: none.
 * @param {EmitterOptions} [options]
 * @returns {Emitter}
 * @throws {ConfigError} when `options`, `options.logger` or `options.now` has the wrong type.
 */
export function createEmitter(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createEmitter: options must be an object');
  }
  if (options.now !== undefined && options.now !== null && typeof options.now !== 'function') {
    throw new ConfigError('createEmitter: now must be a function returning milliseconds');
  }
  if (
    options.logger !== undefined &&
    options.logger !== null &&
    (typeof options.logger !== 'object' || Array.isArray(options.logger))
  ) {
    throw new ConfigError('createEmitter: logger must be an object with error()/warn()');
  }
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const logger = options.logger || undefined;

  /** @type {Map<string, Set<Entry>>} */
  const byPattern = new Map();
  /** @type {Set<Waiter>} */
  const waiters = new Set();
  let seq = 0;

  /** @returns {number} */
  function readClock() {
    let at;
    try {
      at = clock();
    } catch {
      at = undefined;
    }
    return typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
  }

  /**
   * Write a dropped exception to the logger, if any. Never throws.
   * @param {string} msg
   * @param {unknown} data
   */
  function log(msg, data) {
    if (!logger) return;
    const fn =
      typeof logger.error === 'function'
        ? logger.error
        : typeof logger.warn === 'function'
          ? logger.warn
          : undefined;
    if (!fn) return;
    try {
      fn.call(logger, `events: ${msg}`, data);
    } catch {
      // A failing logger must never break the emitter.
    }
  }

  /**
   * @param {string} pattern
   * @param {Listener} fn
   * @param {Listener} original
   * @returns {Entry}
   */
  function add(pattern, fn, original) {
    /** @type {Entry} */
    const entry = { fn, original, pattern, active: true, seq: seq++ };
    let set = byPattern.get(pattern);
    if (!set) {
      set = new Set();
      byPattern.set(pattern, set);
    }
    set.add(entry);
    return entry;
  }

  /** @param {Entry} entry */
  function remove(entry) {
    if (!entry.active) return;
    entry.active = false;
    const set = byPattern.get(entry.pattern);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) byPattern.delete(entry.pattern);
  }

  /**
   * Every active entry that receives `type`, in registration order.
   * @param {string} type
   * @returns {Entry[]}
   */
  function matching(type) {
    /** @type {Entry[]} */
    const out = [];
    /** @param {string} key */
    const collect = (key) => {
      const set = byPattern.get(key);
      if (set) for (const entry of set) out.push(entry);
    };
    collect(type);
    for (let i = type.indexOf(':'); i !== -1; i = type.indexOf(':', i + 1)) {
      collect(type.slice(0, i) + NS_SUFFIX);
    }
    collect(ALL);
    return out.length > 1 ? out.sort((a, b) => a.seq - b.seq) : out;
  }

  /**
   * Subscribe `original` under `patterns`, optionally once in total.
   * @param {string[]} patterns
   * @param {Listener} original
   * @param {boolean} once
   * @returns {Off}
   */
  function subscribe(patterns, original, once) {
    /** @type {Entry[]} */
    const entries = [];
    const off = () => {
      for (const entry of entries) remove(entry);
    };
    /** @type {Listener} */
    const fn = once
      ? (payload) => {
          off();
          original(payload);
        }
      : original;
    for (const pattern of patterns) entries.push(add(pattern, fn, original));
    return off;
  }

  // ── public api ────────────────────────────────────────────────────────────────────────────────

  /** @type {Emitter['on']} */
  function on(event, fn) {
    const patterns = assertPatterns(event, 'event');
    return subscribe(patterns, assertListener(fn, 'fn'), false);
  }

  /** @type {Emitter['once']} */
  function once(event, fn) {
    const patterns = assertPatterns(event, 'event');
    return subscribe(patterns, assertListener(fn, 'fn'), true);
  }

  /** @type {Emitter['off']} */
  function off(event, fn) {
    const patterns = assertPatterns(event, 'event');
    if (fn !== undefined && fn !== null) assertListener(fn, 'fn');
    for (const pattern of patterns) {
      const set = byPattern.get(pattern);
      if (!set) continue;
      for (const entry of Array.from(set)) {
        if (fn === undefined || fn === null || entry.original === fn) remove(entry);
      }
    }
  }

  /** @type {Emitter['emit']} */
  function emit(event, payload) {
    const type = assertEventName(event);
    const entries = matching(type);
    if (entries.length === 0) {
      if (type === 'error') log('unhandled error event', payload);
      return;
    }
    const message = envelope(type, payload, readClock());
    for (const entry of entries) {
      if (!entry.active) continue;
      try {
        entry.fn(message);
      } catch (e) {
        const error = wrap(e);
        if (type === 'error') {
          // An 'error' listener threw: re-emitting would recurse, so log and drop.
          log("listener for 'error' threw; dropped", { event: message.event, error });
        } else {
          emit('error', { error, event: type });
        }
      }
    }
  }

  /** @type {Emitter['waitFor']} */
  function waitFor(event, options) {
    return new Promise((resolve, reject) => {
      /** @type {string[]} */
      let patterns;
      /** @type {ReturnType<typeof assertWaitForOptions>} */
      let opts;
      try {
        patterns = assertPatterns(event, 'event');
        opts = assertWaitForOptions(options);
      } catch (e) {
        reject(e);
        return;
      }
      const { timeoutMs, filter, signal } = opts;
      if (signal?.aborted) {
        reject(abortErrorFrom(signal));
        return;
      }

      let settled = false;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timer = null;
      /** @type {Off} */
      let unsubscribe = () => {};
      /** @type {Waiter} */
      const waiter = { cancel: (error) => finish(() => reject(error)) };

      /** @param {() => void} settle */
      const finish = (settle) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (signal) signal.removeEventListener('abort', onAbort);
        waiters.delete(waiter);
        settle();
      };
      const onAbort = () => {
        finish(() => reject(abortErrorFrom(/** @type {AbortSignal} */ (signal))));
      };

      unsubscribe = subscribe(
        patterns,
        (payload) => {
          let accepted;
          try {
            accepted = filter ? Boolean(filter(payload)) : true;
          } catch (e) {
            finish(() => reject(wrap(e)));
            return;
          }
          if (accepted) finish(() => resolve(payload));
        },
        false
      );
      waiters.add(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          timer = null;
          const label = patterns.length === 1 ? patterns[0] : patterns.join(', ');
          finish(() =>
            reject(
              new TimeoutError(`waitFor('${label}') timed out after ${timeoutMs} ms`, { timeoutMs })
            )
          );
        }, timeoutMs);
      }
    });
  }

  /** @type {Emitter['listenerCount']} */
  function listenerCount(event) {
    if (event === undefined || event === null) {
      let total = 0;
      for (const set of byPattern.values()) total += set.size;
      return total;
    }
    const pattern = assertPattern(event, 'event');
    if (pattern === ALL || pattern.endsWith(NS_SUFFIX)) {
      const set = byPattern.get(pattern);
      return set ? set.size : 0;
    }
    return matching(pattern).length;
  }

  /** @type {Emitter['clear']} */
  function clear() {
    for (const waiter of Array.from(waiters)) {
      waiter.cancel(new AbortError('Emitter cleared while waiting', { reason: 'cleared' }));
    }
    waiters.clear();
    for (const set of byPattern.values()) {
      for (const entry of set) entry.active = false;
    }
    byPattern.clear();
  }

  return { on, once, off, emit, waitFor, listenerCount, clear };
}
