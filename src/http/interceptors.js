/**
 * Built‑in interceptor factories of the Wayfarer HTTP client (docs/api/01-core.md §4). Every factory
 * returns a bundle `{ name, priority, priorities, request?, response?, error? }` that `http.use(bundle)`
 * consumes (or `http.interceptors.<stage>.use(fn, { priority, name })`, stage by stage), and
 * `installDefaultInterceptors(http, deps)` installs the documented default set in the documented order.
 * Interceptors only touch the spec / response / error they are handed, the `ctx.meta` map and the
 * storage they were given: they never call `fetch`, never emit events, never log outside the injected
 * logger, keep no module‑level mutable state and look `document` / timers up at call time only
 * (SSR‑safe). Response‑stage handlers mutate the response in place and return `undefined`, so the
 * client keeps the very object (and fields such as `raw`) instead of re‑wrapping a returned copy;
 * delayed retries go through `ctx.retry({ delayMs })`, so the client owns the timer and `http:retry`
 * carries the real delay. Plain `Error`s are never thrown: bad options raise `ConfigError`, an
 * aborted wait raises `AbortError`, and backend failures become the `ApiError` family through
 * `errors.errorFromResponse`.
 */

import {
  AbortError,
  ApiError,
  ConfigError,
  errorFromResponse,
  isSdkError,
} from '../errors/index.js';
import {
  idempotencyKey as makeIdempotencyKey,
  requestId as makeRequestId,
  uuid,
} from '../utils/id.js';
import { isPlainObject, stableStringify } from '../utils/object.js';
import { withParams } from '../utils/url.js';

/** @typedef {import('../types.js').RequestSpec} RequestSpec */
/** @typedef {import('../types.js').HttpContext} HttpContext */
/** @typedef {import('../types.js').HttpResponse<unknown>} HttpResponse */
/** @typedef {import('../types.js').RequestInterceptor} RequestInterceptor */
/** @typedef {import('../types.js').ResponseInterceptor} ResponseInterceptor */
/** @typedef {import('../types.js').ErrorInterceptor} ErrorInterceptor */
/** @typedef {import('../errors/index.js').ProblemContext} ProblemContext */

/**
 * What every factory returns; `http.use(bundle)` registers the stages it carries.
 * @typedef {Object} InterceptorBundle
 * @property {string} name                       interceptor name (`'auth'`, `'cache'`, …)
 * @property {number} priority                   primary priority (the request stage when present)
 * @property {{ request?: number, response?: number, error?: number }} priorities per‑stage priorities
 * @property {RequestInterceptor} [request]      request stage handler
 * @property {ResponseInterceptor} [response]    response stage handler
 * @property {ErrorInterceptor} [error]          error stage handler
 */

/**
 * Storage duck type: the `createStorage()` facade or anything with the same reads / writes.
 * @typedef {{ get: (key: string) => any, set: (key: string, value: unknown, options?: { ttlMs?: number }) => void, remove?: (key: string) => void, keys?: (prefix?: string) => string[] }} StorageLike
 */

/**
 * Injectable timers (defaults to the global ones, resolved at call time).
 * @typedef {{ setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} TimersLike
 */

/**
 * Auth duck type consumed by `authInterceptor` (`auth/session.js` satisfies it).
 * @typedef {{ getAccessToken: () => string|null|undefined, getGuestToken?: () => string|null|undefined, isGuest?: () => boolean, refresh?: () => Promise<unknown> }} AuthLike
 */

/**
 * One dev‑mode mock handler for `mockInterceptor`.
 * @typedef {Object} MockHandler
 * @property {string} [method]        HTTP method; omitted or `'*'` matches any
 * @property {string|RegExp} path     exact path, `:param` template, or RegExp tested against the path (then the url)
 * @property {(spec: RequestSpec, match: { params: Record<string, string>, ctx?: HttpContext }) => ({ status?: number, body?: unknown, headers?: Record<string, string> } | Promise<{ status?: number, body?: unknown, headers?: Record<string, string> }>)} reply builds the reply
 */

/**
 * Default priorities per stage; lower runs first (docs/api/01-core.md §4 "Default installation order").
 * Stages the doc leaves open (cache / dedupe / logging / telemetry after the response or error) reuse
 * their request priority so envelope → problem always run before them.
 * @type {Readonly<{ request: Readonly<Record<string, number>>, response: Readonly<Record<string, number>>, error: Readonly<Record<string, number>> }>}
 */
export const DEFAULT_PRIORITIES = Object.freeze({
  request: Object.freeze({
    mock: 0,
    correlation: 10,
    apiKey: 20,
    locale: 30,
    device: 35,
    csrf: 40,
    auth: 50,
    idempotency: 60,
    cache: 70,
    dedupe: 80,
    logging: 90,
    telemetry: 95,
  }),
  response: Object.freeze({
    envelope: 10,
    problem: 20,
    cache: 70,
    dedupe: 80,
    logging: 90,
    telemetry: 95,
  }),
  error: Object.freeze({
    problem: 10,
    correlation: 15,
    auth: 20,
    rateLimit: 30,
    dedupe: 80,
    logging: 90,
    telemetry: 95,
  }),
});

// ── constants ───────────────────────────────────────────────────────────────────────────────────

const STAGES = /** @type {const} */ (['request', 'response', 'error']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROBLEM_TYPE = /application\/problem\+json/i;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * `ctx.meta` keys of the cross‑stage bookkeeping. The client copies `ctx.meta` into
 * `response.meta`, so nothing secret (tokens) is ever kept here and `stripMeta()` removes these
 * keys before a response's `meta` is persisted.
 */
const META = Object.freeze({
  authRetried: 'auth:retried',
  cacheKey: 'cache:key',
  correlationId: 'correlation:id',
  dedupeKey: 'dedupe:key',
  dedupeFollower: 'dedupe:follower',
  idempotencyKey: 'idempotency:key',
  rateLimitRetries: 'rateLimit:retries',
  telemetryStart: 'telemetry:startedAt',
});
const DEFAULT_REDACT = Object.freeze(['authorization', 'password', 'card', 'documents']);
const REDACTED = '[redacted]';
/** Resolution of a dedupe deferred that tells followers to issue their own request instead. */
const DEDUPE_RELEASED = Symbol('dedupe:released');

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {string|undefined} */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @param {unknown} v @returns {v is number} */
function isPositive(v) {
  return isFiniteNumber(v) && v > 0;
}

/** @param {(() => number)|undefined} now @returns {number} */
function nowMs(now) {
  if (typeof now === 'function') {
    const t = Number(now());
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/**
 * Run `fn`, returning `fallback` instead of throwing (storage / host callbacks must never break a
 * request).
 * @template T
 * @param {() => T} fn
 * @param {T} [fallback]
 * @returns {T|undefined}
 */
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** @param {string} factory @param {string} message @param {unknown} [details] @returns {ConfigError} */
function configError(factory, message, details) {
  return new ConfigError(`${factory}: ${message}`, details === undefined ? {} : { details });
}

/** @param {unknown} v @returns {v is object} */
function isObjectLike(v) {
  return typeof v === 'object' && v !== null;
}

/** `Headers`‑like: has `get()` and `forEach()`. @param {unknown} v @returns {v is Headers} */
function isHeadersLike(v) {
  return (
    isObjectLike(v) &&
    typeof (/** @type {any} */ (v).get) === 'function' &&
    typeof (/** @type {any} */ (v).forEach) === 'function'
  );
}

/** @param {unknown} spec @returns {string} upper‑case method, `GET` by default */
function methodOf(spec) {
  const m = isObjectLike(spec) ? /** @type {any} */ (spec).method : undefined;
  return String(m || 'GET').toUpperCase();
}

/** @param {unknown} spec @returns {string} `url` or `path` plus the extra `query` */
function urlOf(spec) {
  if (!isObjectLike(spec)) return '';
  const s = /** @type {any} */ (spec);
  const base = String(s.url || s.path || '');
  return isPlainObject(s.query) && Object.keys(s.query).length ? withParams(base, s.query) : base;
}

/** @param {unknown} spec @returns {string} path without query / fragment (absolute urls → pathname) */
function pathnameOf(spec) {
  if (!isObjectLike(spec)) return '';
  const s = /** @type {any} */ (spec);
  const raw = String(s.url || s.path || '');
  if (ABSOLUTE_URL.test(raw) || raw.startsWith('//')) {
    const parsed = safe(() => new URL(raw.startsWith('//') ? `https:${raw}` : raw));
    if (parsed) return parsed.pathname;
  }
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * Case‑insensitive header read over a plain object, a `Map` or a `Headers`.
 * @param {unknown} headers
 * @param {string} name
 * @returns {string|undefined}
 */
function headerOf(headers, name) {
  if (!isObjectLike(headers)) return undefined;
  const lower = name.toLowerCase();
  const h = /** @type {any} */ (headers);
  if (typeof h.get === 'function') {
    const v = safe(() => h.get(name) ?? h.get(lower));
    return v === null || v === undefined ? undefined : String(v);
  }
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower && v !== undefined && v !== null) {
      return String(Array.isArray(v) ? v[0] : v);
    }
  }
  return undefined;
}

/** @param {unknown} headers @returns {Record<string, string>} plain copy of any header container */
function headersToObject(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isObjectLike(headers)) return out;
  const h = /** @type {any} */ (headers);
  if (typeof h.forEach === 'function') {
    safe(() => h.forEach((value, key) => (out[String(key)] = String(value))));
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined && v !== null) out[k] = String(Array.isArray(v) ? v.join(', ') : v);
  }
  return out;
}

