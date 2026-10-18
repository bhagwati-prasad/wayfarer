import { describe, it, expect, vi, afterEach } from 'vitest';
import * as datetime from '../../src/utils/datetime.js';
import {
  parseLocal,
  formatTime,
  formatDate,
  formatDateTime,
  formatDateRange,
  formatDuration,
  durationBetween,
  dayDiff,
  isOvernight,
  timeBucket,
  minutesOfDay,
  addDays,
  diffDays,
  today,
  isPast,
  toDateKey,
  fromDateKey,
  clampDate,
  monthMatrix,
  relativeTime,
  countdown,
  ageAt,
  paxTypeForAge,
} from '../../src/utils/datetime.js';
import { ValidationError } from '../../src/errors/index.js';

/** Collapse ICU's narrow no-break spaces so assertions read naturally. */
const n = (s) => s.replace(/\s/g, ' ');

const DEL = '2026-11-02T06:45:00+05:30'; // Delhi departure
const DXB = '2026-11-02T09:30:00+04:00'; // Dubai arrival, 255 min later
const AMADEUS = '2021-07-04T09:30:00'; // offset-less local time

/** Expect a `ValidationError` whose single issue has `path` / `code`. */
function expectInvalid(fn, path, code) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect(caught.code).toBe('VALIDATION_FAILED');
  expect(caught.issues).toHaveLength(1);
  expect(caught.issues[0].path).toBe(path);
  if (code) expect(caught.issues[0].code).toBe(code);
  return caught;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── module surface ───────────────────────────────────────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly the functions documented in docs/api/03-utils.md §2', () => {
    expect(Object.keys(datetime).sort()).toEqual(
      [
        'parseLocal',
        'formatTime',
        'formatDate',
        'formatDateTime',
        'formatDateRange',
        'formatDuration',
        'durationBetween',
        'dayDiff',
        'isOvernight',
        'timeBucket',
        'minutesOfDay',
        'addDays',
        'diffDays',
        'today',
        'isPast',
        'toDateKey',
        'fromDateKey',
        'clampDate',
        'monthMatrix',
        'relativeTime',
        'countdown',
        'ageAt',
        'paxTypeForAge',
      ].sort()
    );
    for (const value of Object.values(datetime)) expect(typeof value).toBe('function');
  });

  it('imports and runs without a DOM (SSR-safe)', () => {
    // The module was imported in a plain node environment: nothing above touched window / document.
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof formatTime(DEL, { locale: 'en-GB' })).toBe('string');
  });
});

describe('options handling', () => {
  it('treats a null options bag like an empty one', () => {
    expect(formatTime(DEL, null)).toBe(formatTime(DEL));
    expect(formatDate(DEL, null)).toBe(formatDate(DEL));
    expect(formatDateTime(DEL, null)).toBe(formatDateTime(DEL));
    expect(formatDateRange(DEL, DXB, null)).toBe(formatDateRange(DEL, DXB));
    expect(formatDuration(155, null)).toBe(formatDuration(155));
    expect(timeBucket(DEL, null)).toBe('morning');
    expect(monthMatrix(2026, 11, null)).toEqual(monthMatrix(2026, 11));
    expect(typeof relativeTime(DEL, null)).toBe('string');
    const stop = countdown(0, () => {}, null);
    expect(typeof stop).toBe('function');
    stop();
  });

  it('never mutates its inputs (frozen options, rules and parsed values are fine)', () => {
    const frozen = Object.freeze({ locale: 'en-GB', tz: 'local', hour12: false, style: 'short' });
    expect(() => formatTime(DEL, frozen)).not.toThrow();
    expect(() => formatDate(DEL, frozen)).not.toThrow();
    expect(() => formatDateTime(DEL, frozen)).not.toThrow();
    expect(() => formatDateRange(DEL, DXB, frozen)).not.toThrow();
    expect(() => formatDuration(155, Object.freeze({ style: 'long', locale: 'en' }))).not.toThrow();
    expect(() => relativeTime(DEL, Object.freeze({ locale: 'en', now: 0 }))).not.toThrow();
    expect(() => monthMatrix(2026, 11, Object.freeze({ firstDay: 0 }))).not.toThrow();
    expect(() => timeBucket(DEL, Object.freeze({ night: true }))).not.toThrow();
    expect(() => paxTypeForAge(5, Object.freeze({ infantMax: 2, childMax: 12 }))).not.toThrow();
    const stop = countdown(0, () => {}, Object.freeze({ intervalMs: 50 }));
    stop();
    const p = Object.freeze(parseLocal(DEL));
    const wallBefore = p.wall.getTime();
    formatTime(p, { tz: 'local' });
    formatDate(p, { style: 'long' });
    durationBetween(p, DXB);
    dayDiff(p, DXB);
    isPast(p, 0);
    expect(p.wall.getTime()).toBe(wallBefore);
    expect(p.iso).toBe(DEL);
    // formatting one style must not bleed into another (the style table is shared)
    expect(n(formatDate(DEL, { locale: 'en-GB', style: 'short' }))).toBe('2 Nov');
    expect(n(formatDateTime(DEL, { locale: 'en-GB' }))).toBe('2 Nov 2026, 06:45');
    expect(n(formatDate(DEL, { locale: 'en-GB', style: 'short' }))).toBe('2 Nov');
  });

  it('reports a bad locale as such even when a zone is also given', () => {
    expectInvalid(
      () => formatTime(DEL, { locale: 'not a locale!', tz: 'Asia/Kolkata' }),
      'locale',
      'invalid_locale'
    );
    expectInvalid(
      () => formatDate(DEL, { locale: 'not a locale!', style: 'short' }),
      'locale',
      'invalid_locale'
    );
    expectInvalid(() => today('Mars/Olympus'), 'tz', 'invalid_timezone');
  });
});

// ── parseLocal ───────────────────────────────────────────────────────────────────────────────────

