/**
 * Amadeus Flight Offers Search ↔ SDK conversions (docs/BACKEND-MAPPING.md §6 `search.js`, §2.2,
 * §3.1–3.8, §4 C‑4/C‑6/C‑8/C‑9/C‑10/C‑11/C‑12/C‑13/C‑15/C‑16/C‑17/C‑18): the request builders for the
 * POST body (`toSearchRequest`), the GET fast path (`toQuickSearchQuery`), flexible dates and nearby
 * alternatives, and the response converters that turn `FlightOffer`s into the domain model
 * (`SearchSession`, `Offer`, `Slice`, `Segment`, `PriceBreakdown`, `PaxPrice`, `BaggageAllowance`,
 * `Conditions`, `Amenity`, `DateGrid`), plus the fan‑out merge of per‑slice one‑way searches and the
 * segment‑signature matcher used by `search.refresh`. Everything is a pure function: no I/O, no state,
 * no timers, no DOM, no logging, no module or network access; inputs are never mutated and the untouched
 * `FlightOffer` is kept on `Offer.raw`. Facets, summary highlights and tags are left to
 * `modules/filters.js` (placeholders here); the only error ever thrown is `ValidationError`.
 */

import { ValidationError } from '../../errors/index.js';
import { sum as sumMoney, compare as compareMoney, subtract as subtractMoney } from '../../utils/money.js';
import { durationBetween, dayDiff } from '../../utils/datetime.js';
import {
  toMoney,
  toDateTime,
  parseIsoDuration,
  normalizeDate,
  PAX_TYPE,
  CABIN,
  AMENITY_TYPE,
  ADDITIONAL_SERVICE_TYPE,
  toWire,
  fromWire,
  resolveCarrier,
  resolveAircraft,
  resolvePlace,
  scopeId,
  readEither,
} from './common.js';

/** @typedef {import('../../types.js').Money} Money */
/** @typedef {import('../../types.js').DateStr} DateStr */
/** @typedef {import('../../types.js').DateTime} DateTime */
/** @typedef {import('../../types.js').CabinClass} CabinClass */
/** @typedef {import('../../types.js').PaxType} PaxType */
/** @typedef {import('../../types.js').SearchParams} SearchParams */
/** @typedef {import('../../types.js').SliceRequest} SliceRequest */
/** @typedef {import('../../types.js').PaxCounts} PaxCounts */
/** @typedef {import('../../types.js').SearchSession} SearchSession */
/** @typedef {import('../../types.js').Offer} Offer */
/** @typedef {import('../../types.js').SliceOffer} SliceOffer */
/** @typedef {import('../../types.js').Slice} Slice */
/** @typedef {import('../../types.js').Segment} Segment */
/** @typedef {import('../../types.js').Layover} Layover */
/** @typedef {import('../../types.js').Amenity} Amenity */
/** @typedef {import('../../types.js').PriceBreakdown} PriceBreakdown */
/** @typedef {import('../../types.js').PaxPrice} PaxPrice */
/** @typedef {import('../../types.js').BaggageAllowance} BaggageAllowance */
/** @typedef {import('../../types.js').BagRule} BagRule */
/** @typedef {import('../../types.js').Conditions} Conditions */
/** @typedef {import('../../types.js').FareRules} FareRules */
/** @typedef {import('../../types.js').DateGrid} DateGrid */
/** @typedef {import('../../types.js').Facets} Facets */
/** @typedef {import('../../types.js').Issue} Issue */
/** @typedef {import('../../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('./common.js').Dictionaries} Dictionaries */
/** @typedef {import('./common.js').PlacesLookup} PlacesLookup */
/** @typedef {import('./common.js').TzLookup} TzLookup */

/**
 * Amadeus `GetFlightOffersQuery` request body (`POST /v2/shopping/flight-offers`); the facade adds the
 * vendor media type and the `X-HTTP-Method-Override: GET` header (C‑5).
 * @typedef {Record<string, any>} GetFlightOffersQuery
 */

/**
 * Amadeus Flight Offers Search response envelope: `{ data: FlightOffer[], meta, dictionaries, warnings }`
 * (the facade may add `meta.sessionId` / `meta.expiresAt`, C‑4).
 * @typedef {{ data?: Record<string, any>[], meta?: Record<string, any>, dictionaries?: Dictionaries, warnings?: Issue[] }} SearchEnvelope
 */

/**
 * Config‑level inputs of the request builders (what `modules/search.js` reads from `ctx.config` and
 * `bootstrap.limits` and hands over).
 * @typedef {Object} SearchRequestOptions
 * @property {string[]} [sources] content sources (`GDS`, `LTC`, `PYTON`, `EAC`, `NDC`), default `['GDS']`
 * @property {number} [maxUpsellOffers] inline branded upsells per best offer, 0..6 (omitted when 0)
 * @property {'per_slice'|'combined'} [resultMode] default when `params.resultMode` is absent
 * @property {{ maxFlightOffers?: number, nearbyRadiusKm?: number }} [limits] bootstrap limits
 * @property {string} [currency] default currency when `params.currency` is absent
 * @property {string[]} [corporateCodes] negotiated‑fare codes from bootstrap (`fareTypes` corporate)
 * @property {Record<string, string[]>} [alliances] alliance → carrier codes for the C‑15 expansion
 * @property {boolean} [oneFlightOfferPerDay] ask for at least one offer per day of a date window
 * @property {boolean} [crossBorderAllowed] allow nearby airports across a border (radius searches)
 * @property {number} [maxPrice] GET path: maximum price per traveler (integer)
 */

/**
 * Conversion context shared by the response converters: the session the ids are scoped to, the
 * response `dictionaries`, the optional `places` hydration source (C‑19; its `tz` values also attach the
 * UTC offsets, C‑1) or an explicit `tz` lookup, the facade expiry copied to every offer, and the search
 * params (requested cabin fallback, seated‑pax count for `seatsLeft`). `fromFlightOffer` adds `offerId`,
 * `travelerPricings` and `tp0` for the slice / segment converters.
 * @typedef {Object} ConvertContext
 * @property {string} [sessionId]
 * @property {Dictionaries} [dictionaries]
 * @property {PlacesLookup} [places]
 * @property {TzLookup} [tz]
 * @property {DateTime} [expiresAt]
 * @property {SearchParams} [params]
 * @property {CabinClass} [cabin]
 * @property {string} [offerId]
 * @property {number} [sliceIndex]
 * @property {number} [segmentIndex]
 * @property {Record<string, any>[]} [travelerPricings]
 * @property {Record<string, any>} [tp0]
 */

/**
 * Options of `fromSearchResponse` / `mergeOneWaySearches`: `ConvertContext` fields plus the facade TTL
 * inputs (`expiresAt` directly, or `now` + `ttlMs` when the envelope carries no expiry) and, for the
 * fan‑out merge, one session id per slice response.
 * @typedef {ConvertContext & { resultMode?: 'per_slice'|'combined', now?: number, ttlMs?: number, sessionIds?: string[] }} SessionOptions
 */

// ── constants ───────────────────────────────────────────────────────────────────────────────────

const DEFAULT_SOURCES = Object.freeze(['GDS']);
const MAX_SLICES = 6;
const MAX_FLIGHT_OFFERS = 250;
const MAX_UPSELL_OFFERS = 6;
const MAX_CARRIER_CODES = 99;
const MAX_RADIUS_KM = 300;
const DEFAULT_NEARBY_RADIUS_KM = 100;
const MAX_FLEX_DAYS = 3;
const MAX_TIME_WINDOW_HOURS = 12;
const MINUTES_PER_DAY = 24 * 60;
const MAX_INCLUDED_CONNECTION_POINTS = 2;
const MAX_EXCLUDED_CONNECTION_POINTS = 3;
const MAX_GET_PAX = 9;
const DEFAULT_SESSION_TTL_MS = 20 * 60 * 1000;
const LB_TO_KG = 0.4536;
const SEATS_UNLIMITED = 9;
const IATA_RE = /^[A-Z]{3}$/;
const CARRIER_RE = /^[0-9A-Z]{2}$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** `FareType` → Amadeus traveler type when the fare is a traveler category (C‑11). */
const FARE_TYPE_TRAVELER = Object.freeze({ student: 'STUDENT', youth: 'YOUNG', senior: 'SENIOR' });
/** Fare types with no Amadeus equivalent: dropped here, rejected by `search.validate` (C‑11). */
const UNSUPPORTED_FARE_TYPES = new Set(['armed_forces', 'doctor']);
const REFUND_CATEGORIES = new Set(['REFUND', 'CANCELLATION']);
const CHANGE_CATEGORIES = new Set(['EXCHANGE', 'REISSUE', 'REBOOK', 'REVALIDATION']);
/** Wire traveler types an infant may be associated with. */
const ADULT_TYPES = new Set(['ADULT', 'YOUNG', 'SENIOR', 'STUDENT']);

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {v is Record<string, any>} */
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

/** Non‑negative whole count out of a loosely typed value (`'2'`, `2.0`), `0` otherwise. */
function count(v) {
  const n = num(v);
  return n !== undefined && n > 0 ? Math.floor(n) : 0;
}

/** Integer clamped to `[min, max]`, `undefined` when not a number. */
function clampInt(v, min, max) {
  const n = num(v);
  if (n === undefined) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Array of objects out of anything. @returns {Record<string, any>[]} */
function objects(v) {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

/** Distinct values, first occurrence wins. @template T @param {T[]} list @returns {T[]} */
function uniq(list) {
  return [...new Set(list)];
}

/** Upper‑cased trimmed code or `undefined`. */
function code(v) {
  const s = str(v)?.trim().toUpperCase();
  return s || undefined;
}

/** One decimal place. */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Weight in kg from an Amadeus `{ weight, weightUnit }` (LB → kg, C‑16). */
function weightKg(weight, unit) {
  const w = num(weight);
  if (w === undefined) return undefined;
  return code(unit) === 'LB' ? round1(w * LB_TO_KG) : w;
}

/** @returns {ValidationIssue} */
function issue(path, issueCode, message, params) {
  /** @type {ValidationIssue} */
  const out = { path, code: issueCode, message };
  if (params) out.params = params;
  return out;
}

/** Zero `Money` in `currency` (`{ amount: '0', currency: '' }` when the currency is unknown). */
function zero(currency) {
  return toMoney('0', currency) ?? { amount: '0', currency: '' };
}

/**
 * Σ of Amadeus `{ amount }` entries (fees, taxes, discounts, additional services) in `currency`; a
 * `currencyCode` on an entry wins over the enclosing currency. Zero when nothing sums; falls back to
 * the first readable amount when `utils/money` rejects the figures (unknown currency, verbatim text).
 * @param {unknown} entries
 * @param {string} currency
 * @returns {Money}
 */
function sumAmounts(entries, currency) {
  const monies = objects(entries)
    .map((entry) => toMoney(entry.amount, str(entry.currencyCode) ?? currency))
    .filter((m) => m !== undefined);
  if (monies.length === 0) return zero(currency);
  try {
    return sumMoney(monies, currency || undefined);
  } catch {
    return { amount: monies[0].amount, currency: monies[0].currency };
  }
}

/** `a − b − c` or `undefined` when the figures do not compute. */
function safeDifference(a, b, c) {
  try {
    return subtractMoney(subtractMoney(a, b), c);
  } catch {
    return undefined;
  }
}

/** `a < b` by value; numeric fallback when `utils/money` rejects the operands. */
function lessThan(a, b) {
  try {
    return compareMoney(a, b) < 0;
  } catch {
    return Number(a.amount) < Number(b.amount);
  }
}

/** Minutes from `a` to `b` (offset‑aware when both carry one, else wall clock); `undefined` on bad input. */
function safeMinutesBetween(a, b) {
  try {
    return durationBetween(a, b);
  } catch {
    return undefined;
  }
}

/** Local calendar days from `a` to `b`; `0` on bad input. */
function safeDayDiff(a, b) {
  try {
    return dayDiff(a, b);
  } catch {
    return 0;
  }
}

/** ISO expiry `now + ttlMs` when a clock value is given (the facade TTL fallback, C‑4). */
function expiryFrom(now, ttlMs) {
  const at = num(now);
  if (at === undefined) return undefined;
  return new Date(at + (num(ttlMs) ?? DEFAULT_SESSION_TTL_MS)).toISOString();
}

/** Earliest of a list of ISO timestamps (string compare on same‑format values), `undefined` when none. */
function earliest(values) {
  const list = values.filter((v) => typeof v === 'string' && v !== '');
  return list.length ? list.slice().sort()[0] : undefined;
}

/** Placeholder `Facets` until `filters.computeFacets` runs. @returns {Facets} */
function emptyFacets() {
  return {
    stops: [],
    airlines: [],
    alliances: [],
    price: { min: 0, max: 0, histogram: [] },
    duration: { min: 0, max: 0 },
    layover: { min: 0, max: 0 },
    layoverAirports: [],
    departure: {},
    arrival: {},
    aircraft: [],
    features: { baggageIncluded: 0, refundable: 0, selfTransfer: 0 },
  };
}

// ── request side (§2.2, §3.1) ───────────────────────────────────────────────────────────────────

/** Lower‑cased, supported `fareTypes` (armed_forces / doctor dropped, C‑11). @returns {string[]} */
function fareTypesOf(params) {
  if (!Array.isArray(params.fareTypes)) return [];
  return uniq(
    params.fareTypes
      .filter((t) => typeof t === 'string')
      .map((t) => t.toLowerCase())
      .filter((t) => !UNSUPPORTED_FARE_TYPES.has(t))
  );
}

/** `HH:mm[:ss]` → minutes of day (`'24:00'` → 1440), `undefined` when malformed. */
function parseClock(text) {
  const m = CLOCK_RE.exec(String(text ?? '').trim());
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] ?? '0');
  if (hh > 24 || mm > 59 || ss > 59 || (hh === 24 && (mm > 0 || ss > 0))) return undefined;
  return hh * 60 + mm + (ss >= 30 ? 1 : 0);
}

