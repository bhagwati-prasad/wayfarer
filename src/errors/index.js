/**
 * Error taxonomy for the Wayfarer SDK (docs/api/02-state-events-errors.md §3): the `SdkError` class
 * tree, the RFC 9457 `application/problem+json` → error mapping (`errorFromProblem`,
 * `errorFromResponse`), `wrap` for normalising anything thrown, `toUserMessage` for user‑safe,
 * localisable copy and the canonical `ERROR_CODES`. Everything here is pure and SSR‑safe: no I/O, no
 * DOM, no timers, no module‑level mutable state, no logging. It must never throw a plain `Error`
 * itself, and `toUserMessage` must never surface server‑supplied text (titles, details, stack traces).
 */

// ── shared typedefs (from src/types.js, the JSDoc mirror of docs/api/00-types.md) ───────────────

/** @typedef {import('../types.js').Money} Money */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../types.js').Problem} Problem  RFC 9457 document (+ `code`, `errors`, `requestId` extensions). */
/** @typedef {NonNullable<Problem['errors']>[number]} ProblemIssue  Amadeus‑style `errors[]` entry. */
/** @typedef {import('../types.js').TripAction} TripAction */

/**
 * @typedef {Object} SdkErrorOptions
 * @property {string} [code]        Stable machine‑readable code (defaults per class).
 * @property {unknown} [cause]      The original thrown value, when wrapping.
 * @property {string} [requestId]   Correlation id of the failed request.
 * @property {boolean} [retryable]  Whether repeating the operation may succeed (defaults per class).
 * @property {unknown} [details]    Free‑form, non‑user‑facing detail.
 * @property {number} [at]          Timestamp (ms); defaults to `Date.now()`.
 */
/**
 * @typedef {SdkErrorOptions & { status?: number, problem?: Problem, issues?: ProblemIssue[], meta?: Record<string, unknown> }} ApiErrorOptions
 */
/** @typedef {'unauthenticated'|'expired'|'forbidden'|'invalid_credentials'|'mfa_required'|'otp_invalid'|'otp_expired'|'locked'} AuthReason */
/** @typedef {'sold_out'|'withdrawn'|'schedule_changed'} OfferUnavailableReason */
/** @typedef {'create'|'hold'|'confirm'|'ticketing'} BookingStage */
/** @typedef {'retry_payment'|'search_again'|'contact_support'|'wait'} BookingSuggestedAction */
/** @typedef {'declined'|'insufficient_funds'|'authentication_failed'|'expired'|'cancelled'|'gateway'|'fraud'|'method_unavailable'|'requires_action'} PaymentReason */
/** @typedef {'retry'|'search_again'|'login'|'contact_support'} UserAction */
/** @typedef {{ title: string, message: string, action?: UserAction }} UserMessage */
/** @typedef {(key: string, vars?: Record<string, unknown>, opts?: { count?: number, default?: string }) => string} TranslateFn */

/**
 * Context handed to custom `map` factories by `errorFromProblem`.
 * @typedef {Object} ProblemContext
 * @property {Problem} problem
 * @property {string} code
 * @property {number} status
 * @property {string} message
 * @property {string|undefined} requestId
 * @property {ProblemIssue[]|undefined} issues
 * @property {Record<string, unknown>} ext        Extension members of the problem (everything non‑standard).
 * @property {Record<string, unknown>} meta
 * @property {number|undefined} retryAfterMs
 */

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

const BRAND = Symbol.for('@wayfarer/sdk/SdkError');

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string|undefined} */
function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** @param {unknown} v @returns {number|undefined} */
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** @param {unknown} v @returns {boolean|undefined} */
function bool(v) {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * @template T
 * @param {unknown} v @param {readonly T[]} allowed @returns {T|undefined}
 */
function oneOf(v, allowed) {
  return allowed.includes(/** @type {T} */ (v)) ? /** @type {T} */ (v) : undefined;
}

/**
 * Apply defaults only where the caller left the option undefined/null.
 * @template {object} T
 * @param {T} options @param {Partial<T>} defs @returns {T}
 */
function withDefaults(options, defs) {
  const out = { ...(options || {}) };
  for (const k of Object.keys(defs)) {
    if (out[k] === undefined || out[k] === null) out[k] = defs[k];
  }
  return /** @type {T} */ (out);
}

/** @param {unknown} v @returns {number} */
function toStatus(v) {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Upper‑snake normalisation of a backend code; `undefined` when it is not code‑shaped. */
function normalizeCode(v) {
  if (typeof v !== 'string') return undefined;
  const s = v
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toUpperCase();
  return /^[A-Z][A-Z0-9_]*$/.test(s) ? s : undefined;
}

/** `https://api.ota.com/problems/offer-expired` → `OFFER_EXPIRED`; `about:blank` → undefined. */
function codeFromType(type) {
  if (typeof type !== 'string') return undefined;
  const t = type.trim();
  if (!t || t === 'about:blank') return undefined;
  const bare = t.split(/[?#]/)[0].replace(/\/+$/, '');
  const segments = bare.split(/[/:]/).filter(Boolean);
  if (segments.length < 2 && !/^[a-z]/i.test(bare)) return undefined;
  const last = segments[segments.length - 1];
  return last && !/^https?$/i.test(last) ? normalizeCode(last) : undefined;
}

/** @param {unknown} v @returns {Money|undefined} */
function toMoney(v) {
  if (!isObject(v)) return undefined;
  const amount = v.amount;
  const currency = str(v.currency);
  if ((typeof amount === 'string' && amount !== '') || typeof amount === 'number') {
    return { amount: String(amount), currency: currency || '' };
  }
  return undefined;
}

const STATUS_CODES = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  423: 'LOCKED',
  425: 'TOO_EARLY',
  428: 'PRECONDITION_REQUIRED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVER_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
});

const STATUS_TEXT = Object.freeze({
  400: 'Bad request',
  401: 'Authentication required',
  402: 'Payment required',
  403: 'Access denied',
  404: 'Not found',
  408: 'Request timeout',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable request',
  425: 'Too early',
  429: 'Too many requests',
  500: 'Internal server error',
  501: 'Not implemented',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
});

/** @param {number} status @returns {string} */
function codeForStatus(status) {
  if (!status) return 'API_ERROR';
  return STATUS_CODES[status] || `HTTP_${status}`;
}

/** @param {number} status @returns {string} */
function messageForStatus(status) {
  if (!status) return 'Request failed';
  const text = STATUS_TEXT[status];
  return text ? `${text} (HTTP ${status})` : `Request failed with status ${status}`;
}

/** Transport‑level retry policy by status (CONTRIBUTING §4). */
function statusRetryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const PROBLEM_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'errors',
  'requestId',
]);

/** Extension members of a problem document (everything outside RFC 9457 + known extensions). */
function problemExtensions(problem) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!isObject(problem)) return out;
  for (const [k, v] of Object.entries(problem)) {
    if (!PROBLEM_MEMBERS.has(k)) out[k] = v;
  }
  return out;
}