describe('parseLocal', () => {
  it('keeps the airport local time intact and reports the offset', () => {
    const p = parseLocal(DEL);
    expect(p.wall.getUTCFullYear()).toBe(2026);
    expect(p.wall.getUTCMonth()).toBe(10);
    expect(p.wall.getUTCDate()).toBe(2);
    expect(p.wall.getUTCHours()).toBe(6);
    expect(p.wall.getUTCMinutes()).toBe(45);
    expect(p.wall.getUTCSeconds()).toBe(0);
    expect(p.offsetMinutes).toBe(330);
    expect(p.iso).toBe(DEL);
    expect(p.localTimeOnly).toBe(false);
  });

  it('understands negative, compact and hour-only offsets', () => {
    expect(parseLocal('2026-11-02T06:45:00-08:00').offsetMinutes).toBe(-480);
    expect(parseLocal('2026-11-02T06:45:00-08:00').iso).toBe('2026-11-02T06:45:00-08:00');
    expect(parseLocal('2026-11-02T06:45:00+0530').offsetMinutes).toBe(330);
    expect(parseLocal('2026-11-02T06:45:00+0530').iso).toBe(DEL);
    expect(parseLocal('2026-11-02T06:45:00+05').offsetMinutes).toBe(300);
    expect(parseLocal('2026-11-02T06:45:00+05').iso).toBe('2026-11-02T06:45:00+05:00');
    expect(parseLocal('2026-11-02T06:45:00-00:00').offsetMinutes).toBe(0);
    expect(Object.is(parseLocal('2026-11-02T06:45:00-00:00').offsetMinutes, -0)).toBe(false);
  });

  it('treats Z as offset 0 and keeps the Z on the canonical iso', () => {
    const p = parseLocal('2018-06-19T00:00:00.000Z');
    expect(p.offsetMinutes).toBe(0);
    expect(p.localTimeOnly).toBe(false);
    expect(p.iso).toBe('2018-06-19T00:00:00Z');
    expect(parseLocal('2018-06-19T00:00:00+00:00').iso).toBe('2018-06-19T00:00:00+00:00');
  });

  it('parses Amadeus-style offset-less local times and flags them', () => {
    const p = parseLocal(AMADEUS);
    expect(p.wall.toISOString()).toBe('2021-07-04T09:30:00.000Z');
    expect(p.offsetMinutes).toBeNull();
    expect(p.localTimeOnly).toBe(true);
    expect(p.iso).toBe(AMADEUS);
    expect(parseLocal(p.iso)).toEqual(p);
  });

  it('parses a date-only string as local midnight without an offset', () => {
    const p = parseLocal('2026-11-02');
    expect(p.wall.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(p.offsetMinutes).toBeNull();
    expect(p.localTimeOnly).toBe(true);
    expect(p.iso).toBe('2026-11-02T00:00:00');
  });

  it('keeps non-zero fractional seconds and accepts a comma, lower case and a space separator', () => {
    expect(parseLocal('2026-11-02T06:45:00.072-08:00').iso).toBe('2026-11-02T06:45:00.072-08:00');
    expect(parseLocal('2026-11-02T06:45:00.072-08:00').wall.getUTCMilliseconds()).toBe(72);
    expect(parseLocal('2026-11-02T06:45:00,5+05:30').wall.getUTCMilliseconds()).toBe(500);
    expect(parseLocal('2026-11-02t06:45z').iso).toBe('2026-11-02T06:45:00Z');
    expect(parseLocal('2026-11-02 06:45:00 +05:30').iso).toBe(DEL);
    expect(parseLocal('  2026-11-02T06:45:00+05:30 ').iso).toBe(DEL);
  });

  it('reads a Date or a timestamp in the host zone', () => {
    const d = new Date(2026, 10, 2, 6, 45, 0);
    const p = parseLocal(d);
    expect(p.wall.getUTCHours()).toBe(6);
    expect(p.wall.getUTCMinutes()).toBe(45);
    expect(p.wall.getUTCDate()).toBe(2);
    expect(p.offsetMinutes).toBe(-d.getTimezoneOffset() || 0);
    expect(p.localTimeOnly).toBe(false);
    expect(parseLocal(d.getTime())).toEqual(p);
    expect(new Date(p.iso).getTime()).toBe(d.getTime());
  });

  it('returns an already parsed value as is', () => {
    const p = parseLocal(DEL);
    expect(parseLocal(p)).toBe(p);
  });

  it('rejects unparseable or impossible values with a ValidationError', () => {
    expectInvalid(() => parseLocal('tomorrow'), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal('2026-02-30'), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal('2026-13-01'), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal('2026-11-02T24:00:00'), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal('2026-11-02T06:60:00'), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal('2026-11-02+05:30'), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal('2026-11-02T06:45:00+25:00'), 'dt', 'invalid_offset');
    expectInvalid(() => parseLocal('2026-11-02T06:45:00+05:60'), 'dt', 'invalid_offset');
    expectInvalid(() => parseLocal(new Date(NaN)), 'dt', 'invalid_datetime');
    expectInvalid(() => parseLocal(Infinity), 'dt', 'required');
    expectInvalid(() => parseLocal(null), 'dt', 'required');
    expectInvalid(() => parseLocal(undefined), 'dt', 'required');
    expectInvalid(() => parseLocal({}), 'dt', 'required');
    expectInvalid(() => parseLocal(''), 'dt', 'invalid_datetime');
    const err = expectInvalid(() => parseLocal('nope'), 'dt', 'invalid_datetime');
    expect(err.issues[0].params).toEqual({ value: 'nope' });
    expect(err.message).toContain('nope');
  });

  it('rejects a parsed look-alike with a malformed offset instead of leaking a RangeError', () => {
    const badOffset = { wall: new Date(0), offsetMinutes: 'abc', localTimeOnly: false, iso: 'x' };
    const badFlag = { wall: new Date(0), offsetMinutes: 330, localTimeOnly: 'no', iso: 'x' };
    expectInvalid(() => parseLocal(badOffset), 'dt', 'required');
    expectInvalid(() => formatTime(badOffset, { tz: 'local' }), 'dt', 'required');
    expectInvalid(() => formatDateTime(badOffset, { tz: 'Asia/Kolkata' }), 'dt', 'required');
    expectInvalid(() => isPast(badOffset), 'dt', 'required');
    expectInvalid(() => relativeTime(badOffset), 'dt', 'required');
    expectInvalid(() => parseLocal(badFlag), 'dt', 'required');
    const broken = { ...parseLocal(DEL), wall: new Date(NaN) };
    expectInvalid(() => formatTime(broken), 'dt', 'invalid_datetime');
  });

  it('keeps years below 100 out of the 1900s everywhere', () => {
    expect(parseLocal('0000-02-29').iso).toBe('0000-02-29T00:00:00'); // year 0 is a leap year
    expect(parseLocal('0004-02-29').wall.getUTCFullYear()).toBe(4);
    expectInvalid(() => parseLocal('0100-02-29'), 'dt', 'invalid_datetime'); // 100 is not
    expect(addDays('0099-01-05', 1)).toBe('0099-01-06');
    expect(addDays('0000-02-28', 1)).toBe('0000-02-29');
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(dayDiff('0099-12-31', '0100-01-01')).toBe(1);
    expect(diffDays('0001-01-01', '0001-12-31')).toBe(364);
    expect(toDateKey(fromDateKey('0004-02-29'))).toBe('0004-02-29');
    expect(monthMatrix(0, 2).flat().filter(Boolean)).toHaveLength(29);
    expect(monthMatrix(4, 2).flat().filter(Boolean)).toHaveLength(29);
    expect(monthMatrix(5, 2).flat().filter(Boolean)).toHaveLength(28);
    expect(monthMatrix(99, 12).flat().filter(Boolean)[30]).toBe('0099-12-31');
    expect(ageAt('0099-06-01', '0101-05-31')).toBe(1);
  });

  it('accepts a leap day and rejects 29 Feb in a common year', () => {
    expect(parseLocal('2024-02-29').iso).toBe('2024-02-29T00:00:00');
    expectInvalid(() => parseLocal('2026-02-29'), 'dt', 'invalid_datetime');
  });
});

// ── formatTime / formatDate / formatDateTime / formatDateRange ──────────────────────────────────

describe('formatTime', () => {
  it('shows the airport wall clock by default, following the locale clock', () => {
    expect(n(formatTime(DEL, { locale: 'en-GB' }))).toBe('06:45');
    expect(n(formatTime(DEL, { locale: 'en-US' }))).toBe('6:45 AM');
    expect(n(formatTime(DEL, { locale: 'en-US', hour12: false }))).toBe('06:45');
    expect(n(formatTime(DEL, { locale: 'en-GB', hour12: true }))).toBe('6:45 am');
    expect(n(formatTime(DEL, { locale: 'en-US', tz: 'airport' }))).toBe('6:45 AM');
  });

  it('never renders midnight as 24:xx on a 24-hour clock', () => {
    expect(n(formatTime('2026-11-02T00:05:00+05:30', { locale: 'en-US', hour12: false }))).toBe(
      '00:05'
    );
  });

  it('is independent of the UTC instant (airport time is not shifted)', () => {
    // 00:30 in Delhi is 19:00 UTC the previous day; the wall clock still reads 00:30.
    expect(n(formatTime('2026-11-02T00:30:00+05:30', { locale: 'en-GB' }))).toBe('00:30');
    expect(n(formatTime('2026-11-02T23:30:00-08:00', { locale: 'en-GB' }))).toBe('23:30');
  });

  it("renders the same instant in the viewer's zone with tz: 'local'", () => {
    const instant = new Date(Date.UTC(2026, 10, 2, 1, 15)); // = 06:45+05:30
    const expected = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant);
    expect(n(formatTime(DEL, { locale: 'en-GB', tz: 'local' }))).toBe(n(expected));
  });

  it('renders offset-less input identically in airport and local mode', () => {
    expect(n(formatTime(AMADEUS, { locale: 'en-GB' }))).toBe('09:30');
    expect(n(formatTime(AMADEUS, { locale: 'en-GB', tz: 'local' }))).toBe('09:30');
  });

  it('accepts an IANA zone as tz', () => {
    expect(n(formatTime(DEL, { locale: 'en-GB', tz: 'America/New_York' }))).toBe('20:15');
    expect(n(formatTime(DEL, { locale: 'en-GB', tz: 'Asia/Kolkata' }))).toBe('06:45');
  });

  it('works without options and with a Date', () => {
    expect(typeof formatTime(DEL)).toBe('string');
    const d = new Date(2026, 10, 2, 18, 5);
    expect(n(formatTime(d, { locale: 'en-GB' }))).toBe('18:05');
  });

  it('rejects a non-boolean hour12 (null means locale default)', () => {
    expectInvalid(() => formatTime(DEL, { hour12: 'yes' }), 'hour12', 'invalid_option');
    expectInvalid(() => formatTime(DEL, { hour12: 1 }), 'hour12', 'invalid_option');
    expectInvalid(() => formatDateTime(DEL, { hour12: 'no' }), 'hour12', 'invalid_option');
    expect(n(formatTime(DEL, { locale: 'en-GB', hour12: null }))).toBe('06:45');
  });

  it('rejects an unknown zone, an unsupported locale and bad input', () => {
    expectInvalid(() => formatTime(DEL, { tz: 'Mars/Olympus' }), 'tz', 'invalid_timezone');
    expectInvalid(() => formatTime(DEL, { tz: '' }), 'tz', 'invalid_timezone');
    expectInvalid(() => formatTime(DEL, { tz: 42 }), 'tz', 'invalid_timezone');
    expectInvalid(() => formatTime(DEL, { locale: 'not a locale!' }), 'locale', 'invalid_locale');
    expectInvalid(() => formatTime('yesterday'), 'dt', 'invalid_datetime');
  });
});

