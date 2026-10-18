import { describe, it, expect, vi, afterEach } from 'vitest';
import { uuid, shortId, requestId, idempotencyKey, isUuid } from '../../src/utils/id.js';
import { hash, stableStringify } from '../../src/utils/object.js';
import { ValidationError } from '../../src/errors/index.js';

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Deterministic `getRandomValues` stand-in that fills with a repeating byte sequence. */
function fakeGetRandomValues(bytes) {
  return vi.fn((arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = bytes[i % bytes.length];
    return arr;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uuid', () => {
  it('returns lower-case RFC 4122 v4 strings that do not repeat', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
      const id = uuid();
      expect(id).toMatch(V4_RE);
      expect(isUuid(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it('prefers crypto.randomUUID when available', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });
    expect(uuid()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('falls back to getRandomValues and stamps version and variant bits', () => {
    const getRandomValues = fakeGetRandomValues([0xff]);
    const mathRandom = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', { getRandomValues });
    const id = uuid();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(getRandomValues.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(id).toMatch(V4_RE);
  });

  it('falls back to Math.random when crypto is absent', () => {
    vi.stubGlobal('crypto', undefined);
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
    const id = uuid();
    expect(mathRandom).toHaveBeenCalled();
    expect(id).toBe('00000000-0000-4000-8000-000000000000');
    mathRandom.mockReturnValue(0.999999);
    expect(uuid()).toMatch(V4_RE);
  });
});

describe('shortId', () => {
  it('defaults to 8 lower-case base36 characters and honours n', () => {
    expect(shortId()).toMatch(/^[0-9a-z]{8}$/);
    expect(shortId(1)).toMatch(/^[0-9a-z]$/);
    expect(shortId(32)).toMatch(/^[0-9a-z]{32}$/);
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(shortId(12));
    expect(ids.size).toBe(500);
  });

  it('rejects bytes that would bias the alphabet and keeps drawing until full', () => {
    // 252..255 are rejected; 0 → '0', 35 → 'z', 36 → '0' again, 251 → 251 % 36 = 35 → 'z'.
    const getRandomValues = fakeGetRandomValues([252, 255, 0, 35, 36, 251]);
    vi.stubGlobal('crypto', { getRandomValues });
    expect(shortId(4)).toBe('0z0z');
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('keeps drawing when a batch is exhausted by rejections', () => {
    let call = 0;
    const getRandomValues = vi.fn((arr) => {
      call++;
      arr.fill(call === 1 ? 255 : 10);
      return arr;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    expect(shortId(3)).toBe('aaa');
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });

  it('uses Math.random when crypto is absent', () => {
    vi.stubGlobal('crypto', undefined);
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(shortId(3)).toBe('kkk'); // floor(0.5 * 256) = 128 → 128 % 36 = 20 → 'k'
    expect(mathRandom).toHaveBeenCalled();
  });

  it('rejects a non-positive or non-integer length with ValidationError', () => {
    for (const n of [0, -3, 2.5, NaN, '8', null]) {
      let err;
      try {
        shortId(n);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.issues[0]).toMatchObject({ path: 'n', code: 'min' });
    }
  });
});

describe('requestId', () => {
  it('is header-safe, time-prefixed and unique', () => {
    const now = Date.now();
    const id = requestId();
    const m = /^req_([0-9a-z]+)_([0-9a-z]{8})$/.exec(id);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 36)).toBeGreaterThanOrEqual(now);
    expect(parseInt(m[1], 36)).toBeLessThanOrEqual(Date.now());
    const ids = new Set();
    for (let i = 0; i < 300; i++) ids.add(requestId());
    expect(ids.size).toBe(300);
  });

  it('encodes the (possibly faked) clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
      const t36 = Date.now().toString(36);
      expect(requestId().startsWith(`req_${t36}_`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('idempotencyKey', () => {
  it('equals scope + "-" + hash(stableStringify(payload))', () => {
    const payload = { itineraryId: 'it_1', consents: { terms: 'v2', fareRules: true } };
    expect(idempotencyKey('booking', payload)).toBe(`booking-${hash(stableStringify(payload))}`);
    expect(idempotencyKey('booking', payload)).toMatch(/^booking-[0-9a-z]{1,11}$/);
  });

  it('is stable across key order and equal payloads, and differs otherwise', () => {
    const a = idempotencyKey('booking', { a: 1, b: { c: 2, d: [1, 2] } });
    const b = idempotencyKey('booking', { b: { d: [1, 2], c: 2 }, a: 1 });
    expect(a).toBe(b);
    expect(idempotencyKey('booking', { a: 1, b: { c: 2, d: [2, 1] } })).not.toBe(a);
    expect(idempotencyKey('booking', { a: 2 })).not.toBe(idempotencyKey('booking', { a: 1 }));
    expect(idempotencyKey('payment', { a: 1 })).not.toBe(idempotencyKey('booking', { a: 1 }));
  });

  it('accepts a missing payload deterministically', () => {
    expect(idempotencyKey('booking')).toBe(idempotencyKey('booking', undefined));
    expect(idempotencyKey('booking')).toBe(`booking-${hash('null')}`);
    expect(idempotencyKey('booking', null)).toBe(idempotencyKey('booking'));
    expect(idempotencyKey('booking', {})).not.toBe(idempotencyKey('booking'));
  });

  it('rejects a missing or blank scope with ValidationError', () => {
    for (const scope of ['', '   ', undefined, null, 5, {}]) {
      let err;
      try {
        idempotencyKey(scope, { a: 1 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.issues[0]).toMatchObject({ path: 'scope', code: 'required' });
    }
  });

  it('propagates the ValidationError for circular payloads', () => {
    const o = {};
    o.self = o;
    expect(() => idempotencyKey('booking', o)).toThrow(ValidationError);
  });
});

describe('isUuid', () => {
  it('accepts canonical RFC 4122 UUIDs of any version in either case', () => {
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isUuid('9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D')).toBe(true);
    expect(isUuid(uuid())).toBe(true);
    expect(isUuid('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')).toBe(true);
  });

  it('rejects malformed values and non-strings', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('123e4567e89b12d3a456426614174000')).toBe(false);
    expect(isUuid('123e4567-e89b-02d3-a456-426614174000')).toBe(false);
    expect(isUuid('123e4567-e89b-12d3-c456-426614174000')).toBe(false);
    expect(isUuid('123e4567-e89b-12d3-a456-42661417400')).toBe(false);
    expect(isUuid('g23e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(isUuid(' 123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid({})).toBe(false);
  });
});

describe('randomness plumbing', () => {
  it('shortId fills more than 64 KiB in quota-sized slices of one buffer', () => {
    const sizes = [];
    const getRandomValues = vi.fn((arr) => {
      sizes.push(arr.length);
      arr.fill(10);
      return arr;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const id = shortId(70000);
    expect(id).toHaveLength(70000);
    expect(id).toMatch(/^a+$/);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
    expect(sizes.reduce((s, n) => s + n, 0)).toBe(70004);
    for (const call of getRandomValues.mock.calls) expect(call[0]).toBeInstanceOf(Uint8Array);
  });

  it('shortId above the quota works against the real Web Crypto without throwing', () => {
    expect(typeof globalThis.crypto?.getRandomValues).toBe('function');
    expect(shortId(70000)).toMatch(/^[0-9a-z]{70000}$/);
  });

  it('uuid and shortId fall back to Math.random when crypto has no usable methods', () => {
    vi.stubGlobal('crypto', {});
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(uuid()).toBe('00000000-0000-4000-8000-000000000000');
    expect(shortId(2)).toBe('00');
    expect(mathRandom).toHaveBeenCalled();
  });

  it('looks crypto up at call time, not import time', () => {
    const randomUUID = vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    vi.stubGlobal('crypto', { randomUUID });
    expect(uuid()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    vi.stubGlobal('crypto', null);
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(uuid()).toBe('00000000-0000-4000-8000-000000000000');
    expect(mathRandom).toHaveBeenCalled();
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe('idempotencyKey — header safety and payload normalisation', () => {
  it('rejects control characters in scope but accepts other punctuation', () => {
    for (const scope of ['book\ning', 'a\tb', 'x\u0000', 'del\u007f', 'cr\r']) {
      let err;
      try {
        idempotencyKey(scope, {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.issues[0]).toMatchObject({ path: 'scope', code: 'pattern' });
    }
    expect(idempotencyKey('/bookings:create', {})).toMatch(/^\/bookings:create-[0-9a-z]{1,11}$/);
    expect(idempotencyKey('payment:intent', 1)).toBe(`payment:intent-${hash('1')}`);
  });

  it('normalises Dates through toJSON and ignores undefined fields', () => {
    expect(idempotencyKey('b', { at: new Date(0) })).toBe(
      idempotencyKey('b', { at: '1970-01-01T00:00:00.000Z' })
    );
    expect(idempotencyKey('b', { a: 1, x: undefined })).toBe(idempotencyKey('b', { a: 1 }));
    expect(idempotencyKey('b', { a: 1, x: null })).not.toBe(idempotencyKey('b', { a: 1 }));
    expect(idempotencyKey('b', [1, 2])).not.toBe(idempotencyKey('b', [2, 1]));
  });
});

describe('isUuid — nil and max', () => {
  it('rejects the nil and max UUIDs, which carry no version', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(false);
    expect(isUuid('00000000-0000-1000-8000-000000000000')).toBe(true);
  });
});