/** JSON pointer (`/data/travelers/0/lastName`) → dotted path (`data.travelers.0.lastName`). */
function pointerToPath(pointer) {
  if (typeof pointer !== 'string' || !pointer) return undefined;
  const parts = pointer
    .replace(/^#/, '')
    .split('/')
    .filter((p) => p !== '')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  return parts.length ? parts.join('.') : undefined;
}

/** @param {unknown} issues @returns {Record<string, string[]>} */
function fieldErrorsFromIssues(issues) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (!Array.isArray(issues)) return out;
  for (const issue of issues) {
    if (!isObject(issue)) continue;
    const source = isObject(issue.source) ? issue.source : {};
    const path =
      pointerToPath(source.pointer) ||
      str(source.parameter) ||
      str(issue.path) ||
      str(issue.field) ||
      '_';
    const message =
      str(issue.detail) ||
      str(issue.message) ||
      str(issue.title) ||
      (issue.code !== undefined && issue.code !== null ? String(issue.code) : 'invalid');
    (out[path] ||= []).push(message);
  }
  return out;
}

/** @param {unknown} v @returns {Record<string, string[]>|undefined} */
function asFieldErrors(v) {
  if (!isObject(v)) return undefined;
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (Array.isArray(val)) out[k] = val.map((m) => String(m));
    else if (typeof val === 'string') out[k] = [val];
  }
  return out;
}

// ── class tree ──────────────────────────────────────────────────────────────────────────────────

/**
 * Root of every error the SDK raises or rejects with.
 * Fields: `code`, `message`, `cause?`, `requestId?`, `retryable`, `details?`, `at`.
 */
export class SdkError extends Error {
  /**
   * @param {string} message
   * @param {SdkErrorOptions} [options]
   */
  constructor(message, options = {}) {
    super(str(message) || 'Unknown error');
    const o = options || {};
    this.name = 'SdkError';
    /** @type {string} */
    this.code = str(o.code) || 'SDK_ERROR';
    /** @type {boolean} */
    this.retryable = o.retryable === true;
    /** @type {string|undefined} */
    this.requestId = str(o.requestId);
    /** @type {unknown} */
    this.details = o.details;
    /** @type {number} */
    this.at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now();
    if (o.cause !== undefined) {
      /** @type {unknown} */
      this.cause = o.cause;
    }
  }

  /** Serialisable view (drops `cause` and `stack`). @returns {Record<string, unknown>} */
  toJSON() {
    /** @type {Record<string, unknown>} */
    const out = { name: this.name, code: this.code, message: this.message };
    for (const key of Object.keys(this)) {
      if (key === 'cause' || key === 'stack' || key in out) continue;
      const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (this))[key];
      if (typeof value !== 'function') out[key] = value;
    }
    return out;
  }
}
Object.defineProperty(SdkError.prototype, BRAND, { value: true });

/** Invalid or incompatible client configuration. */
export class ConfigError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message || 'Invalid configuration', withDefaults(options, { code: 'CONFIG_ERROR' }));
    this.name = 'ConfigError';
  }
}

/** Client‑side validation failed before any network call; `issues` lists every problem found. */
export class ValidationError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions & { issues?: ValidationIssue[] }} [options] */
  constructor(message, options = {}) {
    super(message || 'Validation failed', withDefaults(options, { code: 'VALIDATION_FAILED' }));
    this.name = 'ValidationError';
    /** @type {ValidationIssue[]} */
    this.issues = Array.isArray(options?.issues) ? options.issues : [];
  }
}

/** The request never reached the server or no response came back (offline, DNS, CORS, reset). */
export class NetworkError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Network error',
      withDefaults(options, { code: 'NETWORK_ERROR', retryable: true })
    );
    this.name = 'NetworkError';
  }
}

/** An operation exceeded its time budget (`timeoutMs`). */
export class TimeoutError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions & { timeoutMs?: number }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Operation timed out',
      withDefaults(options, { code: 'TIMEOUT', retryable: true })
    );
    this.name = 'TimeoutError';
    /** @type {number|undefined} */
    this.timeoutMs = num(options?.timeoutMs);
  }
}

/** An operation was aborted (user signal, `http.abort(tag)`, `destroy()`); `reason` says why. */
export class AbortError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions & { reason?: string }} [options] */
  constructor(message, options = {}) {
    super(message || 'Operation aborted', withDefaults(options, { code: 'ABORTED' }));
    this.name = 'AbortError';
    /** @type {string} */
    this.reason = str(options?.reason) || 'aborted';
  }
}

/** The storage adapter failed (quota, private mode, serialisation). */
export class StorageError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions} [options] */
  constructor(message, options = {}) {
    super(message || 'Storage error', withDefaults(options, { code: 'STORAGE_ERROR' }));
    this.name = 'StorageError';
  }
}

/** A `feature` is not available in this runtime or configuration. */
export class UnsupportedError extends SdkError {
  /** @param {string} message @param {SdkErrorOptions & { feature?: string }} [options] */
  constructor(message, options = {}) {
    super(message || 'Unsupported feature', withDefaults(options, { code: 'UNSUPPORTED' }));
    this.name = 'UnsupportedError';
    /** @type {string} */
    this.feature = str(options?.feature) || 'unknown';
  }
}

/**
 * The server answered with an error. RFC 9457 fields stay on `problem`; Amadeus‑style `errors[]` on
 * `issues`; extension members on `details`; transport info (`contentType`, `retryAfterMs`) on `meta`.
 * Retryable by default only for 408 / 425 / 429 / 5xx.
 */
export class ApiError extends SdkError {
  /** @param {string} message @param {ApiErrorOptions} [options] */
  constructor(message, options = {}) {
    const o = options || {};
    const status = toStatus(o.status);
    super(
      message || messageForStatus(status),
      withDefaults(o, { code: codeForStatus(status), retryable: statusRetryable(status) })
    );
    this.name = 'ApiError';
    /** @type {number} */
    this.status = status;
    /** @type {Problem|undefined} */
    this.problem = isObject(o.problem) ? /** @type {Problem} */ (o.problem) : undefined;
    /** @type {ProblemIssue[]|undefined} */
    this.issues = Array.isArray(o.issues)
      ? o.issues
      : this.problem && Array.isArray(this.problem.errors)
        ? this.problem.errors
        : undefined;
    if (this.details === undefined) {
      this.details = this.problem ? problemExtensions(this.problem) : {};
    }
    /** @type {Record<string, unknown>} */
    this.meta = isObject(o.meta) ? { ...o.meta } : {};
  }
}

const AUTH_REASONS = /** @type {const} */ ([
  'unauthenticated',
  'expired',
  'forbidden',
  'invalid_credentials',
  'mfa_required',
  'otp_invalid',
  'otp_expired',
  'locked',
]);
const AUTH_REASON_CODE = Object.freeze({
  unauthenticated: 'UNAUTHENTICATED',
  expired: 'SESSION_EXPIRED',
  forbidden: 'FORBIDDEN',
  invalid_credentials: 'INVALID_CREDENTIALS',
  mfa_required: 'MFA_REQUIRED',
  otp_invalid: 'OTP_INVALID',
  otp_expired: 'OTP_EXPIRED',
  locked: 'ACCOUNT_LOCKED',
});
const AUTH_CODE_REASON = Object.freeze(
  Object.fromEntries(Object.entries(AUTH_REASON_CODE).map(([r, c]) => [c, r]))
);
const AUTH_MESSAGES = Object.freeze({
  unauthenticated: 'Authentication required',
  expired: 'Session expired',
  forbidden: 'Access denied',
  invalid_credentials: 'Invalid credentials',
  mfa_required: 'Multi-factor authentication required',
  otp_invalid: 'Invalid one-time code',
  otp_expired: 'One-time code expired',
  locked: 'Account locked',
});