/** @param {unknown} headers @returns {Headers|Record<string, string>} a `Headers` when the runtime has one */
function toHeaders(headers) {
  if (isHeadersLike(headers)) return /** @type {Headers} */ (headers);
  const obj = headersToObject(headers);
  if (typeof Headers === 'function') {
    const made = safe(() => new Headers(obj));
    if (made) return made;
  }
  return obj;
}

/**
 * `spec.headers` as a plain object, created when missing; a `Headers` / `Map` container is copied
 * into a plain object first so the caller's headers survive.
 * @param {RequestSpec} spec
 * @returns {Record<string, string>}
 */
function ensureHeaders(spec) {
  if (!isPlainObject(spec.headers)) {
    spec.headers = isObjectLike(spec.headers) ? headersToObject(spec.headers) : {};
  }
  return /** @type {Record<string, string>} */ (spec.headers);
}

/** @param {unknown} headers @returns {Headers|Record<string, string>} an independent copy (own `Headers` when the runtime has one) */
function copyHeaders(headers) {
  const obj = headersToObject(headers);
  if (typeof Headers === 'function') {
    const made = safe(() => new Headers(obj));
    if (made) return made;
  }
  return obj;
}

/** @param {unknown} spec @param {string} name @returns {boolean} */
function hasHeader(spec, name) {
  return isObjectLike(spec) && headerOf(/** @type {any} */ (spec).headers, name) !== undefined;
}

/**
 * Write a header on the spec (replacing any differently‑cased duplicate) and mirror it through
 * `ctx.setHeader` when the client offers one.
 * @param {RequestSpec} spec
 * @param {HttpContext|undefined} ctx
 * @param {string} name
 * @param {string} value
 */
function applyHeader(spec, ctx, name, value) {
  const headers = ensureHeaders(spec);
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k !== name && k.toLowerCase() === lower) delete headers[k];
  }
  headers[name] = value;
  if (ctx && typeof ctx.setHeader === 'function') {
    safe(() => /** @type {HttpContext} */ (ctx).setHeader(name, value));
  }
}

/**
 * Delete a header from the spec (any casing) and mirror the removal through `ctx.setHeader(name,
 * undefined)` when the client offers one.
 * @param {RequestSpec} spec
 * @param {HttpContext|undefined} ctx
 * @param {string} name
 */
function removeHeader(spec, ctx, name) {
  if (!isObjectLike(spec)) return;
  const headers = /** @type {any} */ (spec).headers;
  if (isPlainObject(headers)) {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) delete headers[k];
  } else if (isObjectLike(headers) && typeof (/** @type {any} */ (headers).delete) === 'function') {
    safe(() => /** @type {any} */ (headers).delete(name));
  }
  if (ctx && typeof ctx.setHeader === 'function') {
    safe(() => /** @type {any} */ (ctx).setHeader(name, undefined));
  }
}

/**
 * Set a header unless the caller already supplied one (caller headers always win).
 * @param {RequestSpec} spec
 * @param {HttpContext|undefined} ctx
 * @param {string} name
 * @param {unknown} value
 * @returns {boolean} whether the header was written
 */
function setHeaderIfAbsent(spec, ctx, name, value) {
  if (!isObjectLike(spec) || value === undefined || value === null || value === '') return false;
  if (hasHeader(spec, name)) return false;
  applyHeader(spec, ctx, name, String(value));
  return true;
}

/** @param {unknown} ctx @param {string} key @returns {unknown} */
function metaGet(ctx, key) {
  if (!isObjectLike(ctx)) return undefined;
  const m = /** @type {any} */ (ctx).meta;
  if (m instanceof Map) return m.get(key);
  if (isPlainObject(m)) return m[key];
  return undefined;
}

const META_KEYS = new Set(Object.values(META));

/** @param {unknown} meta @returns {Record<string, unknown>|undefined} `meta` without the interceptors' bookkeeping keys */
function stripMeta(meta) {
  if (!isPlainObject(meta)) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(meta)) if (!META_KEYS.has(k)) out[k] = v;
  return out;
}

/** @param {unknown} ctx @param {string} key @param {unknown} value */
function metaSet(ctx, key, value) {
  if (!isObjectLike(ctx)) return;
  const c = /** @type {any} */ (ctx);
  if (c.meta instanceof Map) {
    c.meta.set(key, value);
    return;
  }
  if (isPlainObject(c.meta)) {
    c.meta[key] = value;
    return;
  }
  safe(() => {
    c.meta = new Map([[key, value]]);
  });
}

/**
 * Build an `HttpResponse` for a short‑circuit (cache hit, mock, dedupe).
 * @param {{ data: unknown, status: number, headers: unknown, ctx?: HttpContext, fromCache: boolean, extra?: Record<string, unknown> }} parts
 * @returns {HttpResponse}
 */
function makeResponse({ data, status, headers, ctx, fromCache, extra }) {
  const attempt = isObjectLike(ctx) ? Number(/** @type {any} */ (ctx).attempt) : NaN;
  const response = {
    data,
    status: isFiniteNumber(status) ? status : 200,
    headers: toHeaders(headers),
    requestId: str(isObjectLike(ctx) ? /** @type {any} */ (ctx).id : undefined),
    fromCache,
    attempts: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    durationMs: 0,
    ...(isPlainObject(extra) ? extra : {}),
  };
  return /** @type {HttpResponse} */ (/** @type {unknown} */ (response));
}

/** @param {AbortSignal|undefined} signal @returns {AbortError} */
function abortError(signal) {
  const reason = signal && /** @type {any} */ (signal).reason;
  return new AbortError('Request aborted while waiting', {
    reason: typeof reason === 'string' ? reason : 'aborted',
    cause: reason,
  });
}

/**
 * Resolve after `ms` through the injectable timers; reject with `AbortError` (and clear the timer)
 * when `signal` aborts first.
 * @param {number} ms
 * @param {TimersLike|undefined} timers
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function wait(ms, timers, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const host = timers && typeof timers.setTimeout === 'function' ? timers : globalThis;
    const set = /** @type {typeof setTimeout} */ (host.setTimeout);
    const clear = /** @type {typeof clearTimeout} */ (
      typeof host.clearTimeout === 'function' ? host.clearTimeout : globalThis.clearTimeout
    );
    const listen = signal && typeof signal.addEventListener === 'function';
    const onAbort = () => {
      clear.call(host, timer);
      reject(abortError(signal));
    };
    const timer = set.call(
      host,
      () => {
        if (listen) /** @type {AbortSignal} */ (signal).removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms)
    );
    if (listen)
      /** @type {AbortSignal} */ (signal).addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Stable text of a JSON‑able body for cache / dedupe identity: `''` for none, the string itself,
 * `stableStringify` for plain data; `undefined` for bodies that have no stable text (binary,
 * multipart, streams, cycles), which are never cached or deduped.
 * @param {unknown} body
 * @returns {string|undefined}
 */
function bodyKeyOf(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'number' || typeof body === 'boolean') return String(body);
  if (isPlainObject(body) || Array.isArray(body)) return safe(() => stableStringify(body));
  return undefined;
}

/**
 * Cache / dedupe identity parts: method, url(+query), `Accept-Language`, `X-Currency` and the body
 * text (`''` for GET‑like requests); `undefined` when the body cannot be keyed.
 * @param {unknown} spec
 * @returns {{ method: string, url: string, lang: string, currency: string, body: string }|undefined}
 */
function identityPartsOf(spec) {
  const s = isObjectLike(spec) ? /** @type {any} */ (spec) : {};
  const body = bodyKeyOf(s.body);
  if (body === undefined) return undefined;
  return {
    method: methodOf(spec),
    url: urlOf(spec),
    lang: headerOf(s.headers, 'Accept-Language') || '',
    currency: headerOf(s.headers, 'X-Currency') || '',
    body,
  };
}

/**
 * Cache / dedupe identity: `<METHOD> <url+query>|<Accept-Language>|<X-Currency>` plus `|<body>` when
 * the request carries one; `undefined` when the body cannot be keyed.
 * @param {unknown} spec
 * @returns {string|undefined}
 */
function identityOf(spec) {
  const p = identityPartsOf(spec);
  if (!p) return undefined;
  return `${p.method} ${p.url}|${p.lang}|${p.currency}${p.body ? `|${p.body}` : ''}`;
}

/**
 * Normalise an `exclude` list (RegExp or string prefixes).
 * @param {unknown} exclude
 * @param {string} factory
 * @returns {Array<RegExp|string>}
 */
