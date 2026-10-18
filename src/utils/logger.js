/**
 * Levelled, scoped, redacting logger for the Wayfarer SDK (docs/api/03-utils.md §11): `createLogger`
 * returns a `Logger` with `debug` / `info` / `warn` / `error`, `child(scope)` (prefixes messages with
 * the dotted scope and inherits level, sink and redact list), `setLevel(level)` and `redact(obj)`.
 * Levels order `silent < error < warn < info < debug`; a call is written only when its level is at or
 * below the effective level, so redaction work is skipped for suppressed calls. The sink defaults to
 * `globalThis.console` (looked up at call time, never at import time, so the module is SSR‑safe) and
 * may be a console‑like object or a function receiving a structured `LogEntry`. Every message and data
 * payload is passed through `redact` before it reaches the sink: the payload is deep‑cloned (the input
 * is never mutated), values under keys that match the redact list (case‑insensitive, word‑wise, so
 * `accessToken`, `card_number` and `X-Guest-Token` all match) become `[REDACTED]`, and any string that
 * contains a card‑PAN‑like run (13–19 digits, Luhn‑valid, optional single space / dash separators)
 * keeps only its last four digits. Digits joined by separators form a group that is split at the
 * separators; every window of whole consecutive segments that is PAN‑like is masked, so
 * `4111 1111 1111 1111 123` masks the PAN and keeps the tail, while an unbroken longer run
 * (`41111111111111110000`) is never partially matched. The Luhn heuristic can mask an unrelated
 * Luhn‑valid digit string (about one 13‑digit epoch‑ms timestamp in ten); that is the safe side.
 * Boxed primitives are unboxed, `Error`s (same‑ or cross‑realm) become plain records with `name`,
 * `message`, `stack`, `cause`, `errors` and own fields, functions and binary data are summarised, and
 * anything that cannot be read (throwing getter, revoked proxy) becomes `[Unreadable]`. The host list
 * given through `redact` extends the defaults; it can never switch the floor off. This module must
 * never write to `console` directly outside the resolved sink, never throw out of a log call or out of
 * `redact` (sink failures and hostile payloads are swallowed, logging must not break the app), never
 * keep module‑level mutable state, never start timers or listeners, and never throw a plain `Error`
 * (only `ValidationError`, from `createLogger`, `child` and `setLevel` on bad arguments).
 */

import { ValidationError } from '../errors/index.js';

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/**
 * Logger verbosity. `silent` writes nothing; `debug` writes everything.
 * @typedef {'silent'|'error'|'warn'|'info'|'debug'} LogLevel
 */

/**
 * The level of a single log call (every level except `silent`).
 * @typedef {'error'|'warn'|'info'|'debug'} LogCallLevel
 */

/**
 * One log record, as handed to a function sink.
 * @typedef {Object} LogEntry
 * @property {LogCallLevel} level  Level of the call.
 * @property {string} scope        Dotted scope of the emitting logger (`''` at the root).
 * @property {string} msg          Message, prefixed with `[scope] ` when scoped, PANs masked.
 * @property {unknown} [data]      Redacted deep clone of the `data` argument (absent when none).
 * @property {number} at           Epoch milliseconds when the call was made.
 */

/**
 * Console‑shaped sink: the method named after the level is used when present, `log` otherwise.
 * @typedef {Object} ConsoleLike
 * @property {(...args: unknown[]) => void} [debug]
 * @property {(...args: unknown[]) => void} [info]
 * @property {(...args: unknown[]) => void} [warn]
 * @property {(...args: unknown[]) => void} [error]
 * @property {(...args: unknown[]) => void} [log]
 */

/**
 * Where log records go: a console‑like object (called as `sink[level](msg, data?)`) or a function
 * (called as `sink(entry)`).
 * @typedef {ConsoleLike | ((entry: LogEntry) => void)} LogSink
 */

