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
 * contains a card‑PAN‑like run (13–19 digits, Luhn‑valid, optional space / dash separators) keeps only
 * its last four digits. The host list given through `redact` extends the defaults; it can never
 * switch the floor off. This module must never write to `console` directly outside the resolved sink,
 * never throw out of a log call (sink failures are swallowed, logging must not break the app), never
 * keep module‑level mutable state, never start timers or listeners, and never throw a plain `Error`
 * (only `ValidationError`).
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
 * @property {LogLevel} [level='warn']  Initial level (the client default is `warn`).
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

/** @type {Record<LogLevel, number>} */
const RANK = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

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
/** Nesting depth past which values are replaced by `[Truncated]` instead of being walked. */
const MAX_DEPTH = 64;

/**
 * Candidate card numbers: 13–19 digits with optional single space / dash separators, not touching
 * other digits on either side (so longer digit runs are never partially matched).
 */
const PAN_RE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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
    .map(keyWords)
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

/**
 * Replace every digit but the last four of a PAN‑shaped match with `*`, keeping separators.
 * @param {string} match
 * @returns {string}
 */
function maskPan(match) {
  const digits = match.replace(/\D/g, '');
  if (!luhnValid(digits)) return match;
  let remaining = digits.length - 4;
  let out = '';
  for (const ch of match) {
    if (ch >= '0' && ch <= '9' && remaining > 0) {
      out += '*';
      remaining--;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Mask every Luhn‑valid 13–19‑digit run in a string.
 * @param {string} s
 * @returns {string}
 */
function maskPans(s) {
  return s.length < 13 ? s : s.replace(PAN_RE, maskPan);
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
 * Deep‑clone `value`, masking matched keys and PAN‑like strings on the way.
 * @param {unknown} value
 * @param {(key: unknown) => boolean} matches
 * @param {WeakMap<object, unknown>} seen  Objects already on the current path (cycle detection).
 * @param {number} depth
 * @returns {unknown}
 */
function redactValue(value, matches, seen, depth) {
  if (typeof value === 'string') return maskPans(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? `[Function${value.name ? `: ${value.name}` : ''}]` : value;
  }
  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[Binary: ${value.byteLength} bytes]`;
  }

  seen.set(value, true);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++)
        out[i] = redactValue(value[i], matches, seen, depth + 1);
      return out;
    }
    if (value instanceof Map) {
      const out = new Map();
      for (const [k, v] of value) {
        out.set(
          redactValue(k, matches, seen, depth + 1),
          matches(k) ? maskOrKeep(v) : redactValue(v, matches, seen, depth + 1)
        );
      }
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      for (const v of value) out.add(redactValue(v, matches, seen, depth + 1));
      return out;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    if (value instanceof Error) {
      out.name = value.name;
      out.message = maskPans(String(value.message));
      if (typeof value.stack === 'string') out.stack = maskPans(value.stack);
    }
    for (const key of Object.keys(value)) {
      const v = /** @type {Record<string, unknown>} */ (value)[key];
      setOwn(out, key, matches(key) ? maskOrKeep(v) : redactValue(v, matches, seen, depth + 1));
    }
    return out;
  } finally {
    seen.delete(value);
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
 * Normalise the `msg` argument to a string (an `Error` contributes its message).
 * @param {unknown} msg
 * @returns {string}
 */
function toMessage(msg) {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return msg.message;
  return String(msg);
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
 * Create a root logger. `level` defaults to `warn`; `sink` defaults to `globalThis.console` (resolved
 * on every call, so it is SSR‑safe and follows later stubs); `redact` adds key names to the default
 * mask list (`authorization`, `password`, `card`, `documents`, `token`, `refreshToken`, `cvc`, `cvv`,
 * `pan`, `passport`); `scope` prefixes every message with `[scope] `.
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
  const level = options.level === undefined ? DEFAULT_LEVEL : assertLevel(options.level, 'level');
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
