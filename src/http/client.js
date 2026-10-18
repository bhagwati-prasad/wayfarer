/**
 * HTTP client of the Wayfarer SDK (docs/api/01-core.md §3, docs/README.md §4): the only place `fetch`
 * is called. `createHttp` returns an `Http` that runs every request through one lifecycle — prepare
 * (defaults, lazy headers, query via `buildQuery`, request id) → request interceptors (ascending
 * priority, may short‑circuit) → hook `beforeRequest` → cache / in‑flight dedupe → fetch with a
 * combined abort signal (caller signal + per‑attempt timeout + tag registry + `ctx.abort`) → hook
 * `afterResponse` → parse by `responseType` → response interceptors → resolve; on failure normalise
 * into an `SdkError` → error interceptors (recover with a response, replace the error, or
 * `ctx.retry()`) → retry policy (network / timeout / 408 / 425 / 429 / 5xx, idempotent requests only,
 * exponential backoff with jitter, `Retry-After` honoured) → hook `onRetry` → back to cache / dedupe.
 * A `ctx.retry()` runs that same cache / dedupe → … pipeline once more for the next attempt (one
 * `http:retry` per retry, one `http:response` or `http:error` per request); whatever it settles with
 * is final and is not fed through the remaining interceptors of the outer attempt again. Also
 * `download`, `upload`, `stream` (SSE + NDJSON with reconnect), tag aborts (which also close open
 * streams), a storage‑backed response cache keyed by method + url (+ body) and `http:*` events.
 * Interceptors mutate, hooks only observe (their exceptions are swallowed and logged). The caller's
 * `spec` / `opts` are never mutated. It must not keep module‑level mutable state, must not touch
 * `window` / `document` / `localStorage`, must not log through `console`, must never throw a plain
 * `Error` (only the classes of `src/errors/index.js`), and must never inspect domain error codes —
 * the `problemInterceptor` and the modules own that.
 */

import {
  AbortError,
  ApiError,
  ConfigError,
  NetworkError,
  SdkError,
  TimeoutError,
  UnsupportedError,
  ValidationError,
  errorFromResponse,
  isSdkError,
  wrap,
} from '../errors/index.js';
import { requestId as newRequestId } from '../utils/id.js';
import { hash, isPlainObject, stableStringify } from '../utils/object.js';
import { buildQuery, joinUrl } from '../utils/url.js';
import { combineSignals } from '../utils/async.js';

/** @typedef {import('../types.js').RequestOpts} RequestOpts */
/** @typedef {import('../types.js').RequestSpec} RequestSpec */
/** @typedef {import('../types.js').HttpContext} HttpContext */
/** @typedef {import('../types.js').HookName} HookName */
/** @typedef {import('../types.js').HookFn} HookFn */
/** @typedef {import('../types.js').RequestInterceptor} RequestInterceptor */
/** @typedef {import('../types.js').ResponseInterceptor} ResponseInterceptor */
/** @typedef {import('../types.js').ErrorInterceptor} ErrorInterceptor */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/**
 * Resolved response (docs/api/01-core.md §3). `meta` carries cross‑stage data interceptors attached
 * (envelope `meta`, `dictionaries`, `deduped`, …).
 * @template T
 * @typedef {import('../types.js').HttpResponse<T> & { meta: Record<string, unknown> }} HttpResult
 */

/**
 * One parsed event of `http.stream`.
 * @typedef {Object} StreamEvent
 * @property {string} type  SSE `event:` field (`'message'` when absent); `'message'` for NDJSON lines.
 * @property {unknown} data  Parsed JSON when the payload is JSON, the raw string otherwise.
 * @property {string} [id]  SSE `id:` field of this event.
 * @property {string} [lastEventId]  Last `id:` seen on the connection (sent back as `Last-Event-ID`).
 * @property {number} [retry]  SSE `retry:` hint in ms, when the server sent one.
 * @property {string} raw  The raw event payload (SSE data lines joined by `\n`, or the NDJSON line).
 */

/**
 * Options of `http.stream` (a `RequestOpts` plus stream controls). `reconnect` (default `true`)
 * re‑opens the connection with exponential backoff (`reconnectBaseMs` 1000 → `reconnectMaxMs` 30000,
 * or the server's SSE `retry:` hint) after a transport failure, a retryable status or a clean SSE end;
 * `maxReconnects` caps the *consecutive* reconnects without a delivered event (the budget resets once a
 * connection delivers one). The stream ends when `opts.signal` aborts, on `close()`, when
 * `http.abort(opts.tag)` / `http.abortAll()` / `http.destroy()` run, or when a non‑retryable error
 * occurs (the iteration then rejects with it).
 * @typedef {RequestOpts & {
 *   method?: string, body?: unknown, reconnect?: boolean, maxReconnects?: number,
 *   reconnectBaseMs?: number, reconnectMaxMs?: number
 * }} StreamOpts
 */

/**
 * The async iterable returned by `http.stream`. Concurrent `next()` calls are answered in order.
 * @typedef {AsyncIterable<StreamEvent> & AsyncIterator<StreamEvent> & { close: () => void, readonly closed: boolean }} HttpStream
 */

/**
 * Registration options of an interceptor. Lower `priority` runs first (default 100).
 * @typedef {{ priority?: number, name?: string }} InterceptorOptions
 */

/**
 * A bundle of interceptors, as returned by the factories of `http/interceptors.js`. Each entry is a
 * function, a `{ fn, priority?, name? }` record or an array of those.
 * @typedef {Object} InterceptorBundle
 * @property {RequestInterceptor | { fn: RequestInterceptor, priority?: number, name?: string } | Array<RequestInterceptor | { fn: RequestInterceptor, priority?: number, name?: string }>} [request]
 * @property {ResponseInterceptor | { fn: ResponseInterceptor, priority?: number, name?: string } | Array<ResponseInterceptor | { fn: ResponseInterceptor, priority?: number, name?: string }>} [response]
 * @property {ErrorInterceptor | { fn: ErrorInterceptor, priority?: number, name?: string } | Array<ErrorInterceptor | { fn: ErrorInterceptor, priority?: number, name?: string }>} [error]
 */

/**
 * Injectable timers (fake‑timer friendly; default to the globals, looked up at call time).
 * @typedef {Object} HttpTimers
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/**
 * Retry backoff tuning.
 * @typedef {Object} HttpBackoff
 * @property {number} [baseMs=300]  Delay of the first retry before jitter.
 * @property {number} [maxMs=10000]  Cap for computed delays and for `Retry-After` (longer → no retry).
 * @property {number} [factor=2]  Exponential growth per attempt.
 */

/**
 * Options of `createHttp` (docs/api/01-core.md §3).
 * @typedef {Object} HttpOptions
 * @property {string} [baseUrl='']  Prefix for relative `path`s.
 * @property {typeof fetch} [fetch]  Fetch implementation; defaults to `globalThis.fetch` at call time.
 * @property {number} [timeoutMs=20000]  Per‑attempt timeout; `0` disables.
 * @property {number} [retries=2]  Default max retries (total attempts = retries + 1).
 * @property {Record<string, string | (() => string | undefined | null)>} [headers]  Default headers; a function is evaluated per request.
 * @property {{ emit: (event: string, payload?: unknown) => void }} [events]  Emitter for `http:*` events.
 * @property {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} [logger]  Scoped logger.
 * @property {import('../storage/adapters.js').StorageFacade | { get: Function, set: Function, remove: Function, keys: Function, clear: Function }} [storage]  Cache store; an in‑memory one is used when absent.
 * @property {() => number} [now]  Clock in ms (default `Date.now`).
 * @property {HttpTimers} [timers]  Injectable timers.
 * @property {() => number} [random]  Random source in `[0, 1)` for jitter (default `Math.random`).
 * @property {HttpBackoff} [backoff]  Retry backoff tuning.
 * @property {(err: SdkError, attempt: number, ctx: HttpContext) => boolean} [retryOn]  Client‑wide retry predicate override (per‑request `opts.retryOn` wins).
 */