describe('formatDate', () => {
  it('supports the four documented styles', () => {
    expect(n(formatDate(DEL, { style: 'short', locale: 'en-GB' }))).toBe('2 Nov');
    expect(n(formatDate(DEL, { style: 'medium', locale: 'en-GB' }))).toBe('2 Nov 2026');
    expect(n(formatDate(DEL, { style: 'long', locale: 'en-GB' }))).toMatch(
      /^Monday,? 2 November 2026$/
    );
    expect(n(formatDate(DEL, { style: 'weekday', locale: 'en-GB' }))).toMatch(/^Mon,? 2 Nov$/);
    expect(n(formatDate(DEL, { style: 'short', locale: 'en-US' }))).toBe('Nov 2');
    expect(n(formatDate(DEL, { style: 'weekday', locale: 'en-US' }))).toMatch(/^Mon,? Nov 2$/);
  });

  it('defaults to medium and accepts a DateStr, a Date and a parsed value', () => {
    expect(n(formatDate('2026-11-02', { locale: 'en-GB' }))).toBe('2 Nov 2026');
    expect(n(formatDate(parseLocal(DEL), { locale: 'en-GB' }))).toBe('2 Nov 2026');
    expect(n(formatDate(new Date(2026, 10, 2, 23, 59), { locale: 'en-GB' }))).toBe('2 Nov 2026');
  });

  it('uses the airport calendar date, not the UTC one', () => {
    expect(n(formatDate('2026-11-02T00:30:00+05:30', { style: 'short', locale: 'en-GB' }))).toBe(
      '2 Nov'
    );
    expect(n(formatDate('2026-11-01T23:30:00-08:00', { style: 'short', locale: 'en-GB' }))).toBe(
      '1 Nov'
    );
  });

  it('rejects an unknown style', () => {
    expectInvalid(() => formatDate(DEL, { style: 'full' }), 'style', 'invalid_style');
    expectInvalid(() => formatDate(DEL, { style: 7 }), 'style', 'invalid_style');
    expectInvalid(() => formatDate(DEL, { style: null }), 'style', 'invalid_style');
  });

  it('does not resolve style names through the prototype chain', () => {
    for (const style of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expectInvalid(() => formatDate(DEL, { style }), 'style', 'invalid_style');
      expectInvalid(() => formatDateTime(DEL, { style }), 'style', 'invalid_style');
      expectInvalid(() => formatDateRange(DEL, DXB, { style }), 'style', 'invalid_style');
      expectInvalid(() => formatDateRange(DEL, DEL, { style }), 'style', 'invalid_style');
    }
  });
});

describe('formatDateTime', () => {
  it('combines date and time in one locale-aware string', () => {
    expect(n(formatDateTime(DEL, { locale: 'en-GB' }))).toBe('2 Nov 2026, 06:45');
    expect(n(formatDateTime(DEL, { locale: 'en-US' }))).toBe('Nov 2, 2026, 6:45 AM');
    expect(n(formatDateTime(DEL, { locale: 'en-GB', style: 'weekday' }))).toMatch(
      /^Mon,? 2 Nov, 06:45$/
    );
    expect(n(formatDateTime(DEL, { locale: 'en-GB', hour12: true }))).toBe('2 Nov 2026, 6:45 am');
  });

  it('honours tz like formatTime', () => {
    expect(n(formatDateTime(DEL, { locale: 'en-GB', tz: 'America/New_York' }))).toBe(
      '1 Nov 2026, 20:15'
    );
    const expected = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(Date.UTC(2026, 10, 2, 1, 15)));
    expect(n(formatDateTime(DEL, { locale: 'en-GB', tz: 'local' }))).toBe(n(expected));
  });
});

