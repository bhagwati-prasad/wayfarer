/**
 * Display formatters for the Wayfarer SDK (docs/api/03-utils.md §3): places and routes
 * (`Delhi (DEL)`, `DEL → BOM → DEL`), stops and layovers (`1 stop`, `2h 10m in DXB`), passenger
 * summaries (`2 adults, 1 child`), flight numbers and operating‑carrier notes (`AI 101`,
 * `Operated by Vistara`), cabin / fare‑type / passenger‑type labels, baggage rules (`1 × 23 kg`),
 * traveller names and initials, PII‑safe masks and small string helpers (`formatReference`,
 * `formatSeat`, `titleCase`, `truncate`). Every function that produces translatable copy takes an
 * optional `t` (`i18n.t`, or the `I18n` instance itself) and renders built‑in English when it is
 * omitted; the keys used are the `common.*` entries of `messages/en.js` and each call passes the
 * English pattern as `default`, so a host bundle missing a key still renders, and a `t` that answers
 * with the key itself falls back to English too. Everything here is pure and SSR‑safe: no I/O, no DOM,
 * no timers, no module‑level mutable state, no logging. Invalid arguments throw `ValidationError`
 * (never a plain `Error`), and the `mask*` helpers never reveal more than documented — e‑mail: first
 * character + `***` + domain; phone: the last 2–4 digits; card: brand + `••••` + last 4 (a full PAN
 * is reduced to its last 4 digits first); document: the last 3 characters (fewer for short numbers).
 */

import { ValidationError } from '../errors/index.js';
import { durationBetween, formatDuration } from './datetime.js';

/** @typedef {import('../types.js').Place} Place */
/** @typedef {import('../types.js').Slice} Slice */
/** @typedef {import('../types.js').SliceRequest} SliceRequest */
/** @typedef {import('../types.js').SearchParams} SearchParams */
/** @typedef {import('../types.js').Segment} Segment */
/** @typedef {import('../types.js').Layover} Layover */
/** @typedef {import('../types.js').Airline} Airline */
/** @typedef {import('../types.js').PaxCounts} PaxCounts */
/** @typedef {import('../types.js').PaxType} PaxType */
/** @typedef {import('../types.js').CabinClass} CabinClass */
/** @typedef {import('../types.js').FareType} FareType */
/** @typedef {import('../types.js').BagRule} BagRule */
/** @typedef {import('../types.js').Traveler} Traveler */
/** @typedef {import('../types.js').Phone} Phone */
/** @typedef {import('../types.js').Seat} Seat */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/**
 * Translation function as returned by `createI18n().t` (`i18n.t(key, vars?, { count?, default? })`).
 * @typedef {(key: string, vars?: Record<string, unknown>, opts?: { count?: number, default?: string }) => string} TranslateFn
 */
/**
 * What the `t` parameter accepts: the translate function, an object exposing one (an `I18n`
 * instance), or nothing (built‑in English).
 * @typedef {TranslateFn | { t: TranslateFn } | null | undefined} Translator
 */
/** @typedef {'code'|'city'|'city_code'|'airport'|'full'} PlaceStyle */
/** @typedef {'given_first'|'family_first'} NameOrder */
/** @typedef {Place | string} PlaceLike  A `Place` or a bare IATA code. */
/** @typedef {{ origin: PlaceLike, destination: PlaceLike }} SliceLike  A `Slice` or a `SliceRequest`. */
/** @typedef {SliceLike[] | { slices: SliceLike[] } | { params: { slices: SliceLike[] } } | SliceLike} RouteInput */

/**
 * @typedef {Object} RouteOptions
 * @property {string} [arrow='→']        Separator between consecutive places (always padded with spaces).
 * @property {PlaceStyle} [style='code']  How each place is rendered (`Place` inputs only; codes stay codes).
 */

/**
 * @typedef {Object} NameOptions
 * @property {NameOrder} [order='given_first']  `Rahul Sharma` or `Sharma Rahul`.
 * @property {boolean} [middle=true]            Include the middle name.
 * @property {boolean} [title=false]            Prefix the title (`Mr Rahul Sharma`).
 */

// ── English fallback copy (ICU‑lite patterns, mirrors messages/en.js common.*) ──────────────────