/** Authentication / authorisation failure; `reason` drives the UI (login, MFA, OTP, locked…). */
export class AuthError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { reason?: AuthReason }} [options] */
  constructor(message, options = {}) {
    const reason = oneOf(options?.reason, AUTH_REASONS) || 'unauthenticated';
    super(
      message || AUTH_MESSAGES[reason],
      withDefaults(options, {
        code: AUTH_REASON_CODE[reason],
        status: reason === 'forbidden' ? 403 : 401,
        retryable: false,
      })
    );
    this.name = 'AuthError';
    /** @type {AuthReason} */
    this.reason = reason;
  }
}

/** HTTP 429; `retryAfterMs` comes from `Retry-After` (undefined when the server gave none). */
export class RateLimitError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { retryAfterMs?: number }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Too many requests',
      withDefaults(options, { code: 'RATE_LIMITED', status: 429, retryable: true })
    );
    this.name = 'RateLimitError';
    const ms = num(options?.retryAfterMs);
    /** @type {number|undefined} */
    this.retryAfterMs = ms !== undefined && ms >= 0 ? ms : undefined;
  }
}

/** HTTP 404 / unknown resource. */
export class NotFoundError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Not found',
      withDefaults(options, { code: 'NOT_FOUND', status: 404, retryable: false })
    );
    this.name = 'NotFoundError';
  }
}

/** HTTP 409 / state conflict (seat taken, stale version…). */
export class ConflictError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Conflict',
      withDefaults(options, { code: 'CONFLICT', status: 409, retryable: false })
    );
    this.name = 'ConflictError';
  }
}

/** The search session (`sessionId`) is gone; the user must search again. */
export class SearchExpiredError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { sessionId?: string }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Search session expired',
      withDefaults(options, { code: 'SEARCH_EXPIRED', status: 410, retryable: false })
    );
    this.name = 'SearchExpiredError';
    /** @type {string|undefined} */
    this.sessionId = str(options?.sessionId);
  }
}

/** The offer (`offerId`) can no longer be priced or booked because it expired. */
export class OfferExpiredError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { offerId?: string }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Offer expired',
      withDefaults(options, { code: 'OFFER_EXPIRED', status: 410, retryable: false })
    );
    this.name = 'OfferExpiredError';
    /** @type {string|undefined} */
    this.offerId = str(options?.offerId);
  }
}

const OFFER_UNAVAILABLE_REASONS = /** @type {const} */ ([
  'sold_out',
  'withdrawn',
  'schedule_changed',
]);
const OFFER_UNAVAILABLE_CODE_REASON = Object.freeze({
  SOLD_OUT: 'sold_out',
  OFFER_WITHDRAWN: 'withdrawn',
  SCHEDULE_CHANGED: 'schedule_changed',
  OFFER_UNAVAILABLE: 'withdrawn',
});

/** The offer (`offerId`) is no longer bookable: `sold_out` | `withdrawn` | `schedule_changed`. */
export class OfferUnavailableError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { offerId?: string, reason?: OfferUnavailableReason }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Offer unavailable',
      withDefaults(options, { code: 'OFFER_UNAVAILABLE', status: 410, retryable: false })
    );
    this.name = 'OfferUnavailableError';
    /** @type {string|undefined} */
    this.offerId = str(options?.offerId);
    /** @type {OfferUnavailableReason} */
    this.reason = oneOf(options?.reason, OFFER_UNAVAILABLE_REASONS) || 'sold_out';
  }
}

/** The fare moved between `from` and `to`; `newOfferId` / `itineraryId` point at the repriced item. */
export class PriceChangedError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { from?: Money, to?: Money, newOfferId?: string, itineraryId?: string }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Price changed',
      withDefaults(options, { code: 'PRICE_CHANGED', status: 409, retryable: false })
    );
    this.name = 'PriceChangedError';
    /** @type {Money|undefined} */
    this.from = toMoney(options?.from);
    /** @type {Money|undefined} */
    this.to = toMoney(options?.to);
    /** @type {string|undefined} */
    this.newOfferId = str(options?.newOfferId);
    /** @type {string|undefined} */
    this.itineraryId = str(options?.itineraryId);
  }
}

/** The server‑side cart (`itineraryId`) expired; the flow restarts from search. */
export class ItineraryExpiredError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { itineraryId?: string }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Itinerary expired',
      withDefaults(options, { code: 'ITINERARY_EXPIRED', status: 410, retryable: false })
    );
    this.name = 'ItineraryExpiredError';
    /** @type {string|undefined} */
    this.itineraryId = str(options?.itineraryId);
  }
}

const BOOKING_STAGES = /** @type {const} */ (['create', 'hold', 'confirm', 'ticketing']);
const BOOKING_ACTIONS = /** @type {const} */ ([
  'retry_payment',
  'search_again',
  'contact_support',
  'wait',
]);

/** Booking pipeline failure at `stage`; `recoverable` + `suggestedAction` tell the UI what to offer. */
export class BookingError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { stage?: BookingStage, recoverable?: boolean, suggestedAction?: BookingSuggestedAction }} [options] */
  constructor(message, options = {}) {
    const recoverable = bool(options?.recoverable) ?? false;
    super(
      message || 'Booking failed',
      withDefaults(options, { code: 'BOOKING_FAILED', status: 422, retryable: recoverable })
    );
    this.name = 'BookingError';
    /** @type {BookingStage} */
    this.stage = oneOf(options?.stage, BOOKING_STAGES) || 'create';
    /** @type {boolean} */
    this.recoverable = recoverable;
    /** @type {BookingSuggestedAction} */
    this.suggestedAction =
      oneOf(options?.suggestedAction, BOOKING_ACTIONS) ||
      (recoverable ? 'retry_payment' : 'contact_support');
  }
}

const PAYMENT_REASONS = /** @type {const} */ ([
  'declined',
  'insufficient_funds',
  'authentication_failed',
  'expired',
  'cancelled',
  'gateway',
  'fraud',
  'method_unavailable',
  'requires_action',
]);
const PAYMENT_REASON_CODE = Object.freeze({
  declined: 'PAYMENT_DECLINED',
  insufficient_funds: 'PAYMENT_INSUFFICIENT_FUNDS',
  authentication_failed: 'PAYMENT_AUTHENTICATION_FAILED',
  expired: 'PAYMENT_EXPIRED',
  cancelled: 'PAYMENT_CANCELLED',
  gateway: 'PAYMENT_GATEWAY_ERROR',
  fraud: 'PAYMENT_FRAUD',
  method_unavailable: 'PAYMENT_METHOD_UNAVAILABLE',
  requires_action: 'PAYMENT_REQUIRES_ACTION',
});
const PAYMENT_CODE_REASON = Object.freeze({
  ...Object.fromEntries(Object.entries(PAYMENT_REASON_CODE).map(([r, c]) => [c, r])),
  INSUFFICIENT_BALANCE: 'insufficient_funds',
  PAYMENT_FAILED: 'declined',
});