function normaliseExclude(exclude, factory) {
  if (exclude === undefined || exclude === null) return [];
  if (!Array.isArray(exclude)) throw configError(factory, '`exclude` must be an array of RegExp');
  return exclude.map((e, i) => {
    if (e instanceof RegExp || typeof e === 'string') return e;
    throw configError(factory, `exclude[${i}] must be a RegExp or a string prefix`);
  });
}

/** @param {Array<RegExp|string>} list @param {unknown} spec @returns {boolean} */
function isExcluded(list, spec) {
  if (!list.length || !isObjectLike(spec)) return false;
  const s = /** @type {any} */ (spec);
  const candidates = [s.path, s.url, pathnameOf(spec)].filter((c) => typeof c === 'string' && c);
  return list.some((rule) =>
    candidates.some((c) => {
      if (rule instanceof RegExp) {
        rule.lastIndex = 0;
        return rule.test(c);
      }
      return c === rule || c.startsWith(rule);
    })
  );
}

/**
 * Assemble a bundle: priorities come from `DEFAULT_PRIORITIES` for the stages present; `priority`
 * is the request one (falling back to error, then response).
 * @param {string} name
 * @param {Record<string, unknown>} handlers
 * @returns {InterceptorBundle & Record<string, unknown>}
 */
function bundle(name, handlers) {
  /** @type {{ request?: number, response?: number, error?: number }} */
  const priorities = {};
  for (const stage of STAGES) {
    if (typeof handlers[stage] === 'function') priorities[stage] = DEFAULT_PRIORITIES[stage][name];
  }
  const priority = priorities.request ?? priorities.error ?? priorities.response ?? 50;
  return { name, priority, priorities, ...handlers };
}

/** `Retry-After` (delta seconds or HTTP date) → ms. @param {unknown} value @param {number} now @returns {number|undefined} */
function parseRetryAfter(value, now) {
  const v = str(value)?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Status of a failure: the error's own, else the raw response's. @param {unknown} err @param {unknown} ctx @returns {number} */
function statusOf(err, ctx) {
  const own = isObjectLike(err) ? Number(/** @type {any} */ (err).status) : NaN;
  if (Number.isFinite(own) && own > 0) return own;
  const res = isObjectLike(ctx) ? /** @type {any} */ (ctx).response : undefined;
  const fromResponse = isObjectLike(res) ? Number(/** @type {any} */ (res).status) : NaN;
  return Number.isFinite(fromResponse) ? fromResponse : 0;
}

/**
 * Deep copy with the values of matching keys replaced (`isSecret(key)` decides); header containers
 * become plain objects, other exotic objects their tag; `__proto__` keys are dropped so untrusted
 * bodies cannot reshape the log record.
 * @param {unknown} value
 * @param {(key: string) => boolean} isSecret
 * @param {WeakSet<object>} [seen]
 * @param {number} [depth]
 * @returns {unknown}
 */
function redactDeep(value, isSecret, seen = new WeakSet(), depth = 0) {
  if (!isObjectLike(value)) return value;
  if (depth > 10) return '[depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, isSecret, seen, depth + 1));
  const source = isHeadersLike(value) || value instanceof Map ? headersToObject(value) : value;
  if (!isPlainObject(source)) {
    const ctor = /** @type {any} */ (source).constructor;
    return `[${(ctor && ctor.name) || 'object'}]`;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === '__proto__') continue;
    out[k] = isSecret(k) ? REDACTED : redactDeep(v, isSecret, seen, depth + 1);
  }
  return out;
}

/** @param {string} name @returns {string|undefined} value of the cookie, read from `document.cookie` now */
function readCookie(name) {
  const doc = /** @type {any} */ (globalThis).document;
  const raw = doc && typeof doc.cookie === 'string' ? doc.cookie : '';
  if (!raw) return undefined;
  const decode = (/** @type {string} */ s) => safe(() => decodeURIComponent(s), s);
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    const key = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (key !== name && decode(key) !== name) continue;
    const value = (eq === -1 ? '' : part.slice(eq + 1)).trim();
    return decode(value);
  }
  return undefined;
}

/**
 * Match a string mock path (`/v1/trips/:id`) against a pathname; `*` matches one segment.
 * @param {string} pattern
 * @param {string} pathname
 * @returns {Record<string, string>|null} captured params, or null when it does not match
 */
function matchPath(pattern, pathname) {
  if (pattern === pathname) return {};
  const want = pattern.split('/');
  const have = pathname.split('/');
  if (want.length !== have.length) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const h = have[i];
    if (w.startsWith(':') && w.length > 1) {
      if (!h) return null;
      params[w.slice(1)] = safe(() => decodeURIComponent(h), h) ?? h;
    } else if (w !== '*' && w !== h) {
      return null;
    }
  }
  return params;
}

/** A tiny `StorageLike` over a `Map`, used when no storage was given. @returns {StorageLike} */
function memoryStorage() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: (prefix) => Array.from(map.keys()).filter((k) => !prefix || String(k).startsWith(prefix)),
  };
}

/** @param {unknown} v @returns {v is StorageLike} */
function isStorageLike(v) {
  return (
    isObjectLike(v) &&
    typeof (/** @type {any} */ (v).get) === 'function' &&
    typeof (/** @type {any} */ (v).set) === 'function'
  );
}

// ── factories ───────────────────────────────────────────────────────────────────────────────────

/**
 * Attach credentials and recover from `401` once per request.
 * Request stage: `Authorization: Bearer <token>` from `auth.getAccessToken()`, else `X-Guest-Token`
 * (`guestHeader`) from `auth.getGuestToken()` while `auth.isGuest()`; skipped when `spec.auth ===
 * false` or the path is excluded; caller‑supplied credentials win (and are left alone on 401); also
 * injects `ctx.auth = { getToken, refresh }`. Error stage, on a 401 (not excluded, not `auth: false`,
 * at most once per request): when the session's credentials already differ from the ones sent
 * (another request refreshed them meanwhile) the request is retried with them straight away;
 * otherwise `auth.refresh()` runs single‑flight (one refresh shared by every concurrent 401 and by
 * `ctx.auth.refresh()`). Either way the credentials written on `ctx.spec` are replaced by the fresh
 * ones before `return ctx.retry()` — the retry re‑enters at the cache / dedupe stage, so the request
 * stage does not run again. When the refresh throws the original error is rethrown. Clearing the
 * session and emitting `auth:expired` on a failed refresh is `auth.refresh()`'s own job.
 * Effects: none of its own (the retry is a new attempt of the same request).
 * @param {{ auth: AuthLike, exclude?: Array<RegExp|string>, guestHeader?: string }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `auth` does not expose `getAccessToken()` or `exclude` is malformed
 */
export function authInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const auth = /** @type {AuthLike} */ (o.auth);
  if (!isObjectLike(auth) || typeof auth.getAccessToken !== 'function') {
    throw configError('authInterceptor', '`auth` must expose getAccessToken()');
  }
  const excluded = normaliseExclude(o.exclude, 'authInterceptor');
  const guestHeader = str(o.guestHeader) || 'X-Guest-Token';
  const skip = (/** @type {unknown} */ spec) =>
    (isObjectLike(spec) && /** @type {any} */ (spec).auth === false) || isExcluded(excluded, spec);
  /** The refresh every concurrent 401 shares; released once it settles. @type {Promise<unknown>|null} */
  let refreshing = null;
  /**
   * The credentials this bundle wrote per request, keyed by `ctx` (never in `ctx.meta`: the client
   * copies that map into `response.meta`, which the cache persists).
   * @type {WeakMap<object, { header: string, value: string }>}
   */
  const sent = new WeakMap();

  const refreshShared = () => {
    if (typeof auth.refresh !== 'function') {
      return Promise.reject(configError('authInterceptor', '`auth.refresh()` is not available'));
    }
    if (refreshing) return refreshing;
    const shared = Promise.resolve()
      .then(() => /** @type {() => Promise<unknown>} */ (auth.refresh)())
      .finally(() => {
        if (refreshing === shared) refreshing = null;
      });
    shared.catch(() => {}); // every awaiter handles its own rejection
    refreshing = shared;
    return shared;
  };

  /** Credentials the session offers right now: `[header, value]`, or `undefined` when anonymous. @returns {[string, string]|undefined} */
  const credentialsFor = () => {
    const token = str(safe(() => auth.getAccessToken()));
    if (token) return ['Authorization', `Bearer ${token}`];
    const guestToken =
      typeof auth.getGuestToken === 'function' ? str(safe(() => auth.getGuestToken())) : undefined;
    const isGuest =
      typeof auth.isGuest === 'function'
        ? safe(() => /** @type {() => boolean} */ (auth.isGuest)()) === true
        : guestToken !== undefined;
    return isGuest && guestToken ? [guestHeader, guestToken] : undefined;
  };

  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (isObjectLike(ctx) && !(/** @type {any} */ (ctx).auth)) {
      safe(() => {
        /** @type {any} */ (ctx).auth = {
          getToken: () => str(safe(() => auth.getAccessToken())) ?? null,
          refresh: refreshShared,
        };
      });
    }
    if (!isObjectLike(spec) || skip(spec)) return spec;
    const creds = credentialsFor();
    if (creds && setHeaderIfAbsent(spec, ctx, creds[0], creds[1]) && isObjectLike(ctx)) {
      sent.set(ctx, { header: creds[0], value: creds[1] });
    }
    return spec;
  };

  /** @type {ErrorInterceptor} */
  const error = async (err, ctx) => {
    if (statusOf(err, ctx) !== 401) return undefined;
    if (!isObjectLike(ctx) || typeof ctx.retry !== 'function') return undefined;
    if (skip(ctx.spec)) return undefined;
    if (metaGet(ctx, META.authRetried)) return undefined;
    const written = sent.get(ctx);
    const callerSupplied =
      written === undefined &&
      (hasHeader(ctx.spec, 'Authorization') || hasHeader(ctx.spec, guestHeader));
    if (callerSupplied) return undefined;
    let creds = credentialsFor();
    const changed = creds !== undefined && creds[1] !== written?.value;
    if (!changed && typeof auth.refresh !== 'function') return undefined;
    metaSet(ctx, META.authRetried, true);
    if (!changed) {
      try {
        await refreshShared();
      } catch {
        throw err;
      }
      creds = credentialsFor();
    }
    if (written && (!creds || creds[0] !== written.header)) {
      removeHeader(ctx.spec, ctx, written.header);
    }
    if (creds) {
      applyHeader(ctx.spec, ctx, creds[0], creds[1]);
      sent.set(ctx, { header: creds[0], value: creds[1] });
    } else {
      sent.delete(ctx);
    }
    return ctx.retry();
  };

  return bundle('auth', { request, error });
}

