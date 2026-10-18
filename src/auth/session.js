/**
 * Auth / session script of the Wayfarer SDK (docs/api/01-core.md §5; `session` slice in
 * docs/README.md §5). `createAuth` owns the access token (closure only, never in the store), the
 * refresh token (memory, or the `'session'` / `'local'` storage named by `config.auth.tokenStorage`),
 * the guest identity (`guestId` + `guestToken`, persisted so carts and bookings survive a reload),
 * single‑flight `refresh()` with proactive refresh scheduled at `expiresAt - autoRefreshSkewMs`
 * through injectable timers, guest sessions, the guest → account claim flow, register, password /
 * OTP / provider / magic‑link login, MFA and logout. It registers the `session` slice with
 * `secret: true` so `store.snapshot()` never carries tokens, and resolves its paths through the
 * `endpoints` table (`auth.*` keys are seeded with the documented `/v1/auth/...` paths when the table
 * lacks them). STANDALONE: it imports only `errors` and `utils` and the `http` / `store` / `storage` /
 * `events` instances it is given — never a domain module or `core/client.js`; modules receive it as
 * `ctx.auth`. SSR‑safe (no `window` / `document` / `localStorage`, timers looked up at call time), no
 * module‑level mutable state, no `console.*`, never throws a plain `Error`. Credential‑free calls
 * (login, register, refresh, OTP, claim, magic link, MFA, provider callback) are sent with
 * `{ auth: false }` so the `authInterceptor` never attaches a stale token to them.
 */

import {
  AuthError,
  ConfigError,
  SdkError,
  ValidationError,
  isSdkError,
  wrap,
} from '../errors/index.js';
import { singleFlight } from '../utils/async.js';
import { isPlainObject } from '../utils/object.js';
import { isEmail, isPhone, schemas, validate } from '../utils/validation.js';

/** @typedef {import('../types.js').User} User */
/** @typedef {import('../types.js').RequestOpts} RequestOpts */
/** @typedef {import('../types.js').ClientConfig} ClientConfig */
/** @typedef {import('../types.js').DateTime} DateTime */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

// ── typedefs ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Tokens handed to `setTokens` / returned by `refresh`. `expiresAt` is the access token expiry.
 * @typedef {Object} Tokens
 * @property {string} accessToken
 * @property {string|null} [refreshToken]  `undefined` keeps the current one, `null` drops it.
 * @property {DateTime|number|null} [expiresAt]  ISO‑8601 or epoch ms (`expiresIn` seconds also read from backend payloads).
 * @property {User|null} [user]
 */

/** @typedef {'anonymous'|'guest'|'authenticated'|'refreshing'} SessionStatus */
/** @typedef {'email'|'sms'|'whatsapp'} ClaimChannel */

/**
 * Pending claim (`auth.claimAccount` → `auth.completeClaim`).
 * @typedef {Object} ClaimState
 * @property {string} challengeId
 * @property {ClaimChannel} channel
 * @property {string} sentTo  Masked destination the backend messaged.
 * @property {DateTime|null} expiresAt
 * @property {string|null} bookingId
 */

/**
 * The `session` slice (docs/README.md §5). Tokens never appear here.
 * @typedef {Object} SessionState
 * @property {SessionStatus} status
 * @property {User|null} user
 * @property {string|null} guestId
 * @property {DateTime|null} accessExpiresAt
 * @property {ClaimState|null} claim
 */

/**
 * The part of `Http` this script uses.
 * @typedef {Object} AuthHttp
 * @property {(spec: Record<string, unknown>) => Promise<{ data?: unknown }>} request
 * @property {(tag: string, reason?: unknown) => number} [abort]
 */

/**
 * The part of `Store` this script uses.
 * @typedef {Object} AuthStore
 * @property {(name: string, options: { initial: unknown, secret?: boolean }) => void} registerSlice
 * @property {(slice: string, updater: object | ((s: any) => any), meta?: { action?: string }) => void} set
 * @property {(path?: string) => unknown} get
 * @property {(slice?: string) => void} reset
 * @property {(name: string) => boolean} [hasSlice]
 * @property {(fn: () => void) => void} [batch]
 * @property {(selector: (s: any) => any, listener: (value: any, prev: any) => void) => () => void} subscribe
 */

/**
 * Key/value facade (`storage/adapters.js`); `get` returns `undefined` for missing / expired keys.
 * @typedef {Object} AuthStorage
 * @property {(key: string) => unknown} get
 * @property {(key: string, value: unknown, options?: { ttlMs?: number }) => void} set
 * @property {(key: string) => void} remove
 */

/** @typedef {(kind: 'memory'|'session'|'local') => AuthStorage} AuthStorageFactory */
/** @typedef {{ emit: (event: string, payload?: unknown) => void }} AuthEvents */
/** @typedef {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (handle: unknown) => void }} AuthTimers */
/** @typedef {{ get: (key: string, params?: Record<string, string|number|boolean>) => string, set: (key: string, template: unknown) => void, has?: (key: string) => boolean }} AuthEndpoints */
/** @typedef {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} AuthLogger */

/**
 * @typedef {Object} AuthOptions
 * @property {AuthHttp} http  HTTP client (the only way this script reaches the network).
 * @property {AuthStore} store  Store the `session` slice is registered on.
 * @property {AuthStorage|AuthStorageFactory|null} [storage]  Facade, or a factory per kind; omitted = memory only.
 * @property {AuthEvents|null} [events]  Emitter for `auth:*` events.
 * @property {Partial<ClientConfig>|null} [config]  Reads `auth.strategy`, `auth.tokenStorage`, `auth.autoRefreshSkewMs`, `auth.guest`, `auth.refreshPath`, `storage`.
 * @property {AuthEndpoints|null} [endpoints]  Endpoint table; missing `auth.*` keys are seeded.
 * @property {() => number} [now]  Clock in ms (default `Date.now`).
 * @property {AuthTimers} [timers]  Injectable timers (default: the globals, looked up at call time).
 * @property {AuthLogger|null} [logger]  Optional scoped logger.
 */

