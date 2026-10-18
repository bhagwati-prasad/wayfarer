import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore, createSelector, shallowEqual } from '../../src/state/store.js';
import { createStorage } from '../../src/storage/adapters.js';
import { ConfigError, ValidationError, SdkError } from '../../src/errors/index.js';
import { shallowEqual as objectShallowEqual } from '../../src/utils/object.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Let the microtask batch (and one re-scheduled batch) run. Not affected by fake timers. */
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** `{ emit }` stand-in that records every event. */
function fakeEvents() {
  const calls = [];
  return { calls, emit: vi.fn((type, payload) => calls.push({ type, payload })) };
}

/** `{ debug, info, warn, error }` logger stand-in. */
function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const SEARCH_INITIAL = Object.freeze({
  status: 'idle',
  params: null,
  offers: { byId: {}, allIds: [] },
  filters: { stops: [] },
  resultMode: 'per_slice',
  history: [],
});

const PREFS_INITIAL = Object.freeze({ locale: 'en-IN', currency: 'INR', hour12: true });

/** Store with `search` + `prefs` slices on a memory storage facade. */
function makeStore(options = {}) {
  const storage = createStorage({ driver: 'memory' });
  const store = createStore({ storage, ...options });
  store.registerSlice('search', { initial: SEARCH_INITIAL });
  store.registerSlice('prefs', { initial: PREFS_INITIAL });
  // An empty batch delivers the pending @@init commits now, so tests observe only their own changes.
  store.batch(() => {});
  return { store, storage };
}

// ── createStore ──────────────────────────────────────────────────────────────────────────────────

describe('createStore', () => {
  it('starts with a frozen empty state and no slices', () => {
    const store = createStore();
    expect(store.getState()).toEqual({});
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(store.getSnapshot()).toBe(store.getState());
    expect(store.hasSlice('search')).toBe(false);
  });

  it('exposes every documented member', () => {
    const store = createStore();
    for (const name of [
      'getState',
      'get',
      'select',
      'subscribe',
      'set',
      'batch',
      'reset',
      'registerSlice',
      'use',
      'snapshot',
      'restore',
      'getSnapshot',
      'toObservable',
      'destroy',
    ]) {
      expect(typeof store[name]).toBe('function');
    }
    expect(typeof store.persist.flush).toBe('function');
    expect(typeof store.persist.hydrate).toBe('function');
    expect(typeof store.persist.clear).toBe('function');
  });

  it('registers the `slices` option and installs `middleware` in order', async () => {
    const seen = [];
    const store = createStore({
      slices: {
        search: { initial: SEARCH_INITIAL },
        prefs: { initial: PREFS_INITIAL },
      },
      middleware: [
        (ctx, proceed) => {
          seen.push(`a:${ctx.slice}:${ctx.action}`);
          proceed();
        },
        (ctx, proceed) => {
          seen.push(`b:${ctx.slice}:${ctx.action}`);
          proceed();
        },
      ],
    });
    expect(store.getState().search).toBe(SEARCH_INITIAL);
    expect(store.getState().prefs).toBe(PREFS_INITIAL);
    expect(seen).toEqual([
      'a:search:@@init',
      'b:search:@@init',
      'a:prefs:@@init',
      'b:prefs:@@init',
    ]);
    store.set('prefs', { currency: 'USD' }, { action: 'prefs/setCurrency' });
    await tick();
    expect(seen.slice(-2)).toEqual(['a:prefs:prefs/setCurrency', 'b:prefs:prefs/setCurrency']);
  });

  it('rejects invalid options with ConfigError', () => {
    expect(() => createStore({ storage: 'local' })).toThrow(ConfigError);
    expect(() => createStore({ storage: {} })).toThrow(ConfigError);
    expect(() => createStore({ slices: [] })).toThrow(ConfigError);
    expect(() => createStore({ middleware: () => {} })).toThrow(ConfigError);
    expect(() => createStore({ persist: 'yes' })).toThrow(ConfigError);
    expect(() => createStore({ persist: { storage: 'cookie' } })).toThrow(ConfigError);
    expect(() => createStore({ persist: { debounceMs: -1 } })).toThrow(ConfigError);
    expect(() => createStore({ persist: { prefix: 5 } })).toThrow(ConfigError);
    expect(() => createStore({ events: {} })).toThrow(ConfigError);
  });

  it('never throws a plain Error for bad options', () => {
    for (const bad of [{ storage: 1 }, { slices: 'x' }, { persist: 1 }]) {
      try {
        createStore(bad);
        throw new Error('expected to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(SdkError);
      }
    }
  });
});

// ── registerSlice ────────────────────────────────────────────────────────────────────────────────

describe('store.registerSlice', () => {
  it('adds the slice with its (shallowly frozen) initial value', () => {
    const store = createStore();
    const initial = { a: 1, nested: { b: 2 } };
    store.registerSlice('x', { initial });
    expect(store.getState().x).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.nested)).toBe(false);
    expect(store.hasSlice('x')).toBe(true);
    expect(store.get('x.nested.b')).toBe(2);
  });

  it('is idempotent: a second registration is ignored', async () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.registerSlice('x', { initial: { a: 1 } });
    store.set('x', { a: 2 });
    store.registerSlice('x', { initial: { a: 99 }, persist: true });
    store.registerSlice('x', { initial: { a: 100 } });
    await tick();
    expect(store.get('x.a')).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers of the registration with the @@init action', async () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.registerSlice('x', { initial: { a: 1 } });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    const [state, prev, change] = listener.mock.calls[0];
    expect(state.x).toEqual({ a: 1 });
    expect(prev).toEqual({});
    expect(change.actions).toEqual(['@@init']);
  });

  it('validates the name and the options', () => {
    const store = createStore();
    expect(() => store.registerSlice('', { initial: {} })).toThrow(ValidationError);
    expect(() => store.registerSlice('a.b', { initial: {} })).toThrow(ValidationError);
    expect(() => store.registerSlice('__proto__', { initial: {} })).toThrow(ValidationError);
    expect(() => store.registerSlice(42, { initial: {} })).toThrow(ValidationError);
    expect(() => store.registerSlice('x')).toThrow(ConfigError);
    expect(() => store.registerSlice('x', {})).toThrow(ConfigError);
    expect(() => store.registerSlice('x', { initial: {}, persist: 'local' })).toThrow(ConfigError);
    expect(() => store.registerSlice('x', { initial: {}, persist: { storage: 'cookie' } })).toThrow(
      ConfigError
    );
    expect(() => store.registerSlice('x', { initial: {}, persist: { pick: 'a' } })).toThrow(
      ConfigError
    );
    expect(() => store.registerSlice('x', { initial: {}, persist: { pick: [''] } })).toThrow(
      ConfigError
    );
    expect(() => store.registerSlice('x', { initial: {}, persist: { ttlMs: -5 } })).toThrow(
      ConfigError
    );
    expect(() => store.registerSlice('x', { initial: {}, persist: { version: 1.5 } })).toThrow(
      ConfigError
    );
    expect(() => store.registerSlice('x', { initial: {}, persist: true, migrate: 'no' })).toThrow(
      ConfigError
    );
    expect(() =>
      store.registerSlice('x', { initial: {}, persist: { debounceMs: 'fast' } })
    ).toThrow(ConfigError);
    expect(store.hasSlice('x')).toBe(false);
  });
});

