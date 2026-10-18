/**
 * Date / time utilities for the Wayfarer SDK (docs/api/03-utils.md §2). Airport local time is kept
 * intact: `parseLocal` turns an ISO‑8601 `DateTime` (with a UTC offset, or Amadeus‑style without one)
 * into a stable wall clock plus its offset, and every formatter / comparator here reads that wall clock
 * unless it is explicitly asked for the viewer's zone (`tz: 'local'`). Offset‑less inputs are flagged
 * (`localTimeOnly`) and compared as a same‑zone wall clock. Everything is pure and uses only `Date` and
 * `Intl`, except `countdown`, whose interval timer is injectable (`options.timers`) and always cleared by
 * the returned `stop()`, on expiry, or when `onTick` throws. SSR‑safe: no `window`, `document`, storage
 * or module‑level mutable state (the only module‑level object is an invisible `Intl.DateTimeFormat`
 * memo); no logging; inputs are never mutated. Plain `Error`s are never thrown — only `ValidationError`.
 */

import { ValidationError } from '../errors/index.js';

/** @typedef {import('../types.js').DateStr} DateStr */
/** @typedef {import('../types.js').DateTime} DateTime */
/** @typedef {import('../types.js').TimeBucket} TimeBucket */
/** @typedef {import('../types.js').PaxType} PaxType */
/** @typedef {import('../types.js').AgeRules} AgeRules */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/**
 * Result of `parseLocal`: the airport wall clock and what is known about its zone.
 * @typedef {Object} LocalDateTime
 * @property {Date} wall                 The local components stored *as if UTC*, so `wall.getUTCHours()`
 *                                       etc. read the airport clock on any host, in any zone.
 * @property {number|null} offsetMinutes UTC offset in minutes (`+05:30` → `330`, `Z` → `0`); `null` when
 *                                       the input carried no offset.
 * @property {string} iso                Canonical `YYYY-MM-DDTHH:mm:ss[.SSS][±HH:mm|Z]`; no suffix at all
 *                                       for offset‑less input, so it round‑trips through `parseLocal`.
 * @property {boolean} localTimeOnly     `true` when no offset was given (Amadeus‑style local time): the
 *                                       value is a wall clock only and does not pin down an instant.
 */

/**
 * Anything accepted where a `DateTime` is documented: an ISO‑8601 string (with or without offset, date
 * only allowed), a `Date` or epoch‑ms number (read in the host zone) or an already parsed `LocalDateTime`.
 * @typedef {DateTime|DateStr|Date|number|LocalDateTime} DateInput
 */

/**
 * Injectable interval timers for `countdown` (defaults to the globals, resolved at call time).
 * @typedef {{ setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} IntervalTimers
 */

/** @typedef {'short'|'medium'|'long'|'weekday'} DateStyle */
/** @typedef {'short'|'long'|'compact'} DurationStyle */
/** @typedef {'local'|'airport'|string} TimeZoneOption  `'airport'` = wall clock, `'local'` = host zone, else an IANA zone. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `YYYY-MM-DD[THH:mm[:ss[.fff]][Z|±HH[:]MM]]`; the offset is only legal after a time part. */
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s?([Zz]|[+-]\d{2}(?::?\d{2})?))?)?$/;

