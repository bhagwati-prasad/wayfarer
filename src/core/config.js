/**
 * Client configuration for the Wayfarer SDK (docs/api/01-core.md §2, `ClientConfig` in
 * docs/api/00-types.md): the compiled `DEFAULTS`, `defineConfig(partial)` which validates the host's
 * partial, deep‑merges it over the defaults, validates the merged result, normalises (`baseUrl`
 * loses its trailing slash, `currency` is upper‑cased) and deep‑freezes it, and
 * `validateConfig(config)` which reports every problem as a `ValidationResult` without throwing.
 * Validation is strict enough that nothing downstream rejects a defined config later: endpoint keys
 * and templates follow `core/endpoints.js`, access rule keys follow `auth/access.js`, millisecond
 * values fit a 32‑bit timer, and prototype‑pollution keys (`__proto__`, `constructor`, `prototype`)
 * and cyclic message bundles are reported instead of being silently dropped or overflowing the stack.
 * Pure and SSR‑safe: no I/O, no DOM, no timers, no module‑level mutable state, no logging.
 * Host‑owned objects (a custom `storage` adapter, the `payments` port, `fetch`, plugins, telemetry
 * adapters and every function) are kept by reference and are never copied, mutated or frozen; the
 * host's partial is never mutated. The only error thrown is `ConfigError` (carrying `issues[]`);
 * never a plain `Error`, and `validateConfig` never throws at all.
 */

import { ConfigError } from '../errors/index.js';
import { DEFAULT_ACCESS_POLICY } from '../auth/access.js';
import { clone, deepFreeze, deepMerge, isPlainObject } from '../utils/object.js';

/** @typedef {import('../types.js').ClientConfig} ClientConfig */
/** @typedef {import('../types.js').AccessPolicy} AccessPolicy */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../types.js').ValidationResult} ValidationResult */

/**
 * A check for one configuration value: pushes issues for `value` found at `path`.
 * @typedef {(value: unknown, path: string, issues: ValidationIssue[]) => void} Check
 */

// ── enumerations (docs/api/00-types.md, ClientConfig) ──────────────────────────────────────────

