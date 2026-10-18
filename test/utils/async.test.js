import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  debounce,
  throttle,
  singleFlight,
  retry,
  poll,
  withTimeout,
  sleep,
  deferred,
  combineSignals,
  timeoutSignal,
  isAbort,
  createQueue,
  onceAsync,
  memoAsync,
} from '../../src/utils/async.js';
import {
  AbortError,
  TimeoutError,
  ValidationError,
  NetworkError,
  RateLimitError,
} from '../../src/errors/index.js';

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── debounce ─────────────────────────────────────────────────────────────────────────────────────

describe('debounce', () => {
  it('collapses a burst into one trailing call with the last arguments', async () => {
    const fn = vi.fn((x) => x * 2);
    const d = debounce(fn, 100);
    expect(d(1)).toBeUndefined();
    await tick(50);
    d(2);
    await tick(50);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(true);
    await tick(99);
    expect(fn).not.toHaveBeenCalled();
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(3);
    expect(d.pending()).toBe(false);
    expect(d(4)).toBe(6); // last result is remembered
    expect(vi.getTimerCount()).toBe(1);
    d.cancel();
  });

  it('leading: invokes immediately once per quiet window, trailing only when more calls arrived', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true });
    d('a');
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(100);
    expect(fn).toHaveBeenCalledTimes(1); // single call: no trailing invocation
    d('b');
    d('c');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');
    await tick(100);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('leading only (trailing: false) runs once per window and drops the rest', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true, trailing: false });
    d(1);
    d(2);
    await tick(99);
    d(3);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(100);
    expect(fn).toHaveBeenCalledTimes(1);
    d(4);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(4);
    expect(vi.getTimerCount()).toBe(1);
    d.cancel();
  });

  it('maxWait forces an invocation while calls keep arriving', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 50, { maxWait: 100 });
    for (let t = 0; t <= 250; t += 10) {
      d(t);
      await tick(10);
    }
    // Calls at 0..250 (every 10 ms): forced at 100 and 200, trailing at 250 + 50 = 300.
    expect(fn.mock.calls.map((c) => c[0])).toEqual([90, 190]);
    await tick(40);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith(250);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel() drops the pending call and leaves no timers', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { maxWait: 200 });
    d(1);
    expect(vi.getTimerCount()).toBe(2);
    d.cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect(d.pending()).toBe(false);
    await tick(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush() invokes the pending call now and returns its result', async () => {
    const fn = vi.fn((x) => x + 1);
    const d = debounce(fn, 100);
    expect(d.flush()).toBeUndefined();
    d(41);
    expect(d.flush()).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await tick(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preserves `this`', async () => {
    const obj = {
      n: 0,
      bump: debounce(function (by) {
        this.n += by;
      }, 10),
    };
    obj.bump(5);
    await tick(10);
    expect(obj.n).toBe(5);
  });

  it('validates its arguments', () => {
    expect(() => debounce('nope', 10)).toThrow(ValidationError);
    expect(() => debounce(() => {}, -1)).toThrow(ValidationError);
    expect(() => debounce(() => {}, 10, { maxWait: 'x' })).toThrow(ValidationError);
    try {
      debounce(null, 1);
    } catch (e) {
      expect(e.issues).toEqual([{ path: 'fn', code: 'type', message: expect.any(String) }]);
    }
  });
});

// ── throttle ─────────────────────────────────────────────────────────────────────────────────────