/** @typedef {import('../errors/index.js').SdkError} SdkError */

// ── constants ────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF = Object.freeze({ baseMs: 300, maxMs: 10000, factor: 2 });
const DEFAULT_PRIORITY = 100;
const CACHE_PREFIX = 'cache:';
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRY_STATUSES = new Set([408, 425, 429]);
const RESPONSE_TYPES = new Set(['json', 'blob', 'text', 'stream']);
const HOOK_NAMES = new Set([
  'beforeRequest',
  'afterResponse',
  'onRetry',
  'onError',
  'onAbort',
  'onTimeout',
  'onAuthExpired',
  'onTokenRefreshed',
  'onStateChange',
]);
const STREAM_ACCEPT = 'text/event-stream, application/x-ndjson, application/json';

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

const noop = () => {};

/** @param {string} path @param {string} code @param {string} message @returns {ValidationError} */
function invalid(path, code, message) {
  return new ValidationError(message, { issues: [{ path, code, message }] });
}

/** @param {unknown} v @returns {v is Function} */
function isFn(v) {
  return typeof v === 'function';
}

/** @param {unknown} v @returns {boolean} */
function isHeadersLike(v) {
  return !!v && typeof v === 'object' && isFn(/** @type {any} */ (v).get);
}

/** Case‑insensitive header read on a plain object or `Headers`. */
function headerOf(headers, name) {
  if (!headers) return undefined;
  if (isHeadersLike(headers)) {
    const v = /** @type {Headers} */ (headers).get(name);
    return v === null ? undefined : v;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v !== undefined && v !== null) return String(v);
  }
  return undefined;
}

/** Set a header on a plain object, replacing any existing key that differs only by case. */
function setHeaderOn(headers, name, value) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
  if (value !== undefined && value !== null) headers[name] = String(value);
}

/** Merge header sources left‑to‑right, case‑insensitively; later sources win. */
function mergeHeaders(...sources) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    const entries = isHeadersLike(src)
      ? Array.from(/** @type {Headers} */ (src).entries())
      : Object.entries(src);
    for (const [k, v] of entries) setHeaderOn(out, k, v);
  }
  return out;
}

/** True for a native fetch `Response`. */
function isNativeResponse(v) {
  return typeof Response !== 'undefined' && v instanceof Response;
}

/** True for an `HttpResponse`‑shaped value (not a spec, not a native Response). */
function isHttpResponse(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    !isNativeResponse(v) &&
    typeof (/** @type {any} */ (v).status) === 'number' &&
    'data' in v &&
    typeof (/** @type {any} */ (v).method) !== 'string'
  );
}

/** True for a `RequestSpec`‑shaped value. */
function isSpecLike(v) {
  return !!v && typeof v === 'object' && typeof (/** @type {any} */ (v).method) === 'string';
}

/** A body `fetch` sends as is (no JSON encoding). */
function isRawBody(b) {
  if (typeof b === 'string') return true;
  if (typeof FormData !== 'undefined' && b instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
  if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== 'undefined' && (b instanceof ArrayBuffer || ArrayBuffer.isView(b)))
    return true;
  if (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) return true;
  return false;
}

/** Build the SDK error that represents an aborted signal. */
function abortErrorFor(signal, fallbackReason = 'aborted') {
  const reason = signal ? signal.reason : undefined;
  if (isSdkError(reason)) return /** @type {SdkError} */ (reason);
  const options = { reason: typeof reason === 'string' && reason ? reason : fallbackReason };
  if (reason !== undefined) /** @type {any} */ (options).cause = reason;
  return new AbortError('Request aborted', options);
}

/** Turn a user‑supplied abort reason into an `AbortError` (SdkErrors pass through). */
function toAbortReason(reason, fallback) {
  if (isSdkError(reason)) return reason;
  if (reason instanceof Error)
    return new AbortError(reason.message, { reason: fallback, cause: reason });
  return new AbortError('Request aborted', {
    reason: typeof reason === 'string' && reason ? reason : fallback,
  });
}

/** Content type is JSON (`application/json`, `application/problem+json`, `…+json`). */
function isJsonType(contentType) {
  return /[/+]json\b/i.test(contentType || '');
}

/** Read a response body as JSON when the content type says so, text otherwise. */
async function readBody(response) {
  const ct = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!text) return undefined;
  if (isJsonType(ct) || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** @param {unknown} v @param {string} path @param {{ integer?: boolean, min?: number }} [o] */
function requireNumber(v, path, o = {}) {
  const min = o.min ?? 0;
  if (
    typeof v !== 'number' ||
    !Number.isFinite(v) ||
    v < min ||
    (o.integer && !Number.isInteger(v))
  ) {
    throw invalid(
      path,
      'range',
      `${path} must be a ${o.integer ? 'non-negative integer' : `number ≥ ${min}`}`
    );
  }
  return v;
}

/** A minimal in‑memory store with the `StorageFacade` subset the cache needs. */
function memoryStore(now) {
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.expiresAt && e.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value, options = {}) {
      const ttl = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 0;
      map.set(key, { value, expiresAt: ttl ? now() + ttl : 0 });
    },
    remove(key) {
      map.delete(key);
    },
    keys(prefix = '') {
      return Array.from(map.keys()).filter((k) => k.startsWith(prefix));
    },
    clear(prefix = '') {
      for (const k of Array.from(map.keys())) if (k.startsWith(prefix)) map.delete(k);
    },
  };
}

/** One ordered interceptor stage. */
function createStage(kind) {
  /** @type {Array<{ fn: Function, priority: number, name: string|undefined, seq: number }>} */
  let list = [];
  let seq = 0;
  /**
   * @param {Function} fn
   * @param {InterceptorOptions} [options]
   * @returns {() => void}
   */
  function use(fn, options = {}) {
    if (!isFn(fn)) throw invalid(`interceptors.${kind}`, 'type', 'interceptor must be a function');
    const o = options || {};
    const priority = o.priority === undefined ? DEFAULT_PRIORITY : o.priority;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw invalid(`interceptors.${kind}.priority`, 'type', 'priority must be a finite number');
    }
    const entry = {
      fn,
      priority,
      name: typeof o.name === 'string' ? o.name : undefined,
      seq: seq++,
    };
    list = [...list, entry].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    return () => {
      list = list.filter((e) => e !== entry);
    };
  }
  return {
    use,
    /** Snapshot of the registered entries, in run order. */
    entries: () => list,
    /** Drop every interceptor of this stage. */
    clear() {
      list = [];
    },
  };
}

// ── factory ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Create the HTTP client (docs/api/01-core.md §3). Effects: none until used.
 * @param {HttpOptions} [options]
 * @returns {Http}
 * @throws {ConfigError} on invalid options.
 */
