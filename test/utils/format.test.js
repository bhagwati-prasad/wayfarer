import { describe, it, expect, vi, afterEach } from 'vitest';
import * as format from '../../src/utils/format.js';
import {
  formatPlace,
  formatRoute,
  formatStops,
  formatLayovers,
  formatPaxSummary,
  formatFlightNumber,
  formatOperatedBy,
  formatCabin,
  formatFareType,
  formatPaxType,
  formatBaggage,
  formatName,
  initials,
  maskEmail,
  maskPhone,
  maskCard,
  maskDocument,
  formatReference,
  formatSeat,
  titleCase,
  truncate,
} from '../../src/utils/format.js';
import { createI18n } from '../../src/utils/i18n.js';
import { ValidationError } from '../../src/errors/index.js';

/** Collapse ICU's narrow no-break spaces so assertions read naturally. */
const n = (s) => s.replace(/\s/g, ' ');

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

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const DEL = {
  code: 'DEL',
  type: 'airport',
  name: 'Indira Gandhi International Airport',
  city: 'Delhi',
  cityCode: 'DEL',
  country: 'India',
  countryCode: 'IN',
  tz: 'Asia/Kolkata',
};
const BOM = {
  code: 'BOM',
  type: 'airport',
  name: 'Chhatrapati Shivaji Maharaj International Airport',
  city: 'Mumbai',
  country: 'India',
  countryCode: 'IN',
  tz: 'Asia/Kolkata',
};
const DXB = {
  code: 'DXB',
  type: 'airport',
  name: 'Dubai International Airport',
  city: 'Dubai',
  country: 'United Arab Emirates',
  countryCode: 'AE',
  tz: 'Asia/Dubai',
};
const LHR = {
  code: 'LHR',
  type: 'airport',
  name: 'Heathrow Airport',
  city: 'London',
  country: 'United Kingdom',
  countryCode: 'GB',
  tz: 'Europe/London',
};
const LONDON_CITY = {
  code: 'LON',
  type: 'city',
  name: 'London',
  city: 'London',
  country: 'United Kingdom',
  countryCode: 'GB',
  tz: 'Europe/London',
};

const AI = { code: 'AI', name: 'Air India' };
const UK = { code: 'UK', name: 'Vistara' };

const seg = (over = {}) => ({
  id: 's1',
  marketingCarrier: AI,
  operatingCarrier: AI,
  flightNumber: '101',
  origin: DEL,
  destination: DXB,
  departureAt: '2026-11-02T06:45:00+05:30',
  arrivalAt: '2026-11-02T09:30:00+04:00',
  durationMinutes: 225,
  cabin: 'economy',
  ...over,
});

const layover = (airport, durationMinutes, over = {}) => ({
  airport,
  durationMinutes,
  overnight: false,
  selfTransfer: false,
  airportChange: false,
  ...over,
});

const slice = (over = {}) => ({
  id: 'sl1',
  origin: DEL,
  destination: LHR,
  departureAt: '2026-11-02T06:45:00+05:30',
  arrivalAt: '2026-11-02T16:10:00+00:00',
  durationMinutes: 865,
  stops: 1,
  segments: [
    seg(),
    seg({
      id: 's2',
      marketingCarrier: AI,
      operatingCarrier: UK,
      flightNumber: '131',
      origin: DXB,
      destination: LHR,
      departureAt: '2026-11-02T11:40:00+04:00',
      arrivalAt: '2026-11-02T16:10:00+00:00',
      durationMinutes: 510,
    }),
  ],
  layovers: [layover(DXB, 130)],
  dayChange: 0,
  ...over,
});