/** Payment failed or needs attention; `retryable` says whether the user may try again. */
export class PaymentError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { reason?: PaymentReason }} [options] */
  constructor(message, options = {}) {
    const reason = oneOf(options?.reason, PAYMENT_REASONS) || 'gateway';
    super(
      message || 'Payment failed',
      withDefaults(options, {
        code: PAYMENT_REASON_CODE[reason],
        status: 402,
        retryable: reason !== 'fraud',
      })
    );
    this.name = 'PaymentError';
    /** @type {PaymentReason} */
    this.reason = reason;
  }
}

const TRIP_ACTIONS = /** @type {const} */ ([
  'change',
  'cancel',
  'cancel_partial',
  'add_seats',
  'add_bags',
  'add_meals',
  'check_in',
  'name_correction',
  'special_assistance',
  'update_contact',
  'update_documents',
  'split_pnr',
  'download_eticket',
  'invoice',
  'gst_invoice',
  'resend',
  'pay_now',
  'void',
  'rebook',
  'support',
]);
const SERVICING_CODE_ACTION = Object.freeze({
  CHANGE_NOT_ALLOWED: 'change',
  CANCEL_NOT_ALLOWED: 'cancel',
});

/** A post‑booking `action` (change, cancel…) is not possible for the given `reason`. */
export class ServicingError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { action?: TripAction, reason?: string }} [options] */
  constructor(message, options = {}) {
    const action = oneOf(options?.action, TRIP_ACTIONS) || 'support';
    super(
      message || 'Action not allowed for this booking',
      withDefaults(options, {
        code:
          action === 'change'
            ? 'CHANGE_NOT_ALLOWED'
            : action === 'cancel' || action === 'cancel_partial'
              ? 'CANCEL_NOT_ALLOWED'
              : 'SERVICING_NOT_ALLOWED',
        status: 409,
        retryable: false,
      })
    );
    this.name = 'ServicingError';
    /** @type {TripAction} */
    this.action = action;
    /** @type {string} */
    this.reason = str(options?.reason) || 'not_allowed';
  }
}

/** HTTP 422 / server‑side validation; `fieldErrors` maps field paths to messages. */
export class UnprocessableError extends ApiError {
  /** @param {string} message @param {ApiErrorOptions & { fieldErrors?: Record<string, string[]> }} [options] */
  constructor(message, options = {}) {
    super(
      message || 'Unprocessable request',
      withDefaults(options, { code: 'UNPROCESSABLE', status: 422, retryable: false })
    );
    this.name = 'UnprocessableError';
    /** @type {Record<string, string[]>} */
    this.fieldErrors = asFieldErrors(options?.fieldErrors) || fieldErrorsFromIssues(this.issues);
  }
}

// ── predicates ──────────────────────────────────────────────────────────────────────────────────

/**
 * True for any error from this class tree, including copies from another bundle of the SDK (brand
 * symbol), so `instanceof` pitfalls across realms do not matter.
 * @param {unknown} e
 * @returns {e is SdkError}
 */
export function isSdkError(e) {
  if (e instanceof SdkError) return true;
  return typeof e === 'object' && e !== null && /** @type {any} */ (e)[BRAND] === true;
}

/**
 * Whether repeating the failed operation may succeed. Non‑SDK values are normalised through `wrap`
 * first, so a bare fetch `TypeError` counts as retryable and `null` does not.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isRetryable(e) {
  const err = isSdkError(e) ? e : wrap(e);
  return err.retryable === true;
}

/**
 * `e instanceof Class`, tolerant of duplicate SDK copies (falls back to constructor names along the
 * prototype chain for branded foreign errors). A string `Class` matches on `code` instead.
 * @param {unknown} e
 * @param {Function|string} Class
 * @returns {boolean}
 */