/** Minutes of day → `hh:mm:ss`. */
function clock(minutes) {
  const m = Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
}

/**
 * `SliceRequest.timeWindow` (`{ from, to }`, local `HH:mm`) → the symmetric Amadeus window: `time` is
 * the centre of the range and `timeWindow` half its span in hours, rounded up (1..12 H). An open bound
 * means midnight (`{ from: '18:00' }` ⇒ 18:00–24:00 ⇒ `21:00:00` ± `3H`). Malformed clocks and empty
 * ranges are reported as issues.
 * @returns {{ time: string, timeWindow: string }|undefined}
 */
function timeRange(window, path, issues) {
  if (!isObject(window) || (window.from === undefined && window.to === undefined)) return undefined;
  const from = window.from === undefined ? 0 : parseClock(window.from);
  const to = window.to === undefined ? MINUTES_PER_DAY : parseClock(window.to);
  if (from === undefined || to === undefined) {
    issues.push(issue(path, 'invalid_time', 'timeWindow bounds must be HH:mm local times'));
    return undefined;
  }
  if (to <= from) {
    issues.push(issue(path, 'invalid_range', 'timeWindow.to must be later than timeWindow.from'));
    return undefined;
  }
  const span = to - from;
  const hours = Math.min(MAX_TIME_WINDOW_HOURS, Math.max(1, Math.ceil(span / 120)));
  return { time: clock(from + span / 2), timeWindow: `${hours}H` };
}

/** Nearby‑airport radius in km when the search asks for it (clamped to the 300 km limit), else `undefined`. */
function nearbyRadius(params, options) {
  const explicit = num(params.nearbyRadiusKm);
  if (params.includeNearby !== true && !(explicit !== undefined && explicit > 0)) return undefined;
  const limits = isObject(options.limits) ? options.limits : {};
  const radius = explicit ?? num(limits.nearbyRadiusKm) ?? DEFAULT_NEARBY_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, Math.max(1, radius));
}

/** Validated IATA code list (upper‑cased, deduped) with a size cap; issues on bad codes / overflow. */
function iataList(values, path, max, issues) {
  if (!Array.isArray(values)) return undefined;
  const codes = uniq(values.map(code).filter((c) => c !== undefined));
  const bad = codes.filter((c) => !IATA_RE.test(c));
  if (bad.length) issues.push(issue(path, 'invalid_iata', 'IATA codes are three letters', { bad }));
  if (codes.length > max) {
    issues.push(issue(path, 'too_many', `at most ${max} codes are supported`, { max }));
  }
  return codes.length ? codes : undefined;
}

/**
 * `slices[]` → `originDestinations[]` (§2.2, §3.1): ids `'1'..`, codes upper‑cased, the departure
 * range with `time` / `timeWindow` / `dateWindow` (`I{n}D`), nearby radii when asked for, connection
 * points from `via`. Radii exclude date / time windows (C‑13): the combination is an issue, not a drop.
 */
function buildOriginDestinations(params, options, issues) {
  const slices = Array.isArray(params.slices) ? params.slices : [];
  if (slices.length === 0) issues.push(issue('slices', 'required', 'at least one slice is required'));
  if (slices.length > MAX_SLICES) {
    issues.push(issue('slices', 'too_many', `at most ${MAX_SLICES} slices are supported`));
  }
  const radius = nearbyRadius(params, options);
  const via = isObject(params.via) ? params.via : {};
  const included = iataList(via.include, 'via.include', MAX_INCLUDED_CONNECTION_POINTS, issues);
  const excluded = iataList(via.exclude, 'via.exclude', MAX_EXCLUDED_CONNECTION_POINTS, issues);

  return slices.map((slice, i) => {
    const path = `slices[${i}]`;
    const s = isObject(slice) ? slice : {};
    const origin = code(s.origin);
    const destination = code(s.destination);
    const date = normalizeDate(s.date);
    if (!origin || !IATA_RE.test(origin)) {
      issues.push(issue(`${path}.origin`, 'invalid_iata', 'origin must be a three-letter IATA code'));
    }
    if (!destination || !IATA_RE.test(destination)) {
      issues.push(
        issue(`${path}.destination`, 'invalid_iata', 'destination must be a three-letter IATA code')
      );
    }
    if (!date) issues.push(issue(`${path}.date`, 'invalid_date', 'date must be YYYY-MM-DD'));

    /** @type {Record<string, any>} */
    const range = { date };
    const flexDays = count(s.flexDays);
    if (flexDays > MAX_FLEX_DAYS) {
      issues.push(issue(`${path}.flexDays`, 'max', `flexDays cannot exceed ${MAX_FLEX_DAYS}`));
    }
    const window = timeRange(s.timeWindow, `${path}.timeWindow`, issues);
    if (radius !== undefined) {
      if (flexDays > 0) {
        issues.push(
          issue(`${path}.flexDays`, 'incompatible', 'flexDays cannot be combined with nearby airports')
        );
      }
      if (window) {
        issues.push(
          issue(
            `${path}.timeWindow`,
            'incompatible',
            'timeWindow cannot be combined with nearby airports'
          )
        );
      }
    } else {
      if (flexDays > 0) range.dateWindow = `I${Math.min(MAX_FLEX_DAYS, flexDays)}D`;
      if (window) Object.assign(range, window);
    }

    /** @type {Record<string, any>} */
    const od = {
      id: String(i + 1),
      originLocationCode: origin ?? '',
      destinationLocationCode: destination ?? '',
      departureDateTimeRange: range,
    };
    if (radius !== undefined) {
      od.originRadius = radius;
      od.destinationRadius = radius;
    }
    if (included) od.includedConnectionPoints = included;
    if (excluded) od.excludedConnectionPoints = excluded;
    return od;
  });
}

/**
 * `PaxCounts` → `travelers[]` (§2.2, §3.1, C‑6): ids `'1'..'N'`; adults first (typed STUDENT / YOUNG /
 * SENIOR when `fareTypes` says so), then children, seated infants, youth, seniors, and held infants last,
 * each tied to the n‑th adult through `associatedAdultId`. `fareOptions: ['STANDARD']` is sent for
 * regular fares (the default). More lap infants than adults is an issue.
 */
function buildTravelers(passengers, fareTypes, issues) {
  const p = isObject(passengers) ? passengers : {};
  const adultFare = fareTypes.find((t) => FARE_TYPE_TRAVELER[t] !== undefined);
  const adultType = adultFare ? FARE_TYPE_TRAVELER[adultFare] : 'ADULT';
  const standard = fareTypes.length === 0 || fareTypes.includes('regular');
  /** @type {Record<string, any>[]} */
  const travelers = [];
  const push = (travelerType, associatedAdultId) => {
    /** @type {Record<string, any>} */
    const t = { id: String(travelers.length + 1), travelerType };
    if (associatedAdultId) t.associatedAdultId = associatedAdultId;
    if (standard) t.fareOptions = ['STANDARD'];
    travelers.push(t);
    return t.id;
  };
  for (let i = 0; i < count(p.adults); i++) push(adultType);
  for (let i = 0; i < count(p.children); i++) push('CHILD');
  for (let i = 0; i < count(p.infantsSeated); i++) push('SEATED_INFANT');
  for (let i = 0; i < count(p.youth); i++) push('YOUNG');
  for (let i = 0; i < count(p.seniors); i++) push('SENIOR');
  const adultIds = travelers.filter((t) => ADULT_TYPES.has(t.travelerType)).map((t) => t.id);
  const infants = count(p.infants);
  if (infants > adultIds.length) {
    issues.push(
      issue('passengers.infants', 'infants_exceed_adults', 'each lap infant needs one adult', {
        infants,
        adults: adultIds.length,
      })
    );
  } else {
    for (let i = 0; i < infants; i++) push('HELD_INFANT', adultIds[i]);
  }
  if (travelers.length === 0) {
    issues.push(issue('passengers', 'required', 'at least one traveler is required'));
  }
  return travelers;
}

/** Carrier code list (upper‑cased, deduped) with the alliance expansion folded in (C‑15). */
function carrierList(values, allianceCodes, path, issues) {
  const raw = [...(Array.isArray(values) ? values : []), ...allianceCodes];
  const codes = uniq(raw.map(code).filter((c) => c !== undefined));
  const bad = codes.filter((c) => !CARRIER_RE.test(c));
  if (bad.length) {
    issues.push(issue(path, 'invalid_carrier', 'carrier codes are two alphanumerics', { bad }));
  }
  if (codes.length > MAX_CARRIER_CODES) {
    issues.push(
      issue(path, 'too_many', `at most ${MAX_CARRIER_CODES} carrier codes are supported`, {
        max: MAX_CARRIER_CODES,
      })
    );
  }
  return codes.length ? codes : undefined;
}

/** Carrier codes of the requested alliances through the optional `options.alliances` lookup. */
function allianceCarriers(params, options) {
  if (!Array.isArray(params.alliances) || !isObject(options.alliances)) return [];
  return params.alliances.flatMap((name) => {
    const key = typeof name === 'string' ? name : '';
    const entry =
      options.alliances[key] ??
      options.alliances[key.toLowerCase()] ??
      options.alliances[key.toUpperCase()];
    return Array.isArray(entry) ? entry : [];
  });
}