const searchParams = {
  tripType: 'round_trip',
  slices: [
    { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
    { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
  ],
  passengers: { adults: 2, children: 1, infants: 0 },
  cabin: 'economy',
};

const traveler = {
  type: 'ADT',
  title: 'Mr',
  firstName: 'Rahul',
  middleName: 'Kumar',
  lastName: 'Sharma',
  gender: 'M',
  dob: '1990-01-15',
};

/** Real translator from the bundled English copy. */
const i18n = createI18n();
const { t } = i18n;

/** Spy translator that records calls and answers with a marker so the key / vars can be asserted. */
function spyT(answer = (key) => `<${key}>`) {
  return vi.fn((key, vars, opts) => answer(key, vars, opts));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── module surface ───────────────────────────────────────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly the functions documented in docs/api/03-utils.md §3', () => {
    expect(Object.keys(format).sort()).toEqual(
      [
        'formatPlace',
        'formatRoute',
        'formatStops',
        'formatLayovers',
        'formatPaxSummary',
        'formatFlightNumber',
        'formatOperatedBy',
        'formatCabin',
        'formatFareType',
        'formatPaxType',
        'formatBaggage',
        'formatName',
        'initials',
        'maskEmail',
        'maskPhone',
        'maskCard',
        'maskDocument',
        'formatReference',
        'formatSeat',
        'titleCase',
        'truncate',
      ].sort()
    );
    for (const fn of Object.values(format)) expect(typeof fn).toBe('function');
  });

  it('is pure: starts no timers and keeps no listeners', () => {
    vi.useFakeTimers();
    formatRoute(searchParams);
    formatLayovers(slice(), t);
    formatPaxSummary(searchParams.passengers, t);
    maskEmail('rahul@example.com');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never mutates its inputs (frozen fixtures stay equal to their snapshots)', () => {
    const deepFreeze = (o) => {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
      return o;
    };
    const inputs = {
      slices: [slice({ origin: DEL, destination: BOM }), slice({ origin: BOM, destination: DEL })],
      params: { ...searchParams, slices: searchParams.slices.map((s) => ({ ...s })) },
      withoutLayovers: (() => {
        const s = slice();
        delete s.layovers;
        return s;
      })(),
      segment: seg({ operatingCarrier: UK }),
      pax: { adults: 2, children: 1, infants: 1 },
      bags: [{ quantity: 1, weightKg: 23, included: true }, { included: false }],
      traveler: { ...traveler },
      phone: { countryCode: '91', number: '9876543210' },
      card: { brand: 'visa', last4: '4242' },
      seat: { number: '12A', available: true, characteristics: [] },
      pair: { row: 12, column: 'A' },
    };
    const snapshot = structuredClone(inputs);
    deepFreeze(inputs);
    formatRoute(inputs.slices, { style: 'city_code' });
    formatRoute(inputs.params);
    formatPlace(inputs.slices[0].origin, 'full');
    formatStops(inputs.slices[0]);
    formatLayovers(inputs.slices[0], t);
    formatLayovers(inputs.withoutLayovers);
    formatPaxSummary(inputs.pax, i18n);
    formatFlightNumber(inputs.segment);
    formatOperatedBy(inputs.segment, t);
    formatBaggage(inputs.bags, t);
    formatName(inputs.traveler, { title: true, order: 'family_first' });
    initials(inputs.traveler);
    maskPhone(inputs.phone);
    maskCard(inputs.card);
    formatSeat(inputs.seat);
    formatSeat(inputs.pair);
    expect(inputs).toEqual(snapshot);
  });

  it('never writes to the console', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    formatRoute(searchParams, { style: 'city' });
    formatLayovers(slice(), (key) => key);
    formatCabin('premium_plus', t);
    formatBaggage([{ quantity: 0, weightKg: 23 }], t);
    maskCard('4242424242424242', 'constructor');
    maskPhone('+91 98765 43210');
    titleCase("CHICAGO O'HARE");
    truncate('Indira Gandhi International', 14);
    expect(() => formatSeat({ row: true, column: 'A' })).toThrow(ValidationError);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// ── formatPlace ──────────────────────────────────────────────────────────────────────────────────

describe('formatPlace', () => {
  it('renders every documented style', () => {
    expect(formatPlace(DEL, 'code')).toBe('DEL');
    expect(formatPlace(DEL, 'city')).toBe('Delhi');
    expect(formatPlace(DEL, 'city_code')).toBe('Delhi (DEL)');
    expect(formatPlace(DEL, 'airport')).toBe('Indira Gandhi International Airport');
    expect(formatPlace(DEL, 'full')).toBe(
      'Indira Gandhi International Airport (DEL), Delhi, India'
    );
  });

  it('defaults to city_code', () => {
    expect(formatPlace(DEL)).toBe('Delhi (DEL)');
  });

  it('does not repeat the city for a city / metro place', () => {
    expect(formatPlace(LONDON_CITY, 'full')).toBe('London (LON), United Kingdom');
    expect(formatPlace(LONDON_CITY, 'airport')).toBe('London');
  });

  it('falls back across missing fields and accepts a bare IATA code', () => {
    expect(formatPlace({ code: 'XYZ' }, 'city')).toBe('XYZ');
    expect(formatPlace({ code: 'XYZ' }, 'city_code')).toBe('XYZ');
    expect(formatPlace({ code: 'XYZ' }, 'full')).toBe('XYZ');
    expect(formatPlace({ code: 'XYZ', name: 'Some Airport' }, 'city')).toBe('Some Airport');
    expect(formatPlace({ code: 'XYZ', city: 'Some City' }, 'airport')).toBe('Some City');
    expect(formatPlace({ code: 'XYZ', city: 'Some City', country: 'Nowhere' }, 'full')).toBe(
      'Some City (XYZ), Nowhere'
    );
    expect(formatPlace('del', 'city_code')).toBe('DEL');
    expect(formatPlace(' bom ', 'full')).toBe('BOM');
    expect(formatPlace({ code: 'del', city: '  Delhi  ' })).toBe('Delhi (DEL)');
  });

  it('rejects places without a code and unknown styles', () => {
    expectInvalid(() => formatPlace(null), 'p', 'type');
    expectInvalid(() => formatPlace({}), 'p', 'type');
    expectInvalid(() => formatPlace({ code: '' }), 'p', 'type');
    expectInvalid(() => formatPlace(''), 'p', 'type');
    expectInvalid(() => formatPlace(DEL, 'town'), 'style', 'invalid_style');
    expect(() => formatPlace(DEL, 'town')).toThrow(/formatPlace/);
  });
});

// ── formatRoute ──────────────────────────────────────────────────────────────────────────────────

describe('formatRoute', () => {
  const outbound = slice({ origin: DEL, destination: BOM });
  const inbound = slice({ id: 'sl2', origin: BOM, destination: DEL });

  it('chains slices (Place objects) through their junction codes', () => {
    expect(formatRoute([outbound, inbound])).toBe('DEL → BOM → DEL');
    expect(formatRoute([outbound])).toBe('DEL → BOM');
    expect(formatRoute({ id: 'o1', slices: [outbound, inbound] })).toBe('DEL → BOM → DEL');
  });

  it('accepts SearchParams (codes) and anything carrying slices', () => {
    expect(formatRoute(searchParams)).toBe('DEL → BOM → DEL');
    expect(formatRoute(searchParams.slices)).toBe('DEL → BOM → DEL');
    expect(formatRoute({ id: 'srch', params: searchParams })).toBe('DEL → BOM → DEL');
    expect(formatRoute({ origin: 'del', destination: 'bom' })).toBe('DEL → BOM');
    expect(formatRoute({ ...searchParams, slices: [{ origin: 'DEL', destination: BOM }] })).toBe(
      'DEL → BOM'
    );
  });

  it('starts a new chain for an open jaw', () => {
    expect(
      formatRoute({
        tripType: 'multi_city',
        slices: [
          { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
          { origin: 'BLR', destination: 'DEL', date: '2026-11-09' },
        ],
      })
    ).toBe('DEL → BOM, BLR → DEL');
    expect(
      formatRoute([
        { origin: 'DEL', destination: 'DXB' },
        { origin: 'DXB', destination: 'LHR' },
        { origin: 'LHR', destination: 'DEL' },
      ])
    ).toBe('DEL → DXB → LHR → DEL');
  });

  it('honours arrow and style options', () => {
    expect(formatRoute(searchParams, { arrow: '-' })).toBe('DEL - BOM - DEL');
    expect(formatRoute(searchParams, { arrow: '⇄' })).toBe('DEL ⇄ BOM ⇄ DEL');
    expect(formatRoute([outbound, inbound], { style: 'city' })).toBe('Delhi → Mumbai → Delhi');
    expect(formatRoute([outbound], { style: 'city_code' })).toBe('Delhi (DEL) → Mumbai (BOM)');
    // codes have no city to show, so they stay codes under any style
    expect(formatRoute(searchParams, { style: 'city' })).toBe('DEL → BOM → DEL');
    expect(formatRoute(searchParams, null)).toBe('DEL → BOM → DEL');
  });

  it('always puts exactly one space on each side of the arrow', () => {
    expect(formatRoute(searchParams, { arrow: ' → ' })).toBe('DEL → BOM → DEL');
    expect(formatRoute(searchParams, { arrow: '  to  ' })).toBe('DEL to BOM to DEL');
    // an empty arrow leaves a single space, never a double one
    expect(formatRoute(searchParams, { arrow: '' })).toBe('DEL BOM DEL');
    expect(formatRoute(searchParams, { arrow: '   ' })).toBe('DEL BOM DEL');
  });

  it('returns an empty string for no slices', () => {
    expect(formatRoute([])).toBe('');
    expect(formatRoute({ ...searchParams, slices: [] })).toBe('');
  });

  it('rejects input without slices, slices without endpoints and bad options', () => {
    expectInvalid(() => formatRoute(null), 'slices', 'type');
    expectInvalid(() => formatRoute('DEL-BOM'), 'slices', 'type');
    expectInvalid(() => formatRoute({ tripType: 'one_way' }), 'slices', 'type');
    expectInvalid(() => formatRoute([null]), 'slices[0]', 'type');
    expectInvalid(() => formatRoute([{ origin: 'DEL' }]), 'slices[0].destination', 'type');
    expectInvalid(
      () => formatRoute([{ origin: 'DEL', destination: 'BOM' }, { destination: 'DEL' }]),
      'slices[1].origin',
      'type'
    );
    expectInvalid(() => formatRoute(searchParams, { arrow: 1 }), 'arrow', 'type');
    expectInvalid(() => formatRoute(searchParams, { style: 'town' }), 'style', 'invalid_style');
  });
});

// ── formatStops ──────────────────────────────────────────────────────────────────────────────────

describe('formatStops', () => {
  it('renders English without t', () => {
    expect(formatStops(0)).toBe('Non-stop');
    expect(formatStops(1)).toBe('1 stop');
    expect(formatStops(2)).toBe('2 stops');
    expect(formatStops(3, null)).toBe('3 stops');
  });

  it('uses t with the documented key and vars, passing the English pattern as default', () => {
    const spy = spyT();
    expect(formatStops(1, spy)).toBe('<common.stops.count>');
    expect(spy).toHaveBeenCalledWith(
      'common.stops.count',
      { count: 1 },
      { default: '{count, plural, =0{Non-stop} one{# stop} other{# stops}}' }
    );
  });

  it('matches the bundled English through a real i18n.t and accepts the I18n instance', () => {
    expect(formatStops(0, t)).toBe('Non-stop');
    expect(formatStops(1, t)).toBe('1 stop');
    expect(formatStops(2, t)).toBe('2 stops');
    expect(formatStops(2, i18n)).toBe('2 stops');
  });

  it('is localised by a host bundle', () => {
    const fr = createI18n({
      locale: 'fr',
      messages: {
        fr: {
          common: {
            stops: { count: '{count, plural, =0{Direct} one{# escale} other{# escales}}' },
          },
        },
      },
    });
    expect(formatStops(0, fr.t)).toBe('Direct');
    expect(formatStops(2, fr.t)).toBe('2 escales');
  });

  it('falls back to English when t answers with the key itself or a non-string', () => {
    expect(formatStops(1, (key) => key)).toBe('1 stop');
    expect(formatStops(0, () => undefined)).toBe('Non-stop');
  });

  it('accepts a slice in place of the number', () => {
    expect(formatStops(slice())).toBe('1 stop');
    expect(formatStops(slice({ stops: undefined }))).toBe('1 stop'); // from segments
    expect(formatStops({ segments: [seg()] })).toBe('Non-stop');
    expect(formatStops({ layovers: [layover(DXB, 60), layover(LHR, 90)] })).toBe('2 stops');
  });

  it('rejects invalid counts and translators', () => {
    expectInvalid(() => formatStops(-1), 'n', 'invalid_count');
    expectInvalid(() => formatStops(1.5), 'n', 'invalid_count');
    expectInvalid(() => formatStops('1'), 'n', 'invalid_count');
    expectInvalid(() => formatStops(undefined), 'n', 'invalid_count');
    expectInvalid(() => formatStops({}), 'n', 'invalid_count');
    expectInvalid(() => formatStops({ stops: null }), 'n', 'invalid_count');
    expectInvalid(() => formatStops({ stops: '1' }), 'n', 'invalid_count');
    expectInvalid(() => formatStops(NaN), 'n', 'invalid_count');
    expectInvalid(() => formatStops(1, 'en'), 't', 'type');
    expectInvalid(() => formatStops(1, {}), 't', 'type');
  });
});

// ── formatLayovers ───────────────────────────────────────────────────────────────────────────────

describe('formatLayovers', () => {
  it('lists each layover as duration + airport code', () => {
    expect(n(formatLayovers(slice()))).toBe('2h 10m in DXB');
    expect(
      n(formatLayovers(slice({ stops: 2, layovers: [layover(DXB, 130), layover(LHR, 65)] })))
    ).toBe('2h 10m in DXB, 1h 5m in LHR');
    expect(n(formatLayovers(slice({ layovers: [layover('dxb', 45)] })))).toBe('45m in DXB');
  });

  it('composes with formatStops as documented', () => {
    const s = slice();
    expect(n(`${formatStops(s.stops)} · ${formatLayovers(s)}`)).toBe('1 stop · 2h 10m in DXB');
  });

  it('returns an empty string for a non-stop slice', () => {
    expect(formatLayovers(slice({ stops: 0, layovers: [], segments: [seg()] }))).toBe('');
    expect(formatLayovers([])).toBe('');
  });

  it('derives layovers from consecutive segments when the slice has none', () => {
    const s = slice();
    delete s.layovers;
    expect(n(formatLayovers(s))).toBe('2h 10m in DXB');
    expect(formatLayovers({ segments: [seg()] })).toBe('');
  });

  it('accepts a bare Layover[]', () => {
    expect(n(formatLayovers([layover(DXB, 130)]))).toBe('2h 10m in DXB');
  });

  it('uses t with common.layover, passing the formatted duration and the airport code', () => {
    const spy = spyT((key, vars) => `${vars.duration}|${vars.airport}`);
    expect(n(formatLayovers(slice(), spy))).toBe('2h 10m|DXB');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('common.layover');
    expect(spy.mock.calls[0][2]).toEqual({ default: '{duration} in {airport}' });
    // the bundled English copy matches the docs/api/03-utils.md §3 example
    expect(n(formatLayovers(slice(), t))).toBe('2h 10m in DXB');
  });

  it('rejects malformed slices and layovers', () => {
    expectInvalid(() => formatLayovers(null), 'slice', 'type');
    expectInvalid(() => formatLayovers({ id: 'x' }), 'slice', 'type');
    expectInvalid(() => formatLayovers([null]), 'layovers[0]', 'type');
    expectInvalid(() => formatLayovers([layover({}, 60)]), 'layovers[0].airport', 'type');
    expectInvalid(
      () => formatLayovers([layover(DXB, -5)]),
      'layovers[0].durationMinutes',
      'invalid_duration'
    );
    expectInvalid(
      () => formatLayovers([layover(DXB, '60')]),
      'layovers[0].durationMinutes',
      'invalid_duration'
    );
    expectInvalid(() => formatLayovers({ segments: [seg(), null] }), 'slice.segments[1]', 'type');
    expectInvalid(() => formatLayovers(slice(), 42), 't', 'type');
  });

  it('addresses bad segment times to the segment field when deriving layovers', () => {
    const second = seg({ origin: DXB, destination: LHR, departureAt: '2026-11-02T11:40:00+04:00' });
    // missing arrival on the first segment
    const missingArrival = expectInvalid(
      () => formatLayovers({ segments: [seg({ arrivalAt: undefined }), second] }),
      'slice.segments[0].arrivalAt',
      'invalid_datetime'
    );
    expect(missingArrival.message).toMatch(/^formatLayovers: /);
    // unparsable departure on the second segment
    const badDeparture = expectInvalid(
      () => formatLayovers({ segments: [seg(), seg({ ...second, departureAt: 'tomorrow' })] }),
      'slice.segments[1].departureAt',
      'invalid_datetime'
    );
    expect(badDeparture.issues[0].params).toEqual({ value: 'tomorrow' });
    // the next flight leaves before the previous one lands
    const reversed = expectInvalid(
      () =>
        formatLayovers({
          segments: [seg(), seg({ ...second, departureAt: '2026-11-02T07:30:00+04:00' })],
        }),
      'slice.segments[1].departureAt',
      'invalid_duration'
    );
    expect(reversed.issues[0].params.value).toBeLessThan(0);
    // a zero-minute connection is still a (degenerate) layover, not an error
    expect(
      n(
        formatLayovers({
          segments: [seg(), seg({ ...second, departureAt: '2026-11-02T09:30:00+04:00' })],
        })
      )
    ).toBe('0m in DXB');
  });
});

// ── formatPaxSummary ─────────────────────────────────────────────────────────────────────────────

describe('formatPaxSummary', () => {
  it('renders English counts in display order, skipping zeros', () => {
    expect(formatPaxSummary({ adults: 2, children: 1, infants: 0 })).toBe('2 adults, 1 child');
    expect(formatPaxSummary({ adults: 1, children: 0, infants: 1 })).toBe('1 adult, 1 infant');
    expect(formatPaxSummary({ adults: 2, children: 2, infants: 2 })).toBe(
      '2 adults, 2 children, 2 infants'
    );
    expect(
      formatPaxSummary({
        adults: 1,
        children: 0,
        infants: 0,
        infantsSeated: 1,
        youth: 2,
        seniors: 1,
      })
    ).toBe('1 adult, 1 infant with seat, 2 youths, 1 senior');
    expect(formatPaxSummary({ adults: 1, infantsSeated: 2 })).toBe('1 adult, 2 infants with seats');
  });

  it('returns an empty string when every count is zero or missing', () => {
    expect(formatPaxSummary({ adults: 0, children: 0, infants: 0 })).toBe('');
    expect(formatPaxSummary({})).toBe('');
  });

  it('translates each phrase through t', () => {
    expect(formatPaxSummary({ adults: 2, children: 1, infants: 0 }, t)).toBe('2 adults, 1 child');
    expect(formatPaxSummary({ adults: 1, infants: 1, infantsSeated: 1 }, i18n)).toBe(
      '1 adult, 1 infant, 1 infant with seat'
    );
    const spy = spyT();
    expect(formatPaxSummary({ adults: 2, children: 1 }, spy)).toBe(
      '<common.paxCount.ADT>, <common.paxCount.CHD>'
    );
    expect(spy.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['common.paxCount.ADT', { count: 2 }],
      ['common.paxCount.CHD', { count: 1 }],
    ]);
  });

  it('rejects non-objects and bad counts', () => {
    expectInvalid(() => formatPaxSummary(null), 'pax', 'type');
    expectInvalid(() => formatPaxSummary(2), 'pax', 'type');
    expectInvalid(() => formatPaxSummary({ adults: -1 }), 'pax.adults', 'invalid_count');
    expectInvalid(
      () => formatPaxSummary({ adults: 1, children: 1.5 }),
      'pax.children',
      'invalid_count'
    );
    expectInvalid(() => formatPaxSummary({ adults: '2' }), 'pax.adults', 'invalid_count');
    expectInvalid(() => formatPaxSummary({ adults: 1 }, 'x'), 't', 'type');
  });
});

// ── formatFlightNumber / formatOperatedBy ────────────────────────────────────────────────────────

describe('formatFlightNumber', () => {
  it('joins the marketing carrier code and the number', () => {
    expect(formatFlightNumber(seg())).toBe('AI 101');
    expect(formatFlightNumber(seg({ flightNumber: 101 }))).toBe('AI 101');
    expect(
      formatFlightNumber(
        seg({ marketingCarrier: { code: '6E', name: 'IndiGo' }, flightNumber: '2041' })
      )
    ).toBe('6E 2041');
  });

  it('normalises numbers that already carry the carrier prefix', () => {
    expect(formatFlightNumber(seg({ flightNumber: 'AI101' }))).toBe('AI 101');
    expect(formatFlightNumber(seg({ flightNumber: ' ai 101 ' }))).toBe('AI 101');
    expect(formatFlightNumber(seg({ marketingCarrier: 'ai', flightNumber: 'AI101' }))).toBe(
      'AI 101'
    );
  });

  it('returns the bare number without a marketing carrier', () => {
    expect(formatFlightNumber({ flightNumber: '101' })).toBe('101');
    expect(formatFlightNumber({ flightNumber: 'ai101', marketingCarrier: {} })).toBe('AI101');
    expect(formatFlightNumber({ flightNumber: 'AI', marketingCarrier: AI })).toBe('AI');
  });

  it('rejects non-segments', () => {
    expectInvalid(() => formatFlightNumber(null), 'seg', 'type');
    expectInvalid(() => formatFlightNumber({ marketingCarrier: AI }), 'seg.flightNumber', 'type');
    expectInvalid(() => formatFlightNumber({ flightNumber: null }), 'seg.flightNumber', 'type');
  });

  it('rejects blank and non-integer flight numbers instead of rendering "AI NAN"', () => {
    for (const flightNumber of ['', '   ', NaN, Infinity, -1, 1.5, true, ['101'], {}]) {
      expectInvalid(() => formatFlightNumber(seg({ flightNumber })), 'seg.flightNumber', 'type');
      expectInvalid(() => formatFlightNumber({ flightNumber }), 'seg.flightNumber', 'type');
    }
    expect(formatFlightNumber(seg({ flightNumber: 0 }))).toBe('AI 0');
  });
});

describe('formatOperatedBy', () => {
  it('names the operating carrier only when it differs', () => {
    expect(formatOperatedBy(seg({ operatingCarrier: UK }))).toBe('Operated by Vistara');
    expect(formatOperatedBy(seg())).toBeNull();
    expect(
      formatOperatedBy(seg({ operatingCarrier: { code: 'AI', name: 'AIR INDIA LTD' } }))
    ).toBeNull();
  });

  it('compares by name when codes are missing and falls back to the code for the label', () => {
    expect(
      formatOperatedBy({
        marketingCarrier: { name: 'Air India' },
        operatingCarrier: { name: 'air india' },
      })
    ).toBeNull();
    expect(
      formatOperatedBy({
        marketingCarrier: { name: 'Air India' },
        operatingCarrier: { name: 'Vistara' },
      })
    ).toBe('Operated by Vistara');
    expect(formatOperatedBy(seg({ operatingCarrier: { code: 'UK' } }))).toBe('Operated by UK');
    expect(formatOperatedBy(seg({ marketingCarrier: 'AI', operatingCarrier: 'UK' }))).toBe(
      'Operated by UK'
    );
  });

  it('is null when either carrier is unknown', () => {
    expect(formatOperatedBy(seg({ operatingCarrier: undefined }))).toBeNull();
    expect(formatOperatedBy(seg({ operatingCarrier: {} }))).toBeNull();
    expect(formatOperatedBy({ operatingCarrier: UK, flightNumber: '101' })).toBeNull();
  });

  it('translates through t', () => {
    expect(formatOperatedBy(seg({ operatingCarrier: UK }), t)).toBe('Operated by Vistara');
    const spy = spyT((key, vars) => `[${key}:${vars.airline}]`);
    expect(formatOperatedBy(seg({ operatingCarrier: UK }), spy)).toBe(
      '[common.operatedBy:Vistara]'
    );
    expect(spy).toHaveBeenCalledWith(
      'common.operatedBy',
      { airline: 'Vistara' },
      { default: 'Operated by {airline}' }
    );
    expect(formatOperatedBy(seg(), spy)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects non-segments and bad translators', () => {
    expectInvalid(() => formatOperatedBy(null), 'seg', 'type');
    expectInvalid(() => formatOperatedBy(seg(), 'x'), 't', 'type');
  });
});

// ── enumeration labels ───────────────────────────────────────────────────────────────────────────

describe('formatCabin / formatFareType / formatPaxType', () => {
  it('renders the English labels', () => {
    expect(formatCabin('economy')).toBe('Economy');
    expect(formatCabin('premium_economy')).toBe('Premium economy');
    expect(formatCabin('business')).toBe('Business');
    expect(formatCabin('first')).toBe('First');
    expect(formatCabin('mixed')).toBe('Mixed cabins');
    expect(formatFareType('regular')).toBe('Regular');
    expect(formatFareType('student')).toBe('Student');
    expect(formatFareType('senior')).toBe('Senior citizen');
    expect(formatFareType('armed_forces')).toBe('Armed forces');
    expect(formatFareType('doctor')).toBe('Doctors and nurses');
    expect(formatFareType('corporate')).toBe('Corporate');
    expect(formatFareType('youth')).toBe('Youth');
    expect(formatPaxType('ADT')).toBe('Adult');
    expect(formatPaxType('CHD')).toBe('Child');
    expect(formatPaxType('INF')).toBe('Infant (on lap)');
    expect(formatPaxType('INS')).toBe('Infant (with seat)');
    expect(formatPaxType('YTH')).toBe('Youth');
    expect(formatPaxType('SRC')).toBe('Senior');
    expect(formatPaxType('STU')).toBe('Student');
  });

  it('agrees with the bundled English through i18n.t', () => {
    for (const cabin of ['economy', 'premium_economy', 'business', 'first', 'mixed']) {
      expect(formatCabin(cabin, t)).toBe(formatCabin(cabin));
    }
    for (const ft of [
      'regular',
      'student',
      'senior',
      'armed_forces',
      'doctor',
      'corporate',
      'youth',
    ]) {
      expect(formatFareType(ft, t)).toBe(formatFareType(ft));
    }
    for (const pt of ['ADT', 'CHD', 'INF', 'INS', 'YTH', 'SRC', 'STU']) {
      expect(formatPaxType(pt, i18n)).toBe(formatPaxType(pt));
    }
  });

  it('asks t with the documented keys and honours host overrides', () => {
    const spy = spyT();
    expect(formatCabin('business', spy)).toBe('<common.cabins.business>');
    expect(formatFareType('senior', spy)).toBe('<common.fareTypes.senior>');
    expect(formatPaxType('INF', spy)).toBe('<common.paxTypes.INF>');
    expect(spy.mock.calls[0]).toEqual(['common.cabins.business', {}, { default: 'Business' }]);
    const host = createI18n({ messages: { en: { common: { cabins: { business: 'Biz' } } } } });
    expect(formatCabin('business', host.t)).toBe('Biz');
    expect(formatCabin('first', host.t)).toBe('First');
  });

  it('humanises unknown values unless the host bundle knows them', () => {
    expect(formatCabin('premium_plus')).toBe('Premium plus');
    expect(formatCabin('premium_plus', t)).toBe('Premium plus');
    expect(formatFareType('defence-personnel')).toBe('Defence personnel');
    expect(formatPaxType('UNN')).toBe('Unn');
    const host = createI18n({
      messages: { en: { common: { paxTypes: { UNN: 'Unaccompanied minor' } } } },
    });
    expect(formatPaxType('UNN', host.t)).toBe('Unaccompanied minor');
    // a spy that reports the key as missing (returns the key) also falls back to the humanised value
    expect(formatCabin('premium_plus', (key) => key)).toBe('Premium plus');
  });

  it('rejects empty / non-string values and bad translators', () => {
    expectInvalid(() => formatCabin(''), 'cabin', 'type');
    expectInvalid(() => formatCabin(undefined), 'cabin', 'type');
    expectInvalid(() => formatFareType(1), 'ft', 'type');
    expectInvalid(() => formatPaxType(null), 'pt', 'type');
    expectInvalid(() => formatCabin('economy', 'en'), 't', 'type');
  });
});

// ── formatBaggage ────────────────────────────────────────────────────────────────────────────────

describe('formatBaggage', () => {
  it('renders pieces × weight, pieces, weight, or included / not included', () => {
    expect(formatBaggage({ quantity: 1, weightKg: 23, included: true })).toBe('1 × 23 kg');
    expect(formatBaggage({ quantity: 2, weightKg: 23, included: false })).toBe('2 × 23 kg');
    expect(formatBaggage({ quantity: 1, included: true })).toBe('1 piece');
    expect(formatBaggage({ quantity: 2, included: true })).toBe('2 pieces');
    expect(formatBaggage({ weightKg: 15, included: true })).toBe('15 kg');
    expect(formatBaggage({ weightKg: 7.5, included: true })).toBe('7.5 kg');
    expect(formatBaggage({ included: true })).toBe('Included');
    expect(formatBaggage({ included: false })).toBe('Not included');
    expect(formatBaggage({ quantity: 0, included: true })).toBe('Not included');
    expect(formatBaggage({})).toBe('Not included');
  });

  it('treats zero pieces as not included even when a weight is quoted', () => {
    expect(formatBaggage({ quantity: 0, weightKg: 23, included: true })).toBe('Not included');
    expect(formatBaggage({ quantity: 0, weightKg: 23, included: false })).toBe('Not included');
    expect(formatBaggage({ quantity: 0, weightKg: 23 }, t)).toBe('Not included');
    const spy = spyT();
    expect(formatBaggage({ quantity: 0, weightKg: 23 }, spy)).toBe('<common.baggage.notIncluded>');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      formatBaggage([
        { quantity: 0, weightKg: 23, included: true },
        { quantity: 1, weightKg: 7, included: true },
      ])
    ).toBe('Not included, 1 × 7 kg');
    // a zero weight does not cancel a piece allowance, and null means "unknown", not zero
    expect(formatBaggage({ quantity: 1, weightKg: 0, included: true })).toBe('1 piece');
    expect(formatBaggage({ quantity: null, weightKg: null, included: true })).toBe('Included');
  });

  it('joins a list of rules and treats an empty list as not included', () => {
    expect(
      formatBaggage([
        { quantity: 1, weightKg: 23, included: true },
        { quantity: 1, weightKg: 7, included: true },
      ])
    ).toBe('1 × 23 kg, 1 × 7 kg');
    expect(formatBaggage([])).toBe('Not included');
  });

  it('translates through t with the common.baggage keys', () => {
    expect(formatBaggage({ quantity: 1, weightKg: 23, included: true }, t)).toBe('1 × 23 kg');
    expect(formatBaggage({ quantity: 2, included: true }, t)).toBe('2 pieces');
    expect(formatBaggage({ included: false }, i18n)).toBe('Not included');
    expect(formatBaggage([], t)).toBe('Not included');
    const spy = spyT();
    expect(formatBaggage({ quantity: 1, weightKg: 23, included: true }, spy)).toBe(
      '1 × <common.baggage.weight>'
    );
    expect(spy).toHaveBeenCalledWith('common.baggage.weight', { kg: 23 }, { default: '{kg} kg' });
    expect(formatBaggage({ quantity: 3, included: true }, spy)).toBe('<common.baggage.pieces>');
    expect(spy).toHaveBeenLastCalledWith(
      'common.baggage.pieces',
      { count: 3 },
      { default: '{count, plural, one{# piece} other{# pieces}}' }
    );
    expect(formatBaggage({ included: true }, spy)).toBe('<common.baggage.included>');
    expect(formatBaggage({ included: false }, spy)).toBe('<common.baggage.notIncluded>');
  });

  it('rejects malformed rules', () => {
    expectInvalid(() => formatBaggage(null), 'rule', 'type');
    expectInvalid(() => formatBaggage('1x23'), 'rule', 'type');
    expectInvalid(() => formatBaggage({ quantity: -1 }), 'rule.quantity', 'invalid_count');
    expectInvalid(() => formatBaggage({ quantity: 1.5 }), 'rule.quantity', 'invalid_count');
    expectInvalid(() => formatBaggage({ weightKg: '23' }), 'rule.weightKg', 'invalid_weight');
    expectInvalid(() => formatBaggage({ weightKg: -3 }), 'rule.weightKg', 'invalid_weight');
    expectInvalid(() => formatBaggage([{ included: true }, 5]), 'rule[1]', 'type');
    expectInvalid(() => formatBaggage({ included: true }, 'x'), 't', 'type');
  });
});

// ── names ────────────────────────────────────────────────────────────────────────────────────────

describe('formatName', () => {
  it('renders given-first by default and family-first on request', () => {
    expect(formatName(traveler)).toBe('Rahul Kumar Sharma');
    expect(formatName(traveler, { order: 'given_first' })).toBe('Rahul Kumar Sharma');
    expect(formatName(traveler, { order: 'family_first' })).toBe('Sharma Rahul Kumar');
  });

  it('can drop the middle name and prefix the title', () => {
    expect(formatName(traveler, { middle: false })).toBe('Rahul Sharma');
    expect(formatName(traveler, { title: true })).toBe('Mr Rahul Kumar Sharma');
    expect(formatName(traveler, { title: true, middle: false, order: 'family_first' })).toBe(
      'Mr Sharma Rahul'
    );
  });

  it('cleans whitespace and skips missing parts', () => {
    expect(formatName({ firstName: '  Rahul  ', lastName: ' Sharma ' })).toBe('Rahul Sharma');
    expect(formatName({ firstName: 'Mary  Jane', lastName: 'Watson' })).toBe('Mary Jane Watson');
    expect(formatName({ firstName: 'Madonna' })).toBe('Madonna');
    expect(formatName({ lastName: 'Sharma' }, { order: 'family_first' })).toBe('Sharma');
    expect(formatName({ firstName: 'Rahul', lastName: 'Sharma', title: 42 }, { title: true })).toBe(
      'Rahul Sharma'
    );
    expect(formatName({})).toBe('');
    expect(formatName(traveler, null)).toBe('Rahul Kumar Sharma');
  });

  it('rejects non-objects and unknown orders', () => {
    expectInvalid(() => formatName(null), 'traveler', 'type');
    expectInvalid(() => formatName('Rahul Sharma'), 'traveler', 'type');
    expectInvalid(() => formatName(traveler, { order: 'surname' }), 'order', 'invalid_order');
  });
});

describe('initials', () => {
  it('takes the first letter of the first and last name', () => {
    expect(initials(traveler)).toBe('RS');
    expect(initials({ firstName: 'rahul', lastName: 'sharma' })).toBe('RS');
    expect(initials({ firstName: ' Jean-Luc ', lastName: 'Picard' })).toBe('JP');
    expect(initials({ firstName: 'Ólafur', lastName: 'Þór' })).toBe('ÓÞ');
    expect(initials({ firstName: '😀 Emoji', lastName: 'Name' })).toBe('😀N');
  });

  it('handles single or missing names', () => {
    expect(initials({ firstName: 'Madonna' })).toBe('M');
    expect(initials({ lastName: 'Sharma' })).toBe('S');
    expect(initials({})).toBe('');
    expect(initials({ firstName: '   ' })).toBe('');
  });

  it('rejects non-objects', () => {
    expectInvalid(() => initials(null), 'traveler', 'type');
    expectInvalid(() => initials('RS'), 'traveler', 'type');
  });
});

// ── masks ────────────────────────────────────────────────────────────────────────────────────────

describe('maskEmail', () => {
  it('keeps the first character and the domain only', () => {
    expect(maskEmail('rahul.sharma@example.com')).toBe('r***@example.com');
    expect(maskEmail('R@example.com')).toBe('R***@example.com');
    expect(maskEmail('  rahul@example.com ')).toBe('r***@example.com');
    expect(maskEmail('a@b@example.com')).toBe('a***@example.com');
    expect(maskEmail('@example.com')).toBe('***@example.com');
  });

  it('never leaks the rest of the local part', () => {
    const masked = maskEmail('rahul.sharma@example.com');
    expect(masked).not.toContain('ahul');
    expect(masked).not.toContain('sharma');
    expect(masked).toMatch(/^.\*\*\*@/);
  });

  it('handles values without a domain and empty input', () => {
    expect(maskEmail('rahul')).toBe('r***');
    expect(maskEmail('rahul@')).toBe('r***@');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('   ')).toBe('');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
  });

  it('rejects non-strings', () => {
    expectInvalid(() => maskEmail(42), 'e', 'type');
    expectInvalid(() => maskEmail({ email: 'x@y.z' }), 'e', 'type');
  });
});

describe('maskPhone', () => {
  it('shows the last 4 digits of a Phone object with its country code', () => {
    expect(maskPhone({ countryCode: '91', number: '9876543210' })).toBe('+91 ••••••3210');
    expect(maskPhone({ countryCode: '+91', number: '98765 43210' })).toBe('+91 ••••••3210');
    expect(maskPhone({ countryCode: '1', number: '(415) 555-2671' })).toBe('+1 ••••••2671');
    expect(maskPhone({ countryCode: 44, number: 7700900123 })).toBe('+44 ••••••0123');
    expect(maskPhone({ number: '9876543210' })).toBe('••••••3210');
  });

  it('shows 2-4 digits depending on length, never more than half', () => {
    expect(maskPhone('9876543210')).toBe('••••••3210');
    expect(maskPhone('98765432')).toBe('••••5432');
    expect(maskPhone('9876543')).toBe('••••543');
    expect(maskPhone('987654')).toBe('•••654');
    expect(maskPhone('98765')).toBe('•••65');
    expect(maskPhone('9876')).toBe('••76');
    expect(maskPhone('987')).toBe('••7');
    expect(maskPhone('98')).toBe('•8');
    expect(maskPhone('9')).toBe('•');
  });

  it('masks strings, keeping only a leading +', () => {
    expect(maskPhone('+91 98765 43210')).toBe('+••••••••3210');
    expect(maskPhone('0091-98765-43210')).toBe('••••••••••3210');
    expect(maskPhone('+91 98765 43210')).not.toContain('98765');
  });

  it('returns an empty string without digits or input', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone('abc')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
    expect(maskPhone({ countryCode: '91' })).toBe('');
    expect(maskPhone({ countryCode: '91', number: '' })).toBe('');
  });

  it('rejects unsupported shapes', () => {
    expectInvalid(() => maskPhone(9876543210), 'p', 'type');
    expectInvalid(() => maskPhone(['91', '9876543210']), 'p', 'type');
    expectInvalid(() => maskPhone({ countryCode: '91', number: {} }), 'p.number', 'type');
    expectInvalid(() => maskPhone({ countryCode: '91', number: true }), 'p.number', 'type');
    expectInvalid(
      () => maskPhone({ countryCode: {}, number: '9876543210' }),
      'p.countryCode',
      'type'
    );
    expectInvalid(
      () => maskPhone({ countryCode: true, number: '9876543210' }),
      'p.countryCode',
      'type'
    );
    // a null country code is simply absent
    expect(maskPhone({ countryCode: null, number: '9876543210' })).toBe('••••••3210');
  });
});