export function is(e, Class) {
  if (typeof Class === 'string') return isSdkError(e) && e.code === Class;
  if (typeof Class !== 'function') return false;
  if (e instanceof Class) return true;
  if (!isSdkError(e) || e instanceof SdkError) return false;
  let proto = Object.getPrototypeOf(e);
  while (proto) {
    if (proto.constructor && proto.constructor.name === Class.name) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

// ── problem → error ─────────────────────────────────────────────────────────────────────────────

/** Default backend code → class map (overridable per call via `map`). */
const DEFAULT_CODE_MAP = Object.freeze({
  OFFER_EXPIRED: OfferExpiredError,
  OFFER_UNAVAILABLE: OfferUnavailableError,
  SOLD_OUT: OfferUnavailableError,
  OFFER_WITHDRAWN: OfferUnavailableError,
  SCHEDULE_CHANGED: OfferUnavailableError,
  PRICE_CHANGED: PriceChangedError,
  SEARCH_EXPIRED: SearchExpiredError,
  ITINERARY_EXPIRED: ItineraryExpiredError,
  PAYMENT_DECLINED: PaymentError,
  PAYMENT_REQUIRES_ACTION: PaymentError,
  PAYMENT_INSUFFICIENT_FUNDS: PaymentError,
  PAYMENT_AUTHENTICATION_FAILED: PaymentError,
  PAYMENT_EXPIRED: PaymentError,
  PAYMENT_CANCELLED: PaymentError,
  PAYMENT_GATEWAY_ERROR: PaymentError,
  PAYMENT_FRAUD: PaymentError,
  PAYMENT_METHOD_UNAVAILABLE: PaymentError,
  PAYMENT_FAILED: PaymentError,
  INSUFFICIENT_BALANCE: PaymentError,
  BOOKING_FAILED: BookingError,
  HOLD_NOT_ALLOWED: BookingError,
  CHANGE_NOT_ALLOWED: ServicingError,
  CANCEL_NOT_ALLOWED: ServicingError,
  NAME_MISMATCH: UnprocessableError,
  DOCUMENT_INVALID: UnprocessableError,
  DUPLICATE_TRAVELER: UnprocessableError,
  PROMO_INVALID: UnprocessableError,
  PROMO_NOT_ELIGIBLE: UnprocessableError,
  PROMO_EXPIRED: UnprocessableError,
  GIFT_CARD_INVALID: UnprocessableError,
  VOUCHER_NOT_APPLICABLE: UnprocessableError,
  VALIDATION_FAILED: UnprocessableError,
  UNPROCESSABLE: UnprocessableError,
  SEAT_TAKEN: ConflictError,
  CONFLICT: ConflictError,
  SESSION_EXPIRED: AuthError,
  UNAUTHENTICATED: AuthError,
  INVALID_CREDENTIALS: AuthError,
  MFA_REQUIRED: AuthError,
  OTP_INVALID: AuthError,
  OTP_EXPIRED: AuthError,
  ACCOUNT_LOCKED: AuthError,
  FORBIDDEN: AuthError,
  RATE_LIMITED: RateLimitError,
  NOT_FOUND: NotFoundError,
});

/** @param {number} status @returns {typeof ApiError} */
function classForStatus(status) {
  switch (status) {
    case 401:
    case 403:
      return AuthError;
    case 404:
      return NotFoundError;
    case 409:
      return ConflictError;
    case 422:
      return UnprocessableError;
    case 429:
      return RateLimitError;
    default:
      return ApiError;
  }
}

/** @param {Function} Class @param {Function} Base */
function extendsClass(Class, Base) {
  return Class === Base || Class.prototype instanceof Base;
}

/** @param {unknown} v @returns {v is typeof SdkError} */
function isSdkErrorClass(v) {
  return typeof v === 'function' && extendsClass(v, SdkError);
}

/**
 * Class‑specific fields derived from the problem's extension members and code.
 * @param {typeof ApiError} Class
 * @param {ProblemContext} ctx
 * @returns {Record<string, unknown>}
 */
function fieldsFor(Class, ctx) {
  const { ext, code, status } = ctx;
  /** @type {Record<string, unknown>} */
  const f = {};
  if (extendsClass(Class, AuthError)) {
    f.reason =
      oneOf(ext.reason, AUTH_REASONS) ||
      AUTH_CODE_REASON[code] ||
      (status === 403 ? 'forbidden' : 'unauthenticated');
  } else if (extendsClass(Class, RateLimitError)) {
    const sec = num(ext.retryAfter);
    f.retryAfterMs =
      ctx.retryAfterMs ?? num(ext.retryAfterMs) ?? (sec !== undefined ? sec * 1000 : undefined);
  } else if (extendsClass(Class, SearchExpiredError)) {
    f.sessionId = str(ext.sessionId) || str(ext.searchId);
  } else if (extendsClass(Class, OfferExpiredError)) {
    f.offerId = str(ext.offerId);
  } else if (extendsClass(Class, OfferUnavailableError)) {
    f.offerId = str(ext.offerId);
    f.reason =
      oneOf(ext.reason, OFFER_UNAVAILABLE_REASONS) ||
      OFFER_UNAVAILABLE_CODE_REASON[code] ||
      'sold_out';
  } else if (extendsClass(Class, PriceChangedError)) {
    f.from = toMoney(ext.from) || toMoney(ext.oldPrice) || toMoney(ext.previousPrice);
    f.to = toMoney(ext.to) || toMoney(ext.newPrice);
    f.newOfferId = str(ext.newOfferId);
    f.itineraryId = str(ext.itineraryId);
  } else if (extendsClass(Class, ItineraryExpiredError)) {
    f.itineraryId = str(ext.itineraryId);
  } else if (extendsClass(Class, BookingError)) {
    f.stage = oneOf(ext.stage, BOOKING_STAGES) || (code === 'HOLD_NOT_ALLOWED' ? 'hold' : 'create');
    f.recoverable = bool(ext.recoverable) ?? false;
    f.suggestedAction =
      oneOf(ext.suggestedAction, BOOKING_ACTIONS) ||
      (code === 'HOLD_NOT_ALLOWED' ? 'retry_payment' : undefined);
  } else if (extendsClass(Class, PaymentError)) {
    f.reason = oneOf(ext.reason, PAYMENT_REASONS) || PAYMENT_CODE_REASON[code] || 'gateway';
  } else if (extendsClass(Class, ServicingError)) {
    f.action = oneOf(ext.action, TRIP_ACTIONS) || SERVICING_CODE_ACTION[code] || 'support';
    f.reason = str(ext.reason) || 'not_allowed';
  } else if (extendsClass(Class, UnprocessableError)) {
    f.fieldErrors = asFieldErrors(ext.fieldErrors) || fieldErrorsFromIssues(ctx.issues);
  }
  return f;
}

/**
 * @param {typeof ApiError} Class
 * @param {ProblemContext} ctx
 * @returns {ApiError}
 */
function construct(Class, ctx) {
  /** @type {Record<string, unknown>} */
  const options = {
    code: ctx.code,
    status: ctx.status,
    problem: ctx.problem,
    issues: ctx.issues,
    requestId: ctx.requestId,
    meta: ctx.meta,
    ...fieldsFor(Class, ctx),
  };
  if (Object.keys(ctx.ext).length) options.details = ctx.ext;
  const retryable = bool(ctx.ext.retryable);
  if (retryable !== undefined) options.retryable = retryable;
  return new Class(ctx.message, options);
}

/**
 * Build the right `ApiError` subclass from an RFC 9457 problem document. Precedence for the code:
 * `problem.code` (extension) → last path segment of `problem.type`
 * (`https://api.ota.com/problems/offer-expired` → `OFFER_EXPIRED`) → `status`. The class is looked up
 * by that code in `map` (overrides) then the default map, falling back to the status mapping
 * (401 → `AuthError`, 403 → `AuthError{forbidden}`, 404 → `NotFoundError`, 409 → `ConflictError`,
 * 422 → `UnprocessableError`, 429 → `RateLimitError`, 5xx → retryable `ApiError`). Amadeus‑style
 * `errors[]` are kept on `issues`; the document itself on `problem`. Effects: none.
 * @param {Problem|Record<string, unknown>} problem
 * @param {{ requestId?: string, map?: Record<string, typeof ApiError | ((ctx: ProblemContext) => ApiError)>, meta?: Record<string, unknown>, retryAfterMs?: number }} [options]
 * @returns {ApiError}
 */
export function errorFromProblem(problem, options = {}) {
  const o = options || {};
  const p = /** @type {Problem} */ (isObject(problem) ? problem : {});
  const status = toStatus(p.status);
  const explicitCode = normalizeCode(p.code) || codeFromType(p.type);
  const code = explicitCode || codeForStatus(status);
  const map = isObject(o.map) ? o.map : {};
  const entry = map[code] || DEFAULT_CODE_MAP[code] || classForStatus(status);

  const problemDoc = /** @type {Problem} */ ({
    ...p,
    type: str(p.type) || 'about:blank',
    title: str(p.title) || str(p.detail) || messageForStatus(status),
    status,
  });
  /** @type {ProblemContext} */
  const ctx = {
    problem: problemDoc,
    code,
    status,
    message: str(p.detail) || str(p.title) || messageForStatus(status),
    requestId: str(o.requestId) || str(p.requestId),
    issues: Array.isArray(p.errors) ? /** @type {ProblemIssue[]} */ (p.errors) : undefined,
    ext: problemExtensions(p),
    meta: isObject(o.meta) ? { ...o.meta } : {},
    retryAfterMs: num(o.retryAfterMs),
  };

  if (isSdkErrorClass(entry)) {
    // Only ApiError subclasses are valid targets; anything else falls back to the status mapping.
    if (extendsClass(entry, ApiError))
      return construct(/** @type {typeof ApiError} */ (entry), ctx);
  } else if (typeof entry === 'function') {
    try {
      const made = /** @type {(ctx: ProblemContext) => unknown} */ (entry)(ctx);
      if (made instanceof ApiError) return made;
    } catch {
      // A faulty custom factory must not break error handling; fall through to the status mapping.
    }
  }
  return construct(classForStatus(status), ctx);
}

/** Case‑insensitive header read over `Headers`, `Map` or a plain object. */
function headerGet(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const v = headers.get(name) ?? headers.get(lower);
    return v === null || v === undefined ? undefined : String(v);
  }
  if (isObject(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower && v !== undefined && v !== null) {
        return String(Array.isArray(v) ? v[0] : v);
      }
    }
  }
  return undefined;
}