/** @type {Readonly<Record<DateStyle, Readonly<Intl.DateTimeFormatOptions>>>} */
const DATE_STYLES = Object.freeze({
  short: Object.freeze({ day: 'numeric', month: 'short' }),
  medium: Object.freeze({ day: 'numeric', month: 'short', year: 'numeric' }),
  long: Object.freeze({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  weekday: Object.freeze({ weekday: 'short', day: 'numeric', month: 'short' }),
});

/** Default age bands when `AgeRules` leaves them out: infant under 2, child under 12. */
const DEFAULT_INFANT_MAX = 2;
const DEFAULT_CHILD_MAX = 12;

// ── errors ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Build a `ValidationError` with a single issue.
 * @param {string} message @param {string} path @param {string} code @param {object} [params]
 * @returns {ValidationError}
 */
function invalid(message, path, code, params) {
  /** @type {ValidationIssue} */
  const issue = { path, code, message };
  if (params) issue.params = params;
  return new ValidationError(message, { issues: [issue] });
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/** @param {number} n @returns {string} */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** @param {number} n @returns {string} */
function pad3(n) {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n);
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Options bag that tolerates `null` and non‑objects. @param {unknown} v @returns {Record<string, any>} */
function opts(v) {
  return typeof v === 'object' && v !== null ? /** @type {Record<string, any>} */ (v) : {};
}

/**
 * `Math.round` that is symmetric around zero (`-2.5 → -3` just as `2.5 → 3`), never `-0`.
 * @param {number} x @returns {number}
 */
function roundSym(x) {
  return (x < 0 ? -Math.round(-x) : Math.round(x)) || 0;
}

/**
 * `Date.UTC` without the two‑digit‑year quirk: years 0‑99 stay 0‑99 instead of becoming 1900‑1999.
 * Out‑of‑range parts overflow exactly as with `Date.UTC` (day 0 = last day of the previous month).
 * @param {number} y @param {number} mo 1‑12 @param {number} d
 * @param {number} [h] @param {number} [mi] @param {number} [s] @param {number} [ms]
 * @returns {Date}
 */
function utcDate(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  if (y >= 0 && y < 100) date.setUTCFullYear(y, mo - 1, d);
  return date;
}

/** @param {number} year @param {number} month 1‑12 @returns {number} */
function daysInMonth(year, month) {
  return utcDate(year, month + 1, 0).getUTCDate();
}

/**
 * Structural check for an already parsed value; a look‑alike with a malformed `offsetMinutes` is
 * rejected here so it never reaches `Intl` (which would throw a plain `RangeError`).
 * @param {unknown} v @returns {v is LocalDateTime}
 */
function isLocalDateTime(v) {
  if (typeof v !== 'object' || v === null) return false;
  const o = /** @type {Record<string, unknown>} */ (v);
  return (
    o.wall instanceof Date &&
    (o.offsetMinutes === null || isFiniteNumber(o.offsetMinutes)) &&
    typeof o.localTimeOnly === 'boolean'
  );
}

/**
 * `Z` / `±HH:MM` / `±HHMM` / `±HH` → minutes east of UTC, or `undefined` when out of range.
 * @param {string} s
 * @returns {number|undefined}
 */
function parseOffset(s) {
  if (s === 'Z' || s === 'z') return 0;
  const sign = s[0] === '-' ? -1 : 1;
  const digits = s.slice(1).replace(':', '');
  const hh = Number(digits.slice(0, 2));
  const mm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  if (hh > 23 || mm > 59) return undefined;
  return sign * (hh * 60 + mm) || 0;
}

/** @param {number} offsetMinutes @returns {string} `±HH:MM` */
function formatOffset(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Assemble a `LocalDateTime` from validated components.
 * @param {number[]} c `[year, month(1‑12), day, hour, minute, second, ms]`
 * @param {number|null} offsetMinutes
 * @param {boolean} zulu  Input said `Z` (kept on `iso`).
 * @param {string} path
 * @param {unknown} original
 * @returns {LocalDateTime}
 */
function build(c, offsetMinutes, zulu, path, original) {
  const [y, mo, d, h, mi, s, ms] = c;
  const inRange =
    mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h <= 23 && mi <= 59 && s <= 59;
  if (!inRange) {
    throw invalid(`Invalid date/time "${String(original)}"`, path, 'invalid_datetime', {
      value: original,
    });
  }
  const wall = utcDate(y, mo, d, h, mi, s, ms);
  let iso = `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
  if (ms) iso += `.${pad3(ms)}`;
  if (offsetMinutes !== null) iso += zulu ? 'Z' : formatOffset(offsetMinutes);
  return { wall, offsetMinutes, iso, localTimeOnly: offsetMinutes === null };
}

/**
 * A `Date` (an instant) read in the host zone.
 * @param {Date} date @param {string} path @param {unknown} original
 * @returns {LocalDateTime}
 */
function fromInstant(date, path, original) {
  if (Number.isNaN(date.getTime())) {
    throw invalid(`Invalid date "${String(original)}"`, path, 'invalid_datetime', {
      value: original,
    });
  }
  const c = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
  return build(c, -date.getTimezoneOffset() || 0, false, path, original);
}

/**
 * Normalise any `DateInput` to a `LocalDateTime`.
 * @param {unknown} value @param {string} [path='dt']
 * @returns {LocalDateTime}
 */
function toParsed(value, path = 'dt') {
  if (isLocalDateTime(value)) {
    if (Number.isNaN(value.wall.getTime())) {
      throw invalid('Invalid parsed date/time', path, 'invalid_datetime');
    }
    return value;
  }
  if (typeof value === 'string') {
    const m = DATETIME_RE.exec(value.trim());
    if (!m) {
      throw invalid(`Invalid date/time "${value}"`, path, 'invalid_datetime', { value });
    }
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac, off] = m;
    let offsetMinutes = null;
    if (off !== undefined) {
      const parsed = parseOffset(off);
      if (parsed === undefined) {
        throw invalid(`Invalid UTC offset in "${value}"`, path, 'invalid_offset', { value });
      }
      offsetMinutes = parsed;
    }
    const ms = frac ? Number(`${frac}00`.slice(0, 3)) : 0;
    const c = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), ms];
    return build(c, offsetMinutes, off === 'Z' || off === 'z', path, value);
  }
  if (value instanceof Date) return fromInstant(value, path, value);
  if (isFiniteNumber(value)) return fromInstant(new Date(value), path, value);
  throw invalid('Expected an ISO-8601 date/time string, a Date or a timestamp', path, 'required', {
    value,
  });
}

/**
 * The instant a parsed value denotes, in epoch ms. Offset‑less values (`localTimeOnly`) are read in the
 * host zone, which is what `new Date('2026-11-02T06:45:00')` does too.
 * @param {LocalDateTime} p
 * @returns {number}
 */
function epochMs(p) {
  const w = p.wall;
  if (p.offsetMinutes !== null) return w.getTime() - p.offsetMinutes * MINUTE;
  const local = new Date(0);
  local.setFullYear(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  local.setHours(w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds());
  return local.getTime();
}

/** @param {Date} wall @returns {DateStr} */
function keyOfWall(wall) {
  return `${String(wall.getUTCFullYear()).padStart(4, '0')}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
}

/** Calendar day of a wall clock as a whole number of days since the epoch. @param {Date} wall @returns {number} */
function dayNumber(wall) {
  return Math.floor(wall.getTime() / DAY);
}

/** @param {unknown} v @param {string} [path] @returns {number} epoch ms */
function nowMs(v, path = 'now') {
  if (v === undefined || v === null) return Date.now();
  if (v instanceof Date) return v.getTime();
  if (isFiniteNumber(v)) return v;
  throw invalid('Expected a timestamp or Date', path, 'invalid_datetime', { value: v });
}

/**
 * `Intl.DateTimeFormat` memo (construction is the expensive part when rendering result lists).
 * @type {Map<string, Intl.DateTimeFormat>}
 */
const DTF_CACHE = new Map();
const DTF_CACHE_MAX = 100;

/**
 * @param {string|string[]|undefined} locale
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {Intl.DateTimeFormat}
 */
function dtf(locale, options) {
  const key = `${JSON.stringify(locale ?? null)}|${JSON.stringify(options)}`;
  let f = DTF_CACHE.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch (e) {
      const cause = e instanceof Error ? e.message : e;
      let localeOk = true;
      try {
        new Intl.DateTimeFormat(locale);
      } catch {
        localeOk = false;
      }
      if (localeOk && options.timeZone) {
        throw invalid(`Unknown time zone "${options.timeZone}"`, 'tz', 'invalid_timezone', {
          value: options.timeZone,
          cause,
        });
      }
      throw invalid(`Unsupported locale "${String(locale)}"`, 'locale', 'invalid_locale', {
        value: locale,
        cause,
      });
    }
    if (DTF_CACHE.size >= DTF_CACHE_MAX) DTF_CACHE.clear();
    DTF_CACHE.set(key, f);
  }
  return f;
}

/**
 * Reject a structurally invalid BCP 47 tag the same way `Intl` constructors do, without depending on
 * the constructor that will consume it (used where that constructor has a non‑throwing fallback).
 * @param {unknown} locale
 * @returns {void}
 */
function assertLocale(locale) {
  if (locale === undefined) return;
  try {
    Intl.getCanonicalLocales(/** @type {any} */ (locale));
  } catch (e) {
    throw invalid(`Unsupported locale "${String(locale)}"`, 'locale', 'invalid_locale', {
      value: locale,
      cause: e instanceof Error ? e.message : e,
    });
  }
}

/**
 * Hour options honouring `hour12` without the `24:00` quirk of `hour12: false`. 24‑hour clocks (by
 * request or by locale) get two‑digit hours (`06:45`), 12‑hour clocks keep `6:45 AM`.
 * @param {unknown} hour12 `true`, `false` or `undefined` / `null` (locale default)
 * @param {string|string[]|undefined} locale
 * @returns {Intl.DateTimeFormatOptions}
 * @throws {ValidationError} when `hour12` is not a boolean
 */
function hourOptions(hour12, locale) {
  if (hour12 !== undefined && hour12 !== null && typeof hour12 !== 'boolean') {
    throw invalid('Expected hour12 to be a boolean', 'hour12', 'invalid_option', { value: hour12 });
  }
  /** @type {Intl.DateTimeFormatOptions} */
  const o = { hour: 'numeric', minute: '2-digit' };
  if (hour12 === true) o.hour12 = true;
  else if (hour12 === false) o.hourCycle = 'h23';
  const cycle = dtf(locale, o).resolvedOptions().hourCycle;
  return cycle === 'h23' || cycle === 'h24' ? { ...o, hour: '2-digit' } : o;
}

/**
 * Pick the `Date` to hand to `Intl` and the zone to render it in.
 * @param {LocalDateTime} p
 * @param {TimeZoneOption|undefined} tz
 * @returns {{ date: Date, timeZone: string|undefined }}
 */
function zoneTarget(p, tz) {
  if (tz === undefined || tz === null || tz === 'airport') return { date: p.wall, timeZone: 'UTC' };
  if (tz === 'local') return { date: new Date(epochMs(p)), timeZone: undefined };
  if (typeof tz !== 'string' || tz === '') {
    throw invalid(
      "Expected tz to be 'local', 'airport' or an IANA zone",
      'tz',
      'invalid_timezone',
      {
        value: tz,
      }
    );
  }
  return { date: new Date(epochMs(p)), timeZone: tz };
}

/**
 * @param {unknown} style @param {DateStyle} fallback
 * @returns {Intl.DateTimeFormatOptions}
 */
function dateStyleOptions(style, fallback) {
  const s = style === undefined ? fallback : style;
  // Own keys only: `'constructor'` / `'__proto__'` must not resolve through the prototype chain.
  if (typeof s !== 'string' || !Object.prototype.hasOwnProperty.call(DATE_STYLES, s)) {
    throw invalid(
      "Expected style to be 'short', 'medium', 'long' or 'weekday'",
      'style',
      'invalid_style',
      { value: style }
    );
  }
  return DATE_STYLES[/** @type {DateStyle} */ (s)];
}

/** Strict `YYYY-MM-DD` → `[year, month, day]`. @param {unknown} v @param {string} path */
function dateKeyParts(v, path) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw invalid(`Expected a YYYY-MM-DD date, got "${String(v)}"`, path, 'invalid_date', {
      value: v,
    });
  }
  const p = toParsed(v, path).wall;
  return [p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate()];
}

// ── parsing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `DateTime` keeping the airport local time intact (no zone shift). `2026-11-02T06:45:00+05:30`
 * gives a `wall` that reads 06:45 on every host, `offsetMinutes: 330` and a canonical `iso`. Amadeus‑style
 * offset‑less local times (`2026-11-02T06:45:00`) parse too and come back with `offsetMinutes: null`,
 * `localTimeOnly: true`. Date‑only strings parse as local midnight; a `Date` / timestamp is read in the
 * host zone; an existing `LocalDateTime` is returned as is.
 * @param {DateInput} dt
 * @returns {LocalDateTime}
 * @throws {ValidationError} on an unparseable or out‑of‑range value
 */
export function parseLocal(dt) {
  return toParsed(dt, 'dt');
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

/**
 * Format the time of day with `Intl`. `tz: 'airport'` (default) shows the airport wall clock,
 * `tz: 'local'` the same instant in the viewer's zone (identical for offset‑less input), any other string
 * is used as an IANA zone.
 * @param {DateInput} dt
 * @param {{ locale?: string|string[], hour12?: boolean, tz?: TimeZoneOption }} [options]
 * @returns {string} e.g. `06:45` / `6:45 AM`
 * @throws {ValidationError}
 */
export function formatTime(dt, options = {}) {
  options = opts(options);
  const p = toParsed(dt, 'dt');
  const { date, timeZone } = zoneTarget(p, options.tz);
  const o = hourOptions(options.hour12, options.locale);
  if (timeZone) o.timeZone = timeZone;
  return dtf(options.locale, o).format(date);
}

/**
 * Format a calendar date (`DateTime` or `DateStr`) with `Intl`. Styles: `short` → `2 Nov`, `medium`
 * (default) → `2 Nov 2026`, `long` → `Monday 2 November 2026`, `weekday` → `Mon 2 Nov` (order and
 * punctuation follow the locale).
 * @param {DateInput} d
 * @param {{ style?: DateStyle, locale?: string|string[] }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function formatDate(d, options = {}) {
  options = opts(options);
  const p = toParsed(d, 'dt');
  const o = { ...dateStyleOptions(options.style, 'medium'), timeZone: 'UTC' };
  return dtf(options.locale, o).format(p.wall);
}

/**
 * Format date and time together in one locale‑aware string (`2 Nov 2026, 06:45`). `style` picks the date
 * part as in `formatDate`; `hour12` / `tz` behave as in `formatTime`.
 * @param {DateInput} dt
 * @param {{ style?: DateStyle, locale?: string|string[], hour12?: boolean, tz?: TimeZoneOption }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function formatDateTime(dt, options = {}) {
  options = opts(options);
  const p = toParsed(dt, 'dt');
  const { date, timeZone } = zoneTarget(p, options.tz);
  const o = {
    ...dateStyleOptions(options.style, 'medium'),
    ...hourOptions(options.hour12, options.locale),
  };
  if (timeZone) o.timeZone = timeZone;
  return dtf(options.locale, o).format(date);
}

/**
 * Format a date range (`2 – 9 Nov 2026`) using `Intl.DateTimeFormat#formatRange` when available, else
 * `a – b`. A single date (same calendar day, or `b` missing) renders as `formatDate(a)`.
 * @param {DateInput} a
 * @param {DateInput|null|undefined} b
 * @param {{ style?: DateStyle, locale?: string|string[] }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function formatDateRange(a, b, options = {}) {
  options = opts(options);
  const pa = toParsed(a, 'a');
  if (b === undefined || b === null) return formatDate(pa, options);
  const pb = toParsed(b, 'b');
  if (dayNumber(pa.wall) === dayNumber(pb.wall)) return formatDate(pa, options);
  const [from, to] = pa.wall.getTime() <= pb.wall.getTime() ? [pa, pb] : [pb, pa];
  const f = dtf(options.locale, { ...dateStyleOptions(options.style, 'medium'), timeZone: 'UTC' });
  if (typeof f.formatRange === 'function') return f.formatRange(from.wall, to.wall);
  return `${f.format(from.wall)} – ${f.format(to.wall)}`;
}

/**
 * One duration part, localised through `Intl.NumberFormat` unit style when the engine has it.
 * The locale has been validated by the caller, so a throw here means the engine lacks unit style and
 * English labels are used instead.
 * @param {number} n @param {'day'|'hour'|'minute'} unit @param {'narrow'|'short'} display
 * @param {string|string[]|undefined} locale
 * @returns {string}
 */
function durationPart(n, unit, display, locale) {
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: display }).format(n);
  } catch {
    const label =
      display === 'narrow'
        ? { day: 'd', hour: 'h', minute: 'm' }[unit]
        : { day: n === 1 ? ' day' : ' days', hour: ' hr', minute: ' min' }[unit];
    return `${n}${label}`;
  }
}