describe('maskCard', () => {
  it('renders brand •••• last4', () => {
    expect(maskCard('4242', 'visa')).toBe('Visa •••• 4242');
    expect(maskCard('4444', 'mastercard')).toBe('Mastercard •••• 4444');
    expect(maskCard('0005', 'amex')).toBe('American Express •••• 0005');
    expect(maskCard('1234', 'rupay')).toBe('RuPay •••• 1234');
    expect(maskCard('1117', 'discover')).toBe('Discover •••• 1117');
    expect(maskCard('3237', 'diners')).toBe('Diners Club •••• 3237');
    expect(maskCard('0000', 'jcb')).toBe('JCB •••• 0000');
    expect(maskCard('4242', 'VISA')).toBe('Visa •••• 4242');
    expect(maskCard(4242, 'visa')).toBe('Visa •••• 4242');
  });

  it('drops the label for a missing or unknown brand and humanises others', () => {
    expect(maskCard('4242')).toBe('•••• 4242');
    expect(maskCard('4242', 'unknown')).toBe('•••• 4242');
    expect(maskCard('4242', '')).toBe('•••• 4242');
    expect(maskCard('4242', null)).toBe('•••• 4242');
    expect(maskCard('4242', 'cartes_bancaires')).toBe('Cartes bancaires •••• 4242');
  });

  it('does not resolve brands through Object.prototype', () => {
    expect(maskCard('4242', 'constructor')).toBe('Constructor •••• 4242');
    expect(maskCard('4242', 'toString')).toBe('Tostring •••• 4242');
    expect(maskCard('4242', 'hasOwnProperty')).toBe('Hasownproperty •••• 4242');
    expect(maskCard('4242', '__proto__')).toBe('Proto •••• 4242');
    for (const brand of ['constructor', 'valueOf', '__proto__', 'toString']) {
      expect(maskCard('4242', brand)).not.toMatch(/function|native code|object Object/);
    }
  });

  it('never reveals more than the last four digits', () => {
    expect(maskCard('4242424242424242', 'visa')).toBe('Visa •••• 4242');
    expect(maskCard('4111 1111 1111 1111', 'visa')).toBe('Visa •••• 1111');
    expect(maskCard('•••• 4242', 'visa')).toBe('Visa •••• 4242');
    expect(maskCard('42', 'visa')).toBe('Visa •••• 42');
    expect(maskCard('', 'visa')).toBe('Visa ••••');
    expect(maskCard(null)).toBe('••••');
    expect(maskCard(undefined, 'visa')).toBe('Visa ••••');
  });

  it('accepts a SavedMethod-like object', () => {
    expect(maskCard({ brand: 'visa', last4: '4242' })).toBe('Visa •••• 4242');
    expect(maskCard({ brand: 'visa', last4: '4242' }, 'rupay')).toBe('RuPay •••• 4242');
    expect(maskCard({ last4: '4242' })).toBe('•••• 4242');
    expect(maskCard({})).toBe('••••');
  });

  it('rejects wrong types', () => {
    expectInvalid(() => maskCard(['4242']), 'last4', 'type');
    expectInvalid(() => maskCard(true), 'last4', 'type');
    expectInvalid(() => maskCard('4242', 7), 'brand', 'type');
  });
});

