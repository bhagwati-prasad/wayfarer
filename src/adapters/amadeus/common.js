/**
 * Shared Amadeus ↔ SDK conversion helpers (docs/BACKEND-MAPPING.md §6 `common.js`, §4 C‑1/C‑2/C‑3/C‑5/
 * C‑24/C‑25/C‑35, §3.16): money and timestamp normalisation (`toMoney`, `toDateTime`), ISO‑8601
 * durations and dates, the bidirectional enum maps (pax type, cabin, gender, document type, amenity,
 * service name, additional service type) with their `toWire` / `fromWire` helpers, dictionary lookups
 * (`resolveCarrier`, `resolveAircraft`, `resolvePlace`), id scoping (`scopeId` / `unscopeId`), offer
 * renumbering for multi‑offer requests (`renumberOffers`), the Amadeus `errors[]` → RFC 9457 problem +
 * SDK error class mapping (`fromIssue`, `fromIssueArray`, `fromWarnings`) and the tolerant `readEither`
 * getter for the spec's misspelt example keys. Everything is a pure function: no I/O, no state, no
 * timers, no DOM, no logging; inputs are never mutated and the untouched wire payload is left for the
 * caller to keep on `raw`. Unknown enum values pass through (C‑35) and malformed wire values degrade
 * gracefully instead of throwing; the only errors ever constructed are the SDK classes handed back as
 * `ErrorClass` by `fromIssueArray` (never thrown here).
 */

import {
  ApiError,
  BookingError,
  ConflictError,
  NotFoundError,
  OfferUnavailableError,
  PaymentError,
  PriceChangedError,
  ValidationError,
} from '../../errors/index.js';
import { money } from '../../utils/money.js';
import { clone } from '../../utils/object.js';

/** @typedef {import('../../types.js').Money} Money */
/** @typedef {import('../../types.js').DateTime} DateTime */
/** @typedef {import('../../types.js').DateStr} DateStr */
/** @typedef {import('../../types.js').IATA} IATA */
/** @typedef {import('../../types.js').Place} Place */
/** @typedef {import('../../types.js').Airline} Airline */
/** @typedef {import('../../types.js').Aircraft} Aircraft */
/** @typedef {import('../../types.js').Problem} Problem */
/** @typedef {import('../../types.js').Issue} Issue */
/** @typedef {import('../../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../../types.js').PaxType} PaxType */
/** @typedef {import('../../types.js').CabinClass} CabinClass */
/** @typedef {import('../../types.js').AncillaryType} AncillaryType */

/**
 * A `Money` read from the wire; `additionalCollection` is set only when the Amadeus amount carried the
 * `'A'` suffix (`ElementaryPrice` "additional collection", C‑2).
 * @typedef {Money & { additionalCollection?: true }} WireMoney
 */

/**
 * Result of `toDateTime`: the ISO‑8601 value (with offset when the zone is known), the offset in
 * minutes (`null` when unknown) and the `localTimeOnly` flag (C‑1).
 * @typedef {{ value: string, offsetMinutes: number|null, localTimeOnly: boolean }} WireDateTime
 */

/**
 * Where airport time zones come from: a function of the IATA code, a `Map`, a plain record of
 * `code → IANA zone` or `code → { tz }` (a `Place`), or a bare IANA zone string applied to every input
 * (office stamps, C‑1).
 * @typedef {((iata: string) => string|{ tz?: string }|undefined) | Map<string, string|{ tz?: string }> | Record<string, string|{ tz?: string }> | string} TzLookup
 */

/**
 * Bidirectional enum map: `toWire` (SDK → Amadeus) and `fromWire` (Amadeus → SDK, aliases included).
 * `fallback` normalises an Amadeus value no entry covers (`undefined` = pass through unchanged).
 * @typedef {Object} EnumMap
 * @property {Readonly<Record<string, string>>} toWire
 * @property {Readonly<Record<string, string>>} fromWire
 * @property {((value: string) => string)|undefined} fallback
 */

/**
 * Response `dictionaries` (`Dictionaries` in every Amadeus spec): `code → name` tables plus
 * `locations[code] → { cityCode, countryCode }`. The bogus `key` property of the schema is ignored.
 * @typedef {{ locations?: Record<string, { cityCode?: string, countryCode?: string }>, aircraft?: Record<string, string>, currencies?: Record<string, string>, carriers?: Record<string, string> }} Dictionaries
 */

/**
 * Optional hydration source for `resolvePlace`: full `Place`s by IATA code.
 * @typedef {((iata: string) => Partial<Place>|undefined) | Map<string, Partial<Place>> | Record<string, Partial<Place>>} PlacesLookup
 */

/**
 * One converted `Issue` (`fromIssue`): the Amadeus code as a number when numeric, the HTTP status, the
 * texts, the SDK‑rebased `path` (from `source.pointer` or `source.parameter`) and the raw locators.
 * @typedef {Object} WireIssue
 * @property {number|string|undefined} code
 * @property {number|undefined} status
 * @property {string|undefined} title
 * @property {string|undefined} detail
 * @property {string|undefined} path
 * @property {string|undefined} pointer
 * @property {string|undefined} parameter
 * @property {string|undefined} example
 */

