/**
 * Async / timing utilities (docs/api/03-utils.md §5): `debounce`, `throttle`, `singleFlight`, `retry`
 * (exponential backoff), `poll` (honours `{ retryAfterMs }`), `withTimeout`, `sleep`, `deferred`,
 * `combineSignals`, `timeoutSignal`, `isAbort`, `createQueue`, `onceAsync` and `memoAsync`. Everything is
 * pure apart from the timers it starts, and every timer is cleared by the matching `cancel()` / abort /
 * settle, so nothing lingers after `destroy()`. Timer delays are clamped to `2^31 − 1` ms because the
 * platform silently turns anything larger into ~1 ms. SSR‑safe: only the `setTimeout` / `clearTimeout` /
 * `AbortController` / `AbortSignal` / `Date` globals are used, never `window`, `document` or storage; no
 * module‑level mutable state; no logging. Rejections are always `SdkError` subclasses from
 * `../errors/index.js` (`AbortError`, `TimeoutError`, `ValidationError`); errors thrown by user callbacks
 * pass through untouched, and nothing that returns a promise ever throws synchronously at call time.
 */

import { AbortError, TimeoutError, ValidationError, isSdkError } from '../errors/index.js';

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../errors/index.js').SdkError} SdkError */

/**
 * Function returned by `debounce` / `throttle`.
 * @template {(...args: any[]) => any} F
 * @typedef {((...args: Parameters<F>) => ReturnType<F> | undefined) & {
 *   cancel: () => void,
 *   flush: () => ReturnType<F> | undefined,
 *   pending: () => boolean,
 * }} DebouncedFunction
 */

/**
 * @typedef {Object} DebounceOptions
 * @property {boolean} [leading=false]  Invoke on the leading edge of a quiet window.
 * @property {boolean} [trailing=true]  Invoke on the trailing edge with the last arguments.
 * @property {number} [maxWait]         Never wait longer than this for a trailing invocation while calls
 *                                      keep arriving.
 */

/**
 * @typedef {boolean | 'full' | 'equal' | 'none' | ((delayMs: number, attempt: number) => number)} Jitter
 * `true` / `'full'` = random in `[0, delay]`, `'equal'` = `delay/2 + random(delay/2)`, `false` / `'none'` =
 * exact delay, a function computes the delay itself.
 */

/**
 * @typedef {Object} RetryOptions
 * @property {number} [retries=3]    Maximum number of retries after the first attempt.
 * @property {number} [baseMs=300]   Delay before the first retry.
 * @property {number} [maxMs=10000]  Upper bound of a single delay (also caps `retryAfterMs`).
 * @property {number} [factor=2]     Exponential growth factor.
 * @property {Jitter} [jitter=true]  Randomisation strategy.
 * @property {(err: unknown, attempt: number) => boolean | Promise<boolean>} [retryOn]
 *   Decide whether a failed attempt is retried. Default: never on aborts; `SdkError`s follow their own
 *   `retryable` flag; anything else is retried.
 * @property {AbortSignal} [signal]  Abort the whole operation (rejects with `AbortError`).
 * @property {(err: unknown, attempt: number, delayMs: number) => void} [onRetry]
 *   Observer called before each wait.
 */

/**
 * @typedef {Object} PollOptions
 * @property {number} [intervalMs=1000]        Delay between two attempts.
 * @property {number} [maxIntervalMs]          Cap of a single delay (also caps `retryAfterMs`).
 * @property {boolean|number} [backoff]        `true` (= ×2) or a factor ≥ 1: grow the interval exponentially.
 * @property {(result: any, attempt: number) => boolean} until  Stop (resolve) when this returns truthy.
 * @property {number} [maxAttempts]            Reject with `TimeoutError{code:'POLL_EXHAUSTED'}` after this many.
 * @property {number} [maxMs]                  Reject with `TimeoutError` once this much time has elapsed.
 * @property {AbortSignal} [signal]            Abort (rejects with `AbortError`).
 * @property {(result: any, info: { attempt: number, elapsedMs: number, nextDelayMs: number | null }) => void} [onTick]
 *   Observer called after every attempt; `nextDelayMs` is `null` when no further attempt follows (done,
 *   or `maxAttempts` reached).
 */

/**
 * @template T
 * @typedef {Promise<T> & { cancel: (reason?: string) => void }} CancelablePromise
 */

/**
 * @template T
 * @typedef {Object} Deferred
 * @property {Promise<T>} promise
 * @property {(value: T | PromiseLike<T>) => void} resolve
 * @property {(reason?: unknown) => void} reject
 * @property {'pending'|'resolved'|'rejected'} status  Which of `resolve` / `reject` was called.
 * @property {boolean} settled                          `status !== 'pending'`.
 */