const ACCESS_LEVELS = Object.freeze(['open', 'guest', 'auth']);
const ERROR_FORMATS = Object.freeze(['problem+json', 'envelope']);
const AUTH_STRATEGIES = Object.freeze(['bearer', 'cookie']);
const TOKEN_STORAGES = Object.freeze(['memory', 'session', 'local']);
const STORAGE_DRIVERS = Object.freeze(['memory', 'local', 'session']);
const SEARCH_MODES = Object.freeze(['poll', 'single', 'stream']);
const RESULT_MODES = Object.freeze(['per_slice', 'combined', 'auto']);
const LOG_LEVELS = Object.freeze(['silent', 'error', 'warn', 'info', 'debug']);
const HOOK_NAMES = Object.freeze([
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

/** Members every `PaymentsPort` must expose for the duck‑type check (docs/api/07-booking.md §2). */
const PAYMENTS_PORT_MEMBERS = Object.freeze(['methods', 'createIntent', 'confirm', 'pay']);

/** Members every custom `StorageAdapter` must expose (docs/api/02-state-events-errors.md §4). */
const STORAGE_ADAPTER_MEMBERS = Object.freeze(['getItem', 'setItem', 'removeItem']);
/** Optional `StorageAdapter` members (functions when present). */
const STORAGE_ADAPTER_OPTIONAL = Object.freeze(['keys']);
/** Optional `TelemetryAdapter` members (functions when present; docs/api/03-utils.md §10). */
const TELEMETRY_ADAPTER_OPTIONAL = Object.freeze(['page', 'identify', 'flush']);

/**
 * Top‑level keys whose values belong to the host: they are re‑attached by reference after the merge
 * (so `deepMerge` never copies them) and skipped by the freeze.
 */
const HOST_OWNED_KEYS = Object.freeze(['storage', 'payments', 'fetch']);

/** BCP‑47‑ish language tag: 2–3 letter language, optional 1–8 char subtags (`en`, `en-IN`, `zh-Hant-TW`). */
const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;
/** ISO‑4217 code (case is normalised by `defineConfig`). */
const CURRENCY_RE = /^[a-z]{3}$/i;
/** A path segment safe to write with dot notation. */
const PLAIN_KEY_RE = /^[A-Za-z_$][\w$]*$/;
/** Keys `deepMerge` drops (prototype‑pollution vectors); reported instead of vanishing silently. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Whitespace or control characters, which the WHATWG URL parser would strip or keep silently. */
const SPACE_OR_CONTROL_RE = /[\s\p{Cc}]/u;
/** Largest delay `setTimeout` honours; above it browsers and Node fire after ~1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Endpoint / function key: `module.fn`, `module.group.fn`, … (mirrors `core/endpoints.js`). */
const FUNCTION_KEY_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** Access rule key: a function key or a `module.*` / `module.group.*` wildcard (mirrors `auth/access.js`). */
const RULE_KEY_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.\*)?$/;
/** Well‑formed `{name}` placeholders of an endpoint template. */
const PLACEHOLDER_RE = /\{[A-Za-z_$][\w$]*\}/g;
/** Any brace left once well‑formed placeholders are removed: `{bad-name}`, `{unclosed`, `}`. */
const STRAY_BRACE_RE = /[{}]/;
/** An endpoint template may be an absolute http(s) URL instead of a `/path`. */
const ABSOLUTE_URL_RE = /^https?:\/\/\S+$/i;

// ── defaults ────────────────────────────────────────────────────────────────────────────────────

/**
 * Compiled defaults (docs/api/01-core.md §2). `search.resultMode` is `'per_slice'` — the **split**
 * result model of docs/QUESTIONS.md decision 5 (outbound and inbound chosen separately); the
 * frontend may request `'combined'` per search. `locale`, `currency` and `market` have no default:
 * the bootstrap config fills them. Deep‑frozen.
 * @type {Readonly<ClientConfig>}
 */
export const DEFAULTS = deepFreeze({
  baseUrl: 'https://api.ota.com',
  endpoints: {},
  access: DEFAULT_ACCESS_POLICY,
  errorFormat: 'problem+json',
  timeoutMs: 20000,
  retries: 2,
  auth: {
    strategy: 'bearer',
    refreshPath: '/auth/refresh',
    tokenStorage: 'memory',
    autoRefreshSkewMs: 30000,
    guest: true,
  },
  storage: 'local',
  storageNamespace: 'wf',
  persist: { drafts: false },
  interceptors: { request: [], response: [], error: [] },
  hooks: {},
  search: { mode: 'poll', resultMode: 'per_slice', pollIntervalMs: 1500, maxPollMs: 45000 },
  telemetry: { adapters: [], enabled: true, sampleRate: 1 },
  features: {},
  i18n: { fallback: 'en' },
  logger: { level: 'warn', redact: [] },
  autoBootstrap: true,
  plugins: [],
  devtools: false,
});

// ── issue helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} path @param {string} code @param {string} message @param {object} [params]
 * @returns {ValidationIssue}
 */
function issue(path, code, message, params) {
  /** @type {ValidationIssue} */
  const out = { path, code, message };
  if (params) out.params = params;
  return out;
}

/** Human type name used in messages and `params.received`. @param {unknown} v @returns {string} */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Join a child key onto a dotted path, using bracket notation for keys that are not identifiers
 * (`access.rules[booking.*]`, `plugins[0]`), matching what `utils/object.get` can read back.
 * @param {string} base @param {string|number} key
 * @returns {string}
 */
function join(base, key) {
  if (typeof key === 'number') return `${base}[${key}]`;
  if (PLAIN_KEY_RE.test(key)) return base ? `${base}.${key}` : key;
  return `${base}[${key}]`;
}

/** Quote the allowed values of an enum for a message. @param {readonly string[]} list */
function listOf(list) {
  return list.map((v) => `'${v}'`).join(', ');
}

// ── generic checks ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {{ nonEmpty?: boolean }} [options]
 * @returns {value is string}
 */
function expectString(value, path, issues, options = {}) {
  if (typeof value !== 'string' || (options.nonEmpty && value.trim() === '')) {
    const what = options.nonEmpty ? 'a non-empty string' : 'a string';
    issues.push(
      issue(path, 'invalid_type', `${path} must be ${what}`, {
        expected: 'string',
        received: typeOf(value),
      })
    );
    return false;
  }
  return true;
}

/**
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @returns {value is boolean}
 */
function expectBoolean(value, path, issues) {
  if (typeof value !== 'boolean') {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a boolean`, {
        expected: 'boolean',
        received: typeOf(value),
      })
    );
    return false;
  }
  return true;
}

/**
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @returns {value is Function}
 */
function expectFunction(value, path, issues) {
  if (typeof value !== 'function') {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a function`, {
        expected: 'function',
        received: typeOf(value),
      })
    );
    return false;
  }
  return true;
}

