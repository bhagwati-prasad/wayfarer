import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import {
  createTelemetry,
  bindDomainEvents,
  ga4Adapter,
  gtmAdapter,
  segmentAdapter,
  consoleAdapter,
  beaconAdapter,
} from '../../src/utils/telemetry.js';
import { createEmitter } from '../../src/events/emitter.js';
import { ConfigError, ValidationError } from '../../src/errors/index.js';

// ── helpers / fixtures ───────────────────────────────────────────────────────────────────────────

/** A spy adapter; `extras` adds optional methods (`page`, `identify`, `flush`). */
function adapter(name = 'spy', extras = {}) {
  return { name, track: vi.fn(), ...extras };
}

/** A spy adapter that implements every optional method. */
function fullAdapter(name = 'full') {
  return adapter(name, { page: vi.fn(), identify: vi.fn(), flush: vi.fn() });
}

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

const money = (amount, currency = 'INR') => ({ amount, currency });

function price({
  total = '9000.00',
  perPax = '4500.00',
  taxes = '1000.00',
  currency = 'INR',
} = {}) {
  return {
    total: money(total, currency),
    base: money('8000.00', currency),
    taxes: money(taxes, currency),
    fees: money('0.00', currency),
    perPax: money(perPax, currency),
  };
}

function offer(id, { legs = [['DEL', 'BOM']], airline = '6E', ...priceOpts } = {}) {
  return {
    id,
    owner: { code: airline, name: 'Airline' },
    slices: legs.map(([o, d], i) => ({
      id: `${id}-s${i}`,
      origin: { code: o },
      destination: { code: d },
      segments: [],
    })),
    price: price(priceOpts),
    passengers: [],
    baggage: { items: [] },
    conditions: { refundable: false, changeable: true },
    tags: [],
    expiresAt: '2026-11-02T06:45:00+05:30',
  };
}

const ITEM_1 = {
  item_id: 'of_1',
  item_name: 'DEL-BOM',
  item_brand: '6E',
  price: 4500,
  currency: 'INR',
};

function itinerary(extra = {}) {
  return {
    id: 'it_1',
    status: 'active',
    offers: [offer('of_1')],
    passengers: { adults: 2, children: 0, infants: 0 },
    slots: [],
    price: price(),
    ancillaries: [],
    expiresAt: '2026-10-17T12:00:00+05:30',
    createdAt: '2026-10-17T11:30:00+05:30',
    ...extra,
  };
}

function booking(extra = {}) {
  return {
    id: 'bk_1',
    reference: 'WF123ABC',
    type: 'flight',
    status: 'ticketed',
    airlineLocators: [],
    tickets: [],
    itinerary: itinerary(),
    travelers: [],
    contact: {},
    payment: { total: money('9200.00'), paid: money('9200.00'), due: money('0.00'), methods: [] },
    createdAt: '2026-10-17T11:40:00+05:30',
    documents: [],
    availableActions: [],
    protections: [],
    ...extra,
  };
}