/**
 * `searchCriteria` (§2.2): offer / upsell caps, `addOneWayOffers` (C‑8), the `additionalInformation`
 * flags, `pricingOptions` (corporate fares, refundable, bags included) and `flightFilters` (cabin with
 * coverage, carriers, connections, cross‑border).
 */
function buildSearchCriteria(params, options, fareTypes, odIds, issues) {
  const limits = isObject(options.limits) ? options.limits : {};
  /** @type {Record<string, any>} */
  const criteria = {
    maxFlightOffers: clampInt(limits.maxFlightOffers, 1, MAX_FLIGHT_OFFERS) ?? MAX_FLIGHT_OFFERS,
  };
  const upsell = clampInt(options.maxUpsellOffers, 0, MAX_UPSELL_OFFERS);
  if (upsell) criteria.maxUpsellOffers = upsell;
  const resultMode = params.resultMode ?? options.resultMode ?? 'per_slice';
  criteria.addOneWayOffers = resultMode !== 'combined';
  if (options.oneFlightOfferPerDay === true) criteria.oneFlightOfferPerDay = true;
  criteria.additionalInformation = { chargeableCheckedBags: true, brandedFares: true, fareRules: true };

  /** @type {Record<string, any>} */
  const pricingOptions = {};
  if (fareTypes.includes('corporate')) {
    pricingOptions.fareType = ['CORPORATE'];
    const codes = uniq(
      [...(Array.isArray(params.corporateCodes) ? params.corporateCodes : []), ...(Array.isArray(options.corporateCodes) ? options.corporateCodes : [])]
        .map(code)
        .filter((c) => c !== undefined)
    );
    if (codes.length) pricingOptions.corporateCodes = codes.slice(0, 6);
  }
  if (params.refundableOnly === true) pricingOptions.refundableFare = true;
  if (params.baggageIncluded === true) pricingOptions.includedCheckedBagsOnly = true;
  if (Object.keys(pricingOptions).length) criteria.pricingOptions = pricingOptions;

  /** @type {Record<string, any>} */
  const filters = {};
  const cabin = toWire(CABIN, params.cabin);
  if (cabin) {
    filters.cabinRestrictions = [
      {
        cabin,
        coverage: params.allowMixedCabin === true ? 'MOST_SEGMENTS' : 'ALL_SEGMENTS',
        originDestinationIds: odIds,
      },
    ];
  }
  const airlines = isObject(params.airlines) ? params.airlines : {};
  const includedCarrierCodes = carrierList(
    airlines.include,
    allianceCarriers(params, options),
    'airlines.include',
    issues
  );
  const excludedCarrierCodes = carrierList(airlines.exclude, [], 'airlines.exclude', issues);
  if (includedCarrierCodes || excludedCarrierCodes) {
    filters.carrierRestrictions = {};
    if (includedCarrierCodes) filters.carrierRestrictions.includedCarrierCodes = includedCarrierCodes;
    if (excludedCarrierCodes) filters.carrierRestrictions.excludedCarrierCodes = excludedCarrierCodes;
  }
  /** @type {Record<string, any>} */
  const connection = {};
  const maxStops = clampInt(params.maxStops, 0, 2);
  if (params.directOnly === true) connection.maxNumberOfConnections = 0;
  else if (maxStops !== undefined) connection.maxNumberOfConnections = maxStops;
  if (params.allowSelfTransfer === true) connection.airportChangeAllowed = true;
  if (Object.keys(connection).length) filters.connectionRestriction = connection;
  if (options.crossBorderAllowed === true) filters.crossBorderAllowed = true;
  if (Object.keys(filters).length) criteria.flightFilters = filters;
  return criteria;
}

/** `sources[]` (defaults to `['GDS']`), upper‑cased and deduped. */
function sourceList(values) {
  const list = Array.isArray(values) ? uniq(values.map(code).filter((c) => c !== undefined)) : [];
  return list.length ? list : [...DEFAULT_SOURCES];
}

/**
 * `SearchParams` → `GetFlightOffersQuery` body for `POST /v2/shopping/flight-offers` (§2.2, §3.1, C‑8,
 * C‑10, C‑11, C‑12, C‑13, C‑15): `slices[]` → `originDestinations[]` (ids `'1'..`, date / time /
 * `dateWindow 'I{n}D'` or nearby radii), `passengers` → `travelers[]` (ids, `associatedAdultId` for lap
 * infants, STUDENT / YOUNG / SENIOR traveler types for those fare types, `fareOptions ['STANDARD']`),
 * `cabin` → `cabinRestrictions` with coverage (`MOST_SEGMENTS` when mixed cabins are allowed) over every
 * OD, `airlines` / `alliances` → `carrierRestrictions`, `directOnly` / `maxStops` /
 * `allowSelfTransfer` → `connectionRestriction`, `refundableOnly` / `baggageIncluded` / corporate →
 * `pricingOptions`, `via` → connection points, `currency` → `currencyCode`, `sources` (config, default
 * GDS), `maxFlightOffers` from `limits`, `maxUpsellOffers`, `additionalInformation` all on, and
 * `addOneWayOffers: true` unless `resultMode === 'combined'`. `maxDurationMinutes`, `context`,
 * `childAges` and unsupported fare types (armed_forces / doctor) are not sent. The input is not mutated.
 * @param {SearchParams} params
 * @param {SearchRequestOptions} [options]
 * @returns {GetFlightOffersQuery}
 * @throws {ValidationError} with `issues[]` for missing / malformed slices, IATA or carrier codes,
 *   more lap infants than adults, no travelers, `flexDays` > 3, invalid time windows, and the C‑13
 *   combination of nearby airports with `flexDays` / `timeWindow`
 */
export function toSearchRequest(params, options = {}) {
  const p = isObject(params) ? params : {};
  const o = isObject(options) ? options : {};
  /** @type {ValidationIssue[]} */
  const issues = [];
  const fareTypes = fareTypesOf(p);
  const originDestinations = buildOriginDestinations(p, o, issues);
  const travelers = buildTravelers(p.passengers, fareTypes, issues);
  const searchCriteria = buildSearchCriteria(
    p,
    o,
    fareTypes,
    originDestinations.map((od) => od.id),
    issues
  );
  if (issues.length) throw new ValidationError('Invalid search parameters', { issues });
  /** @type {GetFlightOffersQuery} */
  const body = {};
  const currency = code(p.currency ?? o.currency);
  if (currency) body.currencyCode = currency;
  body.originDestinations = originDestinations;
  body.travelers = travelers;
  body.sources = sourceList(p.sources ?? o.sources);
  body.searchCriteria = searchCriteria;
  return body;
}

/**
 * `SearchParams` → query parameters of the GET fast path (`GET /v2/shopping/flight-offers`,
 * `search.createQuick`): one or two bounds between the same airports, adults / children / infants,
 * `travelClass`, included / excluded airline codes (comma‑separated), `nonStop`, `currencyCode`,
 * `maxPrice` and `max`. The GET path has no filters: anything it cannot express (multi‑city or open‑jaw
 * trips, seated infants / youth / seniors, date or time windows, nearby airports, connection points,
 * `maxStops` 1–2, refundable / bags‑only, non‑regular fare types, more than 9 of a passenger type) is
 * rejected with `ValidationError{ code: 'unsupported' }` so the module falls back to the POST path.
 * @param {SearchParams} params
 * @param {SearchRequestOptions} [options]
 * @returns {Record<string, string|number|boolean>}
 * @throws {ValidationError}
 */
export function toQuickSearchQuery(params, options = {}) {
  const p = isObject(params) ? params : {};
  const o = isObject(options) ? options : {};
  /** @type {ValidationIssue[]} */
  const issues = [];
  const unsupported = (path, what) =>
    issues.push(issue(path, 'unsupported', `${what} is not supported by the quick search path`));

  const slices = Array.isArray(p.slices) ? p.slices.filter(isObject) : [];
  const first = slices[0] ?? {};
  const origin = code(first.origin);
  const destination = code(first.destination);
  const departureDate = normalizeDate(first.date);
  if (slices.length === 0 || !origin || !destination || !departureDate) {
    issues.push(issue('slices[0]', 'required', 'origin, destination and date are required'));
  }
  if (slices.length > 2) unsupported('slices', 'multi-city');
  const second = slices[1];
  if (second && (code(second.origin) !== destination || code(second.destination) !== origin)) {
    unsupported('slices[1]', 'an open-jaw return');
  }
  slices.forEach((s, i) => {
    if (count(s.flexDays) > 0) unsupported(`slices[${i}].flexDays`, 'flexDays');
    if (isObject(s.timeWindow)) unsupported(`slices[${i}].timeWindow`, 'timeWindow');
  });
  if (p.includeNearby === true || num(p.nearbyRadiusKm) > 0) {
    unsupported('includeNearby', 'nearby airports');
  }
  if (isObject(p.via)) unsupported('via', 'connection points');
  const maxStops = clampInt(p.maxStops, 0, 2);
  if (maxStops !== undefined && maxStops > 0) unsupported('maxStops', 'maxStops');
  if (p.refundableOnly === true) unsupported('refundableOnly', 'refundableOnly');
  if (p.baggageIncluded === true) unsupported('baggageIncluded', 'baggageIncluded');
  const fareTypes = fareTypesOf(p);
  if (fareTypes.some((t) => t !== 'regular')) unsupported('fareTypes', 'special fare types');

  const pax = isObject(p.passengers) ? p.passengers : {};
  const adults = count(pax.adults);
  const children = count(pax.children);
  const infants = count(pax.infants);
  if (adults < 1) issues.push(issue('passengers.adults', 'min', 'at least one adult is required'));
  if (adults > MAX_GET_PAX || children > MAX_GET_PAX || infants > MAX_GET_PAX) {
    unsupported('passengers', 'more than 9 passengers of one type');
  }
  if (infants > adults) {
    issues.push(issue('passengers.infants', 'infants_exceed_adults', 'each lap infant needs one adult'));
  }
  for (const key of ['infantsSeated', 'youth', 'seniors']) {
    if (count(pax[key]) > 0) unsupported(`passengers.${key}`, key);
  }

  const airlines = isObject(p.airlines) ? p.airlines : {};
  const included = carrierList(
    airlines.include,
    allianceCarriers(p, o),
    'airlines.include',
    issues
  );
  if (Array.isArray(p.alliances) && p.alliances.length && !isObject(o.alliances)) {
    unsupported('alliances', 'alliances without a carrier expansion');
  }
  const excluded = carrierList(airlines.exclude, [], 'airlines.exclude', issues);
  if (issues.length) throw new ValidationError('Invalid quick search parameters', { issues });

  /** @type {Record<string, string|number|boolean>} */
  const query = { originLocationCode: origin, destinationLocationCode: destination, departureDate };
  if (second) query.returnDate = normalizeDate(second.date) ?? '';
  query.adults = adults;
  if (children) query.children = children;
  if (infants) query.infants = infants;
  const travelClass = toWire(CABIN, p.cabin);
  if (travelClass) query.travelClass = travelClass;
  if (included) query.includedAirlineCodes = included.join(',');
  if (excluded) query.excludedAirlineCodes = excluded.join(',');
  if (p.directOnly === true || maxStops === 0) query.nonStop = true;
  const currency = code(p.currency ?? o.currency);
  if (currency) query.currencyCode = currency;
  const maxPrice = clampInt(o.maxPrice, 1, Number.MAX_SAFE_INTEGER);
  if (maxPrice !== undefined) query.maxPrice = maxPrice;
  const limits = isObject(o.limits) ? o.limits : {};
  const max = clampInt(limits.maxFlightOffers, 1, MAX_FLIGHT_OFFERS);
  if (max !== undefined) query.max = max;
  return query;
}

