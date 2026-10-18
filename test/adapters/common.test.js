import { describe, it, expect } from 'vitest';
import {
  toMoney,
  toDateTime,
  parseIsoDuration,
  normalizeDate,
  PAX_TYPE,
  CABIN,
  GENDER,
  DOCUMENT_TYPE,
  TRAVELER_FIELD_DOCUMENTS,
  AMENITY_TYPE,
  SERVICE_NAME,
  ADDITIONAL_SERVICE_TYPE,
  toWire,
  fromWire,
  resolveCarrier,
  resolveAircraft,
  resolvePlace,
  scopeId,
  unscopeId,
  renumberOffers,
  pointerToSdkPath,
  fromIssue,
  fromIssueArray,
  fromWarnings,
  readEither,
} from '../../src/adapters/amadeus/common.js';
import {
  ApiError,
  BookingError,
  ConflictError,
  NotFoundError,
  OfferUnavailableError,
  PaymentError,
  PriceChangedError,
  ValidationError,
  SdkError,
  errorFromProblem,
} from '../../src/errors/index.js';
import { expectValid } from '../helpers/swagger.js';

const SEARCH_SPEC = 'FlightOffersSearch';

// ── fixtures (inline; validated against the Amadeus schema where one applies) ───────────────────

/** Minimal but schema‑valid `FlightOffer` with two segments whose ids restart at '1'. */
function flightOffer(id, legs) {
  return {
    type: 'flight-offer',
    id,
    source: 'GDS',
    oneWay: true,
    numberOfBookableSeats: 4,
    itineraries: [
      {
        duration: 'PT5H30M',
        segments: legs.map(([segId, from, to, at, arr], i) => ({
          id: segId,
          departure: { iataCode: from, at },
          arrival: { iataCode: to, at: arr },
          carrierCode: 'AI',
          number: String(101 + i),
          aircraft: { code: '32N' },
          duration: 'PT2H15M',
          numberOfStops: 0,
        })),
      },
    ],
    price: { currency: 'INR', total: '5400.00', base: '4800.00', grandTotal: '5400.00' },
    validatingAirlineCodes: ['AI'],
    travelerPricings: [
      {
        travelerId: '1',
        fareOption: 'STANDARD',
        travelerType: 'ADULT',
        price: { currency: 'INR', total: '5400.00', base: '4800.00' },
        fareDetailsBySegment: legs.map(([segId]) => ({
          segmentId: segId,
          cabin: 'ECONOMY',
          fareBasis: 'QOWIN',
          class: 'Q',
          includedCheckedBags: { quantity: 1 },
        })),
      },
    ],
  };
}

const OFFER_A = flightOffer('1', [
  ['1', 'DEL', 'BOM', '2026-11-02T06:45:00', '2026-11-02T09:00:00'],
  ['2', 'BOM', 'GOI', '2026-11-02T10:30:00', '2026-11-02T11:45:00'],
]);
const OFFER_B = flightOffer('1', [
  ['1', 'GOI', 'BOM', '2026-11-09T12:00:00', '2026-11-09T13:15:00'],
  ['2', 'BOM', 'DEL', '2026-11-09T15:00:00', '2026-11-09T17:10:00'],
]);

/**
 * The spec's own `Error_400` example, minus `source.example`: `Issue_Source` is declared with
 * `maxProperties: 1`, so the example as printed does not validate against its schema (C‑35 — fixtures
 * follow the schema).
 */
const ISSUE_477 = {
  status: 400,
  code: 477,
  title: 'INVALID FORMAT',
  detail: 'invalid query parameter format',
  source: { parameter: 'airport' },
};

/**
 * Amadeus `departure.at` / `arrival.at` are local wall‑clock strings without an offset although the
 * schema declares `format: date-time` (§3.4); ajv‑formats enforces RFC 3339, so the structural check
 * runs on a copy whose timestamps are pinned to `Z`. Renumbering never touches the timestamps.
 */
function withRfcTimes(offer) {
  return {
    ...offer,
    itineraries: offer.itineraries.map((it) => ({
      ...it,
      segments: it.segments.map((s) => ({
        ...s,
        departure: { ...s.departure, at: `${s.departure.at}Z` },
        arrival: { ...s.arrival, at: `${s.arrival.at}Z` },
      })),
    })),
  };
}

const TZ = { DEL: 'Asia/Kolkata', LHR: 'Europe/London', JFK: 'America/New_York' };

/**
 * Independent oracle: the UTC offset (minutes) at which `wall` (`YYYY-MM-DDTHH:mm:ss`) is the local
 * time in `zone`, found by brute force over every quarter‑hour offset with `Intl.DateTimeFormat`.
 */
function intlOffset(zone, wall) {
  const [date, time] = wall.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (let offset = -12 * 60; offset <= 14 * 60; offset += 15) {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(asUtc - offset * 60000)).map((p) => [p.type, p.value])
    );
    const seen = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    if (seen === wall) return offset;
  }
  throw new Error(`no offset reproduces ${wall} in ${zone}`);
}

const pad = (n) => String(Math.abs(n)).padStart(2, '0');
const offsetText = (min) => `${min < 0 ? '-' : '+'}${pad(Math.trunc(min / 60))}:${pad(min % 60)}`;

// ── money ───────────────────────────────────────────────────────────────────────────────────────