/** @type {Readonly<Record<string, string>>} */
const EN = Object.freeze({
  'common.stops.count': '{count, plural, =0{Non-stop} one{# stop} other{# stops}}',
  // docs/api/03-utils.md §3 renders a layover as `2h 10m in DXB`; the en bundle says "… layover in …".
  'common.layover': '{duration} in {airport}',
  'common.operatedBy': 'Operated by {airline}',
  'common.paxCount.ADT': '{count, plural, one{# adult} other{# adults}}',
  'common.paxCount.CHD': '{count, plural, one{# child} other{# children}}',
  'common.paxCount.INF': '{count, plural, one{# infant} other{# infants}}',
  'common.paxCount.INS': '{count, plural, one{# infant with seat} other{# infants with seats}}',
  'common.paxCount.YTH': '{count, plural, one{# youth} other{# youths}}',
  'common.paxCount.SRC': '{count, plural, one{# senior} other{# seniors}}',
  'common.paxCount.STU': '{count, plural, one{# student} other{# students}}',
  'common.cabins.economy': 'Economy',
  'common.cabins.premium_economy': 'Premium economy',
  'common.cabins.business': 'Business',
  'common.cabins.first': 'First',
  'common.cabins.mixed': 'Mixed cabins',
  'common.paxTypes.ADT': 'Adult',
  'common.paxTypes.CHD': 'Child',
  'common.paxTypes.INF': 'Infant (on lap)',
  'common.paxTypes.INS': 'Infant (with seat)',
  'common.paxTypes.YTH': 'Youth',
  'common.paxTypes.SRC': 'Senior',
  'common.paxTypes.STU': 'Student',
  'common.fareTypes.regular': 'Regular',
  'common.fareTypes.student': 'Student',
  'common.fareTypes.senior': 'Senior citizen',
  'common.fareTypes.armed_forces': 'Armed forces',
  'common.fareTypes.doctor': 'Doctors and nurses',
  'common.fareTypes.corporate': 'Corporate',
  'common.fareTypes.youth': 'Youth',
  'common.baggage.pieces': '{count, plural, one{# piece} other{# pieces}}',
  'common.baggage.weight': '{kg} kg',
  'common.baggage.included': 'Included',
  'common.baggage.notIncluded': 'Not included',
});

/**
 * Card brand codes (as `utils/validation.cardBrand` / gateways report them) → display labels.
 * @type {Readonly<Record<string, string>>}
 */
const CARD_BRANDS = Object.freeze({
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  rupay: 'RuPay',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  maestro: 'Maestro',
  unionpay: 'UnionPay',
});

/** `PaxCounts` field → passenger type, in display order. */
const PAX_FIELDS = Object.freeze([
  ['adults', 'ADT'],
  ['children', 'CHD'],
  ['infants', 'INF'],
  ['infantsSeated', 'INS'],
  ['youth', 'YTH'],
  ['seniors', 'SRC'],
]);

const PLACE_STYLES = new Set(['code', 'city', 'city_code', 'airport', 'full']);
const NAME_ORDERS = new Set(['given_first', 'family_first']);
const BULLET = '•';
const PLURAL_RE =
  /\{(\w+),\s*plural,\s*((?:(?:=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\}\s*)+)\}/g;
const PLURAL_OPTION_RE = /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g;

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} fn Name of the public function (prefixes the message).
 * @param {string} message @param {string} path @param {string} code @param {object} [params]
 * @returns {ValidationError}
 */
function invalid(fn, message, path, code, params) {
  /** @type {ValidationIssue} */
  const issue = { path, code, message };
  if (params) issue.params = params;
  return new ValidationError(`${fn}: ${message}`, { issues: [issue] });
}

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {Record<string, any>} */
function opts(v) {
  return isObject(v) ? v : {};
}