/** `Retry-After` header (delta‑seconds or HTTP‑date) → milliseconds, or undefined. */
function parseRetryAfter(value, now) {
  const v = str(value)?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Body → parsed JSON object, raw text, or undefined (empty / unreadable). */
function parseBody(body) {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return undefined;
    if (text[0] === '{' || text[0] === '[') {
      try {
        return normalizeParsed(JSON.parse(text));
      } catch {
        return text;
      }
    }
    return text;
  }
  if (Array.isArray(body) || isObject(body)) return normalizeParsed(body);
  return undefined;
}

function normalizeParsed(v) {
  if (Array.isArray(v)) return { errors: v };
  return isObject(v) ? v : undefined;
}

/** Duck typing for mislabeled problem documents. */
function looksLikeProblem(obj) {
  return (
    isObject(obj) &&
    typeof obj.type === 'string' &&
    (typeof obj.title === 'string' || typeof obj.status === 'number')
  );
}

const LEGACY_MEMBERS = new Set([
  'code',
  'errorCode',
  'message',
  'error',
  'errors',
  'details',
  'requestId',
  'status',
  'statusCode',
]);

/**
 * Legacy `{ code, message }` (also nested `{ error: {…} }` and `{ errors: [{…}] }`) → problem.
 * @param {Record<string, unknown>} body @param {number} status @returns {Problem}
 */
function legacyToProblem(body, status) {
  const nested = isObject(body.error) ? body.error : undefined;
  const list = Array.isArray(body.errors) ? body.errors.filter(isObject) : [];
  const src = nested || (body.code === undefined && list.length ? list[0] : body);
  const code = str(src.code) || str(src.errorCode) || str(src.error);
  const message = str(src.message) || str(src.detail) || str(src.description) || str(src.title);
  /** @type {Problem} */
  const problem = {
    type: 'about:blank',
    title: message || messageForStatus(status),
    status,
  };
  if (code) problem.code = code;
  if (message) problem.detail = message;
  const rid = str(body.requestId) || str(src.requestId);
  if (rid) problem.requestId = rid;
  const issues = list.length ? list : Array.isArray(src.details) ? src.details : undefined;
  if (issues && issues.length) problem.errors = /** @type {ProblemIssue[]} */ (issues);
  for (const source of [body, src]) {
    for (const [k, v] of Object.entries(source)) {
      if (!LEGACY_MEMBERS.has(k) && !(k in problem)) problem[k] = v;
    }
  }
  return problem;
}

/**
 * Turn any failed HTTP response into an `ApiError`. Detects `application/problem+json` (by
 * `Content-Type` or by shape) and delegates to `errorFromProblem`; legacy `{ code, message }` bodies
 * keep their code / message and map by known code, then status; empty or non‑JSON bodies fall back to
 * the status mapping. `Retry-After` feeds `RateLimitError.retryAfterMs`; `X-Request-Id` feeds
 * `requestId`. Effects: none.
 * @param {number} status
 * @param {unknown} body            Parsed JSON, raw text, or empty.
 * @param {Headers|Record<string, string|string[]>|Map<string, string>|undefined|null} headers
 * @param {{ requestId?: string, map?: Record<string, typeof ApiError | ((ctx: ProblemContext) => ApiError)>, now?: number }} [options]
 * @returns {ApiError}
 */
export function errorFromResponse(status, body, headers, options = {}) {
  const o = options || {};
  const st = toStatus(status);
  const contentType = headerGet(headers, 'content-type');
  const now = num(o.now) ?? Date.now();
  const retryAfterMs = parseRetryAfter(headerGet(headers, 'retry-after'), now);
  const parsed = parseBody(body);

  /** @type {Record<string, unknown>} */
  const meta = {};
  if (contentType) meta.contentType = contentType;
  if (retryAfterMs !== undefined) meta.retryAfterMs = retryAfterMs;

  /** @type {Problem} */
  let problem;
  if (
    isObject(parsed) &&
    (/application\/problem\+json/i.test(contentType || '') || looksLikeProblem(parsed))
  ) {
    problem = /** @type {Problem} */ ({ ...parsed, status: toStatus(parsed.status) || st });
  } else if (isObject(parsed)) {
    problem = legacyToProblem(parsed, st);
  } else {
    if (typeof parsed === 'string') meta.bodyPreview = parsed.slice(0, 200);
    problem = { type: 'about:blank', title: messageForStatus(st), status: st };
  }

  const requestId =
    str(o.requestId) || headerGet(headers, 'x-request-id') || str(problem.requestId) || undefined;
  return errorFromProblem(problem, { requestId, map: o.map, meta, retryAfterMs });
}

// ── wrap ────────────────────────────────────────────────────────────────────────────────────────

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const NETWORK_MESSAGE = /fetch|network|load failed|connection|socket|ECONN|ENOTFOUND|EAI_AGAIN/i;
const STORAGE_NAMES = new Set([
  'QuotaExceededError',
  'SecurityError',
  'NS_ERROR_DOM_QUOTA_REACHED',
]);

/** Stripe‑style card errors → PaymentError reason. */
function cardReason(e) {
  const decline = str(e.decline_code) || '';
  const code = str(e.code) || '';
  if (decline === 'insufficient_funds') return 'insufficient_funds';
  if (decline === 'fraudulent' || decline === 'stolen_card' || decline === 'lost_card')
    return 'fraud';
  if (code === 'authentication_required' || decline === 'authentication_required') {
    return 'requires_action';
  }
  if (code === 'expired_card') return 'declined';
  if (code === 'payment_intent_authentication_failure') return 'authentication_failed';
  return 'declined';
}

/**
 * Normalise anything thrown into an `SdkError`: SDK errors pass through; `DOMException`
 * abort / timeout / quota, fetch `TypeError`s and Node socket errors, Stripe‑style card errors and
 * plain `Error`s / strings / objects get the closest class. `fallback` supplies `code` / `message`
 * when the input has none. Effects: none.
 * @param {unknown} e
 * @param {{ code?: string, message?: string }} [fallback]
 * @returns {SdkError}
 */