describe('toMoney', () => {
  it('normalises decimal strings to the currency minor units and upper-cases the code', () => {
    expect(toMoney('6', 'eur')).toEqual({ amount: '6.00', currency: 'EUR' });
    expect(toMoney('514.13', 'EUR')).toEqual({ amount: '514.13', currency: 'EUR' });
    expect(toMoney('1234.5', 'INR')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(toMoney('1234.6', 'JPY')).toEqual({ amount: '1235', currency: 'JPY' });
    expect(toMoney(42, 'USD')).toEqual({ amount: '42.00', currency: 'USD' });
  });

  it("strips the 'A' suffix of an additional collection and flags it", () => {
    expect(toMoney('514.13A', 'EUR')).toEqual({
      amount: '514.13',
      currency: 'EUR',
      additionalCollection: true,
    });
    expect(toMoney('6A', 'EUR')).toEqual({
      amount: '6.00',
      currency: 'EUR',
      additionalCollection: true,
    });
    expect(toMoney('6', 'EUR')).not.toHaveProperty('additionalCollection');
  });

  it('reads the currency from an enclosing object (currency / currencyCode / billingCurrency alias)', () => {
    expect(toMoney('10', { currency: 'EUR' })).toEqual({ amount: '10.00', currency: 'EUR' });
    expect(toMoney('10', { currencyCode: 'GBP' })).toEqual({ amount: '10.00', currency: 'GBP' });
    expect(toMoney('10', { billingCurrency: 'inr' })).toEqual({ amount: '10.00', currency: 'INR' });
  });

  it('keeps alphanumeric or unparseable amounts verbatim instead of dropping them', () => {
    expect(toMoney('12.5X', 'EUR')).toEqual({ amount: '12.5X', currency: 'EUR' });
    expect(toMoney('abc', 'EUR')).toEqual({ amount: 'abc', currency: 'EUR' });
    expect(toMoney('1,234.00', 'EUR')).toEqual({ amount: '1,234.00', currency: 'EUR' });
  });

  it('keeps the amount with an empty currency when no code can be found', () => {
    expect(toMoney('6', undefined)).toEqual({ amount: '6', currency: '' });
    expect(toMoney('6', { foo: 'EUR' })).toEqual({ amount: '6', currency: '' });
    expect(toMoney('6', 'EURO')).toEqual({ amount: '6', currency: '' });
  });

  it('gives undefined for a missing amount', () => {
    expect(toMoney(undefined, 'EUR')).toBeUndefined();
    expect(toMoney(null, 'EUR')).toBeUndefined();
    expect(toMoney('', 'EUR')).toBeUndefined();
    expect(toMoney('   ', 'EUR')).toBeUndefined();
  });

  it('never produces floats or throws', () => {
    expect(toMoney('0.1', 'EUR')).toEqual({ amount: '0.10', currency: 'EUR' });
    expect(toMoney('-12', 'EUR')).toEqual({ amount: '-12.00', currency: 'EUR' });
    expect(toMoney('.5', 'EUR')).toEqual({ amount: '0.50', currency: 'EUR' });
    expect(() => toMoney({}, 'EUR')).not.toThrow();
  });
});

// ── timestamps ──────────────────────────────────────────────────────────────────────────────────

describe('toDateTime', () => {
  it.each([
    ['DEL', '2026-11-02T06:45:00'],
    ['LHR', '2026-07-14T10:00:00'],
    ['LHR', '2026-01-14T10:00:00'],
    ['JFK', '2026-07-14T18:30:00'],
    ['JFK', '2026-12-24T18:30:00'],
  ])('attaches the %s offset in force at %s (checked against Intl)', (iata, wall) => {
    const expected = intlOffset(TZ[iata], wall);
    const out = toDateTime(wall, iata, TZ);
    expect(out).toEqual({
      value: `${wall}${offsetText(expected)}`,
      offsetMinutes: expected,
      localTimeOnly: false,
    });
  });

  it('accepts every lookup shape: function, Map, Place record and a bare zone string', () => {
    const wall = '2026-11-02T06:45:00';
    const expected = { value: `${wall}+05:30`, offsetMinutes: 330, localTimeOnly: false };
    expect(
      toDateTime(wall, 'DEL', (code) => (code === 'DEL' ? 'Asia/Kolkata' : undefined))
    ).toEqual(expected);
    expect(toDateTime(wall, 'DEL', new Map([['DEL', 'Asia/Kolkata']]))).toEqual(expected);
    expect(toDateTime(wall, 'DEL', { DEL: { code: 'DEL', tz: 'Asia/Kolkata' } })).toEqual(expected);
    expect(toDateTime(wall, undefined, 'Asia/Kolkata')).toEqual(expected);
  });

  it('handles quarter-hour and 45-minute zones', () => {
    expect(toDateTime('2026-01-10T12:00:00', 'KTM', { KTM: 'Asia/Kathmandu' })).toEqual({
      value: '2026-01-10T12:00:00+05:45',
      offsetMinutes: 345,
      localTimeOnly: false,
    });
    const chatham = intlOffset('Pacific/Chatham', '2026-01-10T12:00:00');
    expect(toDateTime('2026-01-10T12:00:00', 'CHT', { CHT: 'Pacific/Chatham' })).toMatchObject({
      offsetMinutes: chatham,
      value: `2026-01-10T12:00:00${offsetText(chatham)}`,
    });
  });

  it('keeps the string and flags localTimeOnly when the zone is unknown', () => {
    const wall = '2026-11-02T06:45:00';
    const local = { value: wall, offsetMinutes: null, localTimeOnly: true };
    expect(toDateTime(wall, 'XXX', TZ)).toEqual(local);
    expect(toDateTime(wall, 'DEL')).toEqual(local);
    expect(toDateTime(wall, 'DEL', {})).toEqual(local);
    expect(toDateTime(wall, 'DEL', { DEL: 'Not/AZone' })).toEqual(local);
    expect(toDateTime(wall, 'DEL', { DEL: { code: 'DEL' } })).toEqual(local);
    expect(toDateTime(wall, undefined, () => undefined)).toEqual(local);
  });

  it('keeps fractional seconds and reads bare dates as local midnight', () => {
    expect(toDateTime('2026-11-02T06:45:00.123', 'DEL', TZ)).toEqual({
      value: '2026-11-02T06:45:00.123+05:30',
      offsetMinutes: 330,
      localTimeOnly: false,
    });
    expect(toDateTime('2026-11-02', 'DEL', TZ)).toEqual({
      value: '2026-11-02T00:00:00+05:30',
      offsetMinutes: 330,
      localTimeOnly: false,
    });
    expect(toDateTime('2026-11-02', 'DEL')).toEqual({
      value: '2026-11-02',
      offsetMinutes: null,
      localTimeOnly: true,
    });
  });

  it('keeps an input that already carries an offset verbatim', () => {
    expect(toDateTime('2026-11-02T06:45:00+05:30', 'JFK', TZ)).toEqual({
      value: '2026-11-02T06:45:00+05:30',
      offsetMinutes: 330,
      localTimeOnly: false,
    });
    expect(toDateTime('2026-11-02T01:15:00Z', 'DEL', TZ)).toEqual({
      value: '2026-11-02T01:15:00Z',
      offsetMinutes: 0,
      localTimeOnly: false,
    });
    expect(toDateTime('2026-11-02T06:45:00-0400', 'DEL', TZ)).toMatchObject({
      offsetMinutes: -240,
    });
  });

  it('passes unparseable strings through as local time only and ignores empty input', () => {
    expect(toDateTime('yesterday', 'DEL', TZ)).toEqual({
      value: 'yesterday',
      offsetMinutes: null,
      localTimeOnly: true,
    });
    expect(toDateTime(undefined, 'DEL', TZ)).toBeUndefined();
    expect(toDateTime(null, 'DEL', TZ)).toBeUndefined();
    expect(toDateTime('', 'DEL', TZ)).toBeUndefined();
  });

  it('resolves a DST gap to one of the two neighbouring offsets', () => {
    const out = toDateTime('2026-03-08T02:30:00', 'JFK', TZ);
    expect(out.localTimeOnly).toBe(false);
    expect([-300, -240]).toContain(out.offsetMinutes);
    expect(out.value).toBe(`2026-03-08T02:30:00${offsetText(out.offsetMinutes)}`);
  });
});

// ── durations and dates ─────────────────────────────────────────────────────────────────────────

describe('parseIsoDuration', () => {
  it('converts ISO-8601 durations to minutes', () => {
    expect(parseIsoDuration('PT18H30M')).toBe(1110);
    expect(parseIsoDuration('PT2H')).toBe(120);
    expect(parseIsoDuration('PT90M')).toBe(90);
    expect(parseIsoDuration('P1DT2H')).toBe(1560);
    expect(parseIsoDuration('P1W')).toBe(10080);
    expect(parseIsoDuration('PT0M')).toBe(0);
    expect(parseIsoDuration(' pt1h5m ')).toBe(65);
  });

  it('rounds seconds to the nearest minute and accepts decimal components', () => {
    expect(parseIsoDuration('PT1H30M30S')).toBe(91);
    expect(parseIsoDuration('PT1H30M29S')).toBe(90);
    expect(parseIsoDuration('PT1.5H')).toBe(90);
    expect(parseIsoDuration('-PT30M')).toBe(-30);
  });

  it('passes numbers through and rejects anything malformed', () => {
    expect(parseIsoDuration(135)).toBe(135);
    expect(parseIsoDuration(135.4)).toBe(135);
    expect(parseIsoDuration(NaN)).toBeUndefined();
    expect(parseIsoDuration('PT')).toBeUndefined();
    expect(parseIsoDuration('P')).toBeUndefined();
    expect(parseIsoDuration('18h')).toBeUndefined();
    expect(parseIsoDuration('')).toBeUndefined();
    expect(parseIsoDuration(undefined)).toBeUndefined();
    expect(parseIsoDuration(null)).toBeUndefined();
  });
});

describe('normalizeDate', () => {
  it('takes the calendar date of date and date-time forms', () => {
    expect(normalizeDate('2026-11-02')).toBe('2026-11-02');
    expect(normalizeDate('2026-11-02T00:00:00.000Z')).toBe('2026-11-02');
    expect(normalizeDate('2026-11-02T06:45:00')).toBe('2026-11-02');
    expect(normalizeDate('  2026-11-02 ')).toBe('2026-11-02');
    expect(normalizeDate(new Date(Date.UTC(2026, 10, 2, 23, 59)))).toBe('2026-11-02');
  });

  it('gives undefined for anything else', () => {
    expect(normalizeDate('02/11/2026')).toBeUndefined();
    expect(normalizeDate('2026-11-023')).toBeUndefined();
    expect(normalizeDate('')).toBeUndefined();
    expect(normalizeDate(undefined)).toBeUndefined();
    expect(normalizeDate(null)).toBeUndefined();
    expect(normalizeDate(new Date('nope'))).toBeUndefined();
  });
});

// ── enum maps ───────────────────────────────────────────────────────────────────────────────────

describe('enum maps', () => {
  const ROUND_TRIPS = [
    [
      'PAX_TYPE',
      PAX_TYPE,
      [
        ['ADT', 'ADULT'],
        ['CHD', 'CHILD'],
        ['INF', 'HELD_INFANT'],
        ['INS', 'SEATED_INFANT'],
        ['YTH', 'YOUNG'],
        ['SRC', 'SENIOR'],
        ['STU', 'STUDENT'],
      ],
    ],
    [
      'CABIN',
      CABIN,
      [
        ['economy', 'ECONOMY'],
        ['premium_economy', 'PREMIUM_ECONOMY'],
        ['business', 'BUSINESS'],
        ['first', 'FIRST'],
      ],
    ],
    [
      'GENDER',
      GENDER,
      [
        ['M', 'MALE'],
        ['F', 'FEMALE'],
        ['X', 'UNSPECIFIED'],
      ],
    ],
    [
      'DOCUMENT_TYPE',
      DOCUMENT_TYPE,
      [
        ['passport', 'PASSPORT'],
        ['national_id', 'IDENTITY_CARD'],
        ['visa', 'VISA'],
        ['known_traveler', 'KNOWN_TRAVELER'],
        ['redress', 'REDRESS'],
      ],
    ],
    [
      'AMENITY_TYPE',
      AMENITY_TYPE,
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
    ],
    [
      'SERVICE_NAME',
      SERVICE_NAME,
      [
        ['priority_boarding', 'PRIORITY_BOARDING'],
        ['airport_checkin', 'AIRPORT_CHECKIN'],
        ['fast_track', 'FAST_TRACK'],
      ],
    ],
    [
      'ADDITIONAL_SERVICE_TYPE',
      ADDITIONAL_SERVICE_TYPE,
      [
        ['baggage', 'CHECKED_BAGS'],
        ['cabin_baggage', 'CABIN_BAGS'],
        ['meal', 'MEALS'],
        ['seat', 'SEATS'],
        ['other', 'OTHER_SERVICES'],
      ],
    ],
  ];

  describe.each(ROUND_TRIPS)('%s', (_name, map, pairs) => {
    it('maps every SDK value to its wire value and back', () => {
      for (const [sdk, wire] of pairs) {
        expect(toWire(map, sdk)).toBe(wire);
        expect(fromWire(map, wire)).toBe(sdk);
        expect(map.toWire[sdk]).toBe(wire);
        expect(map.fromWire[wire]).toBe(sdk);
      }
      expect(Object.keys(map.toWire)).toHaveLength(pairs.length);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(map)).toBe(true);
      expect(Object.isFrozen(map.toWire)).toBe(true);
      expect(Object.isFrozen(map.fromWire)).toBe(true);
    });
  });

  it('reads the gender aliases of the orders spec and keeps pricing-time gender to M/F round trips', () => {
    expect(fromWire(GENDER, 'UNDISCLOSED')).toBe('X');
    expect(fromWire(GENDER, 'UNSPECIFIED')).toBe('X');
    expect(toWire(GENDER, 'X')).toBe('UNSPECIFIED');
    expect(fromWire(GENDER, 'male')).toBe('M');
  });

  it('points KTN / redress documents at the traveler fields', () => {
    expect(TRAVELER_FIELD_DOCUMENTS).toEqual({
      KNOWN_TRAVELER: 'knownTravelerNumber',
      REDRESS: 'redressNumber',
    });
    expect(Object.isFrozen(TRAVELER_FIELD_DOCUMENTS)).toBe(true);
    expect(toWire(DOCUMENT_TYPE, 'driving_licence')).toBe('driving_licence');
  });

  it('lower-cases amenity, cabin and service values no entry covers and folds BEVERAGE into meal', () => {
    expect(fromWire(AMENITY_TYPE, 'BEVERAGE')).toBe('meal');
    expect(fromWire(AMENITY_TYPE, 'PRE_RESERVED_SEAT')).toBe('pre_reserved_seat');
    expect(fromWire(AMENITY_TYPE, 'LAYOUT')).toBe('layout');
    expect(fromWire(CABIN, 'SUITE')).toBe('suite');
    expect(fromWire(SERVICE_NAME, 'LOUNGE_ACCESS')).toBe('lounge_access');
    expect(fromWire(ADDITIONAL_SERVICE_TYPE, 'PETS')).toBe('pets');
  });

  it('passes unknown values through without a fallback and ignores empty input', () => {
    expect(fromWire(PAX_TYPE, 'INFANT')).toBe('INFANT');
    expect(toWire(PAX_TYPE, 'XYZ')).toBe('XYZ');
    expect(toWire(CABIN, 'suite')).toBe('suite');
    for (const empty of [undefined, null, '', 3]) {
      expect(toWire(CABIN, empty)).toBeUndefined();
      expect(fromWire(CABIN, empty)).toBeUndefined();
    }
  });

  it('tolerates case variants on both directions', () => {
    expect(toWire(CABIN, 'Business')).toBe('BUSINESS');
    expect(fromWire(CABIN, 'business')).toBe('business');
    expect(fromWire(PAX_TYPE, 'adult')).toBe('ADT');
    expect(toWire(PAX_TYPE, 'adt')).toBe('ADULT');
  });

  it('never reads prototype members as enum entries', () => {
    expect(fromWire(CABIN, 'constructor')).toBe('constructor');
    expect(toWire(CABIN, '__proto__')).toBe('__proto__');
    expect(fromWire(PAX_TYPE, 'toString')).toBe('toString');
  });
});