/**
 * An integer within `[min, max]` (`max` is unbounded when omitted).
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {{ min: number, max?: number }} options
 * @returns {value is number}
 */
function expectInteger(value, path, issues, { min, max = Infinity }) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be an integer`, {
        expected: 'integer',
        received: typeOf(value),
      })
    );
    return false;
  }
  if (!Number.isInteger(value)) {
    issues.push(issue(path, 'not_integer', `${path} must be an integer`, { received: value }));
    return false;
  }
  if (value < min) {
    issues.push(issue(path, 'min', `${path} must be at least ${min}`, { min, received: value }));
    return false;
  }
  if (value > max) {
    issues.push(issue(path, 'max', `${path} must be at most ${max}`, { max, received: value }));
    return false;
  }
  return true;
}

/**
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {readonly string[]} allowed
 * @returns {value is string}
 */
function expectEnum(value, path, issues, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(
      issue(path, 'invalid_enum', `${path} must be one of ${listOf(allowed)}`, {
        allowed: allowed.slice(),
        received: value,
      })
    );
    return false;
  }
  return true;
}

/**
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @returns {value is Record<string, unknown>}
 */
function expectPlainObject(value, path, issues) {
  if (!isPlainObject(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a plain object`, {
        expected: 'object',
        received: typeOf(value),
      })
    );
    return false;
  }
  return true;
}

/**
 * Any non‑null, non‑array object (class instances included) — for host‑owned duck types.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObjectLike(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A plain object whose known keys pass their `Check` and which has no unknown keys. Keys set to
 * `undefined` count as absent.
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {Record<string, Check>} fields
 */
function expectShape(value, path, issues, fields) {
  if (!expectPlainObject(value, path, issues)) return;
  for (const key of Object.keys(value)) {
    const child = join(path, key);
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      issues.push(
        issue(child, 'unknown_key', `${child} is not a known option`, {
          allowed: Object.keys(fields),
        })
      );
      continue;
    }
    if (value[key] !== undefined) fields[key](value[key], child, issues);
  }
}

/**
 * An array whose every item passes `item`.
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {Check} item
 */