describe('formatDateRange', () => {
  it('formats a range within one month and across months', () => {
    expect(n(formatDateRange('2026-11-02', '2026-11-09', { locale: 'en-GB' }))).toMatch(
      /^2\s?[–-]\s?9 Nov 2026$/
    );
    expect(n(formatDateRange('2026-11-02', '2026-12-09', { locale: 'en-GB' }))).toMatch(
      /^2 Nov\s?[–-]\s?9 Dec 2026$/
    );
    expect(n(formatDateRange(DEL, '2026-11-09T22:00:00+04:00', { locale: 'en-GB' }))).toMatch(
      /^2\s?[–-]\s?9 Nov 2026$/
    );
  });

  it('collapses to a single date when both fall on the same day or b is missing', () => {
    expect(n(formatDateRange('2026-11-02', '2026-11-02', { locale: 'en-GB' }))).toBe('2 Nov 2026');
    expect(n(formatDateRange(DEL, '2026-11-02T23:00:00+05:30', { locale: 'en-GB' }))).toBe(
      '2 Nov 2026'
    );
    expect(n(formatDateRange('2026-11-02', null, { locale: 'en-GB' }))).toBe('2 Nov 2026');
    expect(n(formatDateRange('2026-11-02', undefined, { locale: 'en-GB' }))).toBe('2 Nov 2026');
  });

  it('orders the ends chronologically and honours style', () => {
    expect(
      n(formatDateRange('2026-11-09', '2026-11-02', { locale: 'en-US', style: 'short' }))
    ).toMatch(/^Nov 2\s?[–-]\s?9$/);
  });

  it('falls back to "a – b" when formatRange is unavailable', () => {
    const proto = Intl.DateTimeFormat.prototype;
    const original = proto.formatRange;
    Object.defineProperty(proto, 'formatRange', { value: undefined, configurable: true });
    try {
      expect(n(formatDateRange('2026-11-02', '2026-11-09', { locale: 'en-GB' }))).toBe(
        '2 Nov 2026 – 9 Nov 2026'
      );
    } finally {
      Object.defineProperty(proto, 'formatRange', { value: original, configurable: true });
    }
  });

  it('names the offending argument', () => {
    expectInvalid(() => formatDateRange('x', '2026-11-09'), 'a', 'invalid_datetime');
    expectInvalid(() => formatDateRange('2026-11-02', 'x'), 'b', 'invalid_datetime');
  });
});

// ── formatDuration ───────────────────────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it.each([
    [155, '2h 35m', '2 hr 35 min', '2:35'],
    [0, '0m', '0 min', '0:00'],
    [60, '1h', '1 hr', '1:00'],
    [5, '5m', '5 min', '0:05'],
    [1440, '1d', '1 day', '24:00'],
    [1595, '1d 2h 35m', '1 day 2 hr 35 min', '26:35'],
    [2885, '2d 5m', '2 days 5 min', '48:05'],
  ])('formats %i minutes in every style', (minutes, short, long, compact) => {
    expect(n(formatDuration(minutes, { locale: 'en' }))).toBe(short);
    expect(n(formatDuration(minutes, { style: 'short', locale: 'en' }))).toBe(short);
    expect(n(formatDuration(minutes, { style: 'long', locale: 'en' }))).toBe(long);
    expect(n(formatDuration(minutes, { style: 'compact', locale: 'en' }))).toBe(compact);
  });

  it('rounds fractional minutes and keeps a sign for negative durations', () => {
    expect(n(formatDuration(59.6, { locale: 'en' }))).toBe('1h');
    expect(n(formatDuration(0.4, { locale: 'en' }))).toBe('0m');
    expect(n(formatDuration(-30, { locale: 'en' }))).toBe('-30m');
    expect(n(formatDuration(-30, { style: 'compact', locale: 'en' }))).toBe('-0:30');
    expect(n(formatDuration(-0.2, { locale: 'en' }))).toBe('0m');
  });

  it('falls back to English labels when unit formatting is unsupported', () => {
    const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(() => {
      throw new RangeError('unit style unsupported');
    });
    try {
      expect(formatDuration(155)).toBe('2h 35m');
      expect(formatDuration(1595, { style: 'long' })).toBe('1 day 2 hr 35 min');
      expect(formatDuration(2880, { style: 'long' })).toBe('2 days');
    } finally {
      spy.mockRestore();
    }
  });

  it('really localises and rejects an unsupported locale instead of silently falling back', () => {
    expect(n(formatDuration(155, { style: 'long', locale: 'de' }))).toMatch(/Std\./);
    expect(n(formatDuration(155, { style: 'long', locale: ['de', 'en'] }))).toMatch(/Std\./);
    expectInvalid(
      () => formatDuration(155, { locale: 'not a locale!' }),
      'locale',
      'invalid_locale'
    );
    expectInvalid(() => formatDuration(155, { locale: 'en_US' }), 'locale', 'invalid_locale');
    // even when the engine has no unit style at all, a bad locale is still reported as such
    const spy = vi.spyOn(Intl, 'NumberFormat').mockImplementation(() => {
      throw new RangeError('unit style unsupported');
    });
    try {
      expectInvalid(
        () => formatDuration(155, { locale: 'not a locale!' }),
        'locale',
        'invalid_locale'
      );
      expect(formatDuration(155, { locale: 'en' })).toBe('2h 35m');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects non-numbers and unknown styles', () => {
    expectInvalid(() => formatDuration('155'), 'minutes', 'invalid_duration');
    expectInvalid(() => formatDuration(NaN), 'minutes', 'invalid_duration');
    expectInvalid(() => formatDuration(Infinity), 'minutes', 'invalid_duration');
    expectInvalid(() => formatDuration(10, { style: 'tiny' }), 'style', 'invalid_style');
  });
});

// ── durationBetween / dayDiff / isOvernight ─────────────────────────────────────────────────────