/**
 * Result of `fromIssueArray`: the RFC 9457 document (with the `errors` extension), the SDK error class
 * chosen per the C‑5 table and the `[message, options]` arguments that build it
 * (`new ErrorClass(...errorArgs)`). `empty` is `true` for the upsell "no upsell" code 39397, which is
 * an empty result rather than a failure. `issues` are the converted entries.
 * @typedef {Object} IssueMapping
 * @property {Problem} problem
 * @property {typeof ValidationError | typeof ApiError} ErrorClass
 * @property {[string, Record<string, unknown>]} errorArgs
 * @property {boolean} empty
 * @property {WireIssue[]} issues
 */

/**
 * Result of `renumberOffers`: the renumbered copies and how the new ids relate to the input.
 * `map.offers[newOfferId]` → `{ index, id }` (position in the input, wire id); `map.segments[newSegId]` →
 * `{ index, offerId, id }` (input position, new offer id, wire segment id); `map.byIndex[i]` → the new
 * offer id and the `oldSegmentId → newSegmentId` table of input offer `i`.
 * @typedef {{
 *   offers: Record<string, unknown>[],
 *   map: {
 *     offers: Record<string, { index: number, id: string|undefined }>,
 *     segments: Record<string, { index: number, offerId: string, id: string|undefined }>,
 *     byIndex: { id: string, segments: Record<string, string> }[],
 *   },
 * }} RenumberResult
 */

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

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