/**
 * @typedef {Object} Queue
 * @property {<T>(fn: (ctx: { signal?: AbortSignal }) => T | Promise<T>, opts?: { signal?: AbortSignal }) => Promise<T>} add
 *   Enqueue a task; resolves / rejects with the task's outcome.
 * @property {number} size      Tasks waiting to start.
 * @property {number} pending   Tasks currently running.
 * @property {() => Promise<void>} onIdle   Resolves when nothing is queued or running.
 * @property {(reason?: string) => void} clear  Reject every waiting task with `AbortError`.
 */

// ── internal helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Largest delay `setTimeout` honours (2^31 − 1 ms ≈ 24.8 days). Node and browsers coerce the delay to a
 * signed 32‑bit integer, so anything larger fires after ~1 ms instead of later.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `setTimeout` with the delay clamped to `[0, MAX_TIMER_MS]`.
 * @param {() => void} fnc
 * @param {number} ms
 * @returns {ReturnType<typeof setTimeout>}
 */
function setTimer(fnc, ms) {
  return setTimeout(fnc, Math.min(Math.max(0, ms), MAX_TIMER_MS));
}

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
 * @param {string} path
 * @returns {Function}
 */
function requireFn(value, path) {
  if (typeof value !== 'function') throw invalid(path, 'type', `${path} must be a function`);
  return value;
}

/**
 * Non‑negative finite number (or `Infinity` when allowed), with a default for `undefined`.
 * @param {unknown} value
 * @param {string} path
 * @param {number} [fallback]
 * @param {{ allowInfinity?: boolean }} [opts]
 * @returns {number}
 */
function requireMs(value, path, fallback, opts = {}) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw invalid(path, 'required', `${path} is required`);
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number.NaN;
  if (n === Infinity && opts.allowInfinity) return n;
  if (!Number.isFinite(n) || n < 0) {
    throw invalid(path, 'range', `${path} must be a non-negative number of milliseconds`);
  }
  return n;
}

/**
 * Integer ≥ `min` (or `Infinity`), optional.
 * @param {unknown} value
 * @param {string} path
 * @param {number} fallback
 * @param {number} [min=1]
 * @returns {number}
 */
function requireInt(value, path, fallback, min = 1) {
  if (value === undefined || value === null) return fallback;
  if (value === Infinity) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalid(path, 'range', `${path} must be an integer ≥ ${min}`);
  }
  return value;
}

/**
 * Whether `value` can be consumed as an `AbortSignal` (duck‑typed so signals from another realm, e.g. a
 * jsdom window, are accepted).
 * @param {unknown} value
 * @returns {value is AbortSignal}
 */
function isSignalLike(value) {
  if (value === null || typeof value !== 'object') return false;
  const s =
    /** @type {{ aborted?: unknown, addEventListener?: unknown, removeEventListener?: unknown }} */ (
      value
    );
  return (
    typeof s.aborted === 'boolean' &&
    typeof s.addEventListener === 'function' &&
    typeof s.removeEventListener === 'function'
  );
}

/**
 * Optional `AbortSignal`: `undefined` / `null` mean none, anything else must be signal‑like.
 * @param {unknown} value
 * @param {string} path
 * @returns {AbortSignal|undefined}
 */
function requireSignal(value, path) {
  if (value === undefined || value === null) return undefined;
  if (!isSignalLike(value)) throw invalid(path, 'type', `${path} must be an AbortSignal`);
  return value;
}

/**
 * Finite non‑negative `retryAfterMs` carried by a value, or `undefined`.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function retryAfterOf(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const ms = /** @type {{ retryAfterMs?: unknown }} */ (value).retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * The error a consumer of `signal` should reject with. An `SdkError` used as abort reason (e.g. the
 * `TimeoutError` of `timeoutSignal`) propagates as is; anything else becomes an `AbortError`.
 * @param {AbortSignal} signal
 * @param {string} [fallbackReason]
 * @returns {SdkError}
 */
function abortErrorFrom(signal, fallbackReason = 'aborted') {
  const reason = signal.reason;
  if (isSdkError(reason)) return reason;
  const options = {
    reason: typeof reason === 'string' && reason ? reason : fallbackReason,
    cause: reason,
  };
  if (reason === undefined) delete options.cause;
  return new AbortError('Operation aborted', options);
}

/**
 * Call `fn` so that synchronous throws become rejections while `fn` still starts synchronously.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function start(fn) {
  return new Promise((resolve) => resolve(fn()));
}

/**
 * Mark a caller‑supplied promise as consumed when we settle without it, so its own rejection never
 * surfaces as an unhandled rejection. Non‑thenables are ignored.
 * @param {unknown} value
 */