// ── set ──────────────────────────────────────────────────────────────────────────────────────────

describe('store.set', () => {
  it('merges a partial object and keeps structural sharing', () => {
    const { store } = makeStore();
    const before = store.getState();
    store.set('search', { status: 'loading' });
    const after = store.getState();
    expect(after).not.toBe(before);
    expect(after.search.status).toBe('loading');
    expect(after.search.offers).toBe(before.search.offers);
    expect(after.search.filters).toBe(before.search.filters);
    expect(after.prefs).toBe(before.prefs);
    expect(Object.isFrozen(after.search)).toBe(true);
    expect(Object.isFrozen(after)).toBe(true);
  });

  it('applies an updater function and reads back synchronously', () => {
    const { store } = makeStore();
    store.set('search', (s) => ({ ...s, history: [...s.history, { id: 'h1' }] }));
    expect(store.get('search.history')).toEqual([{ id: 'h1' }]);
    expect(store.getState().search.history).toHaveLength(1);
    store.set('search', (s) => ({ ...s, history: [...s.history, { id: 'h2' }] }));
    expect(store.get('search.history')).toHaveLength(2);
  });

  it('is a no-op when nothing changes', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const snap = store.getSnapshot();
    store.set('search', { status: 'idle' });
    store.set('search', (s) => s);
    await tick();
    expect(store.getSnapshot()).toBe(snap);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects unknown slices and bad updaters with ValidationError', () => {
    const { store } = makeStore();
    expect(() => store.set('nope', { a: 1 })).toThrow(ValidationError);
    expect(() => store.set('search', 'loading')).toThrow(ValidationError);
    expect(() => store.set('search', null)).toThrow(ValidationError);
    expect(() => store.set('search', { status: 'x' }, 'meta')).toThrow(ValidationError);
    let caught;
    try {
      store.set('search', (s) => {
        const copy = { ...s, status: 'mutated' };
        void copy; // forgot to return the next state
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.issues[0].code).toBe('invalid_return');
    expect(store.get('search.status')).toBe('idle');
  });

  it('uses meta.action in the change, defaulting to `<slice>/set`', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('search', { status: 'loading' }, { action: 'search/create', requestId: 'r1' });
    store.set('prefs', { currency: 'USD' });
    await tick();
    const change = listener.mock.calls[0][2];
    expect(change.actions).toEqual(['search/create', 'prefs/set']);
    expect(change.changes[0]).toMatchObject({
      slice: 'search',
      action: 'search/create',
      meta: { action: 'search/create', requestId: 'r1' },
    });
    expect(change.changes[0].prev.status).toBe('idle');
    expect(change.changes[0].next.status).toBe('loading');
  });

  it('replaces a non-object slice value with the partial', () => {
    const store = createStore();
    store.registerSlice('count', { initial: 0 });
    store.set('count', (n) => n + 1);
    expect(store.get('count')).toBe(1);
    expect(() => store.set('count', (n) => n)).not.toThrow();
  });
});

// ── batching and plain subscribe ─────────────────────────────────────────────────────────────────