/**
 * Request body of `search.flexibleDates` (§2.2): the whole‑trip search with `dateWindow 'I{days}D'`
 * on every slice (`days` clamped to 1..3, the Amadeus limit), `oneFlightOfferPerDay: true` and
 * combined offers only (`addOneWayOffers: false`), so `toDateGrid` can place one price per date pair.
 * Nearby airports cannot be combined with a date window (C‑13).
 * @param {SearchParams} params
 * @param {number} [days=3]
 * @param {SearchRequestOptions} [options]
 * @returns {GetFlightOffersQuery}
 * @throws {ValidationError}
 */
export function toFlexibleDatesRequest(params, days = MAX_FLEX_DAYS, options = {}) {
  const p = isObject(params) ? params : {};
  const o = isObject(options) ? options : {};
  if (p.includeNearby === true || num(p.nearbyRadiusKm) > 0) {
    throw new ValidationError('Flexible dates cannot be combined with nearby airports', {
      issues: [
        issue(
          'includeNearby',
          'incompatible',
          'a date window cannot be combined with nearby airports (C-13)'
        ),
      ],
    });
  }
  const window = clampInt(days, 1, MAX_FLEX_DAYS) ?? MAX_FLEX_DAYS;
  const slices = (Array.isArray(p.slices) ? p.slices : []).map((s) =>
    isObject(s) ? { ...s, flexDays: window } : s
  );
  return toSearchRequest(
    { ...p, slices, resultMode: 'combined', includeNearby: false, nearbyRadiusKm: undefined },
    { ...o, oneFlightOfferPerDay: true }
  );
}

/**
 * The two bodies behind `search.nearbyAlternatives` (§2.2, C‑13): `[airportsBody, datesBody]`.
 * The first searches nearby airports (`originRadius` / `destinationRadius` = `nearbyRadiusKm`, default
 * 100 km, `crossBorderAllowed`) with every date / time window stripped; the second searches adjacent
 * dates (`dateWindow 'I3D'`, `oneFlightOfferPerDay`) without radii. Both ask for combined offers only.
 * Radius and date window are mutually exclusive on Amadeus, hence two calls.
 * @param {SearchParams} params
 * @param {SearchRequestOptions} [options]
 * @returns {[GetFlightOffersQuery, GetFlightOffersQuery]}
 * @throws {ValidationError}
 */
export function toNearbyRequests(params, options = {}) {
  const p = isObject(params) ? params : {};
  const o = isObject(options) ? options : {};
  const slices = Array.isArray(p.slices) ? p.slices : [];
  const base = { ...p, resultMode: 'combined' };
  const airports = toSearchRequest(
    {
      ...base,
      slices: slices.map((s) => {
        if (!isObject(s)) return s;
        const { flexDays: _flexDays, timeWindow: _timeWindow, ...rest } = s;
        return rest;
      }),
      includeNearby: true,
      nearbyRadiusKm: num(p.nearbyRadiusKm) ?? DEFAULT_NEARBY_RADIUS_KM,
    },
    { ...o, crossBorderAllowed: true }
  );
  const dates = toSearchRequest(
    {
      ...base,
      slices: slices.map((s) => (isObject(s) ? { ...s, flexDays: MAX_FLEX_DAYS } : s)),
      includeNearby: false,
      nearbyRadiusKm: undefined,
    },
    { ...o, oneFlightOfferPerDay: true }
  );
  return [airports, dates];
}

// ── response side: leaf converters (§3.4–3.8) ───────────────────────────────────────────────────

/**
 * `fareDetailsBySegment[].amenities[]` (+ `mealServices[]`) → `Amenity[]` (§3.4): `type` through
 * `AMENITY_TYPE` (WIFI → wifi, SEAT → seat_pitch, BEVERAGE → meal, others lower‑cased), `value` /
 * `label` ← `description`, `paid` ← `isChargeable`, `code` kept; a SEAT entry's `amenitySeat` becomes
 * the value (`'42 inches, normal'`). Meal services become `{ type: 'meal', value: label }`. Non‑array
 * input gives `[]`.
 * @param {Record<string, any>[]|null|undefined} list
 * @param {{ label?: string }[]|null|undefined} [mealServices]
 * @returns {Amenity[]}
 */
export function fromAmenities(list, mealServices) {
  /** @type {Amenity[]} */
  const out = [];
  for (const a of objects(list)) {
    /** @type {Amenity} */
    const amenity = { type: fromWire(AMENITY_TYPE, a.amenityType) ?? 'other' };
    const description = str(a.description);
    if (description) {
      amenity.value = description;
      amenity.label = description;
    }
    if (isObject(a.amenitySeat)) {
      const parts = [];
      const legSpace = num(a.amenitySeat.legSpace);
      if (legSpace !== undefined) {
        parts.push(`${legSpace} ${String(a.amenitySeat.spaceUnit ?? '').toLowerCase()}`.trim());
      }
      const tilt = str(a.amenitySeat.tilt);
      if (tilt) parts.push(tilt.toLowerCase().replace(/_/g, ' '));
      if (parts.length) amenity.value = parts.join(', ');
    }
    if (typeof a.isChargeable === 'boolean') amenity.paid = a.isChargeable;
    const amenityCode = str(a.code);
    if (amenityCode) amenity.code = amenityCode;
    out.push(amenity);
  }
  for (const meal of objects(mealServices)) {
    const label = str(meal.label);
    if (label) out.push({ type: 'meal', value: label, label, paid: false });
  }
  return out;
}

/** `BaggageAllowance` / chargeable bag → `BagRule`, `undefined` when it carries no allowance. */
function bagRule(allowance, included, price) {
  if (!isObject(allowance)) return undefined;
  const quantity = num(allowance.quantity);
  const kg = weightKg(allowance.weight, allowance.weightUnit);
  const hasAllowance = (quantity !== undefined && quantity > 0) || (kg !== undefined && kg > 0);
  if (included && !hasAllowance) return undefined;
  if (!included && !hasAllowance && !price) return undefined;
  /** @type {BagRule} */
  const rule = { included };
  if (quantity !== undefined) rule.quantity = quantity;
  if (kg !== undefined) rule.weightKg = kg;
  if (price) rule.price = price;
  return rule;
}

/** `price.additionalServices[]` amounts by `AdditionalServiceType` (first‑extra‑bag prices, §3.7). */
function additionalServicePrices(price) {
  /** @type {Record<string, Money>} */
  const out = {};
  if (!isObject(price)) return out;
  for (const entry of objects(price.additionalServices)) {
    const type = code(entry.type);
    const money = toMoney(entry.amount, price);
    if (type && money && out[type] === undefined) out[type] = money;
  }
  return out;
}

/**
 * `travelerPricings[]` → `BaggageAllowance` (§3.7, C‑16): one item per passenger type × segment
 * (`bySegment: true`), `checked` from `includedCheckedBags` (piece or weight, LB → kg) plus the
 * chargeable first extra bag (`additionalServices.chargeableCheckedBags` priced from the offer‑level
 * `price.additionalServices[CHECKED_BAGS]`), `cabin` from `includedCabinBags` / `chargeableCabinBags`.
 * `options.offerId` scopes `segmentId` like `Segment.id`; without it the wire segment id is kept.
 * `dimensionsCm` is never known.
 * @param {Record<string, any>[]|null|undefined} tps
 * @param {{ offerId?: string, price?: Record<string, any> }} [options]
 * @returns {BaggageAllowance}
 */
export function fromBaggage(tps, options = {}) {
  const o = isObject(options) ? options : {};
  const prices = additionalServicePrices(o.price);
  const seen = new Set();
  /** @type {BaggageAllowance['items']} */
  const items = [];
  for (const tp of objects(tps)) {
    const paxType = /** @type {PaxType} */ (fromWire(PAX_TYPE, tp.travelerType) ?? 'ADT');
    if (seen.has(paxType)) continue;
    seen.add(paxType);
    for (const fd of objects(readEither(tp, 'fareDetailsBySegment', 'fareDetailBySegment'))) {
      const extra = isObject(fd.additionalServices) ? fd.additionalServices : {};
      const checked = [
        bagRule(fd.includedCheckedBags, true),
        bagRule(extra.chargeableCheckedBags, false, prices.CHECKED_BAGS),
      ].filter((r) => r !== undefined);
      const cabin = [
        bagRule(fd.includedCabinBags, true),
        bagRule(extra.chargeableCabinBags, false, prices.CABIN_BAGS),
      ].filter((r) => r !== undefined);
      /** @type {BaggageAllowance['items'][number]} */
      const item = { paxType, cabin, checked };
      if (fd.segmentId !== undefined && fd.segmentId !== null) {
        item.segmentId = o.offerId ? scopeId(o.offerId, fd.segmentId) : String(fd.segmentId);
      }
      items.push(item);
    }
  }
  return { bySegment: true, items };
}

/** Largest `maxPenaltyAmount` of a rule list as `Money`, `undefined` when none. */
function maxPenalty(rules, currency) {
  let best;
  for (const rule of rules) {
    const amount = toMoney(rule.maxPenaltyAmount, currency);
    if (!amount) continue;
    if (!best || lessThan(best, amount)) best = amount;
  }
  return best;
}

/** `maxPenaltyAmount` > 0 (an `'A'` suffix tolerated). */
function positiveAmount(v) {
  const n = Number(String(v ?? '').replace(/[aA]$/, ''));
  return Number.isFinite(n) && n > 0;
}

/**
 * `FlightOffer.fareRules` (+ `pricingOptions`) → `{ conditions, fareRules }` (§3.8): `refundable`
 * from the REFUND / CANCELLATION rules (`!notApplicable`; `'partial'` when chargeable with a penalty
 * amount), `changeable` from EXCHANGE / REISSUE / REBOOK / REVALIDATION, the largest penalty of each
 * group as `cancelPenalty` / `changePenalty` in `fareRules.currency`, `holdAllowed` ←
 * `!instantTicketingRequired` when that flag is given, `notes` from the rule descriptions and
 * circumstances. Without rules the `pricingOptions` flags decide (`refundableFare`, `noPenaltyFare` /
 * `noRestrictionFare`), else both are `false`. `fareRules.penalties[]` carries every priced rule
 * (`when` ← `circumstances`, default `'before_departure'`) and `raw[]` the description texts.
 * @param {Record<string, any>|null|undefined} fareRules
 * @param {Record<string, any>|null|undefined} [pricingOptions]
 * @param {{ instantTicketingRequired?: boolean }} [options]
 * @returns {{ conditions: Conditions, fareRules: FareRules }}
 */
