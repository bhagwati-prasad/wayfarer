import { describe, it, expect, vi, afterEach } from 'vitest';
import * as validation from '../../src/utils/validation.js';
import {
  validate,
  schemas,
  isEmail,
  isPhone,
  isIata,
  isPostalCode,
  isPassportNumber,
  isGstin,
  isPan,
  isVpa,
  isLuhn,
  isNameValid,
  namesFitTicket,
  documentValid,
  paxCountsValid,
  travelerMatchesSlot,
  cardBrand,
  cardExpiryValid,
  issuesByPath,
  firstIssue,
} from '../../src/utils/validation.js';
import { ValidationError } from '../../src/errors/index.js';

const TODAY = '2026-10-17';
const CTX = { today: TODAY };
const TRAVEL = '2026-11-02';

// Luhn-valid sample numbers (generated, not real cards).
const VISA = '4000000000000002';
const MASTERCARD = '5100000000000008';
const AMEX = '340000000000009';
const RUPAY = '6521000000000007';
const DISCOVER = '6011000000000004';

/** Shorthand: `[path, code]` pairs of a result or issue list. */
const codes = (r) => (Array.isArray(r) ? r : r.issues).map((i) => [i.path, i.code]);

/** Expect `fn` to throw a `ValidationError` whose first issue has `path` / `code`. */
function expectThrows(fn, path, code) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect(caught).toBeInstanceOf(Error);
  expect(caught.constructor).not.toBe(Error);
  expect(caught.code).toBe('VALIDATION_FAILED');
  expect(caught.issues[0].path).toBe(path);
  if (code) expect(caught.issues[0].code).toBe(code);
  return caught;
}

const validSearch = () => ({
  tripType: 'round_trip',
  slices: [
    { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
    { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
  ],
  passengers: { adults: 2, children: 1, infants: 1, childAges: [6] },
  cabin: 'economy',
});

const requirements = () => ({
  perType: {
    ADT: { fields: [], documents: [{ types: ['passport'], required: true, minValidityMonths: 6 }] },
    CHD: { fields: [], documents: [] },
  },
  contact: [],
  apis: true,
  gstAvailable: true,
  ageRules: { infantMax: 2, childMax: 12, refDate: 'departure', infantPerAdult: 1, maxPax: 9 },
  nameRules: { maxLength: 40, charset: 'latin' },
});

const validTraveler = () => ({
  type: 'ADT',
  title: 'Mr',
  firstName: 'Arjun',
  lastName: 'Mehta',
  gender: 'M',
  dob: '1990-05-14',
  nationality: 'IN',
  documents: [
    {
      type: 'passport',
      number: 'A1234567',
      issuingCountry: 'IN',
      expiry: '2030-01-01',
      issueDate: '2020-01-01',
    },
  ],
  email: 'arjun@example.com',
  phone: { countryCode: '+91', number: '98765 43210' },
});

const validContact = () => ({
  email: 'contact@example.com',
  phone: { countryCode: '+91', number: '9876543210' },
  emergency: { name: 'Priya Mehta', phone: { countryCode: '+91', number: '9123456780' } },
  address: {
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'KA',
    postalCode: '560001',
    countryCode: 'IN',
  },
  gst: { number: '27AAPFU0939F1ZV', company: 'Acme Travels Pvt Ltd' },
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── module surface ───────────────────────────────────────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(validation).sort()).toEqual(
      [
        'validate',
        'schemas',
        'isEmail',
        'isPhone',
        'isIata',
        'isPostalCode',
        'isPassportNumber',
        'isGstin',
        'isPan',
        'isVpa',
        'isLuhn',
        'isNameValid',
        'namesFitTicket',
        'documentValid',
        'paxCountsValid',
        'travelerMatchesSlot',
        'cardBrand',
        'cardExpiryValid',
        'issuesByPath',
        'firstIssue',
      ].sort()
    );
    expect(Object.isFrozen(schemas)).toBe(true);
    expect(Object.keys(schemas).sort()).toEqual(
      [
        'searchParams',
        'traveler',
        'contact',
        'document',
        'gst',
        'address',
        'promo',
        'card',
        'password',
      ].sort()
    );
    for (const factory of Object.values(schemas)) expect(typeof factory).toBe('function');
  });

  it('factories return fresh schema objects every call', () => {
    expect(schemas.card()).not.toBe(schemas.card());
    expect(schemas.searchParams()).not.toBe(schemas.searchParams());
  });
});

