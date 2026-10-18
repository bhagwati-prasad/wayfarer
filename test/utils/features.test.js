import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { createFeatures } from '../../src/utils/features.js';
import { createEmitter } from '../../src/events/emitter.js';
import {
  ConfigError,
  SdkError,
  ValidationError,
  NetworkError,
  isSdkError,
} from '../../src/errors/index.js';

/** `{ emit }` duck-typed emitter that records what it receives. */
function emitter() {
  const calls = [];
  return { calls, emit: vi.fn((type, payload) => calls.push({ type, payload })) };
}

/** Duck-typed store that applies functional updaters to a kept `bootstrap` slice. */
function fakeStore(bootstrap = { loaded: false, flags: {}, limits: { maxLegs: 6 } }) {
  const state = { bootstrap };
  const set = vi.fn((slice, updater, meta) => {
    state[slice] = typeof updater === 'function' ? updater(state[slice]) : updater;
    state.lastMeta = meta;
  });
  return { state, set };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createFeatures — construction and reads', () => {
  it('starts empty without options and reads defaults', () => {
    const f = createFeatures();
    expect(f.get('x')).toBeUndefined();
    expect(f.isEnabled('x')).toBe(false);
    expect(f.isEnabled('x', true)).toBe(true);
    expect(f.variant('x')).toBeUndefined();
    expect(f.variant('x', 'control')).toBe('control');
  });

  it('seeds the loaded layer from initial (numbers coerced to strings)', () => {
    const f = createFeatures({ initial: { split: true, layout: 'b', max: 9, legacy: false } });
    expect(f.get('split')).toBe(true);
    expect(f.get('layout')).toBe('b');
    expect(f.get('max')).toBe('9');
    expect(f.get('legacy')).toBe(false);
  });

  it('ignores null / undefined values in initial and tolerates null options fields', () => {
    const f = createFeatures({
      initial: { a: null, b: undefined, c: true },
      source: null,
      events: null,
    });
    expect(f.get('a')).toBeUndefined();
    expect(f.get('b')).toBeUndefined();
    expect(f.get('c')).toBe(true);
  });

  it('rejects bad factory options with ConfigError', () => {
    expect(() => createFeatures(null)).toThrow(ConfigError);
    expect(() => createFeatures({ initial: 'nope' })).toThrow(ConfigError);
    expect(() => createFeatures({ initial: ['a'] })).toThrow(ConfigError);
    expect(() => createFeatures({ source: 'GET /config' })).toThrow(ConfigError);
    expect(() => createFeatures({ events: {} })).toThrow(ConfigError);
    expect(() => createFeatures({ events: 'bus' })).toThrow(ConfigError);
  });

  it('reports every invalid initial value in ConfigError.details.issues', () => {
    let caught;
    try {
      createFeatures({ initial: { ok: true, obj: {}, list: [], nan: NaN } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught.details.path).toBe('initial');
    expect(caught.details.issues.map((i) => i.path)).toEqual([
      'initial.obj',
      'initial.list',
      'initial.nan',
    ]);
    // the unsafe-key case lives in the next test; a literal __proto__ in a literal sets the prototype
    expect(caught.details.issues.every((i) => i.code === 'invalid_type')).toBe(true);
  });

  it('flags __proto__ / constructor / prototype keys in initial as unsafe', () => {
    const initial = JSON.parse('{"__proto__": true, "constructor": "x", "fine": true}');
    let caught;
    try {
      createFeatures({ initial });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught.details.issues.map((i) => [i.code, i.params.key])).toEqual([
      ['unsafe_key', '__proto__'],
      ['unsafe_key', 'constructor'],
    ]);
    expect({}.fine).toBeUndefined();
  });

  it('does not accept a store without set but tolerates it', () => {
    expect(() => createFeatures({ store: {} })).not.toThrow();
    expect(() => createFeatures({ store: null })).not.toThrow();
    expect(() => createFeatures({ store: 'nope' })).not.toThrow();
  });

  it('validates flag names on every read', () => {
    const f = createFeatures();
    expect(() => f.get(42)).toThrow(ValidationError);
    expect(() => f.get('')).toThrow(ValidationError);
    expect(() => f.isEnabled(null)).toThrow(ValidationError);
    expect(() => f.variant(undefined)).toThrow(ValidationError);
    let caught;
    try {
      f.get('');
    } catch (e) {
      caught = e;
    }
    expect(caught.issues).toEqual([
      { path: 'flag', code: 'required', message: 'flag must not be empty' },
    ]);
  });

  it('never resolves prototype properties as flags', () => {
    const f = createFeatures();
    expect(f.get('toString')).toBeUndefined();
    expect(f.get('__proto__')).toBeUndefined();
    expect(f.isEnabled('constructor')).toBe(false);
    expect(f.variant('hasOwnProperty', 'd')).toBe('d');
  });
});

describe('isEnabled / variant semantics', () => {
  it('returns boolean flags as they are and the default only when missing', () => {
    const f = createFeatures({ initial: { on: true, off: false } });
    expect(f.isEnabled('on')).toBe(true);
    expect(f.isEnabled('off')).toBe(false);
    expect(f.isEnabled('off', true)).toBe(false);
    expect(f.isEnabled('missing', true)).toBe(true);
    expect(f.isEnabled('missing', 'truthy-but-not-true')).toBe(false);
  });

  it('parses string flags: off words are off, any other string is on', () => {
    const f = createFeatures({
      initial: {
        t: 'true',
        f: 'false',
        zero: '0',
        one: '1',
        off: ' OFF ',
        on: 'on',
        no: 'No',
        dis: 'disabled',
        empty: '',
        arm: 'variant-b',
        yes: 'yes',
      },
    });
    expect(f.isEnabled('t')).toBe(true);
    expect(f.isEnabled('f')).toBe(false);
    expect(f.isEnabled('zero')).toBe(false);
    expect(f.isEnabled('one')).toBe(true);
    expect(f.isEnabled('off')).toBe(false);
    expect(f.isEnabled('on')).toBe(true);
    expect(f.isEnabled('no')).toBe(false);
    expect(f.isEnabled('dis')).toBe(false);
    expect(f.isEnabled('empty')).toBe(false);
    expect(f.isEnabled('arm')).toBe(true);
    expect(f.isEnabled('yes')).toBe(true);
  });

  it('variant returns the string value, or the default for missing and boolean flags', () => {
    const f = createFeatures({ initial: { exp: 'b', sw: true, n: 3 } });
    expect(f.variant('exp')).toBe('b');
    expect(f.variant('exp', 'a')).toBe('b');
    expect(f.variant('sw')).toBeUndefined();
    expect(f.variant('sw', 'a')).toBe('a');
    expect(f.variant('n')).toBe('3');
    expect(f.variant('none', 'control')).toBe('control');
  });
});

describe('set()', () => {
  it('merges into the loaded layer and removes flags set to null / undefined', () => {
    const f = createFeatures({ initial: { a: true, b: 'x', c: false } });
    f.set({ b: 'y', d: 1, c: null, e: undefined });
    expect(f.get('a')).toBe(true);
    expect(f.get('b')).toBe('y');
    expect(f.get('c')).toBeUndefined();
    expect(f.get('d')).toBe('1');
    expect(f.get('e')).toBeUndefined();
  });

  it('throws ValidationError with one issue per bad entry and changes nothing', () => {
    const f = createFeatures({ initial: { a: true } });
    const bad = JSON.parse('{"a": false, "obj": {"x": 1}, "__proto__": true, "fn": null}');
    bad.fn = () => {};
    let caught;
    try {
      f.set(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.issues.map((i) => [i.path, i.code])).toEqual([
      ['flags.obj', 'invalid_type'],
      ['flags.__proto__', 'unsafe_key'],
      ['flags.fn', 'invalid_type'],
    ]);
    expect(f.get('a')).toBe(true);
    expect(f.get('obj')).toBeUndefined();
  });

  it('rejects non-object flag maps', () => {
    const f = createFeatures();
    for (const v of [undefined, null, 'a', 1, ['a'], new Map()]) {
      expect(() => f.set(v)).toThrow(ValidationError);
    }
  });

  it('notifies only when the effective flags actually change', () => {
    const f = createFeatures({ initial: { a: true, b: 'x' } });
    const fn = vi.fn();
    f.onChange(fn);
    f.set({ a: true, b: 'x' });
    f.set({});
    f.set({ nope: null });
    expect(fn).not.toHaveBeenCalled();
    f.set({ a: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual({
      flags: { a: false, b: 'x' },
      previous: { a: true, b: 'x' },
      changed: ['a'],
      reason: 'set',
    });
  });

  it('lists added, changed and removed names in changed', () => {
    const f = createFeatures({ initial: { keep: true, change: 'a', drop: false } });
    const fn = vi.fn();
    f.onChange(fn);
    f.set({ change: 'b', add: 'new', drop: null });
    expect(fn.mock.calls[0][0].changed).toEqual(['change', 'add', 'drop']);
    expect(fn.mock.calls[0][0].flags).toEqual({ keep: true, change: 'b', add: 'new' });
  });
});

describe('override() / clearOverrides()', () => {
  it('overrides win over loaded flags and survive later set() / load()', async () => {
    const f = createFeatures({ initial: { split: false }, source: async () => ({ split: false }) });
    f.override('split', true);
    expect(f.isEnabled('split')).toBe(true);
    f.set({ split: false });
    expect(f.isEnabled('split')).toBe(true);
    await f.load();
    expect(f.isEnabled('split')).toBe(true);
    f.clearOverrides();
    expect(f.isEnabled('split')).toBe(false);
  });

  it('removes a single override with null / undefined and coerces numbers', () => {
    const f = createFeatures({ initial: { exp: 'a' } });
    f.override('exp', 'b');
    f.override('n', 2);
    expect(f.variant('exp')).toBe('b');
    expect(f.get('n')).toBe('2');
    f.override('exp', undefined);
    expect(f.variant('exp')).toBe('a');
    f.override('n', null);
    expect(f.get('n')).toBeUndefined();
  });

  it('an override of a flag that was never loaded disappears on clearOverrides', () => {
    const f = createFeatures();
    const fn = vi.fn();
    f.onChange(fn);
    f.override('new', 'x');
    expect(f.get('new')).toBe('x');
    f.clearOverrides();
    expect(f.get('new')).toBeUndefined();
    expect(fn.mock.calls.map((c) => c[0].reason)).toEqual(['override', 'clearOverrides']);
    expect(fn.mock.calls[1][0]).toEqual({
      flags: {},
      previous: { new: 'x' },
      changed: ['new'],
      reason: 'clearOverrides',
    });
  });

  it('is silent when nothing effective changes', () => {
    const f = createFeatures({ initial: { a: true } });
    const fn = vi.fn();
    f.onChange(fn);
    f.override('a', true); // same as loaded
    f.clearOverrides(); // back to the same effective value
    f.clearOverrides(); // nothing to clear
    f.override('zzz', undefined); // removing a non-existent override
    expect(fn).not.toHaveBeenCalled();
  });

  it('validates the flag name and value', () => {
    const f = createFeatures();
    expect(() => f.override('', true)).toThrow(ValidationError);
    expect(() => f.override(1, true)).toThrow(ValidationError);
    expect(() => f.override('__proto__', true)).toThrow(ValidationError);
    expect(() => f.override('constructor', 'x')).toThrow(ValidationError);
    expect(() => f.override('a', {})).toThrow(ValidationError);
    expect(() => f.override('a', [])).toThrow(ValidationError);
    expect(() => f.override('a', Infinity)).toThrow(ValidationError);
    expect(f.get('a')).toBeUndefined();
    expect({}.a).toBeUndefined();
  });
});

describe('load()', () => {
  it('calls source() and merges the returned flag map', async () => {
    const source = vi.fn(async () => ({ remote: true, exp: 'b', keep: null }));
    const f = createFeatures({ initial: { keep: true, exp: 'a' }, source });
    const fn = vi.fn();
    f.onChange(fn);
    await expect(f.load()).resolves.toBeUndefined();
    expect(source).toHaveBeenCalledTimes(1);
    expect(f.get('remote')).toBe(true);
    expect(f.get('exp')).toBe('b');
    expect(f.get('keep')).toBe(true); // null from a remote source is skipped, not a removal
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].reason).toBe('load');
    expect(fn.mock.calls[0][0].changed).toEqual(['exp', 'remote']);
  });

  it('accepts a bootstrap document carrying a flags object', async () => {
    const f = createFeatures({
      source: async () => ({ version: '1', limits: { maxLegs: 6 }, flags: { split: 'true' } }),
    });
    await f.load();
    expect(f.isEnabled('split')).toBe(true);
    expect(f.get('version')).toBeUndefined();
    expect(f.get('limits')).toBeUndefined();
  });

  it('sanitises remote values leniently: numbers coerced, the rest skipped', async () => {
    const remote = JSON.parse(
      '{"n": 7, "obj": {"a": 1}, "list": [1], "__proto__": true, "ok": "x", "nil": null}'
    );
    const f = createFeatures({ source: async () => remote });
    await f.load();
    expect(f.get('n')).toBe('7');
    expect(f.get('ok')).toBe('x');
    expect(f.get('obj')).toBeUndefined();
    expect(f.get('list')).toBeUndefined();
    expect(f.get('nil')).toBeUndefined();
    expect({}.__proto__).toBe(Object.prototype);
  });

  it('is single-flight while a load is in progress and loads again afterwards', async () => {
    let resolve;
    const source = vi.fn(() => new Promise((r) => (resolve = r)));
    const f = createFeatures({ source });
    const p1 = f.load();
    const p2 = f.load();
    expect(p1).toBe(p2);
    expect(source).toHaveBeenCalledTimes(1);
    resolve({ a: true });
    await p1;
    expect(f.get('a')).toBe(true);
    const p3 = f.load();
    expect(p3).not.toBe(p1);
    expect(source).toHaveBeenCalledTimes(2);
    resolve({ a: false });
    await p3;
    expect(f.get('a')).toBe(false);
  });

  it('rejects with ConfigError when no source was configured', async () => {
    const f = createFeatures({ initial: { a: true } });
    const fn = vi.fn();
    f.onChange(fn);
    await expect(f.load()).rejects.toBeInstanceOf(ConfigError);
    expect(f.get('a')).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes SdkErrors from the source through and wraps anything else', async () => {
    const net = new NetworkError('offline');
    const f1 = createFeatures({ source: async () => Promise.reject(net) });
    await expect(f1.load()).rejects.toBe(net);

    const f2 = createFeatures({
      source: () => {
        throw new Error('boom');
      },
    });
    let caught;
    try {
      await f2.load();
    } catch (e) {
      caught = e;
    }
    expect(isSdkError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(SdkError);
    expect(caught.message).toBe('boom');
    expect(caught.cause).toBeInstanceOf(Error);

    const f3 = createFeatures({ source: async () => Promise.reject() });
    await expect(f3.load()).rejects.toMatchObject({
      code: 'FEATURES_LOAD_FAILED',
      message: 'feature flags could not be loaded',
    });
  });

  it('rejects with ValidationError when the source resolves to a non-object', async () => {
    for (const bad of [undefined, null, 'flags', 42, [1]]) {
      const f = createFeatures({ source: async () => bad });
      await expect(f.load()).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('a failed load releases the single-flight slot', async () => {
    let fail = true;
    const f = createFeatures({
      source: async () => {
        if (fail) throw new Error('nope');
        return { a: true };
      },
    });
    await expect(f.load()).rejects.toBeInstanceOf(SdkError);
    fail = false;
    await f.load();
    expect(f.get('a')).toBe(true);
  });

  it('works with a fetch-backed source against GET /config (MSW)', async () => {
    server.use(
      http.get('https://api.ota.com/config', () =>
        HttpResponse.json({ flags: { split: true, layout: 'b' }, limits: { maxLegs: 6 } })
      )
    );
    const f = createFeatures({
      source: () => fetch('https://api.ota.com/config').then((r) => r.json()),
    });
    await f.load();
    expect(f.isEnabled('split')).toBe(true);
    expect(f.variant('layout')).toBe('b');
  });
});

describe('onChange()', () => {
  it('returns an idempotent off() and supports the same function registered twice', () => {
    const f = createFeatures();
    const fn = vi.fn();
    const off1 = f.onChange(fn);
    const off2 = f.onChange(fn);
    f.set({ a: true });
    expect(fn).toHaveBeenCalledTimes(2);
    off1();
    off1();
    f.set({ a: false });
    expect(fn).toHaveBeenCalledTimes(3);
    off2();
    f.set({ a: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rejects a non-function listener', () => {
    const f = createFeatures();
    expect(() => f.onChange()).toThrow(ValidationError);
    expect(() => f.onChange('fn')).toThrow(ValidationError);
  });

  it('hands listeners frozen snapshots that later changes do not mutate', () => {
    const f = createFeatures({ initial: { a: true } });
    const seen = [];
    f.onChange((c) => seen.push(c));
    f.set({ b: 'x' });
    f.set({ a: false });
    expect(Object.isFrozen(seen[0].flags)).toBe(true);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0].flags).toEqual({ a: true, b: 'x' });
    expect(seen[1].previous).toBe(seen[0].flags);
    expect(seen[1].flags).toEqual({ a: false, b: 'x' });
  });

  it('a listener removed mid-notification is skipped and one added mid-notification waits', () => {
    const f = createFeatures();
    const late = vi.fn();
    const second = vi.fn();
    let offSecond;
    f.onChange(() => {
      offSecond();
      f.onChange(late);
    });
    offSecond = f.onChange(second);
    f.set({ a: true });
    expect(second).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    f.set({ a: false });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener: others still run, the fault is re-emitted as error', () => {
    const events = emitter();
    const f = createFeatures({ events });
    const after = vi.fn();
    f.onChange(() => {
      throw new Error('listener bug');
    });
    f.onChange(after);
    expect(() => f.set({ a: true })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(events.calls.map((c) => c.type)).toEqual(['error', 'features:change']);
    expect(events.calls[0].payload.event).toBe('features:change');
    expect(isSdkError(events.calls[0].payload.error)).toBe(true);
    expect(events.calls[0].payload.error.message).toBe('listener bug');
  });

  it('without an events bus the first listener fault is rethrown as an SdkError after fan-out', () => {
    const f = createFeatures();
    const after = vi.fn();
    f.onChange(() => {
      throw new Error('first');
    });
    f.onChange(() => {
      throw new Error('second');
    });
    f.onChange(after);
    let caught;
    try {
      f.set({ a: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SdkError);
    expect(caught.message).toBe('first');
    expect(after).toHaveBeenCalledTimes(1);
    expect(f.get('a')).toBe(true);
  });
});

describe('events and store integration', () => {
  it('emits features:change on the duck-typed bus with the change payload', () => {
    const events = emitter();
    const f = createFeatures({ initial: { a: true }, events });
    f.set({ a: false, b: 'x' });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.calls[0].type).toBe('features:change');
    expect(events.calls[0].payload).toEqual({
      flags: { a: false, b: 'x' },
      previous: { a: true },
      changed: ['a', 'b'],
      reason: 'set',
    });
  });

  it('does not emit at construction or for no-op changes', () => {
    const events = emitter();
    const f = createFeatures({ initial: { a: true }, events });
    f.set({ a: true });
    f.clearOverrides();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('plays with the real emitter: listeners get type and at, wildcards match', async () => {
    const bus = createEmitter({ now: () => 1234 });
    const f = createFeatures({ events: bus, source: async () => ({ remote: 'yes' }) });
    const all = vi.fn();
    bus.on('*', all);
    const waited = bus.waitFor('features:change');
    f.override('dev', true);
    await f.load();
    expect(all.mock.calls.map((c) => c[0].type)).toEqual(['features:change', 'features:change']);
    expect(all.mock.calls[0][0]).toMatchObject({
      type: 'features:change',
      at: 1234,
      reason: 'override',
      changed: ['dev'],
    });
    await expect(waited).resolves.toMatchObject({ reason: 'override' });
    expect(all.mock.calls[1][0]).toMatchObject({
      reason: 'load',
      flags: { dev: true, remote: 'yes' },
    });
  });

  it('mirrors effective flags into bootstrap.flags through store.set with a functional updater', () => {
    const store = fakeStore();
    const f = createFeatures({ initial: { a: true }, store });
    // creation writes the initial flags (no event, see above)
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.set.mock.calls[0][0]).toBe('bootstrap');
    expect(store.state.bootstrap).toEqual({
      loaded: false,
      flags: { a: true },
      limits: { maxLegs: 6 },
    });
    expect(store.state.lastMeta).toEqual({ action: 'features/init' });

    f.set({ b: 'x' });
    expect(store.state.bootstrap.flags).toEqual({ a: true, b: 'x' });
    expect(store.state.bootstrap.limits).toEqual({ maxLegs: 6 });
    expect(store.state.lastMeta).toEqual({ action: 'features/set' });

    f.override('a', false);
    expect(store.state.bootstrap.flags).toEqual({ a: false, b: 'x' });
    expect(store.state.lastMeta).toEqual({ action: 'features/override' });

    f.clearOverrides();
    expect(store.state.bootstrap.flags).toEqual({ a: true, b: 'x' });
    expect(store.state.lastMeta).toEqual({ action: 'features/clearOverrides' });
    expect(Object.isFrozen(store.state.bootstrap.flags)).toBe(true);
  });

  it('writes the store once per load and copes with a missing slice', async () => {
    const store = fakeStore(null);
    const f = createFeatures({ store, source: async () => ({ a: 1 }) });
    expect(store.set).not.toHaveBeenCalled(); // empty initial: nothing to mirror
    await f.load();
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.state.bootstrap).toEqual({ flags: { a: '1' } });
    expect(store.state.lastMeta).toEqual({ action: 'features/load' });
  });

  it('skips the store when it has no set(), and keeps store writes before listeners', () => {
    const noSet = { get: vi.fn() };
    const f = createFeatures({ initial: { a: true }, store: noSet });
    f.set({ a: false });
    expect(noSet.get).not.toHaveBeenCalled();

    const store = fakeStore();
    const order = [];
    const events = { emit: vi.fn(() => order.push('emit')) };
    store.set.mockImplementation((slice, updater) => {
      order.push('store');
      store.state[slice] = updater(store.state[slice]);
    });
    const g = createFeatures({ store, events });
    g.onChange(() => {
      order.push('listener');
      expect(store.state.bootstrap.flags).toEqual({ z: true });
    });
    g.set({ z: true });
    expect(order).toEqual(['store', 'listener', 'emit']);
  });

  it('propagates a throwing store.set (misconfigured slice) instead of swallowing it', () => {
    const store = {
      set: vi.fn(() => {
        throw new ValidationError('unknown slice');
      }),
    };
    expect(() => createFeatures({ initial: { a: true }, store })).toThrow(ValidationError);
    const f = createFeatures({ store });
    expect(() => f.set({ a: true })).toThrow(ValidationError);
  });
});

describe('destroy() and hygiene', () => {
  it('destroy() drops every listener, keeps flags readable and is idempotent', () => {
    const events = emitter();
    const f = createFeatures({ initial: { a: true }, events });
    const fn = vi.fn();
    f.onChange(fn);
    f.destroy();
    f.destroy();
    f.set({ a: false });
    expect(fn).not.toHaveBeenCalled();
    expect(f.get('a')).toBe(false);
    expect(events.emit).toHaveBeenCalledTimes(1);
    const off = f.onChange(fn);
    f.set({ a: true });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it('starts no timers, even across load()', async () => {
    vi.useFakeTimers();
    const f = createFeatures({ source: async () => ({ a: true }) });
    const p = f.load();
    expect(vi.getTimerCount()).toBe(0);
    await p;
    f.set({ b: 'x' });
    f.override('c', true);
    f.clearOverrides();
    f.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes exactly the documented surface plus destroy()', () => {
    const f = createFeatures();
    expect(Object.keys(f).sort()).toEqual(
      [
        'isEnabled',
        'variant',
        'get',
        'set',
        'override',
        'clearOverrides',
        'load',
        'onChange',
        'destroy',
      ].sort()
    );
    for (const k of Object.keys(f)) expect(typeof f[k]).toBe('function');
  });

  it('is SSR-safe: importing and using it needs no window or document', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const f = createFeatures({ initial: { a: 'x' } });
    expect(f.variant('a')).toBe('x');
  });
});

describe('re-entrancy and delivery order', () => {
  it('delivers a change committed by a listener after the one in flight, to listeners and the bus', () => {
    const events = emitter();
    const store = fakeStore();
    const f = createFeatures({ events, store });
    const seenByB = [];
    f.onChange((c) => {
      if (c.flags.a === '1') f.set({ a: '2' });
    });
    f.onChange((c) => seenByB.push({ change: c, stored: store.state.bootstrap.flags.a }));
    f.set({ a: '1' });
    // the store is written immediately (it is already '2' while B still receives '1'), but
    // listener B and the bus must end on the newest flags, never on the stale first change
    expect(seenByB.map((s) => s.stored)).toEqual(['2', '2']);
    expect(seenByB.map((s) => s.change.flags.a)).toEqual(['1', '2']);
    seenByB.splice(0, seenByB.length, ...seenByB.map((s) => s.change));
    expect(seenByB[1].previous).toBe(seenByB[0].flags);
    expect(seenByB.map((c) => c.changed)).toEqual([['a'], ['a']]);
    expect(events.calls.map((c) => c.type)).toEqual(['features:change', 'features:change']);
    expect(events.calls.map((c) => c.payload.flags.a)).toEqual(['1', '2']);
    expect(f.get('a')).toBe('2');
  });

  it('a re-entrant set / override / clearOverrides chain arrives in commit order with store writes first', () => {
    const store = fakeStore();
    const f = createFeatures({ initial: { a: 'x' }, store });
    const seen = [];
    f.onChange((c) => {
      seen.push(`${c.reason}:${c.flags.a}:${store.state.bootstrap.flags.a}`);
      if (c.reason === 'set') f.override('a', 'o');
      if (c.reason === 'override') f.clearOverrides();
    });
    f.set({ a: 'y' });
    // each nested commit happens while the previous change is being delivered, so every change is
    // delivered after its own store write and before the next change
    expect(seen).toEqual(['set:y:y', 'override:o:o', 'clearOverrides:y:y']);
    expect(store.set.mock.calls.map((c) => c[2].action)).toEqual([
      'features/init',
      'features/set',
      'features/override',
      'features/clearOverrides',
    ]);
  });

  it('a queued re-entrant change is still delivered when an earlier listener throws (no bus)', () => {
    const f = createFeatures();
    const seen = [];
    f.onChange(() => {
      throw new Error('bug');
    });
    f.onChange((c) => {
      if (c.flags.a === true) f.set({ a: false });
    });
    f.onChange((c) => seen.push(c.flags.a));
    let caught;
    try {
      f.set({ a: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SdkError);
    expect(caught.message).toBe('bug');
    expect(seen).toEqual([true, false]);
    expect(f.get('a')).toBe(false);
  });

  it('a bus whose emit throws does not leave the delivery queue stuck for the next commit', () => {
    let explode = true;
    const f = createFeatures({
      events: {
        emit: () => {
          if (explode) throw new Error('bus down');
        },
      },
    });
    const fn = vi.fn();
    f.onChange(fn);
    expect(() => f.set({ a: true })).toThrow('bus down');
    explode = false;
    f.set({ a: false });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0].changed).toEqual(['a']);
  });
});

describe('load() result shapes and races', () => {
  it('a document whose own flags key is null / undefined carries no flags (other keys are not flags)', async () => {
    for (const flags of [null, undefined]) {
      const fn = vi.fn();
      const f = createFeatures({
        initial: { a: true },
        source: async () => ({ flags, version: '7', loaded: true, limits: { maxLegs: 6 } }),
      });
      f.onChange(fn);
      await expect(f.load()).resolves.toBeUndefined();
      expect(f.get('version')).toBeUndefined();
      expect(f.get('loaded')).toBeUndefined();
      expect(f.get('a')).toBe(true);
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('a bare map may still name a flag "flags" when that value is not an object', async () => {
    const f = createFeatures({ source: async () => ({ flags: true, other: 'x' }) });
    await f.load();
    expect(f.get('flags')).toBe(true);
    expect(f.get('other')).toBe('x');
  });

  it('merges a late remote result over set() calls made while in flight, under any override', async () => {
    let resolve;
    const f = createFeatures({ source: () => new Promise((r) => (resolve = r)) });
    const fn = vi.fn();
    f.onChange(fn);
    const p = f.load();
    f.set({ local: true, both: 'local' });
    f.override('both', 'dev');
    resolve({ remote: true, both: 'remote' });
    await p;
    expect(f.get('local')).toBe(true);
    expect(f.get('remote')).toBe(true);
    expect(f.get('both')).toBe('dev');
    // the load changed only what was effectively different: `both` stayed 'dev' underneath the override
    expect(fn.mock.calls.map((c) => [c[0].reason, c[0].changed])).toEqual([
      ['set', ['local', 'both']],
      ['override', ['both']],
      ['load', ['remote']],
    ]);
    f.clearOverrides();
    expect(f.get('both')).toBe('remote');
  });

  it('routes a listener fault during load() to the bus, or rejects the load without one', async () => {
    const events = emitter();
    const f1 = createFeatures({ events, source: async () => ({ a: true }) });
    f1.onChange(() => {
      throw new Error('bug');
    });
    await expect(f1.load()).resolves.toBeUndefined();
    expect(events.calls.map((c) => c.type)).toEqual(['error', 'features:change']);

    const f2 = createFeatures({ source: async () => ({ a: true }) });
    f2.onChange(() => {
      throw new Error('bug');
    });
    await expect(f2.load()).rejects.toMatchObject({ name: 'SdkError', message: 'bug' });
    expect(f2.get('a')).toBe(true); // applied before fan-out
    await expect(f2.load()).resolves.toBeUndefined(); // slot released; nothing changes → no fan-out
  });

  it('a synchronously throwing or non-promise source is handled like an async one', async () => {
    const f1 = createFeatures({ source: () => ({ sync: true }) });
    await expect(f1.load()).resolves.toBeUndefined();
    expect(f1.get('sync')).toBe(true);

    const f2 = createFeatures({
      source: () => {
        throw new ValidationError('bad request', { issues: [] });
      },
    });
    const p = f2.load();
    expect(p).toBeInstanceOf(Promise);
    await expect(p).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('inputs are never mutated', () => {
  it('leaves initial, set() maps, override values and source results untouched', async () => {
    const initial = Object.freeze({ a: true, n: 1, nil: null });
    const flags = { b: 'x', n: 2, a: null };
    const remote = { c: 3, obj: { z: 1 }, nil: null, flags: undefined };
    const f = createFeatures({ initial, source: async () => remote });
    f.set(flags);
    await f.load();
    expect(initial).toEqual({ a: true, n: 1, nil: null });
    expect(flags).toEqual({ b: 'x', n: 2, a: null });
    expect(remote).toEqual({ c: 3, obj: { z: 1 }, nil: null, flags: undefined });
    expect(Object.keys(remote)).toEqual(['c', 'obj', 'nil', 'flags']);
    expect(f.get('a')).toBeUndefined();
    expect(f.get('n')).toBe('2');
    expect(f.get('b')).toBe('x');
    expect(f.get('c')).toBeUndefined(); // own `flags` key (even undefined) marks a document
  });

  it('snapshots in the store and in change payloads are frozen and independent', () => {
    const store = fakeStore();
    const f = createFeatures({ initial: { a: true }, store });
    const seen = [];
    f.onChange((c) => seen.push(c));
    const before = store.state.bootstrap.flags;
    f.set({ b: 'x' });
    expect(before).toEqual({ a: true });
    expect(Object.isFrozen(before)).toBe(true);
    expect(store.state.bootstrap.flags).not.toBe(before);
    expect(store.state.bootstrap.flags).toBe(seen[0].flags);
    expect(seen[0].previous).toBe(before);
    expect(() => {
      seen[0].changed.push('zzz');
    }).not.toThrow(); // arrays are not frozen by design; mutating one must not leak into the facade
    f.set({ c: true });
    expect(seen[1].changed).toEqual(['c']);
  });
});

describe('number-coerced flags', () => {
  it('follow the string parsing rules after coercion', () => {
    const f = createFeatures({ initial: { zero: 0, one: 1, neg: -1, frac: 0.5, negZero: -0 } });
    expect(f.isEnabled('zero')).toBe(false);
    expect(f.isEnabled('one')).toBe(true);
    expect(f.isEnabled('neg')).toBe(true);
    expect(f.variant('frac')).toBe('0.5');
    expect(f.get('negZero')).toBe('0');
    expect(f.isEnabled('negZero')).toBe(false);
  });
});