export function fromFareRules(fareRules, pricingOptions, options = {}) {
  const fr = isObject(fareRules) ? fareRules : {};
  const po = isObject(pricingOptions) ? pricingOptions : {};
  const o = isObject(options) ? options : {};
  const currency = str(fr.currency) ?? '';
  const rules = objects(fr.rules);
  const category = (r) => code(r.category) ?? '';
  const applicable = (r) => r.notApplicable !== true;
  const refundRules = rules.filter((r) => REFUND_CATEGORIES.has(category(r)));
  const changeRules = rules.filter((r) => CHANGE_CATEGORIES.has(category(r)));

  /** @type {Conditions['refundable']} */
  let refundable;
  if (refundRules.length) {
    const open = refundRules.filter(applicable);
    if (!open.length) refundable = false;
    else if (open.some((r) => r.isChargeable === true && positiveAmount(r.maxPenaltyAmount))) {
      refundable = 'partial';
    } else refundable = true;
  } else refundable = po.refundableFare === true;
  const changeable = changeRules.length
    ? changeRules.some(applicable)
    : po.noPenaltyFare === true || po.noRestrictionFare === true;

  /** @type {Conditions} */
  const conditions = { refundable, changeable };
  const changePenalty = maxPenalty(changeRules.filter(applicable), currency);
  const cancelPenalty = maxPenalty(refundRules.filter(applicable), currency);
  if (changePenalty) conditions.changePenalty = changePenalty;
  if (cancelPenalty) conditions.cancelPenalty = cancelPenalty;
  if (typeof o.instantTicketingRequired === 'boolean') {
    conditions.holdAllowed = !o.instantTicketingRequired;
  }
  const notes = uniq(
    rules.flatMap((r) => [
      ...objects(r.descriptions).map((d) => str(d.text)),
      str(r.circumstances),
    ]).filter((t) => t !== undefined)
  );
  if (notes.length) conditions.notes = notes;

  /** @type {FareRules['penalties']} */
  const penalties = [];
  for (const r of rules) {
    if (!applicable(r)) continue;
    const amount = toMoney(r.maxPenaltyAmount, currency);
    if (!amount) continue;
    const cat = category(r);
    if (!REFUND_CATEGORIES.has(cat) && !CHANGE_CATEGORIES.has(cat)) continue;
    penalties.push({
      type: REFUND_CATEGORIES.has(cat) ? 'cancel' : 'change',
      when: str(r.circumstances) ?? 'before_departure',
      amount,
    });
  }
  /** @type {FareRules} */
  const out = { summary: { ...conditions }, penalties };
  const raw = rules.flatMap((r) =>
    objects(r.descriptions)
      .filter((d) => str(d.text))
      .map((d) => ({
        title: [category(r), str(d.descriptionType)].filter(Boolean).join(' · '),
        text: /** @type {string} */ (str(d.text)),
      }))
  );
  if (raw.length) out.raw = raw;
  return { conditions, fareRules: out };
}

/** Itemised `{ code, label, amount }` lines (§3.5 `items[]`). */
function priceItems(p, tps, currency) {
  /** @type {NonNullable<PriceBreakdown['items']>} */
  const items = [];
  const push = (itemCode, label, amount) => {
    if (amount) items.push({ code: itemCode, label, amount });
  };
  const offerTaxes = objects(p.taxes);
  if (offerTaxes.length) {
    for (const tax of offerTaxes) {
      const taxCode = str(tax.code) ?? 'TAX';
      push(taxCode, `Tax ${taxCode}`, toMoney(tax.amount, currency));
    }
  } else {
    // Offer‑level taxes are often absent: aggregate the per‑traveler lines by code.
    /** @type {Map<string, unknown[]>} */
    const byCode = new Map();
    for (const tp of tps) {
      for (const tax of objects(isObject(tp.price) ? tp.price.taxes : undefined)) {
        const taxCode = str(tax.code) ?? 'TAX';
        if (!byCode.has(taxCode)) byCode.set(taxCode, []);
        byCode.get(taxCode).push(tax);
      }
    }
    for (const [taxCode, entries] of byCode) {
      push(taxCode, `Tax ${taxCode}`, sumAmounts(entries, currency));
    }
  }
  for (const fee of objects(p.fees)) {
    const type = code(fee.type) ?? 'FEE';
    push(type, `${type.toLowerCase().replace(/_/g, ' ')} fee`, toMoney(fee.amount, currency));
  }
  for (const service of objects(p.additionalServices)) {
    const type = code(service.type) ?? 'OTHER_SERVICES';
    const amount = toMoney(service.amount, currency);
    const flagged = amount && 'additionalCollection' in amount;
    push(
      type,
      `${fromWire(ADDITIONAL_SERVICE_TYPE, type) ?? type}${flagged ? ' (additional collection)' : ''}`,
      amount
    );
  }
  for (const margin of objects(p.margins)) {
    const name = code(margin.name) ?? 'MARGIN';
    push(name, name.toLowerCase().replace(/_/g, ' '), toMoney(margin.amount, currency));
  }
  for (const discount of objects(p.discounts)) {
    const name = code(discount.name) ?? 'DISCOUNT';
    push(name, name.toLowerCase().replace(/_/g, ' '), toMoney(discount.amount, currency));
  }
  push('REFUNDABLE_TAXES', 'refundable taxes', toMoney(p.refundableTaxes, currency));
  return items;
}

/**
 * Amadeus `Extended_Price` / `Price` → `PriceBreakdown` (§3.5, C‑2): `total` ← `grandTotal ?? total`,
 * `base`, `fees` = Σ `fees[]`, `taxes` = Σ `travelerPricings[].price.taxes[]` (else offer‑level
 * `taxes[]`, else `total − base − fees`), `discounts` = Σ `discounts[]`, `ancillaries` = Σ
 * `additionalServices[]`, `perPax` ← first ADULT traveler's `price.total` (else `total`), `items[]`
 * (taxes by code, fees, additional services, margins, discounts, refundable taxes; `'A'` suffixes
 * flagged in the label), `refundableTaxes`, `margins[]` and `billing` from `billedPrice`. Every amount
 * gets the enclosing currency attached; nothing is ever held as a float.
 * @param {Record<string, any>|null|undefined} price
 * @param {Record<string, any>[]|null|undefined} [travelerPricings]
 * @param {Record<string, any>|null|undefined} [billedPrice]
 * @returns {PriceBreakdown}
 */
export function fromPrice(price, travelerPricings = [], billedPrice) {
  const p = isObject(price) ? price : {};
  const tps = objects(travelerPricings);
  const tp0 = tps.find((tp) => code(tp.travelerType) === 'ADULT') ?? tps[0];
  const currency =
    str(p.currency) ??
    str(p.currencyCode) ??
    str(isObject(tp0?.price) ? tp0.price.currency : undefined) ??
    '';
  const total = toMoney(p.grandTotal ?? p.total, currency) ?? zero(currency);
  const base = toMoney(p.base, currency) ?? zero(currency);
  const fees = sumAmounts(p.fees, currency);
  const travelerTaxes = tps.flatMap((tp) => objects(isObject(tp.price) ? tp.price.taxes : undefined));
  let taxes;
  if (travelerTaxes.length) taxes = sumAmounts(travelerTaxes, currency);
  else if (objects(p.taxes).length) taxes = sumAmounts(p.taxes, currency);
  else taxes = safeDifference(total, base, fees) ?? zero(currency);
  const perPax =
    (isObject(tp0?.price) ? toMoney(tp0.price.total, str(tp0.price.currency) ?? currency) : undefined) ??
    total;

  /** @type {PriceBreakdown} */
  const breakdown = { total, base, taxes, fees, perPax };
  if (objects(p.discounts).length) breakdown.discounts = sumAmounts(p.discounts, currency);
  if (objects(p.additionalServices).length) {
    breakdown.ancillaries = sumAmounts(p.additionalServices, currency);
  }
  const items = priceItems(p, tps, currency);
  if (items.length) breakdown.items = items;
  const refundableTaxes = toMoney(p.refundableTaxes, currency);
  if (refundableTaxes) breakdown.refundableTaxes = refundableTaxes;
  const margins = objects(p.margins)
    .map((m) => ({ type: (code(m.name) ?? 'margin').toLowerCase(), amount: toMoney(m.amount, currency) }))
    .filter((m) => m.amount !== undefined);
  if (margins.length) breakdown.margins = /** @type {PriceBreakdown['margins']} */ (margins);
  if (isObject(billedPrice)) {
    const billing = toMoney(billedPrice.grandTotal ?? billedPrice.total, billedPrice);
    if (billing) breakdown.billing = billing;
  }
  return breakdown;
}

/**
 * `travelerPricings[]` → `PaxPrice[]` (§3.6, C‑17): one entry per `travelerType` in order of first
 * appearance (ADULT → ADT …), `count` = group size, `unit` = the first member's `price` as a
 * `PriceBreakdown` (`perPax` = its total), `fareOption` of the first member and every `travelerId` of
 * the group (needed to rebuild `travelerPricings` for pricing / orders).
 * @param {Record<string, any>[]|null|undefined} tps
 * @returns {PaxPrice[]}
 */
export function fromTravelerPricings(tps) {
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const tp of objects(tps)) {
    const type = fromWire(PAX_TYPE, tp.travelerType) ?? 'ADT';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(tp);
  }
  /** @type {PaxPrice[]} */
  const out = [];
  for (const [type, members] of groups) {
    const first = members[0];
    /** @type {PaxPrice} */
    const pax = {
      type: /** @type {PaxType} */ (type),
      count: members.length,
      unit: fromPrice(first.price, [], first.billedPrice),
    };
    const fareOption = str(first.fareOption);
    if (fareOption) pax.fareOption = fareOption;
    const ids = members
      .map((m) => (m.travelerId === undefined || m.travelerId === null ? undefined : String(m.travelerId)))
      .filter((id) => id !== undefined);
    if (ids.length) pax.travelerIds = ids;
    out.push(pax);
  }
  return out;
}

// ── response side: segments, slices, offers (§3.2–3.4) ──────────────────────────────────────────

/** First ADULT `travelerPricings[]` entry, else the first one (`tp0` in the mapping). */
function firstAdult(tps) {
  const list = objects(tps);
  return list.find((tp) => code(tp.travelerType) === 'ADULT') ?? list[0];
}

/** `fareDetailsBySegment` entry of `tp` for the wire segment id (both spellings, C‑35). */
function fdbsFor(tp, segmentId) {
  if (!isObject(tp) || segmentId === undefined || segmentId === null) return undefined;
  const wanted = String(segmentId);
  return objects(readEither(tp, 'fareDetailsBySegment', 'fareDetailBySegment')).find(
    (d) => String(d.segmentId) === wanted
  );
}

/** Operating airline: `operating.carrierCode` (+ `carrierName`), name‑only carriers allowed (C‑18). */
function operatingAirline(operating, marketingCarrier, dict) {
  const op = isObject(operating) ? operating : {};
  const opCode = str(op.carrierCode);
  const opName = str(op.carrierName);
  if (opCode) {
    const resolved = resolveCarrier(opCode, dict) ?? { code: opCode, name: opCode };
    return opName && resolved.name === opCode ? { code: opCode, name: opName } : resolved;
  }
  if (opName) return { code: '', name: opName };
  return { ...marketingCarrier };
}

/** CO₂ of one segment in kg for the flown cabin (else the first entry), LB → kg (§3.2). */
function segmentEmissions(seg, cabinWire) {
  const entries = objects(seg.co2Emissions);
  if (!entries.length) return undefined;
  const match = entries.find((e) => code(e.cabin) === cabinWire) ?? entries[0];
  return weightKg(match.weight, match.weightUnit);
}

/** `cabinByPaxType` when travelers of different types fly different cabins on this segment (C‑10). */
function cabinByPaxType(travelerPricings, segmentId) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const tp of objects(travelerPricings)) {
    const cabin = fromWire(CABIN, fdbsFor(tp, segmentId)?.cabin);
    const type = fromWire(PAX_TYPE, tp.travelerType);
    if (cabin && type && map[type] === undefined) map[type] = cabin;
  }
  return new Set(Object.values(map)).size > 1 ? map : undefined;
}

/**
 * Amadeus `Segment` (+ the matching `fareDetailsBySegment` entry) → `Segment` (§3.4, C‑1, C‑10, C‑12):
 * id scoped under `ctx.offerId`, marketing / operating carriers and aircraft through the dictionaries,
 * places through `resolvePlace` (partial until hydrated, C‑19), `departureAt` / `arrivalAt` with the
 * airport offset attached when `ctx.tz` / `ctx.places` know the zone (else `localTimeOnly: true`),
 * duration from the ISO string (else the difference), cabin / RBD / fare basis / brand from `fdbs`
 * (cabin falls back to the requested one), terminals, amenities, `technicalStops[]` from `stops[]`
 * (never counted as connections), `blacklistedInEU`, `emissionsKg`, included checked bags, the
 * post‑booking `status` / `flown` / `segmentType` and `cabinByPaxType` when travelers differ.
 * @param {Record<string, any>} seg
 * @param {Record<string, any>|null|undefined} fdbs
 * @param {ConvertContext} [ctx]
 * @returns {Segment}
 */