function consume(value) {
  if (value && typeof (/** @type {any} */ (value).then) === 'function') {
    /** @type {Promise<unknown>} */ (value).then(undefined, () => {});
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPrimitive(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * One argument of a serialised cache key: type‑tagged so `1`, `'1'`, `null` and `undefined` stay apart;
 * objects by their JSON (`String()` when not serialisable).
 * @param {unknown} value
 * @returns {string}
 */
function keyPart(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'object') {
    try {
      return `object:${JSON.stringify(value)}`;
    } catch {
      return `object:${String(value)}`;
    }
  }
  return `${type}:${String(value)}`;
}

/**
 * Default cache key for `memoAsync`. A single primitive argument is the key itself (so `has('a')` works
 * and, since `Map` keys keep their type, `1` and `'1'` never collide); no arguments key as `undefined`;
 * anything else is serialised with every argument type‑tagged.
 * @param {unknown[]} args
 * @returns {unknown}
 */
function defaultKey(args) {
  if (args.length === 0) return undefined;
  if (args.length === 1 && isPrimitive(args[0])) return args[0];
  return `\u0000${args.map(keyPart).join('\u001f')}`;
}

/**
 * @param {Jitter|undefined} jitter
 * @param {number} delay
 * @param {number} attempt
 * @returns {number}
 */
function applyJitter(jitter, delay, attempt) {
  if (jitter === false || jitter === 'none') return delay;
  if (typeof jitter === 'function') return Math.max(0, Number(jitter(delay, attempt)) || 0);
  if (jitter === 'equal') return delay / 2 + Math.random() * (delay / 2);
  return Math.random() * delay;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function defaultRetryOn(err) {
  if (isAbort(err)) return false;
  if (isSdkError(err)) return err.retryable === true;
  return true;
}

// ── debounce / throttle ──────────────────────────────────────────────────────────────────────────

/**
 * Debounce `fn`: calls are collapsed into one invocation per quiet window of `ms`. With `leading` the
 * first call of a window runs immediately, with `trailing` (default) the last call runs when the window
 * closes, and `maxWait` forces a trailing invocation at most that long after the previous one while calls
 * keep arriving. The returned function remembers the last result and exposes `.cancel()` (drop the
 * pending call and its timers), `.flush()` (run the pending call now) and `.pending()`.
 * Effects: timer. Throws `ValidationError` for a non‑function `fn` or an invalid `ms`.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @param {DebounceOptions} [options]
 * @returns {DebouncedFunction<F>}
 */
export function debounce(fn, ms, options = {}) {
  requireFn(fn, 'fn');
  const wait = requireMs(ms, 'ms', 0);
  const leading = options?.leading === true;
  const trailing = options?.trailing !== false;
  const maxWait =
    options?.maxWait === undefined || options?.maxWait === null
      ? undefined
      : requireMs(options.maxWait, 'maxWait');

  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let maxTimer = null;
  /** @type {unknown[]|null} */
  let pendingArgs = null;
  /** @type {unknown} */
  let pendingThis;
  /** @type {any} */
  let result;
  let lastInvokeTime = 0;

  function clearMax() {
    if (maxTimer !== null) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
  }

  function clearTrailing() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** @param {number} now */
  function invoke(now) {
    const args = /** @type {unknown[]} */ (pendingArgs);
    const self = pendingThis;
    pendingArgs = null;
    pendingThis = undefined;
    lastInvokeTime = now;
    result = fn.apply(self, args);
    return result;
  }

  function onTrailing() {
    timer = null;
    clearMax();
    if (pendingArgs !== null) {
      if (trailing) invoke(Date.now());
      else pendingArgs = null;
    }
  }

  function onMax() {
    maxTimer = null;
    if (pendingArgs !== null) {
      if (trailing) invoke(Date.now());
      else pendingArgs = null;
    }
    // Leading‑only: close the window so the next call is a fresh leading edge.
    if (!trailing) clearTrailing();
  }

  /** @this {unknown} */
  function debounced(...args) {
    const now = Date.now();
    const isLeadingEdge = timer === null;
    pendingArgs = args;
    pendingThis = this;
    clearTrailing();
    timer = setTimer(onTrailing, wait);
    if (isLeadingEdge) {
      lastInvokeTime = now;
      if (leading) invoke(now);
    }
    if (maxWait !== undefined && maxTimer === null && pendingArgs !== null) {
      maxTimer = setTimer(onMax, maxWait - (now - lastInvokeTime));
    }
    return result;
  }

  debounced.cancel = () => {
    clearTrailing();
    clearMax();
    pendingArgs = null;
    pendingThis = undefined;
  };

  debounced.flush = () => {
    if (pendingArgs !== null) {
      clearTrailing();
      clearMax();
      invoke(Date.now());
    }
    return result;
  };

  debounced.pending = () => pendingArgs !== null;

  return /** @type {DebouncedFunction<F>} */ (/** @type {unknown} */ (debounced));
}

/**
 * Throttle `fn` to at most one invocation per `ms`: the first call runs immediately, the latest call of
 * a busy period runs on the trailing edge. Same `.cancel()` / `.flush()` / `.pending()` as `debounce`.
 * Effects: timer. Throws `ValidationError` for invalid arguments.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @returns {DebouncedFunction<F>}
 */
export function throttle(fn, ms) {
  return debounce(fn, ms, { leading: true, trailing: true, maxWait: ms });
}

// ── single flight ────────────────────────────────────────────────────────────────────────────────

/**
 * Share one in‑flight promise per key: while a call for `keyFn(...args)` is pending, further calls with
 * the same key return the same promise instead of invoking `fn` again. A `null` `keyFn` shares a single
 * key. The entry is released as soon as the promise settles. A throwing `keyFn` rejects (never throws).
 * Effects: none. Throws `ValidationError` for a non‑function `fn` / `keyFn`.
 * @template {(...args: any[]) => any} F
 * @param {((...args: Parameters<F>) => unknown) | null | undefined} keyFn
 * @param {F} fn
 * @returns {(...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>}
 */
export function singleFlight(keyFn, fn) {
  requireFn(fn, 'fn');
  if (keyFn !== null && keyFn !== undefined) requireFn(keyFn, 'keyFn');
  /** @type {Map<unknown, Promise<any>>} */
  const inflight = new Map();

  /** @this {unknown} */
  return function shared(...args) {
    /** @type {unknown} */
    let key;
    try {
      key = keyFn ? keyFn(...args) : '';
    } catch (err) {
      return Promise.reject(err);
    }
    const existing = inflight.get(key);
    if (existing) return existing;
    // `start` runs `fn` synchronously but settles asynchronously, so the entry is stored before the
    // cleanup can run, and is gone by the time callers observe the settlement.
    const promise = start(() => fn.apply(this, args)).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}

// ── retry ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn(attempt, { signal })` until it resolves, retrying failures with exponential backoff
 * (`baseMs · factor^(attempt-1)` capped at `maxMs`, randomised by `jitter`). An error carrying a numeric
 * `retryAfterMs` (`RateLimitError`) waits exactly that long (capped at `maxMs`, no jitter). Every delay is
 * further clamped to `2^31 − 1` ms. `retryOn(err, attempt)` decides whether to retry, `onRetry(err,
 * attempt, delayMs)` observes each wait, and `signal` aborts the whole operation. Rejects with the last
 * error, or with `AbortError` when aborted; invalid options reject with `ValidationError`.
 * Effects: timer.
 * @template T
 * @param {(attempt: number, ctx: { signal?: AbortSignal }) => T | Promise<T>} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function retry(fn, options = {}) {
  requireFn(fn, 'fn');
  const o = options || {};
  const retries = requireInt(o.retries, 'retries', 3, 0);
  const baseMs = requireMs(o.baseMs, 'baseMs', 300);
  const maxMs = requireMs(o.maxMs, 'maxMs', 10000, { allowInfinity: true });
  const factor = o.factor === undefined || o.factor === null ? 2 : Number(o.factor);
  if (!Number.isFinite(factor) || factor < 1) {
    throw invalid('factor', 'range', 'factor must be a number ≥ 1');
  }
  const jitter = o.jitter === undefined || o.jitter === null ? true : o.jitter;
  if (
    typeof jitter !== 'boolean' &&
    typeof jitter !== 'function' &&
    jitter !== 'full' &&
    jitter !== 'equal' &&
    jitter !== 'none'
  ) {
    throw invalid(
      'jitter',
      'type',
      "jitter must be a boolean, 'full', 'equal', 'none' or a function"
    );
  }
  const retryOn = o.retryOn === undefined || o.retryOn === null ? defaultRetryOn : o.retryOn;
  requireFn(retryOn, 'retryOn');
  if (o.onRetry !== undefined && o.onRetry !== null) requireFn(o.onRetry, 'onRetry');
  const signal = requireSignal(o.signal, 'signal');

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortErrorFrom(signal);
    attempt += 1;
    try {
      return await fn(attempt, { signal });
    } catch (err) {
      if (signal?.aborted) throw isAbort(err) ? err : abortErrorFrom(signal);
      if (attempt > retries) throw err;
      if (!(await retryOn(err, attempt))) throw err;
      const retryAfter = retryAfterOf(err);
      const raw =
        retryAfter !== undefined
          ? Math.min(maxMs, retryAfter)
          : applyJitter(jitter, Math.min(maxMs, baseMs * factor ** (attempt - 1)), attempt);
      const delay = Math.min(raw, MAX_TIMER_MS);
      if (o.onRetry) o.onRetry(err, attempt, delay);
      await sleep(delay, signal);
    }
  }
}

// ── poll ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Call `fn(attempt, { signal })` every `intervalMs` until `until(result, attempt)` is truthy, then resolve
 * with that result. When a result carries `{ retryAfterMs }` (the backend's `Retry-After`) that delay is
 * used instead of the interval; `backoff` grows the interval exponentially (capped by `maxIntervalMs`, and
 * always by `2^31 − 1` ms). `maxAttempts` / `maxMs` reject with `TimeoutError` (`code: 'POLL_EXHAUSTED'` /
 * `'TIMEOUT'`, the last result on `details.last`); `signal` or the returned promise's `.cancel()` reject
 * with `AbortError`; invalid options reject with `ValidationError`. Errors thrown by `fn` reject
 * immediately. The inner `signal` handed to `fn` aborts on cancel, abort and deadline. Effects: timer
 * (always cleared on settle).
 * @template T
 * @param {(attempt: number, ctx: { signal: AbortSignal }) => T | Promise<T>} fn
 * @param {PollOptions} options
 * @returns {CancelablePromise<T>}
 */
export function poll(fn, options) {
  const controller = new AbortController();
  /** @type {Deferred<T>} */
  const done = deferred();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let waitTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let deadlineTimer = null;
  /** @type {(() => void)|null} */
  let wake = null;
  /** @type {Array<() => void>} */
  const cleanups = [];
  let settled = false;

  /** @param {() => void} fnc */
  const settle = (fnc) => {
    if (settled) return;
    settled = true;
    if (waitTimer !== null) clearTimeout(waitTimer);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    waitTimer = deadlineTimer = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
    fnc();
  };
  /** @param {unknown} err */
  const fail = (err) => settle(() => done.reject(err));

  const promise = /** @type {CancelablePromise<T>} */ (done.promise);
  promise.cancel = (reason = 'cancelled') => {
    if (settled) return;
    const err = new AbortError('Polling cancelled', { reason });
    controller.abort(err);
    fail(err);
    if (wake) wake();
  };

  /** @type {PollOptions} */
  let opts;
  try {
    requireFn(fn, 'fn');
    const o = options || /** @type {PollOptions} */ ({});
    const backoff =
      o.backoff === true
        ? 2
        : o.backoff === undefined || o.backoff === null || o.backoff === false
          ? 1
          : Number(o.backoff);
    if (!Number.isFinite(backoff) || backoff < 1) {
      throw invalid('backoff', 'range', 'backoff must be true or a number ≥ 1');
    }
    opts = {
      intervalMs: requireMs(o.intervalMs, 'intervalMs', 1000),
      maxIntervalMs: requireMs(o.maxIntervalMs, 'maxIntervalMs', Infinity, { allowInfinity: true }),
      backoff,
      until: /** @type {PollOptions['until']} */ (requireFn(o.until, 'until')),
      maxAttempts: requireInt(o.maxAttempts, 'maxAttempts', Infinity),
      maxMs: requireMs(o.maxMs, 'maxMs', Infinity, { allowInfinity: true }),
      signal: requireSignal(o.signal, 'signal'),
      onTick: o.onTick === undefined || o.onTick === null ? undefined : o.onTick,
    };
    if (opts.onTick) requireFn(opts.onTick, 'onTick');
  } catch (err) {
    fail(err);
    return promise;
  }

  const { signal } = opts;
  const startedAt = Date.now();
  let lastResult;
  let attempt = 0;

  /** @param {AbortSignal} s */
  const onAbort = (s) => {
    const err = abortErrorFrom(s);
    controller.abort(err);
    fail(err);
    if (wake) wake();
  };
  if (signal) {
    if (signal.aborted) {
      onAbort(signal);
      return promise;
    }
    const listener = () => onAbort(signal);
    signal.addEventListener('abort', listener, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', listener));
  }

  if (opts.maxMs !== Infinity) {
    deadlineTimer = setTimer(() => {
      deadlineTimer = null;
      const err = new TimeoutError(`Polling exceeded ${opts.maxMs} ms`, {
        timeoutMs: opts.maxMs,
        details: { attempts: attempt, last: lastResult },
      });
      controller.abort(err);
      fail(err);
      if (wake) wake();
    }, /** @type {number} */ (opts.maxMs));
  }

  /** @param {number} ms @returns {Promise<void>} */
  const wait = (ms) =>
    new Promise((resolve) => {
      wake = () => {
        if (waitTimer !== null) clearTimeout(waitTimer);
        waitTimer = null;
        wake = null;
        resolve();
      };
      waitTimer = setTimer(wake, ms);
    });

  (async () => {
    while (!settled) {
      attempt += 1;
      let result;
      try {
        result = await fn(attempt, { signal: controller.signal });
      } catch (err) {
        if (!settled) fail(err);
        return;
      }
      if (settled) return;
      lastResult = result;
      let finished;
      try {
        finished = Boolean(opts.until(result, attempt));
      } catch (err) {
        fail(err);
        return;
      }
      const exhausted = !finished && attempt >= /** @type {number} */ (opts.maxAttempts);
      /** @type {number|null} */
      let nextDelayMs = null;
      if (!finished && !exhausted) {
        const retryAfter = retryAfterOf(result);
        const base =
          retryAfter !== undefined
            ? retryAfter
            : opts.intervalMs * /** @type {number} */ (opts.backoff) ** (attempt - 1);
        nextDelayMs = Math.min(base, /** @type {number} */ (opts.maxIntervalMs), MAX_TIMER_MS);
      }
      if (opts.onTick) {
        try {
          opts.onTick(result, { attempt, elapsedMs: Date.now() - startedAt, nextDelayMs });
        } catch (err) {
          fail(err);
          return;
        }
      }
      if (finished) {
        settle(() => done.resolve(result));
        return;
      }
      if (exhausted) {
        const err = new TimeoutError(`Polling gave up after ${attempt} attempts`, {
          code: 'POLL_EXHAUSTED',
          details: { attempts: attempt, last: result },
        });
        controller.abort(err);
        fail(err);
        return;
      }
      await wait(/** @type {number} */ (nextDelayMs));
    }
  })();

  return promise;
}

// ── timeouts, sleep, deferred ────────────────────────────────────────────────────────────────────

/**
 * Settle with `promise` unless `ms` elapse first (`TimeoutError{ timeoutMs }`) or `signal` aborts
 * (`AbortError`). `promise` may be a function `(signal) => Promise` that receives a signal aborted on
 * timeout / abort so the underlying work can stop. `Infinity` disables the timer. The timer and the
 * abort listener are released as soon as the race settles; when the race is lost, `promise`'s own
 * rejection is swallowed (never unhandled). Invalid arguments reject with `ValidationError`.
 * Effects: timer.
 * @template T
 * @param {Promise<T> | ((signal: AbortSignal) => T | Promise<T>)} promise
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    let timeout;
    try {
      timeout = requireMs(ms, 'ms', undefined, { allowInfinity: true });
      signal = requireSignal(signal, 'signal');
    } catch (err) {
      // The caller's promise is considered consumed: keep its rejection from going unhandled.
      consume(promise);
      reject(err);
      return;
    }
    if (signal?.aborted) {
      consume(promise);
      reject(abortErrorFrom(signal));
      return;
    }
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    let settled = false;
    /** @param {() => void} fnc @param {unknown} [reason] */
    const finish = (fnc, reason) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (reason !== undefined && !controller.signal.aborted) controller.abort(reason);
      fnc();
    };
    const onAbort = () => {
      const err = abortErrorFrom(/** @type {AbortSignal} */ (signal));
      finish(() => reject(err), err);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeout !== Infinity) {
      timer = setTimer(() => {
        timer = null;
        const err = new TimeoutError(`Timed out after ${timeout} ms`, { timeoutMs: timeout });
        finish(() => reject(err), err);
      }, timeout);
    }
    const work =
      typeof promise === 'function'
        ? start(() => /** @type {Function} */ (promise)(controller.signal))
        : Promise.resolve(promise);
    work.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err))
    );
  });
}