describe('throttle', () => {
  it('invokes immediately, then at most once per interval with the latest arguments', async () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    for (let now = 0; now <= 250; now += 10) {
      t(now);
      await tick(10);
    }
    expect(fn.mock.calls.map((c) => c[0])).toEqual([0, 90, 190]);
    await tick(50);
    expect(fn.mock.calls.map((c) => c[0])).toEqual([0, 90, 190, 250]);
    expect(vi.getTimerCount()).toBe(1); // the trailing window stays open until 350
    await tick(50);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a lone call runs once and exposes cancel/flush', async () => {
    const fn = vi.fn(() => 'r');
    const t = throttle(fn, 100);
    expect(t('x')).toBe('r');
    await tick(100);
    expect(fn).toHaveBeenCalledTimes(1);
    t('y');
    expect(fn).toHaveBeenCalledTimes(2);
    t('z');
    expect(t.pending()).toBe(true);
    t.cancel();
    expect(t.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await tick(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(() => throttle(1, 1)).toThrow(ValidationError);
  });
});

// ── singleFlight ─────────────────────────────────────────────────────────────────────────────────

describe('singleFlight', () => {
  it('shares one in-flight promise per key and releases it on settle', async () => {
    const gates = {};
    const fn = vi.fn((id) => new Promise((resolve) => (gates[id] = resolve)));
    const load = singleFlight((id) => id, fn);
    const a1 = load('a');
    const a2 = load('a');
    const b = load('b');
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(fn).toHaveBeenCalledTimes(2);
    gates.a('A');
    await expect(a1).resolves.toBe('A');
    const a3 = load('a');
    expect(a3).not.toBe(a1);
    expect(fn).toHaveBeenCalledTimes(3);
    gates.a('A2');
    gates.b('B');
    await expect(a3).resolves.toBe('A2');
    await expect(b).resolves.toBe('B');
  });

  it('shares rejections, then allows a fresh call; sync throws become rejections', async () => {
    let calls = 0;
    const fn = () => {
      calls += 1;
      if (calls === 1) throw new Error('sync boom');
      return Promise.resolve('ok');
    };
    const go = singleFlight(null, fn);
    const first = go();
    expect(go()).toBe(first);
    await expect(first).rejects.toThrow('sync boom');
    await expect(go()).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('a null keyFn shares a single key regardless of arguments', () => {
    const fn = vi.fn(() => new Promise(() => {}));
    const go = singleFlight(null, fn);
    expect(go(1)).toBe(go(2));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() => singleFlight(null, 'x')).toThrow(ValidationError);
    expect(() => singleFlight('x', fn)).toThrow(ValidationError);
  });

  it('a throwing keyFn rejects instead of throwing synchronously', async () => {
    const boom = new Error('bad key');
    const fn = vi.fn(async () => 'never');
    const go = singleFlight(() => {
      throw boom;
    }, fn);
    const p = go('x');
    await expect(p).rejects.toBe(boom);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── retry ────────────────────────────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('resolves on the first success without starting timers', async () => {
    const fn = vi.fn(async (attempt, { signal }) => ({ attempt, signal }));
    await expect(retry(fn)).resolves.toEqual({ attempt: 1, signal: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off exponentially (base · factor^(n-1), capped at maxMs) with jitter off', async () => {
    const fn = vi.fn(async (attempt) => {
      if (attempt < 5) throw new Error(`fail ${attempt}`);
      return 'done';
    });
    const onRetry = vi.fn();
    const p = retry(fn, { retries: 4, baseMs: 100, factor: 2, maxMs: 300, jitter: false, onRetry });
    await tick(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(1); // 100
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(1); // 300
    expect(fn).toHaveBeenCalledTimes(3);
    await tick(300); // capped at 300 (would be 400)
    expect(fn).toHaveBeenCalledTimes(4);
    await tick(300); // capped again (would be 800)
    expect(fn).toHaveBeenCalledTimes(5);
    await expect(p).resolves.toBe('done');
    expect(
      onRetry.mock.calls.map(([err, attempt, delay]) => [err.message, attempt, delay])
    ).toEqual([
      ['fail 1', 1, 100],
      ['fail 2', 2, 200],
      ['fail 3', 3, 300],
      ['fail 4', 4, 300],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the last error once retries are exhausted (retries + 1 attempts)', async () => {
    const fn = vi.fn(async (attempt) => {
      throw new Error(`fail ${attempt}`);
    });
    const p = retry(fn, { retries: 2, baseMs: 10, jitter: false });
    const assertion = expect(p).rejects.toThrow('fail 3');
    await tick(1000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    const once = vi.fn(async () => {
      throw new Error('only');
    });
    await expect(retry(once, { retries: 0 })).rejects.toThrow('only');
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('applies full, equal and custom jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const failing = (n) =>
      vi.fn(async (attempt) => {
        if (attempt <= n) throw new Error('x');
        return attempt;
      });
    const delays = [];
    const onRetry = (_e, _a, d) => delays.push(d);
    const base = { retries: 1, baseMs: 100, onRetry };
    const run = async (opts) => {
      const p = retry(failing(1), { ...base, ...opts });
      await tick(1000);
      await p;
    };
    await run({}); // default = full jitter
    await run({ jitter: 'full' });
    await run({ jitter: 'equal' });
    await run({ jitter: (delay, attempt) => delay + attempt });
    await run({ jitter: 'none' });
    expect(delays).toEqual([50, 50, 75, 101, 100]);
  });

  it('retryOn(err, attempt) decides, and may be async', async () => {
    const fn = vi.fn(async (attempt) => {
      throw new Error(`fail ${attempt}`);
    });
    const retryOn = vi.fn(async (err, attempt) => attempt < 2);
    const p = retry(fn, { retries: 5, baseMs: 10, jitter: false, retryOn });
    const assertion = expect(p).rejects.toThrow('fail 2');
    await tick(100);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
    expect(retryOn).toHaveBeenCalledTimes(2);
    expect(retryOn.mock.calls[0][0].message).toBe('fail 1');
    expect(retryOn.mock.calls[0][1]).toBe(1);
  });

  it('by default skips non-retryable SdkErrors and aborts, retries everything else', async () => {
    const attempts = async (error) => {
      const fn = vi.fn(async () => {
        throw error;
      });
      const p = retry(fn, { retries: 1, baseMs: 10, jitter: false });
      const assertion = expect(p).rejects.toBe(error);
      await tick(100);
      await assertion;
      return fn.mock.calls.length;
    };
    expect(await attempts(new ValidationError('bad'))).toBe(1);
    expect(await attempts(new AbortError('stop'))).toBe(1);
    expect(await attempts(new NetworkError('net'))).toBe(2);
    expect(await attempts(new Error('plain'))).toBe(2);
    expect(await attempts(new TypeError('plain'))).toBe(2);
  });

  it('waits exactly retryAfterMs (capped at maxMs, no jitter) when the error carries it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const delays = [];
    const fn = vi.fn(async (attempt) => {
      if (attempt === 1) throw new RateLimitError('slow down', { retryAfterMs: 2500 });
      if (attempt === 2) throw new RateLimitError('slow down', { retryAfterMs: 99999 });
      return 'ok';
    });
    const p = retry(fn, {
      retries: 3,
      baseMs: 10,
      maxMs: 5000,
      onRetry: (_e, _a, d) => delays.push(d),
    });
    await tick(2499);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(5000);
    expect(fn).toHaveBeenCalledTimes(3);
    await expect(p).resolves.toBe('ok');
    expect(delays).toEqual([2500, 5000]);
  });

  it('rejects with AbortError when the signal is already aborted, without calling fn', async () => {
    const fn = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const err = await retry(fn, { signal: controller.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.reason).toBe('aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborting during the back-off wait rejects with AbortError and clears the timer', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fail');
    });
    const controller = new AbortController();
    const p = retry(fn, { retries: 3, baseMs: 1000, jitter: false, signal: controller.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError', reason: 'destroyed' });
    await tick(10);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort('destroyed');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a failure after abort surfaces as AbortError; a success after abort is kept', async () => {
    const controller = new AbortController();
    const fail = vi.fn(async () => {
      controller.abort();
      throw new Error('late');
    });
    await expect(retry(fail, { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
    expect(fail).toHaveBeenCalledTimes(1);
    const c2 = new AbortController();
    const ok = async () => {
      c2.abort();
      return 'value';
    };
    await expect(retry(ok, { signal: c2.signal })).resolves.toBe('value');
  });

  it('rejects with ValidationError for bad arguments', async () => {
    await expect(retry('nope')).rejects.toBeInstanceOf(ValidationError);
    await expect(retry(async () => 1, { factor: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(retry(async () => 1, { retries: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(retry(async () => 1, { retryOn: 1 })).rejects.toBeInstanceOf(ValidationError);
    for (const jitter of ['bogus', 42, {}]) {
      const err = await retry(async () => 1, { jitter }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.issues[0]).toMatchObject({ path: 'jitter', code: 'type' });
    }
    const fn = vi.fn(async () => 1);
    const err = await retry(fn, { signal: 'abort' }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues[0]).toMatchObject({ path: 'signal', code: 'type' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('clamps every delay to 2^31 − 1 ms so a huge Retry-After or back-off never fires at once', async () => {
    const MAX = 2 ** 31 - 1;
    const delays = [];
    const fn = vi.fn(async (attempt) => {
      if (attempt === 1) throw new RateLimitError('slow down', { retryAfterMs: 1e12 });
      if (attempt === 2) throw new Error('again');
      return 'ok';
    });
    const p = retry(fn, {
      retries: 2,
      baseMs: 1e9,
      factor: 1e9, // attempt 2 would wait 1e18 ms
      maxMs: Infinity,
      jitter: false,
      onRetry: (_e, _a, d) => delays.push(d),
    });
    await tick(1000);
    expect(fn).toHaveBeenCalledTimes(1); // the 1e12 ms wait did not collapse to ~1 ms
    await tick(MAX - 1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(MAX);
    expect(fn).toHaveBeenCalledTimes(3);
    await expect(p).resolves.toBe('ok');
    expect(delays).toEqual([MAX, MAX]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── poll ─────────────────────────────────────────────────────────────────────────────────────────

describe('poll', () => {
  const statusAfter = (n) =>
    vi.fn(async (attempt) => ({ status: attempt >= n ? 'complete' : 'pending', attempt }));
  const complete = (r) => r.status === 'complete';

  it('calls fn every intervalMs until `until` is satisfied and resolves with that result', async () => {
    const fn = statusAfter(3);
    const onTick = vi.fn();
    const p = poll(fn, { intervalMs: 500, until: complete, onTick });
    expect(typeof p.cancel).toBe('function');
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(500);
    expect(fn).toHaveBeenCalledTimes(3);
    await expect(p).resolves.toEqual({ status: 'complete', attempt: 3 });
    expect(fn.mock.calls[0][0]).toBe(1);
    expect(fn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(onTick).toHaveBeenCalledTimes(3);
    expect(onTick.mock.calls[0]).toEqual([
      { status: 'pending', attempt: 1 },
      { attempt: 1, elapsedMs: 0, nextDelayMs: 500 },
    ]);
    expect(onTick.mock.calls[2][1]).toEqual({ attempt: 3, elapsedMs: 1000, nextDelayMs: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours { retryAfterMs } returned by fn instead of the interval (capped by maxIntervalMs)', async () => {
    const results = [
      { status: 'pending', retryAfterMs: 2000 },
      { status: 'pending', retryAfterMs: 60000 },
      { status: 'pending', retryAfterMs: 'soon' },
      { status: 'complete' },
    ];
    const fn = vi.fn(async (attempt) => results[attempt - 1]);
    const delays = [];
    const p = poll(fn, {
      intervalMs: 100,
      maxIntervalMs: 5000,
      until: complete,
      onTick: (_r, info) => delays.push(info.nextDelayMs),
    });
    await tick(1999);
    expect(fn).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(5000);
    expect(fn).toHaveBeenCalledTimes(3);
    await tick(100);
    expect(fn).toHaveBeenCalledTimes(4);
    await expect(p).resolves.toEqual({ status: 'complete' });
    expect(delays).toEqual([2000, 5000, 100, null]);
  });

  it('grows the interval exponentially with backoff, capped by maxIntervalMs', async () => {
    const fn = statusAfter(5);
    const delays = [];
    const p = poll(fn, {
      intervalMs: 100,
      backoff: true,
      maxIntervalMs: 350,
      until: complete,
      onTick: (_r, info) => delays.push(info.nextDelayMs),
    });
    await tick(100 + 200 + 350 + 350);
    await expect(p).resolves.toMatchObject({ attempt: 5 });
    expect(delays).toEqual([100, 200, 350, 350, null]);

    const custom = [];
    const p2 = poll(statusAfter(3), {
      intervalMs: 100,
      backoff: 3,
      until: complete,
      onTick: (_r, info) => custom.push(info.nextDelayMs),
    });
    await tick(400);
    await p2;
    expect(custom).toEqual([100, 300, null]);

    const plain = [];
    const p3 = poll(statusAfter(2), {
      intervalMs: 100,
      backoff: null, // same as omitting it
      until: complete,
      onTick: (_r, info) => plain.push(info.nextDelayMs),
    });
    await tick(100);
    await p3;
    expect(plain).toEqual([100, null]);
  });

  it('rejects with TimeoutError{POLL_EXHAUSTED} after maxAttempts (onTick sees no next delay)', async () => {
    const fn = statusAfter(Infinity);
    const delays = [];
    const p = poll(fn, {
      intervalMs: 100,
      until: complete,
      maxAttempts: 3,
      onTick: (_r, info) => delays.push(info.nextDelayMs),
    });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'POLL_EXHAUSTED',
      details: { attempts: 3, last: { status: 'pending', attempt: 3 } },
    });
    await tick(1000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls[2][1].signal.aborted).toBe(true);
    expect(delays).toEqual([100, 100, null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with TimeoutError after maxMs even while fn is still in flight', async () => {
    let inner;
    const fn = vi.fn((attempt, { signal }) => {
      inner = signal;
      return new Promise(() => {});
    });
    const p = poll(fn, { intervalMs: 100, until: complete, maxMs: 3000 });
    const assertion = expect(p).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'TIMEOUT',
      timeoutMs: 3000,
    });
    await tick(2999);
    expect(inner.aborted).toBe(false);
    await tick(1);
    await assertion;
    expect(inner.aborted).toBe(true);
    expect(inner.reason).toBeInstanceOf(TimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maxMs also interrupts a pending wait', async () => {
    const fn = statusAfter(Infinity);
    const p = poll(fn, { intervalMs: 10000, until: complete, maxMs: 2500 });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await tick(2500);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel() rejects with AbortError, aborts the inner signal and clears timers', async () => {
    const fn = statusAfter(Infinity);
    const p = poll(fn, { intervalMs: 1000, until: complete, maxMs: 60000 });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError', reason: 'cancelled' });
    await tick(1500);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);
    p.cancel();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(fn.mock.calls[1][1].signal.aborted).toBe(true);
    await tick(5000);
    expect(fn).toHaveBeenCalledTimes(2);
    p.cancel(); // idempotent
  });

  it('cancel() with a custom reason, and cancelling while fn is in flight drops its result', async () => {
    let release;
    const fn = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const onTick = vi.fn();
    const p = poll(fn, { intervalMs: 10, until: () => true, onTick });
    const assertion = expect(p).rejects.toMatchObject({ reason: 'destroyed' });
    p.cancel('destroyed');
    release({ status: 'complete' });
    await assertion;
    await tick(100);
    expect(onTick).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() after resolution is a no-op', async () => {
    const p = poll(statusAfter(1), { intervalMs: 10, until: complete });
    await expect(p).resolves.toMatchObject({ status: 'complete' });
    expect(() => p.cancel()).not.toThrow();
  });

  it('an external signal aborts the poll; an already-aborted one never calls fn', async () => {
    const controller = new AbortController();
    const fn = statusAfter(Infinity);
    const p = poll(fn, { intervalMs: 100, until: complete, signal: controller.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError', reason: 'teardown' });
    await tick(150);
    controller.abort('teardown');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(fn.mock.calls[1][1].signal.aborted).toBe(true);

    const done = new AbortController();
    done.abort();
    const fn2 = vi.fn();
    await expect(poll(fn2, { until: complete, signal: done.signal })).rejects.toBeInstanceOf(
      AbortError
    );
    expect(fn2).not.toHaveBeenCalled();
  });

  it('propagates errors thrown by fn, until and onTick immediately', async () => {
    const boom = new Error('boom');
    await expect(
      poll(
        async () => {
          throw boom;
        },
        { intervalMs: 10, until: complete }
      )
    ).rejects.toBe(boom);
    await expect(
      poll(statusAfter(1), {
        intervalMs: 10,
        until: () => {
          throw boom;
        },
      })
    ).rejects.toBe(boom);
    await expect(
      poll(statusAfter(1), {
        intervalMs: 10,
        until: complete,
        onTick: () => {
          throw boom;
        },
      })
    ).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with ValidationError for bad options and still exposes cancel()', async () => {
    const p = poll(statusAfter(1), { intervalMs: 10 });
    expect(typeof p.cancel).toBe('function');
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues[0]).toMatchObject({ path: 'until', code: 'type' });
    await expect(poll('nope', { until: complete })).rejects.toBeInstanceOf(ValidationError);
    await expect(poll(statusAfter(1), { until: complete, intervalMs: -5 })).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(poll(statusAfter(1), { until: complete, backoff: 0.5 })).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(
      poll(statusAfter(1), { until: complete, maxAttempts: 1.5 })
    ).rejects.toBeInstanceOf(ValidationError);
    const fn = statusAfter(1);
    const bad = await poll(fn, { until: complete, signal: 'x' }).catch((e) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    expect(bad.issues[0]).toMatchObject({ path: 'signal', code: 'type' });
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clamps a huge retryAfterMs / interval to 2^31 − 1 ms instead of polling at once', async () => {
    const MAX = 2 ** 31 - 1;
    const results = [
      { status: 'pending', retryAfterMs: 1e12 },
      { status: 'pending' },
      { status: 'complete' },
    ];
    const fn = vi.fn(async (attempt) => results[attempt - 1]);
    const delays = [];
    const p = poll(fn, {
      intervalMs: 1e10,
      until: complete,
      onTick: (_r, info) => delays.push(info.nextDelayMs),
    });
    await tick(1000);
    expect(fn).toHaveBeenCalledTimes(1); // the 1e12 ms wait did not collapse to ~1 ms
    await tick(MAX - 1000);
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(MAX);
    await expect(p).resolves.toEqual({ status: 'complete' });
    expect(delays).toEqual([MAX, MAX, null]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── withTimeout ──────────────────────────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('passes through a settlement that arrives in time and clears the timer', async () => {
    const d = deferred();
    const p = withTimeout(d.promise, 1000);
    expect(vi.getTimerCount()).toBe(1);
    d.resolve('v');
    await expect(p).resolves.toBe('v');
    expect(vi.getTimerCount()).toBe(0);
    await expect(withTimeout(Promise.reject(new Error('inner')), 1000)).rejects.toThrow('inner');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with TimeoutError{ timeoutMs } once ms elapse', async () => {
    const p = withTimeout(new Promise(() => {}), 250);
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError', timeoutMs: 250 });
    await tick(249);
    await tick(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with AbortError on signal abort (and immediately when already aborted)', async () => {
    const controller = new AbortController();
    const p = withTimeout(new Promise(() => {}), 1000, controller.signal);
    const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError', reason: 'bye' });
    controller.abort('bye');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    const pre = new AbortController();
    pre.abort();
    await expect(withTimeout(Promise.resolve(1), 10, pre.signal)).rejects.toBeInstanceOf(
      AbortError
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a thunk and aborts the signal it receives on timeout', async () => {
    let seen;
    const p = withTimeout((signal) => {
      seen = signal;
      return new Promise(() => {});
    }, 100);
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    expect(seen.aborted).toBe(false);
    await tick(100);
    await assertion;
    expect(seen.aborted).toBe(true);
    expect(seen.reason).toBeInstanceOf(TimeoutError);
    await expect(
      withTimeout(() => {
        throw new Error('sync');
      }, 100)
    ).rejects.toThrow('sync');
    await expect(withTimeout(() => 'plain', 100)).resolves.toBe('plain');
  });

  it('Infinity disables the timer; invalid ms rejects with ValidationError', async () => {
    const d = deferred();
    const p = withTimeout(d.promise, Infinity);
    expect(vi.getTimerCount()).toBe(0);
    d.resolve(1);
    await expect(p).resolves.toBe(1);
    await expect(withTimeout(Promise.resolve(1), -1)).rejects.toBeInstanceOf(ValidationError);
    await expect(withTimeout(Promise.reject(new Error('x')), NaN)).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it('an already-aborted or invalid signal rejects at once and still consumes the input', async () => {
    const pre = new AbortController();
    pre.abort('gone');
    const late = deferred();
    await expect(withTimeout(late.promise, 10, pre.signal)).rejects.toMatchObject({
      name: 'AbortError',
      reason: 'gone',
    });
    late.reject(new Error('nobody listens')); // must not surface as an unhandled rejection
    const thunk = vi.fn();
    await expect(withTimeout(thunk, 10, pre.signal)).rejects.toBeInstanceOf(AbortError);
    expect(thunk).not.toHaveBeenCalled();
    const invalid = deferred();
    const err = await withTimeout(invalid.promise, 10, 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues[0]).toMatchObject({ path: 'signal', code: 'type' });
    invalid.reject(new Error('also swallowed'));
    await tick(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clamps ms above 2^31 − 1 so the timeout does not fire at once', async () => {
    const MAX = 2 ** 31 - 1;
    const p = withTimeout(new Promise(() => {}), 1e12);
    let settled = false;
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError', timeoutMs: 1e12 });
    p.catch(() => {
      settled = true;
    });
    await tick(1000);
    expect(settled).toBe(false);
    await tick(MAX - 1000);
    await assertion;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── sleep ────────────────────────────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after ms', async () => {
    const done = vi.fn();
    sleep(100).then(done);
    await tick(99);
    expect(done).not.toHaveBeenCalled();
    await tick(1);
    expect(done).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects immediately with AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toBeInstanceOf(AbortError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on abort during the wait and clears the timer', async () => {
    const controller = new AbortController();
    const p = sleep(1000, controller.signal);
    const assertion = expect(p).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORTED',
      reason: 'navigated',
    });
    await tick(10);
    controller.abort('navigated');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a DOMException as cause and propagates an SdkError reason as is', async () => {
    const controller = new AbortController();
    const p = sleep(1000, controller.signal);
    const assertion = p.catch((e) => e);
    controller.abort();
    const err = await assertion;
    expect(err).toBeInstanceOf(AbortError);
    expect(err.reason).toBe('aborted');
    expect(err.cause?.name).toBe('AbortError');

    const custom = new AbortError('custom', { reason: 'destroyed' });
    const c2 = new AbortController();
    const p2 = sleep(1000, c2.signal);
    const a2 = expect(p2).rejects.toBe(custom);
    c2.abort(custom);
    await a2;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Infinity waits for the signal alone; invalid ms rejects with ValidationError', async () => {
    const controller = new AbortController();
    const p = sleep(Infinity, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    const assertion = expect(p).rejects.toBeInstanceOf(AbortError);
    controller.abort();
    await assertion;
    await expect(sleep(-1)).rejects.toBeInstanceOf(ValidationError);
    await expect(sleep('soon')).rejects.toBeInstanceOf(ValidationError);
    const err = await sleep(10, 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues[0]).toMatchObject({ path: 'signal', code: 'type' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clamps ms above 2^31 − 1 instead of resolving after ~1 ms', async () => {
    const MAX = 2 ** 31 - 1;
    const done = vi.fn();
    sleep(2 ** 31).then(done);
    await tick(1000);
    expect(done).not.toHaveBeenCalled();
    await tick(MAX - 1000);
    expect(done).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── deferred ─────────────────────────────────────────────────────────────────────────────────────

describe('deferred', () => {
  it('exposes resolve / reject with status flags', async () => {
    const d = deferred();
    expect(d.status).toBe('pending');
    expect(d.settled).toBe(false);
    d.resolve(7);
    d.reject(new Error('ignored'));
    expect(d.status).toBe('resolved');
    expect(d.settled).toBe(true);
    await expect(d.promise).resolves.toBe(7);
    const r = deferred();
    r.reject(new Error('no'));
    expect(r.status).toBe('rejected');
    await expect(r.promise).rejects.toThrow('no');
  });
});

// ── combineSignals ───────────────────────────────────────────────────────────────────────────────

describe('combineSignals', () => {
  it('returns a never-aborting signal for no inputs and the input itself for one', () => {
    const none = combineSignals();
    expect(none).toBeInstanceOf(AbortSignal);
    expect(none.aborted).toBe(false);
    const only = new AbortController().signal;
    expect(combineSignals(null, only, undefined)).toBe(only);
  });

  it('works with already-aborted inputs, keeping the reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    b.abort('b-reason');
    const combined = combineSignals(a.signal, b.signal);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('b-reason');
    const err = new TimeoutError('t', { timeoutMs: 5 });
    const c = new AbortController();
    c.abort(err);
    expect(combineSignals(c.signal, a.signal).reason).toBe(err);
  });

  it('aborts when any input aborts, with that input reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineSignals(a.signal, null, b.signal);
    expect(combined.aborted).toBe(false);
    const onAbort = vi.fn();
    combined.addEventListener('abort', onAbort);
    b.abort('b');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('b');
    expect(onAbort).toHaveBeenCalledTimes(1);
    a.abort('a');
    expect(combined.reason).toBe('b');
  });

  it('falls back to one-shot listeners without AbortSignal.any and removes them on abort', () => {
    const original = AbortSignal.any;
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    try {
      const a = new AbortController();
      const b = new AbortController();
      const removeA = vi.spyOn(a.signal, 'removeEventListener');
      const removeB = vi.spyOn(b.signal, 'removeEventListener');
      const combined = combineSignals(a.signal, b.signal);
      expect(combined.aborted).toBe(false);
      a.abort('first');
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe('first');
      expect(removeA).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(removeB).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(() => b.abort('second')).not.toThrow();
      expect(combined.reason).toBe('first');
    } finally {
      Object.defineProperty(AbortSignal, 'any', { value: original, configurable: true });
    }
  });

  it('accepts signal-like objects from another realm through the listener fallback', () => {
    class ForeignSignal extends EventTarget {
      aborted = false;
      reason = undefined;
      abort(reason) {
        this.aborted = true;
        this.reason = reason;
        this.dispatchEvent(new Event('abort'));
      }
    }
    const foreign = new ForeignSignal();
    const real = new AbortController();
    const combined = combineSignals(real.signal, foreign);
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined.aborted).toBe(false);
    foreign.abort('foreign');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('foreign');
  });

  it('rejects non-signal inputs with ValidationError', () => {
    expect(() => combineSignals({})).toThrow(ValidationError);
    expect(() => combineSignals({ aborted: false })).toThrow(ValidationError);
    expect(() => combineSignals('abort')).toThrow(ValidationError);
  });
});

// ── timeoutSignal ────────────────────────────────────────────────────────────────────────────────

describe('timeoutSignal', () => {
  it('aborts after ms with a TimeoutError reason that consumers surface', async () => {
    const signal = timeoutSignal(300);
    expect(signal.aborted).toBe(false);
    const p = sleep(10000, signal);
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError', timeoutMs: 300 });
    await tick(299);
    expect(signal.aborted).toBe(false);
    await tick(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(TimeoutError);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('composes with combineSignals and validates ms', async () => {
    const user = new AbortController();
    const combined = combineSignals(user.signal, timeoutSignal(50));
    await tick(50);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBeInstanceOf(TimeoutError);
    expect(() => timeoutSignal(-1)).toThrow(ValidationError);
    expect(() => timeoutSignal()).toThrow(ValidationError);
    expect(() => timeoutSignal('soon')).toThrow(ValidationError);
    const never = timeoutSignal(Infinity);
    expect(never).toBeInstanceOf(AbortSignal);
    expect(never.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── isAbort ──────────────────────────────────────────────────────────────────────────────────────

describe('isAbort', () => {
  it('recognises SDK, DOM and code-based aborts only', () => {
    expect(isAbort(new AbortError('x'))).toBe(true);
    expect(isAbort(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbort({ code: 'ABORTED' })).toBe(true);
    expect(isAbort({ code: 20 })).toBe(false); // a bare numeric code is not an abort
    expect(isAbort(new TimeoutError('t'))).toBe(false);
    expect(isAbort(new Error('AbortError'))).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort(undefined)).toBe(false);
    expect(isAbort('AbortError')).toBe(false);
  });
});

// ── createQueue ──────────────────────────────────────────────────────────────────────────────────

describe('createQueue', () => {
  const gated = () => {
    const gates = [];
    const task = (value) => () =>
      new Promise((resolve, reject) => gates.push({ resolve: () => resolve(value), reject }));
    return { gates, task };
  };

  it('runs serially by default, tracking size / pending and onIdle', async () => {
    const q = createQueue();
    const { gates, task } = gated();
    const idleBefore = vi.fn();
    q.onIdle().then(idleBefore);
    await tick(0);
    expect(idleBefore).toHaveBeenCalled(); // already idle
    const p1 = q.add(task('a'));
    const p2 = q.add(task('b'));
    const p3 = q.add(task('c'));
    const idle = vi.fn();
    q.onIdle().then(idle);
    expect(gates.length).toBe(1);
    expect(q.pending).toBe(1);
    expect(q.size).toBe(2);
    gates[0].resolve();
    await expect(p1).resolves.toBe('a');
    expect(gates.length).toBe(2);
    expect(q.size).toBe(1);
    gates[1].resolve();
    await expect(p2).resolves.toBe('b');
    gates[2].resolve();
    await expect(p3).resolves.toBe('c');
    await tick(0);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(0);
    expect(q.pending).toBe(0);
  });

  it('respects concurrency and keeps going after a rejection or a sync throw', async () => {
    const q = createQueue({ concurrency: 2 });
    const { gates, task } = gated();
    const p1 = q.add(task(1));
    const p2 = q.add(task(2));
    const p3 = q.add(task(3));
    const p4 = q.add(() => {
      throw new Error('sync');
    });
    expect(gates.length).toBe(2);
    expect(q.pending).toBe(2);
    expect(q.size).toBe(2);
    gates[1].reject(new Error('two'));
    await expect(p2).rejects.toThrow('two');
    expect(gates.length).toBe(3);
    gates[2].resolve();
    await expect(p3).resolves.toBe(3);
    await expect(p4).rejects.toThrow('sync');
    gates[0].resolve();
    await expect(p1).resolves.toBe(1);
    await q.onIdle();
    expect(q.pending).toBe(0);
  });

  it('a signal aborted while waiting rejects without running; already aborted never queues', async () => {
    const q = createQueue();
    const { gates, task } = gated();
    const first = q.add(task('run'));
    const controller = new AbortController();
    const fn = vi.fn(task('never'));
    const waiting = q.add(fn, { signal: controller.signal });
    const assertion = expect(waiting).rejects.toBeInstanceOf(AbortError);
    expect(q.size).toBe(1);
    controller.abort();
    await assertion;
    expect(q.size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
    const pre = new AbortController();
    pre.abort();
    await expect(q.add(fn, { signal: pre.signal })).rejects.toBeInstanceOf(AbortError);
    gates[0].resolve();
    await expect(first).resolves.toBe('run');
    const running = new AbortController();
    const p = q.add(({ signal }) => Promise.resolve(signal === running.signal), {
      signal: running.signal,
    });
    running.abort(); // already started: outcome is the task's own
    await expect(p).resolves.toBe(true);
  });

  it('clear() rejects every waiting task and lets onIdle resolve', async () => {
    const q = createQueue();
    const { gates, task } = gated();
    const running = q.add(task('r'));
    const w1 = q.add(task('w1'));
    const w2 = q.add(task('w2'));
    const a1 = expect(w1).rejects.toMatchObject({ name: 'AbortError', reason: 'cleared' });
    const a2 = expect(w2).rejects.toMatchObject({ name: 'AbortError', reason: 'cleared' });
    q.clear();
    await a1;
    await a2;
    expect(q.size).toBe(0);
    expect(q.pending).toBe(1);
    gates[0].resolve();
    await expect(running).resolves.toBe('r');
    await q.onIdle();
    expect(gates.length).toBe(1);
  });

  it('validates concurrency and task functions', async () => {
    expect(() => createQueue({ concurrency: 0 })).toThrow(ValidationError);
    expect(() => createQueue({ concurrency: 1.5 })).toThrow(ValidationError);
    expect(() => createQueue({ concurrency: Infinity })).not.toThrow();
    await expect(createQueue().add('nope')).rejects.toBeInstanceOf(ValidationError);
    const q = createQueue();
    const fn = vi.fn(() => 1);
    const err = await q.add(fn, { signal: 'nope' }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues[0]).toMatchObject({ path: 'signal', code: 'type' });
    expect(fn).not.toHaveBeenCalled();
    expect(q.size).toBe(0);
  });
});

// ── onceAsync ────────────────────────────────────────────────────────────────────────────────────

describe('onceAsync', () => {
  it('invokes once and shares the promise; a rejection frees the slot; reset() forgets', async () => {
    let calls = 0;
    const init = onceAsync(async (x) => {
      calls += 1;
      if (calls === 1) throw new Error('first fails');
      return `${x}:${calls}`;
    });
    const p1 = init('a');
    expect(init('b')).toBe(p1);
    await expect(p1).rejects.toThrow('first fails');
    const p2 = init('c');
    expect(p2).not.toBe(p1);
    await expect(p2).resolves.toBe('c:2');
    expect(init('d')).toBe(p2);
    init.reset();
    await expect(init('e')).resolves.toBe('e:3');
    expect(calls).toBe(3);
    expect(() => onceAsync(42)).toThrow(ValidationError);
  });
});

// ── memoAsync ────────────────────────────────────────────────────────────────────────────────────

describe('memoAsync', () => {
  it('caches per arguments, shares in-flight calls and expires after ttlMs', async () => {
    vi.setSystemTime(0);
    const fn = vi.fn(async (id) => `${id}@${Date.now()}`);
    const get = memoAsync(fn, { ttlMs: 1000 });
    const a = get('a');
    expect(get('a')).toBe(a);
    await expect(a).resolves.toBe('a@0');
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(get('b')).resolves.toBe('b@0');
    expect(fn).toHaveBeenCalledTimes(2);
    await tick(999);
    expect(get('a')).toBe(a);
    expect(get.has('a')).toBe(true);
    await tick(1);
    expect(get.has('a')).toBe(false);
    await expect(get('a')).resolves.toBe('a@1000');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never caches rejections and supports keyFn, delete and clear', async () => {
    let fail = true;
    const fn = vi.fn(async (q) => {
      if (fail) throw new Error('nope');
      return q.term.toUpperCase();
    });
    const search = memoAsync(fn, { keyFn: (q) => q.term });
    await expect(search({ term: 'del' })).rejects.toThrow('nope');
    expect(search.has('del')).toBe(false);
    fail = false;
    await expect(search({ term: 'del' })).resolves.toBe('DEL');
    await expect(search({ term: 'del', page: 2 })).resolves.toBe('DEL'); // same key
    expect(fn).toHaveBeenCalledTimes(2);
    expect(search.delete('del')).toBe(true);
    await search({ term: 'del' });
    expect(fn).toHaveBeenCalledTimes(3);
    search.clear();
    await search({ term: 'del' });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('default key tells no-arg, primitive and object arguments apart (1 ≠ "1")', async () => {
    const fn = vi.fn(async (...args) => args.length);
    const m = memoAsync(fn);
    await m();
    await m();
    expect(fn).toHaveBeenCalledTimes(1);
    await m(1);
    await m('1');
    await m(1);
    await m('1');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.slice(1)).toEqual([[1], ['1']]);
    expect(m.has(1)).toBe(true);
    expect(m.has('1')).toBe(true);
    await m(null);
    expect(fn).toHaveBeenCalledTimes(4);
    await m({ a: 1 });
    await m({ a: 1 });
    await m({ a: 2 });
    await m({ a: 1 }, 'page');
    await m(1, '1');
    await m('1', 1);
    await m(1, '1');
    expect(fn).toHaveBeenCalledTimes(9);
    expect(() => memoAsync('x')).toThrow(ValidationError);
    expect(() => memoAsync(fn, { ttlMs: -1 })).toThrow(ValidationError);
    expect(() => memoAsync(fn, { keyFn: 'x' })).toThrow(ValidationError);
  });

  it('a throwing keyFn rejects instead of throwing synchronously', async () => {
    const boom = new Error('bad key');
    const fn = vi.fn(async () => 1);
    const m = memoAsync(fn, {
      keyFn: () => {
        throw boom;
      },
    });
    const p = m('x');
    await expect(p).rejects.toBe(boom);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sweeps expired entries on the next miss so stale keys do not pile up', async () => {
    vi.setSystemTime(0);
    const m = memoAsync(async (k) => k, { ttlMs: 100 });
    await m('a');
    await tick(101);
    expect(m.has('a')).toBe(false);
    await m('b'); // a miss: every expired entry is dropped
    expect(m.delete('a')).toBe(false);
    expect(m.delete('b')).toBe(true);
  });
});