/**
 * Format a duration given in minutes. `short` (default) → `2h 35m`, `long` → `2 hr 35 min`, `compact` →
 * `2:35` (hours:minutes, days folded into hours). Days appear for 24 h and more (`1d 2h 35m`); zero parts
 * are dropped except for a zero duration (`0m` / `0 min` / `0:00`). Minutes are rounded to integers.
 * @param {number} minutes
 * @param {{ style?: DurationStyle, locale?: string|string[] }} [options]
 * @returns {string}
 * @throws {ValidationError} when `minutes` is not a finite number, `style` is unknown or `locale` is not a valid tag
 */
export function formatDuration(minutes, options = {}) {
  options = opts(options);
  if (!isFiniteNumber(minutes)) {
    throw invalid('Expected minutes to be a finite number', 'minutes', 'invalid_duration', {
      value: minutes,
    });
  }
  const style = options.style === undefined ? 'short' : options.style;
  if (style !== 'short' && style !== 'long' && style !== 'compact') {
    throw invalid("Expected style to be 'short', 'long' or 'compact'", 'style', 'invalid_style', {
      value: options.style,
    });
  }
  assertLocale(options.locale);
  const total = Math.round(Math.abs(minutes));
  const sign = minutes < 0 && total > 0 ? '-' : '';
  const m = total % 60;
  if (style === 'compact') {
    return `${sign}${Math.floor(total / 60)}:${pad2(m)}`;
  }
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const display = style === 'short' ? 'narrow' : 'short';
  /** @type {string[]} */
  const parts = [];
  if (d) parts.push(durationPart(d, 'day', display, options.locale));
  if (h) parts.push(durationPart(h, 'hour', display, options.locale));
  if (m || parts.length === 0) parts.push(durationPart(m, 'minute', display, options.locale));
  return sign + parts.join(' ');
}