/**
 * Resolve after `ms` milliseconds; reject with `AbortError` as soon as `signal` aborts (immediately when it
 * already is). `Infinity` waits for the signal alone; delays above `2^31 − 1` ms are clamped to that
 * maximum. The timer is cleared on abort. Invalid arguments reject with `ValidationError`. Effects: timer.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let delay;
    try {
      delay = requireMs(ms, 'ms', undefined, { allowInfinity: true });
      signal = requireSignal(signal, 'signal');
    } catch (err) {
      reject(err);
      return;
    }
    if (signal?.aborted) {
      reject(abortErrorFrom(signal));
      return;
    }
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      reject(abortErrorFrom(/** @type {AbortSignal} */ (signal)));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (delay !== Infinity) {
      timer = setTimer(() => {
        timer = null;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
    }
  });
}

/**
 * A promise with its `resolve` / `reject` exposed, plus `status` / `settled` flags. Effects: none.
 * @template T
 * @returns {Deferred<T>}
 */
export function deferred() {
  /** @type {'pending'|'resolved'|'rejected'} */
  let status = 'pending';
  /** @type {(value: T | PromiseLike<T>) => void} */
  let resolveFn;
  /** @type {(reason?: unknown) => void} */
  let rejectFn;
  /** @type {Promise<T>} */
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve(value) {
      if (status === 'pending') status = 'resolved';
      resolveFn(value);
    },
    reject(reason) {
      if (status === 'pending') status = 'rejected';
      rejectFn(reason);
    },
    get status() {
      return status;
    },
    get settled() {
      return status !== 'pending';
    },
  };
}