/**
 * @typedef {Object} Auth
 * @property {() => string|null} getAccessToken
 * @property {() => boolean} isAuthenticated
 * @property {() => User|null} getUser
 * @property {() => string|null} getSessionId  Server session id when the backend issued one, else the guest id.
 * @property {(tokens: Tokens) => void} setTokens
 * @property {() => void} clearTokens
 * @property {(opts?: RequestOpts) => Promise<Tokens>} refresh
 * @property {(opts?: RequestOpts) => Promise<{ guestId: string, guestToken: string }>} ensureGuestSession
 * @property {() => boolean} isGuest
 * @property {() => string|null} getGuestToken
 * @property {(input: { bookingId?: string, channel: ClaimChannel, destination?: string }, opts?: RequestOpts) => Promise<{ sentTo: string, expiresAt: DateTime|null, challengeId: string }>} claimAccount
 * @property {(input: { token?: string, challengeId?: string, otp?: string, password: string, consents?: Record<string, unknown> }, opts?: RequestOpts) => Promise<User>} completeClaim
 * @property {(input: { email?: string, phone?: import('../types.js').Phone|string, password?: string, firstName?: string, lastName?: string, consents: Record<string, unknown>, otpChallengeId?: string }, opts?: RequestOpts) => Promise<User>} register
 * @property {(input: { identifier: string, password: string, remember?: boolean }, opts?: RequestOpts) => Promise<User>} loginWithPassword
 * @property {(input: { channel: 'sms'|'email'|'whatsapp', identifier: string, purpose: 'login'|'register'|'verify'|'reset' }, opts?: RequestOpts) => Promise<{ challengeId: string, expiresAt: DateTime|null, resendAfterMs: number }>} requestOtp
 * @property {(input: { challengeId: string, code: string, remember?: boolean }, opts?: RequestOpts) => Promise<User | { challengeId: string, requires: 'register' }>} verifyOtp
 * @property {(provider: string, input: { redirectUri: string, state?: string }, opts?: RequestOpts) => Promise<string>} getProviderUrl
 * @property {(input: { provider: string, code?: string, idToken?: string, redirectUri?: string, nonce?: string }, opts?: RequestOpts) => Promise<User>} loginWithProvider
 * @property {(input: { email: string, redirectUri: string }, opts?: RequestOpts) => Promise<void>} requestMagicLink
 * @property {(token: string, opts?: RequestOpts) => Promise<User>} consumeMagicLink
 * @property {{ verify: (input: { challengeId: string, code: string, method?: string }, opts?: RequestOpts) => Promise<User> }} mfa
 * @property {(input?: { everywhere?: boolean }, opts?: RequestOpts) => Promise<void>} logout
 * @property {(fn: (session: SessionState) => void) => () => void} onChange
 * @property {(ms: number) => boolean} willExpireWithin
 * @property {() => DateTime|null} getExpiry
 * @property {() => void} destroy  Clear the refresh timer and every `onChange` listener.
 */

// ── constants ────────────────────────────────────────────────────────────────────────────────────

/** Initial `session` slice. @type {Readonly<SessionState>} */
const SESSION_INITIAL = Object.freeze({
  status: 'anonymous',
  user: null,
  guestId: null,
  accessExpiresAt: null,
  claim: null,
});

/** Storage keys (namespacing is the facade's job). */
const KEYS = Object.freeze({
  refreshToken: 'refreshToken',
  guestId: 'guestId',
  guestToken: 'guestToken',
});

/** Tag of this script's own requests; `logout` aborts the `authed` tag used by the domain modules. */
const AUTH_TAG = 'auth';
const AUTHED_TAG = 'authed';

/** Slices `logout` resets (docs/api/01-core.md §5). */
const RESET_SLICES = Object.freeze([
  'session',
  'account',
  'travelers',
  'trips',
  'wallet',
  'alerts',
]);

const DEFAULT_SKEW_MS = 30000;
/** A refresh is never scheduled closer than this, so a tiny token lifetime cannot spin. */
const MIN_REFRESH_DELAY_MS = 1000;

const TOKEN_STORAGES = new Set(['memory', 'session', 'local']);
const CLAIM_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp']);
const OTP_CHANNELS = Object.freeze(['sms', 'email', 'whatsapp']);
const OTP_PURPOSES = Object.freeze(['login', 'register', 'verify', 'reset']);
/** 4xx statuses that mean "try again later", not "the refresh token is dead". */
const TRANSIENT_4XX = new Set([408, 425, 429]);

/**
 * `auth.*` endpoint keys → documented paths (docs/api/01-core.md §5, `/v1`‑prefixed like the other
 * SDK‑defined paths in `core/endpoints.js`). Seeded into the given table when missing.
 * @type {Readonly<Record<string, Readonly<{ method: 'GET'|'POST', path: string }>>>}
 */
const AUTH_ENDPOINTS = Object.freeze({
  'auth.refresh': Object.freeze({ method: 'POST', path: '/v1/auth/refresh' }),
  'auth.ensureGuestSession': Object.freeze({ method: 'POST', path: '/v1/sessions/guest' }),
  'auth.claimAccount': Object.freeze({ method: 'POST', path: '/v1/auth/claim' }),
  'auth.completeClaim': Object.freeze({ method: 'POST', path: '/v1/auth/claim/complete' }),
  'auth.register': Object.freeze({ method: 'POST', path: '/v1/auth/register' }),
  'auth.loginWithPassword': Object.freeze({ method: 'POST', path: '/v1/auth/login' }),
  'auth.requestOtp': Object.freeze({ method: 'POST', path: '/v1/auth/otp/request' }),
  'auth.verifyOtp': Object.freeze({ method: 'POST', path: '/v1/auth/otp/verify' }),
  'auth.getProviderUrl': Object.freeze({
    method: 'GET',
    path: '/v1/auth/providers/{provider}/url',
  }),
  'auth.loginWithProvider': Object.freeze({
    method: 'POST',
    path: '/v1/auth/providers/{provider}/callback',
  }),
  'auth.requestMagicLink': Object.freeze({ method: 'POST', path: '/v1/auth/magic-link' }),
  'auth.consumeMagicLink': Object.freeze({ method: 'POST', path: '/v1/auth/magic-link/consume' }),
  'auth.mfa.verify': Object.freeze({ method: 'POST', path: '/v1/auth/mfa/verify' }),
  'auth.logout': Object.freeze({ method: 'POST', path: '/v1/auth/logout' }),
});

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {string|undefined} non‑empty trimmed string or `undefined` */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** @param {unknown} v @returns {v is Function} */
function isFn(v) {
  return typeof v === 'function';
}