export function createHttp(options = {}) {
  const o = options || {};
  if (o.fetch !== undefined && !isFn(o.fetch)) {
    throw new ConfigError('createHttp: fetch must be a function');
  }
  if (o.baseUrl !== undefined && typeof o.baseUrl !== 'string') {
    throw new ConfigError('createHttp: baseUrl must be a string');
  }
  if (
    o.timeoutMs !== undefined &&
    (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs) || o.timeoutMs < 0)
  ) {
    throw new ConfigError('createHttp: timeoutMs must be a non-negative number');
  }
  if (o.retries !== undefined && (!Number.isInteger(o.retries) || o.retries < 0)) {
    throw new ConfigError('createHttp: retries must be a non-negative integer');
  }
  if (o.headers !== undefined && !isPlainObject(o.headers)) {
    throw new ConfigError('createHttp: headers must be a plain object');
  }
  for (const key of ['now', 'random', 'retryOn']) {
    if (o[key] !== undefined && !isFn(o[key])) {
      throw new ConfigError(`createHttp: ${key} must be a function`);
    }
  }
  if (
    o.timers !== undefined &&
    (!o.timers || !isFn(o.timers.setTimeout) || !isFn(o.timers.clearTimeout))
  ) {
    throw new ConfigError('createHttp: timers must expose setTimeout and clearTimeout');
  }

  // ── configuration (mutable through setters) ──
  let baseUrl = o.baseUrl || '';
  let fetchImpl = o.fetch;
  const defaultTimeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs;
  const defaultRetries = o.retries === undefined ? DEFAULT_RETRIES : o.retries;
  const backoff = { ...DEFAULT_BACKOFF, ...(isPlainObject(o.backoff) ? o.backoff : {}) };
  const now = o.now || Date.now;
  const random = o.random || Math.random;
  const timers = o.timers || {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
  };
  const logger = o.logger || {};
  const log = (level, msg, data) => {
    const fn = logger[level];
    if (isFn(fn)) {
      try {
        fn.call(logger, msg, data);
      } catch {
        /* logging must never break a request */
      }
    }
  };
  const emit = (type, payload) => {
    if (o.events && isFn(o.events.emit)) {
      try {
        o.events.emit(type, payload);
      } catch (e) {
        log('warn', `http: event emitter threw on ${type}`, { error: e });
      }
    }
  };
  const store =
    o.storage && isFn(o.storage.get) && isFn(o.storage.set) ? o.storage : memoryStore(now);

  // ── state ──
  /** Default headers: lower‑case name → { name, value } (value may be a lazy function). */
  const defaultHeaders = new Map();
  for (const [k, v] of Object.entries(o.headers || {}))
    defaultHeaders.set(k.toLowerCase(), { name: k, value: v });
  const stages = {
    request: createStage('request'),
    response: createStage('response'),
    error: createStage('error'),
  };
  /** @type {Map<string, Set<HookFn>>} */
  const hooks = new Map();
  /** In‑flight requests: ctx id → { ctx, controller }. */
  const inflightSet = new Map();
  /** Dedupe registry: key → { id, promise }. */
  const inflightByKey = new Map();
  /**
   * Open streams. Once its headers arrived a stream is no longer in `inflightSet`, so `abort` /
   * `abortAll` / `destroy` reach it through this registry. `connecting` is true while the stream's
   * own request is in flight (then `inflightSet` already accounts for it).
   * @type {Set<{ tag: string|undefined, connecting: boolean, close: () => void }>}
   */
  const openStreams = new Set();
  let lastId;
  let destroyed = false;

  // ── hooks ──
  function runHook(name, ...args) {
    const set = hooks.get(name);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try {
        const out = fn(...args);
        if (out && isFn(out.then)) {
          out.then(undefined, (e) => log('warn', `http: hook ${name} rejected`, { error: e }));
        }
      } catch (e) {
        log('warn', `http: hook ${name} threw`, { error: e });
      }
    }
  }

  // ── timers ──
  /** Resolve after `ms`; reject with the signal's abort error when it aborts first. */
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortErrorFor(signal));
        return;
      }
      let handle = null;
      const onAbort = () => {
        if (handle !== null) timers.clearTimeout(handle);
        handle = null;
        reject(abortErrorFor(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      handle = timers.setTimeout(
        () => {
          handle = null;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms)
      );
    });
  }

  // ── prepare ──
  /** Resolve default headers (lazy functions evaluated now). */
  function resolveDefaultHeaders() {
    /** @type {Record<string, string>} */
    const out = {};
    for (const { name, value } of defaultHeaders.values()) {
      let v = value;
      if (isFn(v)) {
        try {
          v = v();
        } catch (e) {
          log('warn', `http: default header ${name} threw`, { error: e });
          continue;
        }
      }
      if (v !== undefined && v !== null) out[name] = String(v);
    }
    return out;
  }

  /**
   * Validate and normalise a spec (also used for interceptor replacements and `ctx.retry({ spec })`).
   * @param {RequestSpec} spec
   * @param {boolean} [applyDefaults]
   * @returns {RequestSpec}
   */
  function normaliseSpec(spec, applyDefaults = false) {
    if (!spec || typeof spec !== 'object')
      throw invalid('spec', 'type', 'request spec must be an object');
    const s = /** @type {any} */ (spec);
    if (typeof s.method !== 'string' || !s.method.trim()) {
      throw invalid('method', 'required', 'method must be a non-empty string');
    }
    const hasPath = typeof s.path === 'string' && s.path !== '';
    const hasUrl = typeof s.url === 'string' && s.url !== '';
    if (!hasPath && !hasUrl) throw invalid('path', 'required', 'path or url is required');
    if (s.headers !== undefined && !isPlainObject(s.headers) && !isHeadersLike(s.headers)) {
      throw invalid('headers', 'type', 'headers must be a plain object');
    }
    if (s.query !== undefined && s.query !== null && !isPlainObject(s.query)) {
      throw invalid('query', 'type', 'query must be a plain object');
    }
    if (s.responseType !== undefined && !RESPONSE_TYPES.has(s.responseType)) {
      throw invalid('responseType', 'enum', 'responseType must be json, blob, text or stream');
    }
    if (s.timeoutMs !== undefined) requireNumber(s.timeoutMs, 'timeoutMs');
    if (s.retries !== undefined) requireNumber(s.retries, 'retries', { integer: true });
    if (s.retryOn !== undefined && !isFn(s.retryOn))
      throw invalid('retryOn', 'type', 'retryOn must be a function');
    if (s.cache !== undefined && s.cache !== false && s.cache !== null) {
      if (!isPlainObject(s.cache))
        throw invalid('cache', 'type', 'cache must be false or { ttlMs, key? }');
      requireNumber(s.cache.ttlMs, 'cache.ttlMs', { min: 1 });
    }
    if (s.signal !== undefined && s.signal !== null && typeof s.signal.aborted !== 'boolean') {
      throw invalid('signal', 'type', 'signal must be an AbortSignal');
    }
    const headers = applyDefaults
      ? mergeHeaders(resolveDefaultHeaders(), s.headers)
      : mergeHeaders(s.headers);
    // Every container the lifecycle may write to is copied: the caller's `opts` stay untouched.
    return {
      ...s,
      method: s.method.trim().toUpperCase(),
      headers,
      query: { ...(s.query || {}) },
      timeoutMs: s.timeoutMs === undefined ? defaultTimeoutMs : s.timeoutMs,
      retries: s.retries === undefined ? defaultRetries : s.retries,
      responseType: s.responseType || 'json',
      cache: s.cache ? { ...s.cache } : false,
      meta: isPlainObject(s.meta) ? { ...s.meta } : {},
    };
  }

  /** Final URL of a spec: absolute `url` wins, else `baseUrl + path`; `query` serialised by `buildQuery`. */
  function urlOf(spec) {
    const base =
      typeof spec.url === 'string' && spec.url ? spec.url : joinUrl(baseUrl, spec.path || '');
    const qs = buildQuery(spec.query);
    if (!qs) return base;
    return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
  }

  /** Encode the body and complete `Content-Type` / `Accept`; returns the fetch init body. */
  function encodeBody(spec, headers) {
    const b = spec.body;
    if (b === undefined || b === null) return undefined;
    if (isRawBody(b)) {
      if (typeof b === 'string' && !headerOf(headers, 'content-type')) {
        setHeaderOn(headers, 'Content-Type', 'text/plain;charset=UTF-8');
      }
      return b;
    }
    if (!headerOf(headers, 'content-type'))
      setHeaderOn(headers, 'Content-Type', 'application/json');
    return JSON.stringify(b);
  }

  function defaultAccept(responseType) {
    if (responseType === 'json')
      return 'application/json, application/problem+json;q=0.9, */*;q=0.8';
    if (responseType === 'text') return 'text/plain, */*;q=0.8';
    return '*/*';
  }

  // ── cache ──
  /**
   * Stable text of a request body for cache / dedupe identity: `''` for none, the string itself,
   * a key‑order‑independent serialisation for JSON bodies, `undefined` when it cannot be keyed
   * (binary / multipart / unserialisable).
   */
  function bodyKeyOf(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (isRawBody(body)) return undefined;
    try {
      return stableStringify(body);
    } catch {
      return undefined;
    }
  }

  /**
   * Logical cache key: `spec.cache.key`, else `METHOD url` plus the body (so two POSTs with different
   * payloads never share an entry); `undefined` when the request is not cacheable.
   */
  function cacheLogicalKey(spec, url) {
    if (!spec.cache) return undefined;
    if (typeof spec.cache.key === 'string' && spec.cache.key) return spec.cache.key;
    const bodyKey = bodyKeyOf(spec.body);
    if (bodyKey === undefined) return undefined;
    return `${spec.method} ${url}${bodyKey ? `\n${bodyKey}` : ''}`;
  }
  const cacheStorageKey = (logicalKey) => `${CACHE_PREFIX}${hash(logicalKey)}`;

  function readCache(spec, url) {
    const logicalKey = cacheLogicalKey(spec, url);
    if (logicalKey === undefined) return undefined;
    try {
      const entry = store.get(cacheStorageKey(logicalKey));
      if (!entry || typeof entry !== 'object') return undefined;
      return entry;
    } catch (e) {
      log('warn', 'http: cache read failed', { error: e });
      return undefined;
    }
  }

  function writeCache(spec, url, res) {
    if (res.status < 200 || res.status >= 300) return;
    if (spec.responseType === 'blob' || spec.responseType === 'stream') return;
    const logicalKey = cacheLogicalKey(spec, url);
    if (logicalKey === undefined) return;
    try {
      store.set(
        cacheStorageKey(logicalKey),
        {
          key: logicalKey,
          data: res.data,
          status: res.status,
          headers: Array.from(res.headers.entries()),
          requestId: res.requestId,
          meta: res.meta,
          storedAt: now(),
        },
        { ttlMs: spec.cache.ttlMs }
      );
    } catch (e) {
      log('warn', 'http: cache write failed', { error: e });
    }
  }

  // ── dedupe ──
  function dedupeKey(spec, url) {
    const m = spec.method;
    const wanted = spec.dedupe === true || (spec.dedupe !== false && (m === 'GET' || m === 'HEAD'));
    if (!wanted) return undefined;
    const bodyKey = bodyKeyOf(spec.body);
    if (bodyKey === undefined) return undefined; // binary / multipart bodies are never deduped
    return `${m} ${url}${bodyKey ? `\n${bodyKey}` : ''}`;
  }

  // ── retry policy ──
  function hasIdempotencyKey(spec) {
    return !!spec.idempotencyKey || headerOf(spec.headers, 'idempotency-key') !== undefined;
  }

  /** `null` = do not retry; otherwise the delay in ms before the next attempt. */
  function retryDelayFor(err, ctx) {
    const spec = ctx.spec;
    if (err instanceof AbortError) return null;
    if (ctx.attempt > spec.retries) return null;
    const predicate = isFn(spec.retryOn) ? spec.retryOn : o.retryOn;
    let should;
    if (predicate) {
      try {
        should = predicate(err, ctx.attempt, ctx) === true;
      } catch (e) {
        log('warn', 'http: retryOn threw', { error: e });
        should = false;
      }
    } else {
      const idempotent = IDEMPOTENT_METHODS.has(spec.method) || hasIdempotencyKey(spec);
      if (!idempotent) return null;
      if (err instanceof NetworkError || err instanceof TimeoutError) should = true;
      else if (err instanceof ApiError)
        should = RETRY_STATUSES.has(err.status) || err.status >= 500;
      else should = false;
    }
    if (!should) return null;
    const retryAfterMs =
      err instanceof ApiError && typeof (/** @type {any} */ (err).retryAfterMs) === 'number'
        ? /** @type {any} */ (err).retryAfterMs
        : err instanceof ApiError && typeof err.meta?.retryAfterMs === 'number'
          ? /** @type {number} */ (err.meta.retryAfterMs)
          : undefined;
    if (retryAfterMs !== undefined) {
      return retryAfterMs > backoff.maxMs ? null : retryAfterMs;
    }
    const exp = Math.min(backoff.maxMs, backoff.baseMs * backoff.factor ** (ctx.attempt - 1));
    const r = Math.min(Math.max(Number(random()) || 0, 0), 1);
    return Math.round(exp / 2 + (exp / 2) * r);
  }

  // ── normalise ──
  /**
   * Turn anything thrown into an `SdkError` carrying the request id. An aborted `signal` wins (its
   * reason is the `AbortError` / `TimeoutError`). Only `transport` failures (the `fetch` call, the
   * body read) map a bare `TypeError` to `NetworkError`; a `TypeError` thrown by an interceptor is a
   * programming error and goes through `wrap` (so it is not retried as a network blip).
   * @param {unknown} e @param {{ id: string }} ctx @param {AbortSignal} [signal] @param {boolean} [transport]
   */
  function normaliseError(e, ctx, signal, transport = false) {
    let err;
    if (isSdkError(e)) err = /** @type {SdkError} */ (e);
    else if (signal && signal.aborted) err = abortErrorFor(signal);
    else if (transport && e instanceof TypeError)
      err = new NetworkError(e.message || 'Network error', { cause: e });
    else err = wrap(e);
    if (!err.requestId) err.requestId = ctx.id;
    return err;
  }

  // ── lifecycle ──
  /**
   * Run one request through the full lifecycle.
   * @param {RequestSpec} rawSpec
   * @returns {Promise<HttpResult<any>>}
   */
  async function execute(rawSpec) {
    if (destroyed) throw new AbortError('http client destroyed', { reason: 'destroyed' });
    const spec0 = normaliseSpec(rawSpec, true);
    const id = newRequestId();
    lastId = id;
    const startedAt = now();
    const controller = new AbortController();
    const userSignal = spec0.signal || undefined;
    const baseSignal = combineSignals(userSignal, controller.signal);
    /** @type {Map<string, unknown>} */
    const meta = new Map(Object.entries(spec0.meta || {}));
    /** Per‑attempt signal (base + timeout); replaced on each attempt. */
    let attemptSignal = baseSignal;
    /**
     * Results and errors that already completed a nested `attempt()` through `ctx.retry()`: they ran
     * the remaining interceptors, the retry policy, the cache write and the events, so the outer
     * attempt returns / throws them as they are instead of processing them a second time.
     */
    const settledByRetry = new WeakSet();

    /** @type {HttpContext & { response?: Response }} */
    const ctx = {
      id,
      spec: spec0,
      attempt: 1,
      startedAt,
      get tag() {
        return ctx.spec.tag;
      },
      meta,
      request: undefined,
      response: undefined,
      data: undefined,
      error: undefined,
      setHeader(name, value) {
        if (typeof name !== 'string' || !name)
          throw invalid('name', 'required', 'header name is required');
        setHeaderOn(ctx.spec.headers, name, value);
      },
      setQuery(name, value) {
        if (typeof name !== 'string' || !name)
          throw invalid('name', 'required', 'query name is required');
        if (value === undefined) delete ctx.spec.query[name];
        else ctx.spec.query[name] = value;
      },
      async retry(options = {}) {
        const r = options || {};
        if (r.spec !== undefined) ctx.spec = normaliseSpec(r.spec, false);
        const delayMs = typeof r.delayMs === 'number' && r.delayMs > 0 ? r.delayMs : 0;
        if (baseSignal.aborted) throw abortErrorFor(baseSignal);
        announceRetry(delayMs);
        if (delayMs > 0) await wait(delayMs, baseSignal);
        if (baseSignal.aborted) throw abortErrorFor(baseSignal);
        ctx.attempt += 1;
        try {
          const res = await attempt();
          settledByRetry.add(res);
          return res;
        } catch (e) {
          const err = normaliseError(e, ctx, baseSignal);
          settledByRetry.add(err);
          throw err;
        }
      },
      abort(reason) {
        if (!controller.signal.aborted) controller.abort(toAbortReason(reason, 'aborted'));
      },
      get signal() {
        return attemptSignal;
      },
    };
    inflightSet.set(id, { ctx, controller });
    /** The one dedupe key this request leads (see `attempt`). @type {{ key: string, deferred: ReturnType<typeof createDeferred> } | undefined} */
    let dedupeOwned;

    const throwIfAborted = () => {
      if (attemptSignal.aborted) throw abortErrorFor(attemptSignal);
    };

    /** Announce the next attempt: hook `onRetry` + `http:retry` (shared by the policy and `ctx.retry`). */
    const announceRetry = (delayMs) => {
      runHook('onRetry', ctx, delayMs);
      emit('http:retry', {
        id,
        method: ctx.spec.method,
        url: urlOf(ctx.spec),
        attempt: ctx.attempt + 1,
        delayMs,
        error: ctx.error,
        tag: ctx.spec.tag,
      });
    };

    const finish = (res, extra = {}) => {
      /** @type {HttpResult<any>} */
      const out = {
        data: res.data,
        status: res.status,
        headers: isHeadersLike(res.headers) ? res.headers : new Headers(res.headers || undefined),
        requestId: res.requestId || id,
        fromCache: res.fromCache === true,
        attempts: ctx.attempt,
        durationMs: Math.max(0, now() - startedAt),
        meta: { ...Object.fromEntries(meta), ...(isPlainObject(res.meta) ? res.meta : {}) },
        ...extra,
      };
      return out;
    };

    /** Perform the fetch of the current attempt (with timeout) and return the native Response. */
    async function doFetch() {
      const fetcher = fetchImpl || globalThis.fetch;
      if (!isFn(fetcher))
        throw new UnsupportedError('fetch is not available in this runtime', { feature: 'fetch' });
      const spec = ctx.spec;
      const url = urlOf(spec);
      const headers = { ...spec.headers };
      const body = encodeBody(spec, headers);
      if (!headerOf(headers, 'accept'))
        setHeaderOn(headers, 'Accept', defaultAccept(spec.responseType));
      const timeoutCtl = new AbortController();
      let timer = null;
      const signal = combineSignals(baseSignal, timeoutCtl.signal);
      attemptSignal = signal;
      const timeoutMs = spec.timeoutMs;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = timers.setTimeout(() => {
          timer = null;
          timeoutCtl.abort(
            new TimeoutError(`Request timed out after ${timeoutMs} ms`, {
              timeoutMs,
              requestId: id,
            })
          );
        }, timeoutMs);
      }
      const init = { method: spec.method, headers, body, signal };
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
        init.duplex = 'half';
      if (spec.credentials) init.credentials = spec.credentials;
      try {
        ctx.request = new Request(url, init);
      } catch {
        ctx.request = undefined;
      }
      const clear = () => {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
      };
      try {
        throwIfAborted();
        const response = await fetcher(url, init);
        if (!isNativeResponse(response) && !(response && typeof response.status === 'number')) {
          clear();
          throw new NetworkError('fetch returned no response', { requestId: id });
        }
        // Streams are consumed by the caller; the timeout only covers the headers.
        if (spec.responseType === 'stream') clear();
        return { response, url, clear };
      } catch (e) {
        clear();
        throw normaliseError(e, ctx, signal, true);
      }
    }

    /** Parse the body by `responseType`; 2xx only. */
    async function parse(response) {
      const type = ctx.spec.responseType;
      if (type === 'stream') return response.body;
      if (type === 'blob') return response.blob();
      if (response.status === 204 || response.status === 205 || ctx.spec.method === 'HEAD')
        return undefined;
      if (type === 'text') return response.text();
      const ct = response.headers.get('content-type') || '';
      const text = await response.text();
      if (text === '') return undefined;
      if (isJsonType(ct)) {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new SdkError('Response is not valid JSON', {
            code: 'INVALID_RESPONSE',
            cause: e,
            requestId: id,
            details: { contentType: ct, preview: text.slice(0, 200) },
          });
        }
      }
      return text;
    }

    /** Build the SdkError for a non‑2xx response. */
    async function errorFor(response) {
      let body;
      try {
        body = await readBody(response);
      } catch {
        body = undefined;
      }
      const err = errorFromResponse(response.status, body, response.headers, {
        requestId: id,
        now: now(),
      });
      if (!err.requestId) err.requestId = id;
      return err;
    }

    /**
     * One pass from the cache / dedupe stage to a resolved response, looping on retries.
     * @param {Response} [preResponse]  A native Response short‑circuited by a request interceptor.
     */
    async function attempt(preResponse) {
      let pre = preResponse;
      for (;;) {
        const spec = ctx.spec;
        const url = urlOf(spec);
        // A new attempt starts from the request-level signal; the previous attempt's timeout is gone.
        attemptSignal = baseSignal;
        try {
          throwIfAborted();
          // cache
          const hit = readCache(spec, url);
          if (hit) {
            emit('http:request', {
              id,
              method: spec.method,
              url,
              tag: spec.tag,
              attempt: ctx.attempt,
              fromCache: true,
            });
            const res = finish({
              data: hit.data,
              status: hit.status,
              headers: new Headers(Array.isArray(hit.headers) ? hit.headers : []),
              requestId: hit.requestId,
              meta: hit.meta,
              fromCache: true,
            });
            emit('http:response', {
              id,
              method: spec.method,
              url,
              status: res.status,
              fromCache: true,
              attempts: ctx.attempt,
              durationMs: res.durationMs,
              tag: spec.tag,
            });
            return res;
          }
          // dedupe
          const key = pre ? undefined : dedupeKey(spec, url);
          if (key !== undefined) {
            const leader = inflightByKey.get(key);
            if (leader && leader.id !== id) {
              emit('http:request', {
                id,
                method: spec.method,
                url,
                tag: spec.tag,
                attempt: ctx.attempt,
                deduped: true,
              });
              const shared = await followLeader(leader.promise);
              // Own `Headers` (they are mutable); `data` is shared by design.
              const res = finish({
                ...shared,
                headers: new Headers(shared.headers),
                meta: { ...shared.meta, deduped: true },
              });
              emit('http:response', {
                id,
                method: spec.method,
                url,
                status: res.status,
                fromCache: res.fromCache,
                attempts: ctx.attempt,
                durationMs: res.durationMs,
                tag: spec.tag,
                deduped: true,
              });
              return res;
            }
            // A request leads at most one key. After a retry that changed the URL it keeps serving
            // the followers of its original key; registering a second key would orphan the first
            // entry and hang every later identical request behind a promise that never settles.
            if (!leader && !dedupeOwned) {
              dedupeOwned = { key, deferred: createDeferred() };
              inflightByKey.set(key, { id, promise: dedupeOwned.deferred.promise });
            }
          }
          // fetch
          emit('http:request', {
            id,
            method: spec.method,
            url,
            tag: spec.tag,
            attempt: ctx.attempt,
          });
          let response;
          let clear = noop;
          if (pre) {
            response = pre;
            pre = undefined;
          } else {
            ({ response, clear } = await doFetch());
          }
          ctx.response = response;
          runHook('afterResponse', ctx);
          let res;
          try {
            if (response.status < 200 || response.status >= 300) throw await errorFor(response);
            let data;
            try {
              data = await parse(response);
            } catch (e) {
              // A body read failing mid‑way is a transport error (or the timeout / abort firing).
              throw normaliseError(e, ctx, attemptSignal, true);
            }
            ctx.data = data;
            res = finish({
              data,
              status: response.status,
              headers: response.headers,
              requestId: id,
              meta: Object.fromEntries(meta),
            });
          } finally {
            clear();
          }
          for (const entry of stages.response.entries()) {
            const out = await entry.fn(res, ctx);
            // A nested `ctx.retry()` finished the pipeline (interceptors, cache, events) already.
            if (settledByRetry.has(out)) return out;
            throwIfAborted();
            if (isHttpResponse(out))
              res = finish(
                { ...out, fromCache: out.fromCache === true },
                { attempts: ctx.attempt }
              );
          }
          ctx.data = res.data;
          writeCache(spec, url, res);
          emit('http:response', {
            id,
            method: spec.method,
            url,
            status: res.status,
            fromCache: false,
            attempts: ctx.attempt,
            durationMs: res.durationMs,
            tag: spec.tag,
          });
          return res;
        } catch (raw) {
          // An error settled by a nested `ctx.retry()` went through interceptors + policy already.
          if (settledByRetry.has(raw)) throw raw;
          let err = normaliseError(raw, ctx, attemptSignal);
          // The attempt is over: from here on `ctx.signal`, waits and abort checks follow the
          // request‑level signal (a fired per‑attempt timeout must not read as "request aborted").
          attemptSignal = baseSignal;
          ctx.error = err;
          // error interceptors
          let recovered;
          for (const entry of stages.error.entries()) {
            let out;
            try {
              out = await entry.fn(err, ctx);
            } catch (e) {
              out = e;
            }
            if (settledByRetry.has(out)) {
              if (isHttpResponse(out)) return out;
              throw out;
            }
            // Aborted while the interceptor was running (e.g. awaiting a token refresh): the
            // request rejects with the AbortError, whatever the interceptor produced.
            if (baseSignal.aborted) throw abortErrorFor(baseSignal);
            if (isHttpResponse(out)) {
              recovered = out;
              break;
            }
            if (out instanceof Error || isSdkError(out)) {
              err = normaliseError(out, ctx, baseSignal);
              ctx.error = err;
            }
          }
          if (recovered) {
            const res = finish(
              { ...recovered, fromCache: recovered.fromCache === true },
              { attempts: ctx.attempt }
            );
            ctx.error = undefined;
            ctx.data = res.data;
            emit('http:response', {
              id,
              method: spec.method,
              url,
              status: res.status,
              fromCache: res.fromCache,
              attempts: ctx.attempt,
              durationMs: res.durationMs,
              tag: spec.tag,
              recovered: true,
            });
            return res;
          }
          // retry policy
          const delayMs = baseSignal.aborted ? null : retryDelayFor(err, ctx);
          if (delayMs === null) throw err;
          announceRetry(delayMs);
          await wait(delayMs, baseSignal);
          ctx.attempt += 1;
        }
      }
    }

    /** Wait for a dedupe leader; our own abort still rejects us without touching the leader. */
    function followLeader(promise) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortErrorFor(baseSignal));
        if (baseSignal.aborted) return onAbort();
        baseSignal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          (v) => {
            baseSignal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e) => {
            baseSignal.removeEventListener('abort', onAbort);
            reject(e);
          }
        );
      });
    }

    const onUserAbort = () => controller.abort(abortErrorFor(userSignal));
    if (userSignal) userSignal.addEventListener('abort', onUserAbort, { once: true });

    try {
      throwIfAborted();
      // request interceptors
      let pre;
      for (const entry of stages.request.entries()) {
        const out = await entry.fn(ctx.spec, ctx);
        throwIfAborted();
        if (isNativeResponse(out)) {
          pre = out;
          break;
        }
        if (isHttpResponse(out)) {
          const res = finish({ ...out, fromCache: out.fromCache !== false });
          emit('http:request', {
            id,
            method: ctx.spec.method,
            url: urlOf(ctx.spec),
            tag: ctx.spec.tag,
            attempt: ctx.attempt,
            shortCircuit: true,
          });
          emit('http:response', {
            id,
            method: ctx.spec.method,
            url: urlOf(ctx.spec),
            status: res.status,
            fromCache: res.fromCache,
            attempts: ctx.attempt,
            durationMs: res.durationMs,
            tag: ctx.spec.tag,
          });
          if (dedupeOwned) dedupeOwned.deferred.resolve(res);
          return res;
        }
        if (isSpecLike(out) && out !== ctx.spec) ctx.spec = normaliseSpec(out, false);
      }
      runHook('beforeRequest', ctx);
      throwIfAborted();
      const res = await attempt(pre);
      if (dedupeOwned) dedupeOwned.deferred.resolve(res);
      return res;
    } catch (raw) {
      const err = normaliseError(raw, ctx, attemptSignal);
      ctx.error = err;
      if (dedupeOwned) dedupeOwned.deferred.reject(err);
      const url = urlOf(ctx.spec);
      const base = {
        id,
        method: ctx.spec.method,
        url,
        tag: ctx.spec.tag,
        attempts: ctx.attempt,
        durationMs: Math.max(0, now() - startedAt),
      };
      if (err instanceof AbortError) {
        runHook('onAbort', ctx);
        emit('http:abort', { ...base, reason: err.reason, error: err });
      } else {
        if (err instanceof TimeoutError) runHook('onTimeout', ctx);
        runHook('onError', ctx);
        emit('http:error', {
          ...base,
          error: err,
          status: err instanceof ApiError ? err.status : undefined,
        });
      }
      throw err;
    } finally {
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
      inflightSet.delete(id);
      if (dedupeOwned && inflightByKey.get(dedupeOwned.key)?.id === id)
        inflightByKey.delete(dedupeOwned.key);
    }
  }

  /** A promise with exposed settlers whose rejection never goes unhandled while nobody follows it. */
  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(noop);
    return { promise, resolve, reject };
  }

  // ── public: requests ──
  /** @type {Http['request']} */
  function request(spec) {
    try {
      return execute(spec);
    } catch (e) {
      return Promise.reject(isSdkError(e) ? e : wrap(e));
    }
  }
  const sugar = (method, withBody) =>
    withBody
      ? (path, body, opts = {}) => request({ ...(opts || {}), method, path, body })
      : (path, opts = {}) => request({ ...(opts || {}), method, path });

  /** @type {Http['download']} */
  async function download(path, opts = {}) {
    const res = await request({
      ...(opts || {}),
      method: (opts && opts.method) || 'GET',
      path,
      responseType: 'blob',
    });
    return res.data;
  }

  /** @type {Http['upload']} */
  function upload(path, formData, opts = {}) {
    const o2 = opts || {};
    const onProgress = isFn(o2.onProgress) ? o2.onProgress : undefined;
    const total =
      typeof Blob !== 'undefined' && formData instanceof Blob
        ? formData.size
        : typeof formData === 'string'
          ? formData.length
          : undefined;
    const known = total !== undefined;
    const report = (done) => {
      if (!onProgress) return;
      try {
        // fetch exposes no upload progress: report the start and the completion only.
        onProgress({
          loaded: done ? (known ? total : 1) : 0,
          total: done && !known ? 1 : total,
          lengthComputable: known,
          done,
        });
      } catch (e) {
        log('warn', 'http: onProgress threw', { error: e });
      }
    };
    report(false);
    const { onProgress: _ignored, ...rest } = o2;
    return request({ ...rest, method: rest.method || 'POST', path, body: formData }).then((res) => {
      report(true);
      return res;
    });
  }

  // ── public: stream ──
  /** @type {Http['stream']} */
  function stream(path, opts = {}) {
    const so = /** @type {StreamOpts} */ (opts || {});
    /** @type {StreamEvent[]} */
    const queue = [];
    /** Pending `next()` calls, answered in order. @type {Array<{ resolve: Function, reject: Function }>} */
    const waiters = [];
    let closed = false;
    let ended = false;
    /** @type {SdkError | null} */
    let failure = null;
    const closeCtl = new AbortController();
    const signal = combineSignals(so.signal || undefined, closeCtl.signal);
    const reconnect = so.reconnect !== false;
    const maxReconnects = typeof so.maxReconnects === 'number' ? so.maxReconnects : Infinity;
    const baseMs = typeof so.reconnectBaseMs === 'number' ? so.reconnectBaseMs : 1000;
    const maxMs = typeof so.reconnectMaxMs === 'number' ? so.reconnectMaxMs : 30000;
    /** Consecutive reconnects without a delivered event (backoff exponent and budget). */
    let reconnects = 0;
    /** Events delivered so far (a connection that delivers resets `reconnects`). */
    let delivered = 0;
    /** @type {string|undefined} */
    let lastEventId;
    /** @type {number|undefined} */
    let retryHint;
    /** Registry entry so `abort(tag)` / `abortAll()` / `destroy()` can close this stream. */
    const registration = { tag: so.tag, connecting: false, close: () => close() };
    openStreams.add(registration);

    const push = (event) => {
      if (closed) return;
      delivered += 1;
      const w = waiters.shift();
      if (w) w.resolve({ value: event, done: false });
      else queue.push(event);
    };
    const settleEnd = () => {
      ended = true;
      openStreams.delete(registration);
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (failure && !closed) w.reject(failure);
        else w.resolve({ value: undefined, done: true });
      }
    };

    function parseData(raw) {
      const t = raw.trim();
      if (!t) return raw;
      if (/^[[{"\d-]|^(true|false|null)$/.test(t)) {
        try {
          return JSON.parse(t);
        } catch {
          return raw;
        }
      }
      return raw;
    }

    /** Consume one SSE / NDJSON body; resolves when it ends. */
    async function consume(body, mode) {
      if (!body || !isFn(body.getReader)) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';
      let dataLines = [];
      let eventId;
      const flushSse = () => {
        if (dataLines.length === 0) {
          eventType = '';
          eventId = undefined;
          return;
        }
        const raw = dataLines.join('\n');
        if (eventId !== undefined) lastEventId = eventId;
        push({
          type: eventType || 'message',
          data: parseData(raw),
          id: eventId,
          lastEventId,
          retry: retryHint,
          raw,
        });
        eventType = '';
        dataLines = [];
        eventId = undefined;
      };
      const handleLine = (line) => {
        if (mode === 'ndjson') {
          const t = line.trim();
          if (!t) return;
          let data;
          try {
            data = JSON.parse(t);
          } catch (e) {
            log('warn', 'http.stream: skipping invalid NDJSON line', {
              error: e,
              preview: t.slice(0, 120),
            });
            return;
          }
          push({ type: 'message', data, lastEventId, raw: t });
          return;
        }
        if (line === '') return flushSse();
        if (line.startsWith(':')) return;
        const idx = line.indexOf(':');
        const field = idx === -1 ? line : line.slice(0, idx);
        let value = idx === -1 ? '' : line.slice(idx + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventType = value;
        else if (field === 'data') dataLines.push(value);
        else if (field === 'id') {
          if (!value.includes('\0')) eventId = value;
        } else if (field === 'retry') {
          if (/^\d+$/.test(value)) retryHint = Number(value);
        }
      };
      const onAbort = () => reader.cancel().catch(noop);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
            const sep = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1;
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + sep);
            handleLine(line);
          }
        }
        buffer += decoder.decode();
        if (buffer) handleLine(buffer);
        if (mode === 'sse') flushSse();
      } finally {
        signal.removeEventListener('abort', onAbort);
        reader.releaseLock?.();
      }
    }

    function shouldReconnect(err) {
      if (!reconnect || reconnects >= maxReconnects) return false;
      if (err instanceof AbortError) return false;
      if (err instanceof NetworkError || err instanceof TimeoutError) return true;
      if (err instanceof ApiError) return RETRY_STATUSES.has(err.status) || err.status >= 500;
      return false;
    }

    async function pump() {
      const {
        reconnect: _r,
        maxReconnects: _m,
        reconnectBaseMs: _b,
        reconnectMaxMs: _x,
        method,
        body,
        headers,
        ...rest
      } = so;
      for (;;) {
        if (closed) break;
        /** @type {SdkError | null} */
        let error = null;
        let mode = 'sse';
        const deliveredBefore = delivered;
        registration.connecting = true;
        try {
          const res = await request({
            ...rest,
            method: method || 'GET',
            path,
            body,
            headers: mergeHeaders(
              { Accept: STREAM_ACCEPT },
              lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : undefined,
              headers
            ),
            responseType: 'stream',
            retries: 0,
            cache: false,
            dedupe: false,
            signal,
          });
          registration.connecting = false;
          mode = /text\/event-stream/i.test(res.headers.get('content-type') || '')
            ? 'sse'
            : 'ndjson';
          await consume(res.data, mode);
        } catch (e) {
          error = normaliseErrorForStream(e);
        } finally {
          registration.connecting = false;
        }
        if (closed || signal.aborted) break;
        // A connection that delivered events made progress: backoff and the reconnect budget restart.
        if (delivered > deliveredBefore) reconnects = 0;
        if (error === null) {
          // Clean end: EventSource semantics for SSE (reconnect), a finite document for NDJSON.
          if (mode === 'ndjson' || !reconnect || reconnects >= maxReconnects) break;
        } else if (!shouldReconnect(error)) {
          failure = error;
          break;
        }
        const exp = Math.min(maxMs, baseMs * 2 ** reconnects);
        const delay =
          retryHint !== undefined
            ? Math.min(retryHint, maxMs)
            : Math.round(exp / 2 + (exp / 2) * (Number(random()) || 0));
        reconnects += 1;
        log('debug', 'http.stream: reconnecting', { path, delay, attempt: reconnects, error });
        try {
          await wait(delay, signal);
        } catch {
          break;
        }
      }
      settleEnd();
    }

    /** `request()` already yields SdkErrors; anything else comes from the body read (transport). */
    function normaliseErrorForStream(e) {
      if (isSdkError(e)) return /** @type {SdkError} */ (e);
      if (signal.aborted) return abortErrorFor(signal);
      // A body that dies mid‑stream surfaces as a bare TypeError (`terminated`, `fetch failed`).
      if (e instanceof TypeError)
        return new NetworkError(e.message || 'Network error', { cause: e });
      return wrap(e);
    }

    function close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      if (!closeCtl.signal.aborted)
        closeCtl.abort(new AbortError('Stream closed', { reason: 'closed' }));
      settleEnd();
    }

    /** @type {HttpStream} */
    const iterable = {
      next() {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        if (closed || ended) {
          if (failure && !closed) return Promise.reject(failure);
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      return() {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(e) {
        close();
        return Promise.reject(e);
      },
      close,
      get closed() {
        return closed;
      },
      [Symbol.asyncIterator]() {
        return iterable;
      },
    };
    pump().catch((e) => {
      failure = normaliseErrorForStream(e);
      settleEnd();
    });
    return iterable;
  }

  // ── public: interceptors / hooks ──
  function useBundle(bundle, options = {}) {
    if (!bundle || typeof bundle !== 'object')
      throw invalid('bundle', 'type', 'bundle must be an object');
    const offs = [];
    for (const kind of ['request', 'response', 'error']) {
      const v = bundle[kind];
      if (v === undefined || v === null) continue;
      const list = Array.isArray(v) ? v : [v];
      for (const item of list) {
        if (isFn(item)) offs.push(stages[kind].use(item, options));
        else if (item && isFn(item.fn))
          offs.push(stages[kind].use(item.fn, { ...options, ...item }));
        else throw invalid(`bundle.${kind}`, 'type', 'interceptor must be a function or { fn }');
      }
    }
    return () => offs.forEach((off) => off());
  }

  function hookOn(name, fn) {
    if (!HOOK_NAMES.has(name)) throw invalid('name', 'enum', `unknown hook ${String(name)}`);
    if (!isFn(fn)) throw invalid('fn', 'type', 'hook must be a function');
    if (!hooks.has(name)) hooks.set(name, new Set());
    const set = hooks.get(name);
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  // ── public: headers / config ──
  function setHeader(name, value) {
    if (typeof name !== 'string' || !name.trim())
      throw invalid('name', 'required', 'header name is required');
    if (value === undefined || value === null) {
      defaultHeaders.delete(name.toLowerCase());
      return;
    }
    if (typeof value !== 'string' && !isFn(value))
      throw invalid('value', 'type', 'header value must be a string or a function');
    defaultHeaders.set(name.toLowerCase(), { name, value });
  }
  function removeHeader(name) {
    if (typeof name === 'string') defaultHeaders.delete(name.toLowerCase());
  }
  function setBaseUrl(url) {
    if (typeof url !== 'string') throw invalid('url', 'type', 'baseUrl must be a string');
    baseUrl = url;
  }
  function setFetch(fn) {
    if (fn !== undefined && fn !== null && !isFn(fn))
      throw invalid('fetch', 'type', 'fetch must be a function');
    fetchImpl = fn || undefined;
  }

  // ── public: abort / inflight ──
  /**
   * Abort every in‑flight request whose tag passes `predicate` and close every open stream whose
   * tag does; returns how many were stopped (a stream whose own request was just aborted counts once).
   */
  function abortMatching(predicate, reason, fallback) {
    let count = 0;
    for (const { ctx, controller } of Array.from(inflightSet.values())) {
      if (!predicate(ctx.spec.tag)) continue;
      if (controller.signal.aborted) continue;
      controller.abort(toAbortReason(reason, fallback));
      count += 1;
    }
    for (const stream of Array.from(openStreams)) {
      if (!predicate(stream.tag)) continue;
      if (!stream.connecting) count += 1;
      stream.close();
    }
    return count;
  }
  const abort = (tag, reason) => abortMatching((t) => t === tag, reason, 'aborted');
  const abortAll = (reason) => abortMatching(() => true, reason, 'aborted');
  function inflight(tag) {
    if (tag === undefined) return inflightSet.size;
    let n = 0;
    for (const { ctx } of inflightSet.values()) if (ctx.spec.tag === tag) n += 1;
    return n;
  }

  // ── public: cache ──
  function cacheEntries() {
    /** @type {Array<{ storageKey: string, key: string }>} */
    const out = [];
    try {
      for (const storageKey of store.keys(CACHE_PREFIX)) {
        const entry = store.get(storageKey);
        out.push({ storageKey, key: entry && typeof entry.key === 'string' ? entry.key : '' });
      }
    } catch (e) {
      log('warn', 'http: cache listing failed', { error: e });
    }
    return out;
  }
  const cache = {
    clear(pattern) {
      try {
        if (pattern === undefined || pattern === null) {
          store.clear(CACHE_PREFIX);
          return;
        }
        const matches =
          pattern instanceof RegExp ? (k) => pattern.test(k) : (k) => k.includes(String(pattern));
        for (const { storageKey, key } of cacheEntries())
          if (matches(key)) store.remove(storageKey);
      } catch (e) {
        log('warn', 'http: cache clear failed', { error: e });
      }
    },
    invalidate(key) {
      if (typeof key !== 'string' || !key)
        throw invalid('key', 'required', 'cache key is required');
      try {
        store.remove(cacheStorageKey(key));
      } catch (e) {
        log('warn', 'http: cache invalidate failed', { error: e });
      }
    },
  };

  function destroy() {
    if (destroyed) return;
    abortAll('destroyed'); // requests and open streams (their reconnect timers go with them)
    destroyed = true;
    for (const stage of Object.values(stages)) stage.clear();
    hooks.clear();
    inflightByKey.clear();
    openStreams.clear();
  }

  /** @type {Http} */
  const http = {
    request,
    get: sugar('GET', false),
    post: sugar('POST', true),
    put: sugar('PUT', true),
    patch: sugar('PATCH', true),
    delete: sugar('DELETE', false),
    download,
    upload,
    stream,
    interceptors: {
      request: { use: stages.request.use },
      response: { use: stages.response.use },
      error: { use: stages.error.use },
    },
    use: useBundle,
    hooks: { on: hookOn },
    setHeader,
    removeHeader,
    setBaseUrl,
    setFetch,
    abort,
    abortAll,
    cache,
    inflight,
    lastRequestId: () => lastId,
    destroy,
  };
  return http;
}

/**
 * The HTTP client returned by `createHttp` (docs/api/01-core.md §3).
 * @typedef {Object} Http
 * @property {<T = unknown>(spec: RequestSpec) => Promise<HttpResult<T>>} request  Run the full lifecycle.
 * @property {<T = unknown>(path: string, opts?: RequestOpts) => Promise<HttpResult<T>>} get
 * @property {<T = unknown>(path: string, body?: unknown, opts?: RequestOpts) => Promise<HttpResult<T>>} post
 * @property {<T = unknown>(path: string, body?: unknown, opts?: RequestOpts) => Promise<HttpResult<T>>} put
 * @property {<T = unknown>(path: string, body?: unknown, opts?: RequestOpts) => Promise<HttpResult<T>>} patch
 * @property {<T = unknown>(path: string, opts?: RequestOpts) => Promise<HttpResult<T>>} delete
 * @property {(path: string, opts?: RequestOpts & { method?: string }) => Promise<Blob>} download  `responseType: 'blob'` helper.
 * @property {(path: string, formData: unknown, opts?: RequestOpts & { method?: string, onProgress?: (p: { loaded: number, total?: number, lengthComputable: boolean }) => void }) => Promise<HttpResult<unknown>>} upload  Multipart helper; `onProgress` is best‑effort (start / completion), `fetch` exposes no upload progress.
 * @property {(path: string, opts?: StreamOpts) => HttpStream} stream  SSE / NDJSON stream with reconnect.
 * @property {{ request: { use: (fn: RequestInterceptor, options?: InterceptorOptions) => () => void }, response: { use: (fn: ResponseInterceptor, options?: InterceptorOptions) => () => void }, error: { use: (fn: ErrorInterceptor, options?: InterceptorOptions) => () => void } }} interceptors
 * @property {(bundle: InterceptorBundle, options?: InterceptorOptions) => () => void} use  Register a bundle; the returned `off` removes all of it.
 * @property {{ on: (name: HookName, fn: HookFn) => () => void }} hooks  Observe‑only taps.
 * @property {(name: string, value: string | (() => string | undefined | null)) => void} setHeader
 * @property {(name: string) => void} removeHeader
 * @property {(url: string) => void} setBaseUrl
 * @property {(fn: typeof fetch | undefined) => void} setFetch
 * @property {(tag: string, reason?: unknown) => number} abort  Abort in‑flight requests with `tag` (their promises reject with `AbortError`) and close open streams with `tag`; returns the count.
 * @property {(reason?: unknown) => number} abortAll  Same for every request and stream.
 * @property {{ clear: (pattern?: string | RegExp) => void, invalidate: (key: string) => void }} cache
 * @property {(tag?: string) => number} inflight
 * @property {() => string | undefined} lastRequestId
 * @property {() => void} destroy  Abort every request, close every stream (no timer survives), drop interceptors and hooks; later requests reject with `AbortError`.
 */