describe('durationBetween', () => {
  it('is offset-aware when both sides carry an offset', () => {
    expect(durationBetween(DEL, DXB)).toBe(255);
    expect(durationBetween(DXB, DEL)).toBe(-255);
    expect(durationBetween('2026-11-02T06:45:00Z', '2026-11-02T06:45:00+05:30')).toBe(-330);
    expect(durationBetween(DEL, DEL)).toBe(0);
  });

  it('compares offset-less inputs as a same-zone wall clock', () => {
    expect(durationBetween('2021-07-04T09:30:00', '2021-07-04T11:35:00')).toBe(125);
    expect(durationBetween('2021-07-04T23:30:00', '2021-07-05T01:05:00')).toBe(95);
  });

  it('falls back to the wall clock when only one side has an offset', () => {
    expect(durationBetween('2021-07-04T09:30:00+05:30', '2021-07-04T11:35:00')).toBe(125);
    expect(durationBetween('2021-07-04T09:30:00', '2021-07-04T11:35:00-08:00')).toBe(125);
  });

  it('rounds to whole minutes and accepts parsed values and Dates', () => {
    expect(durationBetween('2026-11-02T06:45:00Z', '2026-11-02T06:47:29Z')).toBe(2);
    expect(durationBetween('2026-11-02T06:45:00Z', '2026-11-02T06:47:31Z')).toBe(3);
    expect(durationBetween(parseLocal(DEL), parseLocal(DXB))).toBe(255);
    const a = new Date(2026, 10, 2, 6, 45);
    const b = new Date(2026, 10, 2, 9, 30);
    expect(durationBetween(a, b)).toBe(165);
  });

  it('rounds half minutes symmetrically so reversing the arguments flips the sign', () => {
    const a = '2026-11-02T06:45:00Z';
    const b = '2026-11-02T06:47:30Z';
    expect(durationBetween(a, b)).toBe(3);
    expect(durationBetween(b, a)).toBe(-3);
    expect(durationBetween('2021-07-04T09:30:00', '2021-07-04T09:30:30')).toBe(1);
    expect(durationBetween('2021-07-04T09:30:30', '2021-07-04T09:30:00')).toBe(-1);
    expect(Object.is(durationBetween('2021-07-04T09:30:10', '2021-07-04T09:30:00'), -0)).toBe(
      false
    );
  });

  it('names the offending argument', () => {
    expectInvalid(() => durationBetween('x', DXB), 'a', 'invalid_datetime');
    expectInvalid(() => durationBetween('x', 'y'), 'a', 'invalid_datetime');
    expectInvalid(() => durationBetween(DEL, 'x'), 'b', 'invalid_datetime');
  });
});

describe('dayDiff / isOvernight / diffDays', () => {
  it('compares local calendar dates, not instants', () => {
    // 23:50 Delhi -> 00:40 Dubai next day: only 110 minutes, still a +1.
    const a = '2026-11-02T23:50:00+05:30';
    const b = '2026-11-03T00:40:00+04:00';
    expect(durationBetween(a, b)).toBe(140);
    expect(dayDiff(a, b)).toBe(1);
    expect(isOvernight(a, b)).toBe(true);
    // Same local day although the UTC day differs (23:40-08:00 is 07:40Z next day).
    expect(dayDiff('2026-11-02T23:50:00+05:30', '2026-11-02T23:40:00-08:00')).toBe(0);
    expect(isOvernight('2026-11-02T23:50:00+05:30', '2026-11-02T23:40:00-08:00')).toBe(false);
  });

  it('handles multi-day gaps, negative results and offset-less input', () => {
    expect(dayDiff(DEL, '2026-11-04T01:00:00+04:00')).toBe(2);
    expect(dayDiff('2026-11-04T01:00:00+04:00', DEL)).toBe(-2);
    expect(dayDiff('2021-07-04T23:30:00', '2021-07-05T01:05:00')).toBe(1);
    expect(isOvernight('2021-07-04T23:30:00', '2021-07-05T01:05:00')).toBe(true);
    expect(isOvernight('2021-07-04T09:30:00', '2021-07-04T23:59:00')).toBe(false);
    expect(dayDiff('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('names the offending argument, a before b', () => {
    expectInvalid(() => dayDiff('x', 'y'), 'a', 'invalid_datetime');
    expectInvalid(() => dayDiff(DEL, 'y'), 'b', 'invalid_datetime');
    expectInvalid(() => isOvernight('x', 'y'), 'a', 'invalid_datetime');
    expectInvalid(() => diffDays('x', 'y'), 'a', 'invalid_datetime');
  });

  it('diffDays counts calendar days between DateStr values', () => {
    expect(diffDays('2026-11-02', '2026-11-09')).toBe(7);
    expect(diffDays('2026-11-09', '2026-11-02')).toBe(-7);
    expect(diffDays('2024-02-28', '2024-03-01')).toBe(2);
    expect(diffDays('2026-11-02', DXB)).toBe(0);
  });
});

// ── timeBucket / minutesOfDay ───────────────────────────────────────────────────────────────────

describe('timeBucket', () => {
  it.each([
    ['00:00', 'early_morning'],
    ['05:59', 'early_morning'],
    ['06:00', 'morning'],
    ['11:59', 'morning'],
    ['12:00', 'afternoon'],
    ['17:59', 'afternoon'],
    ['18:00', 'evening'],
    ['23:59', 'evening'],
  ])('%s is %s', (time, bucket) => {
    expect(timeBucket(`2026-11-02T${time}:00+05:30`)).toBe(bucket);
    expect(timeBucket(`2026-11-02T${time}:00`)).toBe(bucket);
  });

  it('buckets the airport clock even when the UTC hour differs', () => {
    expect(timeBucket('2026-11-02T00:30:00+05:30')).toBe('early_morning');
    expect(timeBucket('2026-11-02T18:30:00-08:00')).toBe('evening');
  });

  it("returns the 'night' alias for 00:00-05:59 only when asked", () => {
    expect(timeBucket('2026-11-02T03:00:00+05:30', { night: true })).toBe('night');
    expect(timeBucket('2026-11-02T03:00:00+05:30', { night: false })).toBe('early_morning');
    expect(timeBucket('2026-11-02T07:00:00+05:30', { night: true })).toBe('morning');
  });
});

describe('minutesOfDay', () => {
  it('counts minutes since local midnight', () => {
    expect(minutesOfDay(DEL)).toBe(405);
    expect(minutesOfDay('2026-11-02T00:00:00+05:30')).toBe(0);
    expect(minutesOfDay('2026-11-02T23:59:59-08:00')).toBe(1439);
    expect(minutesOfDay('2026-11-02')).toBe(0);
    expect(minutesOfDay(new Date(2026, 10, 2, 13, 7))).toBe(787);
  });
});

// ── calendar dates ──────────────────────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('adds and subtracts calendar days across month, year and leap boundaries', () => {
    expect(addDays('2026-11-02', 7)).toBe('2026-11-09');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2026-11-02', 0)).toBe('2026-11-02');
    expect(addDays('2026-11-02', 365)).toBe('2027-11-02');
    expect(addDays('2026-11-02', 1.9)).toBe('2026-11-03');
  });

  it('requires a YYYY-MM-DD date and a finite n', () => {
    expectInvalid(() => addDays(DEL, 1), 'd', 'invalid_date');
    expectInvalid(() => addDays('2026-02-30', 1), 'd', 'invalid_datetime');
    expectInvalid(() => addDays(undefined, 1), 'd', 'invalid_date');
    expectInvalid(() => addDays('2026-11-02', '1'), 'n', 'invalid_number');
    expectInvalid(() => addDays('2026-11-02', NaN), 'n', 'invalid_number');
  });
});

