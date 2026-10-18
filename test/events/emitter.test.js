import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEmitter } from '../../src/events/emitter.js';
import {
  AbortError,
  ConfigError,
  SdkError,
  TimeoutError,
  ValidationError,
} from '../../src/errors/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A ticking clock whose readings are deterministic. */
function clock(start = 1000, step = 1) {
  let t = start;
  return vi.fn(() => {
    const value = t;
    t += step;
    return value;
  });
}

/** A `{ error, warn }` logger stand‑in. */
function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn() };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── createEmitter ────────────────────────────────────────────────────────────────────────────────

describe('createEmitter', () => {
  it('returns the documented surface', () => {
    const e = createEmitter();
    for (const k of ['on', 'once', 'off', 'emit', 'waitFor', 'listenerCount', 'clear']) {
      expect(typeof e[k]).toBe('function');
    }
    expect(e.listenerCount()).toBe(0);
  });

  it('defaults `at` to Date.now()', () => {
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    const e = createEmitter();
    const fn = vi.fn();
    e.on('x', fn);
    e.emit('x');
    expect(fn).toHaveBeenCalledWith({ type: 'x', at: Date.parse('2026-10-17T10:00:00Z') });
  });

  it('rejects bad options with ConfigError', () => {
    expect(() => createEmitter(null)).toThrow(ConfigError);
    expect(() => createEmitter('nope')).toThrow(ConfigError);
    expect(() => createEmitter({ now: 'later' })).toThrow(ConfigError);
    expect(() => createEmitter({ logger: 42 })).toThrow(ConfigError);
    expect(() => createEmitter({ logger: [] })).toThrow(ConfigError);
    expect(() => createEmitter({ logger: null, now: undefined })).not.toThrow();
  });

  it('falls back to Date.now() when the injected clock misbehaves', () => {
    vi.setSystemTime(5000);
    const e = createEmitter({
      now: vi.fn(() => {
        throw new TypeError('no clock');
      }),
    });
    const fn = vi.fn();
    e.on('x', fn);
    e.emit('x');
    expect(fn.mock.calls[0][0].at).toBe(5000);
    const e2 = createEmitter({ now: () => Number.NaN });
    e2.on('x', fn);
    e2.emit('x');
    expect(fn.mock.calls[1][0].at).toBe(5000);
  });
});

// ── emit / payload envelope ──────────────────────────────────────────────────────────────────────