/**
 * Add the public partner key header (`X-Api-Key` by default) unless the caller set one.
 * Effects: none.
 * @param {{ key: string, header?: string }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `key` is not a non‑empty string
 */
export function apiKeyInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const key = str(o.key);
  if (!key) throw configError('apiKeyInterceptor', '`key` must be a non-empty string');
  const header = str(o.header) || 'X-Api-Key';
  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    setHeaderIfAbsent(spec, ctx, header, key);
    return spec;
  };
  return bundle('apiKey', { request });
}

/**
 * `Accept-Language`, `X-Currency` and `X-Market` from the `prefs` slice (`store.get('prefs.locale')`
 * …, falling back to `store.get('prefs')`), read on every request so `client.setLocale()` takes
 * effect immediately; empty prefs add nothing and caller headers win. Effects: none.
 * @param {{ store: { get: (path: string) => unknown } }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `store.get` is missing
 */
export function localeInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const store = /** @type {{ get: (path: string) => unknown }} */ (o.store);
  if (!isObjectLike(store) || typeof store.get !== 'function') {
    throw configError('localeInterceptor', '`store` must expose get(path)');
  }
  const pref = (/** @type {string} */ name) => {
    const direct = safe(() => store.get(`prefs.${name}`));
    if (str(direct)) return direct;
    const prefs = safe(() => store.get('prefs'));
    return isPlainObject(prefs) ? str(prefs[name]) : undefined;
  };
  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    setHeaderIfAbsent(spec, ctx, 'Accept-Language', pref('locale'));
    setHeaderIfAbsent(spec, ctx, 'X-Currency', pref('currency'));
    setHeaderIfAbsent(spec, ctx, 'X-Market', pref('market'));
    return spec;
  };
  return bundle('locale', { request });
}

/**
 * Correlation headers: `X-Request-Id` = `ctx.id` (a fresh `requestId()` without one) and a per‑tab
 * `X-Client-Session` id created once and persisted under `clientSession` in `storage` (memory when
 * no storage is given). Error stage: echoes the server's `X-Request-Id` (else `ctx.id`) into
 * `error.requestId`. Effects: storage `clientSession`.
 * @param {{ header?: string, sessionHeader?: string, storage?: StorageLike, storageKey?: string }} [options]
 * @returns {InterceptorBundle}
 */
export function correlationInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  const header = str(o.header) || 'X-Request-Id';
  const sessionHeader = str(o.sessionHeader) || 'X-Client-Session';
  const storageKey = str(o.storageKey) || 'clientSession';
  const storage = isStorageLike(o.storage) ? o.storage : undefined;
  /** @type {string|undefined} */
  let memorySession;

  const sessionId = () => {
    if (storage) {
      const existing = str(safe(() => storage.get(storageKey)));
      if (existing) {
        memorySession = existing;
        return existing;
      }
    }
    if (!memorySession) memorySession = uuid();
    if (storage) safe(() => storage.set(storageKey, memorySession));
    return memorySession;
  };

  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (!isObjectLike(spec)) return spec;
    const id =
      str(isObjectLike(ctx) ? ctx.id : undefined) ||
      str(/** @type {any} */ (spec).requestId) ||
      makeRequestId();
    metaSet(ctx, META.correlationId, id);
    setHeaderIfAbsent(spec, ctx, header, id);
    setHeaderIfAbsent(spec, ctx, sessionHeader, sessionId());
    return spec;
  };

  /** @type {ErrorInterceptor} */
  const error = (err, ctx) => {
    if (!isObjectLike(err)) return undefined;
    const e = /** @type {any} */ (err);
    const response = isObjectLike(ctx) ? ctx.response : undefined;
    const fromServer = headerOf(isObjectLike(response) ? response.headers : undefined, header);
    const id = fromServer || str(e.requestId) || str(isObjectLike(ctx) ? ctx.id : undefined);
    if (id && e.requestId !== id) {
      safe(() => {
        e.requestId = id;
      });
    }
    return undefined;
  };

  return bundle('correlation', { request, error });
}

/**
 * `Idempotency-Key` for POST / PUT / PATCH / DELETE when `spec.idempotencyKey` is set: a string is
 * used as is, `true` derives `utils/id.idempotencyKey(path(+query), body)` (same path, query and
 * structurally equal body → same key, so a retried create is recognised and two creates that differ
 * only by query are not). GET / HEAD / OPTIONS and an existing header are left alone. Effects: none.
 * @param {{ header?: string }} [options]
 * @returns {InterceptorBundle}
 */
export function idempotencyInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  const header = str(o.header) || 'Idempotency-Key';
  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (!isObjectLike(spec) || SAFE_METHODS.has(methodOf(spec))) return spec;
    const s = /** @type {any} */ (spec);
    const wanted = s.idempotencyKey;
    if (hasHeader(spec, header)) return spec;
    /** @type {string|undefined} */
    let key;
    if (typeof wanted === 'string' && wanted.trim() !== '') key = wanted;
    else if (wanted === true) key = makeIdempotencyKey(urlOf(spec) || methodOf(spec), s.body);
    if (!key) return spec;
    applyHeader(spec, ctx, header, key);
    metaSet(ctx, META.idempotencyKey, key);
    return spec;
  };
  return bundle('idempotency', { request });
}

/**
 * Unwrap `{ data, meta, dictionaries }` envelopes in place (only when the body is a plain object
 * with a `data` key, once per response object — a retry's response is a new object and is unwrapped
 * too): `response.data = body.data`, `response.meta = { ...meta, dictionaries }` (merged over any
 * existing `response.meta`), the untouched envelope on `response.raw` for the adapters. Returns
 * `undefined` so the client keeps the same response object. Effects: none.
 * @param {{ dataKey?: string, metaKey?: string, dictionariesKey?: string }} [options]
 * @returns {InterceptorBundle}
 */
export function envelopeInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  const dataKey = str(o.dataKey) || 'data';
  const metaKey = str(o.metaKey) || 'meta';
  const dictionariesKey = str(o.dictionariesKey) || 'dictionaries';
  /** Response objects already unwrapped (their inner data may itself carry a `data` key). */
  const unwrapped = new WeakSet();
  /** @type {ResponseInterceptor} */
  const response = (res) => {
    if (!isObjectLike(res) || unwrapped.has(res)) return undefined;
    const r = /** @type {any} */ (res);
    const body = r.data;
    if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, dataKey)) {
      return undefined;
    }
    unwrapped.add(res);
    /** @type {Record<string, unknown>} */
    const meta = isPlainObject(body[metaKey]) ? { ...body[metaKey] } : {};
    if (body[dictionariesKey] !== undefined) meta.dictionaries = body[dictionariesKey];
    r.raw = body;
    r.data = body[dataKey];
    r.meta = isPlainObject(r.meta) ? { ...r.meta, ...meta } : meta;
    return undefined;
  };
  return bundle('envelope', { response });
}