// ── signals ──────────────────────────────────────────────────────────────────────────────────────

/**
 * One signal that aborts (with the same `reason`) as soon as any input aborts. `null` / `undefined`
 * inputs are skipped; an already‑aborted input yields an already‑aborted signal; a single input is
 * returned as is; no inputs yield a signal that never aborts. Uses `AbortSignal.any` when the runtime
 * has it and every input is a native `AbortSignal` (no listener leak), otherwise one‑shot listeners that
 * are removed on the first abort. Throws `ValidationError` for a non‑signal input. Effects: none.
 * @param {...(AbortSignal|null|undefined)} signals
 * @returns {AbortSignal}
 */
export function combineSignals(...signals) {
  /** @type {AbortSignal[]} */
  const list = [];
  for (const s of signals) {
    if (s === null || s === undefined) continue;
    if (!isSignalLike(s)) {
      throw invalid('signals', 'type', 'combineSignals accepts AbortSignal instances only');
    }
    list.push(s);
  }
  if (list.length === 1) return list[0];
  const controller = new AbortController();
  if (list.length === 0) return controller.signal;
  for (const s of list) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  const any = /** @type {any} */ (AbortSignal).any;
  if (typeof any === 'function' && list.every((s) => s instanceof AbortSignal)) {
    return any.call(AbortSignal, list);
  }
  const onAbort = function (/** @type {Event} */ event) {
    for (const s of list) s.removeEventListener('abort', onAbort);
    controller.abort(/** @type {AbortSignal} */ (event.target).reason);
  };
  for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/**
 * A signal that aborts after `ms` with a `TimeoutError{ timeoutMs }` reason, so consumers (`sleep`,
 * `withTimeout`, `poll`, `http`) reject with that `TimeoutError`. `Infinity` yields a signal that never
 * aborts (no timer). Unlike `AbortSignal.timeout` it uses the global `setTimeout` (fake‑timer friendly)
 * and never keeps a Node process alive. Throws `ValidationError` for an invalid `ms`. Effects: timer.
 * @param {number} ms
 * @returns {AbortSignal}
 */
export function timeoutSignal(ms) {
  const delay = requireMs(ms, 'ms', undefined, { allowInfinity: true });
  const controller = new AbortController();
  if (delay === Infinity) return controller.signal;
  const timer = setTimer(() => {
    controller.abort(new TimeoutError(`Timed out after ${delay} ms`, { timeoutMs: delay }));
  }, delay);
  if (timer && typeof (/** @type {any} */ (timer).unref) === 'function') {
    /** @type {any} */ (timer).unref();
  }
  return controller.signal;
}

/**
 * Whether `e` denotes an abort: the SDK `AbortError` (any copy, via `code: 'ABORTED'`) or a DOMException /
 * Error named `AbortError`. Effects: none.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isAbort(e) {
  if (e === null || typeof e !== 'object') return false;
  if (e instanceof AbortError) return true;
  const err = /** @type {{ name?: unknown, code?: unknown }} */ (e);
  return err.name === 'AbortError' || err.code === 'ABORTED';
}