/** Own‑property read that never hits the prototype (`constructor`, `__proto__` as wire keys). */
function own(table, key) {
  return isObject(table) && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/** Entries as a safe `Object.fromEntries` record (a hostile key never re‑points the prototype). */
function record(entries) {
  return Object.fromEntries(entries);
}

/** Resolve a lookup given as a function, a `Map` or a plain record. */
function lookup(source, key) {
  if (source === null || source === undefined || typeof key !== 'string' || key === '') {
    return undefined;
  }
  if (typeof source === 'function') {
    try {
      return source(key);
    } catch {
      return undefined;
    }
  }
  if (source instanceof Map) return source.get(key);
  return own(source, key);
}

// ── money (C‑2) ─────────────────────────────────────────────────────────────────────────────────

const AMOUNT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/**
 * Currency code out of a bare string or an enclosing Amadeus object (`Price.currency`,
 * `ElementaryPrice.currencyCode`, `Price.billingCurrency`).
 * @param {unknown} source
 * @returns {string|undefined}
 */
function currencyOf(source) {
  const raw = isObject(source)
    ? (str(source.currency) ?? str(source.currencyCode) ?? str(source.billingCurrency))
    : str(source);
  const code = raw?.trim();
  return code && CURRENCY_RE.test(code) ? code.toUpperCase() : undefined;
}

/**
 * Amadeus amount string → `Money`. Amounts are decimal strings (`'514.13'`, `'6'`) or numbers; the
 * value is normalised to the currency's minor units through `utils/money` (`'6'` → `'6.00'` for EUR,
 * `'1234'` for JPY) and never held as a float. An `'A'` suffix (`ElementaryPrice` additional collection)
 * is stripped and reported as `additionalCollection: true`. `currency` is the ISO code or the enclosing
 * object that carries it (`currency` / `currencyCode` / `billingCurrency` alias). A missing or empty
 * amount gives `undefined`; an unparseable amount or unknown currency is kept verbatim (trimmed, upper‑
 * cased currency or `''`) so no figure is silently dropped (C‑35).
 * @param {string|number|null|undefined} amount
 * @param {string|{ currency?: string, currencyCode?: string, billingCurrency?: string }|null|undefined} currency
 * @returns {WireMoney|undefined}
 */
export function toMoney(amount, currency) {
  if (amount === null || amount === undefined) return undefined;
  let text = typeof amount === 'number' ? String(amount) : String(amount).trim();
  if (text === '') return undefined;
  let additionalCollection = false;
  if (/[aA]$/.test(text)) {
    text = text.slice(0, -1).trim();
    additionalCollection = true;
  }
  const code = currencyOf(currency);
  let normalised = text;
  if (code && AMOUNT_RE.test(text)) {
    try {
      normalised = money(text, code).amount;
    } catch {
      normalised = text;
    }
  }
  /** @type {WireMoney} */
  const out = { amount: normalised, currency: code ?? '' };
  if (additionalCollection) out.additionalCollection = true;
  return out;
}

// ── timestamps (C‑1) ────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD[THH:mm[:ss[.fff]]][Z|±HH[:]MM]` (the offset is tolerated even after a bare date). */
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

const ZONE_FORMATTER_CACHE_SIZE = 64;
/** @type {Map<string, Intl.DateTimeFormat>} */
const zoneFormatters = new Map();

/**
 * Memoised `Intl.DateTimeFormat` for a zone; `undefined` when `Intl` is missing or the zone is unknown.
 * @param {string} zone
 * @returns {Intl.DateTimeFormat|undefined}
 */
function zoneFormatter(zone) {
  const cached = zoneFormatters.get(zone);
  if (cached) return cached;
  const IntlRef = globalThis.Intl;
  if (!IntlRef || typeof IntlRef.DateTimeFormat !== 'function') return undefined;
  try {
    const formatter = new IntlRef.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (zoneFormatters.size >= ZONE_FORMATTER_CACHE_SIZE) {
      zoneFormatters.delete(zoneFormatters.keys().next().value);
    }
    zoneFormatters.set(zone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

/**
 * UTC offset (minutes) of `zone` at the instant `utcMs`.
 * @param {Intl.DateTimeFormat} formatter
 * @param {number} utcMs
 * @returns {number}
 */
function offsetAtInstant(formatter, utcMs) {
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * UTC offset (minutes) in force in `zone` at the given wall‑clock time, DST‑aware: the guess made at the
 * wall time read as UTC is corrected once against the instant it implies. `undefined` when the zone is
 * unknown to the runtime.
 * @param {string} zone
 * @param {number} wallMs  Local components encoded with `Date.UTC`
 * @returns {number|undefined}
 */
function offsetForWall(zone, wallMs) {
  const formatter = zoneFormatter(zone);
  if (!formatter) return undefined;
  try {
    const first = offsetAtInstant(formatter, wallMs);
    const second = offsetAtInstant(formatter, wallMs - first * 60000);
    if (second === first) return first;
    const third = offsetAtInstant(formatter, wallMs - second * 60000);
    return third;
  } catch {
    return undefined;
  }
}

/** `330` → `+05:30`, `-240` → `-04:00`, `0` → `+00:00`. @param {number} minutes */
function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** `+05:30` / `+0530` / `+05` / `Z` → minutes. @param {string} text */
function parseOffset(text) {
  if (/^[Zz]$/.test(text)) return 0;
  const m = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(text);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] || '0');
  return m[1] === '-' ? -minutes : minutes;
}

/**
 * IANA zone for `iata` from a `TzLookup` (string zone, function, `Map`, record of zones or `Place`s).
 * @param {string|undefined} iata
 * @param {TzLookup|undefined} tzLookup
 * @returns {string|undefined}
 */
function zoneFor(iata, tzLookup) {
  if (typeof tzLookup === 'string') return str(tzLookup);
  const found = lookup(tzLookup, iata);
  if (typeof found === 'string') return str(found);
  if (isObject(found)) return str(found.tz);
  return undefined;
}

/**
 * Amadeus local wall‑clock time (`2026-11-02T06:45:00`, `…ss.sss`, or a bare date) → SDK `DateTime`
 * with the UTC offset of the airport attached (C‑1). The offset is the one in force in the IANA zone
 * resolved for `iata` at that wall time (DST‑aware, computed with `Intl`); unknown zone or no `Intl`
 * ⇒ the string is kept as is, `offsetMinutes: null`, `localTimeOnly: true`. An input that already carries
 * an offset (`Z`, `±HH:MM`) is kept verbatim with its offset parsed. A bare date is read as local
 * midnight (`T00:00:00`) when the zone is known. Unparseable strings pass through as local‑time‑only;
 * `null` / `undefined` / `''` give `undefined`.
 * @param {string|null|undefined} localIso
 * @param {string} [iata]  Airport whose zone applies (ignored when `tzLookup` is a zone string)
 * @param {TzLookup} [tzLookup]
 * @returns {WireDateTime|undefined}
 */
export function toDateTime(localIso, iata, tzLookup) {
  if (localIso === null || localIso === undefined) return undefined;
  const text = String(localIso).trim();
  if (text === '') return undefined;
  const m = DATETIME_RE.exec(text);
  if (!m) return { value: text, offsetMinutes: null, localTimeOnly: true };
  const [, year, month, day, hh, mm, ss, frac, offset] = m;
  if (offset) return { value: text, offsetMinutes: parseOffset(offset), localTimeOnly: false };
  const zone = zoneFor(iata, tzLookup);
  const wallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hh || '0'),
    Number(mm || '0'),
    Number(ss || '0')
  );
  const offsetMinutes = zone ? offsetForWall(zone, wallMs) : undefined;
  if (offsetMinutes === undefined) return { value: text, offsetMinutes: null, localTimeOnly: true };
  const time = `${hh || '00'}:${mm || '00'}:${ss || '00'}${frac ? `.${frac}` : ''}`;
  return {
    value: `${year}-${month}-${day}T${time}${formatOffset(offsetMinutes)}`,
    offsetMinutes,
    localTimeOnly: false,
  };
}

// ── durations and dates ─────────────────────────────────────────────────────────────────────────

const DURATION_RE =
  /^([+-])?P(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i;

/**
 * ISO‑8601 duration (`PT18H30M`, `P1DT2H`, `PT90M`, `PT1H30M30S`) → whole minutes (seconds rounded to
 * the nearest minute). A finite number is taken as minutes already (C‑35 coercion). Missing, empty or
 * malformed input (`'PT'`, `'18h'`) gives `undefined`.
 * @param {string|number|null|undefined} str
 * @returns {number|undefined}
 */
export function parseIsoDuration(str) {
  if (typeof str === 'number') return Number.isFinite(str) ? Math.round(str) : undefined;
  if (typeof str !== 'string') return undefined;
  const m = DURATION_RE.exec(str.trim());
  if (!m) return undefined;
  const [, sign, weeks, days, hours, minutes, seconds] = m;
  if (!weeks && !days && !hours && !minutes && !seconds) return undefined;
  const n = (v) => (v ? Number(v.replace(',', '.')) : 0);
  const total =
    n(weeks) * 7 * 24 * 60 + n(days) * 24 * 60 + n(hours) * 60 + n(minutes) + n(seconds) / 60;
  const rounded = Math.round(total);
  return sign === '-' ? -rounded : rounded;
}

/**
 * `YYYY-MM-DD` out of a date or date‑time string (`2026-11-02`, `2026-11-02T00:00:00.000Z`,
 * `2026-11-02T06:45:00`); a `Date` gives its UTC calendar date. Anything else gives `undefined`.
 * @param {string|Date|null|undefined} str
 * @returns {DateStr|undefined}
 */
export function normalizeDate(str) {
  if (str instanceof Date) {
    return Number.isNaN(str.getTime()) ? undefined : str.toISOString().slice(0, 10);
  }
  if (typeof str !== 'string') return undefined;
  const m = /^\s*(\d{4}-\d{2}-\d{2})(?:$|[Tt\s])/.exec(str);
  return m ? m[1] : undefined;
}

// ── enum maps (C‑24, §3.4, §3.6, §3.7) ──────────────────────────────────────────────────────────

/**
 * Build a frozen `EnumMap` from `[sdk, wire]` pairs plus extra wire → SDK aliases.
 * @param {[string, string][]} pairs
 * @param {{ aliases?: Record<string, string>, fallback?: (value: string) => string }} [options]
 * @returns {Readonly<EnumMap>}
 */
function enumMap(pairs, options = {}) {
  const toWireTable = record(pairs);
  const fromWireTable = record([
    ...pairs.map(([sdk, wire]) => [wire, sdk]),
    ...Object.entries(options.aliases || {}),
  ]);
  return Object.freeze({
    toWire: Object.freeze(toWireTable),
    fromWire: Object.freeze(fromWireTable),
    fallback: options.fallback,
  });
}

/** Lower‑case fallback for open wire enums (`PRE_RESERVED_SEAT` → `pre_reserved_seat`). */
const lowerCase = (value) => value.toLowerCase();

/** `PaxType` ↔ `TravelerType`. */
export const PAX_TYPE = enumMap([
  ['ADT', 'ADULT'],
  ['CHD', 'CHILD'],
  ['INF', 'HELD_INFANT'],
  ['INS', 'SEATED_INFANT'],
  ['YTH', 'YOUNG'],
  ['SRC', 'SENIOR'],
  ['STU', 'STUDENT'],
]);

/** `CabinClass` ↔ `TravelClass`. */
export const CABIN = enumMap(
  [
    ['economy', 'ECONOMY'],
    ['premium_economy', 'PREMIUM_ECONOMY'],
    ['business', 'BUSINESS'],
    ['first', 'FIRST'],
  ],
  { fallback: lowerCase }
);

/** `Traveler.gender` ↔ `StakeholderGender` (`UNDISCLOSED` also reads as `X`; C‑24). */
export const GENDER = enumMap(
  [
    ['M', 'MALE'],
    ['F', 'FEMALE'],
    ['X', 'UNSPECIFIED'],
  ],
  { aliases: { UNDISCLOSED: 'X' } }
);

/**
 * `TravelDocument.type` ↔ `DocumentType`. `KNOWN_TRAVELER` / `REDRESS` are documents on the wire but
 * traveler fields in the SDK (`TRAVELER_FIELD_DOCUMENTS`); `driving_licence` has no wire value (C‑24).
 */
export const DOCUMENT_TYPE = enumMap([
  ['passport', 'PASSPORT'],
  ['national_id', 'IDENTITY_CARD'],
  ['visa', 'VISA'],
  ['known_traveler', 'KNOWN_TRAVELER'],
  ['redress', 'REDRESS'],
]);

/** Wire document types that the SDK keeps as `Traveler` fields rather than `documents[]` (C‑24). */
export const TRAVELER_FIELD_DOCUMENTS = Object.freeze({
  KNOWN_TRAVELER: 'knownTravelerNumber',
  REDRESS: 'redressNumber',
});

/** `Amenity.type` ↔ `AmenityType` (`BEVERAGE` also reads as `meal`; others lower‑cased; §3.4). */
export const AMENITY_TYPE = enumMap(
  [
    ['wifi', 'WIFI'],
    ['power', 'POWER'],
    ['meal', 'MEAL'],
    ['entertainment', 'ENTERTAINMENT'],
    ['seat_pitch', 'SEAT'],
    ['baggage', 'BAGGAGE'],
    ['lounge', 'LOUNGE'],
    ['miles', 'FREQUENT_FLYER'],
    ['fare_feature', 'BRANDED_FARES'],
    ['carbon_offset', 'CARBON_OFFSET'],
    ['bundle', 'BUNDLED_SERVICE'],
  ],
  { aliases: { BEVERAGE: 'meal' }, fallback: lowerCase }
);

/** `AncillaryType` ↔ `ServiceName` (`otherServices[].name`; §3.7). */
export const SERVICE_NAME = enumMap(
  [
    ['priority_boarding', 'PRIORITY_BOARDING'],
    ['airport_checkin', 'AIRPORT_CHECKIN'],
    ['fast_track', 'FAST_TRACK'],
  ],
  { fallback: lowerCase }
);

/** `AncillaryType` ↔ `AdditionalServiceType` (`price.additionalServices[].type`; §3.5). */
export const ADDITIONAL_SERVICE_TYPE = enumMap(
  [
    ['baggage', 'CHECKED_BAGS'],
    ['cabin_baggage', 'CABIN_BAGS'],
    ['meal', 'MEALS'],
    ['seat', 'SEATS'],
    ['other', 'OTHER_SERVICES'],
  ],
  { fallback: lowerCase }
);

/** Exact, then case‑variant, table lookup. */
function lookupEnum(table, value) {
  return own(table, value) ?? own(table, value.toUpperCase()) ?? own(table, value.toLowerCase());
}

/**
 * SDK enum value → Amadeus value through `map` (`toWire(CABIN, 'business')` → `'BUSINESS'`). Unknown
 * values pass through unchanged so the backend's validation decides; `null` / `undefined` / `''` give
 * `undefined`.
 * @param {Readonly<EnumMap>} map
 * @param {string|null|undefined} value
 * @returns {string|undefined}
 */
export function toWire(map, value) {
  if (typeof value !== 'string' || value === '') return undefined;
  return lookupEnum(map.toWire, value) ?? value;
}

/**
 * Amadeus enum value → SDK value through `map` (`fromWire(PAX_TYPE, 'HELD_INFANT')` → `'INF'`), aliases
 * included (`UNDISCLOSED` → `'X'`). Values no entry covers go through the map's fallback (lower‑casing
 * for the open enums) or pass through unchanged (C‑35); `null` / `undefined` / `''` give `undefined`.
 * @param {Readonly<EnumMap>} map
 * @param {string|null|undefined} value
 * @returns {string|undefined}
 */
export function fromWire(map, value) {
  if (typeof value !== 'string' || value === '') return undefined;
  const mapped = lookupEnum(map.fromWire, value);
  if (mapped !== undefined) return mapped;
  return map.fallback ? map.fallback(value) : value;
}

// ── dictionaries (§3.16) ────────────────────────────────────────────────────────────────────────

/**
 * Carrier code → `Airline` using `dictionaries.carriers` (`code → name`); the name falls back to the
 * code when the dictionary does not know it. Empty / non‑string codes give `undefined`.
 * @param {string|null|undefined} code
 * @param {Dictionaries|null|undefined} dict
 * @returns {Airline|undefined}
 */
export function resolveCarrier(code, dict) {
  const key = str(code);
  if (!key) return undefined;
  const name = str(own(isObject(dict) ? dict.carriers : undefined, key));
  return { code: key, name: name ?? key };
}

/**
 * Aircraft code → `Aircraft` using `dictionaries.aircraft` (`code → manufacturer/model`); the name falls
 * back to the code. Empty / non‑string codes give `undefined`.
 * @param {string|null|undefined} code
 * @param {Dictionaries|null|undefined} dict
 * @returns {Aircraft|undefined}
 */
export function resolveAircraft(code, dict) {
  const key = str(code);
  if (!key) return undefined;
  const name = str(own(isObject(dict) ? dict.aircraft : undefined, key));
  return { code: key, name: name ?? key };
}

/**
 * IATA code → `Place`, partial until hydrated (C‑19): `code` plus `cityCode` / `countryCode` from
 * `dictionaries.locations`, overlaid with the full `Place` from the optional `places` lookup (function,
 * `Map` or record) when it knows the code. Empty / non‑string codes give `undefined`.
 * @param {string|null|undefined} iata
 * @param {Dictionaries|null|undefined} dict
 * @param {PlacesLookup} [places]
 * @returns {(Partial<Place> & { code: IATA })|undefined}
 */
export function resolvePlace(iata, dict, places) {
  const code = str(iata);
  if (!code) return undefined;
  /** @type {Partial<Place> & { code: IATA }} */
  const place = { code };
  const entry = own(isObject(dict) ? dict.locations : undefined, code);
  if (isObject(entry)) {
    const cityCode = str(entry.cityCode);
    const countryCode = str(entry.countryCode);
    if (cityCode) place.cityCode = cityCode;
    if (countryCode) place.countryCode = countryCode;
  }
  const hydrated = lookup(places, code);
  if (isObject(hydrated)) {
    for (const [key, value] of Object.entries(hydrated)) {
      if (value !== undefined && key !== '__proto__') place[key] = value;
    }
    place.code = code;
  }
  return place;
}

// ── identifiers (C‑3) ───────────────────────────────────────────────────────────────────────────

/**
 * Response‑scoped wire id → SDK id `"<sessionId>:<id>"` (offers under the search session, segments
 * under the offer id — scopes nest). Without a scope the id is returned as a string.
 * @param {string|null|undefined} sessionId
 * @param {string|number} id
 * @returns {string}
 */
export function scopeId(sessionId, id) {
  const scope = sessionId === null || sessionId === undefined ? '' : String(sessionId);
  return scope === '' ? String(id) : `${scope}:${id}`;
}

/**
 * SDK id → `{ sessionId, id }`, splitting on the **first** `':'` so an inner id may itself contain
 * `':'` (`'sess:1:40'` → `{ sessionId: 'sess', id: '1:40' }`; unscope again for the segment). An id
 * without `':'` gives `sessionId: undefined`; `null` / `undefined` give both fields `undefined`.
 * @param {string|number|null|undefined} id
 * @returns {{ sessionId: string|undefined, id: string|undefined }}
 */
export function unscopeId(id) {
  if (id === null || id === undefined) return { sessionId: undefined, id: undefined };
  const text = String(id);
  const at = text.indexOf(':');
  if (at < 0) return { sessionId: undefined, id: text };
  return { sessionId: text.slice(0, at), id: text.slice(at + 1) };
}

/** Wire id as a string (`flightOfferIds` arrive as integers in some examples, C‑35). */
function wireId(v) {
  return v === null || v === undefined ? undefined : String(v);
}

/**
 * Make offer and segment ids unique across several `FlightOffer`s before a multi‑offer pricing / upsell
 * / order request (C‑3, C‑8): offers become `'1'..'n'` in input order, segments are numbered `'1'..'m'`
 * across all offers, and every `travelerPricings[].fareDetailsBySegment[].segmentId` (also the example
 * spelling `fareDetailBySegment`, C‑35) is remapped. The input is deep‑copied, never mutated; a single
 * offer is accepted in place of an array; non‑object entries are skipped.
 * @param {Record<string, unknown>[]|Record<string, unknown>} rawOffers
 * @returns {RenumberResult}
 */
export function renumberOffers(rawOffers) {
  const input = Array.isArray(rawOffers) ? rawOffers : rawOffers ? [rawOffers] : [];
  /** @type {RenumberResult} */
  const result = { offers: [], map: { offers: {}, segments: {}, byIndex: [] } };
  let segmentCounter = 0;
  for (let index = 0; index < input.length; index++) {
    const source = input[index];
    if (!isObject(source)) continue;
    const offer = /** @type {Record<string, any>} */ (clone(source));
    const newOfferId = String(result.offers.length + 1);
    /** @type {Record<string, string>} */
    const segmentIds = {};
    const itineraries = Array.isArray(offer.itineraries) ? offer.itineraries : [];
    for (const itinerary of itineraries) {
      if (!isObject(itinerary) || !Array.isArray(itinerary.segments)) continue;
      for (const segment of itinerary.segments) {
        if (!isObject(segment)) continue;
        const oldId = wireId(segment.id);
        const newId = String(++segmentCounter);
        if (oldId !== undefined) segmentIds[oldId] = newId;
        segment.id = newId;
        result.map.segments[newId] = { index, offerId: newOfferId, id: oldId };
      }
    }
    const pricings = Array.isArray(offer.travelerPricings) ? offer.travelerPricings : [];
    for (const pricing of pricings) {
      if (!isObject(pricing)) continue;
      for (const key of ['fareDetailsBySegment', 'fareDetailBySegment']) {
        const details = pricing[key];
        if (!Array.isArray(details)) continue;
        for (const detail of details) {
          if (!isObject(detail)) continue;
          const oldId = wireId(detail.segmentId);
          const mapped = oldId === undefined ? undefined : own(segmentIds, oldId);
          if (mapped !== undefined) detail.segmentId = mapped;
        }
      }
    }
    result.map.offers[newOfferId] = { index, id: wireId(offer.id) };
    result.map.byIndex.push({ id: newOfferId, segments: segmentIds });
    offer.id = newOfferId;
    result.offers.push(offer);
  }
  return result;
}

// ── errors (C‑5, §3.16) ─────────────────────────────────────────────────────────────────────────

/** Pointer segments dropped when re‑basing (`/data/travelers/1/name/firstName` → `travelers[1].firstName`). */
const DROPPED_SEGMENTS = new Set(['data', 'name', 'departureDateTimeRange']);

/** Amadeus body member → SDK path segment. */
const SEGMENT_RENAMES = Object.freeze({
  originDestinations: 'slices',
  flightOffers: 'offers',
  originLocationCode: 'origin',
  destinationLocationCode: 'destination',
  dateOfBirth: 'dob',
  expiryDate: 'expiry',
  issuanceDate: 'issueDate',
  issuanceCountry: 'issuingCountry',
  documentType: 'type',
  travelerType: 'type',
  emailAddress: 'email',
  countryCallingCode: 'countryCode',
  deviceType: 'type',
  phones: 'phone',
  contacts: 'contact',
  loyaltyPrograms: 'loyalty',
  programOwner: 'airline',
  id: 'number',
});

/** Members whose `id` child is an identifier, not a loyalty number (`loyaltyPrograms[].id`). */
const ID_KEEPERS = new Set(['travelers', 'originDestinations', 'flightOffers', 'segments', 'data']);

/** GET query parameter → SDK `SearchParams` path (`fromIssue` on `source.parameter`). */
const PARAMETER_PATHS = Object.freeze({
  originLocationCode: 'slices[0].origin',
  destinationLocationCode: 'slices[0].destination',
  departureDate: 'slices[0].date',
  returnDate: 'slices[1].date',
  adults: 'passengers.adults',
  children: 'passengers.children',
  infants: 'passengers.infants',
  travelClass: 'cabin',
  currencyCode: 'currency',
  nonStop: 'directOnly',
  includedAirlineCodes: 'airlines.include',
  excludedAirlineCodes: 'airlines.exclude',
  maxPrice: 'maxPrice',
  max: 'limit',
});

/**
 * Amadeus JSON pointer into the request body → SDK dotted path (§3.16): the `data` wrapper and the
 * `name` / `departureDateTimeRange` levels are dropped, indices become `[n]`, Amadeus member names are
 * renamed to their SDK counterparts (`/originDestinations/0/originLocationCode` → `slices[0].origin`,
 * `/data/travelers/1/documents/0/expiryDate` → `travelers[1].documents[0].expiry`); unknown members
 * are kept as they are. `undefined` for an empty or non‑string pointer.
 * @param {string|null|undefined} pointer
 * @returns {string|undefined}
 */
export function pointerToSdkPath(pointer) {
  if (typeof pointer !== 'string' || pointer === '') return undefined;
  const segments = pointer
    .replace(/^#/, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let path = '';
  let parent = '';
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      path += `[${segment}]`;
      continue;
    }
    if (DROPPED_SEGMENTS.has(segment)) {
      parent = segment;
      continue;
    }
    const renamed =
      segment === 'id' && ID_KEEPERS.has(parent) ? 'id' : (own(SEGMENT_RENAMES, segment) ?? segment);
    path += path === '' ? renamed : `.${renamed}`;
    parent = segment;
  }
  return path === '' ? undefined : path;
}

/** Amadeus `Issue.code` (int64, sometimes a numeric string) → number, else the string, else undefined. */
function issueCode(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const text = v.trim();
    if (text === '') return undefined;
    return /^\d+$/.test(text) ? Number(text) : text;
  }
  return undefined;
}