export function fromSegment(seg, fdbs, ctx = {}) {
  const s = isObject(seg) ? seg : {};
  const f = isObject(fdbs) ? fdbs : {};
  const c = isObject(ctx) ? ctx : {};
  const dict = c.dictionaries;
  const tz = c.tz ?? c.places;
  const departure = isObject(s.departure) ? s.departure : {};
  const arrival = isObject(s.arrival) ? s.arrival : {};
  const wireId = s.id === undefined || s.id === null ? String((num(c.segmentIndex) ?? 0) + 1) : s.id;
  const marketingCarrier = resolveCarrier(s.carrierCode, dict) ?? { code: '', name: '' };
  const dep = toDateTime(departure.at, str(departure.iataCode), tz);
  const arr = toDateTime(arrival.at, str(arrival.iataCode), tz);
  const departureAt = dep?.value ?? '';
  const arrivalAt = arr?.value ?? '';
  const localTimeOnly = (dep?.localTimeOnly ?? true) || (arr?.localTimeOnly ?? true);
  const cabinWire = code(f.cabin);

  /** @type {Segment} */
  const segment = {
    id: scopeId(c.offerId, wireId),
    marketingCarrier,
    operatingCarrier: operatingAirline(s.operating, marketingCarrier, dict),
    flightNumber: s.number === undefined || s.number === null ? '' : String(s.number),
    origin: resolvePlace(departure.iataCode, dict, c.places) ?? { code: '' },
    destination: resolvePlace(arrival.iataCode, dict, c.places) ?? { code: '' },
    departureAt,
    arrivalAt,
    durationMinutes:
      parseIsoDuration(s.duration) ?? safeMinutesBetween(departureAt, arrivalAt) ?? 0,
    cabin: /** @type {CabinClass} */ (fromWire(CABIN, cabinWire) ?? c.cabin ?? 'economy'),
  };
  const aircraft = resolveAircraft(isObject(s.aircraft) ? s.aircraft.code : undefined, dict);
  if (aircraft) segment.aircraft = aircraft;
  const bookingClass = str(f.class);
  if (bookingClass) segment.bookingClass = bookingClass;
  const fareBasis = str(f.fareBasis);
  if (fareBasis) segment.fareBasis = fareBasis;
  const brandedFare = str(f.brandedFare);
  if (brandedFare) segment.brandedFare = brandedFare;
  const from = str(departure.terminal);
  const to = str(arrival.terminal);
  if (from || to) {
    segment.terminals = {};
    if (from) segment.terminals.from = from;
    if (to) segment.terminals.to = to;
  }
  const amenities = fromAmenities(f.amenities, f.mealServices);
  if (amenities.length) segment.amenities = amenities;
  if (localTimeOnly) segment.localTimeOnly = true;
  const stops = objects(s.stops);
  if (stops.length) {
    segment.technicalStops = stops.map((stop) => {
      const stopArrival = toDateTime(stop.arrivalAt, str(stop.iataCode), tz)?.value ?? '';
      const stopDeparture = toDateTime(stop.departureAt, str(stop.iataCode), tz)?.value ?? '';
      return {
        airport: resolvePlace(stop.iataCode, dict, c.places) ?? { code: '' },
        arrivalAt: stopArrival,
        departureAt: stopDeparture,
        durationMinutes:
          parseIsoDuration(stop.duration) ?? safeMinutesBetween(stopArrival, stopDeparture) ?? 0,
      };
    });
  }
  if (typeof s.blacklistedInEU === 'boolean') segment.blacklistedInEU = s.blacklistedInEU;
  const emissions = segmentEmissions(s, cabinWire);
  if (emissions !== undefined) segment.emissionsKg = emissions;
  if (isObject(f.includedCheckedBags)) {
    const quantity = num(f.includedCheckedBags.quantity);
    const kg = weightKg(f.includedCheckedBags.weight, f.includedCheckedBags.weightUnit);
    if (quantity !== undefined || kg !== undefined) {
      segment.includedCheckedBags = {};
      if (quantity !== undefined) segment.includedCheckedBags.quantity = quantity;
      if (kg !== undefined) segment.includedCheckedBags.weightKg = kg;
    }
  }
  const status = str(s.bookingStatus);
  if (status) segment.status = /** @type {Segment['status']} */ (status.toLowerCase());
  if (typeof s.isFlown === 'boolean') segment.flown = s.isFlown;
  const segmentType = str(s.segmentType);
  if (segmentType) segment.segmentType = /** @type {Segment['segmentType']} */ (segmentType.toLowerCase());
  const byPax = cabinByPaxType(c.travelerPricings, wireId);
  if (byPax) segment.cabinByPaxType = byPax;
  return segment;
}

/**
 * Connections between consecutive segments (§3.3, C‑1): the wait is computed from offset‑corrected
 * instants when both timestamps carry an offset, else from the wall clock with `localTimeOnly: true`
 * on the layover; `airportChange` when the next flight leaves from another airport, `overnight` by
 * local dates, `selfTransfer` always `false` for Amadeus content.
 * @param {Segment[]} segments
 * @returns {(Layover & { localTimeOnly?: true })[]}
 */
function buildLayovers(segments) {
  /** @type {(Layover & { localTimeOnly?: true })[]} */
  const layovers = [];
  for (let k = 1; k < segments.length; k++) {
    const prev = segments[k - 1];
    const next = segments[k];
    /** @type {Layover & { localTimeOnly?: true }} */
    const layover = {
      airport: next.origin,
      durationMinutes: safeMinutesBetween(prev.arrivalAt, next.departureAt) ?? 0,
      overnight: safeDayDiff(prev.arrivalAt, next.departureAt) >= 1,
      selfTransfer: false,
      airportChange: prev.destination.code !== next.origin.code,
    };
    if (prev.localTimeOnly || next.localTimeOnly) layover.localTimeOnly = true;
    layovers.push(layover);
  }
  return layovers;
}

/**
 * One `itineraries[]` entry → `Slice` (§3.3, C‑12): id `${offerId}:${sliceIndex}`, segments through
 * `fromSegment` with the first ADULT's fare details, origin / destination / times from the first and
 * last segment, duration from the ISO string (else segments + layovers), `stops` = connections
 * (technical stops stay on the segments), `layovers[]`, `fareBrand` ← `brandedFareLabel ?? brandedFare`
 * of the first segment and `dayChange` by local dates.
 * @param {Record<string, any>} it
 * @param {ConvertContext} [ctx]
 * @returns {Slice}
 */
export function fromItinerary(it, ctx = {}) {
  const i = isObject(it) ? it : {};
  const c = isObject(ctx) ? ctx : {};
  const sliceIndex = num(c.sliceIndex) ?? 0;
  const tp0 = isObject(c.tp0) ? c.tp0 : firstAdult(c.travelerPricings);
  const wireSegments = objects(i.segments);
  const segments = wireSegments.map((seg, idx) =>
    fromSegment(seg, fdbsFor(tp0, seg.id), { ...c, tp0, segmentIndex: idx })
  );
  const first = segments[0];
  const last = segments[segments.length - 1];
  const layovers = buildLayovers(segments);
  const summed =
    segments.reduce((acc, s) => acc + s.durationMinutes, 0) +
    layovers.reduce((acc, l) => acc + l.durationMinutes, 0);
  const departureAt = first?.departureAt ?? '';
  const arrivalAt = last?.arrivalAt ?? '';
  /** @type {Slice} */
  const slice = {
    id: c.offerId ? `${c.offerId}:${sliceIndex}` : String(sliceIndex),
    origin: first?.origin ?? { code: '' },
    destination: last?.destination ?? { code: '' },
    departureAt,
    arrivalAt,
    durationMinutes: parseIsoDuration(i.duration) ?? summed,
    stops: Math.max(0, segments.length - 1),
    segments,
    layovers,
    dayChange: safeDayDiff(departureAt, arrivalAt),
  };
  const firstFdbs = fdbsFor(tp0, wireSegments[0]?.id);
  const fareBrand = str(firstFdbs?.brandedFareLabel) ?? str(firstFdbs?.brandedFare);
  if (fareBrand) slice.fareBrand = fareBrand;
  return slice;
}

/** Seated passengers requested (ADT + CHD + INS + YTH + SRC), `undefined` without params (C‑9). */
function seatedPax(params) {
  if (!isObject(params) || !isObject(params.passengers)) return undefined;
  const p = params.passengers;
  return (
    count(p.adults) + count(p.children) + count(p.infantsSeated) + count(p.youth) + count(p.seniors)
  );
}

/** `FareFamily` of the offer itself from the branded‑fare fields of the first ADULT (§3.2, §3.9). */
function offerFareFamily(tp0, slices, offerId, currency) {
  const details = objects(readEither(tp0, 'fareDetailsBySegment', 'fareDetailBySegment'));
  const codes = uniq(details.map((d) => str(d.brandedFare)).filter((b) => b !== undefined));
  if (!codes.length) return undefined;
  const label = details.map((d) => str(d.brandedFareLabel)).find((l) => l !== undefined);
  /** @type {Map<string, import('../../types.js').FareFamily['features'][number]>} */
  const features = new Map();
  for (const slice of slices) {
    for (const segment of slice.segments) {
      for (const amenity of segment.amenities ?? []) {
        const key = amenity.code ?? `${amenity.type}:${amenity.label ?? ''}`;
        if (features.has(key)) continue;
        features.set(key, {
          code: key,
          label: amenity.label ?? amenity.type,
          included: amenity.paid ? 'fee' : true,
          type: amenity.type,
        });
      }
    }
  }
  /** @type {Record<string, string>} */
  const bySegment = {};
  for (const d of details) {
    const brand = str(d.brandedFare);
    if (brand && d.segmentId !== undefined) bySegment[scopeId(offerId, d.segmentId)] = brand;
  }
  return {
    code: codes.join('+'),
    name: label ?? codes.join('+'),
    tier: 0,
    offerId,
    priceDelta: zero(currency),
    features: [...features.values()],
    isCurrent: true,
    brandedFareBySegment: bySegment,
  };
}

/**
 * Amadeus `FlightOffer` → `Offer` (§3.2, C‑3, C‑7, C‑9, C‑17, C‑18); shared by the pricing, upsell and
 * order adapters. `id` = `scopeId(ctx.sessionId, fo.id)`, `owner` ← `validatingAirlineCodes[0]`
 * (else the first marketing carrier) through the dictionaries, `slices[]` via `fromItinerary`,
 * `price` / `passengers` / `baggage` / `conditions` via the leaf converters, `fareFamily` from the
 * branded‑fare fields, `tags: []` (filters tag later), `expiresAt` ← `ctx.expiresAt` (never
 * `lastTicketingDate`), one `tickets[]` group, `selfTransfer: false`, `bookableSeats` ←
 * `numberOfBookableSeats` with `seatsLeft` only below 9, `emissionsKg`, `source` / `sourceReference`,
 * the ticketing flags, `lastTicketingDate` / `ticketingDeadline`, `validatingAirlines`,
 * `oneWayCombinable` ← `oneWay`, `pricingOptions`, `billing`, `fareOptions`, `fareRules` when the
 * wire carried them, and the untouched `FlightOffer` on `raw`.
 * @param {Record<string, any>} fo
 * @param {ConvertContext} [ctx]
 * @returns {Offer}
 */