export function wrap(e, fallback = {}) {
  if (isSdkError(e)) return e;
  const fb = {
    code: str(fallback?.code) || 'UNKNOWN_ERROR',
    message: str(fallback?.message) || 'Unknown error',
  };
  if (e === null || e === undefined) return new SdkError(fb.message, { code: fb.code });
  if (typeof e === 'string') return new SdkError(e || fb.message, { code: fb.code });
  if (typeof e !== 'object' && typeof e !== 'function') {
    return new SdkError(fb.message, { code: fb.code, details: e });
  }

  const err = /** @type {Record<string, any>} */ (e);
  const name = str(err.name) || '';
  const message = str(err.message) || fb.message;
  const code = str(err.code);

  if (name === 'AbortError') {
    return new AbortError(message, { reason: str(err.reason), cause: e });
  }
  if (name === 'TimeoutError') {
    return new TimeoutError(message, { timeoutMs: num(err.timeoutMs), cause: e });
  }
  if (
    STORAGE_NAMES.has(name) ||
    (name === 'DOMException' && (err.code === 22 || err.code === 1014))
  ) {
    return new StorageError(message, { cause: e });
  }
  if (
    (e instanceof TypeError && NETWORK_MESSAGE.test(message)) ||
    name === 'FetchError' ||
    err.type === 'api_connection_error' ||
    (code && NETWORK_ERROR_CODES.has(code))
  ) {
    return new NetworkError(message, { cause: e, details: code ? { code } : undefined });
  }
  if (err.type === 'card_error' || typeof err.decline_code === 'string') {
    return new PaymentError(message, {
      reason: cardReason(err),
      cause: e,
      details: { gatewayCode: code, declineCode: str(err.decline_code) },
    });
  }
  return new SdkError(message, {
    code: normalizeCode(code) || fb.code,
    cause: e,
    details: e instanceof Error ? undefined : e,
  });
}

// ── user messages ───────────────────────────────────────────────────────────────────────────────

/** Default (English) copy. Keys double as i18n keys: `errors.<key>.title|message`. */
const COPY = Object.freeze({
  network: {
    title: 'Connection problem',
    message: "We couldn't reach the server. Check your connection and try again.",
    action: 'retry',
  },
  timeout: {
    title: 'Request timed out',
    message: 'The server took too long to respond. Please try again.',
    action: 'retry',
  },
  abort: { title: 'Request cancelled', message: 'The request was cancelled.' },
  validation: {
    title: 'Check your details',
    message: 'Some of the information provided is invalid. Please review and try again.',
  },
  config: {
    title: 'Configuration error',
    message: 'The application is not configured correctly. Please contact support.',
    action: 'contact_support',
  },
  storage: {
    title: 'Storage unavailable',
    message: "We couldn't save your data on this device. You can continue without it.",
  },
  unsupported: {
    title: 'Not supported',
    message: "This feature isn't available on this device or browser.",
  },
  'auth.unauthenticated': {
    title: 'Sign in required',
    message: 'Please sign in to continue.',
    action: 'login',
  },
  'auth.expired': {
    title: 'Session expired',
    message: 'Your session has expired. Please sign in again.',
    action: 'login',
  },
  'auth.forbidden': { title: 'Access denied', message: "You don't have permission to do that." },
  'auth.invalid_credentials': {
    title: 'Sign-in failed',
    message: 'The email or password you entered is incorrect.',
  },
  'auth.mfa_required': {
    title: 'Verification required',
    message: 'Enter the verification code to continue.',
  },
  'auth.otp_invalid': {
    title: 'Invalid code',
    message: 'The code you entered is incorrect. Please try again.',
    action: 'retry',
  },
  'auth.otp_expired': {
    title: 'Code expired',
    message: 'The code has expired. Please request a new one.',
    action: 'retry',
  },
  'auth.locked': {
    title: 'Account locked',
    message: 'Your account has been locked after too many attempts. Please contact support.',
    action: 'contact_support',
  },
  rate_limit: {
    title: 'Too many requests',
    message: 'Please wait a moment and try again.',
    action: 'retry',
  },
  'rate_limit.seconds': {
    title: 'Too many requests',
    message: 'Please wait {seconds} seconds and try again.',
    action: 'retry',
  },
  not_found: { title: 'Not found', message: "We couldn't find what you were looking for." },
  conflict: {
    title: 'Something changed',
    message:
      "This action couldn't be completed because the information has changed. Please refresh and try again.",
    action: 'retry',
  },
  search_expired: {
    title: 'Search expired',
    message: 'Fares change frequently, so your search results have expired. Please search again.',
    action: 'search_again',
  },
  offer_expired: {
    title: 'Fare expired',
    message: 'This fare is no longer available. Please search again for current fares.',
    action: 'search_again',
  },
  'offer_unavailable.sold_out': {
    title: 'Sold out',
    message: 'This flight has sold out. Please choose another option.',
    action: 'search_again',
  },
  'offer_unavailable.withdrawn': {
    title: 'Fare no longer available',
    message: 'This fare has been withdrawn by the airline. Please choose another option.',
    action: 'search_again',
  },
  'offer_unavailable.schedule_changed': {
    title: 'Schedule changed',
    message: 'The schedule for this flight has changed. Please search again for current options.',
    action: 'search_again',
  },
  price_changed: {
    title: 'Price changed',
    message:
      'The price of your itinerary has changed. Please review the new price before continuing.',
  },
  'price_changed.amounts': {
    title: 'Price changed',
    message:
      'The price of your itinerary has changed from {from} to {to}. Please review before continuing.',
  },
  itinerary_expired: {
    title: 'Itinerary expired',
    message: 'Your itinerary has expired. Please start again from search.',
    action: 'search_again',
  },
  'booking.retry_payment': {
    title: 'Booking not completed',
    message: "We couldn't complete your booking. Please try the payment again.",
    action: 'retry',
  },
  'booking.search_again': {
    title: 'Booking not completed',
    message: "We couldn't complete your booking. Please search again for available fares.",
    action: 'search_again',
  },
  'booking.wait': {
    title: 'Booking in progress',
    message: 'Your booking is still being processed. Please wait a moment and check again.',
    action: 'retry',
  },
  'booking.contact_support': {
    title: 'Booking failed',
    message: "We couldn't complete your booking. Please contact support for help.",
    action: 'contact_support',
  },
  'payment.declined': {
    title: 'Payment declined',
    message: 'Your payment was declined. Please try another payment method.',
    action: 'retry',
  },
  'payment.insufficient_funds': {
    title: 'Insufficient funds',
    message: 'There are not enough funds available. Please try another payment method.',
    action: 'retry',
  },
  'payment.authentication_failed': {
    title: 'Authentication failed',
    message: "We couldn't verify your payment. Please try again.",
    action: 'retry',
  },
  'payment.expired': {
    title: 'Payment expired',
    message: 'The payment session expired. Please try again.',
    action: 'retry',
  },
  'payment.cancelled': {
    title: 'Payment cancelled',
    message: 'The payment was cancelled. You can try again when ready.',
    action: 'retry',
  },
  'payment.gateway': {
    title: 'Payment unavailable',
    message: "We couldn't process your payment right now. Please try again or use another method.",
    action: 'retry',
  },
  'payment.fraud': {
    title: 'Payment not accepted',
    message: "This payment couldn't be accepted. Please contact support.",
    action: 'contact_support',
  },
  'payment.method_unavailable': {
    title: 'Payment method unavailable',
    message: "This payment method isn't available right now. Please choose another.",
    action: 'retry',
  },
  'payment.requires_action': {
    title: 'Verification required',
    message: 'Your bank requires additional verification to complete this payment.',
    action: 'retry',
  },
  servicing: {
    title: 'Not available online',
    message: "This change isn't available online for your booking. Please contact support.",
    action: 'contact_support',
  },
  unprocessable: {
    title: 'Check your details',
    message: "Some of the information provided couldn't be accepted. Please review and try again.",
  },
  'api.retryable': {
    title: 'Something went wrong',
    message: "We're having trouble right now. Please try again in a moment.",
    action: 'retry',
  },
  'api.failed': {
    title: 'Something went wrong',
    message:
      "We couldn't complete your request. Please try again or contact support if it persists.",
    action: 'contact_support',
  },
  unknown: {
    title: 'Something went wrong',
    message: 'An unexpected error occurred. Please try again.',
    action: 'retry',
  },
});