// ── dictionaries ────────────────────────────────────────────────────────────────────────────────

describe('dictionary lookups', () => {
  const dict = {
    locations: {
      DEL: { cityCode: 'DEL', countryCode: 'IN' },
      LHR: { cityCode: 'LON', countryCode: 'GB' },
    },
    aircraft: { '32N': 'AIRBUS A320NEO' },
    currencies: { EUR: 'EURO' },
    carriers: { AI: 'AIR INDIA' },
  };

  it('resolves carriers and aircraft with a code fallback for unknown names', () => {
    expect(resolveCarrier('AI', dict)).toEqual({ code: 'AI', name: 'AIR INDIA' });
    expect(resolveCarrier('6E', dict)).toEqual({ code: '6E', name: '6E' });
    expect(resolveCarrier('6E', undefined)).toEqual({ code: '6E', name: '6E' });
    expect(resolveCarrier('', dict)).toBeUndefined();
    expect(resolveCarrier(undefined, dict)).toBeUndefined();
    expect(resolveAircraft('32N', dict)).toEqual({ code: '32N', name: 'AIRBUS A320NEO' });
    expect(resolveAircraft('788', dict)).toEqual({ code: '788', name: '788' });
    expect(resolveAircraft(null, dict)).toBeUndefined();
  });

  it('ignores prototype members and non-string dictionary values', () => {
    expect(resolveCarrier('constructor', dict)).toEqual({
      code: 'constructor',
      name: 'constructor',
    });
    expect(resolveAircraft('key', { aircraft: { key: 42 } })).toEqual({ code: 'key', name: 'key' });
  });

  it('builds a partial Place from the locations dictionary', () => {
    expect(resolvePlace('LHR', dict)).toEqual({ code: 'LHR', cityCode: 'LON', countryCode: 'GB' });
    expect(resolvePlace('XXX', dict)).toEqual({ code: 'XXX' });
    expect(resolvePlace('DEL', undefined)).toEqual({ code: 'DEL' });
    expect(resolvePlace('', dict)).toBeUndefined();
    expect(resolvePlace(undefined, dict)).toBeUndefined();
  });

  it('overlays the hydrated Place from a record, Map or function lookup', () => {
    const place = {
      code: 'DEL',
      type: 'airport',
      name: 'Indira Gandhi Intl',
      city: 'New Delhi',
      cityCode: 'DEL',
      country: 'India',
      countryCode: 'IN',
      tz: 'Asia/Kolkata',
    };
    expect(resolvePlace('DEL', dict, { DEL: place })).toEqual(place);
    expect(resolvePlace('DEL', dict, new Map([['DEL', place]]))).toEqual(place);
    expect(resolvePlace('DEL', dict, (c) => (c === 'DEL' ? place : undefined))).toEqual(place);
    expect(resolvePlace('LHR', dict, { DEL: place })).toEqual({
      code: 'LHR',
      cityCode: 'LON',
      countryCode: 'GB',
    });
  });

  it('keeps the dictionary codes when the hydrated place lacks them and keeps the requested code', () => {
    expect(
      resolvePlace('LHR', dict, { LHR: { name: 'Heathrow', tz: 'Europe/London', code: 'LHR ' } })
    ).toEqual({
      code: 'LHR',
      cityCode: 'LON',
      countryCode: 'GB',
      name: 'Heathrow',
      tz: 'Europe/London',
    });
    expect(
      resolvePlace('LHR', dict, () => {
        throw new Error('boom');
      })
    ).toEqual({ code: 'LHR', cityCode: 'LON', countryCode: 'GB' });
  });
});