function expectArrayOf(value, path, issues, item) {
  if (!Array.isArray(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be an array`, {
        expected: 'array',
        received: typeOf(value),
      })
    );
    return;
  }
  value.forEach((entry, i) => item(entry, join(path, i), issues));
}

/**
 * A key check for free‑form records: returns whether `key` is acceptable, pushing its own issue
 * (at `path`, the already‑joined child path) when it is not.
 * @typedef {(key: string, path: string, issues: ValidationIssue[]) => boolean} KeyCheck
 */

/**
 * A plain object whose every value passes `item`. Keys are free‑form apart from the reserved
 * prototype‑pollution vectors, which `deepMerge` would silently drop and are therefore reported as
 * `invalid_key`; `keyCheck` may constrain them further.
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {Check} item @param {KeyCheck} [keyCheck]
 */
function expectRecordOf(value, path, issues, item, keyCheck) {
  if (!expectPlainObject(value, path, issues)) return;
  for (const key of Object.keys(value)) {
    const child = join(path, key);
    if (!expectSafeKey(key, child, issues)) continue;
    if (keyCheck && !keyCheck(key, child, issues)) continue;
    if (value[key] !== undefined) item(value[key], child, issues);
  }
}

/** @type {KeyCheck} */
function expectSafeKey(key, path, issues) {
  if (!RESERVED_KEYS.has(key)) return true;
  issues.push(issue(path, 'invalid_key', `${path} is a reserved key`, { received: key }));
  return false;
}

/**
 * An object exposing each of `members` as a function (duck type for host‑provided objects); each of
 * `optional` must be a function too when present.
 * @param {unknown} value @param {string} path @param {ValidationIssue[]} issues
 * @param {readonly string[]} members @param {string} kind
 * @param {readonly string[]} [optional]
 */
function expectDuckType(value, path, issues, members, kind, optional = []) {
  if (!isObjectLike(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a ${kind}`, {
        expected: kind,
        received: typeOf(value),
      })
    );
    return;
  }
  for (const member of members) {
    if (typeof value[member] !== 'function') {
      issues.push(
        issue(
          join(path, member),
          'invalid_type',
          `${path} must be a ${kind}: ${member}() is missing`,
          {
            expected: 'function',
            received: typeOf(value[member]),
          }
        )
      );
    }
  }
  for (const member of optional) {
    if (value[member] !== undefined) expectFunction(value[member], join(path, member), issues);
  }
}

// ── specific checks ─────────────────────────────────────────────────────────────────────────────

/**
 * `baseUrl`: an absolute http(s) URL. The checks go beyond `new URL()`, which silently strips tabs
 * and newlines and accepts a bare `?` / `#` — all of which would survive into the normalised base
 * URL (`defineConfig` only trims and drops trailing slashes) and corrupt every path appended to it.
 * @type {Check}
 */
function checkBaseUrl(value, path, issues) {
  if (!expectString(value, path, issues, { nonEmpty: true })) return;
  const trimmed = value.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    issues.push(
      issue(path, 'invalid_url', `${path} must be an absolute http(s) URL`, { received: value })
    );
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.push(
      issue(path, 'invalid_url', `${path} must use the http or https scheme`, {
        received: url.protocol,
      })
    );
    return;
  }
  if (SPACE_OR_CONTROL_RE.test(trimmed)) {
    issues.push(
      issue(path, 'invalid_url', `${path} must not contain whitespace or control characters`, {
        received: value,
      })
    );
    return;
  }
  if (/[?#]/.test(trimmed)) {
    issues.push(
      issue(path, 'invalid_url', `${path} must not contain a query string or fragment`, {
        received: value,
      })
    );
  }
}

/**
 * An `endpoints` override key, as `createEndpoints` accepts it (`module.fn`, `module.group.fn`).
 * @type {KeyCheck}
 */
function checkEndpointKey(key, path, issues) {
  if (FUNCTION_KEY_RE.test(key)) return true;
  issues.push(
    issue(path, 'invalid_format', `${path} must be an endpoint key such as 'search.create'`, {
      received: key,
    })
  );
  return false;
}

/**
 * An `endpoints` override template, as `createEndpoints` accepts it: a `/path` or absolute http(s)
 * URL without whitespace whose placeholders are well‑formed `{name}`s (surrounding whitespace is
 * tolerated; `createEndpoints` trims it).
 * @type {Check}
 */
function checkEndpointTemplate(value, path, issues) {
  if (!expectString(value, path, issues, { nonEmpty: true })) return;
  const template = value.trim();
  let problem;
  if (/\s/.test(template)) {
    problem = 'must not contain whitespace';
  } else if (!template.startsWith('/') && !ABSOLUTE_URL_RE.test(template)) {
    problem = "must start with '/' or be an absolute http(s) URL";
  } else if (STRAY_BRACE_RE.test(template.replace(PLACEHOLDER_RE, ''))) {
    problem = "has a malformed placeholder (expected '{name}')";
  }
  if (problem)
    issues.push(issue(path, 'invalid_format', `${path} ${problem}`, { received: value }));
}

