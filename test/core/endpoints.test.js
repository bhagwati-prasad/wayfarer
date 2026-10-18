import { describe, it, expect } from 'vitest';
import { createEndpoints, DEFAULT_ENDPOINTS } from '../../src/core/endpoints.js';
import { ConfigError } from '../../src/errors/index.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PLACEHOLDER_RE = /\{([A-Za-z_$][\w$]*)\}/g;

/** Names of the `{...}` placeholders in a template. */
function placeholders(path) {
  return [...path.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/** Call `fn`, assert it throws a ConfigError and return it. */
function expectConfigError(fn) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect(caught).toBeInstanceOf(Error);
  expect(caught.code).toBe('CONFIG_ERROR');
  return caught;
}

/** Keys the docs make Amadeus-backed, with the path each must resolve to. */
const AMADEUS = {
  'search.create': ['POST', '/v2/shopping/flight-offers'],
  'search.createGet': ['GET', '/v2/shopping/flight-offers'],
  'search.createQuick': ['GET', '/v2/shopping/flight-offers'],
  'offers.reprice': ['POST', '/v1/shopping/flight-offers/pricing'],
  'itinerary.reprice': ['POST', '/v1/shopping/flight-offers/pricing'],
  'itinerary.price': ['POST', '/v1/shopping/flight-offers/pricing'],
  'offers.combine': ['POST', '/v1/shopping/flight-offers/pricing'],
  'offers.brandedFares': ['POST', '/v1/shopping/flight-offers/upselling'],
  'offers.availability': ['POST', '/v1/shopping/availability/flight-availabilities'],
  'search.availability': ['POST', '/v1/shopping/availability/flight-availabilities'],
  'booking.create': ['POST', '/v1/booking/flight-orders'],
  'booking.hold': ['POST', '/v1/booking/flight-orders'],
  'booking.get': ['GET', '/v1/booking/flight-orders/{id}'],
  'trips.get': ['GET', '/v1/booking/flight-orders/{id}'],
  'booking.abandon': ['DELETE', '/v1/booking/flight-orders/{id}'],
  'trips.void': ['DELETE', '/v1/booking/flight-orders/{id}'],
  'trips.requests.updateContact': ['PATCH', '/v1/booking/flight-orders/{id}'],
  'trips.requests.updateDocuments': ['PATCH', '/v1/booking/flight-orders/{id}'],
  'booking.patch': ['PATCH', '/v1/booking/flight-orders/{id}'],
  'booking.finalize': ['POST', '/v1/booking/flight-orders/{id}/issuance'],
  'booking.issue': ['POST', '/v1/booking/flight-orders/{id}/issuance'],
  'booking.retrieve': ['GET', '/v1/booking/flight-orders/by-reference'],
  'trips.byReference': ['GET', '/v1/booking/flight-orders/by-reference'],
};

/** A representative sample of SDK-defined (`/v1`-prefixed) paths from the module docs. */
const SDK_PATHS = {
  'places.search': ['GET', '/v1/places/search'],
  'places.get': ['GET', '/v1/places/{code}'],
  'places.airlines.get': ['GET', '/v1/airlines/{code}'],
  'content.policy': ['GET', '/v1/content/policies/{key}'],
  'search.poll': ['GET', '/v1/flights/search/{id}'],
  'search.stream': ['GET', '/v1/flights/search/{id}/stream'],
  'search.nearbyAlternatives': ['GET', '/v1/flights/search/{id}/alternatives'],
  'search.calendar': ['GET', '/v1/flights/prices/calendar'],
  'offers.fareRules': ['GET', '/v1/flights/offers/{id}/fare-rules'],
  'itinerary.create': ['POST', '/v1/itineraries'],
  'itinerary.setTravelers': ['PUT', '/v1/itineraries/{id}/travelers'],
  'itinerary.removePromo': ['DELETE', '/v1/itineraries/{id}/promo'],
  'itinerary.fromLock': ['POST', '/v1/price-locks/{id}/itinerary'],
  'travelers.documents.add': ['POST', '/v1/me/travelers/{id}/documents'],
  'travelers.documents.remove': ['DELETE', '/v1/me/travelers/{id}/documents/{docId}'],
  'ancillaries.seats.map': ['GET', '/v1/itineraries/{id}/seatmaps/{segmentId}'],
  'ancillaries.remove': ['DELETE', '/v1/itineraries/{id}/ancillaries/{selectionId}'],
  'booking.holdOptions': ['GET', '/v1/itineraries/{id}/hold-options'],
  'booking.download': ['GET', '/v1/bookings/{id}/documents/{type}'],
  'payments.createIntent': ['POST', '/v1/bookings/{id}/payments'],
  'payments.confirm': ['POST', '/v1/payments/{id}/confirm'],
  'payments.savedMethods.remove': ['DELETE', '/v1/me/payment-methods/{id}'],
  'trips.list': ['GET', '/v1/me/trips'],
  'trips.changes.quote': ['POST', '/v1/bookings/{id}/changes/quote'],
  'trips.changes.confirm': ['POST', '/v1/bookings/{id}/changes/{quoteId}/confirm'],
  'trips.cancellation.confirm': ['POST', '/v1/bookings/{id}/cancellations/{quoteId}/confirm'],
  'trips.disruptions.respond': ['POST', '/v1/bookings/{id}/disruptions/{did}/respond'],
  'trips.requests.other': ['POST', '/v1/bookings/{id}/requests'],
  'support.tickets.reply': ['POST', '/v1/support/tickets/{id}/messages'],
  'account.me': ['GET', '/v1/me'],
  'account.consents.set': ['PUT', '/v1/me/consents'],
  'account.requestPasswordReset': ['POST', '/v1/auth/password/forgot'],
  'wallet.coupons.validate': ['POST', '/v1/promos/validate'],
  'wallet.giftCards.check': ['POST', '/v1/gift-cards/check'],
  'alerts.createGuest': ['POST', '/v1/alerts/guest'],
  'alerts.savedSearches.remove': ['DELETE', '/v1/me/saved-searches/{id}'],
};

const MODULES = [
  'account',
  'alerts',
  'ancillaries',
  'booking',
  'content',
  'itinerary',
  'offers',
  'payments',
  'places',
  'search',
  'support',
  'travelers',
  'trips',
  'wallet',
];

describe('module surface', () => {
  it('exports createEndpoints and a frozen DEFAULT_ENDPOINTS table', () => {
    expect(typeof createEndpoints).toBe('function');
    expect(Object.isFrozen(DEFAULT_ENDPOINTS)).toBe(true);
    for (const entry of Object.values(DEFAULT_ENDPOINTS)) expect(Object.isFrozen(entry)).toBe(true);
  });

  it('returns the documented API', () => {
    const endpoints = createEndpoints();
    expect(Object.keys(endpoints).sort()).toEqual(['all', 'get', 'has', 'set']);
    for (const fn of Object.values(endpoints)) expect(typeof fn).toBe('function');
  });
});

describe('DEFAULT_ENDPOINTS', () => {
  const keys = Object.keys(DEFAULT_ENDPOINTS);

  it('has a sorted, duplicate-free key list', () => {
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(200);
  });

  it('uses module.function keys with a known module prefix', () => {
    for (const key of keys) {
      expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/);
      expect(MODULES, key).toContain(key.split('.')[0]);
    }
  });

  it('covers every module', () => {
    for (const mod of MODULES) {
      expect(
        keys.some((k) => k.startsWith(`${mod}.`)),
        mod
      ).toBe(true);
    }
  });

  it('gives every entry a valid { method, path } with a version prefix and well-formed placeholders', () => {
    for (const [key, entry] of Object.entries(DEFAULT_ENDPOINTS)) {
      expect(Object.keys(entry).sort(), key).toEqual(['method', 'path']);
      expect(METHODS, key).toContain(entry.method);
      expect(entry.path, key).toMatch(/^\/v[12]\/[a-z]/);
      expect(entry.path, key).not.toMatch(/\s|\/\/|\/$/);
      // every '{' opens a '{name}' placeholder
      expect(entry.path.replace(PLACEHOLDER_RE, ''), key).not.toMatch(/[{}]/);
    }
  });

  it('contains the Amadeus-backed paths with their version prefix', () => {
    for (const [key, [method, path]] of Object.entries(AMADEUS)) {
      expect(DEFAULT_ENDPOINTS[key], key).toEqual({ method, path });
    }
  });

  it('prefixes every other documented path with /v1', () => {
    for (const [key, [method, path]] of Object.entries(SDK_PATHS)) {
      expect(DEFAULT_ENDPOINTS[key], key).toEqual({ method, path });
    }
    const amadeusKeys = new Set(Object.keys(AMADEUS));
    for (const [key, entry] of Object.entries(DEFAULT_ENDPOINTS)) {
      if (!amadeusKeys.has(key)) expect(entry.path, key).toMatch(/^\/v1\//);
    }
  });

  it('is never mutated by instances', () => {
    const snapshot = JSON.stringify(DEFAULT_ENDPOINTS);
    const endpoints = createEndpoints({ 'search.create': '/custom' });
    endpoints.set('booking.get', { method: 'POST', path: '/x/{id}' });
    endpoints.set('custom.thing', '/v1/custom');
    expect(JSON.stringify(DEFAULT_ENDPOINTS)).toBe(snapshot);
    expect(DEFAULT_ENDPOINTS['custom.thing']).toBeUndefined();
  });
});

describe('get', () => {
  it('resolves every default key once its placeholders are supplied', () => {
    const endpoints = createEndpoints();
    for (const [key, entry] of Object.entries(DEFAULT_ENDPOINTS)) {
      const names = placeholders(entry.path);
      const params = Object.fromEntries(names.map((n, i) => [n, `${n}-${i}`]));
      const path = endpoints.get(key, params);
      expect(path, key).not.toMatch(/[{}]/);
      expect(path.startsWith(entry.path.split('{')[0]), key).toBe(true);
      for (const [i, n] of names.entries()) expect(path, key).toContain(`${n}-${i}`);
    }
  });

  it('returns the template verbatim when it has no placeholders and ignores params', () => {
    const endpoints = createEndpoints();
    expect(endpoints.get('search.create')).toBe('/v2/shopping/flight-offers');
    expect(endpoints.get('search.create', { origin: 'DEL', adults: 2 })).toBe(
      '/v2/shopping/flight-offers'
    );
    expect(endpoints.get('places.search', null)).toBe('/v1/places/search');
    expect(endpoints.get('places.search', undefined)).toBe('/v1/places/search');
  });

  it('fills {id}-style placeholders and URL-encodes the values', () => {
    const endpoints = createEndpoints();
    const orderId = 'eJzTd%2FUP8=+/w==';
    expect(endpoints.get('booking.get', { id: orderId })).toBe(
      `/v1/booking/flight-orders/${encodeURIComponent(orderId)}`
    );
    expect(endpoints.get('booking.get', { id: orderId })).not.toContain('=');
    expect(endpoints.get('ancillaries.seats.map', { id: 'it 1', segmentId: 'S/1' })).toBe(
      '/v1/itineraries/it%201/seatmaps/S%2F1'
    );
    expect(endpoints.get('trips.disruptions.respond', { id: 'b1', did: 'd?2' })).toBe(
      '/v1/bookings/b1/disruptions/d%3F2/respond'
    );
    expect(endpoints.get('places.get', { code: 'DEL' })).toBe('/v1/places/DEL');
  });

  it('accepts numbers and booleans and ignores extra params', () => {
    const endpoints = createEndpoints();
    expect(endpoints.get('alerts.get', { id: 42, extra: 'x' })).toBe('/v1/me/alerts/42');
    expect(endpoints.get('alerts.get', { id: true })).toBe('/v1/me/alerts/true');
  });

  it('throws ConfigError for an unknown key', () => {
    const endpoints = createEndpoints();
    for (const key of ['search.nope', 'nope', '', undefined, null, 42]) {
      const error = expectConfigError(() => endpoints.get(key));
      expect(error.message).toMatch(/unknown endpoint key/i);
      expect(error.details).toEqual({ key });
    }
  });

  it('throws ConfigError naming the missing placeholders', () => {
    const endpoints = createEndpoints();
    const error = expectConfigError(() => endpoints.get('ancillaries.seats.map', { id: 'it1' }));
    expect(error.message).toContain('segmentId');
    expect(error.details).toMatchObject({
      key: 'ancillaries.seats.map',
      template: '/v1/itineraries/{id}/seatmaps/{segmentId}',
      missing: ['segmentId'],
    });
    expect(expectConfigError(() => endpoints.get('booking.get')).details.missing).toEqual(['id']);
    expect(expectConfigError(() => endpoints.get('booking.get', {})).details.missing).toEqual([
      'id',
    ]);
  });

  it('treats null and empty-string values as missing and objects / NaN as invalid', () => {
    const endpoints = createEndpoints();
    expect(
      expectConfigError(() => endpoints.get('booking.get', { id: null })).details.missing
    ).toEqual(['id']);
    expect(
      expectConfigError(() => endpoints.get('booking.get', { id: '' })).details.missing
    ).toEqual(['id']);
    expect(
      expectConfigError(() => endpoints.get('booking.get', { id: { a: 1 } })).details.invalid
    ).toEqual(['id']);
    expect(
      expectConfigError(() => endpoints.get('booking.get', { id: NaN })).details.invalid
    ).toEqual(['id']);
    expect(
      expectConfigError(() => endpoints.get('booking.get', { id: ['a'] })).details.invalid
    ).toEqual(['id']);
  });

  it('throws ConfigError when params is not an object', () => {
    const endpoints = createEndpoints();
    expectConfigError(() => endpoints.get('booking.get', 'abc'));
    expectConfigError(() => endpoints.get('booking.get', 42));
    expectConfigError(() => endpoints.get('booking.get', ['abc']));
  });
});

describe('createEndpoints(overrides)', () => {
  it('applies string overrides keeping the default method', () => {
    const endpoints = createEndpoints({
      'search.create': '/v3/search',
      'booking.get': '/v1/orders/{id}',
    });
    expect(endpoints.all()['search.create']).toEqual({ method: 'POST', path: '/v3/search' });
    expect(endpoints.get('booking.get', { id: 'o1' })).toBe('/v1/orders/o1');
    expect(endpoints.all()['booking.get'].method).toBe('GET');
    // untouched keys stay as default
    expect(endpoints.get('places.search')).toBe('/v1/places/search');
  });

  it('applies { method, path } overrides (method case-insensitive) and adds new keys', () => {
    const endpoints = createEndpoints({
      'search.create': { method: 'put', path: '/v3/search' },
      'custom.ping': '/v1/ping',
      'custom.echo': { method: 'POST', path: '/v1/echo/{word}' },
    });
    expect(endpoints.all()['search.create']).toEqual({ method: 'PUT', path: '/v3/search' });
    expect(endpoints.has('custom.ping')).toBe(true);
    expect(endpoints.all()['custom.ping']).toEqual({ method: 'GET', path: '/v1/ping' });
    expect(endpoints.get('custom.echo', { word: 'hi there' })).toBe('/v1/echo/hi%20there');
  });

  it('accepts absolute URLs and trims whitespace', () => {
    const endpoints = createEndpoints({ 'search.create': ' https://other.example/v9/search ' });
    expect(endpoints.get('search.create')).toBe('https://other.example/v9/search');
    endpoints.set('search.poll', '//cdn.example/search/{id}');
    expect(endpoints.get('search.poll', { id: 1 })).toBe('//cdn.example/search/1');
  });

  it('accepts undefined / null overrides', () => {
    expect(createEndpoints().get('account.me')).toBe('/v1/me');
    expect(createEndpoints(undefined).get('account.me')).toBe('/v1/me');
    expect(createEndpoints(null).get('account.me')).toBe('/v1/me');
    expect(createEndpoints({}).get('account.me')).toBe('/v1/me');
  });

  it('rejects invalid overrides with ConfigError', () => {
    expectConfigError(() => createEndpoints('search.create=/x'));
    expectConfigError(() => createEndpoints(['/x']));
    expectConfigError(() => createEndpoints({ 'search.create': 'no-leading-slash' }));
    expectConfigError(() => createEndpoints({ 'search.create': '' }));
    expectConfigError(() => createEndpoints({ 'search.create': 42 }));
    expectConfigError(() => createEndpoints({ 'search.create': null }));
    expectConfigError(() => createEndpoints({ 'search.create': { path: '/x', method: 'FETCH' } }));
    expectConfigError(() => createEndpoints({ 'search.create': { method: 'GET' } }));
    expectConfigError(() => createEndpoints({ 'search.create': { method: 7, path: '/x' } }));
    expectConfigError(() => createEndpoints({ 'search.create': '/x/{bad-name}' }));
    expectConfigError(() => createEndpoints({ 'search.create': '/x/{unclosed' }));
    expectConfigError(() => createEndpoints({ 'bad key': '/x' }));
    expectConfigError(() => createEndpoints({ '': '/x' }));
    expectConfigError(() => createEndpoints({ 'a..b': '/x' }));
  });

  it('refuses prototype-polluting keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expectConfigError(() => createEndpoints({ [key]: '/x' }));
      expectConfigError(() => createEndpoints().set(key, '/x'));
    }
    expect(createEndpoints().has('__proto__')).toBe(false);
    expect(createEndpoints().has('constructor')).toBe(false);
  });
});

