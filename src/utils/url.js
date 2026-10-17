/**
 * URL helpers for the Wayfarer SDK (docs/api/03-utils.md §8): query‑string build / parse
 * (`buildQuery`, `parseQuery`), URL composition (`joinUrl`, `withParams`, `isAbsoluteUrl`,
 * `sameOrigin`), the compact human‑readable search deep‑link format (`encodeSearchParams`,
 * `decodeSearchParams`, used by `search.toUrl` / `search.fromUrl`), base64url JSON for redirect
 * round‑trips (`encodeState`, `decodeState`) and `currentUrlParams`, the only browser‑dependent
 * function here. Everything is pure and SSR‑safe: `window` is read by `currentUrlParams` /
 * `sameOrigin` at call time only, never at import time; no I/O, no timers, no module‑level mutable
 * state, no logging. Decoders never throw on malformed input — they return `null` (or keep the raw
 * value for an undecodable percent‑escape); `encodeSearchParams` / `encodeState` throw only
 * `ValidationError` with `issues[]`. Query parsing never writes prototype‑pollution keys.
 *
 * Deep‑link format: `ORIG-DEST/YYYY-MM-DD` (one‑way), `ORIG-DEST/out/back` (round trip) or legs
 * joined with `+` (multi‑city), followed by a query of `a c i is y s` (passenger counts),
 * `cabin` (`Y|W|C|F`), `ft` (fare types csv), `direct=1`, `stops`, `near=1`, `mode` (`ps|c` for
 * `per_slice|combined`; absent = the default `per_slice` / split, docs/QUESTIONS.md decision 5),
 * `cur` and `ages` (child ages csv).
 */

import { ValidationError } from '../errors/index.js';

/** @typedef {import('../types.js').SearchParams} SearchParams */
/** @typedef {import('../types.js').SliceRequest} SliceRequest */
/** @typedef {import('../types.js').PaxCounts} PaxCounts */
/** @typedef {import('../types.js').CabinClass} CabinClass */
/** @typedef {import('../types.js').TripType} TripType */
/** @typedef {import('../types.js').FareType} FareType */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/**
 * @typedef {Object} BuildQueryOptions
 * @property {'repeat'|'comma'|'bracket'} [arrayFormat] how arrays are serialised: `k=a&k=b`
 *   (default), `k=a,b` or `k[]=a&k[]=b`
 * @property {boolean} [skipNull] drop `null` values (default `true`); when `false` a `null` becomes
 *   `k=`. `undefined` is always dropped.
 */

/** Keys that must never be written to a parsed object (prototype‑pollution vectors). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const CABIN_TO_CODE = Object.freeze({
  economy: 'Y',
  premium_economy: 'W',
  business: 'C',
  first: 'F',
});
const CODE_TO_CABIN = Object.freeze({
  Y: 'economy',
  W: 'premium_economy',
  C: 'business',
  F: 'first',
});
const MODE_TO_CODE = Object.freeze({ per_slice: 'ps', combined: 'c' });
const CODE_TO_MODE = Object.freeze({ ps: 'per_slice', c: 'combined' });
const TRIP_TYPES = new Set(['one_way', 'round_trip', 'multi_city']);
const FARE_TYPES = new Set([
  'regular',
  'student',
  'senior',
  'armed_forces',
  'doctor',
  'corporate',
  'youth',
]);

const IATA_RE = /^[A-Za-z]{3}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INT_RE = /^\d+$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/** `encodeURIComponent` that also encodes `!'()*` so output is RFC 3986 strict. */
function enc(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Decode one query component (`+` → space); keeps the raw text when the escape is malformed. */
function decodeComponent(s) {
  const plain = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plain);
  } catch {
    return plain;
  }
}