describe('today', () => {
  it('returns the host-zone date of the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 23, 30));
    expect(today()).toBe('2026-11-02');
    expect(today()).toBe(toDateKey(new Date()));
    expect(today('local')).toBe('2026-11-02');
  });

  it('returns the date in a given IANA zone', () => {
    const t = Date.UTC(2026, 10, 1, 20, 0); // 01:30 on 2 Nov in Kolkata, 12:00 on 1 Nov in LA
    expect(today('Asia/Kolkata', t)).toBe('2026-11-02');
    expect(today('America/Los_Angeles', t)).toBe('2026-11-01');
    expect(today('UTC', new Date(t))).toBe('2026-11-01');
    expect(today('Pacific/Kiritimati', Date.UTC(2026, 11, 31, 11, 0))).toBe('2027-01-01');
  });

  it('rejects unknown zones and bad clocks', () => {
    expectInvalid(() => today('Nowhere/Here'), 'tz', 'invalid_timezone');
    expectInvalid(() => today(''), 'tz', 'invalid_timezone');
    expectInvalid(() => today(42), 'tz', 'invalid_timezone');
    expectInvalid(() => today('UTC', 'yesterday'), 'now', 'invalid_datetime');
  });
});

describe('isPast', () => {
  it('compares the instant with now (explicit or Date.now)', () => {
    const departure = Date.UTC(2026, 10, 2, 1, 15); // = DEL
    expect(isPast(DEL, departure - 1)).toBe(false);
    expect(isPast(DEL, departure)).toBe(false);
    expect(isPast(DEL, departure + 1)).toBe(true);
    expect(isPast(DEL, new Date(departure + 60_000))).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(departure + 1);
    expect(isPast(DEL)).toBe(true);
    vi.setSystemTime(departure - 1);
    expect(isPast(DEL)).toBe(false);
  });

  it('reads offset-less input in the host zone', () => {
    const local = new Date(2021, 6, 4, 9, 30);
    expect(isPast(AMADEUS, local.getTime() - 1)).toBe(false);
    expect(isPast(AMADEUS, local.getTime() + 1)).toBe(true);
  });
});

describe('toDateKey / fromDateKey', () => {
  it('round-trips through the host zone', () => {
    expect(toDateKey(new Date(2026, 10, 2, 23, 30))).toBe('2026-11-02');
    expect(toDateKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    const d = fromDateKey('2026-11-02');
    expect(d).toBeInstanceOf(Date);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 10, 2]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(toDateKey(fromDateKey('2026-11-02'))).toBe('2026-11-02');
    expect(toDateKey(fromDateKey('0099-01-05'))).toBe('0099-01-05');
  });

  it('toDateKey uses the airport date of a DateTime', () => {
    expect(toDateKey(DEL)).toBe('2026-11-02');
    expect(toDateKey('2026-11-02T00:30:00+05:30')).toBe('2026-11-02');
    expect(toDateKey('2026-11-02')).toBe('2026-11-02');
    expect(toDateKey(parseLocal(DXB))).toBe('2026-11-02');
  });

  it('validates its input', () => {
    expectInvalid(() => toDateKey('2026/11/02'), 'date', 'invalid_datetime');
    expectInvalid(() => toDateKey(new Date(NaN)), 'date', 'invalid_datetime');
    expectInvalid(() => fromDateKey('2026-11-02T06:45:00+05:30'), 'd', 'invalid_date');
    expectInvalid(() => fromDateKey('2026-11-31'), 'd', 'invalid_datetime');
    expectInvalid(() => fromDateKey(20261102), 'd', 'invalid_date');
  });
});

describe('clampDate', () => {
  it('keeps dates inside the bounds and clamps the rest', () => {
    expect(clampDate('2026-11-07', '2026-11-05', '2026-11-09')).toBe('2026-11-07');
    expect(clampDate('2026-11-02', '2026-11-05', '2026-11-09')).toBe('2026-11-05');
    expect(clampDate('2026-11-12', '2026-11-05', '2026-11-09')).toBe('2026-11-09');
    expect(clampDate('2026-11-05', '2026-11-05', '2026-11-05')).toBe('2026-11-05');
  });

  it('treats a missing bound as open and accepts DateTime inputs', () => {
    expect(clampDate('2026-11-02', null, '2026-11-01')).toBe('2026-11-01');
    expect(clampDate('2026-11-02', '2026-11-05')).toBe('2026-11-05');
    expect(clampDate('2026-11-02', undefined, undefined)).toBe('2026-11-02');
    expect(clampDate(DEL, null, '2026-11-01')).toBe('2026-11-01');
    expect(clampDate(DEL, '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z')).toBe('2026-11-02');
  });

  it('rejects an inverted range and bad dates', () => {
    expectInvalid(
      () => clampDate('2026-11-02', '2026-11-09', '2026-11-05'),
      'min',
      'invalid_range'
    );
    expectInvalid(() => clampDate('x', '2026-11-05', '2026-11-09'), 'd', 'invalid_datetime');
    expectInvalid(() => clampDate(undefined, '2026-11-05', '2026-11-09'), 'd', 'required');
    expectInvalid(() => clampDate('2026-11-02', 'x', '2026-11-09'), 'min', 'invalid_datetime');
    expectInvalid(() => clampDate('2026-11-02', '2026-11-05', 'x'), 'max', 'invalid_datetime');
  });
});