/** @param {unknown} v @returns {boolean} */
function isObjectLike(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

/**
 * @param {ValidationIssue[]} issues
 * @param {boolean} ok
 * @param {string} path
 * @param {string} code
 * @param {string} message
 */
function check(issues, ok, path, code, message) {
  if (!ok) issues.push({ path, code, message });
}

/**
 * @param {string} what
 * @param {ValidationIssue[]} issues
 */
function assertValid(what, issues) {
  if (issues.length > 0) {
    throw new ValidationError(`Invalid ${what}: ${issues.map((i) => i.message).join('; ')}`, {
      issues,
    });
  }
}

/**
 * @param {unknown} input
 * @param {string} what
 * @returns {Record<string, any>}
 */
function requireObject(input, what) {
  if (!isPlainObject(input)) {
    throw new ValidationError(`${what} must be an object`, {
      issues: [{ path: '', code: 'type', message: `${what} must be an object` }],
    });
  }
  return input;
}

/** Drop `undefined` members so request bodies stay minimal. @param {Record<string, unknown>} o */
function compact(o) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * Normalise an expiry (ISO string or epoch ms / s) into `{ iso, ms }`; `null` when absent / invalid.
 * @param {unknown} v
 * @returns {{ iso: string, ms: number } | null}
 */
function toExpiry(v) {
  if (v === undefined || v === null || v === '') return null;
  let ms;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Epoch seconds when the number is far too small to be milliseconds.
    ms = v < 1e11 ? v * 1000 : v;
  } else if (typeof v === 'string') {
    ms = Date.parse(v);
    if (Number.isNaN(ms)) return null;
    return { iso: v, ms };
  } else if (v instanceof Date) {
    ms = v.getTime();
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  return { iso: new Date(ms).toISOString(), ms };
}

/**
 * Read tokens out of a backend payload (camelCase, snake_case, or nested under `tokens`).
 * @param {unknown} data
 * @param {number} now
 * @returns {{ accessToken: string, refreshToken: string|undefined, expiry: { iso: string, ms: number } | null, user: User|null|undefined, sessionId: string|undefined } | null}
 */
function readTokens(data, now) {
  if (!isPlainObject(data)) return null;
  const src = isPlainObject(data.tokens) ? { ...data, ...data.tokens } : data;
  const accessToken = str(src.accessToken) || str(src.access_token) || str(src.token);
  if (!accessToken) return null;
  const refreshToken = str(src.refreshToken) || str(src.refresh_token);
  let expiry = toExpiry(src.expiresAt ?? src.expires_at ?? src.accessExpiresAt);
  if (!expiry) {
    const sec = src.expiresIn ?? src.expires_in;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) {
      expiry = toExpiry(now + sec * 1000);
    }
  }
  return {
    accessToken,
    refreshToken,
    expiry,
    user: isPlainObject(src.user) ? /** @type {User} */ (src.user) : undefined,
    sessionId: str(src.sessionId) || str(src.session_id),
  };
}

/**
 * Body of an HTTP result; unwraps a bare `{ data, meta? }` envelope when no interceptor did.
 * @param {unknown} res
 * @returns {any}
 */
function payloadOf(res) {
  const d = isObjectLike(res) ? /** @type {any} */ (res).data : undefined;
  if (
    isPlainObject(d) &&
    isPlainObject(d.data) &&
    Object.keys(d).every((k) => k === 'data' || k === 'meta' || k === 'dictionaries')
  ) {
    return d.data;
  }
  return d === undefined ? null : d;
}

/**
 * Whether a failed refresh means the session is gone (the backend rejected it) rather than a
 * transient fault (network, timeout, abort, 5xx, 408 / 425 / 429).
 * @param {unknown} err
 * @returns {boolean}
 */
function isDefinitiveRefreshFailure(err) {
  if (!isSdkError(err)) return false;
  const status = /** @type {any} */ (err).status;
  if (typeof status !== 'number') return err instanceof AuthError;
  return status >= 400 && status < 500 && !TRANSIENT_4XX.has(status);
}

// ── factory ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Create the auth / session manager for one client (docs/api/01-core.md §5).
 * Effects: storage read (`refreshToken`, `guestId`, `guestToken` when persisted) · state `session`
 * (registered `secret`) · endpoints `auth.*` seeded when missing · timer (a restored refresh token
 * schedules an immediate proactive refresh).
 * @param {AuthOptions} options
 * @returns {Auth}
 * @throws {ConfigError} when `http` / `store` are missing or an option has the wrong shape
 */