// ── identifiers ─────────────────────────────────────────────────────────────────────────────────

describe('scopeId / unscopeId', () => {
  it('formats "<sessionId>:<id>" and splits on the first colon', () => {
    expect(scopeId('sess-1', '3')).toBe('sess-1:3');
    expect(scopeId('sess-1', 3)).toBe('sess-1:3');
    expect(unscopeId('sess-1:3')).toEqual({ sessionId: 'sess-1', id: '3' });
  });

  it('nests: a segment scoped under a scoped offer id unscopes twice', () => {
    const offerId = scopeId('sess', '1');
    const segmentId = scopeId(offerId, '40');
    expect(segmentId).toBe('sess:1:40');
    const outer = unscopeId(segmentId);
    expect(outer).toEqual({ sessionId: 'sess', id: '1:40' });
    expect(unscopeId(outer.id)).toEqual({ sessionId: '1', id: '40' });
  });

  it('tolerates ids without a scope, empty scopes and nullish input', () => {
    expect(scopeId(undefined, '7')).toBe('7');
    expect(scopeId('', 7)).toBe('7');
    expect(scopeId(null, 'x')).toBe('x');
    expect(unscopeId('7')).toEqual({ sessionId: undefined, id: '7' });
    expect(unscopeId(7)).toEqual({ sessionId: undefined, id: '7' });
    expect(unscopeId(':7')).toEqual({ sessionId: '', id: '7' });
    expect(unscopeId(undefined)).toEqual({ sessionId: undefined, id: undefined });
    expect(unscopeId(null)).toEqual({ sessionId: undefined, id: undefined });
  });
});

