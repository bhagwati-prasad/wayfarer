/**
 * Validation utilities for the Wayfarer SDK (docs/api/03-utils.md §4): a tiny schema runner
 * (`validate`) with the rules required / type / pattern / min / max / minLength / maxLength / enum /
 * custom / when / items / props, prebuilt `schemas` for the SDK's own inputs (search params,
 * travelers, contact, travel documents, GST, address, promo, card, password), stand‑alone validators
 * (email, E.164 phone, IATA, postal codes, passport numbers, GSTIN with checksum, PAN, UPI VPA, Luhn,
 * airline name rules), domain checks that return `ValidationIssue[]` (document expiry, passenger
 * counts, age vs passenger type), card brand / expiry helpers and the `issuesByPath` / `firstIssue`
 * helpers for UI binding. Every issue `message` is an i18n key (`validation.<code>`), never English
 * prose; `params` carries the interpolation data. Everything here is pure and SSR‑safe: no DOM,
 * storage, timers, network, module‑level mutable state or logging; the clock is read only at call
 * time and can be overridden (`ctx.today` / `ctx.now`, or the trailing `now` of `cardExpiryValid`).
 * User data never throws — it produces issues; a plain `Error` is never thrown, only
 * `ValidationError`, and only for malformed programmer input (a broken schema, an unparseable
 * reference date, inconsistent age bands). Nothing is ever mutated: neither the value under
 * validation nor the schemas.
 */

import { ValidationError } from '../errors/index.js';
import { addDays, ageAt, paxTypeForAge, today } from './datetime.js';

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../types.js').ValidationResult} ValidationResult */
/** @typedef {import('../types.js').DateStr} DateStr */
/** @typedef {import('../types.js').PaxType} PaxType */
/** @typedef {import('../types.js').PaxCounts} PaxCounts */
/** @typedef {import('../types.js').SearchParams} SearchParams */
/** @typedef {import('../types.js').Traveler} Traveler */
/** @typedef {import('../types.js').Contact} Contact */
/** @typedef {import('../types.js').TravelDocument} TravelDocument */
/** @typedef {import('../types.js').AgeRules} AgeRules */
/** @typedef {import('../types.js').TravelerRequirements} TravelerRequirements */
/** @typedef {import('../types.js').FieldRule} FieldRule */
/** @typedef {import('../types.js').DocumentRule} DocumentRule */
/** @typedef {import('../types.js').PassengerSlot} PassengerSlot */
/** @typedef {import('../types.js').Phone} Phone */
/** @typedef {import('../types.js').Address} Address */

/**
 * Structural type a rule may demand. `date` is a real `YYYY-MM-DD` calendar date (its mismatch code
 * is `date`, every other mismatch is `type`).
 * @typedef {'string'|'number'|'integer'|'boolean'|'object'|'array'|'date'} RuleType
 */

/**
 * Free‑form context handed to every `custom` / `when` function. The keys below are understood by the
 * runner and the prebuilt schemas; anything else is passed through untouched.
 * @typedef {{ path?: string, today?: DateStr, now?: number, travelDate?: DateStr, [key: string]: unknown }} ValidationContext
 *   `path` prefixes every issue path; `today` is the reference date for past / future checks
 *   (defaults to the host clock, or to `now` in epoch ms); `travelDate` enables the age‑vs‑type and
 *   document‑validity checks of `schemas.traveler` / `schemas.document`.
 */

/**
 * What `custom` and `when` receive next to the value.
 * @typedef {Object} RuleInfo
 * @property {unknown} value            the value under validation
 * @property {unknown} parent           the enclosing object / array (the root value itself for a top‑level rule)
 * @property {unknown} root             the value `validate` was called with
 * @property {string} path              full path of the node (`''` for the root)
 * @property {ValidationContext} ctx    the context given to `validate`
 */

/**
 * Anything a `custom` function may return: `true` / `null` / `undefined` / `[]` mean "valid";
 * `false` is an `invalid` issue at the node; a string is used as the issue code; an issue object
 * (its `path`, when given, is relative to the node and its `message` defaults to the i18n key) or a
 * list of any of these.
 * @typedef {boolean|string|null|undefined|Partial<ValidationIssue>|Array<string|Partial<ValidationIssue>>} CustomResult
 */

/**
 * One rule of the schema runner. Checks run in the order listed; an empty value (`undefined`,
 * `null`, a blank string or an empty array) only ever yields `required`, so `custom` never sees one.
 * `min` / `max` apply to numbers and, given as `YYYY-MM-DD` strings, to dates; `minLength` /
 * `maxLength` to strings and arrays.
 * @typedef {Object} Rule
 * @property {boolean} [required]                                  value must be present and non‑empty
 * @property {RuleType} [type]                                     structural type (stops further checks when it fails)
 * @property {RegExp|string} [pattern]                             strings / numbers must match
 * @property {number|DateStr} [min]                                lower bound (inclusive)
 * @property {number|DateStr} [max]                                upper bound (inclusive)
 * @property {number} [minLength]                                  minimum string / array length
 * @property {number} [maxLength]                                  maximum string / array length
 * @property {readonly unknown[]} [enum]                           allowed values (strict equality)
 * @property {(value: any, info: RuleInfo) => CustomResult} [custom]  last check, run only when the node's own
 *   checks (type / pattern / bounds / enum) passed; issues in `items` / `props` children never block it
 * @property {(parent: any, info: RuleInfo) => boolean} [when]     the rule applies only when this returns `true`
 * @property {Schema} [items]                                      schema for every array element (`path[i]`)
 * @property {Record<string, Schema>} [props]                      schemas for object properties (`path.key`); unknown keys are ignored
 */

/**
 * A schema node: a single rule or a list of rules applied in order, each with its own `when`.
 * @typedef {Rule|Rule[]} Schema
 */

/**
 * `bootstrap.limits` as consumed by `schemas.searchParams` (docs/QUESTIONS.md #4,
 * BACKEND-MAPPING.md C‑6). Every field is optional; the defaults are the Amadeus‑market ones.
 * @typedef {Object} SearchLimits
 * @property {number} [maxSeated=9]        seated passengers: adults + children + seated infants + youth + seniors
 * @property {number} [maxTotal=18]        all passengers including lap infants
 * @property {number} [maxPax]             alias of `maxTotal` (also caps `maxSeated` when that is not given)
 * @property {number} [infantPerAdult=1]   lap infants allowed per adult
 * @property {number} [maxLegs=6]          maximum slices
 * @property {number} [advanceDays=365]    how far ahead a departure may be
 * @property {number} [infantMax=2]        infant age band (exclusive upper bound)
 * @property {number} [childMax=12]        child age band (exclusive upper bound)
 * @property {Partial<AgeRules>} [ageRules] age bands given as `AgeRules` (flat keys win)
 * @property {string[]} [fareTypes]        special fares the market supports (default: every `FareType`)
 * @property {string[]} [cabins]           cabins the market supports (default: every `CabinClass`)
 */

/**
 * Password policy for `schemas.password`.
 * @typedef {Object} PasswordPolicy
 * @property {number} [minLength=8]
 * @property {number} [maxLength=128]
 * @property {boolean} [requireLower=false]
 * @property {boolean} [requireUpper=false]
 * @property {boolean} [requireDigit=false]
 * @property {boolean} [requireSymbol=false]
 * @property {number} [minClasses=0]        minimum number of character classes (lower / upper / digit / symbol)
 * @property {boolean} [allowSpaces=true]
 */

// ── constants ────────────────────────────────────────────────────────────────────────────────────

const RULE_TYPES = Object.freeze([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'date',
]);
const TRIP_TYPES = Object.freeze(['one_way', 'round_trip', 'multi_city']);
const CABINS = Object.freeze(['economy', 'premium_economy', 'business', 'first']);
const FARE_TYPES = Object.freeze([
  'regular',
  'student',
  'senior',
  'armed_forces',
  'doctor',
  'corporate',
  'youth',
]);
const PAX_TYPES = Object.freeze(['ADT', 'CHD', 'INF', 'INS', 'YTH', 'SRC', 'STU']);
const DOCUMENT_TYPES = Object.freeze(['passport', 'national_id', 'driving_licence', 'other']);
const GENDERS = Object.freeze(['M', 'F', 'X']);
/** `per_slice` (split) is the default result mode (docs/QUESTIONS.md decision 5); both are accepted. */
const RESULT_MODES = Object.freeze(['per_slice', 'combined']);
const FLEX_DAYS = Object.freeze([0, 1, 2, 3]);
const MAX_STOPS = Object.freeze([0, 1, 2]);
/** Age band of each passenger type: fare‑based adult types (YTH / SRC / STU) are adults by age. */
const AGE_CLASS = Object.freeze({
  ADT: 'ADT',
  YTH: 'ADT',
  SRC: 'ADT',
  STU: 'ADT',
  CHD: 'CHD',
  INF: 'INF',
  INS: 'INF',
});
const COUNT_FIELDS = Object.freeze([
  'adults',
  'children',
  'infants',
  'infantsSeated',
  'youth',
  'seniors',
]);
/** Types counted as accompanying adults (seniors / youth are adults on a special fare). */
const ADULT_FIELDS = Object.freeze(['adults', 'youth', 'seniors']);
const LIMIT_FIELDS = Object.freeze([
  'maxSeated',
  'maxTotal',
  'infantPerAdult',
  'maxLegs',
  'advanceDays',
  'infantMax',
  'childMax',
]);