// ── validate: schema runner ──────────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('returns { valid, issues } and never mutates the value or the schema', () => {
    const value = { a: 1, list: [{ b: 'x' }] };
    const snapshot = JSON.stringify(value);
    const schema = Object.freeze({
      props: Object.freeze({ a: Object.freeze({ required: true, type: 'number' }) }),
    });
    expect(validate(schema, value)).toEqual({ valid: true, issues: [] });
    expect(validate({}, undefined)).toEqual({ valid: true, issues: [] });
    expect(validate([], null)).toEqual({ valid: true, issues: [] });
    expect(JSON.stringify(value)).toBe(snapshot);
  });

  it('required flags undefined, null, blank strings and empty arrays; optional empties skip every other check', () => {
    const req = { required: true, type: 'string', minLength: 3 };
    for (const v of [undefined, null, '', '   ', []]) {
      const r = validate(req, v);
      expect(r.valid).toBe(false);
      expect(r.issues).toEqual([{ path: '', code: 'required', message: 'validation.required' }]);
    }
    const opt = { type: 'string', minLength: 3, pattern: /x/, custom: () => 'never' };
    for (const v of [undefined, null, '', '  ', []]) expect(validate(opt, v).valid).toBe(true);
    expect(validate({ required: true }, 0).valid).toBe(true);
    expect(validate({ required: true }, false).valid).toBe(true);
  });

  it('checks structural types, uses code "date" for dates and stops after a type failure', () => {
    const cases = [
      ['string', 'x', 1],
      ['number', 1.5, '1'],
      ['number', 2, NaN],
      ['integer', 3, 3.5],
      ['boolean', false, 'false'],
      ['object', { a: 1 }, [1]],
      ['array', [1], { 0: 1 }],
      ['date', '2026-02-28', '2026-02-30'],
      ['date', '2024-02-29', '2023-02-29'],
      ['date', '2026-10-17', '17-10-2026'],
    ];
    for (const [type, good, bad] of cases) {
      expect(validate({ type }, good).valid).toBe(true);
      const r = validate({ type }, bad);
      expect(r.valid).toBe(false);
      expect(r.issues[0].code).toBe(type === 'date' ? 'date' : 'type');
      if (type !== 'date')
        expect(r.issues[0].params).toEqual({ expected: type, actual: expect.any(String) });
    }
    const r = validate({ type: 'string', minLength: 5, custom: () => 'custom' }, 42);
    expect(codes(r)).toEqual([['', 'type']]);
  });

  it('matches patterns given as RegExp or string, on strings and numbers only', () => {
    expect(validate({ pattern: /^[a-z]+$/ }, 'abc').valid).toBe(true);
    expect(validate({ pattern: '^[a-z]+$' }, 'abc').valid).toBe(true);
    expect(validate({ pattern: /^\d+$/ }, 123).valid).toBe(true);
    const r = validate({ pattern: /^[a-z]+$/ }, 'ABC');
    expect(r.issues).toEqual([
      { path: '', code: 'pattern', message: 'validation.pattern', params: { pattern: '^[a-z]+$' } },
    ]);
    expect(codes(validate({ pattern: /x/ }, { x: 1 }))).toEqual([['', 'pattern']]);
    const global = { pattern: /^ab$/g };
    expect(validate(global, 'ab').valid).toBe(true);
    expect(validate(global, 'ab').valid).toBe(true);
    expect(validate(global, 'ab').valid).toBe(true);
  });

  it('applies inclusive min / max to numbers and to YYYY-MM-DD dates', () => {
    expect(validate({ min: 1, max: 3 }, 1).valid).toBe(true);
    expect(validate({ min: 1, max: 3 }, 3).valid).toBe(true);
    expect(validate({ min: 1, max: 3 }, 0).issues).toEqual([
      { path: '', code: 'min', message: 'validation.min', params: { min: 1 } },
    ]);
    expect(validate({ min: 1, max: 3 }, 4).issues).toEqual([
      { path: '', code: 'max', message: 'validation.max', params: { max: 3 } },
    ]);
    const dates = { type: 'date', min: '2026-01-01', max: '2026-12-31' };
    expect(validate(dates, '2026-06-15').valid).toBe(true);
    expect(codes(validate(dates, '2025-12-31'))).toEqual([['', 'min']]);
    expect(codes(validate(dates, '2027-01-01'))).toEqual([['', 'max']]);
    // incomparable pairs are ignored rather than flagged
    expect(validate({ min: 5 }, 'abc').valid).toBe(true);
    expect(validate({ max: '2026-01-01' }, 7).valid).toBe(true);
  });

  it('applies minLength / maxLength to strings and arrays', () => {
    expect(validate({ minLength: 2, maxLength: 3 }, 'ab').valid).toBe(true);
    expect(validate({ minLength: 2, maxLength: 3 }, 'a').issues).toEqual([
      {
        path: '',
        code: 'minLength',
        message: 'validation.minLength',
        params: { min: 2, length: 1 },
      },
    ]);
    expect(validate({ minLength: 2, maxLength: 3 }, 'abcd').issues).toEqual([
      {
        path: '',
        code: 'maxLength',
        message: 'validation.maxLength',
        params: { max: 3, length: 4 },
      },
    ]);
    expect(codes(validate({ maxLength: 1 }, [1, 2]))).toEqual([['', 'maxLength']]);
    expect(codes(validate({ minLength: 2 }, [1]))).toEqual([['', 'minLength']]);
    expect(validate({ minLength: 2 }, 12345).valid).toBe(true);
  });

  it('checks enum membership with strict equality', () => {
    const rule = { enum: ['a', 1, null] };
    expect(validate(rule, 'a').valid).toBe(true);
    expect(validate(rule, 1).valid).toBe(true);
    expect(validate(rule, '1').issues).toEqual([
      { path: '', code: 'enum', message: 'validation.enum', params: { values: ['a', 1, null] } },
    ]);
  });

  it('turns custom results into issues (false, string, object with relative path, arrays)', () => {
    expect(validate({ custom: () => true }, 'x').valid).toBe(true);
    expect(validate({ custom: () => null }, 'x').valid).toBe(true);
    expect(validate({ custom: () => undefined }, 'x').valid).toBe(true);
    expect(validate({ custom: () => [] }, 'x').valid).toBe(true);
    expect(validate({ custom: () => false }, 'x').issues).toEqual([
      { path: '', code: 'invalid', message: 'validation.invalid' },
    ]);
    expect(validate({ custom: () => 'email' }, 'x').issues).toEqual([
      { path: '', code: 'email', message: 'validation.email' },
    ]);
    const nested = {
      props: {
        pair: {
          custom: () => [
            { path: 'b', code: 'dateOrder', params: { min: 1 } },
            'sameAirport',
            { code: 'x', message: 'custom.message' },
            {},
          ],
        },
      },
    };
    expect(validate(nested, { pair: { a: 1, b: 0 } }).issues).toEqual([
      { path: 'pair.b', code: 'dateOrder', message: 'validation.dateOrder', params: { min: 1 } },
      { path: 'pair', code: 'sameAirport', message: 'validation.sameAirport' },
      { path: 'pair', code: 'x', message: 'custom.message' },
      { path: 'pair', code: 'invalid', message: 'validation.invalid' },
    ]);
  });

  it('runs custom only when the node itself passed, receiving value and info', () => {
    const custom = vi.fn(() => 'nope');
    expect(codes(validate({ pattern: /^a$/, custom }, 'b'))).toEqual([['', 'pattern']]);
    expect(custom).not.toHaveBeenCalled();
    // child failures do not block a parent-level custom (cross-field) check
    const parentCustom = vi.fn(() => ({ path: 'a', code: 'cross' }));
    const r = validate(
      { props: { a: { type: 'number' }, b: { type: 'number' } }, custom: parentCustom },
      { a: 1, b: 'x' },
      { today: TODAY, extra: 42 }
    );
    expect(codes(r)).toEqual([
      ['b', 'type'],
      ['a', 'cross'],
    ]);
    const [value, info] = parentCustom.mock.calls[0];
    expect(value).toEqual({ a: 1, b: 'x' });
    expect(info.path).toBe('');
    expect(info.root).toBe(value);
    expect(info.parent).toBe(value);
    expect(info.ctx).toEqual({ today: TODAY, extra: 42 });
  });

  it('skips a rule (including required) when its when-predicate is false and passes the parent', () => {
    const when = vi.fn((parent) => parent.kind === 'strict');
    const schema = { props: { kind: {}, value: { when, required: true, min: 10 } } };
    expect(validate(schema, { kind: 'loose' }).valid).toBe(true);
    expect(validate(schema, { kind: 'loose', value: 1 }).valid).toBe(true);
    expect(codes(validate(schema, { kind: 'strict' }))).toEqual([['value', 'required']]);
    expect(codes(validate(schema, { kind: 'strict', value: 1 }))).toEqual([['value', 'min']]);
    expect(when.mock.calls[0][0]).toEqual({ kind: 'loose' });
    expect(when.mock.calls[0][1]).toMatchObject({ path: 'value', value: undefined });
    // at the top level the parent is the root value itself
    const top = { when: (p) => p.enabled, props: { x: { required: true } } };
    expect(validate(top, { enabled: false }).valid).toBe(true);
    expect(codes(validate(top, { enabled: true }))).toEqual([['x', 'required']]);
  });

  it('validates array items at path[i] and flags non-arrays', () => {
    const schema = { items: { type: 'integer', min: 0 } };
    expect(validate(schema, [1, 2, 3]).valid).toBe(true);
    expect(codes(validate(schema, [1, -1, 'x']))).toEqual([
      ['[1]', 'min'],
      ['[2]', 'type'],
    ]);
    expect(codes(validate({ props: { list: schema } }, { list: 'nope' }))).toEqual([
      ['list', 'type'],
    ]);
    expect(validate({ props: { list: schema } }, { list: 'nope' }).issues[0].params).toEqual({
      expected: 'array',
      actual: 'string',
    });
  });

  it('validates nested props with dotted paths, ignores unknown keys and flags non-objects', () => {
    const schema = {
      props: {
        contact: {
          props: {
            email: { required: true },
            phones: { items: { props: { number: { required: true } } } },
          },
        },
      },
    };
    expect(validate(schema, { contact: { email: 'a@b.co', extra: 1 }, unknown: true }).valid).toBe(
      true
    );
    expect(codes(validate(schema, { contact: { phones: [{ number: '1' }, {}] } }))).toEqual([
      ['contact.email', 'required'],
      ['contact.phones[1].number', 'required'],
    ]);
    expect(codes(validate(schema, { contact: 'x' }))).toEqual([['contact', 'type']]);
  });

  it('applies rule lists in order and collapses duplicate path + code pairs', () => {
    const schema = {
      props: {
        tripType: {},
        slices: [
          { required: true, type: 'array', maxLength: 6 },
          { when: (p) => p.tripType === 'one_way', maxLength: 1 },
          { when: (p) => p.tripType === 'round_trip', minLength: 2, maxLength: 2 },
        ],
      },
    };
    expect(validate(schema, { tripType: 'one_way', slices: [1] }).valid).toBe(true);
    expect(validate(schema, { tripType: 'round_trip', slices: [1, 2] }).valid).toBe(true);
    expect(validate(schema, { tripType: 'one_way', slices: [1, 2] }).issues).toEqual([
      {
        path: 'slices',
        code: 'maxLength',
        message: 'validation.maxLength',
        params: { max: 1, length: 2 },
      },
    ]);
    expect(codes(validate(schema, { tripType: 'round_trip', slices: [1] }))).toEqual([
      ['slices', 'minLength'],
    ]);
    expect(codes(validate(schema, { tripType: 'round_trip' }))).toEqual([['slices', 'required']]);
    // seven slices on a one-way: two maxLength failures, one issue
    expect(codes(validate(schema, { tripType: 'one_way', slices: [1, 2, 3, 4, 5, 6, 7] }))).toEqual(
      [['slices', 'maxLength']]
    );
    expect(codes(validate([{ required: true }, { required: true }], undefined))).toEqual([
      ['', 'required'],
    ]);
  });

  it('prefixes every path with ctx.path', () => {
    const r = validate(
      { props: { dob: { required: true }, docs: { items: { required: true } } } },
      { docs: [null] },
      { path: 'travelers[0]' }
    );
    expect(codes(r)).toEqual([
      ['travelers[0].dob', 'required'],
      ['travelers[0].docs[0]', 'required'],
    ]);
    expect(codes(validate({ required: true }, undefined, { path: 'promo' }))).toEqual([
      ['promo', 'required'],
    ]);
  });

  it('uses i18n keys, never prose, as messages', () => {
    const r = validate(
      { props: { a: { required: true }, b: { type: 'date' }, c: { enum: [1] } } },
      { b: 'x', c: 2 }
    );
    for (const it of r.issues) {
      expect(it.message).toBe(`validation.${it.code}`);
      expect(it.message).not.toMatch(/\s/);
    }
  });

  it('throws ValidationError (never a plain Error) for a malformed schema', () => {
    expectThrows(() => validate(null, 1), 'schema', 'invalid_schema');
    expectThrows(() => validate('x', 1), 'schema', 'invalid_schema');
    expectThrows(() => validate({ type: 'email' }, 'a@b.co'), 'schema', 'invalid_schema');
    expectThrows(() => validate({ pattern: 42 }, 'x'), 'schema', 'invalid_schema');
    expectThrows(() => validate({ pattern: '(' }, 'x'), 'schema', 'invalid_schema');
    expectThrows(() => validate({ custom: 'fn' }, 'x'), 'schema', 'invalid_schema');
    expectThrows(() => validate({ when: true }, 'x'), 'schema', 'invalid_schema');
    expectThrows(() => validate({ enum: 'abc' }, 'x'), 'schema', 'invalid_schema');
    expectThrows(() => validate({ props: [] }, {}), 'schema', 'invalid_schema');
    expectThrows(
      () => validate({ props: { a: { props: { b: 'bad' } } } }, { a: { b: 1 } }),
      'schema.a.b',
      'invalid_schema'
    );
    // the value never throws, whatever it is
    for (const v of [undefined, null, 0, 'x', [], {}, () => {}, Symbol('s'), 10n]) {
      expect(() => validate({ required: true, type: 'string', props: {} }, v)).not.toThrow();
    }
  });
});

// ── validators ───────────────────────────────────────────────────────────────────────────────────

describe('isEmail', () => {
  it('accepts practical addresses and ignores surrounding whitespace', () => {
    for (const v of [
      'a@b.co',
      'first.last@example.com',
      'user+tag@sub.example.co.in',
      "o'neil@example.org",
      '  padded@example.com ',
      'x_y-z@example-domain.com',
    ]) {
      expect(isEmail(v), v).toBe(true);
    }
  });

  it('rejects malformed addresses and non-strings', () => {
    for (const v of [
      '',
      'plain',
      '@example.com',
      'a@',
      'a@b',
      'a@.com',
      'a@b..com',
      '.a@b.com',
      'a.@b.com',
      'a..b@c.com',
      'a@b.c',
      'a b@c.com',
      'a@b.com.',
      'a@-b.com',
      `${'x'.repeat(65)}@example.com`,
      `a@${'b'.repeat(250)}.com`,
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isEmail(v), String(v)).toBe(false);
    }
  });
});

describe('isPhone', () => {
  it('accepts E.164-compatible { countryCode, number } pairs, with or without separators', () => {
    expect(isPhone({ countryCode: '+91', number: '9876543210' })).toBe(true);
    expect(isPhone({ countryCode: '91', number: '98765 43210' })).toBe(true);
    expect(isPhone({ countryCode: '+1', number: '(212) 555-0123' })).toBe(true);
    expect(isPhone({ countryCode: '+44', number: '7700.900123' })).toBe(true);
    expect(isPhone({ countryCode: '+39', number: '0612345678' })).toBe(true);
    expect(isPhone({ countryCode: 971, number: 501234567 })).toBe(true);
    expect(isPhone({ countryCode: '+683', number: '1234' })).toBe(true);
  });

  it('rejects bad dial codes, too short / long numbers, letters and non-objects', () => {
    expect(isPhone({ countryCode: '+091', number: '9876543210' })).toBe(false);
    expect(isPhone({ countryCode: '+9123', number: '9876543210' })).toBe(false);
    expect(isPhone({ countryCode: '', number: '9876543210' })).toBe(false);
    expect(isPhone({ countryCode: '+91', number: '123' })).toBe(false);
    expect(isPhone({ countryCode: '+91', number: '98765432101234' })).toBe(false);
    expect(isPhone({ countryCode: '+1', number: '555-CALL' })).toBe(false);
    expect(isPhone({ countryCode: '+1', number: '' })).toBe(false);
    expect(isPhone({ countryCode: '+1' })).toBe(false);
    expect(isPhone({ countryCode: '+683', number: '123' })).toBe(false);
    expect(isPhone(null)).toBe(false);
    expect(isPhone(undefined)).toBe(false);
    expect(isPhone(9876543210)).toBe(false);
    expect(isPhone([])).toBe(false);
  });

  it('also accepts a full +E.164 string', () => {
    expect(isPhone('+919876543210')).toBe(true);
    expect(isPhone('+1 212 555 0123')).toBe(true);
    expect(isPhone('919876543210')).toBe(false);
    expect(isPhone('+0919876543210')).toBe(false);
    expect(isPhone('+91')).toBe(false);
    expect(isPhone('+9198765432101234')).toBe(false);
  });
});

describe('isIata', () => {
  it('accepts three letters in any case and nothing else', () => {
    expect(isIata('DEL')).toBe(true);
    expect(isIata('bom')).toBe(true);
    expect(isIata(' LHR ')).toBe(true);
    for (const v of ['DE', 'DELH', 'D3L', '', null, 123, ['DEL']]) expect(isIata(v)).toBe(false);
  });
});

