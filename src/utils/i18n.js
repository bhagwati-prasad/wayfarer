/**
 * Internationalisation for the Wayfarer SDK (docs/api/03-utils.md §9): `createI18n` returns an
 * `I18n` whose `t(key, vars, { count, default })` renders ICU‑lite messages — `{name}` interpolation
 * (numbers and dates are formatted for the locale), `{count, plural, =0{…} one{…} other{…}}` with
 * `#` for the count (categories from `Intl.PluralRules`, exact `=N` matches, `offset:N`,
 * `selectordinal`), `{value, select, a{…} other{…}}`, `{n, number}` / `{n, number, percent}` /
 * `{d, date, short}` and ICU apostrophe quoting (`'{'`, `''`). Keys are dotted paths resolved
 * against nested bundles (flat `'a.b'` keys work too) along the fallback chain
 * `en-IN → en → fallback`; the bundled English copy (`messages/en.js`) is always loaded so every
 * SDK string resolves out of the box. A key found in no bundle is recorded (`i18n.missing()` lists
 * them) and renders the `default` option, the custom `missing` handler's string, or the key itself.
 * `setLocale` / `addMessages` / `loadMessages` notify `onChange` listeners (the client turns those
 * into `prefs:change`; this module emits nothing itself). `dir()` is `'rtl'` for Arabic, Hebrew,
 * Persian, Urdu and other right‑to‑left languages / scripts. Everything is SSR‑safe (`Intl` is read
 * at call time, never `window` / `navigator`), keeps no module‑level mutable state (caches live on the
 * instance), starts no timers, never logs and never throws a plain `Error` — only `ValidationError`
 * for bad arguments and the `SdkError` `wrap` produces for a failed message loader.
 */

import { ValidationError, wrap } from '../errors/index.js';
import { deepMerge, get, isPlainObject, stableStringify } from './object.js';
import { en } from './messages/en.js';

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('./messages/en.js').Messages} Messages */

/** @typedef {'zero'|'one'|'two'|'few'|'many'|'other'} PluralCategory */
/** @typedef {'ltr'|'rtl'} TextDirection */

/**
 * Custom plural selector: a function, or an `Intl.PluralRules`‑like object with `select(n)`.
 * @typedef {((n: number, locale: string, type: 'cardinal'|'ordinal') => string) | { select(n: number): string }} PluralSelector
 */

/**
 * Called for a key found in no bundle of the fallback chain (and no `default` given). A returned
 * string is used as the translation; anything else falls back to the key itself.
 * @typedef {(key: string, locale: string, vars: Record<string, unknown>) => string | void} MissingHandler
 */

/**
 * Payload handed to `onChange` listeners.
 * @typedef {Object} I18nChange
 * @property {'locale'|'messages'} type     What changed: the active locale or a message bundle.
 * @property {string} locale                 The active locale (`'locale'`) or the bundle's (`'messages'`).
 * @property {string} [previous]             Previous active locale (`'locale'` only).
 * @property {TextDirection} dir             Text direction of the active locale.
 */

/**
 * @typedef {Object} I18nOptions
 * @property {string} [locale]                       Initial locale; defaults to the (first) fallback.
 * @property {Record<string, Messages>} [messages]   Bundles keyed by locale, merged over the built‑in `en`.
 * @property {string|string[]} [fallback='en']       Locale(s) tried after the active locale's chain.
 * @property {PluralSelector} [pluralRules]          Override `Intl.PluralRules`.
 * @property {MissingHandler} [missing]              Custom handler for keys found in no bundle.
 */

/**
 * @typedef {Object} TranslateOptions
 * @property {number} [count]     Shorthand for `vars.count` (used by `plural` arguments).
 * @property {string} [default]   Rendered (with `vars`) when the key is found in no bundle.
 */

/**
 * @typedef {Object} FormatListOptions
 * @property {'conjunction'|'disjunction'|'unit'} [type='conjunction']
 * @property {'long'|'short'|'narrow'} [style='long']
 */