/** Serialise one scalar for a query value. */
function scalar(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Key of a raw `k=v` query part, decoded and without a trailing `[]`. */
function rawKey(part) {
  const eq = part.indexOf('=');
  const key = decodeComponent(eq === -1 ? part : part.slice(0, eq));
  return key.endsWith('[]') ? key.slice(0, -2) : key;
}

/** Split `url` into `[beforeQuery, query, hash]` (query without `?`, hash with `#`). */
function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const noHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const qAt = noHash.indexOf('?');
  return qAt === -1 ? [noHash, '', hash] : [noHash.slice(0, qAt), noHash.slice(qAt + 1), hash];
}

/** `true` when `s` is a `YYYY-MM-DD` string naming a real calendar date. */
function isValidDateStr(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** `true` for a non‑negative safe integer. */
function isCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Infer the trip type from a list of normalised slices. */
function inferTripType(slices) {
  if (slices.length === 1) return 'one_way';
  if (slices.length === 2 && isMirrored(slices[0], slices[1])) return 'round_trip';
  return 'multi_city';
}

/** `true` when `back` is the exact reverse routing of `out`. */
function isMirrored(out, back) {
  return out.origin === back.destination && out.destination === back.origin;
}

/** Parse a csv query value into trimmed, non‑empty items; `null` when any item is empty. */
function csv(value) {
  const items = value.split(',').map((s) => s.trim());
  return items.length && items.every(Boolean) ? items : null;
}

/** Parse a non‑negative integer query value; `null` when malformed. */
function parseCount(value) {
  return INT_RE.test(value) ? Number(value) : null;
}

/** Parse a `1`/`0` flag query value; `undefined` when absent, `null` when malformed. */
function parseFlag(value) {
  if (value === undefined) return undefined;
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

/** Origin of a URL for `sameOrigin`: a string, `RELATIVE`, or `null` when unparsable. */
const RELATIVE = Symbol('relative');
function originOf(u) {
  const s = String(u ?? '').trim();
  const href =
    typeof window !== 'undefined' && window && window.location && window.location.href
      ? String(window.location.href)
      : undefined;
  try {
    if (isAbsoluteUrl(s)) return new URL(s, href).origin;
    if (href) return new URL(s, href).origin;
    return RELATIVE;
  } catch {
    return null;
  }
}

// ── base64url plumbing ──────────────────────────────────────────────────────────────────────────

/** UTF‑8 encode a string (TextEncoder when available, percent‑escape fallback otherwise). */
function utf8Encode(str) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
  const escaped = encodeURIComponent(str);
  const out = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '%') {
      out.push(parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(escaped.charCodeAt(i));
    }
  }
  return Uint8Array.from(out);
}