describe('maskDocument', () => {
  it('shows only the last 3 characters', () => {
    expect(maskDocument('A1234567')).toBe('•••••567');
    expect(maskDocument('ABCDE1234F')).toBe('•••••••34F');
    expect(maskDocument('N 1234567')).toBe('•••••567');
    expect(maskDocument('  X98765432  ')).toBe('••••••432');
  });

  it('shows less for short values (never more than half)', () => {
    expect(maskDocument('123456')).toBe('•••456');
    expect(maskDocument('12345')).toBe('•••45');
    expect(maskDocument('1234')).toBe('••34');
    expect(maskDocument('123')).toBe('••3');
    expect(maskDocument('12')).toBe('•2');
    expect(maskDocument('1')).toBe('•');
  });

  it('handles empty input and rejects non-strings', () => {
    expect(maskDocument('')).toBe('');
    expect(maskDocument(null)).toBe('');
    expect(maskDocument(undefined)).toBe('');
    expectInvalid(() => maskDocument(12345678), 'number', 'type');
    expectInvalid(() => maskDocument({ number: 'A1234567' }), 'number', 'type');
  });
});

// ── small string helpers ─────────────────────────────────────────────────────────────────────────

describe('formatReference', () => {
  it('upper-cases and trims', () => {
    expect(formatReference('abc123')).toBe('ABC123');
    expect(formatReference('  wf7k2q9m ')).toBe('WF7K2Q9M');
    expect(formatReference('ab  c 123')).toBe('AB C 123');
    expect(formatReference(123456)).toBe('123456');
    expect(formatReference('')).toBe('');
    expect(formatReference(null)).toBe('');
    expect(formatReference(undefined)).toBe('');
  });

  it('rejects other types', () => {
    expectInvalid(() => formatReference({ reference: 'ABC123' }), 'ref', 'type');
    expectInvalid(() => formatReference(['ABC123']), 'ref', 'type');
    expectInvalid(() => formatReference(NaN), 'ref', 'type');
    expectInvalid(() => formatReference(Infinity), 'ref', 'type');
    expectInvalid(() => formatReference(true), 'ref', 'type');
  });
});