/**
 * An `access.rules` key, as `createAccess` accepts it: a function key or a `….*` wildcard with no
 * reserved segment (`'booking.create'`, `'booking.*'`, `'trips.changes.*'`).
 * @type {KeyCheck}
 */
function checkAccessRuleKey(key, path, issues) {
  if (RULE_KEY_RE.test(key) && !key.split('.').some((segment) => RESERVED_KEYS.has(segment))) {
    return true;
  }
  issues.push(
    issue(
      path,
      'invalid_format',
      `${path} must be a function key such as 'booking.create' or a wildcard such as 'booking.*'`,
      { received: key }
    )
  );
  return false;
}

/**
 * `i18n.messages`: a tree of plain objects (bundles) whose leaves the host's formatter understands.
 * Reserved keys are reported at any depth, and a plain object that refers back to one of its own
 * ancestors is reported as `cyclic` — `deepMerge` would otherwise recurse without end. A sub‑tree
 * shared between two bundles is not a cycle and is accepted.
 * @type {Check}
 */
function checkMessages(value, path, issues) {
  if (!expectPlainObject(value, path, issues)) return;
  walkMessages(value, path, issues, new Set());
}

/**
 * @param {Record<string, unknown>} node @param {string} path @param {ValidationIssue[]} issues
 * @param {Set<object>} ancestors plain objects on the current descent, `node` included on return
 */
function walkMessages(node, path, issues, ancestors) {
  ancestors.add(node);
  for (const key of Object.keys(node)) {
    const child = join(path, key);
    if (!expectSafeKey(key, child, issues)) continue;
    const value = node[key];
    if (!isPlainObject(value)) continue;
    if (ancestors.has(value)) {
      issues.push(issue(child, 'cyclic', `${child} refers back to one of its ancestors`));
      continue;
    }
    walkMessages(value, child, issues, ancestors);
  }
  ancestors.delete(node);
}

/** @type {Check} */
function checkLocale(value, path, issues) {
  if (!expectString(value, path, issues, { nonEmpty: true })) return;
  if (!LOCALE_RE.test(value)) {
    issues.push(
      issue(path, 'invalid_format', `${path} must be a BCP-47 language tag such as 'en-IN'`, {
        received: value,
      })
    );
  }
}

/** @type {Check} */
function checkCurrency(value, path, issues) {
  if (!expectString(value, path, issues, { nonEmpty: true })) return;
  if (!CURRENCY_RE.test(value)) {
    issues.push(
      issue(path, 'invalid_format', `${path} must be a 3-letter ISO-4217 code such as 'INR'`, {
        received: value,
      })
    );
  }
}

/** @type {Check} */
function checkAccessLevel(value, path, issues) {
  expectEnum(value, path, issues, ACCESS_LEVELS);
}

/** @type {Check} */
function checkStorage(value, path, issues) {
  if (typeof value === 'string') {
    expectEnum(value, path, issues, STORAGE_DRIVERS);
    return;
  }
  expectDuckType(
    value,
    path,
    issues,
    STORAGE_ADAPTER_MEMBERS,
    'storage driver name or StorageAdapter',
    STORAGE_ADAPTER_OPTIONAL
  );
}

/** @type {Check} */
function checkInterceptorList(value, path, issues) {
  expectArrayOf(value, path, issues, expectFunction);
}

/** @type {Check} */
function checkHooks(value, path, issues) {
  if (!expectPlainObject(value, path, issues)) return;
  for (const key of Object.keys(value)) {
    const child = join(path, key);
    if (!HOOK_NAMES.includes(key)) {
      issues.push(
        issue(child, 'unknown_key', `${child} is not a lifecycle hook (${listOf(HOOK_NAMES)})`, {
          allowed: HOOK_NAMES.slice(),
        })
      );
      continue;
    }
    if (value[key] !== undefined) expectFunction(value[key], child, issues);
  }
}