/** @param {Money|undefined} m */
function formatMoney(m) {
  return m ? `${m.currency} ${m.amount}`.trim() : '';
}

/**
 * Pick the copy key + interpolation vars for an error. Never reads `err.message` or `details`.
 * @param {SdkError} err
 * @returns {{ key: string, vars: Record<string, unknown> }}
 */
function describe(err) {
  if (err instanceof AuthError) return { key: `auth.${err.reason}`, vars: {} };
  if (err instanceof RateLimitError) {
    if (err.retryAfterMs !== undefined && err.retryAfterMs > 0) {
      return { key: 'rate_limit.seconds', vars: { seconds: Math.ceil(err.retryAfterMs / 1000) } };
    }
    return { key: 'rate_limit', vars: {} };
  }
  if (err instanceof NotFoundError) return { key: 'not_found', vars: {} };
  if (err instanceof ConflictError) return { key: 'conflict', vars: {} };
  if (err instanceof SearchExpiredError) return { key: 'search_expired', vars: {} };
  if (err instanceof OfferExpiredError) return { key: 'offer_expired', vars: {} };
  if (err instanceof OfferUnavailableError) {
    return { key: `offer_unavailable.${err.reason}`, vars: {} };
  }
  if (err instanceof PriceChangedError) {
    if (err.from && err.to) {
      return {
        key: 'price_changed.amounts',
        vars: { from: formatMoney(err.from), to: formatMoney(err.to) },
      };
    }
    return { key: 'price_changed', vars: {} };
  }
  if (err instanceof ItineraryExpiredError) return { key: 'itinerary_expired', vars: {} };
  if (err instanceof BookingError) return { key: `booking.${err.suggestedAction}`, vars: {} };
  if (err instanceof PaymentError) return { key: `payment.${err.reason}`, vars: {} };
  if (err instanceof ServicingError) return { key: 'servicing', vars: {} };
  if (err instanceof UnprocessableError) return { key: 'unprocessable', vars: {} };
  if (err instanceof ApiError)
    return { key: err.retryable ? 'api.retryable' : 'api.failed', vars: {} };
  if (err instanceof NetworkError) return { key: 'network', vars: {} };
  if (err instanceof TimeoutError) return { key: 'timeout', vars: {} };
  if (err instanceof AbortError) return { key: 'abort', vars: {} };
  if (err instanceof ValidationError) return { key: 'validation', vars: {} };
  if (err instanceof ConfigError) return { key: 'config', vars: {} };
  if (err instanceof StorageError) return { key: 'storage', vars: {} };
  if (err instanceof UnsupportedError) return { key: 'unsupported', vars: {} };
  return { key: 'unknown', vars: {} };
}

/** `{seconds}` style interpolation for the built‑in copy. */
function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * Localised, user‑safe `{ title, message, action? }` for any thrown value. Copy is chosen from the
 * error class / reason only; server text (`message`, `detail`, `details`) is never surfaced. When
 * `t` is given it is called as `t('errors.<key>.title'|'errors.<key>.message', vars, { default })`
 * and its result is used when it returns a non‑empty string other than the key itself.
 * Effects: none.
 * @param {unknown} e
 * @param {TranslateFn} [t]
 * @returns {UserMessage}
 */
export function toUserMessage(e, t) {
  const err = wrap(e);
  const { key, vars } = describe(err);
  const copy = COPY[key] || COPY.unknown;
  const translate = (field, fallbackText) => {
    if (typeof t !== 'function') return fallbackText;
    const i18nKey = `errors.${key}.${field}`;
    try {
      const out = t(i18nKey, vars, { default: fallbackText });
      return typeof out === 'string' && out.trim() && out !== i18nKey ? out : fallbackText;
    } catch {
      return fallbackText;
    }
  };
  /** @type {UserMessage} */
  const result = {
    title: translate('title', interpolate(copy.title, vars)),
    message: translate('message', interpolate(copy.message, vars)),
  };
  if (copy.action) result.action = copy.action;
  return result;
}

// ── canonical codes ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical codes the SDK understands (backend problem codes + SDK‑local codes), as an identity map
 * so callers can write `if (err.code === ERROR_CODES.OFFER_EXPIRED)`.
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_CODES = Object.freeze(
  Object.fromEntries(
    [
      // offers / search / itinerary
      'OFFER_EXPIRED',
      'OFFER_UNAVAILABLE',
      'SOLD_OUT',
      'OFFER_WITHDRAWN',
      'SCHEDULE_CHANGED',
      'PRICE_CHANGED',
      'SEARCH_EXPIRED',
      'ITINERARY_EXPIRED',
      'SEAT_TAKEN',
      'SERVICE_UNAVAILABLE',
      // travellers / promo / credits
      'NAME_MISMATCH',
      'DOCUMENT_INVALID',
      'DUPLICATE_TRAVELER',
      'PROMO_INVALID',
      'PROMO_NOT_ELIGIBLE',
      'PROMO_EXPIRED',
      'GIFT_CARD_INVALID',
      'INSUFFICIENT_BALANCE',
      'VOUCHER_NOT_APPLICABLE',
      // booking / payment / servicing
      'BOOKING_FAILED',
      'HOLD_NOT_ALLOWED',
      'PAYMENT_DECLINED',
      'PAYMENT_REQUIRES_ACTION',
      'PAYMENT_INSUFFICIENT_FUNDS',
      'PAYMENT_AUTHENTICATION_FAILED',
      'PAYMENT_EXPIRED',
      'PAYMENT_CANCELLED',
      'PAYMENT_GATEWAY_ERROR',
      'PAYMENT_FRAUD',
      'PAYMENT_METHOD_UNAVAILABLE',
      'PAYMENT_FAILED',
      'CHANGE_NOT_ALLOWED',
      'CANCEL_NOT_ALLOWED',
      'SERVICING_NOT_ALLOWED',
      // auth
      'SESSION_EXPIRED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'INVALID_CREDENTIALS',
      'MFA_REQUIRED',
      'OTP_INVALID',
      'OTP_EXPIRED',
      'ACCOUNT_LOCKED',
      // generic http
      'RATE_LIMITED',
      'NOT_FOUND',
      'CONFLICT',
      'VALIDATION_FAILED',
      'UNPROCESSABLE',
      'BAD_REQUEST',
      'PAYMENT_REQUIRED',
      'REQUEST_TIMEOUT',
      'TOO_EARLY',
      'INTERNAL_ERROR',
      'BAD_GATEWAY',
      'SERVER_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
      'API_ERROR',
      // sdk‑local
      'SDK_ERROR',
      'CONFIG_ERROR',
      'NETWORK_ERROR',
      'TIMEOUT',
      'ABORTED',
      'STORAGE_ERROR',
      'UNSUPPORTED',
      'UNKNOWN_ERROR',
    ].map((c) => [c, c])
  )
);