describe('monthMatrix', () => {
  it('builds a Monday-first grid by default', () => {
    const rows = monthMatrix(2026, 11);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toHaveLength(7);
    expect(rows[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(rows[1]).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
    expect(rows[5]).toEqual(['2026-11-30', null, null, null, null, null, null]);
  });

  it('honours firstDay and lists every day exactly once', () => {
    const rows = monthMatrix(2026, 11, { firstDay: 0 });
    expect(rows).toHaveLength(5);
    expect(rows[0][0]).toBe('2026-11-01');
    expect(rows[4][0]).toBe('2026-11-29');
    expect(rows[4][1]).toBe('2026-11-30');
    const days = rows.flat().filter(Boolean);
    expect(days).toHaveLength(30);
    expect(new Set(days).size).toBe(30);
    expect(days[0]).toBe('2026-11-01');
    expect(days[29]).toBe('2026-11-30');
  });

  it('handles short and leap months', () => {
    expect(monthMatrix(2026, 2, { firstDay: 0 })).toHaveLength(4); // 1 Feb 2026 is a Sunday
    expect(monthMatrix(2024, 2).flat().filter(Boolean)).toHaveLength(29);
    expect(monthMatrix(2026, 2).flat().filter(Boolean)).toHaveLength(28);
    expect(monthMatrix(2026, 12, { firstDay: 6 })[0]).toEqual([
      null,
      null,
      null,
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
    ]);
  });

  it('validates year, month and firstDay', () => {
    expectInvalid(() => monthMatrix(2026.5, 11), 'year', 'invalid_number');
    expectInvalid(() => monthMatrix('2026', 11), 'year', 'invalid_number');
    expectInvalid(() => monthMatrix(2026, 0), 'month', 'invalid_number');
    expectInvalid(() => monthMatrix(2026, 13), 'month', 'invalid_number');
    expectInvalid(() => monthMatrix(2026, 11, { firstDay: 7 }), 'firstDay', 'invalid_number');
    expectInvalid(() => monthMatrix(2026, 11, { firstDay: -1 }), 'firstDay', 'invalid_number');
  });
});

// ── relativeTime ────────────────────────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  const now = Date.UTC(2026, 10, 2, 6, 45);
  const at = (ms) => new Date(now + ms).toISOString();

  it.each([
    [0, 'now'],
    [20_000, 'now'],
    [-44_000, 'now'],
    [60_000, 'in 1 minute'],
    [15 * 60_000, 'in 15 minutes'],
    [-2 * 3_600_000, '2 hours ago'],
    [70 * 60_000, 'in 1 hour'],
    [24 * 3_600_000, 'tomorrow'],
    [-26 * 3_600_000, 'yesterday'],
    [3 * 86_400_000, 'in 3 days'],
    [-10 * 86_400_000, '10 days ago'],
    [40 * 86_400_000, 'next month'],
    [61 * 86_400_000, 'in 2 months'],
    [400 * 86_400_000, 'next year'],
    [-3 * 365.25 * 86_400_000, '3 years ago'],
  ])('%i ms from now reads "%s"', (ms, text) => {
    expect(n(relativeTime(at(ms), { locale: 'en', now }))).toBe(text);
  });

  it('rounds half units symmetrically', () => {
    expect(n(relativeTime(at(150_000), { locale: 'en', now }))).toBe('in 3 minutes');
    expect(n(relativeTime(at(-150_000), { locale: 'en', now }))).toBe('3 minutes ago');
    expect(n(relativeTime(at(5.5 * 3_600_000), { locale: 'en', now }))).toBe('in 6 hours');
    expect(n(relativeTime(at(-5.5 * 3_600_000), { locale: 'en', now }))).toBe('6 hours ago');
    expect(n(relativeTime(at(4.5 * 86_400_000), { locale: 'en', now }))).toBe('in 5 days');
    expect(n(relativeTime(at(-4.5 * 86_400_000), { locale: 'en', now }))).toBe('5 days ago');
  });

  it('supports numeric: always and short / narrow styles', () => {
    expect(n(relativeTime(at(86_400_000), { locale: 'en', now, numeric: 'always' }))).toBe(
      'in 1 day'
    );
    expect(n(relativeTime(at(-2 * 3_600_000), { locale: 'en', now, style: 'narrow' }))).toBe(
      '2h ago'
    );
    expect(n(relativeTime(at(-2 * 3_600_000), { locale: 'en', now, style: 'short' }))).toMatch(
      /^2 hr\.? ago$/
    );
  });

  it('defaults now to Date.now and reads offset-less input in the host zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(n(relativeTime(at(3 * 86_400_000), { locale: 'en' }))).toBe('in 3 days');
    expect(n(relativeTime('2026-11-02T06:45:00Z', { locale: 'en' }))).toBe('now');
    // 06:45+05:30 is 01:15Z, i.e. 5.5 h ago, which rounds away from zero like "in 6 hours" does.
    expect(n(relativeTime(DEL, { locale: 'en' }))).toBe('6 hours ago');
    const local = new Date(2021, 6, 4, 9, 30);
    vi.setSystemTime(local.getTime() + 2 * 3_600_000);
    expect(n(relativeTime(AMADEUS, { locale: 'en' }))).toBe('2 hours ago');
  });

  it('rejects an unsupported locale and bad input', () => {
    expectInvalid(() => relativeTime(DEL, { locale: 'not a locale!' }), 'locale', 'invalid_locale');
    expectInvalid(() => relativeTime('x'), 'dt', 'invalid_datetime');
    expectInvalid(() => relativeTime(DEL, { now: 'later' }), 'now', 'invalid_datetime');
  });
});

// ── countdown ───────────────────────────────────────────────────────────────────────────────────