/** @type {Check} */
function checkPlugin(value, path, issues) {
  if (!isObjectLike(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a plugin ({ name, install })`, {
        expected: 'Plugin',
        received: typeOf(value),
      })
    );
    return;
  }
  expectString(value.name, join(path, 'name'), issues, { nonEmpty: true });
  expectFunction(value.install, join(path, 'install'), issues);
}

/** @type {Check} */
function checkTelemetryAdapter(value, path, issues) {
  if (!isObjectLike(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a telemetry adapter ({ name, track })`, {
        expected: 'TelemetryAdapter',
        received: typeOf(value),
      })
    );
    return;
  }
  expectString(value.name, join(path, 'name'), issues, { nonEmpty: true });
  expectFunction(value.track, join(path, 'track'), issues);
  for (const member of TELEMETRY_ADAPTER_OPTIONAL) {
    if (value[member] !== undefined) expectFunction(value[member], join(path, member), issues);
  }
}

/** @type {Check} */
function checkSampleRate(value, path, issues) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a number between 0 and 1`, {
        expected: 'number',
        received: typeOf(value),
      })
    );
    return;
  }
  if (value < 0)
    issues.push(issue(path, 'min', `${path} must be at least 0`, { min: 0, received: value }));
  if (value > 1)
    issues.push(issue(path, 'max', `${path} must be at most 1`, { max: 1, received: value }));
}

/** @type {Check} */
function checkFeatureValue(value, path, issues) {
  if (typeof value !== 'boolean' && typeof value !== 'string') {
    issues.push(
      issue(path, 'invalid_type', `${path} must be a boolean or a string`, {
        expected: 'boolean|string',
        received: typeOf(value),
      })
    );
  }
}

/** @type {Check} */
function checkPayments(value, path, issues) {
  expectDuckType(value, path, issues, PAYMENTS_PORT_MEMBERS, 'PaymentsPort');
}

/** @type {Check} */
const nonNegativeInt = (v, p, i) => expectInteger(v, p, i, { min: 0 });
/** A millisecond delay `setTimeout` can honour (`0` allowed: "disabled" for `timeoutMs`). @type {Check} */
const timerMs = (v, p, i) => expectInteger(v, p, i, { min: 0, max: MAX_TIMER_MS });
/** A strictly positive millisecond delay `setTimeout` can honour. @type {Check} */
const positiveTimerMs = (v, p, i) => expectInteger(v, p, i, { min: 1, max: MAX_TIMER_MS });
/** @type {Check} */
const nonEmptyString = (v, p, i) => expectString(v, p, i, { nonEmpty: true });
/** @type {Check} */
const anyString = (v, p, i) => expectString(v, p, i);

/** One `Check` per `ClientConfig` key; unknown top‑level keys are reported as `unknown_key`. */
const CHECKS = Object.freeze(
  /** @type {Record<string, Check>} */ ({
    baseUrl: checkBaseUrl,
    endpoints: (v, p, i) => expectRecordOf(v, p, i, checkEndpointTemplate, checkEndpointKey),
    access: (v, p, i) =>
      expectShape(v, p, i, {
        default: checkAccessLevel,
        rules: (rv, rp, ri) => expectRecordOf(rv, rp, ri, checkAccessLevel, checkAccessRuleKey),
      }),
    errorFormat: (v, p, i) => expectEnum(v, p, i, ERROR_FORMATS),
    apiKey: nonEmptyString,
    clientId: nonEmptyString,
    locale: checkLocale,
    currency: checkCurrency,
    market: nonEmptyString,
    fetch: expectFunction,
    timeoutMs: timerMs,
    retries: nonNegativeInt,
    auth: (v, p, i) =>
      expectShape(v, p, i, {
        strategy: (sv, sp, si) => expectEnum(sv, sp, si, AUTH_STRATEGIES),
        refreshPath: nonEmptyString,
        tokenStorage: (sv, sp, si) => expectEnum(sv, sp, si, TOKEN_STORAGES),
        autoRefreshSkewMs: timerMs,
        guest: expectBoolean,
      }),
    storage: checkStorage,
    storageNamespace: anyString,
    persist: (v, p, i) => expectShape(v, p, i, { drafts: expectBoolean }),
    interceptors: (v, p, i) =>
      expectShape(v, p, i, {
        request: checkInterceptorList,
        response: checkInterceptorList,
        error: checkInterceptorList,
      }),
    hooks: checkHooks,
    search: (v, p, i) =>
      expectShape(v, p, i, {
        mode: (sv, sp, si) => expectEnum(sv, sp, si, SEARCH_MODES),
        pollIntervalMs: positiveTimerMs,
        maxPollMs: positiveTimerMs,
        resultMode: (sv, sp, si) => expectEnum(sv, sp, si, RESULT_MODES),
      }),
    payments: checkPayments,
    telemetry: (v, p, i) =>
      expectShape(v, p, i, {
        adapters: (av, ap, ai) => expectArrayOf(av, ap, ai, checkTelemetryAdapter),
        enabled: expectBoolean,
        sampleRate: checkSampleRate,
      }),
    features: (v, p, i) => expectRecordOf(v, p, i, checkFeatureValue),
    i18n: (v, p, i) => expectShape(v, p, i, { messages: checkMessages, fallback: checkLocale }),
    logger: (v, p, i) =>
      expectShape(v, p, i, {
        level: (lv, lp, li) => expectEnum(lv, lp, li, LOG_LEVELS),
        sink: expectFunction,
        redact: (rv, rp, ri) => expectArrayOf(rv, rp, ri, anyString),
      }),
    autoBootstrap: expectBoolean,
    plugins: (v, p, i) => expectArrayOf(v, p, i, checkPlugin),
    devtools: expectBoolean,
  })
);

// ── public API ──────────────────────────────────────────────────────────────────────────────────

/**
 * Validate a (partial or complete) client configuration against `ClientConfig`: types, enumerations
 * (`auth.strategy`, `search.mode`, `search.resultMode`, `access` levels, `logger.level`, …),
 * `baseUrl` as an absolute http(s) URL without query, fragment or whitespace (a trailing slash is
 * allowed; `defineConfig` strips it), integer `timeoutMs` / `retries` (millisecond values are
 * non‑negative and fit a 32‑bit timer), BCP‑47‑ish `locale`, 3‑letter `currency`, `storage` as a
 * driver name or `StorageAdapter` duck type, `payments` as a `PaymentsPort` duck type, `endpoints`
 * keys and templates as `createEndpoints` accepts them, `access.rules` keys as `createAccess` accepts
 * them, an acyclic `i18n.messages` tree, unknown keys (`unknown_key`) and the reserved keys
 * `__proto__` / `constructor` / `prototype` (`invalid_key`). Absent (`undefined`) keys are fine —
 * defaults fill them; `null` is reported. Issues follow the input's key order. Never throws.
 * Effects: none.
 * @param {unknown} config
 * @returns {ValidationResult}
 */
export function validateConfig(config) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  if (!isPlainObject(config)) {
    issues.push(
      issue('', 'invalid_type', 'config must be a plain object', {
        expected: 'object',
        received: typeOf(config),
      })
    );
    return { valid: false, issues };
  }
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (!Object.prototype.hasOwnProperty.call(CHECKS, key)) {
      issues.push(
        issue(key, 'unknown_key', `${key} is not a ClientConfig option`, {
          allowed: Object.keys(CHECKS),
        })
      );
      continue;
    }
    if (value !== undefined) CHECKS[key](value, key, issues);
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Build the effective client configuration: validate `partial` with `validateConfig` (so every
 * issue points at what the host actually passed and nothing it passed is silently dropped),
 * deep‑merge it over `DEFAULTS` (nested objects merge, arrays replace, `undefined` keeps the
 * default), validate the merged result, normalise (`baseUrl` trimmed and stripped of trailing
 * slashes, `currency` upper‑cased) and deep‑freeze. Host‑owned values — a custom `storage` adapter,
 * the `payments` port, `fetch`, plugin objects, telemetry adapters and every function — keep their
 * identity and are not frozen; `i18n.messages` is deep‑cloned so the freeze never reaches an object
 * the host still holds. Idempotent: a defined config can be passed back in. Effects: none.
 * @param {Partial<ClientConfig>|null} [partial]
 * @returns {Readonly<ClientConfig>}
 * @throws {ConfigError} with `issues: ValidationIssue[]` when the configuration is invalid
 */
export function defineConfig(partial = {}) {
  const input = partial === null || partial === undefined ? {} : partial;
  const given = validateConfig(input);
  if (!given.valid) throw configError(given.issues);
  // `input` is a plain object now (anything else fails validation above).
  const source = /** @type {Record<string, unknown>} */ (input);

  // Host-owned values are kept out of the merge (deepMerge would copy a plain adapter object) and
  // re-attached by reference afterwards.
  /** @type {Record<string, unknown>} */
  const mergeable = {};
  for (const key of Object.keys(source)) {
    if (HOST_OWNED_KEYS.includes(key)) continue;
    mergeable[key] = key === 'i18n' ? cloneI18n(source[key]) : source[key];
  }
  const merged = deepMerge(DEFAULTS, mergeable);
  for (const key of HOST_OWNED_KEYS) {
    if (source[key] !== undefined) merged[key] = source[key];
  }
  // A valid partial merges into a valid config; this guards the defaults themselves and the merge.
  const effective = validateConfig(merged);
  if (!effective.valid) throw configError(effective.issues);

  merged.baseUrl = normaliseBaseUrl(/** @type {string} */ (merged.baseUrl));
  if (typeof merged.currency === 'string') merged.currency = merged.currency.toUpperCase();
  return /** @type {Readonly<ClientConfig>} */ (freezeConfig(merged));
}

// ── internals ───────────────────────────────────────────────────────────────────────────────────

/**
 * The host's `i18n` block with `messages` deep‑cloned. `deepMerge` copies nested plain objects but
 * shares array items with its source, so without the clone `freezeConfig` would freeze bundle
 * entries (objects inside arrays) that the host still owns. Validation has passed, so `i18n` is a
 * plain object or `undefined`; the host's object is not touched.
 * @param {unknown} i18n
 * @returns {unknown}
 */
function cloneI18n(i18n) {
  if (!isPlainObject(i18n) || i18n.messages === undefined) return i18n;
  return { ...i18n, messages: clone(i18n.messages) };
}

/**
 * Trim and drop every trailing slash (`https://api.ota.com/` → `https://api.ota.com`).
 * @param {string} baseUrl
 * @returns {string}
 */