/**
 * One Amadeus `Issue` → `WireIssue`: numeric `code` (numbers and numeric strings alike), `status`
 * (the issue's own, else `httpStatus`), `title` / `detail`, the SDK‑rebased `path` (`source.pointer`
 * through `pointerToSdkPath`, else `source.parameter` mapped to the `SearchParams` field it names) and
 * `example`. Non‑object input gives an issue with every field `undefined` except `status`.
 * @param {Issue|Record<string, unknown>|null|undefined} issue
 * @param {{ httpStatus?: number }} [options]
 * @returns {WireIssue}
 */
export function fromIssue(issue, options = {}) {
  const o = isObject(options) ? options : {};
  const i = isObject(issue) ? issue : {};
  const source = isObject(i.source) ? i.source : {};
  const pointer = str(source.pointer);
  const parameter = str(source.parameter);
  const status = num(i.status) ?? num(o.httpStatus);
  return {
    code: issueCode(i.code),
    status: status === undefined ? undefined : Math.trunc(status),
    title: str(i.title),
    detail: str(i.detail),
    path:
      pointerToSdkPath(pointer) ??
      (parameter ? (own(PARAMETER_PATHS, parameter) ?? parameter) : undefined),
    pointer,
    parameter,
    example: str(source.example),
  };
}