/**
 * Map backend failures to the `SdkError` taxonomy. Error stage: a not‑yet‑mapped error carrying a
 * status ≥ 400 (its own, or `ctx.response.status`) becomes `errors.errorFromResponse(status, body,
 * headers, { requestId, map })` — the body is the error's own `problem | body | data`, else
 * `ctx.data` (the parsed body of the attempt a response interceptor rejected); `requestId` is the
 * server's `X-Request-Id`, else the error's, else `ctx.id`. Errors without a status (network,
 * timeout, abort, validation) and already specific `ApiError` subclasses pass through untouched,
 * unless `map` names their `code` (then the host's class wins). Response stage: a response with
 * status ≥ 400 or an `application/problem+json` content type is thrown as that error; others pass
 * (`undefined`). Effects: none.
 * @param {{ map?: Record<string, typeof ApiError | ((ctx: ProblemContext) => ApiError)> }} [options]
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `map` is not an object
 */
export function problemInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  if (o.map !== undefined && !isPlainObject(o.map)) {
    throw configError('problemInterceptor', '`map` must be an object of code → ApiError subclass');
  }
  const map = o.map;
  const convert = (
    /** @type {number} */ status,
    /** @type {unknown} */ body,
    /** @type {unknown} */ headers,
    /** @type {unknown} */ ctx,
    /** @type {string|undefined} */ fallbackId
  ) =>
    errorFromResponse(status, body, /** @type {any} */ (headers), {
      requestId:
        headerOf(headers, 'x-request-id') ||
        fallbackId ||
        str(isObjectLike(ctx) ? /** @type {any} */ (ctx).id : undefined),
      map,
    });
  /** Whether `map` asks for a different class than the one `err` already has. @param {any} err */
  const remaps = (err) => {
    if (
      !map ||
      typeof err.code !== 'string' ||
      !Object.prototype.hasOwnProperty.call(map, err.code)
    )
      return false;
    const target = /** @type {any} */ (map[err.code]);
    if (typeof target !== 'function') return false;
    const isClass = target.prototype instanceof ApiError || target === ApiError;
    return !(isClass && err instanceof target);
  };

  /** @type {ResponseInterceptor} */
  const response = (res, ctx) => {
    if (!isObjectLike(res)) return undefined;
    const r = /** @type {any} */ (res);
    const status = Number(r.status);
    const type = headerOf(r.headers, 'content-type') || '';
    if ((Number.isFinite(status) && status >= 400) || PROBLEM_TYPE.test(type)) {
      throw convert(status, r.data, r.headers, ctx, str(r.requestId));
    }
    return undefined;
  };

  /** @type {ErrorInterceptor} */
  const error = (err, ctx) => {
    if (!isObjectLike(err)) return undefined;
    if (err instanceof ApiError && err.name !== 'ApiError' && !remaps(err)) return undefined;
    if (isSdkError(err) && !(err instanceof ApiError)) return undefined;
    const status = statusOf(err, ctx);
    if (status < 400) return undefined;
    const e = /** @type {any} */ (err);
    const res = isObjectLike(ctx) ? ctx.response : undefined;
    const own = e.problem ?? e.body ?? e.data;
    const body = own !== undefined ? own : isObjectLike(ctx) ? ctx.data : undefined;
    const headers = isObjectLike(res) ? res.headers : e.headers;
    return convert(status, body, headers, ctx, str(e.requestId));
  };

  return bundle('problem', { response, error });
}

/**
 * On `429` ask the client for a delayed retry: `return ctx.retry({ delayMs })` with `delayMs =
 * min(Retry-After, maxWaitMs)` (`error.retryAfterMs`, else the `Retry-After` header as delta
 * seconds or HTTP date, else `defaultWaitMs`), at most `maxRetries` times per request. The client
 * owns the wait: it runs on the client's timers, `http:retry` / `onRetry(ctx, delayMs)` carry the
 * real delay, and aborting the request during the wait rejects with `AbortError`. Other errors pass
 * through. Effects: timer (the client's, through `ctx.retry`).
 * @param {{ maxWaitMs?: number, maxRetries?: number, defaultWaitMs?: number, now?: () => number }} [options]
 * @returns {InterceptorBundle}
 * @throws {ConfigError} on a negative / non‑numeric option
 */
export function rateLimitInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  const maxWaitMs = o.maxWaitMs === undefined ? 10000 : o.maxWaitMs;
  const maxRetries = o.maxRetries === undefined ? 1 : o.maxRetries;
  const defaultWaitMs = o.defaultWaitMs === undefined ? 1000 : o.defaultWaitMs;
  for (const [name, value] of Object.entries({ maxWaitMs, maxRetries, defaultWaitMs })) {
    if (!isFiniteNumber(value) || value < 0) {
      throw configError('rateLimitInterceptor', `\`${name}\` must be a non-negative number`);
    }
  }
  const now = /** @type {(() => number)|undefined} */ (o.now);

  const retryAfterOf = (/** @type {any} */ err, /** @type {any} */ ctx) => {
    if (isPositive(err?.retryAfterMs) || err?.retryAfterMs === 0) return err.retryAfterMs;
    if (isFiniteNumber(err?.meta?.retryAfterMs)) return err.meta.retryAfterMs;
    const headers = isObjectLike(ctx?.response) ? ctx.response.headers : undefined;
    return parseRetryAfter(headerOf(headers, 'Retry-After'), nowMs(now));
  };

  /** @type {ErrorInterceptor} */
  const error = (err, ctx) => {
    if (statusOf(err, ctx) !== 429) return undefined;
    if (!isObjectLike(ctx) || typeof ctx.retry !== 'function') return undefined;
    const used = Number(metaGet(ctx, META.rateLimitRetries)) || 0;
    if (used >= maxRetries) return undefined;
    metaSet(ctx, META.rateLimitRetries, used + 1);
    const wanted = retryAfterOf(err, ctx);
    const delayMs = Math.min(wanted === undefined ? defaultWaitMs : wanted, maxWaitMs);
    return ctx.retry({ delayMs });
  };

  return bundle('rateLimit', { error });
}

/**
 * Serve and store responses when `spec.cache` is set (`{ ttlMs, key? }` or `true` with
 * `defaultTtlMs`) for the listed `methods`. Keys are `cache:<METHOD> <url+query>|<Accept-Language>|
 * <X-Currency>` (or `cache:<spec.cache.key>|…`), plus `|<body>` for requests that carry one (so a
 * cacheable POST is keyed by its body too); a request whose body has no stable text (binary,
 * multipart) is never cached. A fresh entry short‑circuits with `{ …, fromCache: true }`; a 2xx
 * response is stored with `expiresAt = now + ttlMs` (after envelope unwrapping, so `meta` travels
 * with it, minus the interceptors' own `ctx.meta` bookkeeping the client mirrors into
 * `response.meta`). Without `storage` an in‑memory map is used. The bundle also carries `key(spec)`,
 * `invalidate(key)` and `clear(pattern?)` for `http.cache`.
 * Effects: storage `cache:*`.
 * @param {{ storage?: StorageLike, defaultTtlMs?: number, methods?: string[], now?: () => number, prefix?: string }} [options]
 * @returns {InterceptorBundle & { key: (spec: RequestSpec) => string|undefined, invalidate: (key: string) => void, clear: (pattern?: string|RegExp) => void }}
 * @throws {ConfigError} on a bad `storage`, `defaultTtlMs` or `methods`
 */