/**
 * @typedef {Object} I18n
 * @property {(key: string, vars?: Record<string, unknown>, opts?: TranslateOptions) => string} t
 *   Render the message at `key` for the active locale (falling back along the chain).
 * @property {(locale: string) => void} setLocale             Switch locale; notifies `onChange` when it differs.
 * @property {() => string} getLocale                         Active (canonicalised) locale.
 * @property {(locale?: string) => TextDirection} dir         Text direction of the active (or given) locale.
 * @property {(locale: string, messages: Messages, opts?: { merge?: boolean }) => void} addMessages
 *   Add a bundle: deep‑merged over the existing one (default) or replacing it (`merge: false`).
 * @property {(key: string, locale?: string) => boolean} hasKey   True when `key` resolves to a string along the chain.
 * @property {(locale: string, loader: (locale: string) => Promise<Messages | { default: Messages }>) => Promise<void>} loadMessages
 *   Load a bundle asynchronously (single‑flight per locale + loader) and add it.
 * @property {(items: unknown[], opts?: FormatListOptions) => string} formatList   `Intl.ListFormat` (`a, b, and c`).
 * @property {(n: number|bigint|string, opts?: Intl.NumberFormatOptions) => string} formatNumber   `Intl.NumberFormat`.
 * @property {(n: number|bigint|string, opts?: Intl.NumberFormatOptions) => string} formatPercent  `0.15 → 15%`.
 * @property {(fn: (change: I18nChange) => void) => () => void} onChange   Subscribe to locale / bundle changes.
 * @property {() => string[]} missing                          Keys requested but found in no bundle (unique, in order).
 * @property {() => string[]} locales                          Locales that have a bundle, sorted.
 * @property {() => void} destroy                              Drop listeners, caches, pending loads and the missing list.
 */

// ── message AST ─────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ type: 'text', value: string }
 *   | { type: 'pound' }
 *   | { type: 'arg', name: string, format?: 'number'|'date'|'time', style?: string }
 *   | { type: 'plural', name: string, ordinal: boolean, offset: number, options: Record<string, MessageNode[]> }
 *   | { type: 'select', name: string, options: Record<string, MessageNode[]> }} MessageNode
 */

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi', 'dv', 'ckb', 'syr', 'ug']);
const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Thaa', 'Syrc', 'Nkoo', 'Adlm', 'Rohg']);
const LTR_SCRIPTS = new Set(['Latn', 'Cyrl', 'Deva', 'Grek', 'Hans', 'Hant', 'Jpan', 'Kore']);
/** Upper bound for every per‑instance memo before it is reset. */
const CACHE_LIMIT = 500;
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * @param {string} message @param {string} path @param {string} code @param {object} [params]
 * @returns {ValidationError}
 */
function invalid(message, path, code, params) {
  /** @type {ValidationIssue} */
  const issue = { path, code, message };
  if (params) issue.params = params;
  return new ValidationError(`createI18n: ${message}`, { issues: [issue] });
}

/** @param {unknown} v @returns {v is string} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** @param {string} c */
function isWs(c) {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r';
}

/**
 * Canonical BCP 47 form of a locale tag (`en_in` → `en-IN`, `iw` → `he`). Falls back to a manual
 * case normalisation when `Intl.getCanonicalLocales` rejects the tag.
 * @param {string} tag
 * @returns {string}
 */
function normalizeLocale(tag) {
  const raw = tag.trim().replace(/_/g, '-');
  try {
    const canon = Intl.getCanonicalLocales(raw)[0];
    if (canon) return canon;
  } catch {
    // not a well‑formed tag: normalise by hand below
  }
  return raw
    .split('-')
    .filter(Boolean)
    .map((part, i) => {
      if (i === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      return part.toLowerCase();
    })
    .join('-');
}

/**
 * Text direction for a canonical locale tag: script subtag first, language subtag otherwise.
 * @param {string} locale
 * @returns {TextDirection}
 */
function directionOf(locale) {
  const parts = locale.split('-');
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 4) {
      if (RTL_SCRIPTS.has(p)) return 'rtl';
      if (LTR_SCRIPTS.has(p)) return 'ltr';
    }
  }
  return RTL_LANGUAGES.has(parts[0].toLowerCase()) ? 'rtl' : 'ltr';
}

/**
 * Resolve a dotted key against a (possibly mixed flat / nested) bundle without walking prototypes.
 * @param {unknown} node @param {string[]} segs @param {number} start
 * @returns {unknown}
 */