/** Amadeus codes answered with `ValidationError` (C‑5, all HTTP 400). */
const VALIDATION_CODES = new Set([425, 477, 572, 2668, 2781, 4926, 9880, 10661, 32171]);

/** The "no upsell available" code (C‑5, C‑20): an empty result, not a failure. */
const NO_UPSELL_CODE = 39397;

/**
 * Canonical SDK code for an HTTP status, as `ApiError` derives it (`400` → `BAD_REQUEST`, `0` →
 * `API_ERROR`), without duplicating that table here.
 * @param {number} status
 * @returns {string}
 */
function codeForStatus(status) {
  return new ApiError('', { status, at: 0 }).code;
}

/**
 * @typedef {Object} CodeMapping
 * @property {typeof ValidationError | typeof ApiError} ErrorClass
 * @property {string} code                     Canonical SDK code for `Problem.code`
 * @property {Record<string, unknown>} fields  Class‑specific constructor options
 * @property {boolean} [retryable]
 * @property {boolean} [empty]
 */

/**
 * The C‑5 table: Amadeus code → SDK class and options. `status` only matters for the default code.
 * @param {number|string|undefined} code
 * @param {number} status
 * @returns {CodeMapping|undefined}
 */
function mappingFor(code, status) {
  if (typeof code !== 'number') return undefined;
  if (VALIDATION_CODES.has(code)) {
    return { ErrorClass: ValidationError, code: 'VALIDATION_FAILED', fields: {} };
  }
  switch (code) {
    case 37200:
      return { ErrorClass: PriceChangedError, code: 'PRICE_CHANGED', fields: {} };
    case 34651:
      return { ErrorClass: OfferUnavailableError, code: 'SOLD_OUT', fields: { reason: 'sold_out' } };
    case 34107:
      return {
        ErrorClass: OfferUnavailableError,
        code: 'OFFER_WITHDRAWN',
        fields: { reason: 'withdrawn' },
      };
    case 38034:
      return { ErrorClass: ApiError, code: 'SERVICE_UNAVAILABLE', fields: {}, retryable: true };
    case 1304:
      return { ErrorClass: PaymentError, code: 'PAYMENT_DECLINED', fields: { reason: 'declined' } };
    case 34733:
      return {
        ErrorClass: PaymentError,
        code: 'PAYMENT_GATEWAY_ERROR',
        fields: { reason: 'gateway' },
      };
    case 9112:
      return { ErrorClass: BookingError, code: 'BOOKING_FAILED', fields: { stage: 'ticketing' } };
    case 36870:
      return { ErrorClass: BookingError, code: 'BOOKING_FAILED', fields: { stage: 'create' } };
    case NO_UPSELL_CODE:
      return { ErrorClass: NotFoundError, code: 'NOT_FOUND', fields: {}, empty: true };
    case 1797:
      return { ErrorClass: NotFoundError, code: 'NOT_FOUND', fields: {} };
    case 2552:
      return { ErrorClass: ConflictError, code: 'CONFLICT', fields: {}, retryable: true };
    case 141:
      return { ErrorClass: ApiError, code: codeForStatus(status), fields: {}, retryable: true };
    default:
      return undefined;
  }
}

