/**
 * Identifier helpers for the Wayfarer SDK (docs/api/03-utils.md §7): RFC 4122 v4 `uuid()`, a short
 * base36 `shortId()`, a time‑prefixed `requestId()` for request correlation, a deterministic
 * `idempotencyKey(scope, payload)` and the `isUuid()` predicate. Randomness comes from
 * `globalThis.crypto` when present (`randomUUID`, then `getRandomValues`) and falls back to
 * `Math.random` otherwise; `crypto` is looked up at call time, never at import time, so the module is
 * SSR‑safe. Nothing here touches the DOM, storage, timers or the network, keeps module‑level state or
 * logs. Plain `Error`s are never thrown — only `ValidationError` — and nothing from the Web Crypto
 * API (quota `DOMException`s included) is allowed to escape.
 */

import { ValidationError } from '../errors/index.js';
import { hash, stableStringify } from './object.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 36 that fits a byte; bytes at or above it are rejected to avoid modulo bias. */
const ALPHABET_LIMIT = 252;
/** `crypto.getRandomValues` rejects requests above this many bytes (`QuotaExceededError`). */
const RANDOM_CHUNK = 65536;
/** ASCII control characters, which can never travel in an HTTP header value. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** The Web Crypto object when the runtime exposes one. @returns {Crypto|undefined} */
function webCrypto() {
  const c = globalThis.crypto;
  return c !== null && typeof c === 'object' ? c : undefined;
}

/**
 * `n` random bytes from `crypto.getRandomValues` (filled in ≤ 64 KiB slices, the per‑call quota),
 * or from `Math.random` when unavailable.
 * @param {number} n
 * @returns {Uint8Array}
 */
function randomBytes(n) {
  const bytes = new Uint8Array(n);
  const c = webCrypto();
  if (c && typeof c.getRandomValues === 'function') {
    for (let offset = 0; offset < n; offset += RANDOM_CHUNK) {
      c.getRandomValues(bytes.subarray(offset, Math.min(n, offset + RANDOM_CHUNK)));
    }
    return bytes;
  }
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/**
 * Random RFC 4122 version 4 UUID, lower‑case. Uses `crypto.randomUUID()` when available, otherwise
 * builds one from `crypto.getRandomValues` (or `Math.random` as a last resort).
 * @returns {string}
 */
export function uuid() {
  const c = webCrypto();
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  let hex = '';
  for (let i = 0; i < 16; i++) hex += b[i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Random lower‑case alphanumeric (base36) string of `n` characters, uniformly distributed (biasing
 * bytes are rejected and redrawn). Any positive length works, including ones above the 64 KiB
 * `getRandomValues` quota.
 * @param {number} [n=8]
 * @returns {string}
 * @throws {ValidationError} when `n` is not a positive integer
 */
export function shortId(n = 8) {
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError('shortId() length must be a positive integer', {
      issues: [
        {
          path: 'n',
          code: 'min',
          message: 'length must be a positive integer',
          params: { min: 1 },
        },
      ],
    });
  }
  let out = '';
  while (out.length < n) {
    const bytes = randomBytes(n - out.length + 4);
    for (let i = 0; i < bytes.length && out.length < n; i++) {
      if (bytes[i] < ALPHABET_LIMIT) out += ALPHABET[bytes[i] % 36];
    }
  }
  return out;
}

/**
 * Correlation id for one HTTP request: `req_<time base36>_<8 random chars>` — unique, header‑safe
 * (`[a-z0-9_]` only) and roughly sortable by creation time. Reads `Date.now()`.
 * @returns {string}
 */
export function requestId() {
  return `req_${Date.now().toString(36)}_${shortId(8)}`;
}

/**
 * Deterministic idempotency key: `scope + '-' + hash(stableStringify(payload))`. The same scope and
 * structurally equal payload (whatever the key order) always give the same key, so a retried create
 * call is recognised by the backend. A missing payload hashes like `null`. The key is header‑safe
 * whenever `scope` is: control characters in `scope` are rejected, other characters pass through.
 * @param {string} scope  e.g. `'booking'`, `'payment:intent'`
 * @param {unknown} [payload]  Anything `stableStringify` accepts (plain data, Dates, …)
 * @returns {string}
 * @throws {ValidationError} when `scope` is not a non‑empty string without control characters, or
 *   `payload` contains a cycle
 */
export function idempotencyKey(scope, payload) {
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new ValidationError('idempotencyKey() requires a non-empty scope', {
      issues: [{ path: 'scope', code: 'required', message: 'scope must be a non-empty string' }],
    });
  }
  if (CONTROL_CHARS_RE.test(scope)) {
    throw new ValidationError('idempotencyKey() scope must not contain control characters', {
      issues: [{ path: 'scope', code: 'pattern', message: 'scope contains a control character' }],
    });
  }
  return `${scope}-${hash(stableStringify(payload))}`;
}

/**
 * True when `s` is a canonical RFC 4122 UUID string (8‑4‑4‑4‑12 hex, version 1–8, variant 10xx),
 * in either case. The nil and max UUIDs are not canonical versioned UUIDs and are rejected.
 * @param {unknown} s
 * @returns {s is string}
 */
export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}