/**
 * @typedef {Object} LoggerOptions
 * @property {LogLevel} [level='warn']  Initial level (the client default is `warn`); `null` = default.
 * @property {LogSink} [sink]           Destination; defaults to `globalThis.console` at call time.
 * @property {string[]} [redact]        Extra key names to mask, added to the default list.
 * @property {string} [scope]           Scope of the root logger (`''` = unprefixed).
 */

/**
 * @typedef {Object} Logger
 * @property {(msg: string, data?: unknown) => void} debug  Write at `debug`.
 * @property {(msg: string, data?: unknown) => void} info   Write at `info`.
 * @property {(msg: string, data?: unknown) => void} warn   Write at `warn`.
 * @property {(msg: string, data?: unknown) => void} error  Write at `error`.
 * @property {(scope: string) => Logger} child   Scoped logger (`parent.scope + '.' + scope`) that
 *   inherits sink, redact list and — until it calls `setLevel` itself — the parent's level.
 * @property {(level: LogLevel) => void} setLevel  Set this logger's level; descendants without their
 *   own level follow it.
 * @property {<T>(obj: T) => T} redact  Deep‑cloned, masked copy of `obj` (see module header).
 * @property {LogLevel} level  Effective level (read‑only).
 * @property {string} scope    Dotted scope (read‑only, `''` at the root).
 */

/** Level names in increasing verbosity; the index is the rank used for gating. */
const LEVELS = /** @type {const} */ (['silent', 'error', 'warn', 'info', 'debug']);

/** @type {Readonly<Record<LogLevel, number>>} */
const RANK = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });

/** Level assumed when none is given — matches the client default (docs/api/01-core.md §1.2). */
const DEFAULT_LEVEL = 'warn';

/**
 * Keys whose values are always masked: the `loggingInterceptor` defaults (docs/api/01-core.md §4)
 * plus the token / card / document fields the SDK itself handles.
 */
const DEFAULT_REDACT_KEYS = Object.freeze([
  'authorization',
  'password',
  'card',
  'documents',
  'token',
  'refreshToken',
  'cvc',
  'cvv',
  'pan',
  'passport',
]);

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
/** Stands in for a value that could not be read (throwing getter, revoked proxy, hostile object). */
const UNREADABLE = '[Unreadable]';
/** Nesting depth past which values are replaced by `[Truncated]` instead of being walked. */
const MAX_DEPTH = 64;
/** PAN length bounds (digits). */
const PAN_MIN = 13;
const PAN_MAX = 19;
/** Digits of a masked PAN that stay visible. */
const PAN_KEEP = 4;

/**
 * Cheap pre‑filter: a string without 13 digits joined by at most single space / dash separators
 * cannot contain a PAN, so the group scanner is skipped for it. No `g` flag, so no `lastIndex` state.
 */
const PAN_HINT_RE = /\d(?:[ -]?\d){12}/;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const objectTag = (v) => Object.prototype.toString.call(v);

// ── validation ──────────────────────────────────────────────────────────────────────────────────

/**
 * Throw a `ValidationError` carrying one issue.
 * @param {string} path
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(path, code, message) {
  /** @type {ValidationIssue[]} */
  const issues = [{ path, code, message }];
  throw new ValidationError(message, { issues });
}

/**
 * @param {unknown} level
 * @param {string} path
 * @returns {LogLevel}
 */
function assertLevel(level, path) {
  if (typeof level !== 'string' || !hasOwn(RANK, level)) {
    return fail(path, 'invalid_level', `${path} must be one of ${LEVELS.join(', ')}`);
  }
  return /** @type {LogLevel} */ (level);
}

/**
 * @param {unknown} sink
 * @param {string} path
 * @returns {LogSink|undefined}
 */
function assertSink(sink, path) {
  if (sink === undefined || sink === null) return undefined;
  if (typeof sink === 'function' || typeof sink === 'object') {
    return /** @type {LogSink} */ (sink);
  }
  return fail(path, 'invalid_sink', `${path} must be a function or a console-like object`);
}

/**
 * @param {unknown} list
 * @param {string} path
 * @returns {string[]}
 */