function resolvePath(node, segs, start) {
  if (start >= segs.length) return node;
  if (!isPlainObject(node)) return undefined;
  for (let end = segs.length; end > start; end--) {
    const k = segs.slice(start, end).join('.');
    if (hasOwn.call(node, k)) {
      const found = resolvePath(node[k], segs, end);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ── parser ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse an ICU‑lite message into nodes. Malformed arguments are kept as literal text, so a message
 * can never fail to render.
 * @param {string} src
 * @returns {MessageNode[]}
 */
function parseMessage(src) {
  return parseNodes({ src, i: 0 }, false, false);
}

/**
 * @param {{ src: string, i: number }} st
 * @param {boolean} inBranch   Inside a `{…}` option body: an unquoted `}` ends the body.
 * @param {boolean} inPlural   Inside a plural body (possibly through a nested select): `#` is the count.
 * @returns {MessageNode[]}
 */
function parseNodes(st, inBranch, inPlural) {
  const { src } = st;
  /** @type {MessageNode[]} */
  const nodes = [];
  let text = '';
  const flush = () => {
    if (text) nodes.push({ type: 'text', value: text });
    text = '';
  };
  while (st.i < src.length) {
    const ch = src[st.i];
    if (ch === "'") {
      const next = src[st.i + 1];
      if (next === "'") {
        text += "'";
        st.i += 2;
      } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
        st.i += 1;
        while (st.i < src.length) {
          const c = src[st.i];
          if (c === "'") {
            if (src[st.i + 1] === "'") {
              text += "'";
              st.i += 2;
              continue;
            }
            st.i += 1;
            break;
          }
          text += c;
          st.i += 1;
        }
      } else {
        text += ch;
        st.i += 1;
      }
      continue;
    }
    if (ch === '}' && inBranch) break;
    if (ch === '#' && inPlural) {
      flush();
      nodes.push({ type: 'pound' });
      st.i += 1;
      continue;
    }
    if (ch === '{') {
      const arg = parseArgument(st, inPlural);
      if (arg) {
        flush();
        nodes.push(arg);
        continue;
      }
    }
    text += ch;
    st.i += 1;
  }
  flush();
  return nodes;
}

/**
 * Parse one `{…}` argument starting at `st.i`. Returns `null` (cursor restored) when malformed.
 * @param {{ src: string, i: number }} st
 * @param {boolean} inPlural
 * @returns {MessageNode|null}
 */
function parseArgument(st, inPlural) {
  const { src } = st;
  const start = st.i;
  const fail = () => {
    st.i = start;
    return null;
  };
  const skipWs = () => {
    while (st.i < src.length && isWs(src[st.i])) st.i++;
  };
  const readToken = (re) => {
    let out = '';
    while (st.i < src.length && re.test(src[st.i])) out += src[st.i++];
    return out;
  };

  st.i += 1; // '{'
  skipWs();
  const name = readToken(/[\w.-]/);
  if (!name) return fail();
  skipWs();
  if (src[st.i] === '}') {
    st.i += 1;
    return { type: 'arg', name };
  }
  if (src[st.i] !== ',') return fail();
  st.i += 1;
  skipWs();
  const kind = readToken(/[a-zA-Z]/);
  skipWs();

  if (kind === 'number' || kind === 'date' || kind === 'time') {
    let style = '';
    if (src[st.i] === ',') {
      st.i += 1;
      skipWs();
      style = readToken(/[\w:-]/);
      skipWs();
    }
    if (src[st.i] !== '}') return fail();
    st.i += 1;
    /** @type {MessageNode} */
    const node = { type: 'arg', name, format: kind };
    if (style) node.style = style;
    return node;
  }

  if (kind !== 'plural' && kind !== 'selectordinal' && kind !== 'select') return fail();
  if (src[st.i] !== ',') return fail();
  st.i += 1;
  const isPlural = kind !== 'select';
  let offset = 0;
  /** @type {Record<string, MessageNode[]>} */
  const options = {};
  for (;;) {
    skipWs();
    if (st.i >= src.length) return fail();
    if (src[st.i] === '}') {
      st.i += 1;
      break;
    }
    const selector = readToken(/[^\s{}]/);
    if (!selector) return fail();
    if (isPlural && selector.startsWith('offset:')) {
      let value = selector.slice('offset:'.length);
      if (!value) {
        skipWs();
        value = readToken(/[\d-]/);
      }
      const n = Number(value);
      if (!Number.isFinite(n)) return fail();
      offset = n;
      continue;
    }
    skipWs();
    if (src[st.i] !== '{') return fail();
    st.i += 1;
    const body = parseNodes(st, true, isPlural || inPlural);
    if (src[st.i] !== '}') return fail();
    st.i += 1;
    if (!hasOwn.call(options, selector)) options[selector] = body;
  }
  return isPlural
    ? { type: 'plural', name, ordinal: kind === 'selectordinal', offset, options }
    : { type: 'select', name, options };
}

// ── factory ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Validate `options` and return the normalised fallback list.
 * @param {I18nOptions} options
 * @returns {string[]}
 */
function validateOptions(options) {
  if (!isPlainObject(options)) {
    throw invalid('options must be an object', 'options', 'type', { expected: 'object' });
  }
  if (options.locale !== undefined && !isNonEmptyString(options.locale)) {
    throw invalid('locale must be a non-empty string', 'locale', 'type', { expected: 'string' });
  }
  const fb = options.fallback === undefined ? ['en'] : options.fallback;
  const fallbacks = Array.isArray(fb) ? fb : [fb];
  if (fallbacks.length === 0 || !fallbacks.every(isNonEmptyString)) {
    throw invalid('fallback must be a non-empty string or array of them', 'fallback', 'type', {
      expected: 'string | string[]',
    });
  }
  if (options.messages !== undefined && !isPlainObject(options.messages)) {
    throw invalid('messages must be an object keyed by locale', 'messages', 'type', {
      expected: 'object',
    });
  }
  if (options.missing !== undefined && typeof options.missing !== 'function') {
    throw invalid('missing must be a function', 'missing', 'type', { expected: 'function' });
  }
  const pr = options.pluralRules;
  if (
    pr !== undefined &&
    typeof pr !== 'function' &&
    !(typeof pr === 'object' && pr !== null && typeof pr.select === 'function')
  ) {
    throw invalid(
      'pluralRules must be a function or an object with select()',
      'pluralRules',
      'type',
      {
        expected: 'function | { select }',
      }
    );
  }
  return fallbacks.map(normalizeLocale);
}

/**
 * Create an i18n instance. The built‑in `en` bundle is always present; `messages` are merged over
 * it per locale. Effects: none (no I/O, no timers, no DOM).
 * @param {I18nOptions} [options]
 * @returns {I18n}
 * @throws {ValidationError} on malformed options
 */
export function createI18n(options = {}) {
  const fallbacks = validateOptions(options);
  const customMissing = options.missing;
  const customPlural = options.pluralRules;

  /** @type {Map<string, Messages>} locale → bundle (deep copies; never the caller's objects) */
  const bundles = new Map();
  /** @type {Map<string, string[]>} locale → fallback chain */
  const chainCache = new Map();
  /** @type {Map<string, { value: string, locale: string } | null>} `${locale}\u0000${key}` → hit */
  const lookupCache = new Map();
  /** @type {Map<string, MessageNode[]>} message source → AST */
  const astCache = new Map();
  /** @type {Map<string, Intl.NumberFormat>} */
  const numberFormats = new Map();
  /** @type {Map<string, Intl.PluralRules>} */
  const pluralRules = new Map();
  /** @type {Map<string, Intl.ListFormat>} */
  const listFormats = new Map();
  /** @type {Map<string, Intl.DateTimeFormat>} */
  const dateFormats = new Map();
  /** @type {Set<(change: I18nChange) => void>} */
  const listeners = new Set();
  /** @type {Map<string, { loader: Function, promise: Promise<void> }>} */
  const pending = new Map();
  /** @type {Set<string>} */
  const missingKeys = new Set();

  let locale = normalizeLocale(options.locale === undefined ? fallbacks[0] : options.locale);

  /**
   * Bounded memo helper: `make` is only called on a miss; the memo is reset once it grows too big.
   * @template T
   * @param {Map<string, T>} cache @param {string} key @param {() => T} make
   * @returns {T}
   */
  function memo(cache, key, make) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    const made = make();
    cache.set(key, made);
    return made;
  }

  /**
   * Build an `Intl` formatter, retrying with the fallback locales and finally the engine default
   * when a tag is rejected.
   * @template T
   * @param {string} loc @param {(tag: string|undefined) => T} make
   * @returns {T}
   */
  function withLocaleFallback(loc, make) {
    const candidates = [loc, ...fallbacks, undefined];
    let lastError;
    for (const tag of candidates) {
      try {
        return make(tag);
      } catch (e) {
        lastError = e;
      }
    }
    // Even the engine default locale was rejected: the formatting options themselves are invalid.
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw invalid(`Intl rejected the formatting options: ${reason}`, 'options', 'invalid');
  }

  /** @param {string} loc @returns {string[]} */
  function chainFor(loc) {
    return memo(chainCache, loc, () => {
      /** @type {string[]} */
      const out = [];
      const expand = (tag) => {
        const parts = tag.split('-');
        for (let i = parts.length; i > 0; i--) {
          const prefix = parts.slice(0, i).join('-');
          if (!out.includes(prefix)) out.push(prefix);
        }
      };
      expand(loc);
      for (const f of fallbacks) expand(f);
      return out;
    });
  }

  /**
   * Find the message for `key` along the chain of `loc`.
   * @param {string} key @param {string} loc
   * @returns {{ value: string, locale: string } | null}
   */
  function find(key, loc) {
    const cacheKey = `${loc}\u0000${key}`;
    const cached = lookupCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const segs = key.split('.');
    /** @type {{ value: string, locale: string } | null} */
    let hit = null;
    for (const tag of chainFor(loc)) {
      const bundle = bundles.get(tag);
      if (!bundle) continue;
      const value = resolvePath(bundle, segs, 0);
      if (typeof value === 'string') {
        hit = { value, locale: tag };
        break;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        hit = { value: String(value), locale: tag };
        break;
      }
    }
    if (lookupCache.size >= CACHE_LIMIT) lookupCache.clear();
    lookupCache.set(cacheKey, hit);
    return hit;
  }

  /**
   * Lenient number formatting used while rendering: non‑numeric input is stringified as is.
   * @param {unknown} value @param {string} loc @param {Intl.NumberFormatOptions} [opts]
   * @returns {string}
   */
  function fmtNumber(value, loc, opts) {
    const n = toNumeric(value);
    if (n === undefined) return String(value);
    if (typeof Intl === 'undefined' || typeof Intl.NumberFormat !== 'function') return String(n);
    const cacheKey = `${loc}|${opts ? stableStringify(opts) : ''}`;
    const nf = memo(numberFormats, cacheKey, () =>
      withLocaleFallback(loc, (tag) => new Intl.NumberFormat(tag, opts))
    );
    return nf.format(/** @type {number} */ (n));
  }

  /**
   * @param {unknown} value @param {string} loc @param {string} kind @param {string} [style]
   * @returns {string}
   */
  function fmtDate(value, loc, kind, style) {
    const d = value instanceof Date ? value : new Date(/** @type {any} */ (value));
    if (Number.isNaN(d.getTime())) return String(value);
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
      return d.toISOString();
    }
    /** @type {Intl.DateTimeFormatOptions} */
    const opts = {};
    const s = /** @type {'short'|'medium'|'long'|'full'} */ (
      style === 'short' || style === 'long' || style === 'full' ? style : 'medium'
    );
    if (kind === 'time') opts.timeStyle = s;
    else opts.dateStyle = s;
    const cacheKey = `${loc}|${kind}|${s}`;
    const df = memo(dateFormats, cacheKey, () =>
      withLocaleFallback(loc, (tag) => new Intl.DateTimeFormat(tag, opts))
    );
    return df.format(d);
  }

  /**
   * @param {number} n @param {string} loc @param {boolean} ordinal
   * @returns {string}
   */
  function pluralCategory(n, loc, ordinal) {
    const type = ordinal ? 'ordinal' : 'cardinal';
    if (typeof customPlural === 'function') return String(customPlural(n, loc, type));
    if (customPlural && typeof customPlural.select === 'function') {
      return String(customPlural.select(n));
    }
    if (typeof Intl === 'undefined' || typeof Intl.PluralRules !== 'function') {
      return n === 1 ? 'one' : 'other';
    }
    const rules = memo(pluralRules, `${loc}|${type}`, () =>
      withLocaleFallback(loc, (tag) => new Intl.PluralRules(tag, { type }))
    );
    return rules.select(n);
  }

  /**
   * Read an argument value: own property first, then a dotted path into `vars`.
   * @param {Record<string, unknown>} vars @param {string} name
   * @returns {unknown}
   */
  function argValue(vars, name) {
    if (hasOwn.call(vars, name)) return vars[name];
    return name.includes('.') ? get(vars, name) : undefined;
  }

  /**
   * Render parsed nodes. `msgLocale` drives plural categories (the language of the text);
   * `fmtLocale` drives number / date formatting (the user's locale).
   * @param {MessageNode[]} nodes @param {Record<string, unknown>} vars
   * @param {string} msgLocale @param {string} fmtLocale @param {string|undefined} pound
   * @returns {string}
   */
  function render(nodes, vars, msgLocale, fmtLocale, pound) {
    let out = '';
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out += node.value;
          break;
        case 'pound':
          out += pound === undefined ? '#' : pound;
          break;
        case 'arg': {
          const value = argValue(vars, node.name);
          if (value === undefined || value === null) {
            out += `{${node.name}}`;
          } else if (node.format === 'number') {
            out +=
              node.style === 'percent'
                ? fmtNumber(value, fmtLocale, { style: 'percent' })
                : node.style === 'integer'
                  ? fmtNumber(value, fmtLocale, { maximumFractionDigits: 0 })
                  : fmtNumber(value, fmtLocale);
          } else if (node.format === 'date' || node.format === 'time') {
            out += fmtDate(value, fmtLocale, node.format, node.style);
          } else if (typeof value === 'number' || typeof value === 'bigint') {
            out += fmtNumber(value, fmtLocale);
          } else if (value instanceof Date) {
            out += fmtDate(value, fmtLocale, 'date');
          } else {
            out += String(value);
          }
          break;
        }
        case 'plural': {
          const n = toNumeric(argValue(vars, node.name));
          if (n === undefined) {
            out += `{${node.name}}`;
            break;
          }
          const num = Number(n);
          const shifted = num - node.offset;
          const branch =
            node.options[`=${num}`] ||
            node.options[pluralCategory(shifted, msgLocale, node.ordinal)] ||
            node.options.other;
          if (branch) {
            out += render(branch, vars, msgLocale, fmtLocale, fmtNumber(shifted, fmtLocale));
          }
          break;
        }
        case 'select': {
          const value = argValue(vars, node.name);
          const key = value === undefined || value === null ? undefined : String(value);
          const branch = (key !== undefined && node.options[key]) || node.options.other;
          if (branch) out += render(branch, vars, msgLocale, fmtLocale, pound);
          else if (key !== undefined) out += key;
          else out += `{${node.name}}`;
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  /**
   * @param {string} source @param {Record<string, unknown>} vars @param {string} msgLocale
   * @returns {string}
   */
  function format(source, vars, msgLocale) {
    const ast = memo(astCache, source, () => parseMessage(source));
    return render(ast, vars, msgLocale, locale, undefined);
  }

  /** @param {I18nChange} change */
  function notify(change) {
    for (const fn of Array.from(listeners)) {
      try {
        fn(change);
      } catch {
        // a listener must never break the caller of setLocale / addMessages
      }
    }
  }

  /** @param {unknown} key @returns {asserts key is string} */
  function assertKey(key) {
    if (!isNonEmptyString(key)) {
      throw invalid('key must be a non-empty string', 'key', 'type', { expected: 'string' });
    }
  }

  /**
   * @param {string} loc @param {Messages} messages @param {boolean} merge
   */
  function putBundle(loc, messages, merge) {
    const existing = bundles.get(loc);
    bundles.set(
      loc,
      merge && existing
        ? /** @type {Messages} */ (deepMerge(existing, messages))
        : /** @type {Messages} */ (deepMerge({}, messages))
    );
    lookupCache.clear();
  }

  putBundle('en', en, false);
  if (options.messages) {
    for (const [tag, bundle] of Object.entries(options.messages)) {
      if (!isNonEmptyString(tag) || !isPlainObject(bundle)) {
        throw invalid(`messages['${tag}'] must be an object`, `messages.${tag}`, 'type', {
          expected: 'object',
        });
      }
      putBundle(normalizeLocale(tag), bundle, true);
    }
  }

  // ── public API ────────────────────────────────────────────────────────────────────────────────

  /** @type {I18n['t']} */
  function t(key, vars, opts) {
    assertKey(key);
    const o = opts && typeof opts === 'object' ? opts : {};
    /** @type {Record<string, unknown>} */
    let v = vars && typeof vars === 'object' ? /** @type {Record<string, unknown>} */ (vars) : {};
    if (o.count !== undefined && !hasOwn.call(v, 'count')) v = { ...v, count: o.count };
    const hit = find(key, locale);
    if (hit) return format(hit.value, v, hit.locale);
    missingKeys.add(key);
    if (typeof o.default === 'string') return format(o.default, v, locale);
    if (customMissing) {
      const custom = customMissing(key, locale, v);
      if (typeof custom === 'string') return custom;
    }
    return key;
  }

  /** @type {I18n['setLocale']} */
  function setLocale(next) {
    if (!isNonEmptyString(next)) {
      throw invalid('locale must be a non-empty string', 'locale', 'type', { expected: 'string' });
    }
    const normalized = normalizeLocale(next);
    if (normalized === locale) return;
    const previous = locale;
    locale = normalized;
    notify({ type: 'locale', locale, previous, dir: directionOf(locale) });
  }

  /** @type {I18n['getLocale']} */
  function getLocale() {
    return locale;
  }

  /** @type {I18n['dir']} */
  function dir(of) {
    if (of === undefined) return directionOf(locale);
    if (!isNonEmptyString(of)) {
      throw invalid('locale must be a non-empty string', 'locale', 'type', { expected: 'string' });
    }
    return directionOf(normalizeLocale(of));
  }

  /** @type {I18n['addMessages']} */
  function addMessages(tag, messages, opts = {}) {
    if (!isNonEmptyString(tag)) {
      throw invalid('locale must be a non-empty string', 'locale', 'type', { expected: 'string' });
    }
    if (!isPlainObject(messages)) {
      throw invalid('messages must be an object', 'messages', 'type', { expected: 'object' });
    }
    const merge = !(opts && opts.merge === false);
    const loc = normalizeLocale(tag);
    putBundle(loc, messages, merge);
    notify({ type: 'messages', locale: loc, dir: directionOf(locale) });
  }

  /** @type {I18n['hasKey']} */
  function hasKey(key, of) {
    assertKey(key);
    return find(key, of === undefined ? locale : normalizeLocale(String(of))) !== null;
  }

  /** @type {I18n['loadMessages']} */
  function loadMessages(tag, loader) {
    if (!isNonEmptyString(tag)) {
      throw invalid('locale must be a non-empty string', 'locale', 'type', { expected: 'string' });
    }
    if (typeof loader !== 'function') {
      throw invalid('loader must be a function', 'loader', 'type', { expected: 'function' });
    }
    const loc = normalizeLocale(tag);
    const inFlight = pending.get(loc);
    if (inFlight && inFlight.loader === loader) return inFlight.promise;
    /** @type {Promise<unknown>} */
    let started;
    try {
      started = Promise.resolve(loader(loc));
    } catch (e) {
      started = Promise.reject(e);
    }
    const promise = started
      .then((loaded) => {
        const bundle = extractBundle(loaded, loc);
        if (!bundle) {
          throw invalid(`loader for '${loc}' did not return a messages object`, 'loader', 'type', {
            expected: 'object',
          });
        }
        addMessages(loc, /** @type {Messages} */ (bundle));
      })
      .catch((e) => {
        if (pending.get(loc)?.promise === promise) pending.delete(loc);
        throw wrap(e, {
          code: 'I18N_LOAD_FAILED',
          message: `Failed to load messages for '${loc}'`,
        });
      });
    pending.set(loc, { loader, promise });
    return promise;
  }

  /** @type {I18n['formatList']} */
  function formatList(items, opts = {}) {
    if (!Array.isArray(items)) {
      throw invalid('items must be an array', 'items', 'type', { expected: 'array' });
    }
    const strings = items.map((x) => (typeof x === 'string' ? x : String(x)));
    const type = opts && opts.type ? opts.type : 'conjunction';
    const style = opts && opts.style ? opts.style : 'long';
    if (typeof Intl !== 'undefined' && typeof Intl.ListFormat === 'function') {
      const lf = memo(listFormats, `${locale}|${type}|${style}`, () =>
        withLocaleFallback(locale, (tag) => new Intl.ListFormat(tag, { type, style }))
      );
      return lf.format(strings);
    }
    if (strings.length <= 1) return strings.join('');
    const word = type === 'disjunction' ? 'or' : 'and';
    if (type === 'unit') return strings.join(', ');
    if (strings.length === 2) return `${strings[0]} ${word} ${strings[1]}`;
    return `${strings.slice(0, -1).join(', ')}, ${word} ${strings[strings.length - 1]}`;
  }

  /** @type {I18n['formatNumber']} */
  function formatNumber(n, opts) {
    const value = toNumeric(n);
    if (value === undefined) {
      throw invalid('value must be a finite number', 'n', 'type', { expected: 'number' });
    }
    return fmtNumber(value, locale, opts && isPlainObject(opts) ? opts : undefined);
  }

  /** @type {I18n['formatPercent']} */
  function formatPercent(n, opts) {
    return formatNumber(n, { style: 'percent', ...(opts && isPlainObject(opts) ? opts : {}) });
  }

  /** @type {I18n['onChange']} */
  function onChange(fn) {
    if (typeof fn !== 'function') {
      throw invalid('listener must be a function', 'fn', 'type', { expected: 'function' });
    }
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  /** @type {I18n['missing']} */
  function missing() {
    return Array.from(missingKeys);
  }

  /** @type {I18n['locales']} */
  function locales() {
    return Array.from(bundles.keys()).sort();
  }

  /** @type {I18n['destroy']} */
  function destroy() {
    listeners.clear();
    pending.clear();
    missingKeys.clear();
    lookupCache.clear();
    astCache.clear();
    chainCache.clear();
    numberFormats.clear();
    pluralRules.clear();
    listFormats.clear();
    dateFormats.clear();
  }

  return {
    t,
    setLocale,
    getLocale,
    dir,
    addMessages,
    hasKey,
    loadMessages,
    formatList,
    formatNumber,
    formatPercent,
    onChange,
    missing,
    locales,
    destroy,
  };
}

/**
 * The messages object inside a loader result: a plain bundle, a `{ default }` module, a module
 * namespace with an export named after the locale (`en-IN`, `en_IN`, `en`), or a namespace with a
 * single object export. `undefined` when nothing fits.
 * @param {unknown} loaded @param {string} loc
 * @returns {Messages|undefined}
 */
function extractBundle(loaded, loc) {
  if (loaded === null || typeof loaded !== 'object') return undefined;
  const obj = /** @type {Record<string, unknown>} */ (loaded);
  if (isPlainObject(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === 'default' && isPlainObject(obj.default)) {
      return /** @type {Messages} */ (obj.default);
    }
    return /** @type {Messages} */ (obj);
  }
  if (isPlainObject(obj.default)) return /** @type {Messages} */ (obj.default);
  const names = [loc, loc.replace(/-/g, '_'), loc.split('-')[0]];
  for (const name of names) {
    if (isPlainObject(obj[name])) return /** @type {Messages} */ (obj[name]);
  }
  const objectExports = Object.keys(obj).filter((k) => isPlainObject(obj[k]));
  if (objectExports.length === 1) return /** @type {Messages} */ (obj[objectExports[0]]);
  return undefined;
}

/**
 * Finite number (or bigint) from a number, bigint or numeric string; `undefined` otherwise.
 * @param {unknown} v
 * @returns {number|bigint|undefined}
 */
function toNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