// ── renumbering ─────────────────────────────────────────────────────────────────────────────────

describe('renumberOffers', () => {
  it('uses schema-valid samples', () => {
    expectValid(SEARCH_SPEC, 'FlightOffer', withRfcTimes(OFFER_A));
    expectValid(SEARCH_SPEC, 'FlightOffer', withRfcTimes(OFFER_B));
  });

  it('makes offer and segment ids unique across two offers and remaps fareDetailsBySegment', () => {
    const before = JSON.stringify([OFFER_A, OFFER_B]);
    const { offers, map } = renumberOffers([OFFER_A, OFFER_B]);

    expect(offers.map((o) => o.id)).toEqual(['1', '2']);
    const segIds = (o) => o.itineraries[0].segments.map((s) => s.id);
    const fdbsIds = (o) => o.travelerPricings[0].fareDetailsBySegment.map((f) => f.segmentId);
    expect(segIds(offers[0])).toEqual(['1', '2']);
    expect(segIds(offers[1])).toEqual(['3', '4']);
    expect(fdbsIds(offers[0])).toEqual(['1', '2']);
    expect(fdbsIds(offers[1])).toEqual(['3', '4']);
    // Everything but the ids is untouched (the segments still describe the same flights).
    expect(offers[1].itineraries[0].segments[0].departure.iataCode).toBe('GOI');
    expect(offers[1].travelerPricings[0].fareDetailsBySegment[1].class).toBe('Q');

    expect(map.offers).toEqual({ 1: { index: 0, id: '1' }, 2: { index: 1, id: '1' } });
    expect(map.segments).toEqual({
      1: { index: 0, offerId: '1', id: '1' },
      2: { index: 0, offerId: '1', id: '2' },
      3: { index: 1, offerId: '2', id: '1' },
      4: { index: 1, offerId: '2', id: '2' },
    });
    expect(map.byIndex).toEqual([
      { id: '1', segments: { 1: '1', 2: '2' } },
      { id: '2', segments: { 1: '3', 2: '4' } },
    ]);

    // Input is never mutated and the output is a deep copy.
    expect(JSON.stringify([OFFER_A, OFFER_B])).toBe(before);
    expect(offers[0]).not.toBe(OFFER_A);
    expect(offers[0].itineraries[0].segments[0]).not.toBe(OFFER_A.itineraries[0].segments[0]);
    expectValid(SEARCH_SPEC, 'FlightOffer', withRfcTimes(offers[1]));
  });

  it('is a no-op renumbering for a single offer whose ids already start at 1', () => {
    const { offers, map } = renumberOffers(OFFER_A);
    expect(offers).toEqual([OFFER_A]);
    expect(map.byIndex).toEqual([{ id: '1', segments: { 1: '1', 2: '2' } }]);
  });

  it('tolerates the example spelling, integer ids, unknown segment references and junk entries', () => {
    const odd = {
      type: 'flight-offer',
      id: 9,
      itineraries: [{ segments: [{ id: 17 }, { id: '18' }] }, { segments: [{ id: 19 }] }],
      travelerPricings: [
        { fareDetailBySegment: [{ segmentId: 17 }, { segmentId: '18' }, { segmentId: '99' }] },
        { fareDetailsBySegment: [{ segmentId: 19 }, {}] },
        null,
      ],
    };
    const { offers, map } = renumberOffers([null, 'x', odd, OFFER_B]);
    expect(offers).toHaveLength(2);
    expect(offers[0].id).toBe('1');
    expect(offers[0].itineraries[0].segments.map((s) => s.id)).toEqual(['1', '2']);
    expect(offers[0].itineraries[1].segments.map((s) => s.id)).toEqual(['3']);
    expect(offers[0].travelerPricings[0].fareDetailBySegment.map((f) => f.segmentId)).toEqual([
      '1',
      '2',
      '99',
    ]);
    expect(offers[0].travelerPricings[1].fareDetailsBySegment).toEqual([{ segmentId: '3' }, {}]);
    expect(offers[1].id).toBe('2');
    expect(offers[1].itineraries[0].segments.map((s) => s.id)).toEqual(['4', '5']);
    expect(map.offers).toEqual({ 1: { index: 2, id: '9' }, 2: { index: 3, id: '1' } });
    expect(map.segments['4']).toEqual({ index: 3, offerId: '2', id: '1' });
  });

  it('handles empty and missing input', () => {
    expect(renumberOffers([])).toEqual({
      offers: [],
      map: { offers: {}, segments: {}, byIndex: [] },
    });
    expect(renumberOffers(undefined).offers).toEqual([]);
    expect(renumberOffers([{ type: 'flight-offer' }]).map.offers).toEqual({
      1: { index: 0, id: undefined },
    });
  });
});