describe('isPostalCode', () => {
  it('knows the IN / US / GB / CA / DE / FR / AU formats', () => {
    const good = {
      IN: ['110001', '560 001'],
      US: ['10001', '94105-1234'],
      GB: ['SW1A 1AA', 'EC1A1BB', 'm1 1ae', 'GIR 0AA', 'DN55 1PT'],
      CA: ['K1A 0B1', 'm5v3l9'],
      DE: ['10115'],
      FR: ['75008', '20090'],
      AU: ['2000'],
    };
    const bad = {
      IN: ['010001', '11000', '1100011', 'ABC123'],
      US: ['1000', '100011', '10001-12', 'ABCDE'],
      GB: ['SW1A', '12345', 'SW1A 1A', 'SW1A 1AAA'],
      CA: ['D1A 0B1', 'K1A0B', 'K1A 0B12'],
      DE: ['1011', '101155', 'ABCDE'],
      FR: ['7500', 'ABCDE'],
      AU: ['200', '20000', 'ABCD'],
    };
    for (const [country, list] of Object.entries(good)) {
      for (const v of list) expect(isPostalCode(v, country), `${country} ${v}`).toBe(true);
      expect(isPostalCode(list[0], country.toLowerCase())).toBe(true);
    }
    for (const [country, list] of Object.entries(bad)) {
      for (const v of list) expect(isPostalCode(v, country), `${country} ${v}`).toBe(false);
    }
  });

  it('falls back to a permissive alphanumeric rule for other countries and rejects junk', () => {
    expect(isPostalCode('1234 AB', 'NL')).toBe(true);
    expect(isPostalCode('100-0001', 'JP')).toBe(true);
    expect(isPostalCode('01310-100', 'BR')).toBe(true);
    expect(isPostalCode('12345')).toBe(true);
    expect(isPostalCode('AB', 'NL')).toBe(false);
    expect(isPostalCode('12345678901', 'NL')).toBe(false);
    expect(isPostalCode('12#45', 'NL')).toBe(false);
    expect(isPostalCode('', 'NL')).toBe(false);
    expect(isPostalCode('   ', 'AE')).toBe(false);
    expect(isPostalCode(12345, 'US')).toBe(false);
    expect(isPostalCode(null, 'US')).toBe(false);
  });
});

describe('isPassportNumber', () => {
  it('uses the generic 6-9 alphanumeric rule by default', () => {
    expect(isPassportNumber('AB1234')).toBe(true);
    expect(isPassportNumber('ab 123 456')).toBe(true);
    expect(isPassportNumber('X12345678', 'DE')).toBe(true);
    expect(isPassportNumber('12345')).toBe(false);
    expect(isPassportNumber('1234567890')).toBe(false);
    expect(isPassportNumber('AB-12345')).toBe(false);
    expect(isPassportNumber('')).toBe(false);
    expect(isPassportNumber(12345678)).toBe(false);
  });

  it('applies the Indian, US and UK shapes', () => {
    expect(isPassportNumber('A1234567', 'IN')).toBe(true);
    expect(isPassportNumber('z1234567', 'in')).toBe(false);
    expect(isPassportNumber('A0234567', 'IN')).toBe(false);
    expect(isPassportNumber('A1234560', 'IN')).toBe(false);
    expect(isPassportNumber('A123456', 'IN')).toBe(false);
    expect(isPassportNumber('A12 34567', 'IN')).toBe(true);
    expect(isPassportNumber('123456789', 'US')).toBe(true);
    expect(isPassportNumber('A12345678', 'US')).toBe(true);
    expect(isPassportNumber('AB1234567', 'US')).toBe(false);
    expect(isPassportNumber('12345678', 'US')).toBe(false);
    expect(isPassportNumber('123456789', 'GB')).toBe(true);
    expect(isPassportNumber('12345678', 'GB')).toBe(false);
    expect(isPassportNumber('A12345678', 'GB')).toBe(false);
  });
});

describe('isGstin / isPan / isVpa / isLuhn', () => {
  it('validates GSTIN structure and mod-36 checksum, case-insensitively', () => {
    expect(isGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isGstin('27AAACR5055K1Z7')).toBe(true);
    expect(isGstin(' 27aapfu0939f1zv ')).toBe(true);
    expect(isGstin('27AAPFU0939F1ZX')).toBe(false); // bad check character
    expect(isGstin('27AAPFU0939F1YV')).toBe(false); // 14th must be Z
    expect(isGstin('27AAPFU0939F0ZV')).toBe(false); // entity number 0
    expect(isGstin('27AAPXU0939F1ZV')).toBe(false); // bad PAN holder letter
    expect(isGstin('27AAPFU0939F1Z')).toBe(false);
    expect(isGstin('')).toBe(false);
    expect(isGstin(27)).toBe(false);
  });

  it('validates PAN', () => {
    expect(isPan('ABCPE1234F')).toBe(true);
    expect(isPan('aapfu0939f')).toBe(true);
    expect(isPan('ABCXE1234F')).toBe(false);
    expect(isPan('ABCPE123F')).toBe(false);
    expect(isPan('ABCPE12345')).toBe(false);
    expect(isPan('')).toBe(false);
    expect(isPan(null)).toBe(false);
  });

  it('validates UPI VPAs', () => {
    expect(isVpa('arjun@okhdfcbank')).toBe(true);
    expect(isVpa('9876543210@ybl')).toBe(true);
    expect(isVpa('first.last-1@paytm')).toBe(true);
    expect(isVpa('a@b')).toBe(false);
    expect(isVpa('@ybl')).toBe(false);
    expect(isVpa('arjun@')).toBe(false);
    expect(isVpa('arjun@1bank')).toBe(false);
    expect(isVpa('ar jun@ybl')).toBe(false);
    expect(isVpa('arjun@ok.hdfc')).toBe(false);
    expect(isVpa(undefined)).toBe(false);
  });

  it('runs the Luhn check, ignoring spaces and hyphens', () => {
    for (const n of [
      VISA,
      MASTERCARD,
      AMEX,
      RUPAY,
      DISCOVER,
      '79927398713',
      '4000 0000 0000 0002',
    ]) {
      expect(isLuhn(n), n).toBe(true);
    }
    expect(isLuhn(4000000000000002)).toBe(true);
    expect(isLuhn('4000000000000003')).toBe(false);
    expect(isLuhn('79927398710')).toBe(false);
    expect(isLuhn('0')).toBe(false);
    expect(isLuhn('')).toBe(false);
    expect(isLuhn('4000 0000 0000 000x')).toBe(false);
    expect(isLuhn(null)).toBe(false);
  });
});

describe('isNameValid / namesFitTicket', () => {
  it('accepts letters with single spaces, hyphens and apostrophes', () => {
    for (const v of ['Arjun', 'Mary Ann', 'Jean-Luc', "O'Neil", 'D’Souza', '  Priya  ', 'A']) {
      expect(isNameValid(v), v).toBe(true);
    }
  });

  it('rejects digits, punctuation, doubled or edge separators, blanks and non-strings', () => {
    for (const v of [
      'R2D2',
      'Jr.',
      'Mary  Ann',
      '-Arjun',
      'Arjun-',
      "O''Neil",
      '',
      '  ',
      'Mary Ann-',
      42,
      null,
    ]) {
      expect(isNameValid(v), String(v)).toBe(false);
    }
  });

  it('restricts to ASCII letters by default and to any script with charset "any"', () => {
    expect(isNameValid('José')).toBe(false);
    expect(isNameValid('José', { charset: 'latin' })).toBe(false);
    expect(isNameValid('José', { charset: 'any' })).toBe(true);
    expect(isNameValid('Zoë-Łukasz', { charset: 'any' })).toBe(true);
    expect(isNameValid('अर्जुन', { charset: 'any' })).toBe(true);
    expect(isNameValid('李 小龙', { charset: 'any' })).toBe(true);
    expect(isNameValid('李 小龙2', { charset: 'any' })).toBe(false);
  });

  it('enforces maxLength (default 60)', () => {
    expect(isNameValid('a'.repeat(60))).toBe(true);
    expect(isNameValid('a'.repeat(61))).toBe(false);
    expect(isNameValid('Arjun', { maxLength: 4 })).toBe(false);
    expect(isNameValid('Arjun', { maxLength: 5 })).toBe(true);
    expect(isNameValid('Arjun', null)).toBe(true);
  });

  it('checks that the letters of first + last name plus one separator fit the ticket', () => {
    expect(namesFitTicket('Arjun', 'Mehta')).toBe(true);
    expect(namesFitTicket('a'.repeat(30), 'b'.repeat(29))).toBe(true);
    expect(namesFitTicket('a'.repeat(30), 'b'.repeat(30))).toBe(false);
    expect(namesFitTicket('a'.repeat(10), 'b'.repeat(10), 21)).toBe(true);
    expect(namesFitTicket('a'.repeat(10), 'b'.repeat(10), 20)).toBe(false);
    // spaces, hyphens and apostrophes are dropped on the ticket
    expect(namesFitTicket("Mary Ann-O'Neil", 'Smith', 18)).toBe(true);
    expect(namesFitTicket('MaryAnnONeil', 'Smith', 18)).toBe(true);
    expect(namesFitTicket("Mary Ann-O'Neil", 'Smith', 17)).toBe(false);
    expect(namesFitTicket('Arjun', 'Mehta', NaN)).toBe(true);
    expect(namesFitTicket(undefined, 'Mehta')).toBe(false);
    expect(namesFitTicket('Arjun', 5)).toBe(false);
  });
});

// ── domain checks ────────────────────────────────────────────────────────────────────────────────

describe('documentValid', () => {
  it('passes when the expiry is at or after travel date + minValidityMonths', () => {
    expect(documentValid({ expiry: '2027-05-02' }, TRAVEL, { minValidityMonths: 6 })).toEqual([]);
    expect(documentValid({ expiry: '2030-01-01' }, TRAVEL, { minValidityMonths: 6 })).toEqual([]);
    expect(documentValid({ expiry: TRAVEL }, TRAVEL)).toEqual([]);
    expect(documentValid({ expiry: TRAVEL }, TRAVEL, { minValidityMonths: 0 })).toEqual([]);
    expect(documentValid({ expiry: TRAVEL }, TRAVEL, { minValidityMonths: -3 })).toEqual([]);
    expect(documentValid({ expiry: TRAVEL }, TRAVEL, null)).toEqual([]);
  });

  it('flags an expiry that falls short, with the i18n params', () => {
    expect(documentValid({ expiry: '2027-05-01' }, TRAVEL, { minValidityMonths: 6 })).toEqual([
      {
        path: 'expiry',
        code: 'documentExpiry',
        message: 'validation.documentExpiry',
        params: { months: 6, expiry: '2027-05-01', minExpiry: '2027-05-02', travelDate: TRAVEL },
      },
    ]);
    expect(codes(documentValid({ expiry: '2026-11-01' }, TRAVEL))).toEqual([
      ['expiry', 'documentExpiry'],
    ]);
    expect(documentValid({ expiry: '2026-11-01' }, TRAVEL)[0].params.months).toBe(0);
  });

  it('clamps month arithmetic to the end of the target month', () => {
    expect(documentValid({ expiry: '2026-02-28' }, '2026-01-31', { minValidityMonths: 1 })).toEqual(
      []
    );
    expect(
      documentValid({ expiry: '2026-02-27' }, '2026-01-31', { minValidityMonths: 1 })[0].params
        .minExpiry
    ).toBe('2026-02-28');
    expect(documentValid({ expiry: '2028-02-29' }, '2027-08-31', { minValidityMonths: 6 })).toEqual(
      []
    );
    expect(documentValid({ expiry: '2027-11-02' }, TRAVEL, { minValidityMonths: 12.9 })).toEqual(
      []
    );
  });

  it('flags a missing / malformed expiry and an issue date after the expiry', () => {
    expect(codes(documentValid({}, TRAVEL))).toEqual([['expiry', 'required']]);
    expect(codes(documentValid({ expiry: '' }, TRAVEL))).toEqual([['expiry', 'required']]);
    expect(codes(documentValid({ expiry: '02/2030' }, TRAVEL))).toEqual([['expiry', 'date']]);
    expect(codes(documentValid({ expiry: '2030-01-01', issueDate: '2030-06-01' }, TRAVEL))).toEqual(
      [['issueDate', 'dateOrder']]
    );
    expect(codes(documentValid({ expiry: '2030-01-01', issueDate: 'yesterday' }, TRAVEL))).toEqual([
      ['issueDate', 'date'],
    ]);
    expect(documentValid({ expiry: '2030-01-01', issueDate: '2020-01-01' }, TRAVEL)).toEqual([]);
    expect(codes(documentValid(null, TRAVEL))).toEqual([['', 'required']]);
    expect(codes(documentValid('passport', TRAVEL))).toEqual([['', 'required']]);
  });

  it('throws ValidationError on an unusable travel date', () => {
    expectThrows(
      () => documentValid({ expiry: '2030-01-01' }, undefined),
      'travelDate',
      'invalid_date'
    );
    expectThrows(
      () => documentValid({ expiry: '2030-01-01' }, '2026-13-01'),
      'travelDate',
      'invalid_date'
    );
    expectThrows(
      () => documentValid({ expiry: '2030-01-01' }, new Date()),
      'travelDate',
      'invalid_date'
    );
  });
});