/**
 * Amadeus `errors[]` (`Error_400` … `Error_500`, `application/vnd.amadeus+json`) → RFC 9457 `Problem`
 * plus the SDK error to raise, per the C‑5 table: 400 codes 425 / 477 / 572 / 2668 / 2781 / 4926 /
 * 9880 / 10661 / 32171 → `ValidationError` (issue paths from `source.pointer` / `source.parameter`);
 * 37200 → `PriceChangedError`; 34651 → `OfferUnavailableError{sold_out}`; 34107 →
 * `OfferUnavailableError{withdrawn}`; 38034 → retryable `ApiError{SERVICE_UNAVAILABLE}`; 1304 →
 * `PaymentError{declined}`; 34733 → `PaymentError{gateway}`; 9112 → `BookingError{ticketing}`; 36870 →
 * `BookingError{create}`; 39397 → `NotFoundError` with `empty: true` (no upsell); 1797 →
 * `NotFoundError`; 2552 → retryable `ConflictError`; 141 → retryable `ApiError`; any other code →
 * `ApiError` whose code and retryability follow the HTTP status. Codes may be numbers or numeric
 * strings; the first issue carrying a mapped code decides, the first issue supplies `title` / `detail`.
 * The problem is `about:blank` typed with `status` ← `httpStatus` (else the first issue's `status`),
 * `code` ← canonical SDK code, `errors` ← the issues verbatim, `requestId` when given, and the
 * class‑specific `reason` / `stage` as extension members so `errorFromProblem(problem)` yields the same
 * error. The input may be the array, the `{ errors }` envelope or a single issue. Nothing is thrown or
 * constructed here: callers do `new ErrorClass(...errorArgs)`.
 * @param {Issue[]|{ errors?: Issue[] }|Issue|null|undefined} errors
 * @param {{ httpStatus?: number, requestId?: string }} [options]
 * @returns {IssueMapping}
 */