export function fromFlightOffer(fo, ctx = {}) {
  const f = isObject(fo) ? fo : {};
  const c = isObject(ctx) ? ctx : {};
  const dict = c.dictionaries;
  const id = scopeId(c.sessionId, f.id === undefined || f.id === null ? '' : f.id);
  const travelerPricings = objects(f.travelerPricings);
  const tp0 = firstAdult(travelerPricings);
  const itineraries = objects(f.itineraries);
  const validating = Array.isArray(f.validatingAirlineCodes)
    ? f.validatingAirlineCodes.filter((v) => typeof v === 'string' && v !== '')
    : [];
  const firstSegment = objects(itineraries[0]?.segments)[0];
  const owner = resolveCarrier(validating[0] ?? firstSegment?.carrierCode, dict) ?? {
    code: '',
    name: '',
  };
  const params = isObject(c.params) ? c.params : undefined;
  const sliceCtx = {
    ...c,
    offerId: id,
    travelerPricings,
    tp0,
    cabin: c.cabin ?? /** @type {CabinClass|undefined} */ (params?.cabin),
  };
  const slices = itineraries.map((it, i) => fromItinerary(it, { ...sliceCtx, sliceIndex: i }));
  const price = fromPrice(f.price, travelerPricings, f.billedPrice);
  const { conditions, fareRules } = fromFareRules(f.fareRules, f.pricingOptions, {
    instantTicketingRequired:
      typeof f.instantTicketingRequired === 'boolean' ? f.instantTicketingRequired : undefined,
  });

  /** @type {Offer} */
  const offer = {
    id,
    owner,
    slices,
    price,
    passengers: fromTravelerPricings(travelerPricings),
    baggage: fromBaggage(travelerPricings, { offerId: id, price: f.price }),
    conditions,
    tags: [],
    expiresAt: str(c.expiresAt) ?? '',
  };
  const fareFamily = offerFareFamily(tp0, slices, id, price.total.currency);
  if (fareFamily) offer.fareFamily = fareFamily;
  const segmentIds = slices.flatMap((s) => s.segments.map((seg) => seg.id));
  offer.tickets = [{ id: `${id}:t1`, segmentIds, carrier: owner }];
  offer.selfTransfer = false;
  const seats = num(f.numberOfBookableSeats);
  if (seats !== undefined) {
    offer.bookableSeats = seats;
    const seated = seatedPax(params);
    if (seats < SEATS_UNLIMITED && (seated === undefined || seats >= seated)) offer.seatsLeft = seats;
  }
  const emissions = slices.flatMap((s) => s.segments.map((seg) => seg.emissionsKg));
  if (emissions.some((e) => e !== undefined)) {
    offer.emissionsKg = round1(emissions.reduce((acc, e) => acc + (e ?? 0), 0));
  }
  const source = str(f.source);
  if (source) offer.source = source;
  const sourceReference = str(f.sourceReference);
  if (sourceReference) offer.sourceReference = sourceReference;
  if (typeof f.instantTicketingRequired === 'boolean') {
    offer.instantTicketingRequired = f.instantTicketingRequired;
  }
  if (typeof f.paymentCardRequired === 'boolean') offer.paymentCardRequired = f.paymentCardRequired;
  if (typeof f.nonHomogeneous === 'boolean') offer.multiplePnrs = f.nonHomogeneous;
  if (typeof f.isUpsellOffer === 'boolean') offer.isUpsell = f.isUpsellOffer;
  if (Array.isArray(f.upsellFlightOfferIds) && f.upsellFlightOfferIds.length) {
    offer.upsellOfferIds = f.upsellFlightOfferIds.map((u) => scopeId(c.sessionId, u));
  }
  const deadline = normalizeDate(f.lastTicketingDate) ?? normalizeDate(f.lastTicketingDateTime);
  if (deadline) {
    offer.lastTicketingDate = deadline;
    offer.ticketingDeadline = { date: deadline };
    const dateTime = str(f.lastTicketingDateTime);
    if (dateTime) offer.ticketingDeadline.dateTime = dateTime;
  }
  if (validating.length) offer.validatingAirlines = validating;
  if (typeof f.oneWay === 'boolean') offer.oneWayCombinable = f.oneWay;
  if (isObject(f.pricingOptions)) {
    const po = f.pricingOptions;
    /** @type {NonNullable<Offer['pricingOptions']>} */
    const pricingOptions = {};
    if (Array.isArray(po.fareType)) {
      pricingOptions.fareType = po.fareType
        .filter((t) => typeof t === 'string')
        .map((t) => /** @type {'published'|'negotiated'|'corporate'} */ (t.toLowerCase()));
    }
    if (Array.isArray(po.corporateCodes)) pricingOptions.corporateCodes = po.corporateCodes.map(String);
    for (const key of ['includedCheckedBagsOnly', 'refundableFare', 'noRestrictionFare', 'noPenaltyFare']) {
      if (typeof po[key] === 'boolean') pricingOptions[key] = po[key];
    }
    offer.pricingOptions = pricingOptions;
  }
  if (price.billing) offer.billing = price.billing;
  const fareOptions = uniq(travelerPricings.map((tp) => str(tp.fareOption)).filter((o) => o !== undefined));
  if (fareOptions.length) offer.fareOptions = fareOptions;
  if (isObject(f.fareRules)) {
    /** @type {Offer & { fareRules?: FareRules }} */ (offer).fareRules = fareRules;
  }
  offer.raw = fo;
  return offer;
}

// ── response side: sessions (§2.2, C‑4, C‑8) ────────────────────────────────────────────────────

/** Minimal `SearchParams` read back from the response when the caller passes none. */
function inferParams(data, currency) {
  const list = objects(data);
  const fo = list.find((o) => o.oneWay !== true) ?? list[0] ?? {};
  const slices = objects(fo.itineraries).map((it) => {
    const segments = objects(it.segments);
    const first = segments[0] ?? {};
    const last = segments[segments.length - 1] ?? {};
    return {
      origin: code(isObject(first.departure) ? first.departure.iataCode : undefined) ?? '',
      destination: code(isObject(last.arrival) ? last.arrival.iataCode : undefined) ?? '',
      date: normalizeDate(isObject(first.departure) ? first.departure.at : undefined) ?? '',
    };
  });
  /** @type {PaxCounts} */
  const passengers = { adults: 0, children: 0, infants: 0 };
  const tps = objects(fo.travelerPricings);
  for (const tp of tps) {
    switch (code(tp.travelerType)) {
      case 'CHILD':
        passengers.children++;
        break;
      case 'HELD_INFANT':
        passengers.infants++;
        break;
      case 'SEATED_INFANT':
        passengers.infantsSeated = (passengers.infantsSeated ?? 0) + 1;
        break;
      case 'YOUNG':
        passengers.youth = (passengers.youth ?? 0) + 1;
        break;
      case 'SENIOR':
        passengers.seniors = (passengers.seniors ?? 0) + 1;
        break;
      default:
        passengers.adults++;
    }
  }
  const roundTrip =
    slices.length === 2 &&
    slices[1].origin === slices[0].destination &&
    slices[1].destination === slices[0].origin;
  const cabin = fromWire(CABIN, objects(readEither(firstAdult(tps), 'fareDetailsBySegment', 'fareDetailBySegment'))[0]?.cabin);
  /** @type {SearchParams} */
  const params = {
    tripType: slices.length <= 1 ? 'one_way' : roundTrip ? 'round_trip' : 'multi_city',
    slices,
    passengers,
    cabin: /** @type {CabinClass} */ (cabin ?? 'economy'),
  };
  if (currency) params.currency = currency;
  return params;
}