describe('paxCountsValid', () => {
  const rules = { infantMax: 2, childMax: 12, refDate: 'departure', infantPerAdult: 1, maxPax: 9 };

  it('passes sensible counts, with or without optional fields', () => {
    expect(paxCountsValid({ adults: 1, children: 0, infants: 0 }, rules)).toEqual([]);
    expect(
      paxCountsValid({ adults: 2, children: 2, infants: 2, childAges: [3, 11] }, rules)
    ).toEqual([]);
    expect(paxCountsValid({ adults: 1 }, rules)).toEqual([]);
    expect(paxCountsValid({ adults: 0, seniors: 1, infants: 1 }, rules)).toEqual([]);
    expect(paxCountsValid({ adults: 0, youth: 1, children: 1 }, rules)).toEqual([]);
    expect(paxCountsValid({ adults: 1, children: 0, infants: 1 })).toEqual([]);
    expect(paxCountsValid({ adults: 1 }, null)).toEqual([]);
  });

  it('requires an adult, caps lap infants per adult and the total', () => {
    expect(paxCountsValid({ adults: 0, children: 1, infants: 0 }, rules)).toEqual([
      { path: 'adults', code: 'min', message: 'validation.min', params: { min: 1 } },
    ]);
    expect(paxCountsValid({ adults: 1, children: 0, infants: 2 }, rules)).toEqual([
      {
        path: 'infants',
        code: 'infantsPerAdult',
        message: 'validation.infantsPerAdult',
        params: { max: 1, infantPerAdult: 1 },
      },
    ]);
    expect(paxCountsValid({ adults: 1, infants: 2 }, { ...rules, infantPerAdult: 2 })).toEqual([]);
    expect(paxCountsValid({ adults: 5, children: 4, infants: 1 }, rules)).toEqual([
      {
        path: '',
        code: 'maxPassengers',
        message: 'validation.maxPassengers',
        params: { max: 9, total: 10 },
      },
    ]);
    expect(paxCountsValid({ adults: 5, children: 4, infants: 0, infantsSeated: 1 }, rules)).toEqual(
      [
        {
          path: '',
          code: 'maxPassengers',
          message: 'validation.maxPassengers',
          params: { max: 9, total: 10 },
        },
      ]
    );
    expect(paxCountsValid({ adults: 9, children: 0, infants: 0 }, rules)).toEqual([]);
    expect(paxCountsValid({ adults: 3 }, { maxPax: 2 })).toEqual([
      {
        path: '',
        code: 'maxPassengers',
        message: 'validation.maxPassengers',
        params: { max: 2, total: 3 },
      },
    ]);
  });

  it('flags non-integer or negative counts without piling on dependent issues', () => {
    expect(paxCountsValid({ adults: '2', children: 0, infants: 0 }, rules)).toEqual([
      {
        path: 'adults',
        code: 'type',
        message: 'validation.type',
        params: { expected: 'integer', actual: 'string' },
      },
    ]);
    expect(paxCountsValid({ adults: 1.5 }, rules)).toEqual([
      {
        path: 'adults',
        code: 'type',
        message: 'validation.type',
        params: { expected: 'integer', actual: 'number' },
      },
    ]);
    expect(paxCountsValid({ adults: 1, children: -1, infants: -2 }, rules)).toEqual([
      { path: 'children', code: 'min', message: 'validation.min', params: { min: 0 } },
      { path: 'infants', code: 'min', message: 'validation.min', params: { min: 0 } },
    ]);
  });

  it('checks childAges count and age band when present', () => {
    expect(paxCountsValid({ adults: 1, children: 2, infants: 0, childAges: [5] }, rules)).toEqual([
      {
        path: 'childAges',
        code: 'childAges',
        message: 'validation.childAges',
        params: { expected: 2, actual: 1 },
      },
    ]);
    expect(paxCountsValid({ adults: 1, children: 2, childAges: [1, 12] }, rules)).toEqual([
      {
        path: 'childAges[0]',
        code: 'ageForType',
        message: 'validation.ageForType',
        params: { min: 2, max: 11, age: 1 },
      },
      {
        path: 'childAges[1]',
        code: 'ageForType',
        message: 'validation.ageForType',
        params: { min: 2, max: 11, age: 12 },
      },
    ]);
    expect(paxCountsValid({ adults: 1, children: 1, childAges: ['5'] }, rules)[0].code).toBe(
      'ageForType'
    );
    expect(paxCountsValid({ adults: 1, children: 1, childAges: 5 }, rules)).toEqual([
      {
        path: 'childAges',
        code: 'type',
        message: 'validation.type',
        params: { expected: 'array', actual: 'number' },
      },
    ]);
    expect(paxCountsValid({ adults: 1, children: 0, childAges: [] }, rules)).toEqual([]);
    expect(paxCountsValid({ adults: 1, children: 1, childAges: null }, rules)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(paxCountsValid(null, rules)).toEqual([
      {
        path: '',
        code: 'type',
        message: 'validation.type',
        params: { expected: 'object', actual: 'null' },
      },
    ]);
    expect(codes(paxCountsValid([1, 2], rules))).toEqual([['', 'type']]);
    expect(codes(paxCountsValid(undefined))).toEqual([['', 'type']]);
  });
});

describe('travelerMatchesSlot', () => {
  const rules = { infantMax: 2, childMax: 12, refDate: 'departure', infantPerAdult: 1, maxPax: 9 };

  it('accepts a traveler whose age at travel date fits the slot type', () => {
    expect(travelerMatchesSlot({ dob: '1990-05-14' }, { type: 'ADT' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '2016-01-01' }, { type: 'CHD' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '2014-11-03' }, { type: 'CHD' }, rules, TRAVEL)).toEqual([]); // 11 the day before
    expect(travelerMatchesSlot({ dob: '2025-06-01' }, { type: 'INF' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '2025-06-01' }, { type: 'INS' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: TRAVEL }, { type: 'INF' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '2004-01-01' }, { type: 'YTH' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '1950-01-01' }, { type: 'SRC' }, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '2000-01-01' }, { type: 'STU' }, rules, TRAVEL)).toEqual([]);
  });

  it('flags a mismatch at dob with the expected / actual types and age', () => {
    expect(travelerMatchesSlot({ dob: '2020-01-01' }, { type: 'ADT' }, rules, TRAVEL)).toEqual([
      {
        path: 'dob',
        code: 'ageForType',
        message: 'validation.ageForType',
        params: { expected: 'ADT', actual: 'CHD', age: 6, travelDate: TRAVEL },
      },
    ]);
    expect(
      travelerMatchesSlot({ dob: '2014-11-02' }, { type: 'CHD' }, rules, TRAVEL)[0].params
    ).toMatchObject({
      actual: 'ADT',
      age: 12,
    });
    expect(
      codes(travelerMatchesSlot({ dob: '2024-11-02' }, { type: 'INF' }, rules, TRAVEL))
    ).toEqual([['dob', 'ageForType']]);
    expect(
      codes(travelerMatchesSlot({ dob: '2025-01-01' }, { type: 'CHD' }, rules, TRAVEL))
    ).toEqual([['dob', 'ageForType']]);
    // custom bands
    expect(
      travelerMatchesSlot({ dob: '2015-01-01' }, { type: 'CHD' }, { childMax: 16 }, TRAVEL)
    ).toEqual([]);
    expect(
      codes(travelerMatchesSlot({ dob: '2015-01-01' }, { type: 'ADT' }, { childMax: 16 }, TRAVEL))
    ).toEqual([['dob', 'ageForType']]);
  });

  it('falls back to the traveler type and reports nothing without any type', () => {
    expect(
      travelerMatchesSlot({ dob: '2020-01-01', type: 'CHD' }, undefined, rules, TRAVEL)
    ).toEqual([]);
    expect(
      codes(travelerMatchesSlot({ dob: '2020-01-01', type: 'ADT' }, {}, rules, TRAVEL))
    ).toEqual([['dob', 'ageForType']]);
    expect(travelerMatchesSlot({ dob: '2020-01-01' }, null, rules, TRAVEL)).toEqual([]);
    expect(travelerMatchesSlot({ dob: '2020-01-01' }, { type: 'XYZ' }, rules, TRAVEL)).toEqual([]);
  });

  it('flags a missing, malformed or future date of birth, and a non-object traveler', () => {
    expect(codes(travelerMatchesSlot({}, { type: 'ADT' }, rules, TRAVEL))).toEqual([
      ['dob', 'required'],
    ]);
    expect(codes(travelerMatchesSlot({ dob: ' ' }, { type: 'ADT' }, rules, TRAVEL))).toEqual([
      ['dob', 'required'],
    ]);
    expect(
      codes(travelerMatchesSlot({ dob: '14/05/1990' }, { type: 'ADT' }, rules, TRAVEL))
    ).toEqual([['dob', 'date']]);
    expect(travelerMatchesSlot({ dob: '2026-11-03' }, { type: 'INF' }, rules, TRAVEL)).toEqual([
      { path: 'dob', code: 'past', message: 'validation.past', params: { max: TRAVEL } },
    ]);
    expect(codes(travelerMatchesSlot(null, { type: 'ADT' }, rules, TRAVEL))).toEqual([
      ['', 'required'],
    ]);
  });

  it('throws ValidationError on an unusable travel date', () => {
    expectThrows(
      () => travelerMatchesSlot({ dob: '1990-01-01' }, { type: 'ADT' }, rules, 'soon'),
      'travelDate',
      'invalid_date'
    );
    expectThrows(
      () => travelerMatchesSlot({ dob: '1990-01-01' }, { type: 'ADT' }, rules),
      'travelDate',
      'invalid_date'
    );
  });
});