/** Trimmed, whitespace‑collapsed string; `''` for anything that is not a string. @param {unknown} v */
function clean(v) {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

/** First code point of a string (surrogate‑pair safe). @param {string} s @returns {string} */
function firstChar(s) {
  const [c] = Array.from(s);
  return c === undefined ? '' : c;
}

/** `premium_economy` → `Premium economy`. @param {string} s @returns {string} */
function humanize(s) {
  const text = s.toLowerCase().replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  return text ? firstChar(text).toUpperCase() + text.slice(firstChar(text).length) : '';
}

/**
 * Normalise the `t` argument: a function, an object with a `t` function (an `I18n`), or nothing.
 * @param {string} fn @param {unknown} t @returns {TranslateFn | null}
 */
function resolveT(fn, t) {
  if (t === undefined || t === null) return null;
  if (typeof t === 'function') return /** @type {TranslateFn} */ (t);
  if (isObject(t) && typeof t.t === 'function') {
    return (key, vars, o) => /** @type {{ t: TranslateFn }} */ (t).t(key, vars, o);
  }
  throw invalid(fn, 'Expected t to be a translate function (i18n.t)', 't', 'type', {
    expected: 'function',
  });
}

/**
 * Render one of the `EN` patterns: `{name}` interpolation and `{count, plural, =0{…} one{…} other{…}}`
 * with `#` for the number (English plural rule: exact match, then `one` for 1, else `other`).
 * @param {string} pattern @param {Record<string, unknown>} [vars] @returns {string}
 */
function renderEnglish(pattern, vars = {}) {
  const withPlurals = pattern.replace(PLURAL_RE, (_m, name, body) => {
    const n = Number(vars[name]);
    /** @type {Record<string, string>} */
    const options = {};
    for (const match of body.matchAll(PLURAL_OPTION_RE)) options[match[1]] = match[2];
    const exact = options[`=${n}`];
    const text =
      exact !== undefined
        ? exact
        : n === 1 && options.one !== undefined
          ? options.one
          : options.other;
    return (text === undefined ? '' : text).replace(/#/g, String(n));
  });
  return withPlurals.replace(/\{(\w+)\}/g, (_m, name) => {
    const v = vars[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Translate `key` through `t` (passing the English pattern as `default`), falling back to the
 * built‑in English when `t` is absent, answers with the key itself (missing key) or returns a
 * non‑string. Keys outside `EN` fall back to `fallback`.
 * @param {TranslateFn | null} t @param {string} key @param {Record<string, unknown>} vars
 * @param {string} [fallback]
 * @returns {string}
 */
function tr(t, key, vars, fallback) {
  const pattern = EN[key];
  if (t) {
    const out = t(key, vars, pattern === undefined ? undefined : { default: pattern });
    if (typeof out === 'string' && out !== key) return out;
  }
  if (pattern !== undefined) return renderEnglish(pattern, vars);
  return fallback === undefined ? '' : fallback;
}

/**
 * Accept a `Place` or a bare IATA code.
 * @param {string} fn @param {unknown} p @param {string} path @returns {Place}
 */
function toPlace(fn, p, path) {
  if (typeof p === 'string' && p.trim() !== '') {
    return /** @type {Place} */ ({ code: p.trim().toUpperCase() });
  }
  if (isObject(p) && typeof p.code === 'string' && p.code.trim() !== '') {
    return /** @type {Place} */ (p);
  }
  throw invalid(fn, `Expected ${path} to be a Place or an IATA code`, path, 'type', {
    expected: 'Place',
  });
}

/** IATA code of a `PlaceLike`, or `''`. @param {unknown} p @returns {string} */
function codeOf(p) {
  if (typeof p === 'string') return p.trim().toUpperCase();
  if (isObject(p) && typeof p.code === 'string') return p.code.trim().toUpperCase();
  return '';
}

/** Airline code of an `Airline` or a bare code, or `''`. @param {unknown} a @returns {string} */
function airlineCode(a) {
  if (typeof a === 'string') return a.trim().toUpperCase();
  if (isObject(a) && typeof a.code === 'string') return a.code.trim().toUpperCase();
  return '';
}

/** Airline display name, or `''`. @param {unknown} a @returns {string} */
function airlineName(a) {
  return isObject(a) ? clean(a.name) : '';
}

/**
 * Unwrap whatever carries slices: an array, `{ slices }` (SearchParams / Offer / Itinerary‑like),
 * `{ params: { slices } }` (SearchSession‑like) or a single slice‑like object.
 * @param {string} fn @param {unknown} input @returns {unknown[]}
 */
function toSlices(fn, input) {
  if (Array.isArray(input)) return input;
  if (isObject(input)) {
    if (Array.isArray(input.slices)) return input.slices;
    if (isObject(input.params) && Array.isArray(input.params.slices)) return input.params.slices;
    if (input.origin !== undefined && input.destination !== undefined) return [input];
  }
  throw invalid(
    fn,
    'Expected slices (Slice[] / SliceRequest[]) or an object carrying them (SearchParams)',
    'slices',
    'type',
    { expected: 'array' }
  );
}

/**
 * Layovers of a slice: the `layovers` array itself, a slice's `layovers`, or layovers derived from
 * consecutive `segments` when the slice has none.
 * @param {string} fn @param {unknown} slice @returns {Layover[]}
 */
function toLayovers(fn, slice) {
  if (Array.isArray(slice)) return /** @type {Layover[]} */ (slice);
  if (isObject(slice)) {
    if (Array.isArray(slice.layovers)) return slice.layovers;
    if (Array.isArray(slice.segments)) {
      /** @type {Layover[]} */
      const derived = [];
      for (let i = 1; i < slice.segments.length; i += 1) {
        const prev = slice.segments[i - 1];
        const next = slice.segments[i];
        if (!isObject(prev) || !isObject(next)) {
          throw invalid(
            fn,
            `Expected slice.segments[${i}] to be a Segment`,
            `slice.segments[${i}]`,
            'type',
            {
              expected: 'Segment',
            }
          );
        }
        derived.push({
          airport: prev.destination,
          durationMinutes: durationBetween(prev.arrivalAt, next.departureAt),
          overnight: false,
          selfTransfer: false,
          airportChange: codeOf(prev.destination) !== codeOf(next.origin),
        });
      }
      return derived;
    }
  }
  throw invalid(fn, 'Expected slice to be a Slice (with layovers or segments)', 'slice', 'type', {
    expected: 'Slice',
  });
}

/**
 * Number of stops of a slice‑like object (`stops`, else `segments.length - 1`, else `layovers.length`).
 * @param {Record<string, any>} slice @returns {unknown}
 */
function stopsOf(slice) {
  if (slice.stops !== undefined) return slice.stops;
  if (Array.isArray(slice.segments)) return Math.max(0, slice.segments.length - 1);
  if (Array.isArray(slice.layovers)) return slice.layovers.length;
  return undefined;
}

/**
 * Label for a domain enumeration value (`common.<group>.<value>`); unknown values are humanised
 * (`premium_plus` → `Premium plus`) unless the host bundle knows them.
 * @param {string} fn @param {unknown} value @param {Translator} t @param {string} group @param {string} path
 * @returns {string}
 */
function enumLabel(fn, value, t, group, path) {
  const translate = resolveT(fn, t);
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(fn, `Expected ${path} to be a non-empty string`, path, 'type', {
      expected: 'string',
    });
  }
  const v = value.trim();
  return tr(translate, `common.${group}.${v}`, {}, humanize(v));
}

/**
 * Mask every character but the last `visible` ones with bullets. `visible` is capped at `max` and at
 * half the length, so short values never show more than half of themselves.
 * @param {string[]} chars @param {number} max @returns {string}
 */
function maskTail(chars, max) {
  const visible = Math.min(max, Math.floor(chars.length / 2));
  return BULLET.repeat(chars.length - visible) + chars.slice(chars.length - visible).join('');
}

/**
 * Optional string argument: `null` / `undefined` → `''`, strings trimmed, anything else rejected.
 * @param {string} fn @param {unknown} v @param {string} path @returns {string}
 */
function optionalString(fn, v, path) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  throw invalid(fn, `Expected ${path} to be a string`, path, 'type', { expected: 'string' });
}

// ── places & routes ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a place: `code` → `DEL`, `city` → `Delhi`, `city_code` (default) → `Delhi (DEL)`, `airport`
 * → `Indira Gandhi International Airport`, `full` → `Indira Gandhi International Airport (DEL), Delhi,
 * India`. Missing fields fall back (`city` ↔ `name`, then the code); a bare IATA code is accepted and
 * renders as the code in every style.
 * @param {Place | string} p
 * @param {PlaceStyle} [style='city_code']
 * @returns {string}
 * @throws {ValidationError} when `p` has no code or `style` is unknown
 */
export function formatPlace(p, style = 'city_code') {
  const place = toPlace('formatPlace', p, 'p');
  if (!PLACE_STYLES.has(style)) {
    throw invalid(
      'formatPlace',
      "Expected style to be 'code', 'city', 'city_code', 'airport' or 'full'",
      'style',
      'invalid_style',
      { value: style }
    );
  }
  const code = place.code.trim().toUpperCase();
  const city = clean(place.city) || clean(place.name);
  const name = clean(place.name) || clean(place.city);
  switch (style) {
    case 'code':
      return code;
    case 'city':
      return city || code;
    case 'city_code':
      return city ? `${city} (${code})` : code;
    case 'airport':
      return name || code;
    default: {
      const parts = [name ? `${name} (${code})` : code];
      if (city && city !== name) parts.push(city);
      const country = clean(place.country);
      if (country) parts.push(country);
      return parts.join(', ');
    }
  }
}

/**
 * Render a route as a chain of codes: `DEL → BOM → DEL`. Accepts `Slice[]` (places), `SliceRequest[]`
 * (codes), anything carrying `slices` (`SearchParams`, an `Offer`) or `params.slices` (a search
 * session), or one slice‑like object. Consecutive slices that connect share the junction code; an
 * open jaw starts a new chain after a comma (`DEL → BOM, BLR → DEL`). `arrow` is placed between
 * places with a space on each side; `style` renders `Place` objects through `formatPlace`.
 * @param {RouteInput | SearchParams} input
 * @param {RouteOptions} [options]
 * @returns {string} `''` for an empty slice list
 * @throws {ValidationError} for input that carries no slices, a slice without origin / destination,
 *   or an invalid `arrow` / `style`
 */
export function formatRoute(input, options = {}) {
  const fn = 'formatRoute';
  const o = opts(options);
  const arrow = o.arrow === undefined ? '→' : o.arrow;
  if (typeof arrow !== 'string') {
    throw invalid(fn, 'Expected arrow to be a string', 'arrow', 'type', { expected: 'string' });
  }
  const style = o.style === undefined ? 'code' : o.style;
  if (!PLACE_STYLES.has(style)) {
    throw invalid(fn, 'Expected style to be a formatPlace style', 'style', 'invalid_style', {
      value: style,
    });
  }
  const slices = toSlices(fn, input);
  const separator = ` ${arrow} `;
  /** @type {string[][]} */
  const chains = [];
  /** @type {string[]} */
  let chain = [];
  let previousDestination = '';
  slices.forEach((slice, i) => {
    if (!isObject(slice)) {
      throw invalid(fn, `Expected slices[${i}] to be a slice`, `slices[${i}]`, 'type', {
        expected: 'Slice',
      });
    }
    const origin = toPlace(fn, slice.origin, `slices[${i}].origin`);
    const destination = toPlace(fn, slice.destination, `slices[${i}].destination`);
    if (chain.length === 0) {
      chain.push(formatPlace(origin, style));
    } else if (codeOf(origin) !== previousDestination) {
      chains.push(chain);
      chain = [formatPlace(origin, style)];
    }
    chain.push(formatPlace(destination, style));
    previousDestination = codeOf(destination);
  });
  if (chain.length) chains.push(chain);
  return chains.map((c) => c.join(separator)).join(', ');
}

// ── stops, layovers, passengers ─────────────────────────────────────────────────────────────────

/**
 * `Non-stop` / `1 stop` / `2 stops` (`common.stops.count`). A slice‑like object is accepted in place
 * of the number (its `stops`, else `segments.length - 1`).
 * @param {number | Slice} n
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} when `n` is not a non‑negative integer or `t` is not a function
 */
export function formatStops(n, t) {
  const fn = 'formatStops';
  const translate = resolveT(fn, t);
  const count = isObject(n) ? stopsOf(n) : n;
  if (!Number.isInteger(count) || /** @type {number} */ (count) < 0) {
    throw invalid(fn, 'Expected n to be a non-negative integer', 'n', 'invalid_count', {
      value: n,
    });
  }
  return tr(translate, 'common.stops.count', { count });
}

/**
 * List each layover as duration + airport code — `2h 10m in DXB`, several joined by `, ` — so a UI
 * can compose `1 stop · 2h 10m in DXB`. With `t` the copy is `common.layover` (`{duration}`,
 * `{airport}`), the duration is `formatDuration(minutes)`. A slice without `layovers` has them derived
 * from consecutive `segments`; a bare `Layover[]` is accepted too. Non‑stop → `''`.
 * @param {Slice | Layover[]} slice
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} for a slice without layovers / segments, a layover without an airport or
 *   a finite non‑negative duration, or a `t` that is not a function
 */
export function formatLayovers(slice, t) {
  const fn = 'formatLayovers';
  const translate = resolveT(fn, t);
  const layovers = toLayovers(fn, slice);
  return layovers
    .map((layover, i) => {
      const path = `layovers[${i}]`;
      if (!isObject(layover)) {
        throw invalid(fn, `Expected ${path} to be a Layover`, path, 'type', {
          expected: 'Layover',
        });
      }
      const airport = codeOf(layover.airport);
      if (!airport) {
        throw invalid(
          fn,
          `Expected ${path}.airport to be a Place or an IATA code`,
          `${path}.airport`,
          'type',
          {
            expected: 'Place',
          }
        );
      }
      const minutes = layover.durationMinutes;
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
        throw invalid(
          fn,
          `Expected ${path}.durationMinutes to be a non-negative number`,
          `${path}.durationMinutes`,
          'invalid_duration',
          { value: minutes }
        );
      }
      return tr(translate, 'common.layover', { duration: formatDuration(minutes), airport });
    })
    .join(', ');
}

/**
 * `2 adults, 1 child` — one phrase per non‑zero passenger count (`common.paxCount.<type>`), in the
 * order adults, children, infants, seated infants, youth, seniors. All zero → `''`.
 * @param {PaxCounts} pax
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} when `pax` is not an object, a count is not a non‑negative integer, or
 *   `t` is not a function
 */
export function formatPaxSummary(pax, t) {
  const fn = 'formatPaxSummary';
  const translate = resolveT(fn, t);
  if (!isObject(pax)) {
    throw invalid(fn, 'Expected pax to be a PaxCounts object', 'pax', 'type', {
      expected: 'object',
    });
  }
  const counts = /** @type {Record<string, unknown>} */ (pax);
  /** @type {string[]} */
  const parts = [];
  for (const [field, type] of PAX_FIELDS) {
    const count = /** @type {number} */ (counts[field]);
    if (count === undefined || count === null) continue;
    if (!Number.isInteger(count) || count < 0) {
      throw invalid(
        fn,
        `Expected pax.${field} to be a non-negative integer`,
        `pax.${field}`,
        'invalid_count',
        {
          value: count,
        }
      );
    }
    if (count > 0) parts.push(tr(translate, `common.paxCount.${type}`, { count }));
  }
  return parts.join(', ');
}

// ── flights ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `AI 101`: marketing carrier code + flight number. A flight number that already carries the carrier
 * prefix (`AI101`, `AI 101`) is normalised; without a marketing carrier the number is returned alone.
 * @param {Segment} seg
 * @returns {string}
 * @throws {ValidationError} when `seg` is not an object or has no `flightNumber`
 */
export function formatFlightNumber(seg) {
  const fn = 'formatFlightNumber';
  if (!isObject(seg)) {
    throw invalid(fn, 'Expected seg to be a Segment', 'seg', 'type', { expected: 'object' });
  }
  const raw = seg.flightNumber;
  if (!(typeof raw === 'string' || typeof raw === 'number')) {
    throw invalid(fn, 'Expected seg.flightNumber to be a string', 'seg.flightNumber', 'type', {
      expected: 'string',
    });
  }
  let number = String(raw).trim().toUpperCase();
  const code = airlineCode(seg.marketingCarrier);
  if (!code) return number;
  if (number.startsWith(code)) number = number.slice(code.length).trim();
  return number ? `${code} ${number}` : code;
}

/**
 * `Operated by Vistara` when the operating carrier differs from the marketing carrier, else `null`
 * (also `null` when either carrier is unknown). With `t`: `common.operatedBy` (`{airline}`).
 * @param {Segment} seg
 * @param {Translator} [t]
 * @returns {string | null}
 * @throws {ValidationError} when `seg` is not an object or `t` is not a function
 */
export function formatOperatedBy(seg, t) {
  const fn = 'formatOperatedBy';
  const translate = resolveT(fn, t);
  if (!isObject(seg)) {
    throw invalid(fn, 'Expected seg to be a Segment', 'seg', 'type', { expected: 'object' });
  }
  const operating = seg.operatingCarrier;
  const marketing = seg.marketingCarrier;
  const opCode = airlineCode(operating);
  const opName = airlineName(operating);
  const mkCode = airlineCode(marketing);
  const mkName = airlineName(marketing);
  if (!opCode && !opName) return null;
  if (!mkCode && !mkName) return null;
  const same = opCode && mkCode ? opCode === mkCode : opName.toLowerCase() === mkName.toLowerCase();
  if (same) return null;
  return tr(translate, 'common.operatedBy', { airline: opName || opCode });
}

// ── enumerations ────────────────────────────────────────────────────────────────────────────────

/**
 * Cabin label: `economy` → `Economy`, `premium_economy` → `Premium economy`, … (`common.cabins.*`,
 * `mixed` included). Unknown values are humanised.
 * @param {CabinClass | 'mixed' | string} cabin
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} when `cabin` is not a non‑empty string or `t` is not a function
 */
export function formatCabin(cabin, t) {
  return enumLabel('formatCabin', cabin, t, 'cabins', 'cabin');
}

/**
 * Fare type label: `senior` → `Senior citizen`, `armed_forces` → `Armed forces`, … (`common.fareTypes.*`).
 * @param {FareType | string} ft
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} when `ft` is not a non‑empty string or `t` is not a function
 */
export function formatFareType(ft, t) {
  return enumLabel('formatFareType', ft, t, 'fareTypes', 'ft');
}

/**
 * Passenger type label: `ADT` → `Adult`, `INF` → `Infant (on lap)`, … (`common.paxTypes.*`).
 * @param {PaxType | string} pt
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} when `pt` is not a non‑empty string or `t` is not a function
 */
export function formatPaxType(pt, t) {
  return enumLabel('formatPaxType', pt, t, 'paxTypes', 'pt');
}

// ── baggage ─────────────────────────────────────────────────────────────────────────────────────

/**
 * One baggage rule: `1 × 23 kg` (pieces and weight), `2 pieces`, `23 kg`, else `Included` /
 * `Not included` (`common.baggage.*`). A `BagRule[]` is joined with `, `; an empty list is
 * `Not included`.
 * @param {BagRule | BagRule[]} rule
 * @param {Translator} [t]
 * @returns {string}
 * @throws {ValidationError} when a rule is not an object, its `quantity` / `weightKg` are not
 *   non‑negative numbers, or `t` is not a function
 */
export function formatBaggage(rule, t) {
  const fn = 'formatBaggage';
  const translate = resolveT(fn, t);
  if (Array.isArray(rule)) {
    if (rule.length === 0) return tr(translate, 'common.baggage.notIncluded', {});
    return rule.map((r, i) => formatBagRule(fn, r, translate, `rule[${i}]`)).join(', ');
  }
  return formatBagRule(fn, rule, translate, 'rule');
}

/**
 * @param {string} fn @param {unknown} rule @param {TranslateFn | null} t @param {string} path
 * @returns {string}
 */
function formatBagRule(fn, rule, t, path) {
  if (!isObject(rule)) {
    throw invalid(fn, `Expected ${path} to be a BagRule`, path, 'type', { expected: 'object' });
  }
  const { quantity, weightKg } = rule;
  if (
    quantity !== undefined &&
    quantity !== null &&
    (!Number.isInteger(quantity) || quantity < 0)
  ) {
    throw invalid(
      fn,
      `Expected ${path}.quantity to be a non-negative integer`,
      `${path}.quantity`,
      'invalid_count',
      {
        value: quantity,
      }
    );
  }
  if (
    weightKg !== undefined &&
    weightKg !== null &&
    (typeof weightKg !== 'number' || !Number.isFinite(weightKg) || weightKg < 0)
  ) {
    throw invalid(
      fn,
      `Expected ${path}.weightKg to be a non-negative number`,
      `${path}.weightKg`,
      'invalid_weight',
      {
        value: weightKg,
      }
    );
  }
  const hasQuantity = Number.isInteger(quantity) && /** @type {number} */ (quantity) > 0;
  const hasWeight = typeof weightKg === 'number' && weightKg > 0;
  if (hasQuantity && hasWeight) {
    return `${quantity} × ${tr(t, 'common.baggage.weight', { kg: weightKg })}`;
  }
  if (hasQuantity) return tr(t, 'common.baggage.pieces', { count: quantity });
  if (hasWeight) return tr(t, 'common.baggage.weight', { kg: weightKg });
  if (quantity === 0 || rule.included !== true) return tr(t, 'common.baggage.notIncluded', {});
  return tr(t, 'common.baggage.included', {});
}

// ── names ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Display name of a traveller: `Rahul Kumar Sharma` (`given_first`, default) or `Sharma Rahul Kumar`
 * (`family_first`). Whitespace is trimmed and collapsed, missing parts are skipped; `middle: false`
 * drops the middle name and `title: true` prefixes the title.
 * @param {Traveler | { firstName?: string, middleName?: string, lastName?: string, title?: string }} traveler
 * @param {NameOptions} [options]
 * @returns {string}
 * @throws {ValidationError} when `traveler` is not an object or `order` is unknown
 */
export function formatName(traveler, options = {}) {
  const fn = 'formatName';
  if (!isObject(traveler)) {
    throw invalid(fn, 'Expected traveler to be an object', 'traveler', 'type', {
      expected: 'object',
    });
  }
  const o = opts(options);
  const order = o.order === undefined ? 'given_first' : o.order;
  if (!NAME_ORDERS.has(order)) {
    throw invalid(
      fn,
      "Expected order to be 'given_first' or 'family_first'",
      'order',
      'invalid_order',
      {
        value: o.order,
      }
    );
  }
  const given = [clean(traveler.firstName)];
  if (o.middle !== false) given.push(clean(traveler.middleName));
  const family = clean(traveler.lastName);
  const parts = order === 'given_first' ? [...given, family] : [family, ...given];
  if (o.title === true) parts.unshift(clean(traveler.title));
  return parts.filter(Boolean).join(' ');
}

/**
 * Upper‑case initials of first and last name (`RS`); one letter when only one name is known, `''`
 * when none.
 * @param {Traveler | { firstName?: string, lastName?: string }} traveler
 * @returns {string}
 * @throws {ValidationError} when `traveler` is not an object
 */
export function initials(traveler) {
  if (!isObject(traveler)) {
    throw invalid('initials', 'Expected traveler to be an object', 'traveler', 'type', {
      expected: 'object',
    });
  }
  return [clean(traveler.firstName), clean(traveler.lastName)]
    .filter(Boolean)
    .map((part) => firstChar(part).toUpperCase())
    .join('');
}

// ── PII‑safe masks ──────────────────────────────────────────────────────────────────────────────

/**
 * `r***@example.com`: first character of the local part + `***` + the domain. A value without `@`
 * keeps only its first character (`r***`); `null` / `undefined` / `''` → `''`.
 * @param {string | null | undefined} e
 * @returns {string}
 * @throws {ValidationError} when `e` is not a string
 */
export function maskEmail(e) {
  const s = optionalString('maskEmail', e, 'e');
  if (s === '') return '';
  const at = s.lastIndexOf('@');
  if (at < 0) return `${firstChar(s)}***`;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return `${firstChar(local)}***@${domain}`;
}

/**
 * Mask a phone number, keeping only its last 2–4 digits (4 for 8+ digits, never more than half):
 * `{ countryCode: '91', number: '9876543210' }` → `+91 ••••••3210`; a string keeps a leading `+` and
 * masks everything but the tail (`+••••••••3210`). Formatting characters are dropped; no digits →
 * `''`.
 * @param {Phone | string | null | undefined} p
 * @returns {string}
 * @throws {ValidationError} when `p` is neither a string nor a `Phone` object
 */
export function maskPhone(p) {
  const fn = 'maskPhone';
  if (p === undefined || p === null) return '';
  if (typeof p === 'string') {
    const digits = p.replace(/\D/g, '');
    if (!digits) return '';
    return (p.trim().startsWith('+') ? '+' : '') + maskTail(digits.split(''), 4);
  }
  if (!isObject(p)) {
    throw invalid(fn, 'Expected p to be a Phone object or a string', 'p', 'type', {
      expected: 'Phone',
    });
  }
  const number = p.number;
  if (
    number !== undefined &&
    number !== null &&
    typeof number !== 'string' &&
    typeof number !== 'number'
  ) {
    throw invalid(fn, 'Expected p.number to be a string', 'p.number', 'type', {
      expected: 'string',
    });
  }
  const digits = number === undefined || number === null ? '' : String(number).replace(/\D/g, '');
  if (!digits) return '';
  const cc =
    typeof p.countryCode === 'string' || typeof p.countryCode === 'number'
      ? String(p.countryCode).replace(/\D/g, '')
      : '';
  const masked = maskTail(digits.split(''), 4);
  return cc ? `+${cc} ${masked}` : masked;
}

/**
 * `Visa •••• 4242`: brand label + `••••` + last 4 digits. Whatever is passed as `last4` is reduced
 * to its last four digits first, so a full PAN never leaks; an unknown or missing brand drops the
 * label (`•••• 4242`). A `SavedMethod`‑like `{ brand, last4 }` object is accepted as first argument.
 * @param {string | number | { brand?: string, last4?: string } | null | undefined} last4
 * @param {string} [brand]  `visa`, `mastercard`, `amex`, `rupay`, `discover`, `diners`, `jcb`, …
 * @returns {string}
 * @throws {ValidationError} when `last4` / `brand` have the wrong type
 */
export function maskCard(last4, brand) {
  const fn = 'maskCard';
  let tail = last4;
  let b = brand;
  if (isObject(last4)) {
    tail = last4.last4;
    if (b === undefined) b = last4.brand;
  }
  if (tail !== undefined && tail !== null && typeof tail !== 'string' && typeof tail !== 'number') {
    throw invalid(fn, 'Expected last4 to be a string', 'last4', 'type', { expected: 'string' });
  }
  if (b !== undefined && b !== null && typeof b !== 'string') {
    throw invalid(fn, 'Expected brand to be a string', 'brand', 'type', { expected: 'string' });
  }
  const digits =
    tail === undefined || tail === null ? '' : String(tail).replace(/\D/g, '').slice(-4);
  const key = clean(b).toLowerCase();
  const label = key === '' || key === 'unknown' ? '' : CARD_BRANDS[key] || humanize(key);
  const masked = digits ? `${BULLET.repeat(4)} ${digits}` : BULLET.repeat(4);
  return label ? `${label} ${masked}` : masked;
}

/**
 * Mask a travel‑document number, keeping only its last 3 characters (never more than half, so very
 * short values show less): `A1234567` → `•••••567`. Whitespace is dropped; empty → `''`.
 * @param {string | null | undefined} number
 * @returns {string}
 * @throws {ValidationError} when `number` is not a string
 */
export function maskDocument(number) {
  const s = optionalString('maskDocument', number, 'number').replace(/\s+/g, '');
  if (s === '') return '';
  return maskTail(Array.from(s), 3);
}

// ── small string helpers ────────────────────────────────────────────────────────────────────────

/**
 * Booking reference / PNR for display: trimmed, inner whitespace collapsed, upper‑cased (`abc123` →
 * `ABC123`). `null` / `undefined` → `''`.
 * @param {string | number | null | undefined} ref
 * @returns {string}
 * @throws {ValidationError} when `ref` is not a string or number
 */
export function formatReference(ref) {
  if (ref === undefined || ref === null) return '';
  if (typeof ref !== 'string' && typeof ref !== 'number') {
    throw invalid('formatReference', 'Expected ref to be a string', 'ref', 'type', {
      expected: 'string',
    });
  }
  return clean(String(ref)).toUpperCase();
}

/**
 * Seat label `12A` from a `Seat` (`number`), a `{ row, column }` / `{ row, letter }` pair or a bare
 * string; whitespace removed, upper‑cased. `null` / `undefined` → `''`.
 * @param {Seat | { row: number|string, column?: string, letter?: string } | string | number | null | undefined} seat
 * @returns {string}
 * @throws {ValidationError} when `seat` is of an unsupported shape
 */
export function formatSeat(seat) {
  const fn = 'formatSeat';
  if (seat === undefined || seat === null) return '';
  if (typeof seat === 'string' || typeof seat === 'number') {
    return String(seat).replace(/\s+/g, '').toUpperCase();
  }
  if (isObject(seat)) {
    const o = /** @type {Record<string, unknown>} */ (seat);
    if (o.number !== undefined && o.number !== null) {
      return formatSeat(/** @type {string | number} */ (o.number));
    }
    const column = o.column !== undefined ? o.column : o.letter;
    if (o.row !== undefined && o.row !== null && column !== undefined && column !== null) {
      return formatSeat(`${o.row}${column}`);
    }
  }
  throw invalid(fn, 'Expected seat to be a Seat, { row, column } or a seat label', 'seat', 'type', {
    expected: 'Seat',
  });
}

/**
 * `INDIRA GANDHI INTL` → `Indira Gandhi Intl`: lower‑case, then capitalise the first letter of every
 * word (after whitespace, hyphens, slashes, brackets, …) and single‑letter prefixes before an
 * apostrophe (`O'HARE` → `O'Hare`). Unicode‑aware. `null` / `undefined` → `''`.
 * @param {string | null | undefined} s
 * @returns {string}
 * @throws {ValidationError} when `s` is not a string
 */
export function titleCase(s) {
  if (s === undefined || s === null) return '';
  if (typeof s !== 'string') {
    throw invalid('titleCase', 'Expected s to be a string', 's', 'type', { expected: 'string' });
  }
  return s
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase())
    .replace(
      /(^|[^\p{L}\p{N}])(\p{L})(['’])(\p{L})/gu,
      (_m, sep, a, q, b) => sep + a + q + b.toUpperCase()
    );
}

/**
 * Cut `s` to at most `n` characters (code points), ending with `…` when something was removed
 * (`truncate('Indira Gandhi International', 14)` → `Indira Gandhi…`). Trailing whitespace before the
 * ellipsis is trimmed. `null` / `undefined` → `''`.
 * @param {string | null | undefined} s
 * @param {number} n  Maximum length including the ellipsis.
 * @param {string} [ellipsis='…']
 * @returns {string}
 * @throws {ValidationError} when `s` / `ellipsis` are not strings or `n` is not a non‑negative integer
 */
export function truncate(s, n, ellipsis = '…') {
  const fn = 'truncate';
  if (s === undefined || s === null) return '';
  if (typeof s !== 'string') {
    throw invalid(fn, 'Expected s to be a string', 's', 'type', { expected: 'string' });
  }
  if (!Number.isInteger(n) || n < 0) {
    throw invalid(fn, 'Expected n to be a non-negative integer', 'n', 'invalid_length', {
      value: n,
    });
  }
  if (typeof ellipsis !== 'string') {
    throw invalid(fn, 'Expected ellipsis to be a string', 'ellipsis', 'type', {
      expected: 'string',
    });
  }
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  const tail = Array.from(ellipsis);
  if (n <= tail.length) return tail.slice(0, n).join('');
  return (
    chars
      .slice(0, n - tail.length)
      .join('')
      .trimEnd() + ellipsis
  );
}