describe('emit', () => {
  it('delivers { type, at, ...data } with `at` from the injected clock', () => {
    const now = clock(100);
    const e = createEmitter({ now });
    const fn = vi.fn();
    e.on('search:start', fn);
    e.emit('search:start', { sessionId: 's1' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ type: 'search:start', at: 100, sessionId: 's1' });
    e.emit('search:start', { sessionId: 's2' });
    expect(fn).toHaveBeenLastCalledWith({ type: 'search:start', at: 101, sessionId: 's2' });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('does not read the clock when nobody listens', () => {
    const now = clock();
    const e = createEmitter({ now });
    e.emit('nobody:home', { a: 1 });
    expect(now).not.toHaveBeenCalled();
  });

  it('owns `type` and `at`: same-named fields in the payload are overwritten', () => {
    const e = createEmitter({ now: () => 7 });
    const fn = vi.fn();
    e.on('x', fn);
    e.emit('x', { type: 'forged', at: -1, keep: true });
    expect(fn).toHaveBeenCalledWith({ type: 'x', at: 7, keep: true });
  });

  it('wraps non-object payloads: Error → { error }, anything else → { data }', () => {
    const e = createEmitter({ now: () => 1 });
    const fn = vi.fn();
    e.on('x', fn);
    const err = new SdkError('boom');
    e.emit('x', err);
    expect(fn).toHaveBeenLastCalledWith({ type: 'x', at: 1, error: err });
    e.emit('x', 42);
    expect(fn).toHaveBeenLastCalledWith({ type: 'x', at: 1, data: 42 });
    e.emit('x', [1, 2]);
    expect(fn).toHaveBeenLastCalledWith({ type: 'x', at: 1, data: [1, 2] });
    e.emit('x', null);
    expect(fn).toHaveBeenLastCalledWith({ type: 'x', at: 1, data: null });
    class Thing {
      constructor() {
        this.id = 'thing';
      }
    }
    const thing = new Thing();
    e.emit('x', thing);
    expect(fn).toHaveBeenLastCalledWith({ type: 'x', at: 1, data: thing });
    e.emit('x');
    expect(fn).toHaveBeenLastCalledWith({ type: 'x', at: 1 });
  });

  it('hands every listener the same payload object', () => {
    const e = createEmitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on('x', a);
    e.on('*', b);
    e.emit('x', { v: 1 });
    expect(a.mock.calls[0][0]).toBe(b.mock.calls[0][0]);
  });

  it('returns undefined and never throws because of listeners', () => {
    const e = createEmitter();
    e.on('x', () => {
      throw new Error('listener failure');
    });
    expect(e.emit('x')).toBeUndefined();
  });

  it('rejects empty names and wildcard patterns with ValidationError', () => {
    const e = createEmitter();
    for (const bad of ['', '   ', 'search:*', '*', 42, null, undefined]) {
      let caught;
      try {
        e.emit(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect(caught.issues).toHaveLength(1);
      expect(caught.issues[0].path).toBe('event');
    }
  });
});

// ── on / wildcards / ordering ────────────────────────────────────────────────────────────────────

describe('on', () => {
  it('matches exact names only, for exact subscriptions', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.on('search:start', fn);
    e.emit('search:start');
    e.emit('search:started');
    e.emit('search');
    e.emit('xsearch:start');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("matches a namespace with 'ns:*' (any depth) and everything with '*'", () => {
    const e = createEmitter();
    const ns = vi.fn();
    const deep = vi.fn();
    const all = vi.fn();
    e.on('search:*', ns);
    e.on('search:results:*', deep);
    e.on('*', all);
    e.emit('search:start');
    e.emit('search:results:page');
    e.emit('search');
    e.emit('searching:start');
    e.emit('offer:selected');
    expect(ns.mock.calls.map((c) => c[0].type)).toEqual(['search:start', 'search:results:page']);
    expect(deep.mock.calls.map((c) => c[0].type)).toEqual(['search:results:page']);
    expect(all.mock.calls.map((c) => c[0].type)).toEqual([
      'search:start',
      'search:results:page',
      'search',
      'searching:start',
      'offer:selected',
    ]);
  });

  it('runs listeners in registration order regardless of pattern kind', () => {
    const e = createEmitter();
    const order = [];
    e.on('*', () => order.push('all-1'));
    e.on('search:start', () => order.push('exact-1'));
    e.on('search:*', () => order.push('ns-1'));
    e.on('search:start', () => order.push('exact-2'));
    e.on('*', () => order.push('all-2'));
    e.emit('search:start');
    expect(order).toEqual(['all-1', 'exact-1', 'ns-1', 'exact-2', 'all-2']);
  });

  it('accepts an array of names and the returned off() removes all of them', () => {
    const e = createEmitter();
    const fn = vi.fn();
    const off = e.on(['search:start', 'search:error', 'offer:*'], fn);
    expect(e.listenerCount()).toBe(3);
    e.emit('search:start');
    e.emit('search:error');
    e.emit('offer:selected');
    e.emit('search:complete');
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    expect(e.listenerCount()).toBe(0);
    e.emit('search:start');
    expect(fn).toHaveBeenCalledTimes(3);
    off(); // idempotent
    expect(e.listenerCount()).toBe(0);
  });

  it('de-duplicates repeated names inside one array', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.on(['x', 'x'], fn);
    expect(e.listenerCount('x')).toBe(1);
    e.emit('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('may register the same function more than once (called once per registration)', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.on('x', fn);
    e.on('x', fn);
    e.emit('x');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not fire listeners added during an emit, and skips ones removed during it', () => {
    const e = createEmitter();
    const late = vi.fn();
    const second = vi.fn();
    let offSecond;
    e.on('x', () => {
      e.on('x', late);
      offSecond();
    });
    offSecond = e.on('x', second);
    e.emit('x');
    expect(late).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    e.emit('x');
    expect(late).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('supports nested (re-entrant) emits from inside a listener', () => {
    const e = createEmitter();
    const seen = [];
    e.on('*', (p) => seen.push(p.type));
    e.on('a', () => e.emit('b'));
    e.emit('a');
    expect(seen).toEqual(['a', 'b']);
  });

  it('rejects invalid patterns and listeners with ValidationError', () => {
    const e = createEmitter();
    const fn = () => {};
    const bad = ['', ' ', 'se*rch', '*:change', ':*', 'search:*:x', 'search:**', 7, null];
    for (const pattern of bad) {
      let caught;
      try {
        e.on(pattern, fn);
      } catch (err) {
        caught = err;
      }
      expect(caught, String(pattern)).toBeInstanceOf(ValidationError);
      expect(caught.issues[0].path).toBe('event');
    }
    expect(() => e.on([], fn)).toThrow(ValidationError);
    let caught;
    try {
      e.on(['x', ''], fn);
    } catch (err) {
      caught = err;
    }
    expect(caught.issues[0].path).toBe('event[1]');
    expect(() => e.on('x', 'nope')).toThrow(ValidationError);
    expect(() => e.on('x')).toThrow(ValidationError);
    expect(e.listenerCount()).toBe(0);
  });
});

// ── once ─────────────────────────────────────────────────────────────────────────────────────────

describe('once', () => {
  it('fires a single time and is removed before it runs', () => {
    const e = createEmitter();
    const fn = vi.fn(() => {
      expect(e.listenerCount('x')).toBe(0);
    });
    e.once('x', fn);
    expect(e.listenerCount('x')).toBe(1);
    e.emit('x', { n: 1 });
    e.emit('x', { n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].n).toBe(1);
  });

  it('with an array fires once in total, whichever event comes first', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.once(['search:complete', 'search:error'], fn);
    expect(e.listenerCount()).toBe(2);
    e.emit('search:error');
    e.emit('search:complete');
    e.emit('search:error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].type).toBe('search:error');
    expect(e.listenerCount()).toBe(0);
  });

  it('can be cancelled with the returned off() before it fires', () => {
    const e = createEmitter();
    const fn = vi.fn();
    const off = e.once('x', fn);
    off();
    e.emit('x');
    expect(fn).not.toHaveBeenCalled();
    expect(e.listenerCount()).toBe(0);
  });

  it('is still removed when the listener throws', () => {
    const e = createEmitter();
    const fn = vi.fn(() => {
      throw new Error('once boom');
    });
    e.once('x', fn);
    e.emit('x');
    e.emit('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('validates its arguments', () => {
    const e = createEmitter();
    expect(() => e.once('', () => {})).toThrow(ValidationError);
    expect(() => e.once('x', null)).toThrow(ValidationError);
  });
});

// ── off ──────────────────────────────────────────────────────────────────────────────────────────

describe('off', () => {
  it('removes one listener by reference, leaving the others', () => {
    const e = createEmitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on('x', a);
    e.on('x', b);
    e.off('x', a);
    e.emit('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(e.listenerCount('x')).toBe(1);
  });

  it('removes a once listener by its original reference', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.once('x', fn);
    e.off('x', fn);
    e.emit('x');
    expect(fn).not.toHaveBeenCalled();
  });

  it('removes every listener registered under the name when fn is omitted', () => {
    const e = createEmitter();
    const a = vi.fn();
    const b = vi.fn();
    const ns = vi.fn();
    e.on('x', a);
    e.once('x', b);
    e.on('*', ns);
    e.off('x');
    e.emit('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(ns).toHaveBeenCalledTimes(1);
  });

  it("targets pattern keys: off('*') and off('ns:*') only drop those registrations", () => {
    const e = createEmitter();
    const exact = vi.fn();
    const ns = vi.fn();
    const all = vi.fn();
    e.on('search:start', exact);
    e.on('search:*', ns);
    e.on('*', all);
    e.off('*');
    e.emit('search:start');
    expect(all).not.toHaveBeenCalled();
    expect(exact).toHaveBeenCalledTimes(1);
    expect(ns).toHaveBeenCalledTimes(1);
    e.off('search:*');
    e.emit('search:start');
    expect(ns).toHaveBeenCalledTimes(1);
    expect(exact).toHaveBeenCalledTimes(2);
    expect(e.listenerCount()).toBe(1);
  });

  it('accepts arrays and ignores unknown names / functions', () => {
    const e = createEmitter();
    const fn = vi.fn();
    e.on(['a', 'b'], fn);
    expect(() => e.off('never', fn)).not.toThrow();
    expect(() => e.off('a', () => {})).not.toThrow();
    expect(e.listenerCount()).toBe(2);
    e.off(['a', 'b'], fn);
    expect(e.listenerCount()).toBe(0);
  });

  it('validates its arguments', () => {
    const e = createEmitter();
    expect(() => e.off('')).toThrow(ValidationError);
    expect(() => e.off('x', 'nope')).toThrow(ValidationError);
  });
});

// ── listener exceptions ──────────────────────────────────────────────────────────────────────────

describe('listener exceptions', () => {
  it("are caught and re-emitted as 'error' { error: SdkError, event } without stopping fan-out", () => {
    const e = createEmitter({ now: () => 9 });
    const onError = vi.fn();
    const after = vi.fn();
    e.on('error', onError);
    e.on('search:start', () => {
      throw new TypeError('bad listener');
    });
    e.on('search:start', after);
    expect(() => e.emit('search:start', { sessionId: 's1' })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const payload = onError.mock.calls[0][0];
    expect(payload.type).toBe('error');
    expect(payload.at).toBe(9);
    expect(payload.event).toBe('search:start');
    expect(payload.error).toBeInstanceOf(SdkError);
    expect(payload.error.cause).toBeInstanceOf(TypeError);
    expect(payload.error.message).toBe('bad listener');
  });

  it('pass SdkError instances through unchanged', () => {
    const e = createEmitter();
    const onError = vi.fn();
    const thrown = new TimeoutError('slow', { timeoutMs: 5 });
    e.on('error', onError);
    e.on('x', () => {
      throw thrown;
    });
    e.emit('x');
    expect(onError.mock.calls[0][0].error).toBe(thrown);
  });

  it("thrown by an 'error' listener are logged and dropped (no recursion)", () => {
    const logger = fakeLogger();
    const e = createEmitter({ logger });
    const errorListener = vi.fn(() => {
      throw new Error('error listener boom');
    });
    e.on('error', errorListener);
    e.on('x', () => {
      throw new Error('x boom');
    });
    expect(() => e.emit('x')).not.toThrow();
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, data] = logger.error.mock.calls[0];
    expect(msg).toMatch(/dropped/);
    expect(data.error).toBeInstanceOf(SdkError);
    expect(data.error.message).toBe('error listener boom');
    expect(data.event).toBe('x');
  });

  it("a '*' listener that always throws terminates after one 'error' round", () => {
    const logger = fakeLogger();
    const e = createEmitter({ logger });
    const all = vi.fn(() => {
      throw new Error('always');
    });
    e.on('*', all);
    expect(() => e.emit('x')).not.toThrow();
    // once for 'x', once for the re-emitted 'error'
    expect(all).toHaveBeenCalledTimes(2);
    expect(all.mock.calls[1][0].type).toBe('error');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("are logged when nobody listens to 'error'", () => {
    const logger = fakeLogger();
    const e = createEmitter({ logger });
    e.on('x', () => {
      throw new Error('silent');
    });
    e.emit('x');
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, data] = logger.error.mock.calls[0];
    expect(msg).toMatch(/unhandled error/);
    expect(data.error.message).toBe('silent');
    expect(data.event).toBe('x');
  });

  it('fall back to logger.warn and tolerate a logger without methods or one that throws', () => {
    const warnOnly = { warn: vi.fn() };
    const e = createEmitter({ logger: warnOnly });
    e.on('x', () => {
      throw new Error('w');
    });
    e.emit('x');
    expect(warnOnly.warn).toHaveBeenCalledTimes(1);

    const mute = createEmitter({ logger: {} });
    mute.on('x', () => {
      throw new Error('m');
    });
    expect(() => mute.emit('x')).not.toThrow();

    const broken = createEmitter({
      logger: {
        error: () => {
          throw new Error('logger down');
        },
      },
    });
    broken.on('x', () => {
      throw new Error('b');
    });
    expect(() => broken.emit('x')).not.toThrow();
  });

  it('are silent without a logger', () => {
    const e = createEmitter();
    e.on('error', () => {
      throw new Error('loop?');
    });
    e.on('x', () => {
      throw new Error('x');
    });
    expect(() => e.emit('x')).not.toThrow();
  });
});

// ── waitFor ──────────────────────────────────────────────────────────────────────────────────────

describe('waitFor', () => {
  it('resolves with the next matching payload and releases its listener', async () => {
    const e = createEmitter({ now: () => 3 });
    const p = e.waitFor('booking:confirmed');
    expect(e.listenerCount('booking:confirmed')).toBe(1);
    e.emit('booking:held', { id: 'no' });
    e.emit('booking:confirmed', { id: 'b1' });
    await expect(p).resolves.toEqual({ type: 'booking:confirmed', at: 3, id: 'b1' });
    expect(e.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts wildcards and arrays, settling on the first match', async () => {
    const e = createEmitter();
    const p = e.waitFor(['search:complete', 'search:error']);
    e.emit('search:error', { code: 'X' });
    await expect(p).resolves.toMatchObject({ type: 'search:error', code: 'X' });
    const q = e.waitFor('payment:*');
    e.emit('payment:succeeded');
    await expect(q).resolves.toMatchObject({ type: 'payment:succeeded' });
    expect(e.listenerCount()).toBe(0);
  });

  it('only settles on a payload the filter accepts', async () => {
    const e = createEmitter();
    const filter = vi.fn((p) => p.id === 'b2');
    const p = e.waitFor('booking:statusChanged', { filter });
    e.emit('booking:statusChanged', { id: 'b1' });
    e.emit('booking:statusChanged', { id: 'b2' });
    e.emit('booking:statusChanged', { id: 'b3' });
    await expect(p).resolves.toMatchObject({ id: 'b2' });
    expect(filter).toHaveBeenCalledTimes(2);
    expect(e.listenerCount()).toBe(0);
  });

  it('rejects with the wrapped exception when the filter throws, and cleans up', async () => {
    const e = createEmitter();
    const onError = vi.fn();
    e.on('error', onError);
    const p = e.waitFor('x', {
      timeoutMs: 1000,
      filter: () => {
        throw new RangeError('bad filter');
      },
    });
    e.emit('x');
    const err = await p.catch((caught) => caught);
    expect(err).toBeInstanceOf(SdkError);
    expect(err.cause).toBeInstanceOf(RangeError);
    expect(onError).not.toHaveBeenCalled(); // handled by the wait, not re-emitted
    expect(e.listenerCount()).toBe(1); // only the 'error' listener remains
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with TimeoutError{ timeoutMs } after timeoutMs and releases the listener', async () => {
    const e = createEmitter();
    const p = e.waitFor('x', { timeoutMs: 500 });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'TIMEOUT',
      timeoutMs: 500,
    });
    expect(vi.getTimerCount()).toBe(1);
    await tick(499);
    expect(e.listenerCount('x')).toBe(1);
    await tick(1);
    await assertion;
    expect(e.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const fn = vi.fn();
    e.on('x', fn);
    e.emit('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('names the awaited event in the timeout message', async () => {
    const e = createEmitter();
    const p = e.waitFor(['a', 'b'], { timeoutMs: 10 });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await tick(10);
    await assertion;
    const q = e.waitFor('solo', { timeoutMs: 10 });
    const check = q.catch((err) => err);
    await tick(10);
    expect((await check).message).toContain("waitFor('solo')");
  });

  it('clears the timer when the event arrives first', async () => {
    const e = createEmitter();
    const p = e.waitFor('x', { timeoutMs: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    e.emit('x', { ok: true });
    await expect(p).resolves.toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    await tick(1000); // nothing left to fire
  });

  it('treats timeoutMs: Infinity / undefined / null as "no timeout" and 0 as immediate', async () => {
    const e = createEmitter();
    const forever = [
      e.waitFor('x', { timeoutMs: Infinity }),
      e.waitFor('x', { timeoutMs: undefined }),
      e.waitFor('x', { timeoutMs: null }),
      e.waitFor('x', {}),
      e.waitFor('x'),
    ];
    expect(vi.getTimerCount()).toBe(0);
    expect(e.listenerCount('x')).toBe(5);
    const zero = e.waitFor('x', { timeoutMs: 0 });
    const assertion = expect(zero).rejects.toBeInstanceOf(TimeoutError);
    await tick(0);
    await assertion;
    expect(e.listenerCount('x')).toBe(5); // the five open waits are still subscribed
    e.clear();
    const outcomes = await Promise.allSettled(forever);
    expect(outcomes.every((o) => o.status === 'rejected' && o.reason instanceof AbortError)).toBe(
      true
    );
  });

  it('rejects with AbortError when the signal aborts, releasing listener, timer and abort hook', async () => {
    const e = createEmitter();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const p = e.waitFor('x', { timeoutMs: 1000, signal: controller.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError', reason: 'user' });
    controller.abort('user');
    await assertion;
    expect(e.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects immediately on an already aborted signal without subscribing', async () => {
    const e = createEmitter();
    const controller = new AbortController();
    controller.abort();
    const err = await e.waitFor('x', { signal: controller.signal }).catch((caught) => caught);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.reason).toBe('aborted');
    expect(e.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rethrows an SdkError abort reason as is and keeps other reasons as `cause`', async () => {
    const e = createEmitter();
    const sdk = new AbortController();
    const reason = new TimeoutError('outer', { timeoutMs: 1 });
    sdk.abort(reason);
    await expect(e.waitFor('x', { signal: sdk.signal })).rejects.toBe(reason);

    const other = new AbortController();
    const p = e.waitFor('x', { signal: other.signal });
    const cause = new Error('dom-style');
    other.abort(cause);
    const err = await p.catch((caught) => caught);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.cause).toBe(cause);
    expect(err.reason).toBe('aborted');
  });

  it('removes its abort hook once settled by an event', async () => {
    const e = createEmitter();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const p = e.waitFor('x', { signal: controller.signal });
    e.emit('x');
    await p;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort(); // no effect on the settled promise
    await expect(p).resolves.toMatchObject({ type: 'x' });
  });

  it('is cancelled by clear() with AbortError{ reason: "cleared" } and no timers left', async () => {
    const e = createEmitter();
    const a = e.waitFor('a', { timeoutMs: 5000 });
    const b = e.waitFor('b');
    const assertions = Promise.all([
      expect(a).rejects.toMatchObject({ name: 'AbortError', reason: 'cleared' }),
      expect(b).rejects.toMatchObject({ name: 'AbortError', reason: 'cleared' }),
    ]);
    expect(vi.getTimerCount()).toBe(1);
    e.clear();
    await assertions;
    expect(vi.getTimerCount()).toBe(0);
    expect(e.listenerCount()).toBe(0);
  });

  it('rejects bad arguments with ValidationError (never throws synchronously)', async () => {
    const e = createEmitter();
    await expect(e.waitFor('')).rejects.toBeInstanceOf(ValidationError);
    await expect(e.waitFor('x', 'opts')).rejects.toBeInstanceOf(ValidationError);
    await expect(e.waitFor('x', { timeoutMs: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(e.waitFor('x', { timeoutMs: '5' })).rejects.toBeInstanceOf(ValidationError);
    await expect(e.waitFor('x', { timeoutMs: Number.NaN })).rejects.toBeInstanceOf(ValidationError);
    await expect(e.waitFor('x', { filter: 'yes' })).rejects.toBeInstanceOf(ValidationError);
    await expect(e.waitFor('x', { signal: {} })).rejects.toBeInstanceOf(ValidationError);
    const err = await e.waitFor('x', { timeoutMs: -1 }).catch((caught) => caught);
    expect(err.issues[0].path).toBe('options.timeoutMs');
    expect(e.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── listenerCount / clear ────────────────────────────────────────────────────────────────────────

describe('listenerCount', () => {
  it('counts everything without an argument', () => {
    const e = createEmitter();
    e.on('a', () => {});
    e.on(['b', 'c:*'], () => {});
    e.once('*', () => {});
    expect(e.listenerCount()).toBe(4);
  });

  it('counts every listener a plain name would reach, and exact registrations for a pattern', () => {
    const e = createEmitter();
    e.on('search:start', () => {});
    e.on('search:start', () => {});
    e.on('search:*', () => {});
    e.on('*', () => {});
    e.on('offer:*', () => {});
    expect(e.listenerCount('search:start')).toBe(4);
    expect(e.listenerCount('search:other')).toBe(2);
    expect(e.listenerCount('unknown')).toBe(1);
    expect(e.listenerCount('search:*')).toBe(1);
    expect(e.listenerCount('*')).toBe(1);
    expect(e.listenerCount('offer:*')).toBe(1);
    expect(e.listenerCount('nope:*')).toBe(0);
  });

  it('validates the name', () => {
    const e = createEmitter();
    expect(() => e.listenerCount('')).toThrow(ValidationError);
    expect(() => e.listenerCount('a*b')).toThrow(ValidationError);
  });
});

describe('clear', () => {
  it('drops every listener; earlier off() handles stay harmless', () => {
    const e = createEmitter();
    const fn = vi.fn();
    const off = e.on(['x', 'y:*', '*'], fn);
    e.once('x', fn);
    e.clear();
    expect(e.listenerCount()).toBe(0);
    e.emit('x');
    e.emit('y:z');
    expect(fn).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
    expect(e.listenerCount()).toBe(0);
  });

  it('stops delivery to listeners cleared from inside an emit', () => {
    const e = createEmitter();
    const later = vi.fn();
    e.on('x', () => e.clear());
    e.on('x', later);
    e.emit('x');
    expect(later).not.toHaveBeenCalled();
    expect(e.listenerCount()).toBe(0);
  });

  it('can be reused afterwards', () => {
    const e = createEmitter();
    e.clear();
    const fn = vi.fn();
    e.on('x', fn);
    e.emit('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