function normaliseBaseUrl(baseUrl) {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Deep‑freeze everything the SDK owns; leave host‑owned objects untouched (freezing them in place
 * would mutate the host's objects and break adapters that keep state in own properties).
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, unknown>}
 */
function freezeConfig(cfg) {
  for (const key of Object.keys(cfg)) {
    const value = cfg[key];
    if (HOST_OWNED_KEYS.includes(key)) continue;
    if (key === 'plugins') {
      if (Array.isArray(value)) Object.freeze(value);
    } else if (key === 'telemetry' && isPlainObject(value)) {
      for (const tKey of Object.keys(value)) {
        if (tKey === 'adapters') {
          if (Array.isArray(value.adapters)) Object.freeze(value.adapters);
        } else {
          deepFreeze(value[tKey]);
        }
      }
      Object.freeze(value);
    } else {
      deepFreeze(value);
    }
  }
  return Object.freeze(cfg);
}

/**
 * Build the `ConfigError` for a failed validation: the message names the first issue and how many
 * more there are; every issue is on `error.issues` (and `error.details.issues`).
 * @param {ValidationIssue[]} issues
 * @returns {ConfigError & { issues: ValidationIssue[] }}
 */
function configError(issues) {
  const first = issues[0];
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  const message = first
    ? `Invalid client config: ${first.message}${more}`
    : 'Invalid client config';
  const error = /** @type {ConfigError & { issues: ValidationIssue[] }} */ (
    new ConfigError(message, { details: { issues } })
  );
  error.issues = issues;
  return error;
}