// ── comparisons ─────────────────────────────────────────────────────────────────────────────────

/**
 * Minutes from `a` to `b` (negative when `b` is earlier). Offset‑aware when both carry an offset
 * (`06:45+05:30 → 09:30+04:00` is 225 min); when either is offset‑less both are compared as a same‑zone
 * wall clock. Rounded to whole minutes, symmetrically (`durationBetween(b, a) === -durationBetween(a, b)`).
 * @param {DateInput} a
 * @param {DateInput} b
 * @returns {number}
 * @throws {ValidationError}
 */
export function durationBetween(a, b) {
  const pa = toParsed(a, 'a');
  const pb = toParsed(b, 'b');
  const diff =
    pa.offsetMinutes !== null && pb.offsetMinutes !== null
      ? epochMs(pb) - epochMs(pa)
      : pb.wall.getTime() - pa.wall.getTime();
  return roundSym(diff / MINUTE);
}

/**
 * Difference in local calendar days between `a` and `b` (`+1` badges): compares each value's own local
 * date, never a shifted instant, so `23:50+05:30 → 00:40+04:00` next day is `1`.
 * @param {DateInput} a
 * @param {DateInput} b
 * @returns {number} `b`'s local date minus `a`'s, in days (negative when `b` is earlier)
 * @throws {ValidationError}
 */