/** @type {Readonly<Required<Omit<SearchLimits, 'maxPax'|'ageRules'|'fareTypes'|'cabins'>>>} */
const DEFAULT_LIMITS = Object.freeze({
  maxSeated: 9,
  maxTotal: 18,
  infantPerAdult: 1,
  maxLegs: 6,
  advanceDays: 365,
  infantMax: 2,
  childMax: 12,
});
/** @type {Readonly<AgeRules>} */
const DEFAULT_AGE_RULES = Object.freeze({
  infantMax: 2,
  childMax: 12,
  refDate: 'departure',
  infantPerAdult: 1,
  maxPax: 9,
});
const DEFAULT_NAME_RULES = Object.freeze({ maxLength: 60, charset: 'latin' });
/** @type {Readonly<Required<PasswordPolicy>>} */
const DEFAULT_PASSWORD_POLICY = Object.freeze({
  minLength: 8,
  maxLength: 128,
  requireLower: false,
  requireUpper: false,
  requireDigit: false,
  requireSymbol: false,
  minClasses: 0,
  allowSpaces: true,
});
const DEFAULT_TICKET_NAME_MAX = 60;
/** A card expiry further out than this is treated as a typo. */
const MAX_CARD_YEARS = 20;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const AIRLINE_RE = /^[A-Za-z0-9]{2}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;
const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IATA_RE = /^[A-Za-z]{3}$/;
const DOC_NUMBER_RE = /^[A-Za-z0-9-]{4,20}$/;
const PROMO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const ALNUM_ID_RE = /^[A-Za-z0-9]{4,25}$/;
const DIGITS_RE = /^\d+$/;
const EMAIL_LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const DIAL_CODE_RE = /^\+?[1-9]\d{0,2}$/;
const NATIONAL_NUMBER_RE = /^\d{4,14}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const PHONE_SEPARATORS_RE = /[\s().-]/g;
const CARD_SEPARATORS_RE = /[\s-]/g;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PAN_RE = /^[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]$/;
const VPA_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,255}@[A-Za-z][A-Za-z0-9]{1,63}$/;
const NAME_LATIN_RE = /^[A-Za-z]+(?:[ '’-][A-Za-z]+)*$/;
const NAME_ANY_RE = /^[\p{L}\p{M}]+(?:[ '’-][\p{L}\p{M}]+)*$/u;
const NAME_FILLER_RE = /[\s'’-]/g;
const CARD_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const LOWER_RE = /\p{Ll}/u;
const UPPER_RE = /\p{Lu}/u;
const DIGIT_RE = /\d/;
const SYMBOL_RE = /[^\p{L}\p{N}\s]/u;
const SPACE_RE = /\s/;

/** Postal code formats with a known shape; every other country takes `POSTAL_DEFAULT_RE`. */
const POSTAL_PATTERNS = Object.freeze({
  IN: /^[1-9]\d{2}\s?\d{3}$/,
  US: /^\d{5}(?:-\d{4})?$/,
  GB: /^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i,
  CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d$/i,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  AU: /^\d{4}$/,
});
const POSTAL_DEFAULT_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/;
/** Markets without postal codes: `schemas.address` does not require one there. */
const NO_POSTAL_CODE = Object.freeze(['AE', 'HK', 'MO', 'QA']);
/** Markets where a state / province is part of a deliverable address. */
const STATE_REQUIRED = Object.freeze(['US', 'CA', 'AU', 'IN']);

/** Passport number formats with a known shape; every other country takes the generic rule. */
const PASSPORT_PATTERNS = Object.freeze({
  IN: /^[A-PR-WY][1-9]\d{5}[1-9]$/i,
  US: /^(?:\d{9}|[A-Z]\d{8})$/i,
  GB: /^\d{9}$/,
});
const PASSPORT_DEFAULT_RE = /^[A-Z0-9]{6,9}$/i;

/** Card brand detection by prefix, most specific first (RuPay 60 / 65 / 81 / 82 / 508 after Discover's 6011 / 644‑649 / 622126‑622925). */
const CARD_BRANDS = Object.freeze([
  { brand: 'amex', re: /^3[47]/ },
  { brand: 'diners', re: /^3(?:0[0-5]|095|[689])/ },
  { brand: 'jcb', re: /^35(?:2[89]|[3-8]\d)/ },
  { brand: 'discover', re: /^6(?:011|4[4-9]|22(?:12[6-9]|1[3-9]\d|[2-8]\d\d|9[01]\d|92[0-5]))/ },
  { brand: 'rupay', re: /^(?:60|65|81|82|508)/ },
  { brand: 'mastercard', re: /^(?:5[1-5]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/ },
  { brand: 'visa', re: /^4/ },
]);

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

/**
 * Build one issue; the message is always the i18n key `validation.<code>`.
 * @param {string} path @param {string} code @param {object} [params]
 * @returns {ValidationIssue}
 */
function issue(path, code, params) {
  /** @type {ValidationIssue} */
  const out = { path, code, message: `validation.${code}` };
  if (params !== undefined) out.params = params;
  return out;
}

/**
 * Developer‑facing `ValidationError` for malformed programmer input (never for user data).
 * @param {string} message @param {string} path @param {string} code @param {object} [params]
 * @returns {ValidationError}
 */
function programmerError(message, path, code, params) {
  /** @type {ValidationIssue} */
  const it = { path, code, message };
  if (params) it.params = params;
  return new ValidationError(message, { issues: [it] });
}

/** Join a base path and a key / relative path (`a` + `b` → `a.b`, `a` + `[0]` → `a[0]`). */
function joinPath(base, key) {
  if (key === undefined || key === null || key === '') return base || '';
  const k = String(key);
  if (!base) return k;
  return k.startsWith('[') ? `${base}${k}` : `${base}.${k}`;
}

/** `true` for `undefined`, `null`, a blank string or an empty array. @param {unknown} v */
function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  return Array.isArray(v) && v.length === 0;
}

/** Human name of a value's structural type, for `type` issue params. @param {unknown} v */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A number above zero; `Infinity` counts, `NaN` does not. @param {unknown} v @returns {v is number} */
function isPositiveNumber(v) {
  return typeof v === 'number' && v > 0;
}

/** @param {unknown} v @returns {v is string} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** @param {unknown} v @returns {v is object} */
function isObjectLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * `true` for a real `YYYY-MM-DD` calendar date (any year `0000`‑`9999`; `setUTCFullYear` is used
 * because `Date.UTC` reads years below 100 as 19xx).
 * @param {unknown} v @returns {v is DateStr}
 */
function isDateStr(v) {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** `YYYY-MM-DD` of a UTC wall clock. @param {Date} d */
function dateKey(d) {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Add calendar months to a `YYYY-MM-DD` date, clamping to the last day of the target month
 * (`2026-01-31` + 1 → `2026-02-28`).
 * @param {DateStr} d @param {number} n @returns {DateStr}
 */
function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const target = new Date(0);
  target.setUTCFullYear(y, m - 1 + n, 1);
  const end = new Date(0);
  end.setUTCFullYear(target.getUTCFullYear(), target.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(day, end.getUTCDate()));
  return dateKey(target);
}

/**
 * Reference "today" for a validation run: `ctx.today`, else the date of `ctx.now`, else the host
 * clock.
 * @param {ValidationContext} [ctx] @returns {DateStr}
 */
function refToday(ctx) {
  if (ctx && isDateStr(ctx.today)) return ctx.today;
  if (ctx && isFiniteNumber(ctx.now)) return today(undefined, ctx.now);
  return today();
}

/**
 * A `YYYY-MM-DD` reference date supplied by the program (travel date); anything else is a bug.
 * @param {unknown} v @param {string} name @returns {DateStr}
 * @throws {ValidationError}
 */
function refDate(v, name) {
  if (!isDateStr(v)) {
    throw programmerError(
      `Expected ${name} to be a YYYY-MM-DD date, got "${String(v)}"`,
      name,
      'invalid_date',
      { value: v }
    );
  }
  return v;
}

/**
 * Complete `AgeRules` from a possibly partial / missing object; entries that are not non‑negative
 * finite numbers fall back to the defaults.
 * @param {unknown} rules @returns {AgeRules}
 * @throws {ValidationError} when the bands are inconsistent (`infantMax > childMax`), which
 *   `paxTypeForAge` could not classify (path `rules`, code `invalid_rules`)
 */
function ageRules(rules) {
  const src = isObjectLike(rules) ? /** @type {Record<string, unknown>} */ (rules) : {};
  const out = { ...DEFAULT_AGE_RULES };
  for (const k of ['infantMax', 'childMax', 'infantPerAdult', 'maxPax']) {
    const v = src[k];
    if (isFiniteNumber(v) && v >= 0) out[k] = v;
  }
  if (src.refDate === 'departure' || src.refDate === 'return') out.refDate = src.refDate;
  if (out.infantMax > out.childMax) {
    throw programmerError(
      `Expected age bands with infantMax <= childMax, got ${out.infantMax} > ${out.childMax}`,
      'rules',
      'invalid_rules',
      { infantMax: out.infantMax, childMax: out.childMax }
    );
  }
  return out;
}

/**
 * Upper‑cased ISO‑3166 alpha‑2 code, or `''` when the input is not one.
 * @param {unknown} v @returns {string}
 */
function countryOf(v) {
  return typeof v === 'string' && COUNTRY_RE.test(v.trim()) ? v.trim().toUpperCase() : '';
}

/**
 * Non‑negative integer from a number or a digit string; `null` otherwise.
 * @param {unknown} v @returns {number|null}
 */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && DIGITS_RE.test(v.trim())) return Number(v.trim());
  return null;
}

/** Digits of a card‑number‑like input (spaces / hyphens removed); `''` when not numeric. @param {unknown} v */
function cardDigits(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v);
  if (typeof v !== 'string') return '';
  const d = v.replace(CARD_SEPARATORS_RE, '');
  return DIGITS_RE.test(d) ? d : '';
}

/** Issues of a result or a bare issue list. @param {unknown} r @returns {ValidationIssue[]} */
function toIssues(r) {
  if (Array.isArray(r)) return r;
  if (isObjectLike(r) && Array.isArray(/** @type {any} */ (r).issues)) {
    return /** @type {any} */ (r).issues;
  }
  return [];
}

/** Drop repeated `path` + `code` pairs, keeping the first. @param {ValidationIssue[]} issues */
function dedupe(issues) {
  const seen = new Set();
  /** @type {ValidationIssue[]} */
  const out = [];
  for (const it of issues) {
    const key = `${it.path}\u0000${it.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ── schema runner ────────────────────────────────────────────────────────────────────────────────

/**
 * Reject a malformed rule early, with a developer‑facing error.
 * @param {unknown} rule @param {string} path
 * @returns {Rule}
 * @throws {ValidationError}
 */
function assertRule(rule, path) {
  const at = path ? `schema.${path}` : 'schema';
  if (!isObjectLike(rule)) {
    throw programmerError(`Expected a rule object at ${at}`, at, 'invalid_schema', { value: rule });
  }
  const r = /** @type {Rule} */ (rule);
  if (r.type !== undefined && !RULE_TYPES.includes(r.type)) {
    throw programmerError(`Unknown rule type "${String(r.type)}" at ${at}`, at, 'invalid_schema', {
      type: r.type,
    });
  }
  if (r.pattern !== undefined && !(r.pattern instanceof RegExp) && typeof r.pattern !== 'string') {
    throw programmerError(
      `Expected pattern to be a RegExp or string at ${at}`,
      at,
      'invalid_schema'
    );
  }
  if (r.custom !== undefined && typeof r.custom !== 'function') {
    throw programmerError(`Expected custom to be a function at ${at}`, at, 'invalid_schema');
  }
  if (r.when !== undefined && typeof r.when !== 'function') {
    throw programmerError(`Expected when to be a function at ${at}`, at, 'invalid_schema');
  }
  if (r.enum !== undefined && !Array.isArray(r.enum)) {
    throw programmerError(`Expected enum to be an array at ${at}`, at, 'invalid_schema');
  }
  if (r.props !== undefined && !isObjectLike(r.props)) {
    throw programmerError(`Expected props to be an object at ${at}`, at, 'invalid_schema');
  }
  return r;
}

/**
 * Compile a rule pattern; a `g` / `y` flag is neutralised so repeated tests stay deterministic.
 * @param {RegExp|string} pattern @param {string} path
 * @returns {RegExp}
 * @throws {ValidationError}
 */
function toRegExp(pattern, path) {
  if (pattern instanceof RegExp) {
    return pattern.global || pattern.sticky
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
      : pattern;
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    const at = path ? `schema.${path}` : 'schema';
    throw programmerError(`Invalid pattern "${pattern}" at ${at}`, at, 'invalid_schema', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Turn a `custom` result into issues at (or relative to) `path`.
 * @param {CustomResult} res @param {string} path @param {ValidationIssue[]} out
 */
function applyCustom(res, path, out) {
  if (res === true || res === null || res === undefined) return;
  if (res === false) {
    out.push(issue(path, 'invalid'));
    return;
  }
  if (typeof res === 'string') {
    out.push(issue(path, res || 'invalid'));
    return;
  }
  if (Array.isArray(res)) {
    for (const r of res) applyCustom(r, path, out);
    return;
  }
  if (typeof res === 'object') {
    const code = isNonEmptyString(res.code) ? res.code : 'invalid';
    const it = issue(joinPath(path, res.path), code, res.params);
    if (isNonEmptyString(res.message)) it.message = res.message;
    out.push(it);
  }
}

/**
 * Apply a schema node (rule or rule list) to a value.
 * @param {Schema} schema @param {unknown} value @param {unknown} parent @param {unknown} root
 * @param {string} path @param {ValidationContext} ctx @param {ValidationIssue[]} out
 */
function runSchema(schema, value, parent, root, path, ctx, out) {
  if (Array.isArray(schema)) {
    for (const rule of schema) runRule(rule, value, parent, root, path, ctx, out);
  } else {
    runRule(schema, value, parent, root, path, ctx, out);
  }
}

/**
 * Apply one rule to a value.
 * @param {unknown} rule @param {unknown} value @param {unknown} parent @param {unknown} root
 * @param {string} path @param {ValidationContext} ctx @param {ValidationIssue[]} out
 */
function runRule(rule, value, parent, root, path, ctx, out) {
  const r = assertRule(rule, path);
  /** @type {RuleInfo} */
  const info = { value, parent, root, path, ctx };
  if (r.when && !r.when(parent, info)) return;

  if (isEmpty(value)) {
    if (r.required) out.push(issue(path, 'required'));
    return;
  }

  if (r.type !== undefined && !matchesType(value, r.type)) {
    out.push(
      issue(path, r.type === 'date' ? 'date' : 'type', { expected: r.type, actual: typeOf(value) })
    );
    return;
  }

  const before = out.length;
  if (r.pattern !== undefined) {
    const re = toRegExp(r.pattern, path);
    const testable = typeof value === 'string' || typeof value === 'number';
    if (!testable || !re.test(String(value))) {
      out.push(issue(path, 'pattern', { pattern: re.source }));
    }
  }

  if (r.min !== undefined && isBelow(value, r.min)) {
    out.push(issue(path, 'min', { min: r.min }));
  }
  if (r.max !== undefined && isBelow(r.max, value)) {
    out.push(issue(path, 'max', { max: r.max }));
  }

  const len = typeof value === 'string' || Array.isArray(value) ? value.length : null;
  if (len !== null && isFiniteNumber(r.minLength) && len < r.minLength) {
    out.push(issue(path, 'minLength', { min: r.minLength, length: len }));
  }
  if (len !== null && isFiniteNumber(r.maxLength) && len > r.maxLength) {
    out.push(issue(path, 'maxLength', { max: r.maxLength, length: len }));
  }

  if (r.enum !== undefined && !r.enum.includes(value)) {
    out.push(issue(path, 'enum', { values: [...r.enum] }));
  }

  const items = Array.isArray(value) ? value : null;
  const record = isObjectLike(value) ? /** @type {Record<string, unknown>} */ (value) : null;
  if (r.items !== undefined && !items) {
    out.push(issue(path, 'type', { expected: 'array', actual: typeOf(value) }));
  }
  if (r.props !== undefined && !record) {
    out.push(issue(path, 'type', { expected: 'object', actual: typeOf(value) }));
  }
  // Only the node's own checks decide whether `custom` runs; child issues are reported alongside,
  // so a cross-field check (date order, counts) still runs when one element is malformed.
  const ownIssues = out.length - before;

  if (r.items !== undefined && items) {
    items.forEach((item, i) =>
      runSchema(/** @type {Schema} */ (r.items), item, value, root, `${path}[${i}]`, ctx, out)
    );
  }
  if (r.props !== undefined && record) {
    for (const key of Object.keys(r.props)) {
      runSchema(r.props[key], record[key], value, root, joinPath(path, key), ctx, out);
    }
  }

  if (ownIssues === 0 && r.custom) applyCustom(r.custom(value, info), path, out);
}

/**
 * Structural type check.
 * @param {unknown} v @param {RuleType} type @returns {boolean}
 */
function matchesType(v, type) {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return isFiniteNumber(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObjectLike(v);
    case 'array':
      return Array.isArray(v);
    case 'date':
      return isDateStr(v);
    default:
      return false;
  }
}

/**
 * `a < b` for numbers, or for `YYYY-MM-DD` strings; `false` when the two are not comparable.
 * @param {unknown} a @param {unknown} b
 */
function isBelow(a, b) {
  if (isFiniteNumber(a) && isFiniteNumber(b)) return a < b;
  if (isDateStr(a) && isDateStr(b)) return a < b;
  return false;
}

/**
 * Run a schema against a value. Rules: `required`, `type`, `pattern`, `min`, `max`, `minLength`,
 * `maxLength`, `enum`, `custom(fn)`, `when(predicate)` for conditional rules, `items` for arrays
 * and `props` for nested objects; a node may also be a list of rules. Issues carry a dotted `path`
 * (`slices[1].date`, `''` for the root, prefixed with `ctx.path` when given), a machine `code` and
 * the i18n key `validation.<code>` as `message`; repeated `path` + `code` pairs are collapsed.
 * `custom` runs once the node's own checks passed, whatever its children reported, so cross‑field
 * checks are never hidden by a malformed element. Unknown object keys are ignored. Effects: none.
 * @param {Schema} schema
 * @param {unknown} value
 * @param {ValidationContext} [ctx]  passed to every `custom` / `when`; see `ValidationContext`
 * @returns {ValidationResult}
 * @throws {ValidationError} when the schema itself is malformed (never for the value)
 */
export function validate(schema, value, ctx) {
  /** @type {ValidationContext} */
  const context = isObjectLike(ctx) ? /** @type {ValidationContext} */ (ctx) : {};
  const base = typeof context.path === 'string' ? context.path : '';
  /** @type {ValidationIssue[]} */
  const out = [];
  runSchema(schema, value, value, value, base, context, out);
  const issues = dedupe(out);
  return { valid: issues.length === 0, issues };
}

// ── validators ───────────────────────────────────────────────────────────────────────────────────

/**
 * Practical e‑mail check (RFC 5322 local part without quoting, dotted domain with a ≥ 2‑letter TLD,
 * 64 / 254 length caps). Surrounding whitespace is ignored. Effects: none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isEmail(s) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  if (v.length === 0 || v.length > 254) return false;
  const at = v.lastIndexOf('@');
  if (at <= 0 || at === v.length - 1) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.length > 64) return false;
  return EMAIL_LOCAL_RE.test(local) && EMAIL_DOMAIN_RE.test(domain);
}

/**
 * E.164 phone check on `{ countryCode, number }`: dial code `+`? 1‑3 digits (no leading zero),
 * national number 4‑14 digits (spaces, dots, hyphens and parentheses are ignored), 7‑15 digits in
 * all. A full `+<digits>` string is accepted too. Effects: none.
 * @param {Phone|string} p
 * @returns {boolean}
 */
export function isPhone(p) {
  if (typeof p === 'string') return E164_RE.test(p.replace(PHONE_SEPARATORS_RE, ''));
  if (!isObjectLike(p)) return false;
  const raw = /** @type {{ countryCode?: unknown, number?: unknown }} */ (p);
  const cc =
    typeof raw.countryCode === 'string'
      ? raw.countryCode.trim()
      : isFiniteNumber(raw.countryCode)
        ? String(raw.countryCode)
        : '';
  const num =
    typeof raw.number === 'string'
      ? raw.number.replace(PHONE_SEPARATORS_RE, '')
      : isFiniteNumber(raw.number)
        ? String(raw.number)
        : '';
  if (!DIAL_CODE_RE.test(cc) || !NATIONAL_NUMBER_RE.test(num)) return false;
  const digits = cc.replace('+', '').length + num.length;
  return digits >= 7 && digits <= 15;
}

/**
 * Three‑letter IATA airport / city / metro code (case‑insensitive; `search.normalize` upper‑cases).
 * Effects: none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isIata(s) {
  return typeof s === 'string' && IATA_RE.test(s.trim());
}

/**
 * Postal code for a country: exact shapes for IN (6 digits, no leading 0), US (ZIP / ZIP+4), GB,
 * CA, DE, FR, AU; a permissive 3‑10 character alphanumeric rule everywhere else. Effects: none.
 * @param {unknown} s
 * @param {string} [country]  ISO‑3166 alpha‑2 (case‑insensitive)
 * @returns {boolean}
 */
export function isPostalCode(s, country) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  if (!v) return false;
  const re = POSTAL_PATTERNS[countryOf(country)] || POSTAL_DEFAULT_RE;
  return re.test(v);
}

/**
 * Passport number: 6‑9 alphanumerics generically, with the national shapes for IN (letter except
 * Q / X / Z + 7 digits), US (9 digits, or a letter + 8 digits) and GB (9 digits). Whitespace is
 * ignored. Effects: none.
 * @param {unknown} s
 * @param {string} [country]  issuing country, ISO‑3166 alpha‑2
 * @returns {boolean}
 */
export function isPassportNumber(s, country) {
  if (typeof s !== 'string') return false;
  const v = s.replace(/\s+/g, '');
  if (!v) return false;
  const re = PASSPORT_PATTERNS[countryOf(country)] || PASSPORT_DEFAULT_RE;
  return re.test(v);
}

/**
 * Indian GSTIN: 15 characters (state code, embedded PAN, entity number, `Z`, check character) and
 * the mod‑36 checksum. Case‑insensitive. Effects: none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isGstin(s) {
  if (typeof s !== 'string') return false;
  const v = s.trim().toUpperCase();
  if (!GSTIN_RE.test(v) || !isPan(v.slice(2, 12))) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_ALPHABET.indexOf(v[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36] === v[14];
}

/**
 * Indian PAN: `AAAAA9999A` with a valid holder‑type letter in fourth position. Case‑insensitive.
 * Effects: none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isPan(s) {
  return typeof s === 'string' && PAN_RE.test(s.trim().toUpperCase());
}

/**
 * UPI virtual payment address (`name@handle`). Effects: none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isVpa(s) {
  return typeof s === 'string' && VPA_RE.test(s.trim());
}

/**
 * Luhn (mod 10) check on a digit string (spaces / hyphens ignored); at least two digits. Effects:
 * none.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isLuhn(s) {
  const v = cardDigits(s);
  if (v.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let i = v.length - 1; i >= 0; i--) {
    let n = v.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Airline name field: letters separated by single spaces, hyphens or apostrophes, no leading /
 * trailing separators, at most `maxLength` characters (default 60; `Infinity` lifts the cap).
 * `charset: 'latin'` (default) is ASCII A‑Z, what ticketing systems accept; `'any'` allows every
 * Unicode letter. Effects: none.
 * @param {unknown} s
 * @param {{ maxLength?: number, charset?: 'latin'|'any' }} [options]
 * @returns {boolean}
 */
export function isNameValid(s, options = {}) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  if (!v) return false;
  const o = isObjectLike(options) ? options : {};
  const maxLength = isPositiveNumber(o.maxLength) ? o.maxLength : DEFAULT_NAME_RULES.maxLength;
  if (v.length > maxLength) return false;
  return (o.charset === 'any' ? NAME_ANY_RE : NAME_LATIN_RE).test(v);
}

/**
 * Whether first + last name fit the ticket name field: letters only are counted (spaces, hyphens
 * and apostrophes are dropped on the ticket) plus one separator, against `max` characters (a
 * non‑positive or non‑numeric `max` means the default of 60). Effects: none.
 * @param {string} first
 * @param {string} last
 * @param {number} [max=60]
 * @returns {boolean}
 */
export function namesFitTicket(first, last, max = DEFAULT_TICKET_NAME_MAX) {
  if (typeof first !== 'string' || typeof last !== 'string') return false;
  const limit = isPositiveNumber(max) ? max : DEFAULT_TICKET_NAME_MAX;
  const f = first.replace(NAME_FILLER_RE, '');
  const l = last.replace(NAME_FILLER_RE, '');
  return f.length + l.length + 1 <= limit;
}

// ── domain checks ────────────────────────────────────────────────────────────────────────────────

/**
 * Travel document expiry against the (last) travel date: `expiry` must be a date at or after
 * `travelDate + minValidityMonths` (code `documentExpiry`, params `{ months, expiry, minExpiry,
 * travelDate }`); a missing / malformed expiry gives `required` / `date`; an `issueDate` after the
 * expiry gives `dateOrder`. Paths are relative to the document. Effects: none.
 * @param {Partial<TravelDocument>} doc
 * @param {DateStr} travelDate
 * @param {{ minValidityMonths?: number }} [options]
 * @returns {ValidationIssue[]}
 * @throws {ValidationError} when `travelDate` is not a `YYYY-MM-DD` date
 */
export function documentValid(doc, travelDate, options = {}) {
  const travel = refDate(travelDate, 'travelDate');
  const o = isObjectLike(options) ? options : {};
  const months =
    isFiniteNumber(o.minValidityMonths) && o.minValidityMonths > 0
      ? Math.trunc(o.minValidityMonths)
      : 0;
  if (!isObjectLike(doc)) return [issue('', 'required')];
  /** @type {ValidationIssue[]} */
  const issues = [];
  const { expiry, issueDate } = doc;
  if (isEmpty(expiry)) {
    issues.push(issue('expiry', 'required'));
  } else if (!isDateStr(expiry)) {
    issues.push(issue('expiry', 'date'));
  } else {
    const minExpiry = addMonths(travel, months);
    if (expiry < minExpiry) {
      issues.push(
        issue('expiry', 'documentExpiry', { months, expiry, minExpiry, travelDate: travel })
      );
    }
  }
  if (!isEmpty(issueDate)) {
    if (!isDateStr(issueDate)) {
      issues.push(issue('issueDate', 'date'));
    } else if (isDateStr(expiry) && issueDate > expiry) {
      issues.push(issue('issueDate', 'dateOrder', { expiry, issueDate }));
    }
  }
  return issues;
}

/**
 * Passenger counts against `AgeRules`: every count a non‑negative integer, at least one adult
 * (adults + youth + seniors), lap infants ≤ adults × `infantPerAdult` (`infantsPerAdult` at
 * `infants`), everyone ≤ `maxPax` (`maxPassengers` at `''`), and `childAges`, when given, one per
 * child (`childAges`) and each inside the child band (`ageForType` at `childAges[i]`). Missing
 * rules fall back to infant < 2, child < 12, 1 infant per adult, 9 passengers. Effects: none.
 * @param {PaxCounts} pax
 * @param {AgeRules|Partial<AgeRules>} [rules]
 * @returns {ValidationIssue[]}
 * @throws {ValidationError} when `rules.infantMax > rules.childMax`
 */
export function paxCountsValid(pax, rules) {
  const r = ageRules(rules);
  if (!isObjectLike(pax)) return [issue('', 'type', { expected: 'object', actual: typeOf(pax) })];
  const src = /** @type {Record<string, unknown>} */ (pax);
  /** @type {ValidationIssue[]} */
  const issues = [];
  /** @type {Record<string, number>} */
  const counts = {};
  const invalid = new Set();
  for (const field of COUNT_FIELDS) {
    const v = src[field];
    if (v === undefined || v === null) {
      counts[field] = 0;
    } else if (!Number.isInteger(v)) {
      issues.push(issue(field, 'type', { expected: 'integer', actual: typeOf(v) }));
      counts[field] = 0;
      invalid.add(field);
    } else if (/** @type {number} */ (v) < 0) {
      issues.push(issue(field, 'min', { min: 0 }));
      counts[field] = 0;
      invalid.add(field);
    } else {
      counts[field] = /** @type {number} */ (v);
    }
  }
  const adults = ADULT_FIELDS.reduce((n, f) => n + counts[f], 0);
  const total = COUNT_FIELDS.reduce((n, f) => n + counts[f], 0);
  if (adults < 1 && !ADULT_FIELDS.some((f) => invalid.has(f))) {
    issues.push(issue('adults', 'min', { min: 1 }));
  }
  const maxInfants = adults * r.infantPerAdult;
  if (!invalid.has('infants') && counts.infants > maxInfants) {
    issues.push(
      issue('infants', 'infantsPerAdult', { max: maxInfants, infantPerAdult: r.infantPerAdult })
    );
  }
  if (total > r.maxPax) issues.push(issue('', 'maxPassengers', { max: r.maxPax, total }));

  const ages = src.childAges;
  if (ages !== undefined && ages !== null) {
    if (!Array.isArray(ages)) {
      issues.push(issue('childAges', 'type', { expected: 'array', actual: typeOf(ages) }));
    } else {
      if (!invalid.has('children') && ages.length !== counts.children) {
        issues.push(
          issue('childAges', 'childAges', { expected: counts.children, actual: ages.length })
        );
      }
      ages.forEach((age, i) => {
        if (!Number.isInteger(age) || age < r.infantMax || age >= r.childMax) {
          issues.push(
            issue(`childAges[${i}]`, 'ageForType', { min: r.infantMax, max: r.childMax - 1, age })
          );
        }
      });
    }
  }
  return issues;
}

/**
 * Whether a traveler's age at `travelDate` fits the slot's passenger type: infants (`INF` / `INS`)
 * under `infantMax`, children under `childMax`, every other type an adult by age (fare‑based types
 * are checked by the backend). Issues sit at `dob`: `required` / `date` for a missing or malformed
 * date of birth, `past` when born after the travel date, `ageForType` (params `{ expected, actual,
 * age, travelDate }`) on a mismatch. Falls back to `traveler.type` when `slot` carries no type and
 * reports nothing when neither does. Effects: none.
 * @param {Partial<Traveler>} traveler
 * @param {Partial<PassengerSlot>|null|undefined} slot
 * @param {AgeRules|Partial<AgeRules>} [rules]
 * @param {DateStr} travelDate  departure or return date, as `rules.refDate` asks
 * @returns {ValidationIssue[]}
 * @throws {ValidationError} when `travelDate` is not a `YYYY-MM-DD` date or
 *   `rules.infantMax > rules.childMax`
 */
export function travelerMatchesSlot(traveler, slot, rules, travelDate) {
  const on = refDate(travelDate, 'travelDate');
  const r = ageRules(rules);
  if (!isObjectLike(traveler)) return [issue('', 'required')];
  const slotType = isObjectLike(slot) ? /** @type {any} */ (slot).type : undefined;
  const expected = PAX_TYPES.includes(slotType)
    ? slotType
    : PAX_TYPES.includes(traveler.type)
      ? traveler.type
      : null;
  const { dob } = traveler;
  if (isEmpty(dob)) return [issue('dob', 'required')];
  if (!isDateStr(dob)) return [issue('dob', 'date')];
  const age = ageAt(dob, on);
  if (age < 0) return [issue('dob', 'past', { max: on })];
  if (!expected) return [];
  const actual = paxTypeForAge(age, r);
  if (actual !== AGE_CLASS[expected]) {
    return [issue('dob', 'ageForType', { expected, actual, age, travelDate: on })];
  }
  return [];
}

/**
 * Card brand from the (possibly partial) number: Visa (4), Mastercard (51‑55, 2221‑2720), Amex
 * (34 / 37), Diners (300‑305, 3095, 36, 38, 39), JCB (3528‑3589), Discover (6011, 644‑649,
 * 622126‑622925) and RuPay (60, 65, 81, 82, 508); spaces / hyphens are ignored. Non‑hosted card
 * entry only. Effects: none.
 * @param {string|number} number
 * @returns {'visa'|'mastercard'|'amex'|'rupay'|'discover'|'diners'|'jcb'|'unknown'}
 */
export function cardBrand(number) {
  const digits = cardDigits(number);
  if (!digits) return 'unknown';
  const hit = CARD_BRANDS.find((b) => b.re.test(digits));
  return hit ? /** @type {any} */ (hit.brand) : 'unknown';
}

/**
 * Card expiry month / year not in the past (the card is good through the end of its month) and no
 * more than 20 years ahead. `yy` may be 2 or 4 digits; both may be numbers or digit strings.
 * Effects: none.
 * @param {string|number} mm
 * @param {string|number} yy
 * @param {number|Date} [now]  clock override (defaults to `Date.now()`)
 * @returns {boolean}
 */
export function cardExpiryValid(mm, yy, now) {
  const month = toInt(mm);
  const rawYear = toInt(yy);
  if (month === null || rawYear === null || month < 1 || month > 12) return false;
  const ref = now instanceof Date ? now : new Date(isFiniteNumber(now) ? now : Date.now());
  if (Number.isNaN(ref.getTime())) return false;
  const refYear = ref.getFullYear();
  const refMonth = ref.getMonth() + 1;
  const yearDigits = String(yy).trim().length;
  let year = rawYear;
  if (yearDigits <= 2) year = Math.floor(refYear / 100) * 100 + rawYear;
  else if (yearDigits !== 4) return false;
  if (year < refYear || (year === refYear && month < refMonth)) return false;
  return year - refYear <= MAX_CARD_YEARS;
}

// ── UI binding helpers ───────────────────────────────────────────────────────────────────────────

/**
 * Group issues by path (`{ 'slices[0].date': [...], email: [...] }`); accepts a result or a bare
 * issue list. Effects: none.
 * @param {ValidationResult|ValidationIssue[]} result
 * @returns {Record<string, ValidationIssue[]>}
 */
export function issuesByPath(result) {
  /** @type {Record<string, ValidationIssue[]>} */
  const out = {};
  for (const it of toIssues(result)) {
    const key = typeof it.path === 'string' ? it.path : '';
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      Object.defineProperty(out, key, {
        value: [],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    out[key].push(it);
  }
  return out;
}

/**
 * First issue at exactly `path` (the first issue overall when `path` is omitted), or `null`.
 * Effects: none.
 * @param {ValidationResult|ValidationIssue[]} result
 * @param {string} [path]
 * @returns {ValidationIssue|null}
 */
export function firstIssue(result, path) {
  const issues = toIssues(result);
  if (path === undefined || path === null) return issues.length ? issues[0] : null;
  const hit = issues.find((it) => it.path === path);
  return hit || null;
}

// ── prebuilt schemas ─────────────────────────────────────────────────────────────────────────────

/** Email rule used by several schemas. @param {boolean} required @returns {Rule} */
function emailRule(required) {
  return { required, type: 'string', custom: (v) => isEmail(v) || 'email' };
}

/** `Phone` rule: both parts required, E.164 checked once both are present. @param {boolean} required @returns {Rule} */
function phoneRule(required) {
  return {
    required,
    type: 'object',
    props: { countryCode: { required: true }, number: { required: true } },
    custom: (v) => (isEmpty(v.countryCode) || isEmpty(v.number) ? true : isPhone(v) || 'phone'),
  };
}

/** Property names a backend `FieldRule.path` may never address (prototype pollution). */
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Copy of a schema node (rule or rule list) with a `FieldRule` overlay applied at `segs`: an empty
 * path merges `extra` into the node's first rule; otherwise the node becomes an object rule whose
 * `props[seg]` is overlaid recursively — or, for an array rule, every element (`items`) is. With
 * `required`, every container on the way becomes required too. Nothing in the input is mutated.
 * @param {Schema|undefined} node @param {string[]} segs @param {Rule} extra @param {boolean} required
 * @returns {Schema}
 */
function overlayRule(node, segs, extra, required) {
  const list = Array.isArray(node) ? node : [node];
  /** @type {Rule} */
  const head = isObjectLike(list[0]) ? { ...list[0] } : {};
  if (segs.length === 0) {
    Object.assign(head, extra);
  } else {
    if (required) head.required = true;
    if (head.items !== undefined || head.type === 'array') {
      if (head.type === undefined) head.type = 'array';
      head.items = overlayRule(head.items, segs, extra, required);
    } else {
      if (head.type === undefined) head.type = 'object';
      const props = isObjectLike(head.props) ? { ...head.props } : {};
      const [seg, ...rest] = segs;
      const existing = Object.prototype.hasOwnProperty.call(props, seg) ? props[seg] : undefined;
      props[seg] = overlayRule(existing, rest, extra, required);
      head.props = props;
    }
  }
  return Array.isArray(node) ? [head, ...node.slice(1)] : head;
}

/**
 * Overlay backend `FieldRule[]` (`required`, `pattern`, `options`) on a props tree; dotted paths
 * create nested object rules (a path through an array rule applies to every element; `[i]`
 * indexes are dropped), and a required nested field makes its containers required too. Rules
 * whose path is empty, not a string or addresses the prototype chain (`__proto__`,
 * `constructor`, `prototype`), and unusable backend patterns, are ignored rather than thrown.
 * @param {Record<string, Schema>} props @param {unknown} fields
 */
function applyFieldRules(props, fields) {
  if (!Array.isArray(fields)) return;
  for (const f of fields) {
    if (!isObjectLike(f) || !isNonEmptyString(/** @type {any} */ (f).path)) continue;
    const rule = /** @type {FieldRule} */ (f);
    const segs = rule.path
      .split('.')
      .map((s) => s.trim().replace(/\[\d*\]$/, ''))
      .filter(Boolean);
    if (segs.length === 0 || segs.some((s) => UNSAFE_KEYS.includes(s))) continue;
    /** @type {Rule} */
    const extra = {};
    if (typeof rule.required === 'boolean') extra.required = rule.required;
    if (isNonEmptyString(rule.pattern)) {
      try {
        extra.pattern = new RegExp(rule.pattern);
      } catch {
        // an unusable backend pattern must not break traveler capture
      }
    }
    if (Array.isArray(rule.options) && rule.options.length) extra.enum = rule.options.slice();
    const [first, ...rest] = segs;
    const existing = Object.prototype.hasOwnProperty.call(props, first) ? props[first] : undefined;
    props[first] = overlayRule(existing, rest, extra, rule.required === true);
  }
}

/**
 * Normalise `bootstrap.limits` for the search schema.
 * @param {unknown} limits
 * @returns {Required<Omit<SearchLimits, 'maxPax'|'ageRules'>>}
 */
function searchLimits(limits) {
  const src = isObjectLike(limits) ? /** @type {Record<string, any>} */ (limits) : {};
  const out = { ...DEFAULT_LIMITS };
  if (isObjectLike(src.ageRules)) {
    if (isFiniteNumber(src.ageRules.infantMax)) out.infantMax = src.ageRules.infantMax;
    if (isFiniteNumber(src.ageRules.childMax)) out.childMax = src.ageRules.childMax;
    if (isFiniteNumber(src.ageRules.infantPerAdult))
      out.infantPerAdult = src.ageRules.infantPerAdult;
    if (isFiniteNumber(src.ageRules.maxPax)) out.maxTotal = src.ageRules.maxPax;
  }
  if (isFiniteNumber(src.maxPax)) {
    out.maxTotal = src.maxPax;
    out.maxSeated = Math.min(out.maxSeated, src.maxPax);
  }
  for (const k of LIMIT_FIELDS) if (isFiniteNumber(src[k])) out[k] = src[k];
  const fareTypes = Array.isArray(src.fareTypes) ? src.fareTypes.filter(isNonEmptyString) : [];
  const cabins = Array.isArray(src.cabins) ? src.cabins.filter(isNonEmptyString) : [];
  return {
    ...out,
    fareTypes: fareTypes.length ? fareTypes : [...FARE_TYPES],
    cabins: cabins.length ? cabins : [...CABINS],
  };
}

/**
 * Schema for `SearchParams` under `bootstrap.limits`: trip type, 1‑`maxLegs` slices (exactly 1 for
 * one‑way, 2 for round‑trip, ≥ 2 for multi‑city) with IATA codes (`iata`), distinct origin /
 * destination (`sameAirport`), dates from today (`past`) to today + `advanceDays` (`max`) in
 * chronological order (`dateOrder`), passenger counts via `paxCountsValid` plus the seated cap
 * (`maxPassengers`), cabin / fare types / stops / result mode enumerations and the optional filter
 * flags. `resultMode` is optional and defaults downstream to `per_slice` (split). Today comes from
 * `ctx.today`. Effects: none.
 * @param {SearchLimits} [limits]
 * @returns {Schema}
 * @throws {ValidationError} when the age bands are inconsistent (`infantMax > childMax`)
 */
function searchParamsSchema(limits) {
  const L = searchLimits(limits);
  const rules = ageRules({
    infantMax: L.infantMax,
    childMax: L.childMax,
    refDate: 'departure',
    infantPerAdult: L.infantPerAdult,
    maxPax: L.maxTotal,
  });
  /** @type {Rule} */
  const slice = {
    required: true,
    type: 'object',
    props: {
      origin: { required: true, type: 'string', custom: (v) => isIata(v) || 'iata' },
      destination: {
        required: true,
        type: 'string',
        custom: (v, { parent }) => {
          if (!isIata(v)) return 'iata';
          const origin = parent && typeof parent.origin === 'string' ? parent.origin : '';
          return v.trim().toUpperCase() === origin.trim().toUpperCase() ? 'sameAirport' : true;
        },
      },
      date: {
        required: true,
        type: 'date',
        custom: (v, { ctx }) => {
          const t = refToday(ctx);
          if (v < t) return { code: 'past', params: { min: t } };
          const last = addDays(t, L.advanceDays);
          return v > last ? { code: 'max', params: { max: last } } : true;
        },
      },
      flexDays: { type: 'integer', enum: FLEX_DAYS },
      timeWindow: {
        type: 'object',
        props: {
          from: { type: 'string', pattern: HHMM_RE },
          to: { type: 'string', pattern: HHMM_RE },
        },
      },
    },
  };
  const airlineList = { type: 'array', items: { type: 'string', pattern: AIRLINE_RE } };
  return {
    required: true,
    type: 'object',
    props: {
      tripType: { required: true, enum: TRIP_TYPES },
      slices: [
        {
          required: true,
          type: 'array',
          maxLength: L.maxLegs,
          items: slice,
          custom: (slices) => {
            /** @type {Partial<ValidationIssue>[]} */
            const out = [];
            for (let i = 1; i < slices.length; i++) {
              const prev = slices[i - 1] && slices[i - 1].date;
              const cur = slices[i] && slices[i].date;
              if (isDateStr(prev) && isDateStr(cur) && cur < prev) {
                out.push({ path: `[${i}].date`, code: 'dateOrder', params: { min: prev } });
              }
            }
            return out;
          },
        },
        { when: (p) => p.tripType === 'one_way', maxLength: 1 },
        { when: (p) => p.tripType === 'round_trip', minLength: 2, maxLength: 2 },
        { when: (p) => p.tripType === 'multi_city', minLength: 2 },
      ],
      passengers: {
        required: true,
        type: 'object',
        custom: (pax) => {
          const issues = paxCountsValid(pax, rules);
          const seated = COUNT_FIELDS.filter((f) => f !== 'infants').reduce(
            (n, f) => n + (Number.isInteger(pax[f]) && pax[f] > 0 ? pax[f] : 0),
            0
          );
          if (seated > L.maxSeated) {
            issues.push(issue('', 'maxPassengers', { max: L.maxSeated, seated }));
          }
          return issues;
        },
      },
      cabin: { enum: L.cabins },
      fareTypes: { type: 'array', items: { enum: L.fareTypes } },
      directOnly: { type: 'boolean' },
      maxStops: { enum: MAX_STOPS },
      includeNearby: { type: 'boolean' },
      airlines: { type: 'object', props: { include: airlineList, exclude: airlineList } },
      alliances: { type: 'array', items: { required: true, type: 'string' } },
      refundableOnly: { type: 'boolean' },
      baggageIncluded: { type: 'boolean' },
      allowSelfTransfer: { type: 'boolean' },
      allowMixedCabin: { type: 'boolean' },
      maxDurationMinutes: { type: 'integer', min: 1 },
      currency: { type: 'string', pattern: CURRENCY_RE },
      resultMode: { enum: RESULT_MODES },
      context: {
        type: 'object',
        props: {
          bookingId: { type: 'string' },
          sliceIds: { type: 'array', items: { required: true, type: 'string' } },
        },
      },
    },
  };
}

/**
 * Schema for one `TravelDocument` under a `DocumentRule`: type within `rule.types`, number
 * (`passport` shape for passports, 4‑20 alphanumerics otherwise), issuing country, optional
 * nationality, expiry (with `ctx.travelDate`: at least `rule.minValidityMonths` after travel —
 * `documentExpiry`; without: not yet expired — `future`) and an issue date not in the future
 * (`past`) nor after the expiry (`dateOrder`). Effects: none.
 * @param {Partial<DocumentRule>} [rule]
 * @returns {Schema}
 */
function documentSchema(rule) {
  const r = isObjectLike(rule) ? rule : {};
  const types = Array.isArray(r.types) ? r.types.filter(isNonEmptyString) : [];
  const months = isFiniteNumber(r.minValidityMonths) ? Math.max(0, r.minValidityMonths) : 0;
  return {
    required: true,
    type: 'object',
    props: {
      type: { required: true, enum: types.length ? types : [...DOCUMENT_TYPES] },
      number: {
        required: true,
        type: 'string',
        custom: (v, { parent }) =>
          parent && parent.type === 'passport'
            ? isPassportNumber(v, parent.issuingCountry) || 'passport'
            : DOC_NUMBER_RE.test(v.trim()) || 'pattern',
      },
      issuingCountry: { required: true, type: 'string', pattern: COUNTRY_RE },
      nationality: { type: 'string', pattern: COUNTRY_RE },
      expiry: {
        required: true,
        type: 'date',
        custom: (v, { ctx }) =>
          isDateStr(ctx.travelDate) ? true : v > refToday(ctx) || { code: 'future' },
      },
      issueDate: {
        type: 'date',
        custom: (v, { parent, ctx }) => {
          if (v > refToday(ctx)) return 'past';
          return parent && isDateStr(parent.expiry) && v > parent.expiry ? 'dateOrder' : true;
        },
      },
    },
    custom: (doc, { ctx }) =>
      isDateStr(ctx.travelDate) && isDateStr(doc.expiry)
        ? documentValid(doc, ctx.travelDate, { minValidityMonths: months })
        : true,
  };
}

/**
 * Schema for a `Traveler` of `paxType` under `TravelerRequirements`: type, names per `nameRules`
 * (`name`, `maxLength`, combined `nameLength`), gender, date of birth not in the future (`past`) and
 * — with `ctx.travelDate` — matching the passenger type (`ageForType`), nationality (required when
 * `apis`), documents (required when a `DocumentRule` of the type says so, each validated with
 * `schemas.document`), loyalty accounts, KTN / redress, preferences, optional e‑mail and phone;
 * backend `FieldRule`s of the type are overlaid last. Effects: none.
 * @param {TravelerRequirements|Partial<TravelerRequirements>} [requirements]
 * @param {PaxType} [paxType]
 * @returns {Schema}
 * @throws {ValidationError} when `requirements.ageRules` is inconsistent (`infantMax > childMax`)
 */
function travelerSchema(requirements, paxType) {
  const req = isObjectLike(requirements) ? /** @type {Record<string, any>} */ (requirements) : {};
  const nameRules = {
    ...DEFAULT_NAME_RULES,
    ...(isObjectLike(req.nameRules) ? req.nameRules : {}),
  };
  const nameMax = isFiniteNumber(nameRules.maxLength)
    ? nameRules.maxLength
    : DEFAULT_NAME_RULES.maxLength;
  const charset = nameRules.charset === 'any' ? 'any' : 'latin';
  const rules = ageRules(req.ageRules);
  const type = PAX_TYPES.includes(paxType) ? paxType : undefined;
  const perType =
    type && isObjectLike(req.perType) && isObjectLike(req.perType[type]) ? req.perType[type] : {};
  /** @type {DocumentRule[]} */
  const docRules = Array.isArray(perType.documents) ? perType.documents.filter(isObjectLike) : [];
  const docRequired = docRules.some((d) => d.required === true);
  const docTypes = [...new Set(docRules.flatMap((d) => (Array.isArray(d.types) ? d.types : [])))];
  const minValidity = docRules.reduce(
    (n, d) => (isFiniteNumber(d.minValidityMonths) ? Math.max(n, d.minValidityMonths) : n),
    0
  );
  /** @returns {Rule} */
  const nameRule = (required) => ({
    required,
    type: 'string',
    maxLength: nameMax,
    custom: (v) => isNameValid(v, { maxLength: nameMax, charset }) || 'name',
  });
  /** @type {Record<string, Schema>} */
  const props = {
    type: { required: true, enum: type ? [type] : [...PAX_TYPES] },
    title: { type: 'string', maxLength: 10 },
    firstName: nameRule(true),
    middleName: nameRule(false),
    lastName: nameRule(true),
    gender: { required: true, enum: GENDERS },
    dob: {
      required: true,
      type: 'date',
      custom: (v, { ctx }) => {
        const t = refToday(ctx);
        return v > t ? { code: 'past', params: { max: t } } : true;
      },
    },
    nationality: { required: req.apis === true, type: 'string', pattern: COUNTRY_RE },
    documents: {
      required: docRequired,
      type: 'array',
      items: documentSchema({
        types: docTypes.length ? docTypes : [...DOCUMENT_TYPES],
        required: docRequired,
        minValidityMonths: minValidity,
      }),
    },
    loyalty: {
      type: 'array',
      items: {
        type: 'object',
        props: {
          airline: { required: true, type: 'string', pattern: AIRLINE_RE },
          programme: { type: 'string', maxLength: 60 },
          number: { required: true, type: 'string', minLength: 2, maxLength: 25 },
        },
      },
    },
    knownTravelerNumber: { type: 'string', pattern: ALNUM_ID_RE },
    redressNumber: { type: 'string', pattern: ALNUM_ID_RE },
    mealPref: { type: 'string', maxLength: 10 },
    seatPref: { type: 'string', maxLength: 10 },
    assistance: { type: 'array', items: { required: true, type: 'string' } },
    email: emailRule(false),
    phone: phoneRule(false),
  };
  applyFieldRules(props, perType.fields);
  return {
    required: true,
    type: 'object',
    props,
    custom: (t, { ctx }) => {
      /** @type {Partial<ValidationIssue>[]} */
      const out = [];
      if (
        typeof t.firstName === 'string' &&
        typeof t.lastName === 'string' &&
        t.firstName.length <= nameMax &&
        t.lastName.length <= nameMax &&
        !namesFitTicket(t.firstName, t.lastName, nameMax)
      ) {
        out.push({ path: 'lastName', code: 'nameLength', params: { max: nameMax } });
      }
      if (type && isDateStr(ctx.travelDate) && isDateStr(t.dob) && t.dob <= refToday(ctx)) {
        out.push(...travelerMatchesSlot(t, { type }, rules, ctx.travelDate));
      }
      return out;
    },
  };
}

/**
 * Schema for the GST invoice block (`Contact.gst`): GSTIN with checksum (`gstin`), company name,
 * optional address and e‑mail. Effects: none.
 * @returns {Schema}
 */
function gstSchema() {
  return {
    required: true,
    type: 'object',
    props: {
      number: { required: true, type: 'string', custom: (v) => isGstin(v) || 'gstin' },
      company: { required: true, type: 'string', minLength: 2, maxLength: 120 },
      address: { type: 'string', maxLength: 250 },
      email: emailRule(false),
    },
  };
}

/**
 * Schema for an `Address`. The country drives the rules: `postalCode` is required except in
 * markets without postal codes (AE, HK, MO, QA) and checked with `isPostalCode` (`postalCode`);
 * `state` is required in US, CA, AU and IN; `countryCode` is required unless `country` is given.
 * Without `country`, the address's own `countryCode` is used. Effects: none.
 * @param {string} [country]  ISO‑3166 alpha‑2
 * @returns {Schema}
 */
function addressSchema(country) {
  const fixed = countryOf(country);
  const resolve = (parent) => fixed || (parent ? countryOf(parent.countryCode) : '');
  return {
    required: true,
    type: 'object',
    props: {
      line1: { required: true, type: 'string', minLength: 2, maxLength: 120 },
      line2: { type: 'string', maxLength: 120 },
      city: { required: true, type: 'string', minLength: 1, maxLength: 80 },
      state: [
        { type: 'string', maxLength: 80 },
        { when: (p) => STATE_REQUIRED.includes(resolve(p)), required: true },
      ],
      postalCode: [
        {
          type: 'string',
          maxLength: 12,
          custom: (v, { parent }) => isPostalCode(v, resolve(parent)) || 'postalCode',
        },
        { when: (p) => !NO_POSTAL_CODE.includes(resolve(p)), required: true },
      ],
      countryCode: { required: !fixed, type: 'string', pattern: COUNTRY_RE },
    },
  };
}

/**
 * Schema for a `Contact`: e‑mail (`email`), E.164 phone (`phone`), optional emergency contact,
 * address (`schemas.address` keyed by its own `countryCode`) and GST block (`schemas.gst`); backend
 * `requirements.contact` `FieldRule`s are overlaid last. Effects: none.
 * @param {TravelerRequirements|Partial<TravelerRequirements>} [requirements]
 * @returns {Schema}
 */
function contactSchema(requirements) {
  const req = isObjectLike(requirements) ? /** @type {Record<string, any>} */ (requirements) : {};
  /** @type {Record<string, Schema>} */
  const props = {
    email: emailRule(true),
    phone: phoneRule(true),
    emergency: {
      type: 'object',
      props: {
        name: {
          required: true,
          type: 'string',
          maxLength: 120,
          custom: (v) => isNameValid(v, { maxLength: Infinity, charset: 'any' }) || 'name',
        },
        phone: phoneRule(true),
      },
    },
    address: { .../** @type {Rule} */ (addressSchema()), required: false },
    gst: { .../** @type {Rule} */ (gstSchema()), required: false },
  };
  applyFieldRules(props, req.contact);
  return { required: true, type: 'object', props };
}

/**
 * Schema for a promo code string: 2‑32 characters, letters / digits / `_` / `-` (`promo`).
 * Effects: none.
 * @returns {Schema}
 */
function promoSchema() {
  return { required: true, type: 'string', custom: (v) => PROMO_RE.test(v.trim()) || 'promo' };
}

/**
 * Schema for non‑hosted card entry `{ number, expMonth, expYear, cvc, name? }`: 12‑19 digits
 * passing Luhn (`card`), an expiry not in the past (`cardExpiry` at `expMonth`; `expYear` must be
 * 2 or 4 digits), a 3‑digit CVC (4 for Amex, either when the brand is unknown — `cvv`) and an
 * optional cardholder name. `ctx.now` overrides the clock. Effects: none.
 * @returns {Schema}
 */
function cardSchema() {
  return {
    required: true,
    type: 'object',
    props: {
      number: {
        required: true,
        custom: (v) => {
          const d = cardDigits(v);
          return (d.length >= 12 && d.length <= 19 && isLuhn(d)) || 'card';
        },
      },
      expMonth: {
        required: true,
        custom: (v, { parent, ctx }) =>
          isEmpty(parent.expYear) ||
          cardExpiryValid(v, parent.expYear, isFiniteNumber(ctx.now) ? ctx.now : undefined) ||
          'cardExpiry',
      },
      expYear: {
        required: true,
        custom: (v) => {
          const n = String(v).trim();
          return (DIGITS_RE.test(n) && (n.length === 2 || n.length === 4)) || 'cardExpiry';
        },
      },
      cvc: {
        required: true,
        custom: (v, { parent }) => {
          const brand = cardBrand(parent.number);
          const d = String(v).trim();
          const ok =
            brand === 'amex'
              ? /^\d{4}$/.test(d)
              : brand === 'unknown'
                ? /^\d{3,4}$/.test(d)
                : /^\d{3}$/.test(d);
          return ok || 'cvv';
        },
      },
      name: { type: 'string', minLength: 2, maxLength: 60, pattern: CARD_NAME_RE },
    },
  };
}

/**
 * Schema for a password string under a `PasswordPolicy`: length bounds (`minLength` /
 * `maxLength`) and the character‑class requirements (`passwordPolicy`, params `{ missing: [...] }`
 * naming what is lacking: `lower`, `upper`, `digit`, `symbol`, `classes`, `spaces`). Effects: none.
 * @param {PasswordPolicy} [policy]
 * @returns {Schema}
 */
function passwordSchema(policy) {
  const src = isObjectLike(policy) ? /** @type {Record<string, any>} */ (policy) : {};
  const p = { ...DEFAULT_PASSWORD_POLICY };
  for (const k of ['minLength', 'maxLength', 'minClasses'])
    if (isFiniteNumber(src[k])) p[k] = src[k];
  for (const k of [
    'requireLower',
    'requireUpper',
    'requireDigit',
    'requireSymbol',
    'allowSpaces',
  ]) {
    if (typeof src[k] === 'boolean') p[k] = src[k];
  }
  return {
    required: true,
    type: 'string',
    minLength: p.minLength,
    maxLength: p.maxLength,
    custom: (v) => {
      /** @type {string[]} */
      const missing = [];
      const hasLower = LOWER_RE.test(v);
      const hasUpper = UPPER_RE.test(v);
      const hasDigit = DIGIT_RE.test(v);
      const hasSymbol = SYMBOL_RE.test(v);
      if (p.requireLower && !hasLower) missing.push('lower');
      if (p.requireUpper && !hasUpper) missing.push('upper');
      if (p.requireDigit && !hasDigit) missing.push('digit');
      if (p.requireSymbol && !hasSymbol) missing.push('symbol');
      const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
      if (classes < p.minClasses) missing.push('classes');
      if (!p.allowSpaces && SPACE_RE.test(v)) missing.push('spaces');
      return (
        missing.length === 0 || {
          code: 'passwordPolicy',
          params: { missing, minClasses: p.minClasses, classes },
        }
      );
    },
  };
}

/**
 * Prebuilt schema factories for the SDK's own inputs; each returns a fresh `Schema` for `validate`.
 * `searchParams(limits)`, `traveler(requirements, paxType)`, `contact(requirements)`,
 * `document(rule)`, `gst()`, `address(country)`, `promo()`, `card()`, `password(policy)`.
 */
export const schemas = Object.freeze({
  searchParams: searchParamsSchema,
  traveler: travelerSchema,
  contact: contactSchema,
  document: documentSchema,
  gst: gstSchema,
  address: addressSchema,
  promo: promoSchema,
  card: cardSchema,
  password: passwordSchema,
});