describe('cardBrand', () => {
  it('detects brands by prefix, including the RuPay ranges', () => {
    const cases = [
      [VISA, 'visa'],
      ['4', 'visa'],
      [MASTERCARD, 'mastercard'],
      ['5500 0000 0000 0004', 'mastercard'],
      ['2221000000000009', 'mastercard'],
      ['2720000000000005', 'mastercard'],
      ['2721', 'unknown'],
      ['2220', 'unknown'],
      [AMEX, 'amex'],
      ['37', 'amex'],
      ['30000000000004', 'diners'],
      ['30950000000000', 'diners'],
      ['36000000000008', 'diners'],
      ['38000000000006', 'diners'],
      ['3528000000000007', 'jcb'],
      ['3589000000000003', 'jcb'],
      [DISCOVER, 'discover'],
      ['6440000000000005', 'discover'],
      ['6490', 'discover'],
      ['6221261000000008', 'discover'],
      ['622925', 'discover'],
      [RUPAY, 'rupay'],
      ['60', 'rupay'],
      ['6073000000000009', 'rupay'],
      ['65', 'rupay'],
      ['81-0000-0000-0000-02', 'rupay'],
      ['8200000000000001', 'rupay'],
      ['5085000000000007', 'rupay'],
      ['508', 'rupay'],
      [6521000000000007, 'rupay'],
      ['6304000000000000', 'unknown'],
      ['1234', 'unknown'],
      ['', 'unknown'],
      ['abcd', 'unknown'],
      ['4x11', 'unknown'],
    ];
    for (const [number, brand] of cases) expect(cardBrand(number), String(number)).toBe(brand);
    expect(cardBrand(null)).toBe('unknown');
    expect(cardBrand(undefined)).toBe('unknown');
    expect(cardBrand(-4)).toBe('unknown');
  });
});

describe('cardExpiryValid', () => {
  it('compares against the host clock by default (good through the end of the month)', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 17, 12, 0, 0) }); // 17 Oct 2026, host zone
    expect(cardExpiryValid('10', '26')).toBe(true);
    expect(cardExpiryValid(10, 26)).toBe(true);
    expect(cardExpiryValid('10', '2026')).toBe(true);
    expect(cardExpiryValid('12', '30')).toBe(true);
    expect(cardExpiryValid('09', '26')).toBe(false);
    expect(cardExpiryValid('12', '25')).toBe(false);
    expect(cardExpiryValid('10', '2046')).toBe(true);
    expect(cardExpiryValid('10', '46')).toBe(true);
    expect(cardExpiryValid('01', '2047')).toBe(false);
    expect(cardExpiryValid('01', '47')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed months and years', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 17) });
    for (const [mm, yy] of [
      ['13', '30'],
      ['0', '30'],
      ['00', '30'],
      ['1.5', '30'],
      ['xx', '30'],
      ['', '30'],
      ['10', ''],
      ['10', '3'],
      ['10', '030'],
      ['10', '20260'],
      ['10', '2k'],
      ['10', '26.0'],
      [null, '30'],
      ['10', undefined],
      [-1, 30],
      [10, -30],
    ]) {
      expect(cardExpiryValid(mm, yy), `${mm}/${yy}`).toBe(false);
    }
    expect(cardExpiryValid('1', '3')).toBe(false); // '3' reads as 2003
  });

  it('accepts an explicit clock (epoch ms or Date)', () => {
    const feb2027 = new Date(2027, 1, 1);
    expect(cardExpiryValid('01', '27', feb2027)).toBe(false);
    expect(cardExpiryValid('02', '27', feb2027)).toBe(true);
    expect(cardExpiryValid('02', '27', feb2027.getTime())).toBe(true);
    expect(cardExpiryValid('01', '27', feb2027.getTime())).toBe(false);
    expect(cardExpiryValid('01', '27', new Date('garbage'))).toBe(false);
  });
});

