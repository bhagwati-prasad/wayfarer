import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildQuery,
  parseQuery,
  joinUrl,
  withParams,
  isAbsoluteUrl,
  sameOrigin,
  encodeSearchParams,
  decodeSearchParams,
  encodeState,
  decodeState,
  currentUrlParams,
} from '../../src/utils/url.js';
import { ValidationError } from '../../src/errors/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Call `fn`, assert it throws a ValidationError and (optionally) that an issue path is listed. */
function expectValidation(fn, path) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect(caught).toBeInstanceOf(Error);
  expect(caught.code).toBe('VALIDATION_FAILED');
  expect(Array.isArray(caught.issues)).toBe(true);
  expect(caught.issues.length).toBeGreaterThan(0);
  if (path) expect(caught.issues.map((i) => i.path)).toContain(path);
  return caught;
}

describe('module surface', () => {
  it('exports only functions', () => {
    for (const fn of [
      buildQuery,
      parseQuery,
      joinUrl,
      withParams,
      isAbsoluteUrl,
      sameOrigin,
      encodeSearchParams,
      decodeSearchParams,
      encodeState,
      decodeState,
      currentUrlParams,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});

describe('buildQuery', () => {
  it('serialises scalars with percent-encoding and no leading ?', () => {
    expect(buildQuery({ a: 1, b: 'x y', c: true, d: 'é&=' })).toBe(
      'a=1&b=x%20y&c=true&d=%C3%A9%26%3D'
    );
  });

  it('returns an empty string for empty / non-object input', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery(null)).toBe('');
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery('a=1')).toBe('');
  });

  it('drops undefined always and null by default; null becomes k= with skipNull:false', () => {
    expect(buildQuery({ a: undefined, b: null, c: 0, d: '' })).toBe('c=0&d=');
    expect(buildQuery({ a: undefined, b: null, c: 0 }, { skipNull: false })).toBe('b=&c=0');
  });

  it('formats arrays as repeat (default), comma or bracket', () => {
    const obj = { k: ['a', 'b c'], n: 1 };
    expect(buildQuery(obj)).toBe('k=a&k=b%20c&n=1');
    expect(buildQuery(obj, { arrayFormat: 'repeat' })).toBe('k=a&k=b%20c&n=1');
    expect(buildQuery(obj, { arrayFormat: 'comma' })).toBe('k=a,b%20c&n=1');
    expect(buildQuery(obj, { arrayFormat: 'bracket' })).toBe('k[]=a&k[]=b%20c&n=1');
  });

  it('emits nothing for empty arrays and filters null items', () => {
    expect(buildQuery({ k: [], n: 1 })).toBe('n=1');
    expect(buildQuery({ k: [null, undefined], n: 1 }, { arrayFormat: 'comma' })).toBe('n=1');
    expect(buildQuery({ k: ['a', null, 'b'] })).toBe('k=a&k=b');
    expect(buildQuery({ k: ['a', null] }, { skipNull: false })).toBe('k=a&k=');
  });

  it('serialises Dates as ISO strings and plain objects as JSON', () => {
    const d = new Date('2026-11-02T06:45:00Z');
    expect(buildQuery({ d })).toBe(`d=${encodeURIComponent(d.toISOString())}`);
    expect(buildQuery({ o: { a: 1 } })).toBe(`o=${encodeURIComponent('{"a":1}')}`);
    expect(buildQuery({ d: new Date('nope') })).toBe('d=');
  });

  it('percent-encodes RFC 3986 reserved characters that encodeURIComponent leaves alone', () => {
    expect(buildQuery({ q: "it's (ok)*!" })).toBe('q=it%27s%20%28ok%29%2A%21');
  });
});

describe('parseQuery', () => {
  it('parses with or without the leading ?', () => {
    expect(parseQuery('?a=1&b=two')).toEqual({ a: '1', b: 'two' });
    expect(parseQuery('a=1&b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('accepts a full URL or path and drops the fragment', () => {
    expect(parseQuery('https://api.ota.com/v1/x?a=1&b=2#frag')).toEqual({ a: '1', b: '2' });
    expect(parseQuery('/path?a=1')).toEqual({ a: '1' });
    expect(parseQuery('a=1#b=2')).toEqual({ a: '1' });
    expect(parseQuery('https://api.ota.com/v1/x')).toEqual({});
    expect(parseQuery('/flights/DEL-BOM')).toEqual({});
    expect(parseQuery('//cdn.ota.com/x.js#h')).toEqual({});
  });

  it('decodes percent-escapes and treats + as a space', () => {
    expect(parseQuery('q=x+y%20z&e=%C3%A9')).toEqual({ q: 'x y z', e: 'é' });
  });

  it('keeps the raw text when a percent-escape is malformed instead of throwing', () => {
    expect(parseQuery('q=%E0%A4%A&ok=1')).toEqual({ q: '%E0%A4%A', ok: '1' });
  });

  it('turns repeated keys and k[] keys into arrays', () => {
    expect(parseQuery('k=a&k=b&k=c')).toEqual({ k: ['a', 'b', 'c'] });
    expect(parseQuery('k[]=a')).toEqual({ k: ['a'] });
    expect(parseQuery('k[]=a&k[]=b')).toEqual({ k: ['a', 'b'] });
    expect(parseQuery('k%5B%5D=a&k%5B%5D=b')).toEqual({ k: ['a', 'b'] });
  });

  it('gives a key without = an empty string and skips empty parts', () => {
    expect(parseQuery('flag&a=1&&b=')).toEqual({ flag: '', a: '1', b: '' });
    expect(parseQuery('')).toEqual({});
    expect(parseQuery('?')).toEqual({});
    expect(parseQuery('   ')).toEqual({});
  });

  it('returns {} for non-string input', () => {
    expect(parseQuery(null)).toEqual({});
    expect(parseQuery(undefined)).toEqual({});
    expect(parseQuery(42)).toEqual({});
  });

  it('never writes prototype-pollution keys', () => {
    const out = parseQuery('__proto__=x&constructor=y&prototype=z&a=1&__proto__[]=w');
    expect(out).toEqual({ a: '1' });
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect({}.constructor).toBe(Object);
    // A literal key that merely starts with __proto__ is a harmless own property.
    const literal = parseQuery('__proto__[polluted]=1');
    expect(literal).toEqual({ '__proto__[polluted]': '1' });
    expect({}.polluted).toBeUndefined();
  });

  it('round-trips buildQuery output', () => {
    const q = { a: '1', b: 'x y&z', k: ['p', 'q'], e: 'é' };
    expect(parseQuery(buildQuery(q))).toEqual(q);
    expect(parseQuery(buildQuery(q, { arrayFormat: 'bracket' }))).toEqual(q);
  });
});

describe('joinUrl', () => {
  it('joins with exactly one slash whatever the inputs carry', () => {
    expect(joinUrl('https://api.ota.com/v1', 'flights/search')).toBe(
      'https://api.ota.com/v1/flights/search'
    );
    expect(joinUrl('https://api.ota.com/v1/', '/flights/search')).toBe(
      'https://api.ota.com/v1/flights/search'
    );
    expect(joinUrl('https://api.ota.com/v1//', '/flights')).toBe('https://api.ota.com/v1/flights');
    expect(joinUrl('https://api.ota.com/v1///', 'flights/')).toBe(
      'https://api.ota.com/v1/flights/'
    );
    expect(joinUrl('https://api.ota.com', 'v1')).toBe('https://api.ota.com/v1');
  });

  it('returns the path when absolute, the base when the path is empty', () => {
    expect(joinUrl('https://api.ota.com/v1', 'https://cdn.ota.com/x.js')).toBe(
      'https://cdn.ota.com/x.js'
    );
    expect(joinUrl('https://api.ota.com/v1', '//cdn.ota.com/x.js')).toBe('//cdn.ota.com/x.js');
    expect(joinUrl('https://api.ota.com/v1/', '')).toBe('https://api.ota.com/v1/');
    expect(joinUrl('https://api.ota.com/v1', null)).toBe('https://api.ota.com/v1');
    expect(joinUrl('', '/flights')).toBe('/flights');
    expect(joinUrl(undefined, 'flights')).toBe('flights');
  });

  it('appends a query or fragment path without a slash', () => {
    expect(joinUrl('https://api.ota.com/v1/', '?a=1')).toBe('https://api.ota.com/v1?a=1');
    expect(joinUrl('https://api.ota.com/v1', '#top')).toBe('https://api.ota.com/v1#top');
  });
});

describe('withParams', () => {
  it('appends params to a URL without a query', () => {
    expect(withParams('https://api.ota.com/v1/x', { a: 1, b: 'y z' })).toBe(
      'https://api.ota.com/v1/x?a=1&b=y%20z'
    );
    expect(withParams('/x', { a: [1, 2] })).toBe('/x?a=1&a=2');
  });

  it('merges with an existing query, replacing keys and keeping others, and preserves the hash', () => {
    expect(withParams('/x?a=1&b=2#frag', { b: 3, c: 4 })).toBe('/x?a=1&b=3&c=4#frag');
    expect(withParams('/x?k=1&k=2&z=0', { k: 9 })).toBe('/x?z=0&k=9');
    expect(withParams('/x?k[]=1&k[]=2&z=0', { k: ['a'] })).toBe('/x?z=0&k=a');
  });

  it('removes a key when its value is null or undefined', () => {
    expect(withParams('/x?a=1&b=2', { a: null })).toBe('/x?b=2');
    expect(withParams('/x?a=1', { a: undefined })).toBe('/x');
    expect(withParams('/x?a=1#h', { a: null })).toBe('/x#h');
  });

  it('returns the URL unchanged for empty or non-object params', () => {
    expect(withParams('/x?a=1', {})).toBe('/x?a=1');
    expect(withParams('/x?a=1', null)).toBe('/x?a=1');
    expect(withParams('/x', undefined)).toBe('/x');
    expect(withParams('/x', 'a=1')).toBe('/x');
    expect(withParams(null, { a: 1 })).toBe('?a=1');
  });
});

describe('isAbsoluteUrl', () => {
  it('recognises schemes and protocol-relative URLs', () => {
    expect(isAbsoluteUrl('https://api.ota.com')).toBe(true);
    expect(isAbsoluteUrl('HTTP://x')).toBe(true);
    expect(isAbsoluteUrl('mailto:a@b.c')).toBe(true);
    expect(isAbsoluteUrl('blob:https://x/y')).toBe(true);
    expect(isAbsoluteUrl('//cdn.ota.com/x.js')).toBe(true);
    expect(isAbsoluteUrl('  https://x  ')).toBe(true);
  });

  it('rejects relative paths, deep links and non-strings', () => {
    expect(isAbsoluteUrl('/flights/search')).toBe(false);
    expect(isAbsoluteUrl('flights/search')).toBe(false);
    expect(isAbsoluteUrl('DEL-BOM/2026-11-02?a=1')).toBe(false);
    expect(isAbsoluteUrl('?a=1')).toBe(false);
    expect(isAbsoluteUrl('')).toBe(false);
    expect(isAbsoluteUrl(null)).toBe(false);
    expect(isAbsoluteUrl(42)).toBe(false);
    expect(isAbsoluteUrl({})).toBe(false);
  });
});

describe('sameOrigin', () => {
  it('compares scheme, host and port of absolute URLs', () => {
    expect(sameOrigin('https://api.ota.com/a', 'https://api.ota.com/b?x=1')).toBe(true);
    expect(sameOrigin('https://API.ota.com/a', 'https://api.ota.com:443/b')).toBe(true);
    expect(sameOrigin('https://api.ota.com', 'http://api.ota.com')).toBe(false);
    expect(sameOrigin('https://api.ota.com', 'https://api.ota.com:8443')).toBe(false);
    expect(sameOrigin('https://api.ota.com', 'https://cdn.ota.com')).toBe(false);
  });

  it('treats two relative URLs as same-origin and a relative/absolute pair as not, without a browser', () => {
    expect(typeof window).toBe('undefined');
    expect(sameOrigin('/a', '/b')).toBe(true);
    expect(sameOrigin('a', '?x=1')).toBe(true);
    expect(sameOrigin('/a', 'https://api.ota.com/a')).toBe(false);
    expect(sameOrigin('https://api.ota.com/a', '/a')).toBe(false);
    expect(sameOrigin('//cdn.ota.com/x', '//cdn.ota.com/y')).toBe(false);
  });

  it('resolves relative URLs against window.location when a browser is present at call time', () => {
    vi.stubGlobal('window', { location: { href: 'https://app.ota.com/flights?x=1' } });
    expect(sameOrigin('/a', 'https://app.ota.com/b')).toBe(true);
    expect(sameOrigin('/a', 'https://api.ota.com/b')).toBe(false);
    expect(sameOrigin('/a', '/b')).toBe(true);
    expect(sameOrigin('//cdn.ota.com/x', 'https://cdn.ota.com/y')).toBe(true);
  });

  it('is false for unparsable input and opaque origins', () => {
    expect(sameOrigin('http://', 'http://')).toBe(false);
    expect(sameOrigin('mailto:a@b.c', 'mailto:a@b.c')).toBe(false);
    expect(sameOrigin('data:text/plain,a', 'data:text/plain,a')).toBe(false);
    expect(sameOrigin(null, undefined)).toBe(true);
  });
});

describe('encodeSearchParams', () => {
  const base = { passengers: { adults: 1, children: 0, infants: 0 }, cabin: 'economy' };

  it('encodes a one-way trip', () => {
    const out = encodeSearchParams({
      ...base,
      tripType: 'one_way',
      slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }],
    });
    expect(out).toBe('DEL-BOM/2026-11-02?a=1&cabin=Y');
  });

  it('encodes the documented round-trip example', () => {
    const out = encodeSearchParams({
      tripType: 'round_trip',
      slices: [
        { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
        { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
      ],
      passengers: { adults: 2, children: 1, infants: 0 },
      cabin: 'economy',
    });
    expect(out).toBe('DEL-BOM/2026-11-02/2026-11-09?a=2&c=1&cabin=Y');
  });

  it('encodes multi-city legs joined with +', () => {
    const out = encodeSearchParams({
      ...base,
      tripType: 'multi_city',
      slices: [
        { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
        { origin: 'BOM', destination: 'GOI', date: '2026-11-05' },
        { origin: 'GOI', destination: 'DEL', date: '2026-11-09' },
      ],
    });
    expect(out).toBe('DEL-BOM/2026-11-02+BOM-GOI/2026-11-05+GOI-DEL/2026-11-09?a=1&cabin=Y');
  });

  it('keeps a mirrored multi_city pair in the + form so the trip type survives', () => {
    const out = encodeSearchParams({
      ...base,
      tripType: 'multi_city',
      slices: [
        { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
        { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
      ],
    });
    expect(out).toBe('DEL-BOM/2026-11-02+BOM-DEL/2026-11-09?a=1&cabin=Y');
  });

  it('emits every documented query key', () => {
    const out = encodeSearchParams({
      tripType: 'round_trip',
      slices: [
        { origin: 'DEL', destination: 'DXB', date: '2026-12-20' },
        { origin: 'DXB', destination: 'DEL', date: '2027-01-03' },
      ],
      passengers: {
        adults: 2,
        children: 2,
        infants: 1,
        infantsSeated: 1,
        youth: 1,
        seniors: 1,
        childAges: [4, 9],
      },
      cabin: 'business',
      fareTypes: ['student', 'senior'],
      directOnly: true,
      maxStops: 1,
      includeNearby: true,
      resultMode: 'combined',
      currency: 'INR',
    });
    expect(out).toBe(
      'DEL-DXB/2026-12-20/2027-01-03?a=2&c=2&i=1&is=1&y=1&s=1&cabin=C&ft=student,senior&direct=1&stops=1&near=1&mode=c&cur=INR&ages=4,9'
    );
  });

  it('maps every cabin and result mode to its code', () => {
    const one = (extra) =>
      encodeSearchParams({
        ...base,
        ...extra,
        slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }],
      });
    expect(one({ cabin: 'economy' })).toContain('cabin=Y');
    expect(one({ cabin: 'premium_economy' })).toContain('cabin=W');
    expect(one({ cabin: 'business' })).toContain('cabin=C');
    expect(one({ cabin: 'first' })).toContain('cabin=F');
    expect(one({ resultMode: 'per_slice' })).toContain('mode=ps');
    expect(one({ resultMode: 'combined' })).toContain('mode=c');
  });

  it('omits mode when resultMode is unset so the default (split / per_slice) applies downstream', () => {
    const out = encodeSearchParams({
      ...base,
      slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }],
    });
    expect(out).not.toContain('mode=');
    expect(decodeSearchParams(out).resultMode).toBeUndefined();
  });

  it('uppercases codes and currency, infers tripType, and defaults passengers / cabin', () => {
    expect(
      encodeSearchParams({
        slices: [
          { origin: 'del', destination: ' bom ', date: '2026-11-02' },
          { origin: 'bom', destination: 'del', date: '2026-11-09' },
        ],
        currency: 'inr',
      })
    ).toBe('DEL-BOM/2026-11-02/2026-11-09?a=1&cabin=Y&cur=INR');
    expect(
      encodeSearchParams({
        slices: [
          { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
          { origin: 'BOM', destination: 'GOI', date: '2026-11-09' },
        ],
      })
    ).toBe('DEL-BOM/2026-11-02+BOM-GOI/2026-11-09?a=1&cabin=Y');
  });

  it('drops false flags and zero optional counts but keeps maxStops 0', () => {
    const out = encodeSearchParams({
      ...base,
      slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }],
      passengers: {
        adults: 1,
        children: 0,
        infants: 0,
        infantsSeated: 0,
        youth: 0,
        seniors: 0,
        childAges: [],
      },
      directOnly: false,
      includeNearby: false,
      maxStops: 0,
      fareTypes: [],
    });
    expect(out).toBe('DEL-BOM/2026-11-02?a=1&cabin=Y&stops=0');
  });

  it('rejects non-object input', () => {
    expectValidation(() => encodeSearchParams(null), '');
    expectValidation(() => encodeSearchParams('DEL-BOM/2026-11-02'), '');
    expectValidation(() => encodeSearchParams(undefined), '');
  });

  it('rejects missing or malformed slices with a path per issue', () => {
    expectValidation(() => encodeSearchParams({ ...base }), 'slices');
    expectValidation(() => encodeSearchParams({ ...base, slices: [] }), 'slices');
    const err = expectValidation(
      () =>
        encodeSearchParams({
          ...base,
          slices: [{ origin: 'DELHI', destination: 'B0M', date: '2026-13-02' }],
        }),
      'slices[0].origin'
    );
    const paths = err.issues.map((i) => i.path);
    expect(paths).toContain('slices[0].destination');
    expect(paths).toContain('slices[0].date');
    expectValidation(
      () =>
        encodeSearchParams({
          ...base,
          slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-02-30' }],
        }),
      'slices[0].date'
    );
    expectValidation(() => encodeSearchParams({ ...base, slices: [null] }), 'slices[0].origin');
    expectValidation(() => encodeSearchParams({ ...base, slices: 'DEL-BOM' }), 'slices');
  });

  it('rejects a tripType that disagrees with the slices', () => {
    const oneWay = [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }];
    const mirrored = [...oneWay, { origin: 'BOM', destination: 'DEL', date: '2026-11-09' }];
    const openJaw = [...oneWay, { origin: 'GOI', destination: 'DEL', date: '2026-11-09' }];
    expectValidation(
      () => encodeSearchParams({ ...base, tripType: 'one_way', slices: mirrored }),
      'slices'
    );
    expectValidation(
      () => encodeSearchParams({ ...base, tripType: 'round_trip', slices: oneWay }),
      'slices'
    );
    expectValidation(
      () => encodeSearchParams({ ...base, tripType: 'round_trip', slices: openJaw }),
      'slices[1]'
    );
    expectValidation(
      () => encodeSearchParams({ ...base, tripType: 'multi_city', slices: oneWay }),
      'slices'
    );
    expectValidation(
      () => encodeSearchParams({ ...base, tripType: 'circle', slices: oneWay }),
      'tripType'
    );
  });

  it('rejects bad passenger counts, cabin, fare types, stops, mode and currency', () => {
    const slices = [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }];
    const p = (extra) => ({ ...base, slices, ...extra });
    expectValidation(
      () => encodeSearchParams(p({ passengers: { adults: -1 } })),
      'passengers.adults'
    );
    expectValidation(
      () => encodeSearchParams(p({ passengers: { adults: 1.5 } })),
      'passengers.adults'
    );
    expectValidation(
      () => encodeSearchParams(p({ passengers: { adults: '2' } })),
      'passengers.adults'
    );
    expectValidation(
      () => encodeSearchParams(p({ passengers: { adults: 1, children: NaN } })),
      'passengers.children'
    );
    expectValidation(
      () => encodeSearchParams(p({ passengers: { adults: 1, childAges: [4, 'x'] } })),
      'passengers.childAges'
    );
    expectValidation(
      () => encodeSearchParams(p({ passengers: { adults: 1, childAges: 7 } })),
      'passengers.childAges'
    );
    expectValidation(() => encodeSearchParams(p({ cabin: 'coach' })), 'cabin');
    expectValidation(() => encodeSearchParams(p({ fareTypes: ['student', 'vip'] })), 'fareTypes');
    expectValidation(() => encodeSearchParams(p({ fareTypes: 'student' })), 'fareTypes');
    expectValidation(() => encodeSearchParams(p({ maxStops: 3 })), 'maxStops');
    expectValidation(() => encodeSearchParams(p({ resultMode: 'auto' })), 'resultMode');
    expectValidation(() => encodeSearchParams(p({ currency: 'RUPEES' })), 'currency');
    expectValidation(() => encodeSearchParams(p({ currency: 1 })), 'currency');
  });

  it('collects every issue in one error', () => {
    const err = expectValidation(() =>
      encodeSearchParams({
        tripType: 'nope',
        slices: [{ origin: 'X', destination: 'BOM', date: 'tomorrow' }],
        passengers: { adults: -1 },
        cabin: 'coach',
        currency: 'x',
      })
    );
    expect(err.issues.map((i) => i.path).sort()).toEqual(
      [
        'cabin',
        'currency',
        'passengers.adults',
        'slices[0].date',
        'slices[0].origin',
        'tripType',
      ].sort()
    );
    for (const issue of err.issues) {
      expect(typeof issue.code).toBe('string');
      expect(typeof issue.message).toBe('string');
    }
  });
});