export function fromIssueArray(errors, options = {}) {
  const o = isObject(options) ? options : {};
  const list = Array.isArray(errors)
    ? errors
    : isObject(errors) && Array.isArray(errors.errors)
      ? errors.errors
      : isObject(errors)
        ? [errors]
        : [];
  const raw = /** @type {Issue[]} */ (list.filter(isObject));
  const httpStatus = num(o.httpStatus);
  const issues = raw.map((issue) => fromIssue(issue, { httpStatus }));
  const first = issues[0];
  const status = Math.trunc(httpStatus ?? first?.status ?? 0);
  const requestId = str(o.requestId);

  /** @type {CodeMapping|undefined} */
  let mapping;
  for (const issue of issues) {
    mapping = mappingFor(issue.code, status);
    if (mapping) break;
  }
  if (!mapping) mapping = { ErrorClass: ApiError, code: codeForStatus(status), fields: {} };

  const title = first?.title ?? first?.detail ?? 'Request failed';
  const message = first?.detail ?? first?.title ?? 'Request failed';
  /** @type {Problem} */
  const problem = { type: 'about:blank', title, status, code: mapping.code };
  if (first?.detail && first.detail !== title) problem.detail = first.detail;
  // Class‑specific fields travel as extension members too, so `errorFromProblem(problem)` (the facade
  // path) rebuilds the very same error: `reason` for offer / payment errors, `stage` for booking ones.
  Object.assign(problem, mapping.fields);
  problem.errors = raw;
  if (requestId) problem.requestId = requestId;

  /** @type {Record<string, unknown>} */
  let errorOptions;
  if (mapping.ErrorClass === ValidationError) {
    /** @type {ValidationIssue[]} */
    const validationIssues = issues.map((issue) => {
      /** @type {Record<string, unknown>} */
      const params = { status: issue.status };
      if (issue.example !== undefined) params.example = issue.example;
      if (issue.pointer !== undefined) params.pointer = issue.pointer;
      if (issue.parameter !== undefined) params.parameter = issue.parameter;
      return {
        path: issue.path ?? '',
        code: issue.code === undefined ? 'invalid' : String(issue.code),
        message: issue.detail ?? issue.title ?? 'Invalid request',
        params,
      };
    });
    errorOptions = {
      code: mapping.code,
      issues: validationIssues,
      requestId,
      details: { problem, status },
    };
  } else {
    errorOptions = {
      code: mapping.code,
      status: status || undefined,
      problem,
      issues: raw,
      requestId,
      ...mapping.fields,
    };
    if (mapping.retryable !== undefined) errorOptions.retryable = mapping.retryable;
  }
  if (errorOptions.requestId === undefined) delete errorOptions.requestId;

  return {
    problem,
    ErrorClass: mapping.ErrorClass,
    errorArgs: [message, errorOptions],
    empty: mapping.empty === true,
    issues,
  };
}