describe('formatSeat', () => {
  it('renders Seat objects, row/column pairs and bare labels', () => {
    expect(formatSeat({ number: '12A', available: true, characteristics: [] })).toBe('12A');
    expect(formatSeat({ number: '12 a' })).toBe('12A');
    expect(formatSeat({ row: 12, column: 'a' })).toBe('12A');
    expect(formatSeat({ row: '7', letter: 'F' })).toBe('7F');
    expect(formatSeat('12a')).toBe('12A');
    expect(formatSeat(' 12 A ')).toBe('12A');
    expect(formatSeat(14)).toBe('14');
    expect(formatSeat(null)).toBe('');
    expect(formatSeat(undefined)).toBe('');
  });

  it('rejects unsupported shapes', () => {
    expectInvalid(() => formatSeat({}), 'seat', 'type');
    expectInvalid(() => formatSeat({ row: 12 }), 'seat', 'type');
    expectInvalid(() => formatSeat({ row: 12, column: '' }), 'seat', 'type');
    expectInvalid(() => formatSeat({ column: 'A' }), 'seat', 'type');
    expectInvalid(() => formatSeat(['12A']), 'seat', 'type');
    expectInvalid(() => formatSeat(true), 'seat', 'type');
    expectInvalid(() => formatSeat(NaN), 'seat', 'type');
  });

  it('never stringifies nested objects or booleans and never recurses into them', () => {
    const cyclic = {};
    cyclic.number = cyclic;
    expectInvalid(() => formatSeat(cyclic), 'seat.number', 'type');
    expectInvalid(() => formatSeat({ number: { row: 12, column: 'A' } }), 'seat.number', 'type');
    expectInvalid(() => formatSeat({ number: true }), 'seat.number', 'type');
    expectInvalid(() => formatSeat({ number: NaN }), 'seat.number', 'type');
    expectInvalid(() => formatSeat({ row: true, column: 'A' }), 'seat.row', 'type');
    expectInvalid(() => formatSeat({ row: 12, column: { a: 1 } }), 'seat.column', 'type');
    expectInvalid(() => formatSeat({ row: 12, letter: ['A'] }), 'seat.letter', 'type');
    expect(() => formatSeat(cyclic)).not.toThrow(RangeError);
  });
});