// ── issues → problem / errors ───────────────────────────────────────────────────────────────────

describe('pointerToSdkPath', () => {
  it.each([
    ['/originDestinations/0/originLocationCode', 'slices[0].origin'],
    ['/originDestinations/1/destinationLocationCode', 'slices[1].destination'],
    ['/originDestinations/0/departureDateTimeRange/date', 'slices[0].date'],
    ['/data/travelers/1/documents/0/expiryDate', 'travelers[1].documents[0].expiry'],
    ['/data/travelers/0/name/firstName', 'travelers[0].firstName'],
    ['/data/travelers/0/dateOfBirth', 'travelers[0].dob'],
    ['/data/travelers/0/documents/0/documentType', 'travelers[0].documents[0].type'],
    ['/data/travelers/0/documents/0/issuanceCountry', 'travelers[0].documents[0].issuingCountry'],
    ['/data/travelers/0/id', 'travelers[0].id'],
    ['/data/travelers/0/loyaltyPrograms/0/id', 'travelers[0].loyalty[0].number'],
    [
      '/data/travelers/0/contact/phones/0/countryCallingCode',
      'travelers[0].contact.phone[0].countryCode',
    ],
    ['/data/contacts/0/emailAddress', 'contact[0].email'],
    ['/data/flightOffers/0/itineraries/0/segments/1/id', 'offers[0].itineraries[0].segments[1].id'],
    ['#/data/flightOffers/0/price/grandTotal', 'offers[0].price.grandTotal'],
    ['/searchCriteria/maxFlightOffers', 'searchCriteria.maxFlightOffers'],
    ['/a~1b/c~0d', 'a/b.c~d'],
  ])('%s → %s', (pointer, path) => {
    expect(pointerToSdkPath(pointer)).toBe(path);
  });

  it('gives undefined for empty, wrapper-only or non-string pointers', () => {
    expect(pointerToSdkPath('')).toBeUndefined();
    expect(pointerToSdkPath('/')).toBeUndefined();
    expect(pointerToSdkPath('/data')).toBeUndefined();
    expect(pointerToSdkPath(undefined)).toBeUndefined();
    expect(pointerToSdkPath(42)).toBeUndefined();
  });
});

describe('fromIssue', () => {
  it('converts the spec example (parameter + example) and maps query parameters to SearchParams', () => {
    expect(fromIssue(ISSUE_477)).toEqual({
      code: 477,
      status: 400,
      title: 'INVALID FORMAT',
      detail: 'invalid query parameter format',
      path: 'airport',
      pointer: undefined,
      parameter: 'airport',
      example: undefined,
    });
    expect(
      fromIssue({ ...ISSUE_477, source: { parameter: 'airport', example: 'CDG' } })
    ).toMatchObject({ path: 'airport', parameter: 'airport', example: 'CDG' });
    expect(
      fromIssue({ code: '477', source: { parameter: 'originLocationCode' } }, { httpStatus: 400 })
    ).toMatchObject({
      code: 477,
      status: 400,
      path: 'slices[0].origin',
      parameter: 'originLocationCode',
    });
    expect(fromIssue({ source: { parameter: 'adults' } }).path).toBe('passengers.adults');
    expect(fromIssue({ source: { parameter: 'returnDate' } }).path).toBe('slices[1].date');
  });

  it('prefers the pointer, keeps non-numeric codes and falls back to httpStatus', () => {
    const issue = fromIssue(
      {
        code: 'SOMETHING',
        title: 'T',
        source: { pointer: '/data/travelers/1/documents/0/expiryDate', parameter: 'ignored' },
      },
      { httpStatus: 422 }
    );
    expect(issue).toMatchObject({
      code: 'SOMETHING',
      status: 422,
      path: 'travelers[1].documents[0].expiry',
      pointer: '/data/travelers/1/documents/0/expiryDate',
      parameter: 'ignored',
    });
    expect(fromIssue({ status: '404', code: ' 1797 ' }).status).toBe(404);
    expect(fromIssue({ status: '404', code: ' 1797 ' }).code).toBe(1797);
  });

  it('never throws on junk', () => {
    expect(fromIssue(undefined)).toEqual({
      code: undefined,
      status: undefined,
      title: undefined,
      detail: undefined,
      path: undefined,
      pointer: undefined,
      parameter: undefined,
      example: undefined,
    });
    expect(fromIssue('nope', null).code).toBeUndefined();
    expect(fromIssue({ code: {}, source: 'x', title: 7 }).title).toBeUndefined();
  });
});