export function createAuth(options) {
  const o = isPlainObject(options) ? options : {};
  const http = /** @type {AuthHttp} */ (o.http);
  const store = /** @type {AuthStore} */ (o.store);
  if (!isObjectLike(http) || !isFn(http.request)) {
    throw new ConfigError('createAuth: http must expose request()', { details: { path: 'http' } });
  }
  if (
    !isObjectLike(store) ||
    !isFn(store.registerSlice) ||
    !isFn(store.set) ||
    !isFn(store.get) ||
    !isFn(store.subscribe)
  ) {
    throw new ConfigError(
      'createAuth: store must expose registerSlice(), set(), get() and subscribe()',
      {
        details: { path: 'store' },
      }
    );
  }
  if (
    o.events !== undefined &&
    o.events !== null &&
    !(isObjectLike(o.events) && isFn(o.events.emit))
  ) {
    throw new ConfigError('createAuth: events must expose emit()', { details: { path: 'events' } });
  }
  if (
    o.storage !== undefined &&
    o.storage !== null &&
    !isFn(o.storage) &&
    !(
      isObjectLike(o.storage) &&
      isFn(o.storage.get) &&
      isFn(o.storage.set) &&
      isFn(o.storage.remove)
    )
  ) {
    throw new ConfigError('createAuth: storage must be a facade (get/set/remove) or a factory', {
      details: { path: 'storage' },
    });
  }
  if (
    o.endpoints !== undefined &&
    o.endpoints !== null &&
    !(isObjectLike(o.endpoints) && isFn(o.endpoints.get) && isFn(o.endpoints.set))
  ) {
    throw new ConfigError('createAuth: endpoints must expose get() and set()', {
      details: { path: 'endpoints' },
    });
  }
  if (o.now !== undefined && !isFn(o.now)) {
    throw new ConfigError('createAuth: now must be a function', { details: { path: 'now' } });
  }
  if (
    o.timers !== undefined &&
    !(isObjectLike(o.timers) && isFn(o.timers.setTimeout) && isFn(o.timers.clearTimeout))
  ) {
    throw new ConfigError('createAuth: timers must expose setTimeout and clearTimeout', {
      details: { path: 'timers' },
    });
  }
  if (o.config !== undefined && o.config !== null && !isPlainObject(o.config)) {
    throw new ConfigError('createAuth: config must be an object', { details: { path: 'config' } });
  }

  const events = /** @type {AuthEvents|null} */ (o.events || null);
  const endpoints = /** @type {AuthEndpoints|null} */ (o.endpoints || null);
  const logger = /** @type {AuthLogger} */ (isObjectLike(o.logger) ? o.logger : {});
  const now = o.now || (() => Date.now());
  const timers = o.timers || {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
  };

  // ── configuration ──
  const config = /** @type {Record<string, any>} */ (o.config || {});
  const authCfg = isPlainObject(config.auth) ? config.auth : {};
  const strategy = authCfg.strategy === 'cookie' ? 'cookie' : 'bearer';
  const tokenKind = TOKEN_STORAGES.has(authCfg.tokenStorage) ? authCfg.tokenStorage : 'memory';
  const skewMs =
    typeof authCfg.autoRefreshSkewMs === 'number' &&
    Number.isFinite(authCfg.autoRefreshSkewMs) &&
    authCfg.autoRefreshSkewMs >= 0
      ? authCfg.autoRefreshSkewMs
      : DEFAULT_SKEW_MS;
  const guestEnabled = authCfg.guest !== false;
  const guestKind =
    typeof config.storage === 'string' && TOKEN_STORAGES.has(config.storage)
      ? config.storage
      : 'local';

  // ── closure state (tokens never reach the store) ──
  /** @type {string|null} */
  let accessToken = null;
  /** @type {string|null} */
  let refreshToken = null;
  /** @type {{ iso: string, ms: number } | null} */
  let expiry = null;
  /** @type {User|null} */
  let user = null;
  /** @type {string|null} */
  let sessionId = null;
  /** @type {string|null} */
  let guestId = null;
  /** @type {string|null} */
  let guestToken = null;
  /** `loginWithPassword({ remember: false })` keeps the refresh token in memory for this session. */
  let remember = true;
  /** @type {unknown} */
  let refreshTimer = null;
  let destroyed = false;
  /** @type {Set<() => void>} */
  const offs = new Set();

  // ── logging / events ──

  /** @param {'debug'|'warn'} level @param {string} msg @param {unknown} [data] */
  function log(level, msg, data) {
    const fn = logger[level];
    if (!isFn(fn)) return;
    try {
      fn.call(logger, msg, data);
    } catch {
      // a logger must never break auth
    }
  }

  /** @param {string} event @param {unknown} payload */
  function emit(event, payload) {
    if (!events) return;
    try {
      events.emit(event, payload);
    } catch (e) {
      log('warn', `auth: event emitter threw on ${event}`, { error: e });
    }
  }

  // ── storage ──

  /**
   * @param {'memory'|'session'|'local'} kind
   * @returns {AuthStorage|null}
   */
  function storageFor(kind) {
    if (kind === 'memory' || !o.storage) return null;
    if (isFn(o.storage)) {
      try {
        const s = /** @type {AuthStorageFactory} */ (o.storage)(kind);
        return isObjectLike(s) && isFn(s.get) && isFn(s.set) && isFn(s.remove) ? s : null;
      } catch (e) {
        log('warn', `auth: storage factory failed for '${kind}'`, { error: e });
        return null;
      }
    }
    return /** @type {AuthStorage} */ (o.storage);
  }

  /** @param {AuthStorage|null} s @param {string} key @returns {string|null} */
  function readKey(s, key) {
    if (!s) return null;
    try {
      return str(s.get(key)) || null;
    } catch (e) {
      log('warn', `auth: could not read '${key}'`, { error: e });
      return null;
    }
  }

  /** @param {AuthStorage|null} s @param {string} key @param {string|null} value @param {number} [ttlMs] */
  function writeKey(s, key, value, ttlMs) {
    if (!s) return;
    try {
      if (value === null) s.remove(key);
      else if (ttlMs !== undefined && ttlMs > 0) s.set(key, value, { ttlMs });
      else s.set(key, value);
    } catch (e) {
      log('warn', `auth: could not write '${key}'`, { error: e });
    }
  }

  const tokenStorage = () => (remember ? storageFor(tokenKind) : null);
  const guestStorage = () => storageFor(guestKind);

  function persistRefreshToken() {
    // Remove from the configured storage first so a `remember: false` login cannot leave an older
    // persisted token behind, then write the current one where it belongs.
    writeKey(storageFor(tokenKind), KEYS.refreshToken, null);
    writeKey(tokenStorage(), KEYS.refreshToken, refreshToken);
  }

  /** @param {number} [expiresAtMs] */
  function persistGuest(expiresAtMs) {
    const s = guestStorage();
    const ttl = expiresAtMs !== undefined ? Math.max(0, expiresAtMs - now()) : undefined;
    writeKey(s, KEYS.guestId, guestId, ttl);
    writeKey(s, KEYS.guestToken, guestToken, ttl);
  }

  // ── endpoints ──

  /**
   * Resolve an `auth.*` key to its path, seeding the table when the owner has not added it yet.
   * @param {string} key
   * @param {Record<string, string>} [params]
   * @returns {string}
   */
  function pathFor(key, params) {
    const entry = AUTH_ENDPOINTS[key];
    if (!endpoints) {
      return entry.path.replace(/\{(\w+)\}/g, (_m, name) =>
        encodeURIComponent(String((params && params[name]) || ''))
      );
    }
    return endpoints.get(key, params);
  }

  /**
   * @param {string} key
   * @returns {boolean} whether the endpoints table already knows `key`
   */
  function hasEndpoint(key) {
    if (!endpoints) return false;
    try {
      if (isFn(endpoints.has)) return endpoints.has(key) === true;
      endpoints.get(key);
      return true;
    } catch {
      return false;
    }
  }

  function seedEndpoints() {
    if (!endpoints) return;
    const refreshPath = str(authCfg.refreshPath);
    for (const key of Object.keys(AUTH_ENDPOINTS)) {
      const present = hasEndpoint(key);
      const seed =
        key === 'auth.refresh' && refreshPath
          ? { method: 'POST', path: refreshPath }
          : AUTH_ENDPOINTS[key];
      // `config.auth.refreshPath` is the host's explicit choice for the refresh route and wins.
      if (!present || (key === 'auth.refresh' && refreshPath)) {
        try {
          endpoints.set(key, { ...seed });
        } catch (e) {
          log('warn', `auth: could not seed endpoint '${key}'`, { error: e });
        }
      }
    }
  }

  // ── http ──

  /**
   * Run one request through `http`, passing the caller's `opts` through and forcing `auth: false`
   * where credentials must not be attached.
   * @param {string} key
   * @param {{ body?: unknown, params?: Record<string, string>, opts?: RequestOpts, auth?: false }} req
   * @returns {Promise<any>} the response payload
   */
  async function call(key, req) {
    const entry = AUTH_ENDPOINTS[key];
    /** @type {Record<string, unknown>} */
    const spec = {
      tag: AUTH_TAG,
      ...(isPlainObject(req.opts) ? req.opts : {}),
      method: entry.method,
      path: pathFor(key, req.params),
    };
    if (req.body !== undefined) spec.body = req.body;
    if (req.auth === false) spec.auth = false;
    if (strategy === 'cookie' && spec.credentials === undefined) spec.credentials = 'include';
    const res = await http.request(spec);
    return payloadOf(res);
  }

  // ── session slice ──

  /** @returns {SessionState} */
  function session() {
    const s = store.get('session');
    return isPlainObject(s) ? /** @type {SessionState} */ (s) : SESSION_INITIAL;
  }

  /** @param {Partial<SessionState>} patch @param {string} action */
  function setSession(patch, action) {
    store.set('session', (s) => ({ ...(isPlainObject(s) ? s : SESSION_INITIAL), ...patch }), {
      action,
    });
  }

  /** @param {User|null} u */
  function setAccountUser(u) {
    if (!u) return;
    const has = isFn(store.hasSlice) ? store.hasSlice('account') : false;
    if (!has) return;
    try {
      store.set('account', (a) => ({ ...(isPlainObject(a) ? a : {}), user: u }), {
        action: 'account/user',
      });
    } catch (e) {
      log('warn', 'auth: could not write account.user', { error: e });
    }
  }

  /** @returns {SessionStatus} */
  function restingStatus() {
    if (accessToken) return 'authenticated';
    return guestToken && guestId ? 'guest' : 'anonymous';
  }

  // ── timers ──

  function clearRefreshTimer() {
    if (refreshTimer !== null) {
      try {
        timers.clearTimeout(refreshTimer);
      } catch {
        // nothing to do: the handle is gone either way
      }
      refreshTimer = null;
    }
  }

  /** Whether a refresh can be attempted at all (bearer: needs a refresh token; cookie: always). */
  function canRefresh() {
    return strategy === 'cookie' || refreshToken !== null;
  }

  /** @param {number} delayMs */
  function armRefresh(delayMs) {
    clearRefreshTimer();
    if (destroyed || !canRefresh()) return;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, delayMs);
    const handle = timers.setTimeout(() => {
      refreshTimer = null;
      refresh().catch((e) => log('debug', 'auth: scheduled refresh failed', { error: e }));
    }, delay);
    if (isObjectLike(handle) && isFn(/** @type {any} */ (handle).unref)) {
      try {
        /** @type {any} */ (handle).unref();
      } catch {
        // cosmetic: only keeps a Node process from waiting on the refresh
      }
    }
    refreshTimer = handle;
  }

  /** Proactive refresh at `expiresAt - skew` (only when an expiry is known). */
  function scheduleRefresh() {
    if (!accessToken || !expiry) {
      clearRefreshTimer();
      return;
    }
    armRefresh(expiry.ms - skewMs - now());
  }

  // ── token lifecycle ──

  /**
   * @param {{ accessToken: string, refreshToken?: string|null, expiry?: { iso: string, ms: number } | null, user?: User|null, sessionId?: string|null }} tokens
   * @param {string} action
   */
  function applyTokens(tokens, action) {
    accessToken = tokens.accessToken;
    if (tokens.refreshToken !== undefined) refreshToken = tokens.refreshToken;
    if (tokens.expiry !== undefined) expiry = tokens.expiry;
    if (tokens.user !== undefined) user = tokens.user;
    if (tokens.sessionId !== undefined && tokens.sessionId !== null) sessionId = tokens.sessionId;
    persistRefreshToken();
    setSession(
      { status: 'authenticated', user, guestId, accessExpiresAt: expiry ? expiry.iso : null },
      action
    );
    scheduleRefresh();
  }

  /** Forget the authenticated identity (closure + persisted refresh token + timer). */
  function dropTokens() {
    accessToken = null;
    refreshToken = null;
    expiry = null;
    user = null;
    sessionId = null;
    clearRefreshTimer();
    writeKey(storageFor(tokenKind), KEYS.refreshToken, null);
    remember = true;
  }

  /** Forget the guest identity (closure + storage). */
  function dropGuest() {
    guestId = null;
    guestToken = null;
    const s = guestStorage();
    writeKey(s, KEYS.guestId, null);
    writeKey(s, KEYS.guestToken, null);
  }

  /**
   * The session is gone: clear it and tell the world.
   * @param {string} reason
   * @param {unknown} error
   */
  function expire(reason, error) {
    dropTokens();
    setSession({ status: restingStatus(), user: null, accessExpiresAt: null }, 'session/expired');
    emit('auth:expired', { reason, error });
  }

  /** @returns {Tokens} */
  function publicTokens() {
    return {
      accessToken: /** @type {string} */ (accessToken),
      refreshToken,
      expiresAt: expiry ? expiry.iso : null,
      user,
    };
  }

  /**
   * Finish any login: apply the tokens, mirror the user into `account`, emit `auth:login`.
   * @param {unknown} data
   * @param {string} method
   * @param {string} action
   * @returns {User}
   */
  function completeLogin(data, method, action) {
    const tokens = readTokens(data, now());
    if (!tokens) {
      throw new AuthError('The backend returned no access token', {
        reason: 'unauthenticated',
        details: { method },
      });
    }
    applyTokens(tokens, action);
    setAccountUser(user);
    emit('auth:login', { user, method });
    return /** @type {User} */ (user);
  }

  // ── synchronous reads ──

  /** @type {Auth['getAccessToken']} */
  const getAccessToken = () => accessToken;
  /** @type {Auth['isAuthenticated']} */
  const isAuthenticated = () => accessToken !== null;
  /** @type {Auth['getUser']} */
  const getUser = () => user;
  /** @type {Auth['getSessionId']} */
  const getSessionId = () => sessionId || guestId;
  /** @type {Auth['isGuest']} */
  const isGuest = () => accessToken === null && guestToken !== null && guestId !== null;
  /** @type {Auth['getGuestToken']} */
  const getGuestToken = () => guestToken;
  /** @type {Auth['getExpiry']} */
  const getExpiry = () => (expiry ? expiry.iso : null);

  /** @type {Auth['willExpireWithin']} */
  function willExpireWithin(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new ValidationError('ms must be a non-negative number', {
        issues: [{ path: 'ms', code: 'type', message: 'ms must be a non-negative number' }],
      });
    }
    if (!accessToken) return true;
    if (!expiry) return false;
    return expiry.ms - now() <= ms;
  }

  // ── host‑owned tokens ──

  /** @type {Auth['setTokens']} */
  function setTokens(tokens) {
    const t = requireObject(tokens, 'tokens');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, !!str(t.accessToken), 'accessToken', 'required', 'accessToken is required');
    check(
      issues,
      t.refreshToken === undefined || t.refreshToken === null || typeof t.refreshToken === 'string',
      'refreshToken',
      'type',
      'refreshToken must be a string'
    );
    const exp = toExpiry(t.expiresAt);
    check(
      issues,
      t.expiresAt === undefined || t.expiresAt === null || exp !== null,
      'expiresAt',
      'format',
      'expiresAt must be an ISO-8601 date-time or epoch milliseconds'
    );
    check(
      issues,
      t.user === undefined || t.user === null || isPlainObject(t.user),
      'user',
      'type',
      'user must be an object'
    );
    assertValid('tokens', issues);
    applyTokens(
      {
        accessToken: /** @type {string} */ (t.accessToken),
        refreshToken: t.refreshToken === undefined ? undefined : str(t.refreshToken) || null,
        expiry: t.expiresAt === undefined ? undefined : exp,
        user: t.user === undefined ? undefined : /** @type {User|null} */ (t.user),
      },
      'session/setTokens'
    );
    setAccountUser(user);
    emit('auth:login', { user, method: 'host' });
  }

  /** @type {Auth['clearTokens']} */
  function clearTokens() {
    const had = accessToken !== null || refreshToken !== null;
    dropTokens();
    setSession({ status: restingStatus(), user: null, accessExpiresAt: null }, 'session/clear');
    if (had) emit('auth:logout', { reason: 'cleared', everywhere: false });
  }

  // ── refresh (single‑flight) ──

  /**
   * @param {RequestOpts} [opts]
   * @returns {Promise<Tokens>}
   */
  async function doRefresh(opts) {
    if (!canRefresh()) {
      const err = new AuthError('No refresh token available', { reason: 'expired' });
      if (accessToken) expire('no_refresh_token', err);
      throw err;
    }
    setSession({ status: 'refreshing' }, 'session/refresh');
    let data;
    try {
      data = await call('auth.refresh', {
        body: strategy === 'bearer' ? { refreshToken } : {},
        opts,
        auth: false,
      });
    } catch (e) {
      const err = isSdkError(e) ? e : wrap(e);
      if (isDefinitiveRefreshFailure(err)) {
        expire('refresh_rejected', err);
        throw new AuthError('Session expired', {
          reason: 'expired',
          cause: err,
          requestId: err.requestId,
          details: { status: /** @type {any} */ (err).status },
        });
      }
      // Transient: keep the session, let the caller retry.
      setSession({ status: restingStatus() }, 'session/refreshFailed');
      throw err;
    }
    const tokens = readTokens(data, now());
    if (!tokens) {
      const err = new AuthError('Refresh response carried no access token', { reason: 'expired' });
      expire('refresh_invalid', err);
      throw err;
    }
    applyTokens(tokens, 'session/refreshed');
    if (tokens.user) setAccountUser(tokens.user);
    emit('auth:refreshed', { expiresAt: expiry ? expiry.iso : null, user });
    return publicTokens();
  }

  /** @type {Auth['refresh']} */
  const refresh = singleFlight(null, doRefresh);

  // ── guest sessions (single‑flight) ──

  /**
   * @param {RequestOpts} [opts]
   * @returns {Promise<{ guestId: string, guestToken: string }>}
   */
  async function doEnsureGuestSession(opts) {
    if (guestId !== null && guestToken !== null) return { guestId, guestToken };
    if (!guestEnabled) {
      throw new AuthError('Guest sessions are disabled (config.auth.guest = false)', {
        reason: 'forbidden',
      });
    }
    const data = await call('auth.ensureGuestSession', { body: {}, opts });
    const d = isPlainObject(data) ? data : {};
    const id = str(d.guestId) || str(d.guest_id) || str(d.sessionId) || str(d.id);
    const token = str(d.guestToken) || str(d.guest_token) || str(d.token);
    if (!id || !token) {
      throw new SdkError('Guest session response is missing guestId or guestToken', {
        code: 'GUEST_SESSION_INVALID',
        details: { keys: Object.keys(d) },
      });
    }
    guestId = id;
    guestToken = token;
    const exp = toExpiry(d.expiresAt ?? d.expires_at);
    persistGuest(exp ? exp.ms : undefined);
    setSession({ guestId, status: restingStatus() }, 'session/guest');
    emit('auth:guest', { guestId, reused: false });
    return { guestId, guestToken };
  }

  /** @type {Auth['ensureGuestSession']} */
  const ensureGuestSession = singleFlight(null, doEnsureGuestSession);

  // ── claim flow ──

  /** @type {Auth['claimAccount']} */
  async function claimAccount(input, opts) {
    const i = requireObject(input, 'claim request');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(
      issues,
      CLAIM_CHANNELS.includes(i.channel),
      'channel',
      'enum',
      `channel must be one of ${CLAIM_CHANNELS.join(' | ')}`
    );
    check(
      issues,
      i.destination === undefined || !!str(i.destination),
      'destination',
      'type',
      'destination must be a non-empty string'
    );
    check(
      issues,
      i.bookingId === undefined || !!str(i.bookingId),
      'bookingId',
      'type',
      'bookingId must be a non-empty string'
    );
    assertValid('claim request', issues);
    if (!isGuest()) {
      throw new AuthError('Only a guest session can be claimed', {
        reason: 'forbidden',
        details: { status: session().status },
      });
    }
    const data = await call('auth.claimAccount', {
      body: compact({
        guestId,
        guestToken,
        channel: i.channel,
        destination: str(i.destination),
        bookingId: str(i.bookingId),
      }),
      opts,
      auth: false,
    });
    const d = isPlainObject(data) ? data : {};
    const exp = toExpiry(d.expiresAt ?? d.expires_at);
    const result = {
      sentTo: str(d.sentTo) || str(d.sent_to) || str(i.destination) || '',
      expiresAt: exp ? exp.iso : null,
      challengeId: str(d.challengeId) || str(d.challenge_id) || '',
    };
    /** @type {ClaimState} */
    const claim = { ...result, channel: i.channel, bookingId: str(i.bookingId) || null };
    setSession({ claim }, 'session/claimSent');
    emit('auth:claimSent', { ...claim });
    return result;
  }

  /** @type {Auth['completeClaim']} */
  async function completeClaim(input, opts) {
    const i = requireObject(input, 'claim completion');
    const pending = session().claim;
    const token = str(i.token);
    const challengeId = str(i.challengeId) || (pending ? str(pending.challengeId) : undefined);
    const otp = str(i.otp);
    /** @type {ValidationIssue[]} */
    const issues = [];
    if (typeof i.password !== 'string' || i.password === '') {
      issues.push({ path: 'password', code: 'required', message: 'password is required' });
    } else {
      issues.push(...validate(schemas.password(), i.password, { path: 'password' }).issues);
    }
    check(
      issues,
      !!token || (!!challengeId && !!otp),
      token || challengeId ? 'otp' : 'token',
      'required',
      'either token or challengeId + otp is required'
    );
    check(
      issues,
      i.consents === undefined || isPlainObject(i.consents),
      'consents',
      'type',
      'consents must be an object'
    );
    assertValid('claim completion', issues);
    const data = await call('auth.completeClaim', {
      body: compact({
        guestId: guestId || undefined,
        guestToken: guestToken || undefined,
        token,
        challengeId: token ? undefined : challengeId,
        otp: token ? undefined : otp,
        password: i.password,
        consents: i.consents,
      }),
      opts,
      auth: false,
    });
    const tokens = readTokens(data, now());
    if (!tokens) {
      throw new AuthError('The backend returned no access token', {
        reason: 'unauthenticated',
        details: { method: 'claim' },
      });
    }
    dropGuest();
    applyTokens(tokens, 'session/claimed');
    setSession({ claim: null }, 'session/claimed');
    setAccountUser(user);
    emit('auth:claimed', { user });
    emit('auth:login', { user, method: 'claim' });
    return /** @type {User} */ (user);
  }

  // ── register / login variants ──

  /** @type {Auth['register']} */
  async function register(input, opts) {
    const i = requireObject(input, 'registration');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(
      issues,
      i.email !== undefined || i.phone !== undefined || !!str(i.otpChallengeId),
      'email',
      'required',
      'email, phone or otpChallengeId is required'
    );
    check(issues, i.email === undefined || isEmail(i.email), 'email', 'format', 'email is invalid');
    check(issues, i.phone === undefined || isPhone(i.phone), 'phone', 'format', 'phone is invalid');
    if (i.password !== undefined) {
      if (typeof i.password !== 'string') {
        issues.push({ path: 'password', code: 'type', message: 'password must be a string' });
      } else {
        issues.push(...validate(schemas.password(), i.password, { path: 'password' }).issues);
      }
    }
    for (const field of ['firstName', 'lastName', 'otpChallengeId']) {
      check(
        issues,
        i[field] === undefined || !!str(i[field]),
        field,
        'type',
        `${field} must be a non-empty string`
      );
    }
    check(issues, isPlainObject(i.consents), 'consents', 'required', 'consents is required');
    assertValid('registration', issues);
    const data = await call('auth.register', {
      body: compact({
        email: i.email,
        phone: i.phone,
        password: i.password,
        firstName: i.firstName,
        lastName: i.lastName,
        consents: i.consents,
        otpChallengeId: i.otpChallengeId,
        guestId: guestId || undefined,
      }),
      opts,
      auth: false,
    });
    return completeLogin(data, 'register', 'session/register');
  }

  /**
   * Emit `auth:mfaRequired` for a challenge and build the matching error.
   * @param {Record<string, any>} challenge
   * @param {unknown} [cause]
   * @returns {AuthError}
   */
  function mfaRequired(challenge, cause) {
    const payload = {
      challengeId: str(challenge.challengeId) || str(challenge.challenge_id) || null,
      methods: Array.isArray(challenge.methods) ? challenge.methods : [],
    };
    emit('auth:mfaRequired', payload);
    if (cause instanceof AuthError) return cause;
    return new AuthError('Multi-factor authentication required', {
      reason: 'mfa_required',
      details: payload,
      cause,
    });
  }

  /** @type {Auth['loginWithPassword']} */
  async function loginWithPassword(input, opts) {
    const i = requireObject(input, 'login');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, !!str(i.identifier), 'identifier', 'required', 'identifier is required');
    check(
      issues,
      typeof i.password === 'string' && i.password !== '',
      'password',
      'required',
      'password is required'
    );
    check(
      issues,
      i.remember === undefined || typeof i.remember === 'boolean',
      'remember',
      'type',
      'remember must be a boolean'
    );
    assertValid('login', issues);
    let data;
    try {
      data = await call('auth.loginWithPassword', {
        body: compact({
          identifier: i.identifier,
          password: i.password,
          remember: i.remember,
          guestId: guestId || undefined,
        }),
        opts,
        auth: false,
      });
    } catch (e) {
      if (e instanceof AuthError && e.reason === 'mfa_required') {
        const details = isPlainObject(e.details) ? e.details : {};
        const problem = isPlainObject(e.problem) ? e.problem : {};
        throw mfaRequired({ ...problem, ...details }, e);
      }
      throw e;
    }
    const d = isPlainObject(data) ? data : {};
    if (
      !readTokens(d, now()) &&
      (d.mfaRequired === true || d.requires === 'mfa' || d.status === 'mfa_required')
    ) {
      throw mfaRequired(d);
    }
    remember = i.remember !== false;
    return completeLogin(data, 'password', 'session/login');
  }

  /** @type {Auth['requestOtp']} */
  async function requestOtp(input, opts) {
    const i = requireObject(input, 'OTP request');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(
      issues,
      OTP_CHANNELS.includes(i.channel),
      'channel',
      'enum',
      `channel must be one of ${OTP_CHANNELS.join(' | ')}`
    );
    check(issues, !!str(i.identifier), 'identifier', 'required', 'identifier is required');
    check(
      issues,
      OTP_PURPOSES.includes(i.purpose),
      'purpose',
      'enum',
      `purpose must be one of ${OTP_PURPOSES.join(' | ')}`
    );
    assertValid('OTP request', issues);
    const data = await call('auth.requestOtp', {
      body: { channel: i.channel, identifier: i.identifier, purpose: i.purpose },
      opts,
      auth: false,
    });
    const d = isPlainObject(data) ? data : {};
    const exp = toExpiry(d.expiresAt ?? d.expires_at);
    const resend = d.resendAfterMs ?? d.resend_after_ms;
    return {
      challengeId: str(d.challengeId) || str(d.challenge_id) || '',
      expiresAt: exp ? exp.iso : null,
      resendAfterMs: typeof resend === 'number' && Number.isFinite(resend) ? resend : 0,
    };
  }

  /** @type {Auth['verifyOtp']} */
  async function verifyOtp(input, opts) {
    const i = requireObject(input, 'OTP verification');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, !!str(i.challengeId), 'challengeId', 'required', 'challengeId is required');
    check(issues, !!str(i.code), 'code', 'required', 'code is required');
    check(
      issues,
      i.remember === undefined || typeof i.remember === 'boolean',
      'remember',
      'type',
      'remember must be a boolean'
    );
    assertValid('OTP verification', issues);
    const data = await call('auth.verifyOtp', {
      body: compact({
        challengeId: i.challengeId,
        code: i.code,
        remember: i.remember,
        guestId: guestId || undefined,
      }),
      opts,
      auth: false,
    });
    const d = isPlainObject(data) ? data : {};
    if (!readTokens(d, now()) && (d.requires === 'register' || d.registered === false)) {
      return { challengeId: str(d.challengeId) || i.challengeId, requires: 'register' };
    }
    remember = i.remember !== false;
    return completeLogin(data, 'otp', 'session/login');
  }

  /** @type {Auth['getProviderUrl']} */
  async function getProviderUrl(provider, input, opts) {
    const i = requireObject(input, 'provider URL request');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, !!str(provider), 'provider', 'required', 'provider is required');
    check(issues, !!str(i.redirectUri), 'redirectUri', 'required', 'redirectUri is required');
    check(
      issues,
      i.state === undefined || typeof i.state === 'string',
      'state',
      'type',
      'state must be a string'
    );
    assertValid('provider URL request', issues);
    const query = compact({ redirectUri: i.redirectUri, state: i.state });
    const data = await call('auth.getProviderUrl', {
      params: { provider: String(provider) },
      opts: {
        ...(isPlainObject(opts) ? opts : {}),
        query: { ...((opts && opts.query) || {}), ...query },
      },
      auth: false,
    });
    const url =
      typeof data === 'string' ? str(data) : isPlainObject(data) ? str(data.url) : undefined;
    if (!url) {
      throw new SdkError('The backend returned no provider URL', {
        code: 'PROVIDER_URL_MISSING',
        details: { provider },
      });
    }
    return url;
  }

  /** @type {Auth['loginWithProvider']} */
  async function loginWithProvider(input, opts) {
    const i = requireObject(input, 'provider login');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, !!str(i.provider), 'provider', 'required', 'provider is required');
    check(
      issues,
      !!str(i.code) || !!str(i.idToken),
      'code',
      'required',
      'code or idToken is required'
    );
    for (const field of ['redirectUri', 'nonce']) {
      check(
        issues,
        i[field] === undefined || !!str(i[field]),
        field,
        'type',
        `${field} must be a non-empty string`
      );
    }
    assertValid('provider login', issues);
    const data = await call('auth.loginWithProvider', {
      params: { provider: i.provider },
      body: compact({
        code: str(i.code),
        idToken: str(i.idToken),
        redirectUri: str(i.redirectUri),
        nonce: str(i.nonce),
        guestId: guestId || undefined,
      }),
      opts,
      auth: false,
    });
    return completeLogin(data, 'provider', 'session/login');
  }

  /** @type {Auth['requestMagicLink']} */
  async function requestMagicLink(input, opts) {
    const i = requireObject(input, 'magic link request');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, isEmail(i.email), 'email', 'format', 'email is invalid');
    check(issues, !!str(i.redirectUri), 'redirectUri', 'required', 'redirectUri is required');
    assertValid('magic link request', issues);
    await call('auth.requestMagicLink', {
      body: { email: i.email, redirectUri: i.redirectUri },
      opts,
      auth: false,
    });
  }

  /** @type {Auth['consumeMagicLink']} */
  async function consumeMagicLink(token, opts) {
    if (!str(token)) {
      throw new ValidationError('token is required', {
        issues: [{ path: 'token', code: 'required', message: 'token is required' }],
      });
    }
    const data = await call('auth.consumeMagicLink', {
      body: compact({ token, guestId: guestId || undefined }),
      opts,
      auth: false,
    });
    return completeLogin(data, 'magic_link', 'session/login');
  }

  /** @type {Auth['mfa']['verify']} */
  async function verifyMfa(input, opts) {
    const i = requireObject(input, 'MFA verification');
    /** @type {ValidationIssue[]} */
    const issues = [];
    check(issues, !!str(i.challengeId), 'challengeId', 'required', 'challengeId is required');
    check(issues, !!str(i.code), 'code', 'required', 'code is required');
    check(
      issues,
      i.method === undefined || !!str(i.method),
      'method',
      'type',
      'method must be a non-empty string'
    );
    assertValid('MFA verification', issues);
    const data = await call('auth.mfa.verify', {
      body: compact({ challengeId: i.challengeId, code: i.code, method: str(i.method) }),
      opts,
      auth: false,
    });
    return completeLogin(data, 'mfa', 'session/login');
  }

  // ── logout ──

  /** @type {Auth['logout']} */
  async function logout(input, opts) {
    const i = input === undefined || input === null ? {} : requireObject(input, 'logout options');
    if (i.everywhere !== undefined && typeof i.everywhere !== 'boolean') {
      throw new ValidationError('everywhere must be a boolean', {
        issues: [{ path: 'everywhere', code: 'type', message: 'everywhere must be a boolean' }],
      });
    }
    const everywhere = i.everywhere === true;
    if (accessToken !== null) {
      try {
        await call('auth.logout', { body: { everywhere }, opts });
      } catch (e) {
        log('debug', 'auth: logout request failed (ignored)', { error: e });
      }
    }
    dropTokens();
    dropGuest();
    if (isFn(http.abort)) {
      try {
        http.abort(AUTHED_TAG, 'logout');
      } catch (e) {
        log('warn', 'auth: could not abort authed requests', { error: e });
      }
    }
    const resetAll = () => {
      for (const slice of RESET_SLICES) {
        const has = isFn(store.hasSlice) ? store.hasSlice(slice) : slice === 'session';
        if (!has) continue;
        try {
          store.reset(slice);
        } catch (e) {
          log('warn', `auth: could not reset slice '${slice}'`, { error: e });
        }
      }
    };
    if (isFn(store.batch)) store.batch(resetAll);
    else resetAll();
    emit('auth:logout', { reason: 'logout', everywhere });
  }

  // ── subscriptions / lifecycle ──

  /** @type {Auth['onChange']} */
  function onChange(fn) {
    if (!isFn(fn)) {
      throw new ValidationError('fn must be a function', {
        issues: [{ path: 'fn', code: 'type', message: 'fn must be a function' }],
      });
    }
    if (destroyed) return () => {};
    const off = store.subscribe(
      (s) => (isPlainObject(s) ? s.session : undefined),
      (value) => {
        if (isPlainObject(value)) fn(/** @type {SessionState} */ (value));
      }
    );
    const release = () => {
      offs.delete(release);
      off();
    };
    offs.add(release);
    return release;
  }

  /** @type {Auth['destroy']} */
  function destroy() {
    destroyed = true;
    clearRefreshTimer();
    for (const release of [...offs]) release();
    offs.clear();
  }

  // ── bootstrap: slice, endpoints, persisted identity ──

  store.registerSlice('session', { initial: SESSION_INITIAL, secret: true });
  seedEndpoints();

  guestId = readKey(guestStorage(), KEYS.guestId);
  guestToken = readKey(guestStorage(), KEYS.guestToken);
  if (!guestId || !guestToken) {
    guestId = null;
    guestToken = null;
  }
  refreshToken = readKey(storageFor(tokenKind), KEYS.refreshToken);
  const initialStatus = restingStatus();
  const current = session();
  if (current.status !== initialStatus || current.guestId !== guestId) {
    setSession({ status: initialStatus, guestId }, 'session/restore');
  }
  // A persisted refresh token restores the session proactively (the access token never persists).
  if (refreshToken !== null && accessToken === null) armRefresh(0);

  return {
    getAccessToken,
    isAuthenticated,
    getUser,
    getSessionId,
    setTokens,
    clearTokens,
    refresh,
    ensureGuestSession,
    isGuest,
    getGuestToken,
    claimAccount,
    completeClaim,
    register,
    loginWithPassword,
    requestOtp,
    verifyOtp,
    getProviderUrl,
    loginWithProvider,
    requestMagicLink,
    consumeMagicLink,
    mfa: { verify: verifyMfa },
    logout,
    onChange,
    willExpireWithin,
    getExpiry,
    destroy,
  };
}