/** UTF‑8 decode bytes; throws (caught by the caller) when the byte sequence is malformed. */
function utf8Decode(bytes) {
  if (typeof TextDecoder === 'function') {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  let escaped = '';
  for (const b of bytes) escaped += `%${b.toString(16).padStart(2, '0')}`;
  return decodeURIComponent(escaped);
}

/** Bytes → unpadded base64url. */
function bytesToBase64Url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64_ALPHABET[(n >> 18) & 63] +
      BASE64_ALPHABET[(n >> 12) & 63] +
      BASE64_ALPHABET[(n >> 6) & 63] +
      BASE64_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      BASE64_ALPHABET[(n >> 18) & 63] +
      BASE64_ALPHABET[(n >> 12) & 63] +
      BASE64_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** base64url (or standard base64, padded or not) → bytes; `null` when malformed. */
function base64UrlToBytes(str) {
  const s = str.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!BASE64URL_RE.test(s) || s.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((s.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of s) {
    buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes.subarray(0, written);
}

// ── query strings ───────────────────────────────────────────────────────────────────────────────

/**
 * Serialise an object into a query string (no leading `?`). Values are percent‑encoded; `Date`s
 * become ISO strings, plain objects JSON; `undefined` is dropped, `null` is dropped unless
 * `skipNull: false`; empty arrays emit nothing. Effects: none.
 * @param {Record<string, unknown>|null|undefined} obj
 * @param {BuildQueryOptions} [options]
 * @returns {string}
 */
export function buildQuery(obj, options = {}) {
  if (!obj || typeof obj !== 'object') return '';
  const arrayFormat = options.arrayFormat || 'repeat';
  const skipNull = options.skipNull !== false;
  const parts = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (raw === undefined) continue;
    if (raw === null) {
      if (!skipNull) parts.push(`${enc(key)}=`);
      continue;
    }
    if (Array.isArray(raw)) {
      const values = raw.filter((v) => v !== undefined && (v !== null || !skipNull)).map(scalar);
      if (!values.length) continue;
      if (arrayFormat === 'comma') parts.push(`${enc(key)}=${values.map(enc).join(',')}`);
      else if (arrayFormat === 'bracket')
        values.forEach((v) => parts.push(`${enc(key)}[]=${enc(v)}`));
      else values.forEach((v) => parts.push(`${enc(key)}=${enc(v)}`));
      continue;
    }
    parts.push(`${enc(key)}=${enc(scalar(raw))}`);
  }
  return parts.join('&');
}

/**
 * Parse a query string into an object of strings. Accepts a bare query, one with a leading `?`,
 * or a URL / path (the part between `?` and `#` is used; the fragment is always dropped). `+` is a
 * space; repeated keys and `k[]` keys become arrays; a key without `=` gets `''`; a malformed
 * percent‑escape keeps its raw text; `__proto__`‑like keys are skipped. Effects: none.
 * @param {string|null|undefined} str
 * @returns {Record<string, string|string[]>}
 */
export function parseQuery(str) {
  /** @type {Record<string, string|string[]>} */
  const out = {};
  if (typeof str !== 'string') return out;
  let s = str.trim();
  const hashAt = s.indexOf('#');
  if (hashAt !== -1) s = s.slice(0, hashAt);
  if (s.startsWith('?')) s = s.slice(1);
  else if (/^[^=&]*\?/.test(s)) s = s.slice(s.indexOf('?') + 1);
  else if (isAbsoluteUrl(s) || s.startsWith('/')) return out; // a URL / path with no query
  if (!s) return out;
  for (const part of s.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    let key = decodeComponent(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : decodeComponent(part.slice(eq + 1));
    let isList = false;
    if (key.endsWith('[]')) {
      key = key.slice(0, -2);
      isList = true;
    }
    if (!key || UNSAFE_KEYS.has(key)) continue;
    if (hasOwn(out, key)) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    } else {
      out[key] = isList ? [value] : value;
    }
  }
  return out;
}

// ── URL composition ─────────────────────────────────────────────────────────────────────────────

/**
 * Join a base URL and a path with exactly one `/` between them. An absolute `path` is returned
 * as is; a `path` starting with `?` or `#` is appended without a slash; an empty `path` returns
 * `base` unchanged. Effects: none.
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
export function joinUrl(base, path) {
  const b = String(base ?? '');
  const p = String(path ?? '');
  if (!p) return b;
  if (isAbsoluteUrl(p)) return p;
  if (!b) return p;
  if (p.startsWith('?') || p.startsWith('#')) return b.replace(/\/+$/, '') + p;
  return `${b.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
}

/**
 * Return `url` with `params` merged into its query string: keys already present are replaced,
 * a `null` / `undefined` value removes the key, other keys and the fragment are preserved.
 * Effects: none.
 * @param {string} url
 * @param {Record<string, unknown>|null|undefined} params
 * @returns {string}
 */
export function withParams(url, params) {
  const base = String(url ?? '');
  if (!params || typeof params !== 'object') return base;
  const [path, existing, hash] = splitUrl(base);
  const overridden = new Set(Object.keys(params));
  const kept = existing
    .split('&')
    .filter(Boolean)
    .filter((part) => !overridden.has(rawKey(part)));
  const query = [...kept, buildQuery(params)].filter(Boolean).join('&');
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

/**
 * `true` when `s` carries a scheme (`https:`, `mailto:` …) or is protocol‑relative (`//host/…`).
 * Effects: none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isAbsoluteUrl(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return SCHEME_RE.test(t) || t.startsWith('//');
}

/**
 * `true` when both URLs share scheme, host and port. Relative URLs are resolved against
 * `window.location` when a browser is present at call time; without one, two relative URLs are
 * considered same‑origin and a relative/absolute pair is not. Unparsable input and opaque
 * (`null`) origins are never same‑origin. Effects: none.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameOrigin(a, b) {
  const oa = originOf(a);
  const ob = originOf(b);
  if (oa === null || ob === null) return false;
  if (oa === RELATIVE || ob === RELATIVE) return oa === ob;
  return oa === ob && oa !== 'null';
}

// ── search deep links ───────────────────────────────────────────────────────────────────────────

/**
 * Normalise and validate one slice for encoding, collecting issues.
 * @param {unknown} slice
 * @param {number} index
 * @param {ValidationIssue[]} issues
 * @returns {{ origin: string, destination: string, date: string }}
 */
function normaliseSlice(slice, index, issues) {
  const path = `slices[${index}]`;
  const s =
    slice && typeof slice === 'object' ? /** @type {Record<string, unknown>} */ (slice) : {};
  const out = { origin: '', destination: '', date: '' };
  for (const field of /** @type {const} */ (['origin', 'destination'])) {
    const v = s[field];
    if (typeof v === 'string' && IATA_RE.test(v.trim())) out[field] = v.trim().toUpperCase();
    else
      issues.push({
        path: `${path}.${field}`,
        code: 'invalid',
        message: `${field} must be a 3-letter IATA code`,
      });
  }
  if (isValidDateStr(s.date)) out.date = /** @type {string} */ (s.date);
  else issues.push({ path: `${path}.date`, code: 'invalid', message: 'date must be YYYY-MM-DD' });
  return out;
}

/**
 * Read an optional passenger count for encoding; `0` / missing → `undefined`.
 * @param {Record<string, unknown>} pax
 * @param {string} field
 * @param {ValidationIssue[]} issues
 * @returns {number|undefined}
 */
function countOf(pax, field, issues) {
  const v = pax[field];
  if (v === undefined || v === null) return undefined;
  if (!isCount(v)) {
    issues.push({
      path: `passengers.${field}`,
      code: 'invalid',
      message: `${field} must be a non-negative integer`,
    });
    return undefined;
  }
  return v;
}

/**
 * Encode `SearchParams` as a compact, human‑readable deep link, e.g.
 * `DEL-BOM/2026-11-02/2026-11-09?a=2&c=1&cabin=Y`. One‑way → `ORIG-DEST/date`; round trip →
 * `ORIG-DEST/out/back` (the second slice must mirror the first); multi‑city → legs joined with
 * `+`. `tripType` is inferred from the slices when omitted and must agree with them when given.
 * Query keys: `a c i is y s` (counts; `a` and `cabin` always present, zero optional counts
 * dropped), `cabin` (`Y|W|C|F`), `ft`, `direct=1`, `stops`, `near=1`, `mode` (`ps|c`), `cur`,
 * `ages`. False flags and fields outside this list (`flexDays`, `timeWindow`, `airlines`, …) are
 * not part of the format. `decodeSearchParams` round‑trips the result. Effects: none.
 * @param {SearchParams} p
 * @returns {string}
 * @throws {ValidationError} with `issues[]` naming every invalid field
 */
export function encodeSearchParams(p) {
  if (!p || typeof p !== 'object') {
    throw new ValidationError('Search params must be an object', {
      issues: [{ path: '', code: 'required', message: 'search params must be an object' }],
    });
  }
  /** @type {ValidationIssue[]} */
  const issues = [];
  const rawSlices = Array.isArray(p.slices) ? p.slices : [];
  if (!rawSlices.length) {
    issues.push({ path: 'slices', code: 'required', message: 'at least one slice is required' });
  }
  const slices = rawSlices.map((s, i) => normaliseSlice(s, i, issues));

  let tripType = p.tripType;
  if (tripType === undefined || tripType === null) {
    tripType = slices.length ? inferTripType(slices) : 'one_way';
  } else if (!TRIP_TYPES.has(tripType)) {
    issues.push({ path: 'tripType', code: 'invalid', message: 'unknown tripType' });
  } else if (tripType === 'one_way' && slices.length !== 1) {
    issues.push({ path: 'slices', code: 'invalid', message: 'one_way needs exactly one slice' });
  } else if (tripType === 'round_trip' && slices.length !== 2) {
    issues.push({
      path: 'slices',
      code: 'invalid',
      message: 'round_trip needs exactly two slices',
    });
  } else if (tripType === 'round_trip' && !isMirrored(slices[0], slices[1])) {
    issues.push({
      path: 'slices[1]',
      code: 'invalid',
      message: 'round_trip return slice must reverse the outbound routing',
    });
  } else if (tripType === 'multi_city' && slices.length < 2) {
    issues.push({
      path: 'slices',
      code: 'invalid',
      message: 'multi_city needs two or more slices',
    });
  }

  const pax =
    p.passengers && typeof p.passengers === 'object'
      ? /** @type {Record<string, unknown>} */ (p.passengers)
      : {};
  const adults = countOf(pax, 'adults', issues);
  const children = countOf(pax, 'children', issues);
  const infants = countOf(pax, 'infants', issues);
  const infantsSeated = countOf(pax, 'infantsSeated', issues);
  const youth = countOf(pax, 'youth', issues);
  const seniors = countOf(pax, 'seniors', issues);
  let childAges;
  if (pax.childAges !== undefined && pax.childAges !== null) {
    if (Array.isArray(pax.childAges) && pax.childAges.every(isCount)) childAges = pax.childAges;
    else
      issues.push({
        path: 'passengers.childAges',
        code: 'invalid',
        message: 'childAges must be a list of non-negative integers',
      });
  }

  const cabin = p.cabin === undefined || p.cabin === null ? 'economy' : p.cabin;
  if (!hasOwn(CABIN_TO_CODE, cabin)) {
    issues.push({ path: 'cabin', code: 'invalid', message: 'unknown cabin class' });
  }
  let fareTypes;
  if (p.fareTypes !== undefined && p.fareTypes !== null) {
    if (Array.isArray(p.fareTypes) && p.fareTypes.every((f) => FARE_TYPES.has(f))) {
      fareTypes = p.fareTypes;
    } else {
      issues.push({ path: 'fareTypes', code: 'invalid', message: 'unknown fare type' });
    }
  }
  if (p.maxStops !== undefined && p.maxStops !== null && ![0, 1, 2].includes(p.maxStops)) {
    issues.push({ path: 'maxStops', code: 'invalid', message: 'maxStops must be 0, 1 or 2' });
  }
  if (p.resultMode !== undefined && p.resultMode !== null && !hasOwn(MODE_TO_CODE, p.resultMode)) {
    issues.push({ path: 'resultMode', code: 'invalid', message: 'unknown resultMode' });
  }
  let currency;
  if (p.currency !== undefined && p.currency !== null) {
    if (typeof p.currency === 'string' && CURRENCY_RE.test(p.currency.trim())) {
      currency = p.currency.trim().toUpperCase();
    } else {
      issues.push({ path: 'currency', code: 'invalid', message: 'currency must be ISO-4217' });
    }
  }

  if (issues.length) throw new ValidationError('Invalid search params', { issues });

  const path =
    tripType === 'round_trip'
      ? `${slices[0].origin}-${slices[0].destination}/${slices[0].date}/${slices[1].date}`
      : slices.map((s) => `${s.origin}-${s.destination}/${s.date}`).join('+');

  /** @type {Record<string, unknown>} */
  const query = { a: adults === undefined ? 1 : adults };
  if (children) query.c = children;
  if (infants) query.i = infants;
  if (infantsSeated) query.is = infantsSeated;
  if (youth) query.y = youth;
  if (seniors) query.s = seniors;
  query.cabin = CABIN_TO_CODE[cabin];
  if (fareTypes && fareTypes.length) query.ft = fareTypes;
  if (p.directOnly) query.direct = 1;
  if (typeof p.maxStops === 'number') query.stops = p.maxStops;
  if (p.includeNearby) query.near = 1;
  if (p.resultMode) query.mode = MODE_TO_CODE[p.resultMode];
  if (currency) query.cur = currency;
  if (childAges && childAges.length) query.ages = childAges;

  // csv lists keep a literal comma so the link stays human‑readable.
  return `${path}?${buildQuery(query, { arrayFormat: 'comma' })}`;
}

/**
 * Decode a deep link produced by `encodeSearchParams` back into `SearchParams`. Tolerates a
 * leading / trailing `/`, lowercase codes, a fragment and unknown query keys (ignored). Defaults
 * when absent: `a=1`, `c=0`, `i=0`, `cabin=Y`; an absent `mode` leaves `resultMode` unset, which
 * the search module resolves to the default `per_slice` (split). Any malformed part — bad code or
 * date, wrong segment count, unknown enum value, non‑integer count, duplicated key — yields
 * `null`; nothing is thrown. Effects: none.
 * @param {string} str
 * @returns {SearchParams|null}
 */
export function decodeSearchParams(str) {
  if (typeof str !== 'string') return null;
  const [rawPath, rawQuery] = splitUrl(str.trim());
  let path;
  try {
    path = decodeURIComponent(rawPath).replace(/^\/+|\/+$/g, '');
  } catch {
    return null;
  }
  if (!path) return null;

  const legs = path.split('+');
  /** @type {SliceRequest[]} */
  const slices = [];
  /** @type {TripType} */
  let tripType;
  const readLeg = (leg) => {
    const m = /^([A-Za-z]{3})-([A-Za-z]{3})$/.exec(leg);
    return m ? { origin: m[1].toUpperCase(), destination: m[2].toUpperCase() } : null;
  };
  if (legs.length === 1) {
    const segs = legs[0].split('/');
    const route = readLeg(segs[0]);
    if (!route || segs.length < 2 || segs.length > 3 || !segs.slice(1).every(isValidDateStr)) {
      return null;
    }
    slices.push({ ...route, date: segs[1] });
    if (segs.length === 3) {
      tripType = 'round_trip';
      slices.push({ origin: route.destination, destination: route.origin, date: segs[2] });
    } else {
      tripType = 'one_way';
    }
  } else {
    tripType = 'multi_city';
    for (const leg of legs) {
      const segs = leg.split('/');
      const route = readLeg(segs[0]);
      if (!route || segs.length !== 2 || !isValidDateStr(segs[1])) return null;
      slices.push({ ...route, date: segs[1] });
    }
  }

  const q = parseQuery(rawQuery);
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) return null;
    query[k] = v;
  }
  const count = (key, fallback) => (query[key] === undefined ? fallback : parseCount(query[key]));

  const adults = count('a', 1);
  const children = count('c', 0);
  const infants = count('i', 0);
  const infantsSeated = count('is', undefined);
  const youth = count('y', undefined);
  const seniors = count('s', undefined);
  if ([adults, children, infants, infantsSeated, youth, seniors].includes(null)) return null;
  /** @type {PaxCounts} */
  const passengers = { adults, children, infants };
  if (infantsSeated !== undefined) passengers.infantsSeated = infantsSeated;
  if (youth !== undefined) passengers.youth = youth;
  if (seniors !== undefined) passengers.seniors = seniors;
  if (query.ages !== undefined) {
    const ages = csv(query.ages);
    if (!ages || !ages.every((a) => INT_RE.test(a))) return null;
    passengers.childAges = ages.map(Number);
  }

  const cabinCode = query.cabin === undefined ? 'Y' : query.cabin.toUpperCase();
  if (!hasOwn(CODE_TO_CABIN, cabinCode)) return null;

  /** @type {SearchParams} */
  const out = { tripType, slices, passengers, cabin: CODE_TO_CABIN[cabinCode] };

  if (query.ft !== undefined) {
    const fareTypes = csv(query.ft);
    if (!fareTypes || !fareTypes.every((f) => FARE_TYPES.has(f))) return null;
    out.fareTypes = /** @type {FareType[]} */ (fareTypes);
  }
  const direct = parseFlag(query.direct);
  if (direct === null) return null;
  if (direct !== undefined) out.directOnly = direct;
  if (query.stops !== undefined) {
    if (!['0', '1', '2'].includes(query.stops)) return null;
    out.maxStops = /** @type {0|1|2} */ (Number(query.stops));
  }
  const near = parseFlag(query.near);
  if (near === null) return null;
  if (near !== undefined) out.includeNearby = near;
  if (query.mode !== undefined) {
    if (!hasOwn(CODE_TO_MODE, query.mode)) return null;
    out.resultMode = CODE_TO_MODE[query.mode];
  }
  if (query.cur !== undefined) {
    if (!CURRENCY_RE.test(query.cur)) return null;
    out.currency = query.cur.toUpperCase();
  }
  return out;
}

// ── redirect state ──────────────────────────────────────────────────────────────────────────────

/**
 * Serialise a JSON‑serialisable value as unpadded base64url (URL‑ and cookie‑safe), UTF‑8 encoded
 * so any unicode survives. Effects: none.
 * @param {unknown} obj
 * @returns {string}
 * @throws {ValidationError} when the value is not JSON‑serialisable (cycles, `undefined`, BigInt)
 */
export function encodeState(obj) {
  let json;
  try {
    json = JSON.stringify(obj);
  } catch (cause) {
    throw new ValidationError('State is not JSON-serialisable', {
      cause,
      issues: [{ path: '', code: 'invalid', message: 'state is not JSON-serialisable' }],
    });
  }
  if (typeof json !== 'string') {
    throw new ValidationError('State is not JSON-serialisable', {
      issues: [{ path: '', code: 'invalid', message: 'state is not JSON-serialisable' }],
    });
  }
  return bytesToBase64Url(utf8Encode(json));
}

/**
 * Inverse of `encodeState`; also accepts standard base64 (padded or `+/`). Returns `null` for
 * anything that is not valid base64 of valid UTF‑8 JSON, instead of throwing. Effects: none.
 * @param {string} str
 * @returns {Record<string, unknown>|unknown[]|null}
 */
export function decodeState(str) {
  if (typeof str !== 'string') return null;
  const bytes = base64UrlToBytes(str);
  if (!bytes || !bytes.length) return null;
  try {
    const value = JSON.parse(utf8Decode(bytes));
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// ── browser ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Query parameters of the current page, read from `window.location` at call time (never at
 * import). Parameters carried in the fragment (`#code=…`, `#/callback?code=…`, as OAuth and some
 * payment redirects do) are merged in, with query‑string values winning on conflict. Returns `{}`
 * outside a browser. Effects: none.
 * @returns {Record<string, string|string[]>}
 */
export function currentUrlParams() {
  if (typeof window === 'undefined' || !window || !window.location) return {};
  const { search, hash } = window.location;
  const fromHash =
    typeof hash === 'string' && hash.includes('=') ? parseQuery(hash.replace(/^#\/?\??/, '')) : {};
  const fromQuery = parseQuery(typeof search === 'string' ? search : '');
  return { ...fromHash, ...fromQuery };
}