export function cacheInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  if (o.storage !== undefined && !isStorageLike(o.storage)) {
    throw configError('cacheInterceptor', '`storage` must expose get() and set()');
  }
  if (o.defaultTtlMs !== undefined && !isPositive(o.defaultTtlMs)) {
    throw configError('cacheInterceptor', '`defaultTtlMs` must be a positive number');
  }
  if (o.methods !== undefined && !Array.isArray(o.methods)) {
    throw configError('cacheInterceptor', '`methods` must be an array');
  }
  const storage = isStorageLike(o.storage) ? o.storage : memoryStorage();
  const defaultTtlMs = /** @type {number|undefined} */ (o.defaultTtlMs);
  const methods = new Set((o.methods || ['GET']).map((m) => String(m).toUpperCase()));
  const prefix = typeof o.prefix === 'string' ? o.prefix : 'cache:';
  const now = /** @type {(() => number)|undefined} */ (o.now);
  const clock = () => nowMs(now);

  const key = (/** @type {RequestSpec} */ spec) => {
    const p = identityPartsOf(spec);
    if (!p) return undefined;
    const custom =
      isObjectLike(spec) && isPlainObject(spec.cache) ? str(spec.cache.key) : undefined;
    const head = custom ? custom : `${p.method} ${p.url}`;
    return `${prefix}${head}|${p.lang}|${p.currency}${p.body ? `|${p.body}` : ''}`;
  };
  const ttlOf = (/** @type {unknown} */ spec) => {
    const cache = isObjectLike(spec) ? /** @type {any} */ (spec).cache : undefined;
    if (isPlainObject(cache) && isPositive(cache.ttlMs)) return cache.ttlMs;
    return defaultTtlMs;
  };
  const fullKey = (/** @type {string} */ k) =>
    typeof k === 'string' && k.startsWith(prefix) ? k : `${prefix}${k}`;
  const remove = (/** @type {string} */ k) => {
    safe(() =>
      typeof storage.remove === 'function' ? storage.remove(k) : storage.set(k, undefined)
    );
  };

  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (!isObjectLike(spec) || !spec.cache || !methods.has(methodOf(spec))) return spec;
    const k = key(spec);
    if (k === undefined) return spec;
    metaSet(ctx, META.cacheKey, k);
    const entry = safe(() => storage.get(k));
    if (isPlainObject(entry) && Object.prototype.hasOwnProperty.call(entry, 'data')) {
      const fresh = !isFiniteNumber(entry.expiresAt) || entry.expiresAt > clock();
      if (fresh) {
        return makeResponse({
          data: entry.data,
          status: /** @type {number} */ (entry.status),
          headers: entry.headers,
          ctx,
          fromCache: true,
          extra: entry.meta === undefined ? undefined : { meta: entry.meta },
        });
      }
      remove(k);
    }
    return spec;
  };

  /** @type {ResponseInterceptor} */
  const response = (res, ctx) => {
    const k = metaGet(ctx, META.cacheKey);
    if (typeof k !== 'string' || !isObjectLike(res)) return undefined;
    const r = /** @type {any} */ (res);
    const status = r.status === undefined ? 200 : Number(r.status);
    if (r.fromCache === true || !(status >= 200 && status < 300)) return undefined;
    const ttlMs = ttlOf(isObjectLike(ctx) ? ctx.spec : undefined);
    if (!ttlMs) return undefined;
    const storedAt = clock();
    const entry = {
      data: r.data,
      status,
      headers: headersToObject(r.headers),
      meta: stripMeta(r.meta),
      storedAt,
      expiresAt: storedAt + ttlMs,
    };
    safe(() => storage.set(k, entry, { ttlMs }));
    return undefined;
  };

  const invalidate = (/** @type {string} */ k) => {
    if (typeof k !== 'string' || !k) return;
    remove(fullKey(k));
  };
  const clear = (/** @type {string|RegExp} */ pattern) => {
    const keys =
      typeof storage.keys === 'function' ? safe(() => storage.keys(prefix), []) || [] : [];
    for (const k of keys) {
      if (!String(k).startsWith(prefix)) continue;
      const bare = String(k).slice(prefix.length);
      const hit =
        pattern === undefined ||
        (pattern instanceof RegExp
          ? pattern.test(bare) || pattern.test(String(k))
          : bare.includes(String(pattern)));
      if (hit) remove(String(k));
    }
  };

  return /** @type {any} */ (bundle('cache', { request, response, key, invalidate, clear }));
}

/**
 * Share the outcome of identical in‑flight requests (GET / HEAD by default; any method when
 * `spec.dedupe === true`; never when `spec.dedupe === false` or the body has no stable text): the
 * first request with a key becomes the leader and the bundle holds a deferred per key in a `Map`;
 * followers short‑circuit with a promise of the leader's response (a copy with its own `Headers`
 * and `deduped: true`) that rejects with `AbortError` as soon as the follower's own `ctx.signal`
 * aborts. The leader's response resolves them. A final failure of the leader (not retryable, or no
 * retry budget left) rejects them; a retryable failure — the client may still retry the leader, so
 * it is not the request's outcome — or the leader's abort releases them instead: their request
 * stage resumes with their own spec, so a transient error is never fanned out. Both release the key.
 * A leader re‑entering the request stage on retry is never treated as its own follower. The bundle
 * also carries `inflight()` (number of keys held). Effects: none.
 * @param {{ methods?: string[] }} [options]
 * @returns {InterceptorBundle & { inflight: () => number }}
 * @throws {ConfigError} when `methods` is not an array
 */
export function dedupeInterceptor(options = {}) {
  const o = isPlainObject(options) ? options : {};
  if (o.methods !== undefined && !Array.isArray(o.methods)) {
    throw configError('dedupeInterceptor', '`methods` must be an array');
  }
  const methods = new Set((o.methods || ['GET', 'HEAD']).map((m) => String(m).toUpperCase()));
  /** @typedef {HttpResponse | typeof DEDUPE_RELEASED} Outcome */
  /** @type {Map<string, { promise: Promise<Outcome>, resolve: (r: Outcome) => void, reject: (e: unknown) => void, ownerId: string|undefined }>} */
  const pending = new Map();

  /**
   * A follower's short‑circuit: the leader's response (own copy) or, when released, the follower's
   * own spec; the follower's abort wins over both.
   * @param {Promise<Outcome>} shared
   * @param {RequestSpec} spec
   * @param {HttpContext|undefined} ctx
   * @returns {Promise<HttpResponse|RequestSpec>}
   */
  const follow = (shared, spec, ctx) =>
    new Promise((resolve, reject) => {
      const signal = isObjectLike(ctx) ? ctx.signal : undefined;
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const listen = !!signal && typeof signal.addEventListener === 'function';
      const onAbort = () => reject(abortError(signal));
      if (listen)
        /** @type {AbortSignal} */ (signal).addEventListener('abort', onAbort, { once: true });
      const done = () => {
        if (listen) /** @type {AbortSignal} */ (signal).removeEventListener('abort', onAbort);
      };
      shared.then(
        (outcome) => {
          done();
          if (outcome === DEDUPE_RELEASED) resolve(spec);
          else {
            const res = /** @type {any} */ (outcome);
            resolve({ ...res, headers: copyHeaders(res.headers), deduped: true });
          }
        },
        (e) => {
          done();
          reject(e);
        }
      );
    });

  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (!isObjectLike(spec)) return spec;
    const wanted = /** @type {any} */ (spec).dedupe;
    if (wanted === false || (wanted !== true && !methods.has(methodOf(spec)))) return spec;
    const key = identityOf(spec);
    if (key === undefined) return spec;
    const existing = pending.get(key);
    if (existing && metaGet(ctx, META.dedupeKey) !== key) {
      metaSet(ctx, META.dedupeFollower, key);
      return follow(existing.promise, spec, ctx);
    }
    if (!existing) {
      /** @type {(r: Outcome) => void} */
      let resolve = () => {};
      /** @type {(e: unknown) => void} */
      let reject = () => {};
      /** @type {Promise<Outcome>} */
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {}); // followers observe the rejection; the leader must not warn
      pending.set(key, {
        promise,
        resolve,
        reject,
        ownerId: str(isObjectLike(ctx) ? ctx.id : undefined),
      });
      metaSet(ctx, META.dedupeKey, key);
    }
    return spec;
  };

  const settle = (
    /** @type {unknown} */ ctx,
    /** @type {(entry: { resolve: (r: Outcome) => void, reject: (e: unknown) => void }) => void} */ fn
  ) => {
    const key = metaGet(ctx, META.dedupeKey);
    if (typeof key !== 'string') return;
    const entry = pending.get(key);
    if (!entry) return;
    const id = str(isObjectLike(ctx) ? /** @type {any} */ (ctx).id : undefined);
    if (entry.ownerId && id && entry.ownerId !== id) return;
    pending.delete(key);
    fn(entry);
  };

  /** Whether the leader's failure is the request's outcome (no retry can follow it). @param {unknown} err @param {unknown} ctx */
  const isFinal = (err, ctx) => {
    if (err instanceof AbortError) return false;
    if (!isObjectLike(err) || /** @type {any} */ (err).retryable !== true) return true;
    const c = isObjectLike(ctx) ? /** @type {any} */ (ctx) : {};
    const retries = Number(isObjectLike(c.spec) ? c.spec.retries : NaN);
    const attempt = Number(c.attempt);
    return Number.isFinite(retries) && Number.isFinite(attempt) && attempt > retries;
  };

  /** @type {ResponseInterceptor} */
  const response = (res, ctx) => {
    settle(ctx, (entry) => entry.resolve(/** @type {HttpResponse} */ (res)));
    return undefined;
  };

  /** @type {ErrorInterceptor} */
  const error = (err, ctx) => {
    settle(ctx, (entry) => {
      if (isFinal(err, ctx)) entry.reject(err);
      else entry.resolve(DEDUPE_RELEASED);
    });
    return undefined;
  };

  return /** @type {any} */ (
    bundle('dedupe', { request, response, error, inflight: () => pending.size })
  );
}

/**
 * Cookie auth mode: copy the CSRF cookie (`document.cookie`, read at call time, so SSR renders add
 * nothing) into `header` and set `spec.credentials = 'include'` (unless the caller set credentials).
 * Effects: none.
 * @param {{ cookieName: string, header?: string }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `cookieName` is missing
 */
export function csrfInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const cookieName = str(o.cookieName);
  if (!cookieName) throw configError('csrfInterceptor', '`cookieName` must be a non-empty string');
  const header = str(o.header) || 'X-CSRF-Token';
  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (!isObjectLike(spec)) return spec;
    const s = /** @type {any} */ (spec);
    if (!s.credentials) s.credentials = 'include';
    const token = readCookie(cookieName);
    if (token) setHeaderIfAbsent(spec, ctx, header, token);
    return spec;
  };
  return bundle('csrf', { request });
}