/** Telemetry + spy adapter + real emitter, wired together. */
function rig(options = {}) {
  const events = createEmitter();
  const a = fullAdapter();
  const tracked = [];
  events.on('telemetry:track', (p) => tracked.push(p));
  const telemetry = createTelemetry({ adapters: [a], events, ...options });
  return { telemetry, a, events, tracked };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── createTelemetry ──────────────────────────────────────────────────────────────────────────────

describe('createTelemetry', () => {
  it('returns the documented surface with sane defaults', () => {
    const t = createTelemetry();
    for (const k of [
      'track',
      'page',
      'identify',
      'timing',
      'setContext',
      'setConsent',
      'addAdapter',
      'flush',
    ]) {
      expect(typeof t[k]).toBe('function');
    }
    expect(t.enabled).toBe(true);
    expect(t.consent).toBe(true);
    expect(t.sampleRate).toBe(1);
    expect(t.context).toEqual({});
    expect(t.adapters).toEqual([]);
  });

  it('accepts undefined options and registers initial adapters once each', () => {
    const a = adapter('a');
    const b = adapter('b');
    expect(() => createTelemetry(undefined)).not.toThrow();
    const t = createTelemetry({ adapters: [a, b, a] });
    expect(t.adapters).toEqual(['a', 'b']);
  });

  it.each([
    [null],
    ['nope'],
    [[]],
    [{ enabled: 'yes' }],
    [{ consent: 1 }],
    [{ sampleRate: 2 }],
    [{ sampleRate: -0.1 }],
    [{ sampleRate: NaN }],
    [{ sampleRate: '0.5' }],
    [{ context: [] }],
    [{ context: 'ctx' }],
    [{ random: 0.5 }],
    [{ events: {} }],
    [{ events: 'bus' }],
    [{ logger: 'log' }],
    [{ logger: [] }],
    [{ adapters: {} }],
    [{ adapters: [null] }],
    [{ adapters: [{ name: 'x' }] }],
    [{ adapters: [{ track() {} }] }],
    [{ adapters: [{ name: '', track() {} }] }],
    [{ adapters: [{ name: 'x', track() {}, page: 1 }] }],
    [{ adapters: [{ name: 'x', track() {}, flush: 'now' }] }],
  ])('rejects bad options with ConfigError: %j', (options) => {
    expect(() => createTelemetry(options)).toThrow(ConfigError);
  });

  it('treats null option values as "use the default"', () => {
    const t = createTelemetry({
      enabled: null,
      consent: null,
      sampleRate: null,
      context: null,
      random: null,
      events: null,
      logger: null,
      adapters: null,
    });
    expect(t.enabled).toBe(true);
    expect(t.consent).toBe(true);
    expect(t.sampleRate).toBe(1);
  });
});

// ── track / page / identify / timing ─────────────────────────────────────────────────────────────

describe('telemetry.track', () => {
  it('fans out to every adapter in order with the context merged under the props', () => {
    const first = adapter('first');
    const second = adapter('second');
    const order = [];
    first.track.mockImplementation(() => order.push('first'));
    second.track.mockImplementation(() => order.push('second'));
    const t = createTelemetry({
      adapters: [first, second],
      context: { app: { name: 'ota-web', version: '1.0' }, market: 'IN' },
    });
    expect(t.track('select_item', { market: 'US', app: { screen: 'results' } })).toBe(true);
    const expected = {
      app: { name: 'ota-web', version: '1.0', screen: 'results' },
      market: 'US',
    };
    expect(first.track).toHaveBeenCalledWith('select_item', expected);
    expect(second.track).toHaveBeenCalledWith('select_item', expected);
    expect(order).toEqual(['first', 'second']);
  });

  it('emits telemetry:track on the injected emitter with { kind, event, props }', () => {
    const { telemetry, tracked } = rig({ context: { market: 'IN' } });
    telemetry.track('view_item', { id: 'x' });
    expect(tracked).toEqual([
      {
        type: 'telemetry:track',
        at: expect.any(Number),
        kind: 'track',
        event: 'view_item',
        props: { market: 'IN', id: 'x' },
      },
    ]);
  });

  it('emits even when no adapter is registered and works without an emitter', () => {
    const events = createEmitter();
    const seen = vi.fn();
    events.on('telemetry:track', seen);
    const t = createTelemetry({ events });
    expect(t.track('x')).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    const lonely = createTelemetry();
    expect(lonely.track('x', { a: 1 })).toBe(true);
  });

  it('props default to {} and never leak the context object by reference', () => {
    const a = adapter();
    const t = createTelemetry({ adapters: [a], context: { market: 'IN' } });
    t.track('x');
    const received = a.track.mock.calls[0][1];
    expect(received).toEqual({ market: 'IN' });
    received.market = 'MUTATED';
    expect(t.context).toEqual({ market: 'IN' });
  });

  it('hands every adapter its own copy: a mutating sink cannot affect the next one or the bus', () => {
    const vandal = adapter('vandal');
    vandal.track.mockImplementation((_event, props) => {
      delete props.email;
      props.items[0].item_id = 'hacked';
      props.app.name = 'hacked';
    });
    const witness = adapter('witness');
    const { telemetry, tracked } = rig({ context: { app: { name: 'web' } } });
    telemetry.addAdapter(vandal);
    telemetry.addAdapter(witness);
    const input = { email: 'a@b.c', items: [{ item_id: 'of_1' }] };
    expect(telemetry.track('x', input)).toBe(true);
    const expected = { app: { name: 'web' }, email: 'a@b.c', items: [{ item_id: 'of_1' }] };
    expect(vandal.track).toHaveBeenCalledTimes(1);
    expect(witness.track).toHaveBeenCalledWith('x', expected);
    expect(tracked[0].props).toEqual(expected);
    expect(input).toEqual({ email: 'a@b.c', items: [{ item_id: 'of_1' }] });
    expect(telemetry.context).toEqual({ app: { name: 'web' } });
  });

  it('never pollutes prototypes through __proto__ / constructor keys in props or context', () => {
    const a = adapter();
    const t = createTelemetry({ adapters: [a] });
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"ok":1}'
    );
    expect(t.track('x', hostile)).toBe(true);
    expect('polluted' in {}).toBe(false);
    expect(a.track).toHaveBeenCalledWith('x', { ok: 1 });
    expect(Object.getPrototypeOf(a.track.mock.calls[0][1])).toBe(Object.prototype);
    t.setContext(JSON.parse('{"__proto__":{"polluted":true},"market":"IN"}'));
    expect('polluted' in {}).toBe(false);
    expect(t.context).toEqual({ market: 'IN' });
    expect(Object.getPrototypeOf(t.context)).toBe(Object.prototype);
  });

  it.each([
    ['', 'event'],
    ['   ', 'event'],
    [42, 'event'],
    [undefined, 'event'],
  ])('rejects event %j with a ValidationError on %s', (event, path) => {
    const t = createTelemetry();
    let caught;
    try {
      t.track(event);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.issues).toEqual([{ path, code: 'type', message: expect.any(String) }]);
  });

  it('rejects non-plain props with a ValidationError on props', () => {
    const t = createTelemetry();
    expect(() => t.track('x', 'props')).toThrow(ValidationError);
    expect(() => t.track('x', [1])).toThrow(ValidationError);
    expect(() => t.track('x', new Date())).toThrow(ValidationError);
    expect(() => t.track('x', null)).not.toThrow();
  });
});

describe('telemetry.page', () => {
  it('calls page() on adapters that have it and falls back to track("page_view") otherwise', () => {
    const withPage = fullAdapter('with');
    const without = adapter('without');
    const { telemetry, tracked } = rig({ context: { market: 'IN' } });
    telemetry.addAdapter(withPage);
    telemetry.addAdapter(without);
    expect(telemetry.page('results', { path: '/results' })).toBe(true);
    expect(withPage.page).toHaveBeenCalledWith('results', { market: 'IN', path: '/results' });
    expect(withPage.track).not.toHaveBeenCalled();
    expect(without.track).toHaveBeenCalledWith('page_view', {
      market: 'IN',
      path: '/results',
      name: 'results',
    });
    expect(tracked[0]).toMatchObject({ kind: 'page', event: 'results' });
  });

  it('validates its arguments', () => {
    const t = createTelemetry();
    expect(() => t.page('')).toThrow(ValidationError);
    expect(() => t.page('home', 'x')).toThrow(ValidationError);
  });
});

describe('telemetry.identify', () => {
  it('reaches only adapters with identify(), stringifies numeric ids and skips the context', () => {
    const { telemetry, a, tracked } = rig({ context: { market: 'IN' } });
    const plain = adapter('plain');
    telemetry.addAdapter(plain);
    expect(telemetry.identify(42, { plan: 'gold' })).toBe(true);
    expect(a.identify).toHaveBeenCalledWith('42', { plan: 'gold' });
    expect(plain.track).not.toHaveBeenCalled();
    expect(tracked[0]).toMatchObject({ kind: 'identify', event: '42', props: { plan: 'gold' } });
    telemetry.identify('u_1');
    expect(a.identify).toHaveBeenLastCalledWith('u_1', {});
  });

  it('hands adapters a detached copy of the traits', () => {
    const { telemetry, a } = rig();
    const traits = { plan: 'gold', groups: [{ id: 1 }] };
    telemetry.identify('u_1', traits);
    const received = a.identify.mock.calls[0][1];
    expect(received).toEqual(traits);
    expect(received).not.toBe(traits);
    received.groups[0].id = 2;
    received.plan = 'hacked';
    expect(traits).toEqual({ plan: 'gold', groups: [{ id: 1 }] });
  });

  it('validates its arguments', () => {
    const t = createTelemetry();
    for (const bad of ['', '  ', NaN, Infinity, null, undefined, {}]) {
      expect(() => t.identify(bad)).toThrow(ValidationError);
    }
    expect(() => t.identify('u', 'traits')).toThrow(ValidationError);
  });
});