describe('titleCase', () => {
  it('capitalises each word', () => {
    expect(titleCase('INDIRA GANDHI INTL')).toBe('Indira Gandhi Intl');
    expect(titleCase('chhatrapati shivaji maharaj')).toBe('Chhatrapati Shivaji Maharaj');
    expect(titleCase('mIxEd CaSe')).toBe('Mixed Case');
    expect(titleCase('SAINT-DENIS/PARIS (CDG)')).toBe('Saint-Denis/Paris (Cdg)');
    expect(titleCase("CHICAGO O'HARE")).toBe("Chicago O'Hare");
    expect(titleCase("DON'T")).toBe("Don't");
    expect(titleCase('ÉCOLE élémentaire')).toBe('École Élémentaire');
    expect(titleCase('  two  spaces ')).toBe('  Two  Spaces ');
    expect(titleCase('')).toBe('');
    expect(titleCase(null)).toBe('');
    expect(titleCase(undefined)).toBe('');
  });

  it('rejects non-strings', () => {
    expectInvalid(() => titleCase(42), 's', 'type');
  });
});

describe('truncate', () => {
  it('cuts to n characters including the ellipsis', () => {
    expect(truncate('Indira Gandhi International', 14)).toBe('Indira Gandhi…');
    expect(truncate('Indira Gandhi International', 15)).toBe('Indira Gandhi…');
    expect(truncate('Indira Gandhi International', 16)).toBe('Indira Gandhi I…');
    expect(truncate('Delhi', 5)).toBe('Delhi');
    expect(truncate('Delhi', 10)).toBe('Delhi');
    expect(truncate('Delhi', 4)).toBe('Del…');
    expect(truncate('Delhi', 1)).toBe('…');
    expect(truncate('Delhi', 0)).toBe('');
    expect(truncate('', 3)).toBe('');
    expect(truncate(null, 3)).toBe('');
    expect(truncate(undefined, 3)).toBe('');
  });

  it('counts code points and supports a custom ellipsis', () => {
    expect(truncate('😀😀😀😀', 3)).toBe('😀😀…');
    expect(truncate('Indira Gandhi International', 16, '...')).toBe('Indira Gandhi...');
    expect(truncate('Indira Gandhi International', 2, '...')).toBe('..');
    expect(truncate('Indira Gandhi International', 10, '')).toBe('Indira Gan');
    for (const len of [0, 1, 2, 5, 13, 14, 20]) {
      expect(Array.from(truncate('Indira Gandhi International', len)).length).toBeLessThanOrEqual(
        len
      );
    }
  });

  it('rejects bad arguments', () => {
    expectInvalid(() => truncate(42, 3), 's', 'type');
    expectInvalid(() => truncate('Delhi', -1), 'n', 'invalid_length');
    expectInvalid(() => truncate('Delhi', 2.5), 'n', 'invalid_length');
    expectInvalid(() => truncate('Delhi'), 'n', 'invalid_length');
    expectInvalid(() => truncate('Delhi', 3, 7), 'ellipsis', 'type');
  });
});