/**
 * `X-Device-Id` from the host's `getDeviceId()` (sync or async). The first non‑empty id is kept for
 * the lifetime of the bundle and persisted under `deviceId` when `storage` is given (a stored id is
 * reused without calling the host); concurrent first requests share one resolution, so the host is
 * asked once; a failing / empty `getDeviceId()` just adds no header (and is asked again next time).
 * Effects: storage `deviceId`.
 * @param {{ getDeviceId: () => string | undefined | Promise<string | undefined>, header?: string, storage?: StorageLike, storageKey?: string }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `getDeviceId` is not a function
 */
export function deviceInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const getDeviceId = /** @type {() => unknown} */ (o.getDeviceId);
  if (typeof getDeviceId !== 'function') {
    throw configError('deviceInterceptor', '`getDeviceId` must be a function');
  }
  const header = str(o.header) || 'X-Device-Id';
  const storageKey = str(o.storageKey) || 'deviceId';
  const storage = isStorageLike(o.storage) ? o.storage : undefined;
  /** @type {string|undefined} */
  let cached;
  /** The resolution concurrent first requests share. @type {Promise<string|undefined>|null} */
  let resolving = null;

  const lookup = async () => {
    if (storage) {
      const stored = str(safe(() => storage.get(storageKey)));
      if (stored) {
        cached = stored;
        return stored;
      }
    }
    const id = str(await getDeviceId());
    if (!id) return undefined;
    cached = id;
    if (storage) safe(() => storage.set(storageKey, id));
    return id;
  };
  const resolve = () => {
    if (cached) return Promise.resolve(cached);
    if (!resolving) {
      const shared = lookup().finally(() => {
        if (resolving === shared) resolving = null;
      });
      shared.catch(() => {}); // every awaiter handles its own rejection
      resolving = shared;
    }
    return resolving;
  };

  /** @type {RequestInterceptor} */
  const request = async (spec, ctx) => {
    if (!isObjectLike(spec)) return spec;
    /** @type {string|undefined} */
    let id;
    try {
      id = await resolve();
    } catch {
      id = undefined;
    }
    if (id) setHeaderIfAbsent(spec, ctx, header, id);
    return spec;
  };
  return bundle('device', { request });
}

/**
 * Track one `http_request` per outcome: `{ path, method, status, durationMs, ok: true, attempts,
 * fromCache }` after a response, `{ path, method, status, durationMs, ok: false, code, attempts }`
 * after an error (per failed attempt). `durationMs` is the response's, else measured from the
 * request stage. A throwing `telemetry.track` never breaks the request. Effects: telemetry `http_request`.
 * @param {{ telemetry: { track: (event: string, props?: Record<string, unknown>) => unknown }, event?: string, now?: () => number }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when `telemetry.track` is missing
 */
export function telemetryInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const telemetry = /** @type {{ track: Function }} */ (o.telemetry);
  if (!isObjectLike(telemetry) || typeof telemetry.track !== 'function') {
    throw configError('telemetryInterceptor', '`telemetry` must expose track()');
  }
  const event = str(o.event) || 'http_request';
  const now = /** @type {(() => number)|undefined} */ (o.now);
  const track = (/** @type {Record<string, unknown>} */ props) => {
    safe(() => telemetry.track(event, props));
  };
  const durationOf = (/** @type {unknown} */ ctx, /** @type {unknown} */ res) => {
    const own = isObjectLike(res) ? /** @type {any} */ (res).durationMs : undefined;
    if (isFiniteNumber(own)) return own;
    const started = metaGet(ctx, META.telemetryStart);
    const start = isFiniteNumber(started)
      ? started
      : isObjectLike(ctx)
        ? /** @type {any} */ (ctx).startedAt
        : undefined;
    return isFiniteNumber(start) ? Math.max(0, nowMs(now) - start) : 0;
  };
  const attemptsOf = (/** @type {unknown} */ ctx, /** @type {unknown} */ res) => {
    const a = isObjectLike(ctx) ? Number(/** @type {any} */ (ctx).attempt) : NaN;
    if (Number.isFinite(a) && a > 0) return a;
    const b = isObjectLike(res) ? Number(/** @type {any} */ (res).attempts) : NaN;
    return Number.isFinite(b) && b > 0 ? b : 1;
  };

  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    if (metaGet(ctx, META.telemetryStart) === undefined)
      metaSet(ctx, META.telemetryStart, nowMs(now));
    return spec;
  };
  /** @type {ResponseInterceptor} */
  const response = (res, ctx) => {
    const spec = isObjectLike(ctx) ? ctx.spec : undefined;
    const r = isObjectLike(res) ? /** @type {any} */ (res) : {};
    track({
      path: pathnameOf(spec),
      method: methodOf(spec),
      status: isFiniteNumber(r.status) ? r.status : 0,
      durationMs: durationOf(ctx, res),
      ok: true,
      attempts: attemptsOf(ctx, res),
      fromCache: r.fromCache === true,
    });
    return undefined;
  };
  /** @type {ErrorInterceptor} */
  const error = (err, ctx) => {
    const spec = isObjectLike(ctx) ? ctx.spec : undefined;
    const e = isObjectLike(err) ? /** @type {any} */ (err) : {};
    track({
      path: pathnameOf(spec),
      method: methodOf(spec),
      status: statusOf(err, ctx),
      durationMs: durationOf(ctx),
      ok: false,
      code: str(e.code) || 'UNKNOWN',
      attempts: attemptsOf(ctx),
    });
    return undefined;
  };
  return bundle('telemetry', { request, response, error });
}

/**
 * Debug‑log every request, response and error through `logger.debug` (or `level`) with the values
 * of `redact`ed keys replaced by `[redacted]` — deep, headers included, case‑insensitive, and a key
 * that merely *contains* a redacted word (`cardNumber`, `x-authorization`) counts too, so a secret
 * never leaks through a variant spelling. A throwing logger never breaks the request. Effects: none.
 * @param {{ logger: Record<string, Function>, redact?: string[], level?: 'debug'|'info'|'warn'|'error' }} options
 * @returns {InterceptorBundle}
 * @throws {ConfigError} when the logger lacks the level method or `redact` is not a string array
 */
export function loggingInterceptor(options) {
  const o = isPlainObject(options) ? options : {};
  const level = str(o.level) || 'debug';
  const logger = /** @type {Record<string, Function>} */ (o.logger);
  if (!isObjectLike(logger) || typeof logger[level] !== 'function') {
    throw configError('loggingInterceptor', `\`logger.${level}()\` is required`);
  }
  const redact = o.redact === undefined ? DEFAULT_REDACT : o.redact;
  if (!Array.isArray(redact) || redact.some((k) => typeof k !== 'string')) {
    throw configError('loggingInterceptor', '`redact` must be an array of key names');
  }
  const words = redact.map((k) => k.toLowerCase()).filter((k) => k !== '');
  const isSecret = (/** @type {string} */ key) => {
    const lower = key.toLowerCase();
    return words.some((w) => lower === w || lower.includes(w));
  };
  const log = (/** @type {string} */ msg, /** @type {unknown} */ data) => {
    safe(() => logger[level](msg, redactDeep(data, isSecret)));
  };
  const base = (/** @type {unknown} */ ctx) => {
    const c = isObjectLike(ctx) ? /** @type {any} */ (ctx) : {};
    return {
      id: c.id,
      method: methodOf(c.spec),
      url: urlOf(c.spec),
      tag: c.tag,
      attempt: c.attempt,
    };
  };

  /** @type {RequestInterceptor} */
  const request = (spec, ctx) => {
    const s = isObjectLike(spec) ? /** @type {any} */ (spec) : {};
    log('http request', {
      ...base(ctx),
      method: methodOf(spec),
      url: urlOf(spec),
      headers: s.headers,
      query: s.query,
      body: s.body,
    });
    return spec;
  };
  /** @type {ResponseInterceptor} */
  const response = (res, ctx) => {
    const r = isObjectLike(res) ? /** @type {any} */ (res) : {};
    log('http response', {
      ...base(ctx),
      status: r.status,
      durationMs: r.durationMs,
      fromCache: r.fromCache === true,
      attempts: r.attempts,
      headers: r.headers,
      data: r.data,
    });
    return undefined;
  };
  /** @type {ErrorInterceptor} */
  const error = (err, ctx) => {
    const e = isObjectLike(err) ? /** @type {any} */ (err) : {};
    log('http error', {
      ...base(ctx),
      name: e.name,
      code: e.code,
      status: statusOf(err, ctx) || undefined,
      message: e.message,
      requestId: e.requestId,
      retryable: e.retryable,
    });
    return undefined;
  };
  return bundle('logging', { request, response, error });
}