describe('decodeSearchParams', () => {
  it('decodes the documented example', () => {
    expect(decodeSearchParams('DEL-BOM/2026-11-02/2026-11-09?a=2&c=1&cabin=Y')).toEqual({
      tripType: 'round_trip',
      slices: [
        { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
        { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
      ],
      passengers: { adults: 2, children: 1, infants: 0 },
      cabin: 'economy',
    });
  });

  it('applies defaults when the query is minimal or absent', () => {
    const expected = {
      tripType: 'one_way',
      slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }],
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'economy',
    };
    expect(decodeSearchParams('DEL-BOM/2026-11-02')).toEqual(expected);
    expect(decodeSearchParams('DEL-BOM/2026-11-02?')).toEqual(expected);
    expect(decodeSearchParams('/DEL-BOM/2026-11-02/')).toEqual(expected);
    expect(decodeSearchParams('  del-bom/2026-11-02#top  ')).toEqual(expected);
    expect(decodeSearchParams('DEL-BOM/2026-11-02?utm_source=mail&cabin=y')).toEqual(expected);
  });

  it('leaves resultMode unset when mode is absent (default is split / per_slice, decision 5)', () => {
    const out = decodeSearchParams('DEL-BOM/2026-11-02?a=1');
    expect(out).not.toHaveProperty('resultMode');
    expect(decodeSearchParams('DEL-BOM/2026-11-02?mode=ps').resultMode).toBe('per_slice');
    expect(decodeSearchParams('DEL-BOM/2026-11-02?mode=c').resultMode).toBe('combined');
  });

  it('decodes multi-city legs, including a percent-encoded +', () => {
    const expected = {
      tripType: 'multi_city',
      slices: [
        { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
        { origin: 'BOM', destination: 'GOI', date: '2026-11-05' },
      ],
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'economy',
    };
    expect(decodeSearchParams('DEL-BOM/2026-11-02+BOM-GOI/2026-11-05')).toEqual(expected);
    expect(decodeSearchParams('DEL-BOM/2026-11-02%2BBOM-GOI/2026-11-05')).toEqual(expected);
    expect(decodeSearchParams('DEL-BOM/2026-11-02+BOM-DEL/2026-11-09').tripType).toBe('multi_city');
  });

  it('decodes every documented query key', () => {
    expect(
      decodeSearchParams(
        'DEL-DXB/2026-12-20/2027-01-03?a=2&c=2&i=1&is=1&y=1&s=1&cabin=c&ft=student,senior&direct=1&stops=1&near=1&mode=c&cur=inr&ages=4,9'
      )
    ).toEqual({
      tripType: 'round_trip',
      slices: [
        { origin: 'DEL', destination: 'DXB', date: '2026-12-20' },
        { origin: 'DXB', destination: 'DEL', date: '2027-01-03' },
      ],
      passengers: {
        adults: 2,
        children: 2,
        infants: 1,
        infantsSeated: 1,
        youth: 1,
        seniors: 1,
        childAges: [4, 9],
      },
      cabin: 'business',
      fareTypes: ['student', 'senior'],
      directOnly: true,
      maxStops: 1,
      includeNearby: true,
      resultMode: 'combined',
      currency: 'INR',
    });
    expect(decodeSearchParams('DEL-BOM/2026-11-02?direct=0&near=0&stops=0')).toMatchObject({
      directOnly: false,
      includeNearby: false,
      maxStops: 0,
    });
  });

  it('round-trips encodeSearchParams for every trip shape', () => {
    const cases = [
      {
        tripType: 'one_way',
        slices: [{ origin: 'DEL', destination: 'BOM', date: '2026-11-02' }],
        passengers: { adults: 1, children: 0, infants: 0 },
        cabin: 'economy',
      },
      {
        tripType: 'round_trip',
        slices: [
          { origin: 'BLR', destination: 'SIN', date: '2026-12-24' },
          { origin: 'SIN', destination: 'BLR', date: '2027-01-02' },
        ],
        passengers: { adults: 2, children: 1, infants: 1, infantsSeated: 1, childAges: [6] },
        cabin: 'premium_economy',
        fareTypes: ['regular'],
        maxStops: 2,
        resultMode: 'per_slice',
        currency: 'SGD',
      },
      {
        tripType: 'multi_city',
        slices: [
          { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
          { origin: 'BOM', destination: 'GOI', date: '2026-11-05' },
          { origin: 'GOI', destination: 'DEL', date: '2026-11-09' },
        ],
        passengers: { adults: 3, children: 0, infants: 0, youth: 2, seniors: 1 },
        cabin: 'first',
        fareTypes: ['student', 'senior', 'armed_forces', 'doctor', 'corporate', 'youth'],
        directOnly: true,
        maxStops: 0,
        includeNearby: true,
        resultMode: 'combined',
        currency: 'INR',
      },
      {
        tripType: 'multi_city',
        slices: [
          { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
          { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
        ],
        passengers: { adults: 1, children: 0, infants: 0 },
        cabin: 'business',
      },
    ];
    for (const p of cases) {
      const encoded = encodeSearchParams(p);
      const decoded = decodeSearchParams(encoded);
      expect(decoded).toEqual(p);
      expect(encodeSearchParams(decoded)).toBe(encoded);
    }
  });

  it('returns null for malformed paths', () => {
    for (const bad of [
      '',
      '   ',
      '/',
      '?a=1',
      'DEL-BOM',
      'DEL-BOM/',
      'DELHI-BOM/2026-11-02',
      'DEL_BOM/2026-11-02',
      'DEL-B0M/2026-11-02',
      'DEL-BOM/2026-13-02',
      'DEL-BOM/2026-02-30',
      'DEL-BOM/2026-2-3',
      'DEL-BOM/20261102',
      'DEL-BOM/2026-11-02/2026-11-31',
      'DEL-BOM/2026-11-02/2026-11-09/2026-11-10',
      'DEL-BOM/2026-11-02+',
      '+DEL-BOM/2026-11-02',
      'DEL-BOM/2026-11-02++BOM-DEL/2026-11-09',
      'DEL-BOM/2026-11-02+BOM-DEL/2026-11-09/2026-11-10',
      'DEL-BOM/2026-11-02+BOM-DEL',
      'DEL-BOM/2026-11-02/2026-11-09+BOM-DEL/2026-11-10',
      'DEL-BOM%E0%A4%A/2026-11-02',
      'flights/DEL-BOM/2026-11-02',
    ]) {
      expect(decodeSearchParams(bad), bad).toBeNull();
    }
  });

  it('returns null for malformed query values', () => {
    for (const bad of [
      'a=0.5',
      'a=-1',
      'a=two',
      'a=',
      'c=x',
      'i=1.0',
      'is=-1',
      'y=1e2',
      's=%20',
      'cabin=Z',
      'cabin=',
      'cabin=economy',
      'ft=vip',
      'ft=student,',
      'ft=',
      'ft=student,,senior',
      'direct=yes',
      'direct=true',
      'near=2',
      'stops=3',
      'stops=-1',
      'stops=one',
      'mode=auto',
      'mode=per_slice',
      'mode=',
      'cur=RS',
      'cur=INR1',
      'cur=',
      'ages=4,x',
      'ages=',
      'ages=4,',
      'ages=4.5',
      'a=1&a=2',
      'cabin=Y&cabin=C',
      'ft[]=student',
    ]) {
      expect(decodeSearchParams(`DEL-BOM/2026-11-02?${bad}`), bad).toBeNull();
    }
  });

  it('returns null for non-string input', () => {
    expect(decodeSearchParams(null)).toBeNull();
    expect(decodeSearchParams(undefined)).toBeNull();
    expect(decodeSearchParams(42)).toBeNull();
    expect(decodeSearchParams({ tripType: 'one_way' })).toBeNull();
  });

  it('never throws', () => {
    for (const input of ['%', '%%%', 'DEL-BOM/%ZZ', '\u0000', 'DEL-BOM/2026-11-02?%=%']) {
      expect(() => decodeSearchParams(input)).not.toThrow();
    }
  });
});

describe('encodeState / decodeState', () => {
  const state = {
    returnTo: '/flights/DEL-BOM/2026-11-02?a=2',
    itineraryId: 'itn_123',
    nested: { list: [1, 'two', null, true], empty: {} },
    unicode: 'दिल्ली → मुंबई ✈️ 東京 🌏 “quotes” ü',
  };

  it('produces unpadded base64url (URL-safe characters only)', () => {
    const encoded = encodeState(state);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('round-trips objects, arrays and unicode', () => {
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(decodeState(encodeState({}))).toEqual({});
    expect(decodeState(encodeState([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(decodeState(encodeState({ s: '🌏'.repeat(50) }))).toEqual({ s: '🌏'.repeat(50) });
    for (const len of [0, 1, 2, 3, 4, 5]) {
      const obj = { s: 'é'.repeat(len) };
      expect(decodeState(encodeState(obj))).toEqual(obj);
    }
  });

  it('encodes as standard base64url of the UTF-8 JSON bytes', () => {
    const encoded = encodeState({ a: 'é' });
    expect(encoded).toBe(
      Buffer.from(JSON.stringify({ a: 'é' }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    );
    expect(encodeState({ a: 1 })).toBe('eyJhIjoxfQ');
  });

  it('also accepts standard base64, padding and surrounding whitespace', () => {
    const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
    expect(b64).toMatch(/[+/=]/);
    expect(decodeState(b64)).toEqual(state);
    expect(decodeState(`  ${encodeState(state)}\n`)).toEqual(state);
    expect(decodeState('eyJhIjoxfQ==')).toEqual({ a: 1 });
  });

  it('returns null for anything that is not base64url JSON', () => {
    for (const bad of [
      '',
      '   ',
      '!!!',
      'e',
      'eyJhIjoxfQ*',
      'bm90IGpzb24',
      'eyJhIjo',
      'IjEi',
      'MQ',
      'bnVsbA',
      'dHJ1ZQ',
      Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString('base64'),
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3]).toString('base64'),
    ]) {
      expect(decodeState(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(decodeState(null)).toBeNull();
    expect(decodeState(undefined)).toBeNull();
    expect(decodeState(42)).toBeNull();
    expect(decodeState({})).toBeNull();
  });

  it('throws ValidationError for values that are not JSON-serialisable', () => {
    const circular = {};
    circular.self = circular;
    expectValidation(() => encodeState(circular), '');
    expectValidation(() => encodeState({ n: 10n }), '');
    expectValidation(() => encodeState(undefined), '');
    expectValidation(() => encodeState(() => {}), '');
    const err = expectValidation(() => encodeState(circular));
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('works without TextEncoder / TextDecoder', () => {
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    expect(typeof TextEncoder).toBe('undefined');
    const encoded = encodeState(state);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeState(encoded)).toEqual(state);
    expect(decodeState(Buffer.from([0xff, 0xfe, 0x7b, 0x7d]).toString('base64'))).toBeNull();
  });

  it('fallback and native paths agree byte for byte', () => {
    const native = encodeState(state);
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    expect(encodeState(state)).toBe(native);
    expect(decodeState(native)).toEqual(state);
  });
});

describe('currentUrlParams', () => {
  it('returns {} outside a browser', () => {
    expect(typeof window).toBe('undefined');
    expect(currentUrlParams()).toEqual({});
  });

  it('returns {} when window has no usable location', () => {
    vi.stubGlobal('window', {});
    expect(currentUrlParams()).toEqual({});
    vi.stubGlobal('window', { location: {} });
    expect(currentUrlParams()).toEqual({});
    vi.stubGlobal('window', { location: { search: 7, hash: null } });
    expect(currentUrlParams()).toEqual({});
  });

  it('reads window.location at call time, not at import time', () => {
    const location = { search: '?a=1&b=x+y', hash: '' };
    vi.stubGlobal('window', { location });
    expect(currentUrlParams()).toEqual({ a: '1', b: 'x y' });
    location.search = '?code=abc&state=xyz';
    expect(currentUrlParams()).toEqual({ code: 'abc', state: 'xyz' });
    vi.unstubAllGlobals();
    expect(currentUrlParams()).toEqual({});
  });

  it('merges fragment parameters, with query-string values winning', () => {
    vi.stubGlobal('window', { location: { search: '?a=1', hash: '#code=frag&a=2' } });
    expect(currentUrlParams()).toEqual({ a: '1', code: 'frag' });
    vi.stubGlobal('window', { location: { search: '', hash: '#/callback?token=t1&x=1' } });
    expect(currentUrlParams()).toEqual({ token: 't1', x: '1' });
    vi.stubGlobal('window', { location: { search: '?a=1', hash: '#section-2' } });
    expect(currentUrlParams()).toEqual({ a: '1' });
    vi.stubGlobal('window', { location: { search: '?k=1&k=2', hash: '#?z=9' } });
    expect(currentUrlParams()).toEqual({ k: ['1', '2'], z: '9' });
  });

  it('does not read window at import time (module already loaded without one)', async () => {
    expect(typeof window).toBe('undefined');
    const fresh = await import('../../src/utils/url.js');
    expect(fresh.currentUrlParams()).toEqual({});
  });
});