function assertRedactList(list, path) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some((k) => typeof k !== 'string')) {
    return fail(path, 'invalid_redact', `${path} must be an array of key names`);
  }
  return list;
}

/**
 * @param {unknown} scope
 * @param {string} path
 * @param {boolean} required
 * @returns {string}
 */
function assertScope(scope, path, required) {
  if (!required && (scope === undefined || scope === null)) return '';
  if (typeof scope !== 'string' || (required && scope.trim() === '')) {
    return fail(path, 'invalid_scope', `${path} must be a non-empty string`);
  }
  return scope.trim();
}

// ── key matching ────────────────────────────────────────────────────────────────────────────────

/**
 * Reduce a word to a comparable stem: lower‑case, trailing plural `s` dropped on words longer than
 * three characters (`documents` ≡ `document`, `cards` ≡ `card`, but `pan` / `cvc` stay as they are).
 * @param {string} word
 * @returns {string}
 */
function stem(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * Split a key into comparable words: camelCase, ACRONYMWord, letter / digit, `_`, `-`, `.` and space
 * boundaries all separate words; the result is lower‑cased and stemmed.
 * @param {unknown} key
 * @returns {string[]}
 */
function keyWords(key) {
  if (typeof key !== 'string' || key === '') return [];
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

/**
 * Whether `needle` occurs as a contiguous run inside `haystack`.
 * @param {string[]} haystack
 * @param {string[]} needle
 * @returns {boolean}
 */
function containsRun(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Build the matcher for a redact list: `true` when a key names a value that must be masked. A key
 * matches when the pattern's words occur as a contiguous run in the key's words, or one key word
 * equals the whole pattern joined (so case‑insensitivity holds even for all‑caps multi‑word keys).
 * @param {readonly string[]} keys
 * @returns {(key: unknown) => boolean}
 */
function keyMatcher(keys) {
  const patterns = keys
    .map((k) => keyWords(k))
    .filter((w) => w.length > 0)
    .map((words) => ({ words, joined: stem(words.join('')) }));
  return (key) => {
    const words = keyWords(key);
    if (words.length === 0) return false;
    // `accessToken` → run match on ['access', 'token']; `REFRESHTOKEN` (no case boundary to split on)
    // → its single word equals the pattern's joined form.
    return patterns.some((p) => containsRun(words, p.words) || words.includes(p.joined));
  };
}

// ── card PAN masking ────────────────────────────────────────────────────────────────────────────

/**
 * Luhn mod‑10 check over a digit string.
 * @param {string} digits
 * @returns {boolean}
 */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** @param {number} code UTF‑16 code unit @returns {boolean} */
const isDigitCode = (code) => code >= 48 && code <= 57;

/** @param {number} code UTF‑16 code unit @returns {boolean} `' '` or `'-'`. */
const isSeparatorCode = (code) => code === 32 || code === 45;

/**
 * Mask the PAN‑like windows of one digit group. `group` holds only digits and single separators;
 * `segStarts[k]` / `segEnds[k]` bound its k‑th all‑digit segment. Every window of whole consecutive
 * segments holding 13–19 Luhn‑valid digits is masked to its last four digits; overlapping windows are
 * unioned (over‑masking is the safe direction), so a real PAN is masked no matter which other digits
 * share its group. A group with a single segment can only match as a whole.
 * @param {string} group
 * @param {number[]} segStarts
 * @param {number[]} segEnds
 * @returns {string}
 */
function maskGroup(group, segStarts, segEnds) {
  const segments = segStarts.length;
  /** Digit‑index bounds of each segment inside the concatenated digit string. */
  const digitStart = new Array(segments);
  const digitEnd = new Array(segments);
  let total = 0;
  for (let k = 0; k < segments; k++) {
    digitStart[k] = total;
    total += segEnds[k] - segStarts[k];
    digitEnd[k] = total;
  }
  if (total < PAN_MIN) return group;

  let digits = '';
  for (let k = 0; k < segments; k++) digits += group.slice(segStarts[k], segEnds[k]);

  /** @type {Uint8Array|null} 1 = this digit index is masked. */
  let mask = null;
  for (let a = 0; a < segments; a++) {
    for (let b = a; b < segments; b++) {
      const count = digitEnd[b] - digitStart[a];
      if (count > PAN_MAX) break;
      if (count < PAN_MIN || !luhnValid(digits.slice(digitStart[a], digitEnd[b]))) continue;
      if (!mask) mask = new Uint8Array(total);
      for (let d = digitStart[a]; d < digitEnd[b] - PAN_KEEP; d++) mask[d] = 1;
    }
  }
  if (!mask) return group;

  let out = '';
  let d = 0;
  for (let i = 0; i < group.length; i++) {
    const code = group.charCodeAt(i);
    if (isDigitCode(code)) {
      out += mask[d] ? '*' : group[i];
      d++;
    } else {
      out += group[i];
    }
  }
  return out;
}

/**
 * Mask every card‑PAN‑like run in a string (see `maskGroup`). Digits joined by single space / dash
 * separators are scanned as one group; everything else is copied through.
 * @param {string} s
 * @returns {string}
 */
function maskPans(s) {
  if (s.length < PAN_MIN || !PAN_HINT_RE.test(s)) return s;
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    if (!isDigitCode(s.charCodeAt(i))) {
      let j = i + 1;
      while (j < n && !isDigitCode(s.charCodeAt(j))) j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    /** @type {number[]} */
    const segStarts = [];
    /** @type {number[]} */
    const segEnds = [];
    let j = i;
    for (;;) {
      segStarts.push(j - i);
      while (j < n && isDigitCode(s.charCodeAt(j))) j++;
      segEnds.push(j - i);
      if (j + 1 < n && isSeparatorCode(s.charCodeAt(j)) && isDigitCode(s.charCodeAt(j + 1))) {
        j++;
        continue;
      }
      break;
    }
    out += maskGroup(s.slice(i, j), segStarts, segEnds);
    i = j;
  }
  return out;
}

// ── redaction walk ──────────────────────────────────────────────────────────────────────────────

/**
 * Define `key` on `target` as a plain own data property, even for `"__proto__"`.
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
function setOwn(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/**
 * Masked replacement for a value under a redacted key: `null` / `undefined` stay as they are (they
 * carry nothing and "was it set?" is useful), everything else becomes `[REDACTED]`.
 * @param {unknown} v
 * @returns {unknown}
 */
function maskOrKeep(v) {
  return v === null || v === undefined ? v : REDACTED;
}

/**
 * Whether `value` is an `Error` from this or another realm (iframe, worker, `vm` context, jsdom).
 * @param {unknown} value
 * @returns {value is Error}
 */
function isError(value) {
  return value instanceof Error || objectTag(value) === '[object Error]';
}

/**
 * Deep‑clone `value`, masking matched keys and PAN‑like strings on the way. Never throws: a value
 * that cannot be read becomes `[Unreadable]`.
 * @param {unknown} value
 * @param {(key: unknown) => boolean} matches
 * @param {WeakMap<object, unknown>} seen  Objects already on the current path (cycle detection).
 * @param {number} depth
 * @returns {unknown}
 */
function redactValue(value, matches, seen, depth) {
  if (typeof value === 'string') return maskPans(value);
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  try {
    if (typeof value === 'function') {
      const name = value.name;
      return `[Function${typeof name === 'string' && name ? `: ${name}` : ''}]`;
    }
    return redactObject(value, matches, seen, depth);
  } catch {
    return UNREADABLE;
  }
}

/**
 * `redactValue` for the object case; may throw on hostile input (caught by the caller).
 * @param {object} value
 * @param {(key: unknown) => boolean} matches
 * @param {WeakMap<object, unknown>} seen
 * @param {number} depth
 * @returns {unknown}
 */
function redactObject(value, matches, seen, depth) {
  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  const any = /** @type {any} */ (value);
  const tag = objectTag(value);

  if (value instanceof Date || (tag === '[object Date]' && typeof any.getTime === 'function')) {
    return new Date(any.getTime());
  }
  if (value instanceof RegExp || (tag === '[object RegExp]' && typeof any.source === 'string')) {
    return new RegExp(any.source, any.flags);
  }
  if (
    ArrayBuffer.isView(value) ||
    tag === '[object ArrayBuffer]' ||
    tag === '[object SharedArrayBuffer]'
  ) {
    return `[Binary: ${any.byteLength} bytes]`;
  }
  // Boxed primitives (`new String('4111…')`) are unboxed so the PAN scan sees the whole string instead
  // of one digit per index.
  if (
    tag === '[object String]' ||
    tag === '[object Number]' ||
    tag === '[object Boolean]' ||
    tag === '[object BigInt]' ||
    tag === '[object Symbol]'
  ) {
    const prim = typeof any.valueOf === 'function' ? any.valueOf() : value;
    if (prim === null || (typeof prim !== 'object' && typeof prim !== 'function')) {
      return redactValue(prim, matches, seen, depth);
    }
  }

  seen.set(value, true);
  try {
    const next = depth + 1;
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++)
        out[i] = redactValue(readAt(value, i), matches, seen, next);
      return out;
    }
    if (value instanceof Map) {
      const out = new Map();
      for (const [k, v] of value) {
        out.set(
          redactValue(k, matches, seen, next),
          matches(k) ? maskOrKeep(v) : redactValue(v, matches, seen, next)
        );
      }
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      for (const v of value) out.add(redactValue(v, matches, seen, next));
      return out;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    if (isError(value)) {
      const name = readAt(any, 'name');
      out.name = typeof name === 'string' ? name : 'Error';
      out.message = maskPans(String(readAt(any, 'message') ?? ''));
      const stack = readAt(any, 'stack');
      if (typeof stack === 'string') out.stack = maskPans(stack);
      // `cause` / `errors` are own but non‑enumerable on native errors, so `Object.keys` misses them.
      const cause = readAt(any, 'cause');
      if (cause !== undefined) out.cause = redactValue(cause, matches, seen, next);
      const errors = readAt(any, 'errors');
      if (Array.isArray(errors)) out.errors = redactValue(errors, matches, seen, next);
    }
    for (const key of Object.keys(value)) {
      const v = readAt(any, key);
      setOwn(out, key, matches(key) ? maskOrKeep(v) : redactValue(v, matches, seen, next));
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Read one property, turning a throwing getter / proxy trap into `[Unreadable]` so one bad field does
 * not lose the rest of the record.
 * @param {any} target
 * @param {string|number} key
 * @returns {unknown}
 */
function readAt(target, key) {
  try {
    return target[key];
  } catch {
    return UNREADABLE;
  }
}

// ── sink dispatch ───────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the sink to write to: the injected one, else `globalThis.console` (if any).
 * @param {LogSink|undefined} sink
 * @returns {LogSink|undefined}
 */
function resolveSink(sink) {
  if (sink) return sink;
  const c = globalThis.console;
  return c !== null && typeof c === 'object' ? /** @type {ConsoleLike} */ (c) : undefined;
}

/**
 * Hand one record to the sink. Never throws.
 * @param {LogSink|undefined} sink
 * @param {LogEntry} entry
 */
function write(sink, entry) {
  const target = resolveSink(sink);
  if (!target) return;
  try {
    if (typeof target === 'function') {
      target(entry);
      return;
    }
    const method = target[entry.level];
    const fn = typeof method === 'function' ? method : target.log;
    if (typeof fn !== 'function') return;
    if (hasOwn(entry, 'data')) fn.call(target, entry.msg, entry.data);
    else fn.call(target, entry.msg);
  } catch {
    // A failing sink must never break the caller.
  }
}

// ── factory ─────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LoggerState  Internal, shared down the child chain.
 * @property {LogLevel|null} ownLevel     `null` = inherit from `parent`.
 * @property {LoggerState|null} parent
 * @property {LogSink|undefined} sink
 * @property {(key: unknown) => boolean} matches
 * @property {string} scope
 */

/**
 * @param {LoggerState} state
 * @returns {LogLevel}
 */
function effectiveLevel(state) {
  let s = state;
  while (s.ownLevel === null && s.parent) s = s.parent;
  return s.ownLevel ?? DEFAULT_LEVEL;
}

/**
 * Normalise the `msg` argument to a string (an `Error` contributes its message). Never throws: a
 * message that cannot be stringified becomes `[Unreadable]`.
 * @param {unknown} msg
 * @returns {string}
 */
function toMessage(msg) {
  if (typeof msg === 'string') return msg;
  try {
    if (isError(msg)) return String(/** @type {any} */ (msg).message ?? '');
    return String(msg);
  } catch {
    return UNREADABLE;
  }
}

/**
 * Build a `Logger` over shared state (used for the root and for every child).
 * @param {LoggerState} state
 * @returns {Logger}
 */
function buildLogger(state) {
  const prefix = state.scope ? `[${state.scope}] ` : '';

  /** @param {unknown} obj @returns {unknown} */
  const redact = (obj) => redactValue(obj, state.matches, new WeakMap(), 0);

  /**
   * @param {LogCallLevel} level
   * @returns {(msg: string, data?: unknown) => void}
   */
  const method = (level) => (msg, data) => {
    try {
      if (RANK[level] > RANK[effectiveLevel(state)]) return;
      /** @type {LogEntry} */
      const entry = {
        level,
        scope: state.scope,
        msg: prefix + maskPans(toMessage(msg)),
        at: Date.now(),
      };
      if (data !== undefined) entry.data = redact(data);
      write(state.sink, entry);
    } catch {
      // Logging must never break the caller, whatever the message or payload does.
    }
  };

  /** @type {Logger} */
  const logger = {
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    child(scope) {
      const name = assertScope(scope, 'scope', true);
      return buildLogger({
        ownLevel: null,
        parent: state,
        sink: state.sink,
        matches: state.matches,
        scope: state.scope ? `${state.scope}.${name}` : name,
      });
    },
    setLevel(level) {
      state.ownLevel = assertLevel(level, 'level');
    },
    redact: /** @type {Logger['redact']} */ (redact),
    get level() {
      return effectiveLevel(state);
    },
    get scope() {
      return state.scope;
    },
  };
  return logger;
}

/**
 * Create a root logger. `level` defaults to `warn` (`undefined` / `null` = default); `sink` defaults
 * to `globalThis.console` (resolved on every call, so it is SSR‑safe and follows later stubs);
 * `redact` adds key names to the default mask list (`authorization`, `password`, `card`, `documents`,
 * `token`, `refreshToken`, `cvc`, `cvv`, `pan`, `passport`); `scope` prefixes every message with
 * `[scope] `.
 * Effects: none (log calls write to the sink; no timers, listeners or module state).
 * @param {LoggerOptions} [options]
 * @returns {Logger}
 * @throws {ValidationError} on an unknown level, a non‑callable / non‑object sink, a redact list
 *   that is not an array of strings, or a non‑string scope.
 */
export function createLogger(options = {}) {
  if (options === null || typeof options !== 'object') {
    return fail('options', 'invalid_options', 'options must be an object');
  }
  const level =
    options.level === undefined || options.level === null
      ? DEFAULT_LEVEL
      : assertLevel(options.level, 'level');
  const sink = assertSink(options.sink, 'sink');
  const extra = assertRedactList(options.redact, 'redact');
  const scope = assertScope(options.scope, 'scope', false);
  return buildLogger({
    ownLevel: level,
    parent: null,
    sink,
    matches: keyMatcher([...DEFAULT_REDACT_KEYS, ...extra]),
    scope,
  });
}