/**
 * Dev only: short‑circuit matching requests with fixtures. Handlers are tried in order; a handler
 * matches when its `method` (omitted / `'*'` = any) equals the spec's and its `path` matches the
 * request pathname (string: exact or `:param` template; RegExp: tested against the pathname, then
 * the full url). `reply(spec, { params, ctx })` returns `{ status = 200, body, headers }`; after
 * `delayMs` on the injectable timers the request resolves with `{ data: body, status, headers,
 * mocked: true }`, or throws the mapped `ApiError` when `status ≥ 400`. Unmatched specs pass through.
 * Effects: timer (when `delayMs`).
 * @param {MockHandler[]} handlers
 * @param {{ delayMs?: number, timers?: TimersLike }} [options]
 * @returns {InterceptorBundle}
 * @throws {ConfigError} on a malformed handler or a negative `delayMs`
 */
export function mockInterceptor(handlers, options = {}) {
  if (!Array.isArray(handlers)) throw configError('mockInterceptor', '`handlers` must be an array');
  handlers.forEach((h, i) => {
    const ok =
      isObjectLike(h) &&
      typeof (/** @type {any} */ (h).reply) === 'function' &&
      (typeof (/** @type {any} */ (h).path) === 'string' ||
        /** @type {any} */ (h).path instanceof RegExp);
    if (!ok) {
      throw configError(
        'mockInterceptor',
        `handlers[${i}] needs a string / RegExp \`path\` and a \`reply(spec)\` function`
      );
    }
  });
  const o = isPlainObject(options) ? options : {};
  const delayMs = o.delayMs === undefined ? 0 : o.delayMs;
  if (!isFiniteNumber(delayMs) || delayMs < 0) {
    throw configError('mockInterceptor', '`delayMs` must be a non-negative number');
  }
  const timers = /** @type {TimersLike|undefined} */ (o.timers);

  /** @type {RequestInterceptor} */
  const request = async (spec, ctx) => {
    if (!isObjectLike(spec)) return spec;
    const method = methodOf(spec);
    const pathname = pathnameOf(spec);
    const url = String(/** @type {any} */ (spec).url || '');
    for (const h of handlers) {
      const want = str(h.method);
      if (want && want !== '*' && want.toUpperCase() !== method) continue;
      /** @type {Record<string, string>|null} */
      let params = null;
      if (typeof h.path === 'string') {
        params = matchPath(h.path, pathname);
      } else {
        h.path.lastIndex = 0;
        const m =
          h.path.exec(pathname) || (url ? ((h.path.lastIndex = 0), h.path.exec(url)) : null);
        h.path.lastIndex = 0;
        if (m) params = { ...(m.groups || {}) };
      }
      if (!params) continue;
      const reply = (await h.reply(spec, { params, ctx })) || {};
      if (delayMs > 0) await wait(delayMs, timers, isObjectLike(ctx) ? ctx.signal : undefined);
      const status = Number(reply.status === undefined ? 200 : reply.status);
      const headers = toHeaders(reply.headers);
      if (status >= 400) {
        throw errorFromResponse(status, reply.body, /** @type {any} */ (headers), {
          requestId: str(isObjectLike(ctx) ? ctx.id : undefined),
        });
      }
      return makeResponse({
        data: reply.body,
        status,
        headers,
        ctx,
        fromCache: false,
        extra: { mocked: true },
      });
    }
    return spec;
  };
  return bundle('mock', { request });
}

// ── installation ────────────────────────────────────────────────────────────────────────────────

/** @param {unknown} http @returns {boolean} whether `http.interceptors.<stage>.use` exists for every stage */
function hasStageApi(http) {
  const stages = isObjectLike(http) ? /** @type {any} */ (http).interceptors : undefined;
  return (
    isObjectLike(stages) &&
    STAGES.every((s) => isObjectLike(stages[s]) && typeof stages[s].use === 'function')
  );
}

/**
 * Whether `http` implements the docs §3.1 cache / dedupe stage itself (`createHttp` does): it then
 * exposes the `http.cache` namespace and `http.inflight()` of docs §3, and the `cache` / `dedupe`
 * bundles would only duplicate its work.
 * @param {any} http
 * @returns {boolean}
 */
function hasNativeCacheStage(http) {
  return (
    isObjectLike(http) &&
    isObjectLike(http.cache) &&
    typeof http.cache.invalidate === 'function' &&
    typeof http.inflight === 'function'
  );
}

/**
 * Register one bundle: stage by stage through `http.interceptors.<stage>.use(fn, { priority, name })`
 * when the client exposes it (exact per‑stage priorities), else through `http.use(bundle, opts)`.
 * @param {any} http
 * @param {InterceptorBundle} b
 * @returns {() => void}
 */
function register(http, b) {
  if (hasStageApi(http)) {
    const offs = STAGES.filter((s) => typeof b[s] === 'function').map((s) =>
      http.interceptors[s].use(b[s], { priority: b.priorities[s], name: b.name })
    );
    return () => {
      for (const off of offs) if (typeof off === 'function') safe(off);
    };
  }
  const off = http.use(b, { priority: b.priority, name: b.name, priorities: b.priorities });
  return () => {
    if (typeof off === 'function') safe(off);
  };
}

/**
 * Install the documented default set in the documented order (docs/api/01-core.md §4): request
 * correlation(10) → apiKey(20) → locale(30) → device(35) → csrf(40) → auth(50) → idempotency(60) →
 * cache(70) → dedupe(80) → logging(90) → telemetry(95); response envelope(10) → problem(20); error
 * problem(10) → auth(20) → rateLimit(30). Optional pieces are skipped when their dependency is
 * missing (`apiKey`, `store`, `getDeviceId`, `csrf.cookieName`, `auth`, `logger`, `telemetry`).
 * `cache` and `dedupe` are skipped when `http` runs the §3.1 cache / dedupe stage itself (it
 * exposes `http.cache.invalidate()` and `http.inflight()`, as `createHttp` does): installing the
 * bundles on top would store every cacheable response twice under two key schemes and leave
 * `http.cache.invalidate()` blind to the second copy. `deps.cache` / `deps.dedupe` force either way.
 * Returns an uninstall function carrying the installed `bundles`.
 * Effects: none (registration only).
 * @param {{ use?: Function, interceptors?: object, cache?: object, inflight?: Function }} http
 * @param {{ auth?: AuthLike, store?: { get: (path: string) => unknown }, storage?: StorageLike, apiKey?: string, logger?: Record<string, Function>, telemetry?: { track: Function }, getDeviceId?: () => unknown, csrf?: { cookieName: string, header?: string }, authExclude?: Array<RegExp|string>, cache?: boolean, dedupe?: boolean, cacheTtlMs?: number, problemMap?: Record<string, typeof ApiError | ((ctx: ProblemContext) => ApiError)> }} [deps]
 * @returns {(() => void) & { bundles: InterceptorBundle[] }}
 * @throws {ConfigError} when `http` exposes neither `use()` nor `interceptors.<stage>.use()`
 */
export function installDefaultInterceptors(http, deps = {}) {
  if (!isObjectLike(http) || (typeof http.use !== 'function' && !hasStageApi(http))) {
    throw configError(
      'installDefaultInterceptors',
      '`http` must expose use(bundle) or interceptors.<stage>.use()'
    );
  }
  const d = isPlainObject(deps) ? deps : {};
  /** @type {InterceptorBundle[]} */
  const bundles = [];
  bundles.push(correlationInterceptor({ storage: d.storage }));
  if (str(d.apiKey)) bundles.push(apiKeyInterceptor({ key: /** @type {string} */ (d.apiKey) }));
  if (isObjectLike(d.store) && typeof d.store.get === 'function') {
    bundles.push(localeInterceptor({ store: d.store }));
  }
  if (typeof d.getDeviceId === 'function') {
    bundles.push(deviceInterceptor({ getDeviceId: d.getDeviceId, storage: d.storage }));
  }
  if (isObjectLike(d.csrf) && str(d.csrf.cookieName)) bundles.push(csrfInterceptor(d.csrf));
  if (isObjectLike(d.auth) && typeof d.auth.getAccessToken === 'function') {
    bundles.push(authInterceptor({ auth: d.auth, exclude: d.authExclude }));
  }
  bundles.push(idempotencyInterceptor());
  const native = hasNativeCacheStage(http);
  if (d.cache === true || (d.cache !== false && !native)) {
    bundles.push(cacheInterceptor({ storage: d.storage, defaultTtlMs: d.cacheTtlMs }));
  }
  if (d.dedupe === true || (d.dedupe !== false && !native)) bundles.push(dedupeInterceptor());
  if (isObjectLike(d.logger) && typeof d.logger.debug === 'function') {
    bundles.push(loggingInterceptor({ logger: d.logger }));
  }
  if (isObjectLike(d.telemetry) && typeof d.telemetry.track === 'function') {
    bundles.push(telemetryInterceptor({ telemetry: d.telemetry }));
  }
  bundles.push(envelopeInterceptor());
  bundles.push(problemInterceptor({ map: d.problemMap }));
  bundles.push(rateLimitInterceptor());

  const offs = bundles.map((b) => register(http, b));
  const uninstall = () => {
    while (offs.length) {
      const off = offs.pop();
      if (off) safe(off);
    }
  };
  return Object.assign(uninstall, { bundles });
}