// ── queue ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A FIFO task queue running at most `concurrency` tasks at once (default 1 = serial). `add(fn, { signal })`
 * resolves with the task's result; aborting the signal while the task is still waiting rejects it with
 * `AbortError` without running it. `size` counts waiting tasks, `pending` running ones, `onIdle()` resolves
 * once both are zero, `clear()` rejects every waiting task. Throws `ValidationError` for an invalid
 * `concurrency`; `add` rejects with it for a non‑function task or a non‑signal `signal`. Effects: none.
 * @param {{ concurrency?: number }} [options]
 * @returns {Queue}
 */
export function createQueue(options = {}) {
  const concurrency = requireInt(options?.concurrency, 'concurrency', 1);
  /** @type {Array<{ start: () => void, drop: (err: unknown) => void }>} */
  const waiting = [];
  /** @type {Array<() => void>} */
  const idleWaiters = [];
  let running = 0;

  function drain() {
    while (running < concurrency && waiting.length > 0) {
      const job = /** @type {{ start: () => void }} */ (waiting.shift());
      job.start();
    }
    if (running === 0 && waiting.length === 0) {
      const waiters = idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  /** @type {Queue['add']} */
  function add(fn, opts = {}) {
    return new Promise((resolve, reject) => {
      /** @type {AbortSignal|undefined} */
      let signal;
      try {
        requireFn(fn, 'fn');
        signal = requireSignal(opts?.signal, 'signal');
      } catch (err) {
        reject(err);
        return;
      }
      if (signal?.aborted) {
        reject(abortErrorFrom(signal));
        return;
      }
      const onAbort = () => {
        const index = waiting.indexOf(job);
        if (index === -1) return;
        waiting.splice(index, 1);
        reject(abortErrorFrom(/** @type {AbortSignal} */ (signal)));
        drain();
      };
      const job = {
        start() {
          running += 1;
          if (signal) signal.removeEventListener('abort', onAbort);
          start(() => fn({ signal })).then(
            (value) => {
              running -= 1;
              resolve(value);
              drain();
            },
            (err) => {
              running -= 1;
              reject(err);
              drain();
            }
          );
        },
        /** @param {unknown} err */
        drop(err) {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(job);
      drain();
    });
  }

  return {
    add,
    get size() {
      return waiting.length;
    },
    get pending() {
      return running;
    },
    onIdle() {
      if (running === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    clear(reason = 'cleared') {
      const dropped = waiting.splice(0);
      for (const job of dropped) job.drop(new AbortError('Queue cleared', { reason }));
      drain();
    },
  };
}

// ── once / memo ──────────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn` once and hand every caller the same promise. A rejection releases the slot so the next call
 * tries again; `.reset()` forgets the cached promise. Effects: none.
 * Throws `ValidationError` for a non‑function `fn`.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @returns {((...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>) & { reset: () => void }}
 */
export function onceAsync(fn) {
  requireFn(fn, 'fn');
  /** @type {Promise<any>|null} */
  let promise = null;

  /** @this {unknown} */
  function once(...args) {
    if (promise) return promise;
    /** @type {Promise<any>} */
    const current = start(() => fn.apply(this, args)).then(undefined, (err) => {
      if (promise === current) promise = null;
      throw err;
    });
    promise = current;
    return current;
  }
  once.reset = () => {
    promise = null;
  };
  return once;
}

/**
 * Memoise an async function by `keyFn(...args)` (default: a single primitive argument as is, otherwise
 * the type‑tagged serialised arguments, so `1` and `'1'` never collide) for `ttlMs` after it resolves
 * (default: forever). Concurrent calls for the same key share the in‑flight promise; rejections are never
 * cached; expired entries are swept on the next miss so the cache never grows with stale keys. A throwing
 * `keyFn` rejects (never throws). Exposes `.clear()`, `.delete(key)` and `.has(key)` (true while in
 * flight or fresh). Effects: none. Throws `ValidationError` for invalid arguments.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {{ ttlMs?: number, keyFn?: (...args: Parameters<F>) => unknown }} [options]
 * @returns {((...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>) & {
 *   clear: () => void, delete: (key: unknown) => boolean, has: (key: unknown) => boolean }}
 */
export function memoAsync(fn, options = {}) {
  requireFn(fn, 'fn');
  const ttlMs = requireMs(options?.ttlMs, 'ttlMs', Infinity, { allowInfinity: true });
  const keyFn = options?.keyFn;
  if (keyFn !== undefined && keyFn !== null) requireFn(keyFn, 'keyFn');
  /** @type {Map<unknown, { promise: Promise<any>, expiresAt: number }>} */
  const cache = new Map();

  function sweep() {
    if (ttlMs === Infinity) return;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
  }

  /** @this {unknown} */
  function memo(...args) {
    /** @type {unknown} */
    let key;
    try {
      key = keyFn ? keyFn(...args) : defaultKey(args);
    } catch (err) {
      return Promise.reject(err);
    }
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.promise;
    sweep();
    /** @type {{ promise: Promise<any>, expiresAt: number }} */
    const entry = { promise: /** @type {any} */ (null), expiresAt: Infinity };
    entry.promise = start(() => fn.apply(this, args)).then(
      (value) => {
        entry.expiresAt = Date.now() + ttlMs;
        return value;
      },
      (err) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      }
    );
    cache.set(key, entry);
    return entry.promise;
  }
  memo.clear = () => cache.clear();
  /** @param {unknown} key */
  memo.delete = (key) => cache.delete(key);
  /** @param {unknown} key */
  memo.has = (key) => {
    const hit = cache.get(key);
    return Boolean(hit && hit.expiresAt > Date.now());
  };
  return memo;
}