describe('set / has / all', () => {
  it('set replaces an existing template and adds new keys', () => {
    const endpoints = createEndpoints();
    endpoints.set('booking.get', '/v1/orders/{id}');
    expect(endpoints.get('booking.get', { id: 'o' })).toBe('/v1/orders/o');
    expect(endpoints.all()['booking.get'].method).toBe('GET'); // kept
    endpoints.set('booking.get', { method: 'POST', path: '/v1/orders/lookup' });
    expect(endpoints.all()['booking.get']).toEqual({ method: 'POST', path: '/v1/orders/lookup' });
    endpoints.set('booking.get', '/v1/orders/again');
    expect(endpoints.all()['booking.get'].method).toBe('POST'); // string keeps the current method
    expect(endpoints.has('x.y')).toBe(false);
    endpoints.set('x.y', '/v1/x/y');
    expect(endpoints.has('x.y')).toBe(true);
    expect(endpoints.get('x.y')).toBe('/v1/x/y');
  });

  it('set validates key and template', () => {
    const endpoints = createEndpoints();
    expectConfigError(() => endpoints.set('', '/x'));
    expectConfigError(() => endpoints.set(42, '/x'));
    expectConfigError(() => endpoints.set('a.b', 'x'));
    expectConfigError(() => endpoints.set('a.b', {}));
    expectConfigError(() => endpoints.set('a.b', { method: 'TRACE', path: '/x' }));
    expect(endpoints.has('a.b')).toBe(false);
  });

  it('has reports known and unknown keys without throwing', () => {
    const endpoints = createEndpoints();
    expect(endpoints.has('search.create')).toBe(true);
    expect(endpoints.has('trips.requests.updateContact')).toBe(true);
    expect(endpoints.has('search.nope')).toBe(false);
    expect(endpoints.has('')).toBe(false);
    expect(endpoints.has(undefined)).toBe(false);
    expect(endpoints.has(42)).toBe(false);
  });

  it('all returns a frozen, sorted snapshot that includes overrides', () => {
    const endpoints = createEndpoints({ 'zz.last': '/v1/zz', 'aa.first': '/v1/aa' });
    const table = endpoints.all();
    expect(Object.isFrozen(table)).toBe(true);
    const keys = Object.keys(table);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe('aa.first');
    expect(keys[keys.length - 1]).toBe('zz.last');
    expect(keys.length).toBe(Object.keys(DEFAULT_ENDPOINTS).length + 2);
    // a snapshot: later changes do not leak into it
    endpoints.set('search.create', '/v9/search');
    expect(table['search.create'].path).toBe('/v2/shopping/flight-offers');
    expect(endpoints.all()['search.create'].path).toBe('/v9/search');
  });

  it('all equals DEFAULT_ENDPOINTS for an untouched instance', () => {
    expect(createEndpoints().all()).toEqual(DEFAULT_ENDPOINTS);
  });

  it('instances are independent of each other', () => {
    const a = createEndpoints();
    const b = createEndpoints();
    a.set('search.create', '/a/search');
    expect(b.get('search.create')).toBe('/v2/shopping/flight-offers');
    expect(a.get('search.create')).toBe('/a/search');
  });
});