/**
 * `warnings[]` of a successful response (`Issue`‑shaped) → human‑readable strings for
 * `SearchSession.meta.warnings` / `Booking.warnings` (C‑5): `"<title>: <detail>"`, or whichever of the
 * two exists, or the bare code; plain strings pass through; empty entries and non‑arrays give nothing.
 * @param {(Issue|string)[]|null|undefined} warnings
 * @returns {string[]}
 */
export function fromWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  /** @type {string[]} */
  const out = [];
  for (const warning of warnings) {
    if (typeof warning === 'string') {
      if (warning.trim() !== '') out.push(warning.trim());
      continue;
    }
    if (!isObject(warning)) continue;
    const title = str(warning.title)?.trim();
    const detail = str(warning.detail)?.trim();
    if (title && detail && title !== detail) out.push(`${title}: ${detail}`);
    else if (detail || title) out.push(/** @type {string} */ (detail || title));
    else if (warning.code !== undefined && warning.code !== null) out.push(String(warning.code));
  }
  return out;
}

/**
 * Tolerant getter for the spec's inconsistent spellings (C‑35): the value of the first own key of `obj`
 * that is not `undefined` (`readEither(order, 'ticketingAgreement', 'ticketingAggreement')`,
 * `readEither(tp, 'fareDetailsBySegment', 'fareDetailBySegment')`), else `undefined`. Prototype
 * members are never read.
 * @template T
 * @param {Record<string, T>|null|undefined} obj
 * @param {...string} keys
 * @returns {T|undefined}
 */
export function readEither(obj, ...keys) {
  if (!isObject(obj)) return undefined;
  for (const key of keys) {
    const value = own(obj, key);
    if (value !== undefined) return /** @type {T} */ (value);
  }
  return undefined;
}