describe('issuesByPath / firstIssue', () => {
  const result = {
    valid: false,
    issues: [
      { path: 'email', code: 'required', message: 'validation.required' },
      { path: 'slices[0].date', code: 'past', message: 'validation.past' },
      { path: 'email', code: 'email', message: 'validation.email' },
      { path: '', code: 'maxPassengers', message: 'validation.maxPassengers' },
    ],
  };

  it('groups issues by exact path, preserving order', () => {
    const grouped = issuesByPath(result);
    expect(Object.keys(grouped)).toEqual(['email', 'slices[0].date', '']);
    expect(grouped.email.map((i) => i.code)).toEqual(['required', 'email']);
    expect(grouped['slices[0].date']).toEqual([result.issues[1]]);
    expect(grouped['']).toEqual([result.issues[3]]);
    expect(issuesByPath(result.issues)).toEqual(grouped);
    expect(issuesByPath({ valid: true, issues: [] })).toEqual({});
    expect(issuesByPath(null)).toEqual({});
    expect(issuesByPath([{ code: 'x', message: 'validation.x' }])).toEqual({
      '': [{ code: 'x', message: 'validation.x' }],
    });
  });

  it('keeps a "__proto__" path as an own key', () => {
    const grouped = issuesByPath([{ path: '__proto__', code: 'x', message: 'validation.x' }]);
    expect(Object.prototype.hasOwnProperty.call(grouped, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(grouped)).toBe(Object.prototype);
    expect(grouped['__proto__']).toHaveLength(1);
  });

  it('returns the first issue at a path, or the first overall, else null', () => {
    expect(firstIssue(result, 'email')).toBe(result.issues[0]);
    expect(firstIssue(result, 'slices[0].date')).toBe(result.issues[1]);
    expect(firstIssue(result, '')).toBe(result.issues[3]);
    expect(firstIssue(result)).toBe(result.issues[0]);
    expect(firstIssue(result, 'slices')).toBeNull();
    expect(firstIssue(result, 'phone')).toBeNull();
    expect(firstIssue(result.issues, 'email')).toBe(result.issues[0]);
    expect(firstIssue({ valid: true, issues: [] })).toBeNull();
    expect(firstIssue(undefined, 'x')).toBeNull();
  });
});

// ── prebuilt schemas ─────────────────────────────────────────────────────────────────────────────

describe('schemas.searchParams', () => {
  it('accepts well-formed one-way, round-trip and multi-city searches', () => {
    const schema = schemas.searchParams();
    expect(validate(schema, validSearch(), CTX)).toEqual({ valid: true, issues: [] });
    expect(
      validate(
        schema,
        {
          tripType: 'one_way',
          slices: [
            {
              origin: 'del',
              destination: 'bom',
              date: TODAY,
              flexDays: 3,
              timeWindow: { from: '06:00', to: '23:59' },
            },
          ],
          passengers: { adults: 1, children: 0, infants: 0 },
          cabin: 'business',
          fareTypes: ['student'],
          directOnly: true,
          maxStops: 1,
          includeNearby: false,
          airlines: { include: ['AI', '6E'], exclude: ['UK'] },
          alliances: ['star_alliance'],
          refundableOnly: true,
          baggageIncluded: true,
          allowSelfTransfer: false,
          allowMixedCabin: false,
          maxDurationMinutes: 600,
          currency: 'INR',
          resultMode: 'combined',
          context: { bookingId: 'bk_1', sliceIds: ['s1'] },
        },
        CTX
      )
    ).toEqual({ valid: true, issues: [] });
    expect(
      validate(
        schema,
        {
          tripType: 'multi_city',
          slices: [
            { origin: 'DEL', destination: 'DXB', date: '2026-11-02' },
            { origin: 'DXB', destination: 'LHR', date: '2026-11-05' },
            { origin: 'LHR', destination: 'DEL', date: '2026-11-05' },
          ],
          passengers: { adults: 1 },
        },
        CTX
      ).valid
    ).toBe(true);
  });

  it('accepts both result modes (per_slice is the default downstream) and rejects others', () => {
    const schema = schemas.searchParams();
    for (const resultMode of ['per_slice', 'combined', undefined]) {
      expect(validate(schema, { ...validSearch(), resultMode }, CTX).valid).toBe(true);
    }
    expect(validate(schema, { ...validSearch(), resultMode: 'auto' }, CTX).issues).toEqual([
      {
        path: 'resultMode',
        code: 'enum',
        message: 'validation.enum',
        params: { values: ['per_slice', 'combined'] },
      },
    ]);
  });

  it('requires tripType, slices and passengers', () => {
    expect(codes(validate(schemas.searchParams(), {}, CTX))).toEqual([
      ['tripType', 'required'],
      ['slices', 'required'],
      ['passengers', 'required'],
    ]);
    expect(
      codes(
        validate(
          schemas.searchParams(),
          { tripType: 'round_trip', slices: [], passengers: { adults: 1 } },
          CTX
        )
      )
    ).toEqual([['slices', 'required']]);
    expect(codes(validate(schemas.searchParams(), null, CTX))).toEqual([['', 'required']]);
    expect(
      codes(validate(schemas.searchParams(), { ...validSearch(), tripType: 'return' }, CTX))
    ).toEqual([['tripType', 'enum']]);
  });

  it('ties the number of slices to the trip type and to maxLegs', () => {
    const schema = schemas.searchParams();
    const two = validSearch().slices;
    expect(
      validate(schema, { ...validSearch(), tripType: 'one_way', slices: two }, CTX).issues
    ).toEqual([
      {
        path: 'slices',
        code: 'maxLength',
        message: 'validation.maxLength',
        params: { max: 1, length: 2 },
      },
    ]);
    expect(codes(validate(schema, { ...validSearch(), slices: [two[0]] }, CTX))).toEqual([
      ['slices', 'minLength'],
    ]);
    expect(
      codes(validate(schema, { ...validSearch(), tripType: 'multi_city', slices: [two[0]] }, CTX))
    ).toEqual([['slices', 'minLength']]);
    const legs = Array.from({ length: 7 }, (_, i) => ({
      origin: 'DEL',
      destination: 'BOM',
      date: `2026-11-0${i + 1}`,
    }));
    expect(
      validate(schema, { ...validSearch(), tripType: 'multi_city', slices: legs }, CTX).issues
    ).toEqual([
      {
        path: 'slices',
        code: 'maxLength',
        message: 'validation.maxLength',
        params: { max: 6, length: 7 },
      },
    ]);
    expect(
      validate(
        schemas.searchParams({ maxLegs: 7 }),
        { ...validSearch(), tripType: 'multi_city', slices: legs },
        CTX
      ).valid
    ).toBe(true);
  });

  it('validates each slice: IATA codes, distinct airports, date window, flex days and time window', () => {
    const schema = schemas.searchParams();
    const params = validSearch();
    params.slices[0] = {
      origin: 'DELHI',
      destination: 'DELHI',
      date: '2026-10-16',
      flexDays: 4,
      timeWindow: { from: '6am' },
    };
    params.slices[1] = { origin: 'BOM', destination: 'bom', date: '2027-10-18' };
    expect(validate(schema, params, CTX).issues).toEqual([
      { path: 'slices[0].origin', code: 'iata', message: 'validation.iata' },
      { path: 'slices[0].destination', code: 'iata', message: 'validation.iata' },
      { path: 'slices[0].date', code: 'past', message: 'validation.past', params: { min: TODAY } },
      {
        path: 'slices[0].flexDays',
        code: 'enum',
        message: 'validation.enum',
        params: { values: [0, 1, 2, 3] },
      },
      {
        path: 'slices[0].timeWindow.from',
        code: 'pattern',
        message: 'validation.pattern',
        params: { pattern: expect.any(String) },
      },
      { path: 'slices[1].destination', code: 'sameAirport', message: 'validation.sameAirport' },
      {
        path: 'slices[1].date',
        code: 'max',
        message: 'validation.max',
        params: { max: '2027-10-17' },
      },
    ]);
    const missing = validSearch();
    missing.slices[1] = {};
    expect(codes(validate(schema, missing, CTX))).toEqual([
      ['slices[1].origin', 'required'],
      ['slices[1].destination', 'required'],
      ['slices[1].date', 'required'],
    ]);
    const malformed = validSearch();
    malformed.slices[1].date = '09/11/2026';
    expect(codes(validate(schema, malformed, CTX))).toEqual([['slices[1].date', 'date']]);
  });

  it('honours advanceDays and today from ctx, falling back to the host clock', () => {
    const params = validSearch();
    params.slices[1].date = '2026-11-17';
    expect(validate(schemas.searchParams({ advanceDays: 30 }), params, CTX).issues).toEqual([
      {
        path: 'slices[1].date',
        code: 'max',
        message: 'validation.max',
        params: { max: '2026-11-16' },
      },
    ]);
    expect(validate(schemas.searchParams({ advanceDays: 31 }), params, CTX).valid).toBe(true);
    // ctx.now (epoch ms) also sets today
    expect(
      validate(schemas.searchParams(), params, { now: new Date(2026, 9, 17, 12).getTime() }).valid
    ).toBe(true);
    // without ctx: the host clock; a date in 2000 is always past, one in 2999 always too far
    const past = validSearch();
    past.slices = [
      { origin: 'DEL', destination: 'BOM', date: '2000-01-01' },
      { origin: 'BOM', destination: 'DEL', date: '2999-01-01' },
    ];
    expect(codes(validate(schemas.searchParams(), past))).toEqual([
      ['slices[0].date', 'past'],
      ['slices[1].date', 'max'],
    ]);
  });

  it('requires slices to be chronological (same-day return allowed)', () => {
    const schema = schemas.searchParams();
    const params = validSearch();
    params.slices[1].date = '2026-11-01';
    expect(validate(schema, params, CTX).issues).toEqual([
      {
        path: 'slices[1].date',
        code: 'dateOrder',
        message: 'validation.dateOrder',
        params: { min: '2026-11-02' },
      },
    ]);
    params.slices[1].date = '2026-11-02';
    expect(validate(schema, params, CTX).valid).toBe(true);
    const multi = {
      ...validSearch(),
      tripType: 'multi_city',
      slices: [
        { origin: 'DEL', destination: 'DXB', date: '2026-11-05' },
        { origin: 'DXB', destination: 'LHR', date: '2026-11-04' },
        { origin: 'LHR', destination: 'DEL', date: '2026-11-03' },
      ],
    };
    expect(codes(validate(schema, multi, CTX))).toEqual([
      ['slices[1].date', 'dateOrder'],
      ['slices[2].date', 'dateOrder'],
    ]);
  });

  it('runs paxCountsValid under passengers and applies the seated / total caps from limits', () => {
    const schema = schemas.searchParams();
    expect(
      validate(
        schema,
        { ...validSearch(), passengers: { adults: 1, children: 0, infants: 2 } },
        CTX
      ).issues
    ).toEqual([
      {
        path: 'passengers.infants',
        code: 'infantsPerAdult',
        message: 'validation.infantsPerAdult',
        params: { max: 1, infantPerAdult: 1 },
      },
    ]);
    expect(
      codes(
        validate(
          schema,
          { ...validSearch(), passengers: { adults: 0, children: 1, infants: 0 } },
          CTX
        )
      )
    ).toEqual([['passengers.adults', 'min']]);
    expect(
      codes(
        validate(
          schema,
          { ...validSearch(), passengers: { adults: 1, children: 1, infants: 0, childAges: [1] } },
          CTX
        )
      )
    ).toEqual([['passengers.childAges[0]', 'ageForType']]);
    // Amadeus defaults: 9 seated + lap infants (18 in all)
    expect(
      validate(
        schema,
        { ...validSearch(), passengers: { adults: 9, children: 0, infants: 9 } },
        CTX
      ).valid
    ).toBe(true);
    expect(
      validate(
        schema,
        { ...validSearch(), passengers: { adults: 9, children: 1, infants: 0 } },
        CTX
      ).issues
    ).toEqual([
      {
        path: 'passengers',
        code: 'maxPassengers',
        message: 'validation.maxPassengers',
        params: { max: 9, seated: 10 },
      },
    ]);
    expect(
      codes(
        validate(schema, { ...validSearch(), passengers: { adults: 9, infantsSeated: 1 } }, CTX)
      )
    ).toEqual([['passengers', 'maxPassengers']]);
    // a single maxPax caps everyone
    expect(
      validate(
        schemas.searchParams({ maxPax: 4 }),
        { ...validSearch(), passengers: { adults: 4, infants: 1 } },
        CTX
      ).issues
    ).toEqual([
      {
        path: 'passengers',
        code: 'maxPassengers',
        message: 'validation.maxPassengers',
        params: { max: 4, total: 5 },
      },
    ]);
    expect(
      validate(
        schemas.searchParams({ maxPax: 4 }),
        { ...validSearch(), passengers: { adults: 4 } },
        CTX
      ).valid
    ).toBe(true);
    expect(
      validate(
        schemas.searchParams({ maxSeated: 2, infantPerAdult: 2 }),
        { ...validSearch(), passengers: { adults: 2, infants: 4 } },
        CTX
      ).valid
    ).toBe(true);
    expect(
      codes(
        validate(
          schemas.searchParams({ maxSeated: 2 }),
          { ...validSearch(), passengers: { adults: 3 } },
          CTX
        )
      )
    ).toEqual([['passengers', 'maxPassengers']]);
    expect(
      validate(
        schemas.searchParams({ ageRules: { childMax: 16 } }),
        { ...validSearch(), passengers: { adults: 1, children: 1, childAges: [14] } },
        CTX
      ).valid
    ).toBe(true);
    expect(codes(validate(schema, { ...validSearch(), passengers: 2 }, CTX))).toEqual([
      ['passengers', 'type'],
    ]);
  });

  it('checks the enumerations and filter flags', () => {
    const schema = schemas.searchParams();
    const params = {
      ...validSearch(),
      cabin: 'coach',
      fareTypes: ['student', 'vip'],
      directOnly: 'yes',
      maxStops: 3,
      airlines: { include: ['AIR'], exclude: 'UK' },
      maxDurationMinutes: 0,
      currency: 'RUPEES',
      context: { sliceIds: [''] },
    };
    expect(codes(validate(schema, params, CTX))).toEqual([
      ['cabin', 'enum'],
      ['fareTypes[1]', 'enum'],
      ['directOnly', 'type'],
      ['maxStops', 'enum'],
      ['airlines.include[0]', 'pattern'],
      ['airlines.exclude', 'type'],
      ['maxDurationMinutes', 'min'],
      ['currency', 'pattern'],
      ['context.sliceIds[0]', 'required'],
    ]);
    // market limits narrow fare types and cabins
    const limited = schemas.searchParams({
      fareTypes: ['regular', 'corporate'],
      cabins: ['economy'],
    });
    expect(validate(limited, { ...validSearch(), fareTypes: ['corporate'] }, CTX).valid).toBe(true);
    expect(
      validate(limited, { ...validSearch(), fareTypes: ['student'] }, CTX).issues[0]
    ).toMatchObject({
      path: 'fareTypes[0]',
      code: 'enum',
      params: { values: ['regular', 'corporate'] },
    });
    expect(codes(validate(limited, { ...validSearch(), cabin: 'business' }, CTX))).toEqual([
      ['cabin', 'enum'],
    ]);
    // cabin is optional at validation time (search.normalize fills it)
    const noCabin = validSearch();
    delete noCabin.cabin;
    expect(validate(schema, noCabin, CTX).valid).toBe(true);
  });
});

describe('schemas.traveler', () => {
  it('accepts a complete adult traveler under the requirements', () => {
    const r = validate(schemas.traveler(requirements(), 'ADT'), validTraveler(), {
      ...CTX,
      travelDate: TRAVEL,
    });
    expect(r).toEqual({ valid: true, issues: [] });
    expect(validate(schemas.traveler(), validTraveler(), CTX).valid).toBe(true);
    expect(validate(schemas.traveler(null, 'ADT'), validTraveler(), CTX).valid).toBe(true);
  });

  it('requires the core fields and the slot type', () => {
    expect(codes(validate(schemas.traveler(requirements(), 'ADT'), {}, CTX))).toEqual([
      ['type', 'required'],
      ['firstName', 'required'],
      ['lastName', 'required'],
      ['gender', 'required'],
      ['dob', 'required'],
      ['nationality', 'required'],
      ['documents', 'required'],
    ]);
    expect(
      validate(schemas.traveler(requirements(), 'ADT'), { ...validTraveler(), type: 'CHD' }, CTX)
        .issues
    ).toEqual([
      { path: 'type', code: 'enum', message: 'validation.enum', params: { values: ['ADT'] } },
    ]);
    expect(
      codes(validate(schemas.traveler(requirements()), { ...validTraveler(), type: 'VIP' }, CTX))
    ).toEqual([['type', 'enum']]);
    expect(
      codes(
        validate(
          schemas.traveler(requirements(), 'ADT'),
          { ...validTraveler(), gender: 'male' },
          CTX
        )
      )
    ).toEqual([['gender', 'enum']]);
    expect(codes(validate(schemas.traveler(requirements(), 'ADT'), null, CTX))).toEqual([
      ['', 'required'],
    ]);
  });

  it('applies the name rules: charset, per-field length and the combined ticket length', () => {
    const latin = schemas.traveler(requirements(), 'ADT');
    expect(codes(validate(latin, { ...validTraveler(), firstName: 'José' }, CTX))).toEqual([
      ['firstName', 'name'],
    ]);
    expect(codes(validate(latin, { ...validTraveler(), middleName: 'R2' }, CTX))).toEqual([
      ['middleName', 'name'],
    ]);
    expect(validate(latin, { ...validTraveler(), middleName: 'Kumar' }, CTX).valid).toBe(true);
    const any = schemas.traveler(
      { ...requirements(), nameRules: { maxLength: 40, charset: 'any' } },
      'ADT'
    );
    expect(validate(any, { ...validTraveler(), firstName: 'José' }, CTX).valid).toBe(true);
    expect(validate(latin, { ...validTraveler(), lastName: 'a'.repeat(41) }, CTX).issues).toEqual([
      {
        path: 'lastName',
        code: 'maxLength',
        message: 'validation.maxLength',
        params: { max: 40, length: 41 },
      },
    ]);
    expect(
      validate(
        latin,
        { ...validTraveler(), firstName: 'a'.repeat(20), lastName: 'b'.repeat(20) },
        CTX
      ).issues
    ).toEqual([
      {
        path: 'lastName',
        code: 'nameLength',
        message: 'validation.nameLength',
        params: { max: 40 },
      },
    ]);
    expect(
      validate(
        latin,
        { ...validTraveler(), firstName: 'a'.repeat(20), lastName: 'b'.repeat(19) },
        CTX
      ).valid
    ).toBe(true);
    // defaults: latin, 60
    expect(
      validate(
        schemas.traveler(),
        { ...validTraveler(), firstName: 'a'.repeat(30), lastName: 'b'.repeat(30) },
        CTX
      ).issues[0].code
    ).toBe('nameLength');
  });

  it('checks the date of birth against today and, with ctx.travelDate, against the passenger type', () => {
    const adult = schemas.traveler(requirements(), 'ADT');
    expect(validate(adult, { ...validTraveler(), dob: '2026-10-18' }, CTX).issues).toEqual([
      { path: 'dob', code: 'past', message: 'validation.past', params: { max: TODAY } },
    ]);
    expect(codes(validate(adult, { ...validTraveler(), dob: '14-05-1990' }, CTX))).toEqual([
      ['dob', 'date'],
    ]);
    expect(validate(adult, { ...validTraveler(), dob: '2020-01-01' }, CTX).valid).toBe(true); // no travel date: no age check
    expect(
      validate(adult, { ...validTraveler(), dob: '2020-01-01' }, { ...CTX, travelDate: TRAVEL })
        .issues
    ).toEqual([
      {
        path: 'dob',
        code: 'ageForType',
        message: 'validation.ageForType',
        params: { expected: 'ADT', actual: 'CHD', age: 6, travelDate: TRAVEL },
      },
    ]);
    const child = schemas.traveler(requirements(), 'CHD');
    const kid = { ...validTraveler(), type: 'CHD', dob: '2018-03-03', documents: undefined };
    expect(validate(child, kid, { ...CTX, travelDate: TRAVEL }).valid).toBe(true);
    expect(
      codes(validate(child, { ...kid, dob: '2010-03-03' }, { ...CTX, travelDate: TRAVEL }))
    ).toEqual([['dob', 'ageForType']]);
    // without a pax type there is nothing to compare against
    expect(
      validate(
        schemas.traveler(requirements()),
        { ...validTraveler(), dob: '2020-01-01' },
        { ...CTX, travelDate: TRAVEL }
      ).valid
    ).toBe(true);
  });

  it('requires nationality for APIS and documents when a document rule says so, validating each', () => {
    const req = requirements();
    const withDocs = schemas.traveler(req, 'ADT');
    expect(
      codes(validate(withDocs, { ...validTraveler(), nationality: undefined, documents: [] }, CTX))
    ).toEqual([
      ['nationality', 'required'],
      ['documents', 'required'],
    ]);
    expect(codes(validate(withDocs, { ...validTraveler(), nationality: 'IND' }, CTX))).toEqual([
      ['nationality', 'pattern'],
    ]);
    const noApis = schemas.traveler({ ...req, apis: false }, 'ADT');
    expect(validate(noApis, { ...validTraveler(), nationality: undefined }, CTX).valid).toBe(true);
    // the per-type document rule narrows the accepted types and drives the validity window
    const badDoc = {
      ...validTraveler(),
      documents: [
        { type: 'national_id', number: 'A1234567', issuingCountry: 'IN', expiry: '2027-04-30' },
      ],
    };
    expect(validate(withDocs, badDoc, { ...CTX, travelDate: TRAVEL }).issues).toEqual([
      {
        path: 'documents[0].type',
        code: 'enum',
        message: 'validation.enum',
        params: { values: ['passport'] },
      },
      {
        path: 'documents[0].expiry',
        code: 'documentExpiry',
        message: 'validation.documentExpiry',
        params: { months: 6, expiry: '2027-04-30', minExpiry: '2027-05-02', travelDate: TRAVEL },
      },
    ]);
    expect(
      validate(
        withDocs,
        {
          ...validTraveler(),
          documents: [{ ...validTraveler().documents[0], expiry: '2027-05-02' }],
        },
        { ...CTX, travelDate: TRAVEL }
      ).valid
    ).toBe(true);
    expect(
      codes(
        validate(
          withDocs,
          {
            ...validTraveler(),
            documents: [{ ...validTraveler().documents[0], number: 'Z1234567' }],
          },
          CTX
        )
      )
    ).toEqual([['documents[0].number', 'passport']]);
    // children of this itinerary need no document
    const child = schemas.traveler(req, 'CHD');
    expect(
      validate(
        child,
        { ...validTraveler(), type: 'CHD', dob: '2018-03-03', documents: undefined },
        CTX
      ).valid
    ).toBe(true);
  });

  it('overlays backend FieldRules: required, pattern, options and nested paths', () => {
    const req = requirements();
    req.perType.ADT.fields = [
      { path: 'knownTravelerNumber', required: true, pattern: '^[0-9]{9}$' },
      { path: 'mealPref', required: false, options: ['VGML', 'AVML'] },
      { path: 'phone.number', required: true },
      { path: 'title', required: true, pattern: '(' },
      { path: '', required: true },
      'nonsense',
    ];
    const schema = schemas.traveler(req, 'ADT');
    const base = validTraveler();
    expect(codes(validate(schema, { ...base, phone: undefined }, CTX))).toEqual([
      ['knownTravelerNumber', 'required'],
      ['phone', 'required'],
    ]);
    expect(
      codes(
        validate(
          schema,
          {
            ...base,
            knownTravelerNumber: 'ABC123456',
            mealPref: 'HNML',
            phone: { countryCode: '+91' },
          },
          CTX
        )
      )
    ).toEqual([
      ['knownTravelerNumber', 'pattern'],
      ['mealPref', 'enum'],
      ['phone.number', 'required'],
    ]);
    expect(
      validate(schema, { ...base, knownTravelerNumber: '123456789', mealPref: 'VGML' }, CTX).valid
    ).toBe(true);
  });

  it('validates optional loyalty, e-mail and phone when present', () => {
    const schema = schemas.traveler(requirements(), 'ADT');
    const t = {
      ...validTraveler(),
      loyalty: [
        { airline: 'AI', number: '12345678' },
        { airline: 'AIR', number: '1' },
      ],
      email: 'not-an-email',
      phone: { countryCode: '+91', number: '12' },
      knownTravelerNumber: 'KT-1',
      assistance: ['WCHR', ''],
    };
    expect(codes(validate(schema, t, CTX))).toEqual([
      ['loyalty[1].airline', 'pattern'],
      ['loyalty[1].number', 'minLength'],
      ['knownTravelerNumber', 'pattern'],
      ['assistance[1]', 'required'],
      ['email', 'email'],
      ['phone', 'phone'],
    ]);
  });
});

describe('schemas.contact', () => {
  it('accepts a complete contact and a minimal one', () => {
    expect(validate(schemas.contact(requirements()), validContact(), CTX)).toEqual({
      valid: true,
      issues: [],
    });
    expect(
      validate(schemas.contact(), {
        email: 'a@b.co',
        phone: { countryCode: '+1', number: '2125550123' },
      }).valid
    ).toBe(true);
  });

  it('requires e-mail and phone and validates the optional blocks', () => {
    const schema = schemas.contact(requirements());
    expect(codes(validate(schema, {}, CTX))).toEqual([
      ['email', 'required'],
      ['phone', 'required'],
    ]);
    const bad = {
      email: 'nope',
      phone: { countryCode: '+91', number: '12' },
      emergency: { name: 'R2D2', phone: { countryCode: '+91' } },
      address: { line1: '1', city: 'Bengaluru', postalCode: '56000', countryCode: 'IN' },
      gst: { number: '27AAPFU0939F1ZX', company: 'A' },
    };
    expect(codes(validate(schema, bad, CTX))).toEqual([
      ['email', 'email'],
      ['phone', 'phone'],
      ['emergency.name', 'name'],
      ['emergency.phone.number', 'required'],
      ['address.line1', 'minLength'],
      ['address.state', 'required'],
      ['address.postalCode', 'postalCode'],
      ['gst.number', 'gstin'],
      ['gst.company', 'minLength'],
    ]);
    expect(
      codes(validate(schema, { ...validContact(), phone: { number: '9876543210' } }, CTX))
    ).toEqual([['phone.countryCode', 'required']]);
  });

  it('keys the address rules on the address country and overlays requirements.contact', () => {
    const schema = schemas.contact(requirements());
    const dubai = {
      ...validContact(),
      address: { line1: 'Marina Walk', city: 'Dubai', countryCode: 'AE' },
    };
    expect(validate(schema, dubai, CTX).valid).toBe(true);
    const noCountry = {
      ...validContact(),
      address: { line1: 'Marina Walk', city: 'Dubai', postalCode: '00000' },
    };
    expect(codes(validate(schema, noCountry, CTX))).toEqual([['address.countryCode', 'required']]);
    const req = {
      ...requirements(),
      contact: [
        { path: 'emergency.name', required: true },
        { path: 'gst.number', pattern: '^27' },
      ],
    };
    const strict = schemas.contact(req);
    const withoutEmergency = validContact();
    delete withoutEmergency.emergency;
    expect(codes(validate(strict, withoutEmergency, CTX))).toEqual([['emergency', 'required']]);
    expect(
      codes(
        validate(
          strict,
          { ...validContact(), gst: { number: '27AAACR5055K1Z7', company: 'Acme' } },
          CTX
        )
      )
    ).toEqual([]);
    expect(validate(strict, validContact(), CTX).valid).toBe(true);
  });
});

describe('schemas.document', () => {
  const rule = { types: ['passport', 'national_id'], required: true, minValidityMonths: 6 };
  const passport = () => ({
    type: 'passport',
    number: 'A1234567',
    issuingCountry: 'IN',
    expiry: '2030-01-01',
    issueDate: '2020-01-01',
  });

  it('accepts a valid document with and without a travel date', () => {
    expect(validate(schemas.document(rule), passport(), CTX)).toEqual({ valid: true, issues: [] });
    expect(validate(schemas.document(rule), passport(), { ...CTX, travelDate: TRAVEL }).valid).toBe(
      true
    );
    expect(
      validate(
        schemas.document(),
        { type: 'other', number: 'ID-9988', issuingCountry: 'de', expiry: '2030-01-01' },
        CTX
      ).valid
    ).toBe(true);
  });

  it('requires type, number, issuing country and expiry', () => {
    expect(codes(validate(schemas.document(rule), {}, CTX))).toEqual([
      ['type', 'required'],
      ['number', 'required'],
      ['issuingCountry', 'required'],
      ['expiry', 'required'],
    ]);
    expect(codes(validate(schemas.document(rule), undefined, CTX))).toEqual([['', 'required']]);
  });

  it('restricts the type to the rule, checks number shapes and country codes', () => {
    expect(
      validate(schemas.document(rule), { ...passport(), type: 'driving_licence' }, CTX).issues
    ).toEqual([
      {
        path: 'type',
        code: 'enum',
        message: 'validation.enum',
        params: { values: ['passport', 'national_id'] },
      },
    ]);
    expect(
      codes(validate(schemas.document(rule), { ...passport(), number: 'Z1234567' }, CTX))
    ).toEqual([['number', 'passport']]);
    expect(
      validate(
        schemas.document(rule),
        { ...passport(), number: 'Z1234567', issuingCountry: 'DE' },
        CTX
      ).valid
    ).toBe(true);
    expect(
      codes(
        validate(schemas.document(rule), { ...passport(), type: 'national_id', number: '1!' }, CTX)
      )
    ).toEqual([['number', 'pattern']]);
    expect(
      validate(
        schemas.document(rule),
        { ...passport(), type: 'national_id', number: '1234-5678-9012' },
        CTX
      ).valid
    ).toBe(true);
    expect(
      codes(
        validate(
          schemas.document(rule),
          { ...passport(), issuingCountry: 'IND', nationality: 'I' },
          CTX
        )
      )
    ).toEqual([
      ['issuingCountry', 'pattern'],
      ['nationality', 'pattern'],
    ]);
  });

  it('checks the dates: expiry vs travel date or today, issue date not in the future nor after expiry', () => {
    const schema = schemas.document(rule);
    expect(
      validate(schema, { ...passport(), expiry: '2027-04-30' }, { ...CTX, travelDate: TRAVEL })
        .issues
    ).toEqual([
      {
        path: 'expiry',
        code: 'documentExpiry',
        message: 'validation.documentExpiry',
        params: { months: 6, expiry: '2027-04-30', minExpiry: '2027-05-02', travelDate: TRAVEL },
      },
    ]);
    expect(
      validate(schema, { ...passport(), expiry: '2027-05-02' }, { ...CTX, travelDate: TRAVEL })
        .valid
    ).toBe(true);
    expect(validate(schema, { ...passport(), expiry: '2027-04-30' }, CTX).valid).toBe(true); // no travel date: only "not expired"
    expect(validate(schema, { ...passport(), expiry: TODAY }, CTX).issues).toEqual([
      { path: 'expiry', code: 'future', message: 'validation.future' },
    ]);
    expect(codes(validate(schema, { ...passport(), expiry: '2026-02-30' }, CTX))).toEqual([
      ['expiry', 'date'],
    ]);
    expect(codes(validate(schema, { ...passport(), issueDate: '2026-10-18' }, CTX))).toEqual([
      ['issueDate', 'past'],
    ]);
    expect(codes(validate(schema, { ...passport(), issueDate: '2026-10-17' }, CTX))).toEqual([]);
    // issued after it expired: dateOrder on top of the expiry problem, in either mode
    expect(
      codes(validate(schema, { ...passport(), expiry: '2020-06-01', issueDate: '2020-06-02' }, CTX))
    ).toEqual([
      ['expiry', 'future'],
      ['issueDate', 'dateOrder'],
    ]);
    expect(
      codes(
        validate(
          schema,
          { ...passport(), expiry: '2020-06-01', issueDate: '2020-06-02' },
          { ...CTX, travelDate: TRAVEL }
        )
      )
    ).toEqual([
      ['issueDate', 'dateOrder'],
      ['expiry', 'documentExpiry'],
    ]);
    // a travel date after the expiry but a sound issue date: only the expiry is reported
    expect(
      codes(
        validate(
          schema,
          { ...passport(), expiry: '2026-12-01', issueDate: '2016-12-02' },
          { ...CTX, travelDate: '2027-06-01' }
        )
      )
    ).toEqual([['expiry', 'documentExpiry']]);
  });
});

describe('schemas.gst / schemas.address / schemas.promo', () => {
  it('validates the GST block', () => {
    expect(
      validate(schemas.gst(), {
        number: '27AAPFU0939F1ZV',
        company: 'Acme Travels',
        address: 'Pune',
        email: 'ap@acme.in',
      }).valid
    ).toBe(true);
    expect(codes(validate(schemas.gst(), { number: '27AAPFU0939F1ZX', email: 'nope' }))).toEqual([
      ['number', 'gstin'],
      ['company', 'required'],
      ['email', 'email'],
    ]);
    expect(codes(validate(schemas.gst(), undefined))).toEqual([['', 'required']]);
  });

  it('validates addresses per country', () => {
    const india = { line1: '12 MG Road', city: 'Bengaluru', state: 'KA', postalCode: '560001' };
    expect(validate(schemas.address('IN'), india).valid).toBe(true);
    expect(validate(schemas.address('in'), india).valid).toBe(true);
    expect(
      codes(validate(schemas.address('IN'), { ...india, state: undefined, postalCode: '56000' }))
    ).toEqual([
      ['state', 'required'],
      ['postalCode', 'postalCode'],
    ]);
    expect(codes(validate(schemas.address('IN'), {}))).toEqual([
      ['line1', 'required'],
      ['city', 'required'],
      ['state', 'required'],
      ['postalCode', 'required'],
    ]);
    const us = {
      line1: '1 Market St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94105-1234',
    };
    expect(validate(schemas.address('US'), us).valid).toBe(true);
    expect(codes(validate(schemas.address('US'), { ...us, postalCode: '9410' }))).toEqual([
      ['postalCode', 'postalCode'],
    ]);
    // no postal codes in the UAE, no state needed in Germany
    expect(validate(schemas.address('AE'), { line1: 'Marina Walk', city: 'Dubai' }).valid).toBe(
      true
    );
    expect(
      validate(schemas.address('DE'), {
        line1: 'Unter den Linden 1',
        city: 'Berlin',
        postalCode: '10117',
      }).valid
    ).toBe(true);
    expect(
      codes(validate(schemas.address('DE'), { line1: 'Unter den Linden 1', city: 'Berlin' }))
    ).toEqual([['postalCode', 'required']]);
    // without a fixed country the address's own countryCode drives the rules and is required
    expect(validate(schemas.address(), { ...india, countryCode: 'IN' }).valid).toBe(true);
    expect(codes(validate(schemas.address(), { ...india, countryCode: 'India' }))).toEqual([
      ['countryCode', 'pattern'],
    ]);
    expect(codes(validate(schemas.address(), india))).toEqual([['countryCode', 'required']]);
    expect(
      codes(validate(schemas.address(), { line1: 'Marina Walk', city: 'Dubai', countryCode: 'AE' }))
    ).toEqual([]);
    expect(
      codes(
        validate(schemas.address('IN'), { ...india, line2: 'x'.repeat(121), countryCode: 'IN' })
      )
    ).toEqual([['line2', 'maxLength']]);
  });

  it('validates promo codes as strings', () => {
    expect(validate(schemas.promo(), 'SAVE20').valid).toBe(true);
    expect(validate(schemas.promo(), ' first-trip_10 ').valid).toBe(true);
    expect(codes(validate(schemas.promo(), 'S'))).toEqual([['', 'promo']]);
    expect(codes(validate(schemas.promo(), 'SAVE 20'))).toEqual([['', 'promo']]);
    expect(codes(validate(schemas.promo(), 'x'.repeat(33)))).toEqual([['', 'promo']]);
    expect(codes(validate(schemas.promo(), ''))).toEqual([['', 'required']]);
    expect(codes(validate(schemas.promo(), 20))).toEqual([['', 'type']]);
    expect(codes(validate(schemas.promo(), '', { path: 'promo' }))).toEqual([
      ['promo', 'required'],
    ]);
  });
});

describe('schemas.card', () => {
  const now = new Date(2026, 9, 17).getTime();
  const card = () => ({
    number: '4000 0000 0000 0002',
    expMonth: '10',
    expYear: '26',
    cvc: '123',
    name: 'Arjun Mehta',
  });

  it('accepts a valid card for each brand, with ctx.now as the clock', () => {
    expect(validate(schemas.card(), card(), { now })).toEqual({ valid: true, issues: [] });
    expect(
      validate(schemas.card(), { ...card(), number: AMEX, cvc: '1234', expYear: '2030' }, { now })
        .valid
    ).toBe(true);
    expect(
      validate(schemas.card(), { ...card(), number: RUPAY, expMonth: 12, expYear: 2027 }, { now })
        .valid
    ).toBe(true);
    expect(validate(schemas.card(), { ...card(), name: undefined }, { now }).valid).toBe(true);
    expect(
      validate(schemas.card(), { ...card(), number: '79927398713', cvc: '1234' }, { now }).valid
    ).toBe(false); // 11 digits
    expect(
      validate(schemas.card(), { ...card(), number: '7992739871300000', cvc: '1234' }, { now })
        .valid
    ).toBe(isLuhn('7992739871300000'));
  });

  it('requires every field and flags number, expiry, CVC and name problems', () => {
    expect(codes(validate(schemas.card(), {}, { now }))).toEqual([
      ['number', 'required'],
      ['expMonth', 'required'],
      ['expYear', 'required'],
      ['cvc', 'required'],
    ]);
    expect(
      codes(validate(schemas.card(), { ...card(), number: '4000 0000 0000 0003' }, { now }))
    ).toEqual([['number', 'card']]);
    expect(
      codes(validate(schemas.card(), { ...card(), number: '4000 0000 0000' }, { now }))
    ).toEqual([['number', 'card']]);
    expect(codes(validate(schemas.card(), { ...card(), expMonth: '09' }, { now }))).toEqual([
      ['expMonth', 'cardExpiry'],
    ]);
    expect(
      codes(validate(schemas.card(), { ...card(), expMonth: '13', expYear: '3' }, { now }))
    ).toEqual([
      ['expMonth', 'cardExpiry'],
      ['expYear', 'cardExpiry'],
    ]);
    expect(codes(validate(schemas.card(), { ...card(), expYear: '' }, { now }))).toEqual([
      ['expYear', 'required'],
    ]);
    expect(codes(validate(schemas.card(), { ...card(), cvc: '12' }, { now }))).toEqual([
      ['cvc', 'cvv'],
    ]);
    expect(codes(validate(schemas.card(), { ...card(), cvc: '1234' }, { now }))).toEqual([
      ['cvc', 'cvv'],
    ]);
    expect(
      codes(validate(schemas.card(), { ...card(), number: AMEX, cvc: '123' }, { now }))
    ).toEqual([['cvc', 'cvv']]);
    expect(codes(validate(schemas.card(), { ...card(), name: 'A' }, { now }))).toEqual([
      ['name', 'minLength'],
    ]);
    expect(codes(validate(schemas.card(), { ...card(), name: 'Arjun <script>' }, { now }))).toEqual(
      [['name', 'pattern']]
    );
    // unknown brand: 3 or 4 digits
    expect(
      validate(schemas.card(), { ...card(), number: '6304000000000000', cvc: '1234' }, { now })
        .valid
    ).toBe(true);
    expect(
      validate(schemas.card(), { ...card(), number: '6304000000000000', cvc: '123' }, { now }).valid
    ).toBe(true);
  });

  it('uses the host clock when ctx.now is absent', () => {
    vi.useFakeTimers({ now: new Date(2031, 0, 15) });
    expect(codes(validate(schemas.card(), card()))).toEqual([['expMonth', 'cardExpiry']]);
    expect(validate(schemas.card(), { ...card(), expYear: '31', expMonth: '01' }).valid).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('schemas.password', () => {
  it('enforces only the length bounds by default', () => {
    expect(validate(schemas.password(), 'password').valid).toBe(true);
    expect(validate(schemas.password(), 'pass wor d').valid).toBe(true);
    expect(validate(schemas.password(), 'short').issues).toEqual([
      {
        path: '',
        code: 'minLength',
        message: 'validation.minLength',
        params: { min: 8, length: 5 },
      },
    ]);
    expect(codes(validate(schemas.password(), 'x'.repeat(129)))).toEqual([['', 'maxLength']]);
    expect(codes(validate(schemas.password(), ''))).toEqual([['', 'required']]);
    expect(codes(validate(schemas.password(), 12345678))).toEqual([['', 'type']]);
  });

  it('applies the policy and names what is missing', () => {
    const policy = {
      minLength: 10,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
      requireSymbol: true,
      allowSpaces: false,
    };
    expect(validate(schemas.password(policy), 'Str0ng!Passw0rd').valid).toBe(true);
    expect(validate(schemas.password(policy), 'weakpassword').issues).toEqual([
      {
        path: '',
        code: 'passwordPolicy',
        message: 'validation.passwordPolicy',
        params: { missing: ['upper', 'digit', 'symbol'], minClasses: 0, classes: 1 },
      },
    ]);
    expect(validate(schemas.password(policy), 'Str0ng! Passw0rd').issues[0].params.missing).toEqual(
      ['spaces']
    );
    expect(validate(schemas.password({ minClasses: 3 }), 'abcdefgh').issues[0].params).toEqual({
      missing: ['classes'],
      minClasses: 3,
      classes: 1,
    });
    expect(validate(schemas.password({ minClasses: 3 }), 'Abcdefg1').valid).toBe(true);
    // length failures come first; the class check is skipped until the length is right
    expect(codes(validate(schemas.password(policy), 'weak'))).toEqual([['', 'minLength']]);
    expect(
      validate(schemas.password({ minLength: 'ten', requireDigit: 'yes' }), 'password').valid
    ).toBe(true);
  });
});