describe('fromIssueArray', () => {
  const issue = (code, extra = {}) => ({
    status: 400,
    code,
    title: `CODE ${code}`,
    detail: `detail ${code}`,
    ...extra,
  });

  it('uses a schema-valid Error_400 envelope', () => {
    expectValid(SEARCH_SPEC, 'Error_400', { errors: [ISSUE_477] });
  });

  it.each([425, 477, 572, 2668, 2781, 4926, 9880, 10661, 32171])(
    'maps 400 code %s to ValidationError with paths from pointer / parameter',
    (code) => {
      const errors = [
        issue(code, {
          source: { pointer: '/originDestinations/0/originLocationCode', example: 'DEL' },
        }),
        issue(code, { source: { parameter: 'adults' } }),
      ];
      const out = fromIssueArray(errors, { httpStatus: 400, requestId: 'req-1' });
      expect(out.ErrorClass).toBe(ValidationError);
      expect(out.empty).toBe(false);
      expect(out.problem).toEqual({
        type: 'about:blank',
        title: `CODE ${code}`,
        status: 400,
        detail: `detail ${code}`,
        code: 'VALIDATION_FAILED',
        errors,
        requestId: 'req-1',
      });
      const [message, options] = out.errorArgs;
      expect(message).toBe(`detail ${code}`);
      expect(options.issues).toEqual([
        {
          path: 'slices[0].origin',
          code: String(code),
          message: `detail ${code}`,
          params: {
            status: 400,
            example: 'DEL',
            pointer: '/originDestinations/0/originLocationCode',
          },
        },
        {
          path: 'passengers.adults',
          code: String(code),
          message: `detail ${code}`,
          params: { status: 400, parameter: 'adults' },
        },
      ]);
      const err = new out.ErrorClass(...out.errorArgs);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(SdkError);
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.requestId).toBe('req-1');
      expect(err.issues).toHaveLength(2);
      expect(err.issues[0].path).toBe('slices[0].origin');
      expect(err.details).toEqual({ problem: out.problem, status: 400 });
      expect(err.retryable).toBe(false);
    }
  );

  const API_ROWS = [
    [37200, 400, PriceChangedError, 'PRICE_CHANGED', {}, false],
    [34651, 400, OfferUnavailableError, 'SOLD_OUT', { reason: 'sold_out' }, false],
    [34107, 400, OfferUnavailableError, 'OFFER_WITHDRAWN', { reason: 'withdrawn' }, false],
    [38034, 500, ApiError, 'SERVICE_UNAVAILABLE', {}, true],
    [1304, 400, PaymentError, 'PAYMENT_DECLINED', { reason: 'declined' }, true],
    [34733, 400, PaymentError, 'PAYMENT_GATEWAY_ERROR', { reason: 'gateway' }, true],
    [9112, 400, BookingError, 'BOOKING_FAILED', { stage: 'ticketing' }, false],
    [36870, 400, BookingError, 'BOOKING_FAILED', { stage: 'create' }, false],
    [39397, 400, NotFoundError, 'NOT_FOUND', {}, false],
    [1797, 404, NotFoundError, 'NOT_FOUND', {}, false],
    [2552, 409, ConflictError, 'CONFLICT', {}, true],
    [141, 500, ApiError, 'INTERNAL_ERROR', {}, true],
  ];

  it.each(API_ROWS)(
    'maps code %s (HTTP %s) to %o with code %s',
    (code, httpStatus, Class, sdkCode, fields, retryable) => {
      const errors = [issue(code, { status: httpStatus })];
      const out = fromIssueArray(errors, { httpStatus, requestId: 'req-2' });
      expect(out.ErrorClass).toBe(Class);
      expect(out.empty).toBe(code === 39397);
      expect(out.problem).toMatchObject({
        type: 'about:blank',
        title: `CODE ${code}`,
        detail: `detail ${code}`,
        status: httpStatus,
        code: sdkCode,
        errors,
        requestId: 'req-2',
      });
      expect(out.issues[0].code).toBe(code);

      const [message, options] = out.errorArgs;
      expect(message).toBe(`detail ${code}`);
      expect(options).toMatchObject({
        code: sdkCode,
        status: httpStatus,
        problem: out.problem,
        issues: errors,
        requestId: 'req-2',
        ...fields,
      });
      const err = new Class(...out.errorArgs);
      expect(err).toBeInstanceOf(Class);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe(sdkCode);
      expect(err.status).toBe(httpStatus);
      expect(err.retryable).toBe(retryable);
      expect(err.problem).toBe(out.problem);
      expect(err.issues).toEqual(errors);
      expect(err.requestId).toBe('req-2');
      expect(err.message).toBe(`detail ${code}`);
      for (const [k, v] of Object.entries(fields)) expect(err[k]).toBe(v);

      // The facade path (problem+json with the same canonical code) lands on the same class.
      const viaProblem = errorFromProblem(out.problem, { requestId: 'req-2' });
      expect(viaProblem).toBeInstanceOf(Class);
      expect(viaProblem.code).toBe(sdkCode);
      for (const [k, v] of Object.entries(fields)) expect(viaProblem[k]).toBe(v);
    }
  );

  it('accepts numeric codes given as strings', () => {
    expect(fromIssueArray([issue('37200')], { httpStatus: 400 }).ErrorClass).toBe(
      PriceChangedError
    );
    expect(fromIssueArray([issue(' 2552 ')], { httpStatus: 409 }).ErrorClass).toBe(ConflictError);
    expect(fromIssueArray([issue('477')], { httpStatus: 400 }).ErrorClass).toBe(ValidationError);
    expect(fromIssueArray([issue('39397')]).empty).toBe(true);
  });

  it('falls back to a status-driven ApiError for unknown codes', () => {
    const bad = fromIssueArray([issue(45455)], { httpStatus: 400 });
    expect(bad.ErrorClass).toBe(ApiError);
    expect(bad.problem.code).toBe('BAD_REQUEST');
    expect(new ApiError(...bad.errorArgs)).toMatchObject({
      status: 400,
      retryable: false,
      code: 'BAD_REQUEST',
    });

    const boom = fromIssueArray([issue(45455, { status: 500 })], { httpStatus: 500 });
    expect(boom.problem.code).toBe('INTERNAL_ERROR');
    expect(new ApiError(...boom.errorArgs)).toMatchObject({ status: 500, retryable: true });

    const nothing = fromIssueArray([{ code: 'WEIRD' }]);
    expect(nothing.ErrorClass).toBe(ApiError);
    expect(nothing.problem).toEqual({
      type: 'about:blank',
      title: 'Request failed',
      status: 0,
      code: 'API_ERROR',
      errors: [{ code: 'WEIRD' }],
    });
    expect(nothing.errorArgs).toEqual([
      'Request failed',
      {
        code: 'API_ERROR',
        status: undefined,
        problem: nothing.problem,
        issues: [{ code: 'WEIRD' }],
      },
    ]);
  });

  it('lets the first mapped issue decide and the first issue supply the texts', () => {
    const errors = [issue(45455), issue(37200), issue(477)];
    const out = fromIssueArray(errors, { httpStatus: 400 });
    expect(out.ErrorClass).toBe(PriceChangedError);
    expect(out.problem.title).toBe('CODE 45455');
    expect(out.errorArgs[0]).toBe('detail 45455');
    expect(out.issues.map((i) => i.code)).toEqual([45455, 37200, 477]);
  });

  it('reads the status from the issues when httpStatus is missing and tolerates other input shapes', () => {
    const only = fromIssueArray({ errors: [issue(1797, { status: 404 })] });
    expect(only.problem.status).toBe(404);
    expect(only.ErrorClass).toBe(NotFoundError);
    expect(only.problem).not.toHaveProperty('requestId');
    expect(only.errorArgs[1]).not.toHaveProperty('requestId');

    const single = fromIssueArray(issue(2552, { status: 409 }));
    expect(single.ErrorClass).toBe(ConflictError);
    expect(single.problem.errors).toHaveLength(1);

    for (const junk of [undefined, null, [], 'x', 7, [null, 'y']]) {
      const out = fromIssueArray(junk);
      expect(out.ErrorClass).toBe(ApiError);
      expect(out.problem.errors).toEqual([]);
      expect(out.problem.title).toBe('Request failed');
      expect(out.issues).toEqual([]);
      expect(() => new out.ErrorClass(...out.errorArgs)).not.toThrow();
    }
  });

  it('derives the title from the detail when the issue has no title, and omits a duplicate detail', () => {
    const out = fromIssueArray([{ code: 1797, detail: 'Order not found' }], { httpStatus: 404 });
    expect(out.problem.title).toBe('Order not found');
    expect(out.problem).not.toHaveProperty('detail');
    expect(out.errorArgs[0]).toBe('Order not found');
    const titled = fromIssueArray([{ code: 1797, title: 'NOT FOUND' }], { httpStatus: 404 });
    expect(titled.errorArgs[0]).toBe('NOT FOUND');
  });
});