/** Slice index of a one‑way offer missing from `oneWayCombinations`: match its route to `params.slices`. */
function inferSliceIndex(fo, params) {
  const slices = isObject(params) && Array.isArray(params.slices) ? params.slices : [];
  const segments = objects(objects(fo.itineraries)[0]?.segments);
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return 0;
  const origin = code(isObject(first.departure) ? first.departure.iataCode : undefined);
  const destination = code(isObject(last.arrival) ? last.arrival.iataCode : undefined);
  const date = normalizeDate(isObject(first.departure) ? first.departure.at : undefined);
  let fallback = -1;
  for (let i = 0; i < slices.length; i++) {
    const s = isObject(slices[i]) ? slices[i] : {};
    if (code(s.origin) !== origin || code(s.destination) !== destination) continue;
    if (normalizeDate(s.date) === date) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback < 0 ? 0 : fallback;
}

/**
 * `oneWay` offers + `meta.oneWayCombinations[]` → `sliceOffers[][]` (C‑8): each entry lists the one‑way
 * offers that fulfil one `originDestinationId`; an offer's `combinableWith` is every listed one‑way
 * offer of the other ODs (scoped ids, only those present in the response). Offers no entry names fall
 * back to the slice whose route they fly and keep `combinableWith` undefined (combinability unknown).
 * @returns {SliceOffer[][]}
 */
function groupSliceOffers(oneWay, combinations, ctx, params) {
  /** @type {Map<string, number>} */
  const sliceOfId = new Map();
  /** @type {Map<number, string[]>} */
  const idsBySlice = new Map();
  for (const entry of objects(combinations)) {
    const idx = num(entry.originDestinationId);
    if (idx === undefined || idx < 1) continue;
    const sliceIndex = Math.trunc(idx) - 1;
    const ids = (Array.isArray(entry.flightOfferIds) ? entry.flightOfferIds : []).map(String);
    if (!idsBySlice.has(sliceIndex)) idsBySlice.set(sliceIndex, []);
    for (const wireId of ids) {
      if (!sliceOfId.has(wireId)) sliceOfId.set(wireId, sliceIndex);
      idsBySlice.get(sliceIndex).push(wireId);
    }
  }
  const present = new Set(oneWay.map((fo) => String(fo.id)));
  const sliceCount = Math.max(
    isObject(params) && Array.isArray(params.slices) ? params.slices.length : 0,
    ...[...idsBySlice.keys()].map((k) => k + 1),
    1
  );
  /** @type {SliceOffer[][]} */
  const lists = Array.from({ length: sliceCount }, () => []);
  for (const fo of oneWay) {
    const wireId = String(fo.id);
    const listed = sliceOfId.has(wireId);
    const sliceIndex = listed ? sliceOfId.get(wireId) : inferSliceIndex(fo, params);
    while (lists.length <= sliceIndex) lists.push([]);
    /** @type {SliceOffer} */
    const sliceOffer = { ...fromFlightOffer(fo, ctx), sliceIndex };
    if (listed) {
      const others = [];
      for (const [idx, ids] of idsBySlice) {
        if (idx === sliceIndex) continue;
        for (const other of ids) if (present.has(other)) others.push(scopeId(ctx.sessionId, other));
      }
      sliceOffer.combinableWith = uniq(others);
    }
    if (sliceOffer.oneWayCombinable === undefined) sliceOffer.oneWayCombinable = true;
    lists[sliceIndex].push(sliceOffer);
  }
  return lists;
}

/**
 * Amadeus search envelope → `SearchSession` (§2.2, C‑4, C‑8): `id` ← `options.sessionId` (else the
 * facade's `meta.sessionId`), `status 'complete'`, `providersPending 0`; the non‑`oneWay` offers become
 * `offers[]`, the `oneWay` ones `sliceOffers[sliceIndex]` grouped through `meta.oneWayCombinations`
 * with `combinableWith` filled; `resultMode` is `'per_slice'` when slice offers exist and combined
 * results were not asked for, `meta.sessionMode` is `'native_split'` or `'combined'`, `meta.total` ←
 * `meta.count`, `meta.currency`, `meta.expiresAt` ← `options.expiresAt` / facade `meta.expiresAt` /
 * `now + ttlMs`, `meta.warnings` ← the envelope `warnings[]` (`Issue[]`). `facets` and `summary` are
 * placeholders for `filters.computeFacets` / `summarize`; every offer carries `tags: []`, the session
 * expiry and its untouched `FlightOffer` on `raw`. Places are hydrated from `options.places` (C‑19) and
 * their `tz` attaches the offsets (C‑1).
 * @param {SearchEnvelope} envelope
 * @param {SessionOptions} [options]
 * @returns {SearchSession}
 */
export function fromSearchResponse(envelope, options = {}) {
  const e = isObject(envelope) ? envelope : {};
  const o = isObject(options) ? options : {};
  const meta = isObject(e.meta) ? e.meta : {};
  const data = objects(e.data);
  const dictionaries = isObject(o.dictionaries) ? o.dictionaries : e.dictionaries;
  const sessionId = str(o.sessionId) ?? str(meta.sessionId) ?? '';
  const params = isObject(o.params) ? o.params : undefined;
  const expiresAt = str(o.expiresAt) ?? str(meta.expiresAt) ?? expiryFrom(o.now, o.ttlMs) ?? '';
  /** @type {ConvertContext} */
  const ctx = {
    sessionId,
    dictionaries,
    places: o.places,
    tz: o.tz,
    expiresAt,
    params,
    cabin: o.cabin ?? /** @type {CabinClass|undefined} */ (params?.cabin),
  };
  const combined = data.filter((fo) => fo.oneWay !== true);
  const oneWay = data.filter((fo) => fo.oneWay === true);
  const offers = combined.map((fo) => fromFlightOffer(fo, ctx));
  const sliceOffers = oneWay.length
    ? groupSliceOffers(oneWay, meta.oneWayCombinations, ctx, params)
    : undefined;
  const split = sliceOffers !== undefined && sliceOffers.some((list) => list.length > 0);
  const requestedCombined = (params?.resultMode ?? o.resultMode) === 'combined';
  const resultMode = split && !requestedCombined ? 'per_slice' : 'combined';
  const sliceCount = sliceOffers ? sliceOffers.reduce((acc, list) => acc + list.length, 0) : 0;
  const currency =
    offers[0]?.price.total.currency ||
    sliceOffers?.find((list) => list.length)?.[0].price.total.currency ||
    str(params?.currency) ||
    '';
  const warnings = objects(e.warnings);

  /** @type {SearchSession} */
  const session = {
    id: sessionId,
    status: 'complete',
    params: params ?? inferParams(data, currency),
    resultMode,
    offers,
    facets: emptyFacets(),
    summary: { count: resultMode === 'per_slice' ? sliceCount : offers.length },
    meta: {
      total: num(meta.count) ?? data.length,
      currency,
      expiresAt,
      providersPending: 0,
      sessionMode: split ? 'native_split' : 'combined',
    },
  };
  if (sliceOffers) session.sliceOffers = sliceOffers;
  if (warnings.length) session.meta.warnings = /** @type {Issue[]} */ (warnings);
  return session;
}

/**
 * Fan‑out mode (C‑8): one one‑way search envelope per slice (`responses[i]` ↔ `params.slices[i]`) →
 * one `SearchSession` with `sliceOffers[i]`, `offers: []`, `resultMode 'per_slice'` and
 * `meta.sessionMode 'fanout'`. Offers are converted with `sliceIndex: i`, `oneWayCombinable: true` and
 * `combinableWith` undefined (combinability is unknown until pricing validates a pair); each slice's
 * ids are scoped under its own session id (`options.sessionIds[i]`, else the response's
 * `meta.sessionId`, else `${sessionId}-${i}`) so they never collide. `meta.total` sums the counts,
 * `meta.warnings` concatenates the envelopes' warnings, `meta.expiresAt` is the earliest expiry. A
 * missing / failed response yields an empty slice list.
 * @param {(SearchEnvelope|null|undefined)[]} responses
 * @param {SessionOptions} [options]
 * @returns {SearchSession}
 */
export function mergeOneWaySearches(responses, options = {}) {
  const list = Array.isArray(responses) ? responses : [];
  const o = isObject(options) ? options : {};
  const params = isObject(o.params) ? o.params : undefined;
  const metas = list.map((r) => (isObject(r) && isObject(r.meta) ? r.meta : {}));
  const sessionId = str(o.sessionId) ?? metas.map((m) => str(m.sessionId)).find(Boolean) ?? '';
  const sessionIds = Array.isArray(o.sessionIds) ? o.sessionIds : [];
  const expiresAt =
    str(o.expiresAt) ??
    earliest(metas.map((m) => str(m.expiresAt))) ??
    expiryFrom(o.now, o.ttlMs) ??
    '';
  const sliceCount = Math.max(list.length, params && Array.isArray(params.slices) ? params.slices.length : 0);
  /** @type {SliceOffer[][]} */
  const sliceOffers = [];
  /** @type {Issue[]} */
  const warnings = [];
  let total = 0;
  let currency = '';
  for (let i = 0; i < sliceCount; i++) {
    const r = isObject(list[i]) ? list[i] : {};
    const meta = metas[i] ?? {};
    const data = objects(r.data);
    const sliceSessionId =
      str(sessionIds[i]) ?? str(meta.sessionId) ?? (sessionId ? `${sessionId}-${i}` : String(i));
    /** @type {ConvertContext} */
    const ctx = {
      sessionId: sliceSessionId,
      dictionaries: isObject(o.dictionaries) ? o.dictionaries : r.dictionaries,
      places: o.places,
      tz: o.tz,
      expiresAt,
      params,
      cabin: o.cabin ?? /** @type {CabinClass|undefined} */ (params?.cabin),
    };
    const wholeTrip = data.filter((fo) => fo.oneWay !== true);
    const source = wholeTrip.length ? wholeTrip : data;
    sliceOffers[i] = source.map((fo) => ({
      ...fromFlightOffer(fo, ctx),
      sliceIndex: i,
      oneWayCombinable: true,
    }));
    total += num(meta.count) ?? source.length;
    warnings.push(.../** @type {Issue[]} */ (objects(r.warnings)));
    if (!currency && sliceOffers[i][0]) currency = sliceOffers[i][0].price.total.currency;
  }
  const count = sliceOffers.reduce((acc, l) => acc + l.length, 0);
  /** @type {SearchSession} */
  const session = {
    id: sessionId,
    status: 'complete',
    params: params ?? inferParams(objects(isObject(list[0]) ? list[0].data : undefined), currency),
    resultMode: 'per_slice',
    offers: [],
    sliceOffers,
    facets: emptyFacets(),
    summary: { count },
    meta: {
      total,
      currency: currency || str(params?.currency) || '',
      expiresAt,
      providersPending: 0,
      sessionMode: 'fanout',
    },
  };
  if (warnings.length) session.meta.warnings = warnings;
  return session;
}

// ── grids and signatures (§2.2 flexibleDates / refresh) ─────────────────────────────────────────

/** Departure dates of an offer's slices (domain `Offer` or raw `FlightOffer`). @returns {(string|undefined)[]} */
function departureDates(offer) {
  if (Array.isArray(offer.slices)) {
    return offer.slices.map((s) => normalizeDate(isObject(s) ? s.departureAt : undefined));
  }
  return objects(offer.itineraries).map((it) => {
    const first = objects(it.segments)[0];
    return normalizeDate(first && isObject(first.departure) ? first.departure.at : undefined);
  });
}

/** Grand total of an offer (domain or raw), `undefined` when unpriced. */
function offerTotal(offer) {
  if (isObject(offer.price) && isObject(offer.price.total)) return offer.price.total;
  if (isObject(offer.price)) return toMoney(offer.price.grandTotal ?? offer.price.total, offer.price);
  return undefined;
}

/**
 * Offers of a flexible‑dates search → `DateGrid` (§2.2): `rows` = outbound dates, `cols` = return dates
 * (absent for one‑way, every row then has one cell), each cell the cheapest offer of that date pair
 * (`{ price, offerId }`) or `null` when no offer covers it (Amadeus returns at most 250 offers, not a
 * full matrix). Accepts converted `Offer`s (preferred) or raw `FlightOffer`s; unpriced offers are
 * skipped. Multi‑city offers contribute their first two slices.
 * @param {(Offer|Record<string, any>)[]} offers
 * @returns {DateGrid}
 */
export function toDateGrid(offers) {
  /** @type {Map<string, { price: Money, offerId?: string }>} */
  const cells = new Map();
  const rows = new Set();
  const cols = new Set();
  let hasReturn = false;
  for (const offer of objects(offers)) {
    const [out, back] = departureDates(offer);
    const price = offerTotal(offer);
    if (!out || !price) continue;
    rows.add(out);
    if (back) {
      hasReturn = true;
      cols.add(back);
    }
    const key = `${out}|${back ?? ''}`;
    const current = cells.get(key);
    if (!current || lessThan(price, current.price)) {
      /** @type {{ price: Money, offerId?: string }} */
      const cell = { price };
      const offerId = offer.id === undefined || offer.id === null ? undefined : String(offer.id);
      if (offerId) cell.offerId = offerId;
      cells.set(key, cell);
    }
  }
  const rowList = [...rows].sort();
  const colList = hasReturn ? [...cols].sort() : undefined;
  /** @type {DateGrid} */
  const grid = {
    rows: rowList,
    cells: rowList.map((r) => (colList ?? ['']).map((c) => cells.get(`${r}|${c}`) ?? null)),
  };
  if (colList) grid.cols = colList;
  return grid;
}

/** `YYYY-MM-DDTHH:mm` of a timestamp with or without seconds / offset. */
function wallMinute(at) {
  const text = str(at);
  return text ? text.slice(0, 16) : '';
}

/**
 * Segment signature of an offer (`carrierCode+number@departure.at` per segment, slices joined),
 * read from `raw` when present so domain and wire offers compare alike.
 * @returns {string|undefined}
 */
function offerSignature(offer) {
  if (!isObject(offer)) return undefined;
  const raw = isObject(offer.raw) ? offer.raw : offer;
  if (Array.isArray(raw.itineraries)) {
    return objects(raw.itineraries)
      .map((it) =>
        objects(it.segments)
          .map(
            (s) =>
              `${code(s.carrierCode) ?? ''}${s.number ?? ''}@${wallMinute(
                isObject(s.departure) ? s.departure.at : undefined
              )}`
          )
          .join('>')
      )
      .join('|');
  }
  if (Array.isArray(offer.slices)) {
    return objects(offer.slices)
      .map((slice) =>
        objects(slice.segments)
          .map(
            (s) =>
              `${code(isObject(s.marketingCarrier) ? s.marketingCarrier.code : undefined) ?? ''}${
                s.flightNumber ?? ''
              }@${wallMinute(s.departureAt)}`
          )
          .join('>')
      )
      .join('|');
  }
  return undefined;
}

/**
 * Whether two offers (domain `Offer`s or raw `FlightOffer`s, in any mix) fly the very same flights:
 * every slice's `carrierCode + number + departure.at` sequence matches (§2.2 `search.refresh`: ids
 * change on every response, so the selection is re‑matched by this signature). Offers without
 * segments never match.
 * @param {Offer|Record<string, any>|null|undefined} a
 * @param {Offer|Record<string, any>|null|undefined} b
 * @returns {boolean}
 */
export function matchOfferSignature(a, b) {
  const sa = offerSignature(a);
  const sb = offerSignature(b);
  return sa !== undefined && sa !== '' && sa === sb;
}