describe('telemetry.timing', () => {
  it('delivers track("timing_complete", { name, value }) with rounded ms and merged context', () => {
    const { telemetry, a, tracked } = rig({ context: { market: 'IN' } });
    expect(telemetry.timing('http_request', 123.6, { path: '/search', name: 'ignored' })).toBe(
      true
    );
    expect(a.track).toHaveBeenCalledWith('timing_complete', {
      market: 'IN',
      path: '/search',
      name: 'http_request',
      value: 124,
    });
    expect(tracked[0]).toMatchObject({ kind: 'timing', event: 'timing_complete' });
  });

  it('validates its arguments', () => {
    const t = createTelemetry();
    expect(() => t.timing('', 1)).toThrow(ValidationError);
    for (const bad of [-1, NaN, Infinity, '12', undefined]) {
      let caught;
      try {
        t.timing('x', bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect(caught.issues[0].path).toBe('ms');
    }
    expect(() => t.timing('x', 1, 'props')).toThrow(ValidationError);
  });
});

// ── gates: enabled / consent / sampling ──────────────────────────────────────────────────────────

describe('gates', () => {
  it('enabled=false drops every call (no fan-out, no emit) but flush still forwards', async () => {
    const { telemetry, a, tracked } = rig({ enabled: false });
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.track('x')).toBe(false);
    expect(telemetry.page('p')).toBe(false);
    expect(telemetry.identify('u')).toBe(false);
    expect(telemetry.timing('t', 1)).toBe(false);
    expect(a.track).not.toHaveBeenCalled();
    expect(a.page).not.toHaveBeenCalled();
    expect(a.identify).not.toHaveBeenCalled();
    expect(tracked).toEqual([]);
    await telemetry.flush();
    expect(a.flush).toHaveBeenCalledTimes(1);
  });

  it('consent=false drops everything except flush, without buffering, until setConsent(true)', async () => {
    const { telemetry, a, tracked } = rig({ consent: false });
    expect(telemetry.consent).toBe(false);
    expect(telemetry.track('dropped')).toBe(false);
    expect(telemetry.page('dropped')).toBe(false);
    expect(telemetry.identify('dropped')).toBe(false);
    expect(telemetry.timing('dropped', 1)).toBe(false);
    await telemetry.flush();
    expect(a.flush).toHaveBeenCalledTimes(1);
    telemetry.setConsent(true);
    expect(telemetry.consent).toBe(true);
    // nothing recorded while consent was off is replayed
    expect(a.track).not.toHaveBeenCalled();
    expect(tracked).toEqual([]);
    expect(telemetry.track('kept')).toBe(true);
    expect(a.track).toHaveBeenCalledTimes(1);
    telemetry.setConsent(false);
    expect(telemetry.track('dropped again')).toBe(false);
    expect(a.track).toHaveBeenCalledTimes(1);
  });

  it('setConsent requires a boolean', () => {
    const t = createTelemetry();
    for (const bad of ['yes', 1, null, undefined]) {
      expect(() => t.setConsent(bad)).toThrow(ValidationError);
    }
    expect(t.consent).toBe(true);
  });

  it('samples track() and timing() per call through random(); page() and identify() always pass', () => {
    const random = vi.fn();
    const { telemetry, a, tracked } = rig({ sampleRate: 0.5, random });
    random.mockReturnValueOnce(0.49);
    expect(telemetry.track('kept')).toBe(true);
    random.mockReturnValueOnce(0.5);
    expect(telemetry.track('dropped')).toBe(false);
    random.mockReturnValueOnce(0.99);
    expect(telemetry.timing('dropped', 10)).toBe(false);
    random.mockReturnValueOnce(0.1);
    expect(telemetry.timing('kept', 10)).toBe(true);
    expect(random).toHaveBeenCalledTimes(4);
    expect(telemetry.page('always')).toBe(true);
    expect(telemetry.identify('always')).toBe(true);
    expect(random).toHaveBeenCalledTimes(4);
    expect(a.track.mock.calls.map((c) => c[0])).toEqual(['kept', 'timing_complete']);
    expect(tracked.map((p) => p.kind)).toEqual(['track', 'timing', 'page', 'identify']);
  });

  it('never consults random() at a rate of 1, drops everything at 0 and fails open on a broken random()', () => {
    const random = vi.fn(() => 0.9);
    const full = createTelemetry({ adapters: [adapter()], sampleRate: 1, random });
    expect(full.track('x')).toBe(true);
    const none = createTelemetry({ adapters: [adapter()], sampleRate: 0, random });
    expect(none.track('x')).toBe(false);
    expect(random).not.toHaveBeenCalled();
    const broken = createTelemetry({
      sampleRate: 0.5,
      random: () => {
        throw new TypeError('no entropy');
      },
    });
    expect(broken.track('x')).toBe(true);
    const nan = createTelemetry({ sampleRate: 0.5, random: () => 'nope' });
    expect(nan.track('x')).toBe(true);
  });

  it('defaults random to Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const t = createTelemetry({ sampleRate: 0.5 });
    expect(t.track('x')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── context ──────────────────────────────────────────────────────────────────────────────────────

describe('telemetry.setContext', () => {
  it('deep-merges, removes keys set to undefined and exposes a copy', () => {
    const a = adapter();
    const t = createTelemetry({ adapters: [a], context: { app: { name: 'web' }, market: 'IN' } });
    t.setContext({ app: { version: '2' }, locale: 'en-IN', market: undefined });
    expect(t.context).toEqual({ app: { name: 'web', version: '2' }, locale: 'en-IN' });
    const copy = t.context;
    copy.app.name = 'mutated';
    expect(t.context.app.name).toBe('web');
    t.track('x', { locale: 'en-US' });
    expect(a.track).toHaveBeenCalledWith('x', {
      app: { name: 'web', version: '2' },
      locale: 'en-US',
    });
  });

  it("never aliases the caller's context or partial, even through arrays of objects", () => {
    const a = adapter();
    const initial = { tags: [{ k: 'a' }], app: { name: 'web' } };
    const t = createTelemetry({ adapters: [a], context: initial });
    initial.tags[0].k = 'mutated';
    initial.app.name = 'mutated';
    expect(t.context).toEqual({ tags: [{ k: 'a' }], app: { name: 'web' } });
    const partial = { extra: [{ n: 1 }] };
    t.setContext(partial);
    partial.extra[0].n = 2;
    expect(t.context.extra).toEqual([{ n: 1 }]);
    t.track('x');
    const received = a.track.mock.calls[0][1];
    received.tags[0].k = 'hacked';
    received.extra[0].n = 99;
    expect(t.context).toEqual({ tags: [{ k: 'a' }], app: { name: 'web' }, extra: [{ n: 1 }] });
    const copy = t.context;
    copy.tags[0].k = 'copy';
    expect(t.context.tags[0].k).toBe('a');
  });

  it('rejects anything but a plain object', () => {
    const t = createTelemetry();
    for (const bad of [undefined, null, 'ctx', [], 1]) {
      expect(() => t.setContext(bad)).toThrow(ValidationError);
    }
  });
});

// ── adapters registry ────────────────────────────────────────────────────────────────────────────

describe('telemetry.addAdapter', () => {
  it('registers, dedupes and returns an idempotent remover', () => {
    const t = createTelemetry();
    const a = adapter('a');
    const b = adapter('b');
    const removeA = t.addAdapter(a);
    const removeADup = t.addAdapter(a);
    t.addAdapter(b);
    expect(t.adapters).toEqual(['a', 'b']);
    t.track('x');
    expect(a.track).toHaveBeenCalledTimes(1);
    removeA();
    removeA();
    expect(t.adapters).toEqual(['b']);
    t.track('y');
    expect(a.track).toHaveBeenCalledTimes(1);
    expect(b.track).toHaveBeenCalledTimes(2);
    removeADup();
    expect(t.adapters).toEqual(['b']);
  });

  it('rejects malformed adapters with a ValidationError on adapter', () => {
    const t = createTelemetry();
    for (const bad of [
      null,
      'ga4',
      {},
      { name: 'x' },
      { name: '', track() {} },
      { name: 'x', track: 'fn' },
      { name: 'x', track() {}, identify: {} },
    ]) {
      let caught;
      try {
        t.addAdapter(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect(caught.issues[0].path).toBe('adapter');
    }
    expect(t.adapters).toEqual([]);
  });

  it('an adapter removed mid fan-out still receives the event in flight', () => {
    const t = createTelemetry();
    const b = adapter('b');
    const a = adapter('a');
    let removeB;
    a.track.mockImplementation(() => removeB());
    t.addAdapter(a);
    removeB = t.addAdapter(b);
    t.track('x');
    expect(b.track).toHaveBeenCalledTimes(1);
    t.track('y');
    expect(b.track).toHaveBeenCalledTimes(1);
  });

  it('serves an adapter that tracks from inside track() re-entrantly, in a stable order', () => {
    const t = createTelemetry();
    const seen = [];
    const nested = adapter('nested');
    nested.track.mockImplementation((event) => {
      seen.push(`nested:${event}`);
      if (event === 'outer') expect(t.track('inner')).toBe(true);
    });
    const other = adapter('other');
    other.track.mockImplementation((event) => seen.push(`other:${event}`));
    t.addAdapter(nested);
    t.addAdapter(other);
    expect(t.track('outer')).toBe(true);
    expect(seen).toEqual(['nested:outer', 'nested:inner', 'other:inner', 'other:outer']);
  });
});

// ── failure isolation ────────────────────────────────────────────────────────────────────────────

describe('failure isolation', () => {
  it('a throwing adapter never breaks the caller, the other adapters or the emit', () => {
    const logger = fakeLogger();
    const boom = adapter('boom', {
      page: vi.fn(() => {
        throw new RangeError('page broke');
      }),
    });
    boom.track.mockImplementation(() => {
      throw new TypeError('track broke');
    });
    const { telemetry, a, tracked } = rig({ logger });
    telemetry.addAdapter(boom);
    telemetry.addAdapter(adapter('after'));
    expect(telemetry.track('x')).toBe(true);
    expect(telemetry.page('p')).toBe(true);
    expect(a.track).toHaveBeenCalledTimes(1);
    expect(telemetry.adapters).toEqual(['full', 'boom', 'after']);
    expect(tracked).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("'boom' failed on track"),
      { adapter: 'boom', kind: 'track', error: expect.any(TypeError) }
    );
    expect(logger.warn).toHaveBeenNthCalledWith(2, expect.stringContaining('page'), {
      adapter: 'boom',
      kind: 'page',
      error: expect.any(RangeError),
    });
  });

  it('works without a logger, with an error-only logger and with a throwing logger', () => {
    const boom = adapter('boom');
    boom.track.mockImplementation(() => {
      throw new Error('x');
    });
    expect(() => createTelemetry({ adapters: [boom] }).track('x')).not.toThrow();
    const errorOnly = { error: vi.fn() };
    createTelemetry({ adapters: [boom], logger: errorOnly }).track('x');
    expect(errorOnly.error).toHaveBeenCalledTimes(1);
    const throwing = {
      warn: () => {
        throw new Error('logger down');
      },
    };
    expect(() => createTelemetry({ adapters: [boom], logger: throwing }).track('x')).not.toThrow();
    expect(() => createTelemetry({ adapters: [boom], logger: {} }).track('x')).not.toThrow();
  });

  it('an event bus that throws on emit is reported and does not stop delivery', () => {
    const logger = fakeLogger();
    const a = adapter();
    const events = {
      emit: vi.fn(() => {
        throw new Error('bus down');
      }),
    };
    const t = createTelemetry({ adapters: [a], events, logger });
    expect(t.track('x')).toBe(true);
    expect(a.track).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('telemetry:track'), {
      error: expect.any(Error),
    });
  });
});

// ── flush ────────────────────────────────────────────────────────────────────────────────────────

describe('telemetry.flush', () => {
  it('calls every flush(), awaits promises and resolves to undefined', async () => {
    let resolveSlow;
    const slow = adapter('slow', {
      flush: vi.fn(() => new Promise((r) => (resolveSlow = r))),
    });
    const sync = adapter('sync', { flush: vi.fn() });
    const none = adapter('none');
    const t = createTelemetry({ adapters: [slow, sync, none] });
    let settled = false;
    const done = t.flush().then((v) => {
      settled = true;
      return v;
    });
    await Promise.resolve();
    expect(slow.flush).toHaveBeenCalledTimes(1);
    expect(sync.flush).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    resolveSlow();
    await expect(done).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('never rejects: throwing and rejecting flushes are reported', async () => {
    const logger = fakeLogger();
    const throwing = adapter('throwing', {
      flush: () => {
        throw new Error('sync');
      },
    });
    const rejecting = adapter('rejecting', { flush: () => Promise.reject(new Error('async')) });
    const ok = adapter('ok', { flush: vi.fn() });
    const t = createTelemetry({ adapters: [throwing, rejecting, ok], logger });
    await expect(t.flush()).resolves.toBeUndefined();
    expect(ok.flush).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map((c) => c[1].adapter).sort()).toEqual([
      'rejecting',
      'throwing',
    ]);
    expect(logger.warn.mock.calls.every((c) => c[1].kind === 'flush')).toBe(true);
  });

  it('resolves with no adapters', async () => {
    await expect(createTelemetry().flush()).resolves.toBeUndefined();
  });
});

// ── bindDomainEvents ─────────────────────────────────────────────────────────────────────────────

describe('bindDomainEvents', () => {
  function bound(options = {}) {
    const r = rig(options);
    const off = bindDomainEvents(r.telemetry, r.events);
    return { ...r, off };
  }

  const lastTrack = (a) => a.track.mock.calls.at(-1);

  it('validates its arguments', () => {
    const events = createEmitter();
    const t = createTelemetry();
    expect(() => bindDomainEvents({}, events)).toThrow(ValidationError);
    expect(() => bindDomainEvents(null, events)).toThrow(ValidationError);
    expect(() => bindDomainEvents(t, {})).toThrow(ValidationError);
    expect(() => bindDomainEvents(t, null)).toThrow(ValidationError);
    expect(events.listenerCount()).toBe(0);
  });

  it('subscribes to exactly the seven mapped events and off() removes them all, idempotently', () => {
    const { events, off, a } = bound();
    expect(events.listenerCount()).toBe(8); // 7 domain listeners + the test's telemetry:track spy
    for (const name of [
      'search:complete',
      'offer:selected',
      'itinerary:created',
      'booking:created',
      'payment:intentCreated',
      'booking:ticketed',
      'trip:cancelled',
    ]) {
      expect(events.listenerCount(name)).toBe(1);
    }
    expect(typeof off).toBe('function');
    off();
    off();
    expect(events.listenerCount()).toBe(1);
    events.emit('booking:ticketed', { booking: booking() });
    expect(a.track).not.toHaveBeenCalled();
  });

  it('ignores every other SDK event', () => {
    const { events, a } = bound();
    for (const name of [
      'search:start',
      'search:results',
      'offer:deselected',
      'booking:confirmed',
      'payment:succeeded',
      'trip:changed',
      'state:change',
    ]) {
      events.emit(name, { booking: booking() });
    }
    expect(a.track).not.toHaveBeenCalled();
  });

  it('search:complete (combined) → view_item_list with indexed items and the route as list name', () => {
    const { events, a } = bound();
    const session = {
      id: 'ss_1',
      status: 'complete',
      resultMode: 'combined',
      params: {
        tripType: 'round_trip',
        slices: [
          { origin: 'DEL', destination: 'BOM', date: '2026-11-02' },
          { origin: 'BOM', destination: 'DEL', date: '2026-11-09' },
        ],
      },
      offers: [
        offer('of_1', {
          legs: [
            ['DEL', 'BOM'],
            ['BOM', 'DEL'],
          ],
        }),
        offer('of_2', { airline: 'AI', perPax: '5100.50', currency: 'USD' }),
      ],
    };
    events.emit('search:complete', { session });
    expect(lastTrack(a)).toEqual([
      'view_item_list',
      {
        item_list_id: 'ss_1',
        item_list_name: 'DEL-BOM / BOM-DEL',
        items: [
          { ...ITEM_1, item_name: 'DEL-BOM / BOM-DEL', index: 0 },
          {
            item_id: 'of_2',
            item_name: 'DEL-BOM',
            item_brand: 'AI',
            price: 5100.5,
            currency: 'USD',
            index: 1,
          },
        ],
      },
    ]);
  });

  it('search:complete (per_slice, the default split mode) flattens sliceOffers[][]', () => {
    const { events, a } = bound();
    const session = {
      id: 'ss_2',
      resultMode: 'per_slice',
      params: { slices: [{ origin: { code: 'DEL' }, destination: { code: 'BOM' } }] },
      offers: [],
      sliceOffers: [[offer('out_1'), offer('out_2')], [offer('in_1', { legs: [['BOM', 'DEL']] })]],
    };
    events.emit('search:complete', session); // the module may emit the session itself
    const [name, props] = lastTrack(a);
    expect(name).toBe('view_item_list');
    expect(props.item_list_id).toBe('ss_2');
    expect(props.item_list_name).toBe('DEL-BOM');
    expect(props.items.map((i) => [i.item_id, i.index])).toEqual([
      ['out_1', 0],
      ['out_2', 1],
      ['in_1', 2],
    ]);
    expect(props.items[2].item_name).toBe('BOM-DEL');
  });

  it('reads the store-shaped { byId, allIds } offers map and caps lists at 200 items', () => {
    const { events, a } = bound();
    const allIds = Array.from({ length: 250 }, (_, i) => `of_${i}`);
    const byId = Object.fromEntries(allIds.map((id) => [id, offer(id)]));
    events.emit('search:complete', { sessionId: 'ss_3', offers: { byId, allIds } });
    const [, props] = lastTrack(a);
    expect(props.item_list_id).toBe('ss_3');
    expect(props.items).toHaveLength(200);
    expect(props.items[199]).toMatchObject({ item_id: 'of_199', index: 199 });
  });

  it('survives payloads without offers and skips unreadable entries', () => {
    const { events, a } = bound();
    events.emit('search:complete', { session: { id: 'ss_4', offers: [null, {}, offer('ok')] } });
    expect(lastTrack(a)).toEqual([
      'view_item_list',
      { item_list_id: 'ss_4', items: [{ ...ITEM_1, item_id: 'ok', index: 0 }] },
    ]);
    events.emit('search:complete');
    expect(lastTrack(a)).toEqual(['view_item_list', { items: [] }]);
  });

  it('offer:selected → select_item with the offer (and index) or just the id', () => {
    const { events, a } = bound();
    events.emit('offer:selected', { offer: offer('of_1'), sessionId: 'ss_1', index: 3 });
    expect(lastTrack(a)).toEqual([
      'select_item',
      { item_list_id: 'ss_1', items: [{ ...ITEM_1, index: 3 }] },
    ]);
    events.emit('offer:selected', { offerId: 'of_9', sliceIndex: 1 });
    expect(lastTrack(a)).toEqual(['select_item', { items: [{ item_id: 'of_9' }] }]);
    events.emit('offer:selected', offer('of_1'));
    expect(lastTrack(a)).toEqual(['select_item', { items: [ITEM_1] }]);
  });

  it('itinerary:created → add_to_cart with total, coupon and items', () => {
    const { events, a } = bound();
    const it = itinerary({
      promo: { code: 'SAVE10', label: '10% off', discount: money('900.00') },
    });
    events.emit('itinerary:created', { itinerary: it });
    expect(lastTrack(a)).toEqual([
      'add_to_cart',
      { currency: 'INR', value: 9000, coupon: 'SAVE10', items: [{ ...ITEM_1, index: 0 }] },
    ]);
    events.emit('itinerary:created', itinerary());
    expect(lastTrack(a)).toEqual([
      'add_to_cart',
      { currency: 'INR', value: 9000, items: [{ ...ITEM_1, index: 0 }] },
    ]);
  });

  it('booking:created → begin_checkout from the booked itinerary', () => {
    const { events, a } = bound();
    events.emit('booking:created', { booking: booking({ status: 'pending_payment' }) });
    expect(lastTrack(a)).toEqual([
      'begin_checkout',
      { currency: 'INR', value: 9000, items: [{ ...ITEM_1, index: 0 }] },
    ]);
  });

  it('payment:intentCreated → add_payment_info with amount and payment_type, items when known', () => {
    const { events, a } = bound();
    const intent = {
      id: 'pi_1',
      bookingId: 'bk_1',
      status: 'requires_confirmation',
      amount: money('9200.00'),
      method: { type: 'upi', gateway: 'razorpay' },
      createdAt: '2026-10-17T11:45:00+05:30',
    };
    events.emit('payment:intentCreated', { intent });
    expect(lastTrack(a)).toEqual([
      'add_payment_info',
      { currency: 'INR', value: 9200, payment_type: 'upi', items: [] },
    ]);
    events.emit('payment:intentCreated', { intent, booking: booking() });
    expect(lastTrack(a)).toEqual([
      'add_payment_info',
      { currency: 'INR', value: 9200, payment_type: 'upi', items: [{ ...ITEM_1, index: 0 }] },
    ]);
    events.emit('payment:intentCreated', intent);
    expect(lastTrack(a)[1]).toMatchObject({ value: 9200, payment_type: 'upi' });
  });

  it('booking:ticketed → purchase with reference, paid total, tax and items', () => {
    const { events, a } = bound();
    events.emit('booking:ticketed', { booking: booking() });
    expect(lastTrack(a)).toEqual([
      'purchase',
      {
        transaction_id: 'WF123ABC',
        currency: 'INR',
        value: 9200,
        tax: 1000,
        items: [{ ...ITEM_1, index: 0 }],
      },
    ]);
    const bare = booking({ reference: undefined, payment: undefined });
    events.emit('booking:ticketed', bare);
    expect(lastTrack(a)[1]).toMatchObject({ transaction_id: 'bk_1', value: 9000 });
  });

  it('trip:cancelled → refund with the refunded amount when known', () => {
    const { events, a } = bound();
    const trip = { ...booking({ status: 'cancelled' }), phase: 'cancelled' };
    const cancellation = {
      id: 'cx_1',
      bookingId: 'bk_1',
      status: 'cancelled',
      refund: {
        id: 'rf_1',
        bookingId: 'bk_1',
        amount: money('7500.00'),
        method: 'original',
        status: 'processing',
      },
    };
    events.emit('trip:cancelled', { trip, cancellation });
    expect(lastTrack(a)).toEqual([
      'refund',
      {
        transaction_id: 'WF123ABC',
        currency: 'INR',
        value: 7500,
        items: [{ ...ITEM_1, index: 0 }],
      },
    ]);
    events.emit('trip:cancelled', { bookingId: 'bk_2' });
    expect(lastTrack(a)).toEqual(['refund', { transaction_id: 'bk_2', items: [] }]);
    events.emit('trip:cancelled', { booking: booking() });
    expect(lastTrack(a)[1]).toEqual({
      transaction_id: 'WF123ABC',
      currency: 'INR',
      items: [{ ...ITEM_1, index: 0 }],
    });
  });

  it('goes through the telemetry gates and emits telemetry:track', () => {
    const { events, a, telemetry, tracked } = bound({ consent: false });
    events.emit('booking:ticketed', { booking: booking() });
    expect(a.track).not.toHaveBeenCalled();
    expect(tracked).toEqual([]);
    telemetry.setConsent(true);
    events.emit('booking:ticketed', { booking: booking() });
    expect(a.track).toHaveBeenCalledTimes(1);
    expect(tracked[0]).toMatchObject({ kind: 'track', event: 'purchase' });
  });

  it('a throwing adapter during a domain event neither throws nor becomes an error event', () => {
    const logger = fakeLogger();
    const { events, telemetry } = bound({ logger });
    const errors = vi.fn();
    events.on('error', errors);
    const boom = adapter('boom');
    boom.track.mockImplementation(() => {
      throw new Error('ga down');
    });
    telemetry.addAdapter(boom);
    expect(() => events.emit('itinerary:created', { itinerary: itinerary() })).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a payload the mapper cannot read still counts as the commerce event, never as an error event', () => {
    const { events, a } = bound();
    const errors = vi.fn();
    events.on('error', errors);
    const unreadable = {
      id: 'of_x',
      slices: [],
      price: { perPax: { amount: Symbol('not a number'), currency: 'INR' } },
    };
    expect(() =>
      events.emit('search:complete', { session: { id: 'ss_x', offers: [unreadable] } })
    ).not.toThrow();
    expect(lastTrack(a)).toEqual(['view_item_list', {}]);
    expect(() =>
      events.emit('booking:ticketed', {
        booking: booking({ itinerary: itinerary({ offers: [unreadable] }) }),
      })
    ).not.toThrow();
    expect(lastTrack(a)).toEqual(['purchase', {}]);
    expect(errors).not.toHaveBeenCalled();
    expect(a.track).toHaveBeenCalledTimes(2);
  });

  it('falls back to events.off() when on() returns nothing, and tolerates a cleared emitter', () => {
    const events = { on: vi.fn(), off: vi.fn() };
    const off = bindDomainEvents(createTelemetry(), events);
    expect(events.on).toHaveBeenCalledTimes(7);
    off();
    expect(events.off).toHaveBeenCalledTimes(7);
    events.on.mock.calls.forEach(([name, fn], i) => {
      expect(events.off.mock.calls[i]).toEqual([name, fn]);
    });
    const real = createEmitter();
    const offReal = bindDomainEvents(createTelemetry(), real);
    real.clear();
    expect(() => offReal()).not.toThrow();
  });
});

// ── reference adapters ───────────────────────────────────────────────────────────────────────────

describe('ga4Adapter', () => {
  it('maps track / page / identify onto gtag', () => {
    const gtag = vi.fn();
    const a = ga4Adapter({ gtag });
    expect(a.name).toBe('ga4');
    a.track('purchase', { value: 1 });
    a.track('bare');
    a.page('results', { page_location: '/r' });
    a.identify('u_1', { plan: 'gold' });
    a.identify('u_2');
    a.identify('u_3', {});
    expect(gtag.mock.calls).toEqual([
      ['event', 'purchase', { value: 1 }],
      ['event', 'bare', {}],
      ['event', 'page_view', { page_title: 'results', page_location: '/r' }],
      ['set', { user_id: 'u_1' }],
      ['set', 'user_properties', { plan: 'gold' }],
      ['set', { user_id: 'u_2' }],
      ['set', { user_id: 'u_3' }],
    ]);
  });

  it('resolves globalThis.gtag lazily and is a no-op while it is absent', () => {
    const a = ga4Adapter();
    expect(() => a.track('x')).not.toThrow();
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    a.track('x', { a: 1 });
    expect(gtag).toHaveBeenCalledWith('event', 'x', { a: 1 });
  });

  it('rejects a non-function gtag and non-object options', () => {
    expect(() => ga4Adapter({ gtag: 'G-1' })).toThrow(ConfigError);
    expect(() => ga4Adapter(null)).toThrow(ConfigError);
    expect(() => ga4Adapter({ gtag: null })).not.toThrow();
  });
});

describe('gtmAdapter', () => {
  it('pushes plain events, and ecommerce events under `ecommerce` after a reset', () => {
    const dataLayer = [];
    const a = gtmAdapter({ dataLayer });
    expect(a.name).toBe('gtm');
    a.track('search', { market: 'IN' });
    a.track('purchase', {
      transaction_id: 'WF1',
      currency: 'INR',
      value: 9200,
      tax: 1000,
      items: [{ item_id: 'of_1' }],
      market: 'IN',
    });
    a.page('results', { page_location: '/r' });
    a.identify('u_1', { plan: 'gold' });
    a.identify('u_2');
    expect(dataLayer).toEqual([
      { event: 'search', market: 'IN' },
      { ecommerce: null },
      {
        event: 'purchase',
        market: 'IN',
        ecommerce: {
          transaction_id: 'WF1',
          currency: 'INR',
          value: 9200,
          tax: 1000,
          items: [{ item_id: 'of_1' }],
        },
      },
      { event: 'page_view', page_title: 'results', page_location: '/r' },
      { event: 'identify', user_id: 'u_1', user_properties: { plan: 'gold' } },
      { event: 'identify', user_id: 'u_2', user_properties: {} },
    ]);
  });

  it('accepts any object with push(), resolves globalThis.dataLayer lazily and validates', () => {
    const layer = { push: vi.fn() };
    gtmAdapter({ dataLayer: layer }).track('x');
    expect(layer.push).toHaveBeenCalledWith({ event: 'x' });
    const lazy = gtmAdapter();
    expect(() => lazy.track('x')).not.toThrow();
    const dataLayer = [];
    vi.stubGlobal('dataLayer', dataLayer);
    lazy.track('y');
    expect(dataLayer).toEqual([{ event: 'y' }]);
    expect(() => gtmAdapter({ dataLayer: 'layer' })).toThrow(ConfigError);
    expect(() => gtmAdapter({ dataLayer: {} })).toThrow(ConfigError);
    expect(() => gtmAdapter('x')).toThrow(ConfigError);
  });
});

describe('segmentAdapter', () => {
  it('forwards track / page / identify one-to-one and flushes when the SDK can', async () => {
    const analytics = { track: vi.fn(), page: vi.fn(), identify: vi.fn(), flush: vi.fn() };
    const a = segmentAdapter({ analytics });
    expect(a.name).toBe('segment');
    a.track('Order Completed', { total: 1 });
    a.track('bare');
    a.page('Results', { path: '/r' });
    a.identify('u_1', { plan: 'gold' });
    a.identify('u_2');
    await expect(a.flush()).resolves.toBeUndefined();
    expect(analytics.track.mock.calls).toEqual([
      ['Order Completed', { total: 1 }],
      ['bare', {}],
    ]);
    expect(analytics.page).toHaveBeenCalledWith('Results', { path: '/r' });
    expect(analytics.identify.mock.calls).toEqual([
      ['u_1', { plan: 'gold' }],
      ['u_2', {}],
    ]);
    expect(analytics.flush).toHaveBeenCalledTimes(1);
  });

  it('tolerates an SDK without flush, resolves globalThis.analytics lazily and validates', async () => {
    const partial = { track: vi.fn() };
    const a = segmentAdapter({ analytics: partial });
    expect(() => a.page('p')).not.toThrow();
    await expect(a.flush()).resolves.toBeUndefined();
    const lazy = segmentAdapter();
    expect(() => lazy.track('x')).not.toThrow();
    await expect(lazy.flush()).resolves.toBeUndefined();
    const analytics = { track: vi.fn() };
    vi.stubGlobal('analytics', analytics);
    lazy.track('x', { a: 1 });
    expect(analytics.track).toHaveBeenCalledWith('x', { a: 1 });
    expect(() => segmentAdapter({ analytics: 'segment' })).toThrow(ConfigError);
    expect(() => segmentAdapter(42)).toThrow(ConfigError);
  });
});

describe('consoleAdapter', () => {
  it('hands structured entries to a function sink', () => {
    const sink = vi.fn();
    const a = consoleAdapter({ sink });
    expect(a.name).toBe('console');
    a.track('x', { a: 1 });
    a.page('home');
    a.identify(7, { plan: 'gold' });
    expect(sink.mock.calls).toEqual([
      [{ kind: 'track', event: 'x', props: { a: 1 } }],
      [{ kind: 'page', event: 'home', props: {} }],
      [{ kind: 'identify', event: '7', props: { plan: 'gold' } }],
    ]);
  });

  it('writes to debug() of a console-like sink, falling back to log()', () => {
    const sink = { debug: vi.fn(), log: vi.fn() };
    consoleAdapter({ sink }).track('x', { a: 1 });
    expect(sink.debug).toHaveBeenCalledWith('[wayfarer:telemetry] track x', { a: 1 });
    expect(sink.log).not.toHaveBeenCalled();
    const logOnly = { log: vi.fn() };
    consoleAdapter({ sink: logOnly }).page('home');
    expect(logOnly.log).toHaveBeenCalledWith('[wayfarer:telemetry] page home', {});
    expect(() => consoleAdapter({ sink: {} }).track('x')).not.toThrow();
  });

  it('defaults to globalThis.console resolved at call time and validates the sink', () => {
    const a = consoleAdapter();
    const fake = { debug: vi.fn() };
    vi.stubGlobal('console', fake);
    a.track('x', { a: 1 });
    vi.unstubAllGlobals();
    expect(fake.debug).toHaveBeenCalledWith('[wayfarer:telemetry] track x', { a: 1 });
    vi.stubGlobal('console', undefined);
    expect(() => a.track('y')).not.toThrow();
    vi.unstubAllGlobals();
    expect(() => consoleAdapter({ sink: 'stdout' })).toThrow(ConfigError);
    expect(() => consoleAdapter([])).toThrow(ConfigError);
  });
});

describe('beaconAdapter', () => {
  const URL = 'https://api.ota.com/telemetry';

  it('validates its options', () => {
    expect(() => beaconAdapter()).toThrow(ConfigError);
    expect(() => beaconAdapter({})).toThrow(ConfigError);
    expect(() => beaconAdapter({ url: '' })).toThrow(ConfigError);
    expect(() => beaconAdapter({ url: URL, fetch: 'f' })).toThrow(ConfigError);
    expect(() => beaconAdapter('url')).toThrow(ConfigError);
    expect(beaconAdapter({ url: URL }).name).toBe('beacon');
  });

  it('prefers navigator.sendBeacon with a JSON Blob and never touches fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const fetchFn = vi.fn();
    const a = beaconAdapter({ url: URL, fetch: fetchFn });
    a.track('purchase', { value: 1 });
    a.page('results');
    a.identify(5, { plan: 'gold' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sendBeacon).toHaveBeenCalledTimes(3);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe(URL);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual({
      kind: 'track',
      event: 'purchase',
      props: { value: 1 },
      at: Date.parse('2026-10-17T10:00:00Z'),
    });
    expect(JSON.parse(await sendBeacon.mock.calls[1][1].text())).toMatchObject({
      kind: 'page',
      event: 'results',
      props: {},
    });
    expect(JSON.parse(await sendBeacon.mock.calls[2][1].text())).toMatchObject({
      kind: 'identify',
      event: '5',
      props: { plan: 'gold' },
    });
    await expect(a.flush()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to fetch keepalive when sendBeacon is missing, refuses or throws', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ ok: true }));
    const a = beaconAdapter({ url: URL, fetch: fetchFn });
    vi.stubGlobal('navigator', {});
    a.track('a');
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    a.track('b');
    vi.stubGlobal('navigator', {
      sendBeacon: vi.fn(() => {
        throw new TypeError('beacon broke');
      }),
    });
    a.track('c');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(URL);
    expect(init).toMatchObject({
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body)).toEqual({
      kind: 'track',
      event: 'a',
      props: {},
      at: expect.any(Number),
    });
    expect(fetchFn.mock.calls.map((c) => JSON.parse(c[1].body).event)).toEqual(['a', 'b', 'c']);
    await expect(a.flush()).resolves.toBeUndefined();
  });

  it('flush waits for in-flight fetches and swallows their rejections', async () => {
    vi.stubGlobal('navigator', {});
    let resolveFirst;
    const first = new Promise((r) => (resolveFirst = r));
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(Promise.reject(new Error('offline')));
    const a = beaconAdapter({ url: URL, fetch: fetchFn });
    a.track('slow');
    a.track('failing');
    let settled = false;
    const flushed = a.flush().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveFirst({ ok: true });
    await flushed;
    expect(settled).toBe(true);
    // a later flush has nothing left to wait for
    await expect(a.flush()).resolves.toBeUndefined();
  });

  it('drops events when neither transport exists and lets a synchronous fetch failure reach the telemetry', () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('fetch', undefined);
    const silent = beaconAdapter({ url: URL });
    expect(() => silent.track('x')).not.toThrow();
    const logger = fakeLogger();
    const broken = beaconAdapter({
      url: URL,
      fetch: () => {
        throw new TypeError('bad init');
      },
    });
    const t = createTelemetry({ adapters: [broken], logger });
    expect(t.track('x')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'beacon' failed on track"), {
      adapter: 'beacon',
      kind: 'track',
      error: expect.any(TypeError),
    });
  });

  it('reaches the collector through the real fetch (MSW) when sendBeacon is unavailable', async () => {
    const received = [];
    server.use(
      http.post(URL, async ({ request }) => {
        received.push({
          contentType: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json({ ok: true }, { status: 202 });
      })
    );
    const t = createTelemetry({
      adapters: [beaconAdapter({ url: URL })],
      context: { market: 'IN' },
    });
    t.track('select_item', { items: [{ item_id: 'of_1' }] });
    await t.flush();
    expect(received).toEqual([
      {
        contentType: 'application/json',
        body: {
          kind: 'track',
          event: 'select_item',
          props: { market: 'IN', items: [{ item_id: 'of_1' }] },
          at: expect.any(Number),
        },
      },
    ]);
  });
});

// ── hygiene ──────────────────────────────────────────────────────────────────────────────────────

describe('hygiene', () => {
  it('touches no browser globals at import time (SSR-safe)', async () => {
    const keys = ['window', 'document', 'localStorage', 'navigator'];
    const touched = [];
    const originals = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
    for (const k of keys) {
      Object.defineProperty(globalThis, k, {
        configurable: true,
        get() {
          touched.push(k);
          return undefined;
        },
      });
    }
    try {
      vi.resetModules();
      const mod = await import('../../src/utils/telemetry.js');
      expect(typeof mod.createTelemetry).toBe('function');
      const t = mod.createTelemetry({ adapters: [mod.ga4Adapter({ gtag: vi.fn() })] });
      t.track('x');
      expect(touched).toEqual([]);
    } finally {
      for (const [k, desc] of originals) {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
    }
  });

  it('starts no timers and leaves no listeners behind after a full lifecycle', async () => {
    vi.useFakeTimers();
    const events = createEmitter();
    const t = createTelemetry({
      adapters: [
        ga4Adapter({ gtag: vi.fn() }),
        gtmAdapter({ dataLayer: [] }),
        segmentAdapter({ analytics: { track: vi.fn() } }),
        consoleAdapter({ sink: vi.fn() }),
        beaconAdapter({
          url: 'https://api.ota.com/telemetry',
          fetch: vi.fn(() => Promise.resolve()),
        }),
      ],
      events,
      sampleRate: 0.5,
      random: () => 0,
    });
    const off = bindDomainEvents(t, events);
    events.emit('search:complete', { session: { id: 's', offers: [offer('of_1')] } });
    events.emit('booking:ticketed', { booking: booking() });
    t.page('results');
    t.identify('u');
    t.timing('http_request', 12);
    await t.flush();
    off();
    expect(events.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