describe('fromWarnings', () => {
  it('turns Issue-shaped warnings into readable strings', () => {
    expect(
      fromWarnings([
        { code: 10151, title: 'PRICE CHANGED', detail: 'fare recalculated' },
        { title: 'ONLY TITLE' },
        { detail: 'only detail' },
        { code: 12345 },
        { title: 'SAME', detail: 'SAME' },
        { title: '  ', detail: ' spaced ' },
        {},
        'plain string',
        '  ',
        null,
        7,
      ])
    ).toEqual([
      'PRICE CHANGED: fare recalculated',
      'ONLY TITLE',
      'only detail',
      '12345',
      'SAME',
      'spaced',
      'plain string',
    ]);
  });

  it('gives an empty list for non-arrays', () => {
    expect(fromWarnings(undefined)).toEqual([]);
    expect(fromWarnings(null)).toEqual([]);
    expect(fromWarnings({ title: 'x' })).toEqual([]);
    expect(fromWarnings('x')).toEqual([]);
  });
});

describe('readEither', () => {
  it('returns the first own key that is defined', () => {
    const order = { ticketingAggreement: { option: 'DELAY_TO_CANCEL' } };
    expect(readEither(order, 'ticketingAgreement', 'ticketingAggreement')).toEqual({
      option: 'DELAY_TO_CANCEL',
    });
    expect(readEither({ a: undefined, b: null, c: 0 }, 'a', 'b', 'c')).toBeNull();
    expect(readEither({ a: undefined, c: 0 }, 'a', 'b', 'c')).toBe(0);
    expect(
      readEither(
        { fareDetailsBySegment: [], fareDetailBySegment: [1] },
        'fareDetailsBySegment',
        'fareDetailBySegment'
      )
    ).toEqual([]);
  });

  it('gives undefined when nothing matches, for non-objects and for prototype members', () => {
    expect(readEither({ a: 1 }, 'b')).toBeUndefined();
    expect(readEither({ a: 1 })).toBeUndefined();
    expect(readEither(undefined, 'a')).toBeUndefined();
    expect(readEither(null, 'a')).toBeUndefined();
    expect(readEither([1], '0')).toBeUndefined();
    expect(readEither('str', 'length')).toBeUndefined();
    expect(readEither({}, 'constructor', 'toString')).toBeUndefined();
  });
});