describe('batched notification (plain subscribe)', () => {
  it('notifies once per microtask for several sets, with (state, prev, change)', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const before = store.getState();
    store.set('search', { status: 'loading' });
    store.set('search', { status: 'streaming' });
    store.set('prefs', { currency: 'USD' });
    expect(listener).not.toHaveBeenCalled();
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    const [state, prev, change] = listener.mock.calls[0];
    expect(state).toBe(store.getState());
    expect(prev).toBe(before);
    expect(change.slices).toEqual(['search', 'prefs']);
    expect(change.actions).toEqual(['search/set', 'search/set', 'prefs/set']);
    expect(change.changes).toHaveLength(3);
    expect(Object.isFrozen(change)).toBe(true);
    off();
    off();
    store.set('prefs', { currency: 'EUR' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('getSnapshot returns the same reference until a commit', async () => {
    const { store } = makeStore();
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    await tick();
    expect(store.getSnapshot()).toBe(a);
    store.set('prefs', { currency: 'USD' });
    const b = store.getSnapshot();
    expect(b).not.toBe(a);
    expect(store.getSnapshot()).toBe(b);
    await tick();
    expect(store.getSnapshot()).toBe(b);
  });

  it('registers the same function twice as two subscriptions', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    const off1 = store.subscribe(listener);
    store.subscribe(listener);
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(2);
    off1();
    store.set('prefs', { currency: 'EUR' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('fireImmediately calls the plain listener with the current state at once', () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener, { fireImmediately: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(store.getState(), undefined, undefined);
  });

  it('routes a throwing listener to the error event and keeps notifying the others', async () => {
    const events = fakeEvents();
    const { store } = makeStore({ events });
    const second = vi.fn();
    store.subscribe(() => {
      throw new TypeError('boom');
    });
    store.subscribe(second);
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(second).toHaveBeenCalledTimes(1);
    const error = events.calls.find((c) => c.type === 'error');
    expect(error).toBeDefined();
    expect(error.payload.error).toBeInstanceOf(SdkError);
    expect(error.payload.error.message).toMatch(/boom/);
  });

  it('falls back to logger.error for listener faults when there is no emitter', async () => {
    const logger = fakeLogger();
    const { store } = makeStore({ logger });
    store.subscribe(() => {
      throw new Error('bad listener');
    });
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1].error).toBeInstanceOf(SdkError);
  });

  it('a set made inside a listener is delivered in a later batch', async () => {
    const { store } = makeStore();
    const seen = [];
    store.subscribe((state) => {
      seen.push(state.search.status);
      if (state.search.status === 'loading') store.set('search', { status: 'complete' });
    });
    store.set('search', { status: 'loading' });
    await tick();
    expect(seen).toEqual(['loading', 'complete']);
  });

  it('validates its arguments', () => {
    const { store } = makeStore();
    expect(() => store.subscribe()).toThrow(ValidationError);
    expect(() => store.subscribe('x')).toThrow(ValidationError);
    expect(() => store.subscribe(() => {}, 'opts')).toThrow(ValidationError);
    expect(() =>
      store.subscribe(
        (s) => s,
        () => {},
        { equality: 'eq' }
      )
    ).toThrow(ValidationError);
  });
});

// ── selector subscribe ───────────────────────────────────────────────────────────────────────────

describe('subscribe(selector, listener, options)', () => {
  it('fires only when the selected value changes, with (value, prev)', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe((s) => s.search.status, listener);
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(listener).not.toHaveBeenCalled();
    store.set('search', { status: 'loading' });
    store.set('search', { status: 'streaming' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('streaming', 'idle');
    store.set('search', { params: { tripType: 'round_trip' } });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('honours a custom equality (shallowEqual) and fireImmediately', async () => {
    const { store } = makeStore();
    const strict = vi.fn();
    const shallow = vi.fn();
    store.subscribe((s) => ({ status: s.search.status }), strict);
    store.subscribe((s) => ({ status: s.search.status }), shallow, {
      equality: shallowEqual,
      fireImmediately: true,
    });
    expect(shallow).toHaveBeenCalledTimes(1);
    expect(shallow).toHaveBeenCalledWith({ status: 'idle' }, undefined);
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(strict).toHaveBeenCalledTimes(1); // new object every time
    expect(shallow).toHaveBeenCalledTimes(1); // same content
    store.set('search', { status: 'loading' });
    await tick();
    expect(shallow).toHaveBeenCalledTimes(2);
    expect(shallow).toHaveBeenLastCalledWith({ status: 'loading' }, { status: 'idle' });
  });

  it('off() stops it and a throwing selector is reported, not thrown', async () => {
    const events = fakeEvents();
    const { store } = makeStore({ events });
    const listener = vi.fn();
    const off = store.subscribe((s) => s.search.status, listener);
    store.subscribe((s) => {
      if (s.search.status === 'loading') throw new Error('selector failed');
      return s.search.status;
    }, vi.fn());
    store.set('search', { status: 'loading' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(events.calls.filter((c) => c.type === 'error')).toHaveLength(1);
    off();
    store.set('search', { status: 'complete' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── select ───────────────────────────────────────────────────────────────────────────────────────

describe('store.select', () => {
  it('memoises by selector identity and state reference', () => {
    const { store } = makeStore();
    const selector = vi.fn((s) => s.search.offers.allIds.length);
    expect(store.select(selector)).toBe(0);
    expect(store.select(selector)).toBe(0);
    expect(selector).toHaveBeenCalledTimes(1);
    store.set('search', (s) => ({ ...s, offers: { byId: { a: {} }, allIds: ['a'] } }));
    expect(store.select(selector)).toBe(1);
    expect(selector).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous result when equality says equal', () => {
    const { store } = makeStore();
    const selector = (s) => ({ status: s.search.status });
    const first = store.select(selector, shallowEqual);
    store.set('prefs', { currency: 'USD' });
    const second = store.select(selector, shallowEqual);
    expect(second).toBe(first);
    store.set('search', { status: 'loading' });
    expect(store.select(selector, shallowEqual)).toEqual({ status: 'loading' });
  });

  it('validates its arguments', () => {
    const { store } = makeStore();
    expect(() => store.select('x')).toThrow(ValidationError);
    expect(() => store.select((s) => s, 'eq')).toThrow(ValidationError);
  });

  it('get() reads paths and the whole state', () => {
    const { store } = makeStore();
    expect(store.get()).toBe(store.getState());
    expect(store.get('search.filters.stops')).toEqual([]);
    expect(store.get(['prefs', 'locale'])).toBe('en-IN');
    expect(store.get('search.missing.deep')).toBeUndefined();
    expect(() => store.get(5)).toThrow(ValidationError);
  });
});

// ── batch ────────────────────────────────────────────────────────────────────────────────────────

describe('store.batch', () => {
  it('groups sets into one synchronous notification when the outermost batch ends', () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.batch(() => {
      store.set('search', { status: 'loading' });
      store.batch(() => {
        store.set('prefs', { currency: 'USD' });
      });
      expect(listener).not.toHaveBeenCalled();
      store.set('search', { status: 'streaming' });
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][2].slices).toEqual(['search', 'prefs']);
    expect(listener.mock.calls[0][2].actions).toHaveLength(3);
  });

  it('still notifies (and rethrows) when the callback throws', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.batch(() => {
        store.set('search', { status: 'loading' });
        throw new TypeError('inside');
      })
    ).toThrow(TypeError);
    expect(listener).toHaveBeenCalledTimes(1);
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => store.batch('nope')).toThrow(ValidationError);
  });

  it('includes a set made before the batch in the same notification', async () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('prefs', { currency: 'USD' });
    store.batch(() => store.set('search', { status: 'loading' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][2].slices).toEqual(['prefs', 'search']);
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── reset ────────────────────────────────────────────────────────────────────────────────────────

describe('store.reset', () => {
  it('returns one slice to its initial value and removes its persisted copy', async () => {
    const { store, storage } = makeStore({ persist: { debounceMs: 0 } });
    store.registerSlice('x', { initial: { n: 0 }, persist: true });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('x', { n: 5 });
    store.set('search', { status: 'loading' });
    await tick();
    expect(storage.get('state:x')).toEqual({ v: 1, d: { n: 5 } });
    store.reset('x');
    await tick();
    expect(store.get('x.n')).toBe(0);
    expect(store.get('search.status')).toBe('loading');
    expect(storage.get('state:x')).toBeUndefined();
    expect(listener.mock.calls[1][2].actions).toEqual(['@@reset']);
  });

  it('resets every slice when called without arguments', async () => {
    const { store } = makeStore();
    store.set('search', { status: 'loading' });
    store.set('prefs', { currency: 'USD' });
    store.reset();
    expect(store.getState().search).toBe(SEARCH_INITIAL);
    expect(store.getState().prefs).toBe(PREFS_INITIAL);
    expect(() => store.reset('nope')).toThrow(ValidationError);
  });
});

// ── middleware ───────────────────────────────────────────────────────────────────────────────────

describe('store.use (middleware)', () => {
  it('sees { slice, action, prev, next, meta } and may cancel or rewrite a commit', async () => {
    const { store } = makeStore();
    const seen = [];
    const off = store.use((ctx, proceed) => {
      seen.push(ctx);
      if (ctx.action === 'search/blocked') return; // cancel
      if (ctx.action === 'search/rewrite') {
        proceed({ ...ctx.next, status: 'rewritten' });
        proceed({ ...ctx.next, status: 'second-call-ignored' });
        return;
      }
      proceed();
    });
    store.set('search', { status: 'loading' }, { action: 'search/blocked', reason: 'test' });
    expect(store.get('search.status')).toBe('idle');
    expect(seen[0]).toMatchObject({
      slice: 'search',
      action: 'search/blocked',
      meta: { action: 'search/blocked', reason: 'test' },
    });
    expect(seen[0].prev.status).toBe('idle');
    expect(seen[0].next.status).toBe('loading');
    store.set('search', { status: 'loading' }, { action: 'search/rewrite' });
    expect(store.get('search.status')).toBe('rewritten');
    off();
    off();
    store.set('search', { status: 'loading' }, { action: 'search/blocked' });
    expect(store.get('search.status')).toBe('loading');
    expect(() => store.use('x')).toThrow(ValidationError);
  });

  it('runs middleware in installation order, outer to inner', () => {
    const { store } = makeStore();
    const order = [];
    store.use((ctx, proceed) => {
      order.push('a:before');
      proceed();
      order.push('a:after');
    });
    store.use((ctx, proceed) => {
      order.push('b:before');
      proceed();
      order.push('b:after');
    });
    store.set('prefs', { currency: 'USD' });
    expect(order).toEqual(['a:before', 'b:before', 'b:after', 'a:after']);
  });

  it('wraps internal commits too (reset / restore / hydrate carry @@ actions)', () => {
    const { store } = makeStore();
    const actions = [];
    store.use((ctx, proceed) => {
      actions.push(ctx.action);
      proceed();
    });
    store.set('prefs', { currency: 'USD' });
    store.reset('prefs');
    store.restore({ slices: { prefs: { currency: 'AED' } } });
    expect(actions).toEqual(['prefs/set', '@@reset', '@@restore']);
  });
});

// ── events ───────────────────────────────────────────────────────────────────────────────────────

describe('state:change events', () => {
  it('emits one state:change { slice, action } per set after the batch commits', async () => {
    const events = fakeEvents();
    const { store } = makeStore({ events });
    events.calls.length = 0;
    store.set('search', { status: 'loading' }, { action: 'search/create' });
    store.set('prefs', { currency: 'USD' });
    expect(events.calls).toHaveLength(0);
    await tick();
    expect(events.calls).toEqual([
      { type: 'state:change', payload: { slice: 'search', action: 'search/create' } },
      { type: 'state:change', payload: { slice: 'prefs', action: 'prefs/set' } },
    ]);
  });

  it('survives an emitter that throws', async () => {
    const events = {
      emit: () => {
        throw new Error('emitter down');
      },
    };
    const { store } = makeStore({ events });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── persistence ──────────────────────────────────────────────────────────────────────────────────

describe('persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a persisted slice through the storage facade, debounced', async () => {
    const storage = createStorage({ driver: 'memory' });
    const setSpy = vi.spyOn(storage, 'set');
    const store = createStore({ storage, persist: { debounceMs: 100 } });
    store.registerSlice('search', { initial: SEARCH_INITIAL, persist: { pick: ['history'] } });
    store.set('search', (s) => ({ ...s, status: 'loading', history: [{ id: 'h1' }] }));
    store.set('search', (s) => ({ ...s, history: [...s.history, { id: 'h2' }] }));
    expect(vi.getTimerCount()).toBe(0);
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    expect(setSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    store.set('search', (s) => ({ ...s, history: [...s.history, { id: 'h3' }] }));
    await tick();
    await vi.advanceTimersByTimeAsync(99);
    expect(setSpy).not.toHaveBeenCalled(); // debounce restarted
    await vi.advanceTimersByTimeAsync(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(storage.get('state:search')).toEqual({
      v: 1,
      d: { history: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }] },
    });
    expect(vi.getTimerCount()).toBe(0);
    store.destroy();
  });

  it('does not persist slices without a persist option', async () => {
    const storage = createStorage({ driver: 'memory' });
    const setSpy = vi.spyOn(storage, 'set');
    const store = createStore({ storage, persist: { debounceMs: 0 } });
    store.registerSlice('search', { initial: SEARCH_INITIAL });
    store.set('search', { status: 'loading' });
    await tick();
    expect(setSpy).not.toHaveBeenCalled();
    expect(storage.keys()).toEqual([]);
  });

  it('uses injectable timers', async () => {
    const storage = createStorage({ driver: 'memory' });
    const handles = [];
    const timers = {
      setTimeout: vi.fn((fn, ms) => {
        const h = { fn, ms };
        handles.push(h);
        return h;
      }),
      clearTimeout: vi.fn((h) => {
        h.cleared = true;
      }),
    };
    const store = createStore({ storage, timers, persist: { debounceMs: 50 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers.setTimeout.mock.calls[0][1]).toBe(50);
    expect(vi.getTimerCount()).toBe(0); // nothing went to the global timers
    store.set('prefs', { currency: 'EUR' });
    await tick();
    expect(timers.clearTimeout).toHaveBeenCalledWith(handles[0]);
    expect(timers.setTimeout).toHaveBeenCalledTimes(2);
    handles[1].fn();
    expect(storage.get('state:prefs')).toEqual({ v: 1, d: { ...PREFS_INITIAL, currency: 'EUR' } });
    store.destroy();
    expect(handles[1].cleared).toBeUndefined(); // already fired, nothing to clear
  });

  it('writes synchronously at commit time when debounceMs is 0 and passes ttlMs', async () => {
    const storage = createStorage({ driver: 'memory' });
    const setSpy = vi.spyOn(storage, 'set');
    const store = createStore({ storage, persist: { debounceMs: 0 } });
    store.registerSlice('bootstrap', {
      initial: { loaded: false, flags: {} },
      persist: { ttlMs: 60_000 },
    });
    store.set('bootstrap', { loaded: true });
    await tick();
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0][0]).toBe('state:bootstrap');
    expect(setSpy.mock.calls[0][2]).toEqual({ ttlMs: 60_000 });
    expect(storage.get('state:bootstrap')).toEqual({ v: 1, d: { loaded: true, flags: {} } });
    vi.advanceTimersByTime(60_000);
    expect(storage.get('state:bootstrap')).toBeUndefined(); // expired by the facade
  });

  it('persists dotted pick paths and hydrates only those on register', async () => {
    const storage = createStorage({ driver: 'memory' });
    const make = () => {
      const store = createStore({ storage, persist: { debounceMs: 0 } });
      store.registerSlice('itinerary', {
        initial: { current: null, status: 'idle', travelers: [] },
        persist: { pick: ['current.id'] },
      });
      return store;
    };
    const a = make();
    a.set('itinerary', {
      current: { id: 'it_1', total: { amount: '10.00', currency: 'INR' } },
      status: 'active',
    });
    await tick();
    expect(storage.get('state:itinerary')).toEqual({ v: 1, d: { current: { id: 'it_1' } } });
    const b = make();
    expect(b.getState().itinerary).toEqual({
      current: { id: 'it_1' },
      status: 'idle',
      travelers: [],
    });
  });

  it('hydrates on register (shallow merge over initial) and notifies with @@hydrate', async () => {
    const storage = createStorage({ driver: 'memory' });
    storage.set('state:prefs', { v: 1, d: { locale: 'en-US', currency: 'USD' } });
    const events = fakeEvents();
    const store = createStore({ storage, events });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    expect(store.getState().prefs).toEqual({ locale: 'en-US', currency: 'USD', hour12: true });
    expect(Object.isFrozen(store.getState().prefs)).toBe(true);
    await tick();
    expect(events.calls.map((c) => c.payload.action)).toEqual(['@@init', '@@hydrate']);
    expect(vi.getTimerCount()).toBe(0); // hydration never schedules a write
  });

  it('migrates data stored under another version (legacy raw values are version 0)', async () => {
    const storage = createStorage({ driver: 'memory' });
    storage.set('state:prefs', { locale: 'en-US', cur: 'USD' });
    const migrate = vi.fn((old, version) => ({
      ...old,
      currency: old.cur,
      migratedFrom: version,
    }));
    const store = createStore({ storage });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: { version: 2 }, migrate });
    expect(migrate).toHaveBeenCalledWith({ locale: 'en-US', cur: 'USD' }, 0);
    expect(store.getState().prefs).toMatchObject({
      locale: 'en-US',
      currency: 'USD',
      migratedFrom: 0,
    });
    store.set('prefs', { hour12: false });
    await tick();
    await vi.runAllTimersAsync();
    expect(storage.get('state:prefs').v).toBe(2);
  });

  it('drops stored data on a version mismatch without migrate, when migrate returns undefined or throws', () => {
    const logger = fakeLogger();
    const storage = createStorage({ driver: 'memory' });
    storage.set('state:a', { v: 1, d: { x: 1 } });
    storage.set('state:b', { v: 1, d: { x: 1 } });
    storage.set('state:c', { v: 1, d: { x: 1 } });
    const store = createStore({ storage, logger });
    store.registerSlice('a', { initial: { x: 0 }, persist: { version: 2 } });
    store.registerSlice('b', {
      initial: { x: 0 },
      persist: { version: 2, migrate: () => undefined },
    });
    store.registerSlice('c', {
      initial: { x: 0 },
      persist: {
        version: 2,
        migrate: () => {
          throw new Error('cannot migrate');
        },
      },
    });
    expect(store.getState()).toEqual({ a: { x: 0 }, b: { x: 0 }, c: { x: 0 } });
    expect(storage.keys()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('ignores corrupt stored data for a picked slice', () => {
    const storage = createStorage({ driver: 'memory' });
    storage.set('state:prefs', { v: 1, d: 'garbage' });
    const store = createStore({ storage });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: { pick: ['currency'] } });
    expect(store.getState().prefs).toBe(PREFS_INITIAL);
  });

  it('persist.flush writes now, persist.hydrate re-reads, persist.clear removes', async () => {
    const storage = createStorage({ driver: 'memory' });
    const store = createStore({ storage, persist: { debounceMs: 1000 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    await expect(store.persist.flush()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(storage.get('state:prefs').d.currency).toBe('USD');

    // another tab changed storage; a pending local write is discarded by an explicit hydrate
    storage.set('state:prefs', { v: 1, d: { ...PREFS_INITIAL, currency: 'AED' } });
    store.set('prefs', { currency: 'EUR' });
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    await expect(store.persist.hydrate('prefs')).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.get('prefs.currency')).toBe('AED');
    await vi.runAllTimersAsync();
    expect(storage.get('state:prefs').d.currency).toBe('AED');

    store.persist.clear('prefs');
    expect(storage.get('state:prefs')).toBeUndefined();
    expect(store.get('prefs.currency')).toBe('AED');
    await expect(store.persist.hydrate()).resolves.toBeUndefined();
    store.persist.clear();
    expect(() => store.persist.hydrate('nope')).toThrow(ValidationError);
    expect(() => store.persist.clear('nope')).toThrow(ValidationError);
  });

  it('routes each kind to the storage factory and caches the result per kind', async () => {
    const local = createStorage({ driver: 'memory', namespace: 'local' });
    const session = createStorage({ driver: 'memory', namespace: 'session' });
    const memory = createStorage({ driver: 'memory', namespace: 'memory' });
    const factory = vi.fn((kind) => ({ local, session, memory })[kind]);
    const store = createStore({ storage: factory, persist: { debounceMs: 0 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.registerSlice('travelers', {
      initial: { profiles: [], drafts: {} },
      persist: { storage: 'session', pick: ['drafts'] },
    });
    store.registerSlice('ui', { initial: { busy: {} }, persist: { storage: 'memory' } });
    store.set('prefs', { currency: 'USD' });
    store.set('travelers', { drafts: { slot1: { firstName: 'A' } } });
    store.set('ui', { busy: { search: true } });
    await tick();
    expect(factory.mock.calls.map((c) => c[0])).toEqual(['local', 'session', 'memory']);
    expect(local.get('state:prefs').d.currency).toBe('USD');
    expect(session.get('state:travelers')).toEqual({
      v: 1,
      d: { drafts: { slot1: { firstName: 'A' } } },
    });
    expect(memory.get('state:ui').d.busy).toEqual({ search: true });
    expect(local.keys()).toEqual(['state:prefs']);
  });

  it('with a single facade, local and session share it while memory stays internal', async () => {
    const storage = createStorage({ driver: 'memory' });
    const store = createStore({ storage, persist: { debounceMs: 0 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.registerSlice('drafts', { initial: { a: 1 }, persist: { storage: 'session' } });
    store.registerSlice('ui', { initial: { busy: {} }, persist: { storage: 'memory' } });
    store.set('prefs', { currency: 'USD' });
    store.set('drafts', { a: 2 });
    store.set('ui', { busy: { x: true } });
    await tick();
    expect(storage.keys().sort()).toEqual(['state:drafts', 'state:prefs']);
    // the memory copy still hydrates a store sharing the same persistence (same store instance only)
    store.set('ui', { busy: {} });
    await tick();
    await store.persist.hydrate('ui');
    expect(store.get('ui.busy')).toEqual({});
  });

  it('rejects a factory that does not return a Storage', () => {
    const store = createStore({ storage: () => ({}) });
    expect(() => store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true })).toThrow(
      ConfigError
    );
  });

  it('persist: false disables persistence for every slice', async () => {
    const storage = createStorage({ driver: 'memory' });
    const setSpy = vi.spyOn(storage, 'set');
    const store = createStore({ storage, persist: false });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.set('prefs', { currency: 'USD' });
    await tick();
    await vi.runAllTimersAsync();
    expect(setSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to an internal memory facade when no storage is given', async () => {
    const store = createStore({ persist: { debounceMs: 0 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.set('prefs', { currency: 'USD' });
    await tick();
    store.set('prefs', { currency: 'EUR' });
    await store.persist.hydrate('prefs');
    expect(store.get('prefs.currency')).toBe('USD');
  });

  it('a failing storage write is logged and the state stands', async () => {
    const logger = fakeLogger();
    const storage = createStorage({ driver: 'memory' });
    const store = createStore({ storage, logger, persist: { debounceMs: 0 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.set('prefs', { currency: 'USD', cyclic: undefined });
    const cyclic = {};
    cyclic.self = cyclic;
    store.set('prefs', { cyclic });
    await tick();
    expect(store.get('prefs.cyclic')).toBe(cyclic);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not persist/);
  });

  it('a read failure during hydration is logged and the initial state is kept', () => {
    const logger = fakeLogger();
    const storage = {
      get: () => {
        throw new Error('read failed');
      },
      set: vi.fn(),
      remove: vi.fn(),
    };
    const store = createStore({ storage, logger });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    expect(store.getState().prefs).toBe(PREFS_INITIAL);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('destroy() flushes pending writes and leaves no timers', async () => {
    const storage = createStorage({ driver: 'memory' });
    const store = createStore({ storage, persist: { debounceMs: 500 } });
    store.registerSlice('prefs', { initial: PREFS_INITIAL, persist: true });
    store.registerSlice('search', { initial: SEARCH_INITIAL, persist: { pick: ['history'] } });
    store.set('prefs', { currency: 'USD' });
    store.set('search', (s) => ({ ...s, history: [{ id: 'h1' }] }));
    await tick();
    expect(vi.getTimerCount()).toBe(2);
    store.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(storage.get('state:prefs').d.currency).toBe('USD');
    expect(storage.get('state:search')).toEqual({ v: 1, d: { history: [{ id: 'h1' }] } });
    store.set('prefs', { currency: 'EUR' });
    await tick();
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(storage.get('state:prefs').d.currency).toBe('USD');
    store.destroy(); // idempotent
  });
});

// ── snapshot / restore ───────────────────────────────────────────────────────────────────────────

describe('store.snapshot / store.restore', () => {
  it('copies every non-secret slice as plain data', () => {
    const now = vi.fn(() => 1234);
    const { store } = makeStore({ now });
    store.registerSlice('session', {
      initial: { status: 'anonymous', accessToken: null },
      secret: true,
    });
    store.set('session', { status: 'authenticated', accessToken: 'tok' });
    store.set('search', { status: 'complete' });
    const snap = store.snapshot();
    expect(snap).toEqual({
      version: 1,
      at: 1234,
      slices: { search: { ...SEARCH_INITIAL, status: 'complete' }, prefs: PREFS_INITIAL },
    });
    expect(snap.slices).not.toHaveProperty('session');
    expect(snap.slices.search).not.toBe(store.getState().search);
    expect(Object.isFrozen(snap.slices.search)).toBe(false);
    snap.slices.search.status = 'mutated';
    expect(store.get('search.status')).toBe('complete');
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('restores slices over their initial value, skipping secrets and notifying with @@restore', async () => {
    const { store } = makeStore();
    store.registerSlice('session', { initial: { status: 'anonymous', token: null }, secret: true });
    await tick(); // deliver the @@init of `session` before listening
    const listener = vi.fn();
    store.subscribe(listener);
    // JSON.parse yields an own `__proto__` key (an object literal would set the prototype instead).
    const slices = JSON.parse(
      '{"search": {"status": "complete", "visibleIds": ["o1"]},' +
        ' "session": {"status": "authenticated", "token": "leaked"},' +
        ' "__proto__": {"polluted": true}}'
    );
    store.restore({ version: 1, at: 1, slices });
    expect(store.getState().search).toEqual({
      ...SEARCH_INITIAL,
      status: 'complete',
      visibleIds: ['o1'],
    });
    expect(store.getState().session).toEqual({ status: 'anonymous', token: null });
    expect(store.getState().prefs).toBe(PREFS_INITIAL);
    expect(store.getState()).not.toHaveProperty('polluted');
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][2].actions).toEqual(['@@restore']);
    expect(() => store.restore(null)).toThrow(ValidationError);
    expect(() => store.restore({ slices: [] })).toThrow(ValidationError);
  });

  it('applies snapshot slices that register later (SSR hydration before module install)', () => {
    const store = createStore();
    store.restore({ slices: { booking: { lastReference: 'PNR123' }, secretLater: { t: 1 } } });
    store.registerSlice('booking', { initial: { current: null, lastReference: null } });
    expect(store.getState().booking).toEqual({ current: null, lastReference: 'PNR123' });
    store.registerSlice('secretLater', { initial: { t: 0 }, secret: true });
    expect(store.getState().secretLater).toEqual({ t: 0 });
  });

  it('round-trips through a second store', () => {
    const { store: a } = makeStore();
    a.set('search', { status: 'complete', history: [{ id: 'h1' }] });
    a.set('prefs', { currency: 'USD' });
    const { store: b } = makeStore();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.getState()).toEqual(a.getState());
  });
});

// ── interop: getSnapshot / toObservable ──────────────────────────────────────────────────────────

describe('store.toObservable', () => {
  it('emits the current value on subscribe, then on every change of the selected value', async () => {
    const { store } = makeStore();
    const next = vi.fn();
    const sub = store.toObservable((s) => s.search.status).subscribe({ next });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith('idle');
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(next).toHaveBeenCalledTimes(1);
    store.set('search', { status: 'loading' });
    store.set('search', { status: 'streaming' });
    await tick();
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenLastCalledWith('streaming');
    expect(sub.closed).toBe(false);
    sub.unsubscribe();
    expect(sub.closed).toBe(true);
    store.set('search', { status: 'complete' });
    await tick();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('accepts a plain next function and defaults to the whole state', async () => {
    const { store } = makeStore();
    const next = vi.fn();
    store.toObservable().subscribe(next);
    expect(next).toHaveBeenCalledWith(store.getState());
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenLastCalledWith(store.getState());
    expect(() => store.toObservable().subscribe()).toThrow(ValidationError);
    expect(() => store.toObservable('x')).toThrow(ValidationError);
  });

  it('is interoperable: @@observable and Symbol.observable return the observable itself', () => {
    const { store } = makeStore();
    const had = Object.getOwnPropertyDescriptor(Symbol, 'observable');
    if (!had) {
      Object.defineProperty(Symbol, 'observable', {
        value: Symbol('observable'),
        configurable: true,
      });
    }
    try {
      const observable = store.toObservable();
      expect(observable['@@observable']()).toBe(observable);
      expect(observable[Symbol.observable]()).toBe(observable);
    } finally {
      if (!had) delete Symbol.observable;
    }
    const plain = createStore().toObservable();
    expect(typeof plain['@@observable']).toBe('function');
  });

  it('completes observers on destroy and errors them when the selector throws', async () => {
    const { store } = makeStore();
    const complete = vi.fn();
    const error = vi.fn();
    const next = vi.fn();
    store.toObservable().subscribe({ next, complete });
    const failing = store
      .toObservable((s) => {
        if (s.search.status === 'loading') throw new Error('selector failed');
        return s.search.status;
      })
      .subscribe({ next: vi.fn(), error });
    store.set('search', { status: 'loading' });
    await tick();
    expect(error).toHaveBeenCalledTimes(1);
    expect(failing.closed).toBe(true);
    const immediate = vi.fn();
    const failedAtOnce = store
      .toObservable(() => {
        throw new Error('now');
      })
      .subscribe({ error: immediate });
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(failedAtOnce.closed).toBe(true);
    store.destroy();
    expect(complete).toHaveBeenCalledTimes(1);
    const late = store.toObservable().subscribe({ next: vi.fn(), complete });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(late.closed).toBe(true);
  });

  it('works as a useSyncExternalStore pair (subscribe + getSnapshot)', async () => {
    const { store } = makeStore();
    let snapshot = store.getSnapshot();
    let renders = 0;
    const off = store.subscribe(() => {
      const next = store.getSnapshot();
      if (next !== snapshot) {
        snapshot = next;
        renders += 1;
      }
    });
    store.set('search', { status: 'loading' });
    store.set('prefs', { currency: 'USD' });
    await tick();
    expect(renders).toBe(1);
    expect(snapshot.search.status).toBe('loading');
    off();
  });
});

// ── devtools ─────────────────────────────────────────────────────────────────────────────────────

describe('devtools', () => {
  it('logs every commit through logger.debug, redacting secret slices', () => {
    const logger = fakeLogger();
    const store = createStore({ devtools: true, logger });
    store.registerSlice('prefs', { initial: PREFS_INITIAL });
    store.registerSlice('session', { initial: { token: null }, secret: true });
    store.set('prefs', { currency: 'USD' }, { action: 'prefs/setCurrency' });
    store.set('session', { token: 'secret-token' });
    const messages = logger.debug.mock.calls.map((c) => c[0]);
    expect(messages).toEqual([
      '[store] @@init',
      '[store] @@init',
      '[store] prefs/setCurrency',
      '[store] session/set',
    ]);
    expect(logger.debug.mock.calls[2][1]).toEqual({
      slice: 'prefs',
      action: 'prefs/setCurrency',
      prev: PREFS_INITIAL,
      next: { ...PREFS_INITIAL, currency: 'USD' },
    });
    expect(logger.debug.mock.calls[3][1]).toEqual({
      slice: 'session',
      action: 'session/set',
      secret: true,
    });
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('secret-token');
  });

  it('is silent without a logger or when devtools is off, and survives a throwing logger', () => {
    const logger = fakeLogger();
    const quiet = createStore({ devtools: false, logger });
    quiet.registerSlice('prefs', { initial: PREFS_INITIAL });
    quiet.set('prefs', { currency: 'USD' });
    expect(logger.debug).not.toHaveBeenCalled();
    const loud = createStore({
      devtools: true,
      logger: {
        debug: () => {
          throw new Error('logger down');
        },
      },
    });
    loud.registerSlice('prefs', { initial: PREFS_INITIAL });
    expect(() => loud.set('prefs', { currency: 'USD' })).not.toThrow();
    expect(() => createStore({ devtools: true }).registerSlice('x', { initial: {} })).not.toThrow();
  });
});

// ── destroy ──────────────────────────────────────────────────────────────────────────────────────

describe('store.destroy', () => {
  it('clears listeners and subscriptions; later writes stay silent', async () => {
    const events = fakeEvents();
    const { store } = makeStore({ events });
    const plain = vi.fn();
    const selectorListener = vi.fn();
    store.subscribe(plain);
    store.subscribe((s) => s.prefs.currency, selectorListener);
    store.set('prefs', { currency: 'USD' });
    store.destroy();
    await tick();
    expect(plain).not.toHaveBeenCalled();
    expect(selectorListener).not.toHaveBeenCalled();
    events.calls.length = 0;
    store.set('prefs', { currency: 'EUR' });
    expect(store.get('prefs.currency')).toBe('EUR');
    await tick();
    expect(events.calls).toEqual([]);
    expect(store.subscribe(plain)).toBeTypeOf('function');
    expect(store.subscribe((s) => s, plain)).toBeTypeOf('function');
    store.set('prefs', { currency: 'AED' });
    await tick();
    expect(plain).not.toHaveBeenCalled();
  });
});

// ── createSelector / shallowEqual ────────────────────────────────────────────────────────────────

describe('createSelector', () => {
  it('recomputes only when an input result changes (last-args memo)', () => {
    const combiner = vi.fn((allIds, byId) => allIds.map((id) => byId[id]));
    const visible = createSelector(
      (s) => s.search.offers.allIds,
      (s) => s.search.offers.byId,
      combiner
    );
    const { store } = makeStore();
    store.set('search', (s) => ({ ...s, offers: { byId: { a: { id: 'a' } }, allIds: ['a'] } }));
    const first = visible(store.getState());
    expect(first).toEqual([{ id: 'a' }]);
    store.set('search', { status: 'complete' }); // offers untouched
    expect(visible(store.getState())).toBe(first);
    expect(combiner).toHaveBeenCalledTimes(1);
    expect(visible.recomputations()).toBe(1);
    store.set('search', (s) => ({
      ...s,
      offers: { byId: { ...s.offers.byId, b: { id: 'b' } }, allIds: ['a', 'b'] },
    }));
    expect(visible(store.getState())).toHaveLength(2);
    expect(visible.recomputations()).toBe(2);
    visible.resetRecomputations();
    expect(visible.recomputations()).toBe(0);
    expect(visible.resultFunc).toBe(combiner);
    expect(visible.dependencies).toHaveLength(2);
  });

  it('accepts inputs as an array, forwards extra arguments and composes with store.select', () => {
    const byIndex = createSelector(
      [(s) => s.list, (s, index) => index],
      (list, index) => list[index]
    );
    expect(byIndex({ list: ['x', 'y'] }, 1)).toBe('y');
    expect(byIndex({ list: ['x', 'y'] }, 0)).toBe('x');
    const { store } = makeStore();
    const count = createSelector(
      (s) => s.search.history,
      (history) => history.length
    );
    expect(store.select(count)).toBe(0);
    store.set('search', (s) => ({ ...s, history: [{ id: 'h' }] }));
    expect(store.select(count)).toBe(1);
  });

  it('validates its arguments', () => {
    expect(() => createSelector()).toThrow(ValidationError);
    expect(() => createSelector((s) => s)).toThrow(ValidationError);
    expect(() => createSelector((s) => s, 'combiner')).toThrow(ValidationError);
    expect(() => createSelector('input', (x) => x)).toThrow(ValidationError);
    expect(() => createSelector([], (x) => x)).toThrow(ValidationError);
  });
});

describe('shallowEqual', () => {
  it('is the object helper, re-exported', () => {
    expect(shallowEqual).toBe(objectShallowEqual);
    expect(shallowEqual({ a: 1, b: [1] }, { a: 1, b: [1] })).toBe(false);
    const arr = [1];
    expect(shallowEqual({ a: 1, b: arr }, { b: arr, a: 1 })).toBe(true);
    expect(shallowEqual([1, NaN], [1, NaN])).toBe(true);
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual({}, null)).toBe(false);
  });
});