export function dayDiff(a, b) {
  const pa = toParsed(a, 'a');
  const pb = toParsed(b, 'b');
  return dayNumber(pb.wall) - dayNumber(pa.wall);
}

/**
 * Whether `b` falls on a later local calendar day than `a` (overnight flight or layover).
 * @param {DateInput} a
 * @param {DateInput} b
 * @returns {boolean}
 * @throws {ValidationError}
 */
export function isOvernight(a, b) {
  return dayDiff(a, b) >= 1;
}

/**
 * Time‑of‑day bucket of the airport wall clock: `00:00–05:59` → `early_morning`, `06:00–11:59` →
 * `morning`, `12:00–17:59` → `afternoon`, `18:00–23:59` → `evening`. `night` is an alias for
 * `early_morning` accepted by filters; pass `{ night: true }` to get the alias instead.
 * @param {DateInput} dt
 * @param {{ night?: boolean }} [options]
 * @returns {TimeBucket}
 * @throws {ValidationError}
 */
export function timeBucket(dt, options = {}) {
  options = opts(options);
  const hour = toParsed(dt, 'dt').wall.getUTCHours();
  if (hour < 6) return options.night === true ? 'night' : 'early_morning';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * Minutes since local midnight of the airport wall clock (`06:45` → `405`).
 * @param {DateInput} dt
 * @returns {number}
 * @throws {ValidationError}
 */
export function minutesOfDay(dt) {
  const w = toParsed(dt, 'dt').wall;
  return w.getUTCHours() * 60 + w.getUTCMinutes();
}

// ── calendar dates ──────────────────────────────────────────────────────────────────────────────

/**
 * Add `n` calendar days to a `YYYY-MM-DD` date (negative to subtract; fractions are truncated).
 * @param {DateStr} d
 * @param {number} n
 * @returns {DateStr}
 * @throws {ValidationError}
 */
export function addDays(d, n) {
  const [y, m, day] = dateKeyParts(d, 'd');
  if (!isFiniteNumber(n)) {
    throw invalid('Expected n to be a finite number of days', 'n', 'invalid_number', { value: n });
  }
  return keyOfWall(utcDate(y, m, day + Math.trunc(n)));
}

/**
 * Calendar days from `a` to `b` (`DateStr` or `DateTime`, compared by local date); negative when `b` is
 * earlier.
 * @param {DateInput} a
 * @param {DateInput} b
 * @returns {number}
 * @throws {ValidationError}
 */
export function diffDays(a, b) {
  return dayDiff(a, b);
}

/**
 * Today's date as `YYYY-MM-DD` in the host zone, or in the given IANA zone.
 * @param {string} [tz]      IANA zone, e.g. `Asia/Kolkata` (`'local'` = host zone)
 * @param {number|Date} [now] Clock override (defaults to `Date.now()`)
 * @returns {DateStr}
 * @throws {ValidationError} on an unknown zone
 */
export function today(tz, now) {
  const at = new Date(nowMs(now));
  if (tz === undefined || tz === null || tz === 'local')
    return keyOfWall(fromInstant(at, 'now', at).wall);
  if (typeof tz !== 'string' || tz === '') {
    throw invalid('Expected tz to be an IANA zone name', 'tz', 'invalid_timezone', { value: tz });
  }
  const parts = dtf('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  /** @type {Record<string, string>} */
  const byType = {};
  for (const part of parts) byType[part.type] = part.value;
  return `${byType.year.padStart(4, '0')}-${byType.month}-${byType.day}`;
}

/**
 * Whether the instant denoted by `dt` is before `now`. Offset‑less input is read in the host zone.
 * @param {DateInput} dt
 * @param {number|Date} [now] Clock override (defaults to `Date.now()`)
 * @returns {boolean}
 * @throws {ValidationError}
 */
export function isPast(dt, now) {
  return epochMs(toParsed(dt, 'dt')) < nowMs(now);
}

/**
 * `YYYY-MM-DD` of a `Date` in the host zone (also accepts a `DateTime`, whose own local date is used).
 * @param {Date|DateInput} date
 * @returns {DateStr}
 * @throws {ValidationError}
 */
export function toDateKey(date) {
  return keyOfWall(toParsed(date, 'date').wall);
}

/**
 * `YYYY-MM-DD` → `Date` at local midnight in the host zone (the inverse of `toDateKey`).
 * @param {DateStr} d
 * @returns {Date}
 * @throws {ValidationError}
 */
export function fromDateKey(d) {
  const [y, m, day] = dateKeyParts(d, 'd');
  const out = new Date(0);
  out.setFullYear(y, m - 1, day);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Clamp a date into `[min, max]`; either bound may be omitted (`null` / `undefined`).
 * @param {DateInput} d
 * @param {DateInput|null} [min]
 * @param {DateInput|null} [max]
 * @returns {DateStr}
 * @throws {ValidationError} when `min` is after `max`
 */
export function clampDate(d, min, max) {
  const key = keyOfWall(toParsed(d, 'd').wall);
  const lo = min === undefined || min === null ? null : keyOfWall(toParsed(min, 'min').wall);
  const hi = max === undefined || max === null ? null : keyOfWall(toParsed(max, 'max').wall);
  if (lo !== null && hi !== null && lo > hi) {
    throw invalid('min must not be after max', 'min', 'invalid_range', { min: lo, max: hi });
  }
  if (lo !== null && key < lo) return lo;
  if (hi !== null && key > hi) return hi;
  return key;
}

/**
 * Calendar grid for a month: rows of seven `YYYY-MM-DD` cells, `null` outside the month. `month` is
 * 1‑12; `firstDay` is the weekday the rows start on (`0` Sunday … `6` Saturday, default `1` Monday).
 * @param {number} year
 * @param {number} month 1‑12
 * @param {{ firstDay?: number }} [options]
 * @returns {(DateStr|null)[][]}
 * @throws {ValidationError}
 */
export function monthMatrix(year, month, options = {}) {
  options = opts(options);
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw invalid('Expected year to be an integer between 0 and 9999', 'year', 'invalid_number', {
      value: year,
    });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw invalid('Expected month to be an integer between 1 and 12', 'month', 'invalid_number', {
      value: month,
    });
  }
  const firstDay = options.firstDay === undefined ? 1 : options.firstDay;
  if (!Number.isInteger(firstDay) || firstDay < 0 || firstDay > 6) {
    throw invalid(
      'Expected firstDay to be an integer between 0 (Sunday) and 6 (Saturday)',
      'firstDay',
      'invalid_number',
      { value: options.firstDay }
    );
  }
  const first = utcDate(year, month, 1);
  const lead = (first.getUTCDay() - firstDay + 7) % 7;
  const days = daysInMonth(year, month);
  /** @type {(DateStr|null)[]} */
  const cells = new Array(lead).fill(null);
  for (let d = 1; d <= days; d++) {
    cells.push(`${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(d)}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  /** @type {(DateStr|null)[][]} */
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

// ── relative time ───────────────────────────────────────────────────────────────────────────────

/**
 * Pick the unit and rounded value for `Intl.RelativeTimeFormat`.
 * @param {number} diffMs
 * @returns {[number, Intl.RelativeTimeFormatUnit]}
 */
function relativeUnit(diffMs) {
  const abs = Math.abs(diffMs);
  const sign = diffMs < 0 ? -1 : 1;
  if (abs < 45 * SECOND) return [0, 'second'];
  if (abs < 90 * SECOND) return [sign, 'minute'];
  if (abs < 45 * MINUTE) return [roundSym(diffMs / MINUTE), 'minute'];
  if (abs < 90 * MINUTE) return [sign, 'hour'];
  if (abs < 22 * HOUR) return [roundSym(diffMs / HOUR), 'hour'];
  if (abs < 36 * HOUR) return [sign, 'day'];
  if (abs < 26 * DAY) return [roundSym(diffMs / DAY), 'day'];
  if (abs < 45 * DAY) return [sign, 'month'];
  if (abs < 320 * DAY) return [roundSym(diffMs / (30.4375 * DAY)), 'month'];
  if (abs < 548 * DAY) return [sign, 'year'];
  return [roundSym(diffMs / (365.25 * DAY)), 'year'];
}

/**
 * Human relative time via `Intl.RelativeTimeFormat`: `in 3 days`, `2 hours ago`, `tomorrow`, `now`.
 * Offset‑less input is read in the host zone.
 * @param {DateInput} dt
 * @param {{ locale?: string|string[], now?: number|Date, style?: 'long'|'short'|'narrow', numeric?: 'always'|'auto' }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
export function relativeTime(dt, options = {}) {
  options = opts(options);
  const diff = epochMs(toParsed(dt, 'dt')) - nowMs(options.now);
  const [value, unit] = relativeUnit(diff);
  /** @type {Intl.RelativeTimeFormat} */
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(options.locale, {
      numeric: options.numeric === 'always' ? 'always' : 'auto',
      style: options.style === 'short' || options.style === 'narrow' ? options.style : 'long',
    });
  } catch (e) {
    throw invalid(`Unsupported locale "${String(options.locale)}"`, 'locale', 'invalid_locale', {
      value: options.locale,
      cause: e instanceof Error ? e.message : e,
    });
  }
  return rtf.format(value === 0 ? 0 : value, unit);
}

// ── countdown ───────────────────────────────────────────────────────────────────────────────────

/**
 * Tick `onTick(remainingMs)` once immediately and then every `intervalMs` until `until` is reached, when
 * a final `onTick(0)` fires and the timer stops by itself. `until` is a `DateTime` or an epoch‑ms
 * timestamp. Returns an idempotent `stop()` that clears the interval. Timers come from `options.timers`
 * (`{ setInterval, clearInterval }`, both required when given) or the globals, looked up at call time;
 * `options.now` injects the clock (a function returning epoch ms). If `onTick` throws, the countdown
 * stops itself before the error propagates, so a failing callback is reported once rather than on
 * every tick. **Effects: timer** (cleared by `stop()`, on expiry, or when `onTick` throws).
 * @param {DateInput|number} until
 * @param {(remainingMs: number) => void} onTick
 * @param {{ intervalMs?: number, timers?: IntervalTimers, now?: () => number }} [options]
 * @returns {() => void} stop
 * @throws {ValidationError} when `onTick` is not a function, `intervalMs` is not positive, `until` is
 *   invalid, `timers` lacks `setInterval` / `clearInterval` or `now` is not a function
 */
export function countdown(until, onTick, options = {}) {
  options = opts(options);
  if (typeof onTick !== 'function') {
    throw invalid('Expected onTick to be a function', 'onTick', 'required', { value: onTick });
  }
  const intervalMs = options.intervalMs === undefined ? 1000 : options.intervalMs;
  if (!isFiniteNumber(intervalMs) || intervalMs <= 0) {
    throw invalid('Expected intervalMs to be a positive number', 'intervalMs', 'invalid_number', {
      value: options.intervalMs,
    });
  }
  const target = isFiniteNumber(until) ? until : epochMs(toParsed(until, 'until'));
  if (options.now !== undefined && options.now !== null && typeof options.now !== 'function') {
    throw invalid('Expected now to be a function returning epoch ms', 'now', 'invalid_option', {
      value: options.now,
    });
  }
  /** @type {() => number} */
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  /** @type {IntervalTimers|typeof globalThis} */
  let owner = globalThis;
  if (options.timers !== undefined && options.timers !== null) {
    const t = options.timers;
    if (
      typeof t !== 'object' ||
      typeof t.setInterval !== 'function' ||
      typeof t.clearInterval !== 'function'
    ) {
      throw invalid(
        'Expected timers to provide both setInterval and clearInterval',
        'timers',
        'invalid_option',
        { value: t }
      );
    }
    owner = t;
  }
  /** @type {ReturnType<typeof setInterval>|null} */
  let handle = null;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (handle !== null) {
      const h = handle;
      handle = null;
      owner.clearInterval(h);
    }
  }

  function tick() {
    if (stopped) return;
    const remaining = Math.max(0, target - clock());
    if (remaining <= 0) stop();
    try {
      onTick(remaining);
    } catch (e) {
      stop();
      throw e;
    }
  }

  tick();
  if (!stopped) handle = owner.setInterval(tick, intervalMs);
  return stop;
}

// ── ages ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Completed years between `dob` and `on` (birthday not yet reached → one less). `29 Feb` birthdays count
 * the new year from `1 Mar` in common years. Negative when `on` precedes `dob`.
 * @param {DateStr} dob
 * @param {DateStr} on
 * @returns {number}
 * @throws {ValidationError}
 */
export function ageAt(dob, on) {
  const [by, bm, bd] = dateKeyParts(dob, 'dob');
  const [oy, om, od] = dateKeyParts(on, 'on');
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

/**
 * Passenger type for an age: under `rules.infantMax` → `INF`, under `rules.childMax` → `CHD`, else `ADT`
 * (defaults 2 / 12 when a rule is missing). Seated infants (`INS`) and fare‑based types (`YTH`, `SRC`,
 * `STU`) are choices, not ages, and are never returned.
 * @param {number} age
 * @param {AgeRules|Partial<AgeRules>|null} [rules]
 * @returns {PaxType}
 * @throws {ValidationError} on a negative or non‑numeric age, or bands with `infantMax > childMax` / below 0
 */
export function paxTypeForAge(age, rules) {
  if (!isFiniteNumber(age) || age < 0) {
    throw invalid('Expected age to be a non-negative number', 'age', 'invalid_age', { value: age });
  }
  const r = opts(rules);
  const infantMax = isFiniteNumber(r.infantMax) ? r.infantMax : DEFAULT_INFANT_MAX;
  const childMax = isFiniteNumber(r.childMax) ? r.childMax : DEFAULT_CHILD_MAX;
  if (infantMax < 0 || childMax < 0 || infantMax > childMax) {
    throw invalid('Expected age bands with 0 <= infantMax <= childMax', 'rules', 'invalid_rules', {
      infantMax,
      childMax,
    });
  }
  if (age < infantMax) return 'INF';
  if (age < childMax) return 'CHD';
  return 'ADT';
}
