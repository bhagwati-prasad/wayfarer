/**
 * Identifier helpers for the Wayfarer SDK (docs/api/03-utils.md §7): RFC 4122 v4 `uuid()`, a short
 * base36 `shortId()`, a time‑prefixed `requestId()` for request correlation, a deterministic
 * `idempotencyKey(scope, payload)` and the `isUuid()` predicate. Randomness comes from
 * `globalThis.crypto` when present (`randomUUID`, then `getRandomValues`) and falls back to
 * `Math.random` otherwise; `crypto` is looked up at call time, never at import time, so the module is
 * SSR‑safe. Nothing here touches the DOM, storage, timers or the network, keeps module‑level state or
 * logs. Plain `Error`s are never thrown — only `ValidationError`.
 */

import { ValidationError } from '../errors/index.js';
import { hash, stableStringify } from './object.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 36 that fits a byte; bytes at or above it are rejected to avoid modulo bias. */
const ALPHABET_LIMIT = 252;

/** The Web Crypto object when the runtime exposes one. @returns {Crypto|undefined} */
function webCrypto() {
  const c = globalThis.crypto;
  return c !== null && typeof c === 'object' ? c : undefined;
}

/**
 * `n` random bytes from `crypto.getRandomValues`, or from `Math.random` when unavailable.
 * @param {number} n
 * @returns {Uint8Array}
 */
function randomBytes(n) {
  const bytes = new Uint8Array(n);
  const c = webCrypto();
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
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
 * Random lower‑case alphanumeric (base36) string of `n` characters, uniformly distributed.
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
 * and roughly sortable by creation time.
 * @returns {string}
 */
export function requestId() {
  return `req_${Date.now().toString(36)}_${shortId(8)}`;
}

/**
 * Deterministic idempotency key: `scope + '-' + hash(stableStringify(payload))`. The same scope and
 * structurally equal payload (whatever the key order) always give the same key, so a retried create
 * call is recognised by the backend.
 * @param {string} scope  e.g. `'booking'`, `'payment:intent'`
 * @param {object} [payload]
 * @returns {string}
 * @throws {ValidationError} when `scope` is not a non‑empty string
 */
export function idempotencyKey(scope, payload) {
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new ValidationError('idempotencyKey() requires a non-empty scope', {
      issues: [{ path: 'scope', code: 'required', message: 'scope must be a non-empty string' }],
    });
  }
  return `${scope}-${hash(stableStringify(payload))}`;
}

/**
 * True when `s` is a canonical RFC 4122 UUID string (8‑4‑4‑4‑12 hex, version 1–8, variant 10xx),
 * in either case.
 * @param {unknown} s
 * @returns {s is string}
 */
export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}