describe('countdown', () => {
  const T0 = Date.UTC(2026, 10, 2, 6, 45);

  it('ticks immediately, then every intervalMs, and stops itself at zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const onTick = vi.fn();
    const stop = countdown(T0 + 3500, onTick, { intervalMs: 1000 });
    expect(typeof stop).toBe('function');
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenLastCalledWith(3500);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(2500);
    vi.advanceTimersByTime(2000);
    expect(onTick).toHaveBeenLastCalledWith(500);
    expect(onTick).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(5);
    expect(onTick).toHaveBeenLastCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(onTick).toHaveBeenCalledTimes(5);
    stop(); // idempotent after self-stop
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a DateTime target and defaults to one-second ticks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 2, 1, 15) - 2500); // DEL is 01:15Z
    const onTick = vi.fn();
    const stop = countdown(DEL, onTick);
    expect(onTick).toHaveBeenLastCalledWith(2500);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(1500);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(500);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenLastCalledWith(0);
    expect(onTick).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('stop() clears the interval and is idempotent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const onTick = vi.fn();
    const stop = countdown(T0 + 60_000, onTick, { intervalMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(onTick).toHaveBeenCalledTimes(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(() => stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fires a single zero tick and starts no timer when already expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const onTick = vi.fn();
    const stop = countdown(T0 - 1, onTick, { intervalMs: 1000 });
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(onTick).toHaveBeenCalledTimes(1);
    stop();
  });

  it('uses injected timers and clock, calling them as methods of the timers object', () => {
    let handleSeq = 0;
    let scheduled = null;
    const timers = {
      setInterval: vi.fn(function (fn, ms) {
        expect(this).toBe(timers);
        scheduled = { fn, ms };
        return ++handleSeq;
      }),
      clearInterval: vi.fn(function (handle) {
        expect(this).toBe(timers);
        if (scheduled && handle === handleSeq) scheduled = null;
      }),
    };
    let clock = 1000;
    const onTick = vi.fn();
    const stop = countdown(3500, onTick, { intervalMs: 250, timers, now: () => clock });
    expect(onTick).toHaveBeenLastCalledWith(2500);
    expect(timers.setInterval).toHaveBeenCalledTimes(1);
    expect(scheduled.ms).toBe(250);
    clock = 2000;
    scheduled.fn();
    expect(onTick).toHaveBeenLastCalledWith(1500);
    clock = 4000;
    scheduled.fn();
    expect(onTick).toHaveBeenLastCalledWith(0);
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
    expect(timers.clearInterval).toHaveBeenCalledWith(1);
    expect(scheduled).toBeNull();
    stop();
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
  });

  it('a tick after stop() is ignored even if the host timer still fires', () => {
    let scheduled = null;
    const timers = {
      setInterval: vi.fn((fn) => {
        scheduled = fn;
        return 7;
      }),
      clearInterval: vi.fn(),
    };
    const onTick = vi.fn();
    const stop = countdown(10_000, onTick, { timers, now: () => 0 });
    stop();
    expect(timers.clearInterval).toHaveBeenCalledWith(7);
    scheduled();
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('validates onTick, intervalMs and until before starting anything', () => {
    vi.useFakeTimers();
    expectInvalid(() => countdown(T0 + 1000, null), 'onTick', 'required');
    expectInvalid(() => countdown(T0 + 1000, () => {}, { intervalMs: 0 }), 'intervalMs');
    expectInvalid(() => countdown(T0 + 1000, () => {}, { intervalMs: -5 }), 'intervalMs');
    expectInvalid(() => countdown(T0 + 1000, () => {}, { intervalMs: '1000' }), 'intervalMs');
    expectInvalid(() => countdown('soon', () => {}), 'until', 'invalid_datetime');
    expectInvalid(() => countdown(undefined, () => {}), 'until', 'required');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a half-specified timers object and a non-function clock before starting anything', () => {
    vi.useFakeTimers();
    const setInterval = vi.fn(() => 1);
    const onTick = vi.fn();
    expectInvalid(
      () => countdown(T0 + 1000, onTick, { timers: { setInterval } }),
      'timers',
      'invalid_option'
    );
    expectInvalid(
      () => countdown(T0 + 1000, onTick, { timers: { clearInterval() {} } }),
      'timers',
      'invalid_option'
    );
    expectInvalid(() => countdown(T0 + 1000, onTick, { timers: {} }), 'timers', 'invalid_option');
    expectInvalid(() => countdown(T0 + 1000, onTick, { timers: 'global' }), 'timers');
    expectInvalid(() => countdown(T0 + 1000, onTick, { now: 12345 }), 'now', 'invalid_option');
    expectInvalid(() => countdown(T0 + 1000, onTick, { now: Date.now() }), 'now', 'invalid_option');
    expect(onTick).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // explicit undefined / null fall back to the globals and Date.now
    vi.setSystemTime(T0);
    const stop = countdown(T0 + 1000, onTick, { timers: null, now: undefined });
    expect(onTick).toHaveBeenLastCalledWith(1000);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops itself and surfaces the error once when onTick throws on a later tick', () => {
    let scheduled = null;
    const timers = {
      setInterval: vi.fn((fn) => {
        scheduled = fn;
        return 42;
      }),
      clearInterval: vi.fn(),
    };
    let clock = 0;
    const onTick = vi.fn((remaining) => {
      if (remaining < 10_000) throw new ValidationError('boom');
    });
    const stop = countdown(10_000, onTick, { timers, now: () => clock, intervalMs: 1000 });
    expect(onTick).toHaveBeenCalledTimes(1);
    clock = 1000;
    expect(() => scheduled()).toThrow('boom');
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
    expect(timers.clearInterval).toHaveBeenCalledWith(42);
    // the host timer firing again (or stop()) does nothing further
    clock = 2000;
    scheduled();
    stop();
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
  });

  it('clears the global interval when onTick throws on a later tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let calls = 0;
    countdown(T0 + 10_000, () => {
      if (++calls === 2) throw new ValidationError('boom');
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(() => vi.advanceTimersByTime(1000)).toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(calls).toBe(2);
  });

  it('leaves no timers behind when the first tick throws', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    expect(() =>
      countdown(T0 + 5000, () => {
        throw new ValidationError('boom');
      })
    ).toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── ageAt / paxTypeForAge ───────────────────────────────────────────────────────────────────────

describe('ageAt', () => {
  it('counts completed years', () => {
    expect(ageAt('2000-11-02', '2026-11-02')).toBe(26);
    expect(ageAt('2000-11-03', '2026-11-02')).toBe(25);
    expect(ageAt('2000-11-01', '2026-11-02')).toBe(26);
    expect(ageAt('2026-11-02', '2026-11-02')).toBe(0);
    expect(ageAt('2024-11-30', '2026-11-02')).toBe(1);
  });

  it('moves a 29 Feb birthday to 1 Mar in common years', () => {
    expect(ageAt('2024-02-29', '2026-02-28')).toBe(1);
    expect(ageAt('2024-02-29', '2026-03-01')).toBe(2);
    expect(ageAt('2024-02-29', '2028-02-29')).toBe(4);
  });

  it('is negative when on precedes dob', () => {
    expect(ageAt('2026-01-01', '2025-12-31')).toBe(-1);
  });

  it('requires YYYY-MM-DD dates', () => {
    expectInvalid(() => ageAt('2000-11-02T00:00:00Z', '2026-11-02'), 'dob', 'invalid_date');
    expectInvalid(() => ageAt('2000-11-02', '2026-11-31'), 'on', 'invalid_datetime');
  });
});

describe('paxTypeForAge', () => {
  const rules = { infantMax: 2, childMax: 12, refDate: 'departure', infantPerAdult: 1, maxPax: 9 };

  it('maps ages to INF / CHD / ADT with the given bands (upper bounds exclusive)', () => {
    expect(paxTypeForAge(0, rules)).toBe('INF');
    expect(paxTypeForAge(1, rules)).toBe('INF');
    expect(paxTypeForAge(1.9, rules)).toBe('INF');
    expect(paxTypeForAge(2, rules)).toBe('CHD');
    expect(paxTypeForAge(11, rules)).toBe('CHD');
    expect(paxTypeForAge(12, rules)).toBe('ADT');
    expect(paxTypeForAge(70, rules)).toBe('ADT');
  });

  it('respects custom bands and defaults to under 2 / under 12', () => {
    expect(paxTypeForAge(2, { infantMax: 3, childMax: 16 })).toBe('INF');
    expect(paxTypeForAge(15, { infantMax: 3, childMax: 16 })).toBe('CHD');
    expect(paxTypeForAge(16, { infantMax: 3, childMax: 16 })).toBe('ADT');
    expect(paxTypeForAge(1)).toBe('INF');
    expect(paxTypeForAge(2)).toBe('CHD');
    expect(paxTypeForAge(12)).toBe('ADT');
    expect(paxTypeForAge(5, {})).toBe('CHD');
  });

  it('rejects a negative or non-numeric age', () => {
    expectInvalid(() => paxTypeForAge(-1, rules), 'age', 'invalid_age');
    expectInvalid(() => paxTypeForAge('5', rules), 'age', 'invalid_age');
    expectInvalid(() => paxTypeForAge(NaN, rules), 'age', 'invalid_age');
  });

  it('rejects inverted or negative bands and tolerates null rules', () => {
    expectInvalid(() => paxTypeForAge(5, { infantMax: 12, childMax: 2 }), 'rules', 'invalid_rules');
    expectInvalid(() => paxTypeForAge(5, { infantMax: -1 }), 'rules', 'invalid_rules');
    expectInvalid(() => paxTypeForAge(5, { childMax: -3 }), 'rules', 'invalid_rules');
    expectInvalid(() => paxTypeForAge(5, { infantMax: 13 }), 'rules', 'invalid_rules'); // > default 12
    expect(paxTypeForAge(5, null)).toBe('CHD');
    expect(paxTypeForAge(5, 'rules')).toBe('CHD');
    expect(paxTypeForAge(1, { infantMax: 2, childMax: 2 })).toBe('INF');
    expect(paxTypeForAge(2, { infantMax: 2, childMax: 2 })).toBe('ADT');
  });

  it('composes with ageAt for a travel date', () => {
    expect(paxTypeForAge(ageAt('2024-12-01', '2026-11-02'), rules)).toBe('INF');
    expect(paxTypeForAge(ageAt('2014-11-03', '2026-11-02'), rules)).toBe('CHD');
    expect(paxTypeForAge(ageAt('2014-11-02', '2026-11-02'), rules)).toBe('ADT');
  });
});
