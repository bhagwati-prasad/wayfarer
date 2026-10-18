import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createStorage,
  memoryDriver,
  webStorageDriver,
  cookieDriver,
} from '../../src/storage/adapters.js';
import { ConfigError, StorageError, ValidationError, SdkError } from '../../src/errors/index.js';
import { createEmitter } from '../../src/events/emitter.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Minimal DOM `Storage` look-alike backed by a Map, with optional failure hooks. */
function fakeArea({ failSet = false, failGet = false } = {}) {
  const map = new Map();
  const area = {
    get length() {
      return map.size;
    },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: vi.fn((k) => {
      if (failGet) throw new DOMException('blocked', 'SecurityError');
      return map.has(k) ? map.get(k) : null;
    }),
    setItem: vi.fn((k, v) => {
      if (area.failSet) throw new DOMException('quota', 'QuotaExceededError');
      map.set(k, String(v));
    }),
    removeItem: vi.fn((k) => {
      map.delete(k);
    }),
    clear: () => map.clear(),
    failSet,
    map,
  };
  return area;
}

/** Window stand-in that records storage listeners and can dispatch to them. */
function fakeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener: vi.fn((type, fn) => {
      if (type === 'storage') listeners.add(fn);
    }),
    removeEventListener: vi.fn((type, fn) => {
      if (type === 'storage') listeners.delete(fn);
    }),
    dispatch(event) {
      for (const fn of Array.from(listeners)) fn(event);
    },
  };
}

/**
 * `document` stand-in whose `cookie` property behaves like a browser cookie jar: the setter parses
 * one `name=value; attrs` string, honours `Max-Age=0`, and (when `dropSecure`) rejects `Secure`
 * cookies the way an http page would.
 */
function fakeDocument({ dropSecure = false } = {}) {
  const jar = new Map();
  const writes = [];
  return {
    jar,
    writes,
    get cookie() {
      return Array.from(jar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    },
    set cookie(str) {
      writes.push(str);
      const [pair, ...attrs] = str.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const lower = attrs.map((a) => a.toLowerCase());
      if (lower.includes('max-age=0')) {
        jar.delete(name);
        return;
      }
      if (dropSecure && lower.includes('secure')) return;
      jar.set(name, value);
    },
  };
}

/** `{ emit }` duck-typed emitter that records what it receives. */
function emitter() {
  const calls = [];
  return { calls, emit: vi.fn((type, payload) => calls.push({ type, payload })) };
}

/** Adapter that fails on every write (private mode / quota). */
function brokenDriver(name = 'quota') {
  return {
    name,
    getItem: vi.fn(() => null),
    setItem: vi.fn(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    }),
    removeItem: vi.fn(),
    keys: vi.fn(() => []),
  };
}

/** Map-backed custom adapter without `keys()` (a plain key/value SDK). */
function kvAdapter(name = 'kv') {
  const map = new Map();
  return {
    map,
    name,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** Deterministic injectable clock. */
function clock(start = 1_000_000) {
  let t = start;
  const now = vi.fn(() => t);
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** Install a throwing accessor for a global (Safari-style `SecurityError` on access). */
function throwingGlobal(name, record) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      if (record) record.push(name);
      throw new DOMException(`${name}: the operation is insecure.`, 'SecurityError');
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // `defineProperty` stubs (throwing accessors) are not covered by unstubAllGlobals.
  for (const name of ['window', 'document', 'localStorage', 'sessionStorage']) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc && desc.configurable && typeof desc.get === 'function') delete globalThis[name];
  }
});

// ── module import ────────────────────────────────────────────────────────────────────────────────

describe('module import', () => {
  it('is SSR-safe: importing touches neither window, document nor web storage', async () => {
    const touched = [];
    for (const name of ['window', 'document', 'localStorage', 'sessionStorage']) {
      throwingGlobal(name, touched);
    }
    vi.resetModules();
    const fresh = await import('../../src/storage/adapters.js');
    expect(typeof fresh.createStorage).toBe('function');
    expect(typeof fresh.memoryDriver).toBe('function');
    expect(typeof fresh.webStorageDriver).toBe('function');
    expect(typeof fresh.cookieDriver).toBe('function');
    expect(touched).toEqual([]);

    // At call time the throwing accessors are handled (memory fallback), never propagated.
    for (const driver of ['local', 'session', 'cookie']) {
      const storage = fresh.createStorage({ driver });
      expect(storage.driverName).toBe('memory');
      storage.set('k', 1);
      expect(storage.get('k')).toBe(1);
      expect(() => storage.subscribe('k', () => {})()).not.toThrow();
    }
  });
});

// ── memoryDriver ─────────────────────────────────────────────────────────────────────────────────

describe('memoryDriver', () => {
  it('stores strings in isolation per instance and lists its keys', () => {
    const a = memoryDriver();
    const b = memoryDriver();
    expect(a.name).toBe('memory');
    expect(a.getItem('x')).toBeNull();
    a.setItem('x', '1');
    a.setItem('y', 2);
    expect(a.getItem('x')).toBe('1');
    expect(a.getItem('y')).toBe('2'); // coerced to string like real Storage
    expect(a.keys().sort()).toEqual(['x', 'y']);
    expect(b.getItem('x')).toBeNull();
    a.removeItem('x');
    expect(a.getItem('x')).toBeNull();
    expect(a.keys()).toEqual(['y']);
  });
});

// ── webStorageDriver ─────────────────────────────────────────────────────────────────────────────

describe('webStorageDriver', () => {
  it('wraps a Storage area and names it after the matching global', () => {
    const area = fakeArea();
    const anonymous = webStorageDriver(area);
    expect(anonymous.name).toBe('web');
    anonymous.setItem('k', 'v');
    expect(area.setItem).toHaveBeenCalledWith('k', 'v');
    expect(anonymous.getItem('k')).toBe('v');
    expect(anonymous.keys()).toEqual(['k']);
    anonymous.removeItem('k');
    expect(anonymous.getItem('k')).toBeNull();

    vi.stubGlobal('localStorage', area);
    expect(webStorageDriver(area).name).toBe('local');
    const session = fakeArea();
    vi.stubGlobal('sessionStorage', session);
    expect(webStorageDriver(session).name).toBe('session');
  });

  it('turns an unusable area into StorageError on use (never at construction)', () => {
    const driver = webStorageDriver(undefined);
    expect(driver.name).toBe('web');
    expect(() => driver.getItem('k')).toThrow(StorageError);
    expect(() => driver.setItem('k', 'v')).toThrow(StorageError);
    expect(() => driver.removeItem('k')).toThrow(StorageError);
    expect(() => driver.keys()).toThrow(StorageError);
  });
});

// ── cookieDriver ─────────────────────────────────────────────────────────────────────────────────

describe('cookieDriver', () => {
  it('encodes keys and values and writes domain / secure / sameSite / path attributes', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const driver = cookieDriver({ domain: '.ota.com', secure: true, sameSite: 'lax' });
    expect(driver.name).toBe('cookie');
    const value = '{"v":"a;b=c d","e":1}';
    driver.setItem('wf:k y', value);
    const written = doc.writes[0];
    expect(
      written.startsWith(`${encodeURIComponent('wf:k y')}=${encodeURIComponent(value)}; `)
    ).toBe(true);
    expect(written).toContain('Path=/');
    expect(written).toContain('Domain=.ota.com');
    expect(written).toContain('SameSite=Lax');
    expect(written).toContain('Secure');
    expect(written).not.toContain('Max-Age');
    expect(driver.getItem('wf:k y')).toBe(value);
    expect(driver.getItem('missing')).toBeNull();
    expect(driver.keys()).toEqual(['wf:k y']);
  });

  it('round-trips unicode and separators, and supports Max-Age (rounded up)', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const driver = cookieDriver({ maxAgeSec: 3600.1 });
    driver.setItem('ünï', 'a=b; c,d\nz €');
    expect(driver.getItem('ünï')).toBe('a=b; c,d\nz €');
    expect(doc.writes[0]).toContain('Max-Age=3601');
    expect(doc.writes[0]).not.toContain('Secure');
    expect(doc.writes[0]).not.toContain('SameSite');
    expect(doc.writes[0]).not.toContain('Domain');
    // a sub-second TTL never becomes `Max-Age=0` (which would delete the cookie on write)
    cookieDriver({ maxAgeSec: 0.2 }).setItem('short', '1');
    expect(doc.writes.at(-1)).toContain('Max-Age=1');
    expect(driver.getItem('short')).toBe('1');
  });

  it('removes with Max-Age=0 and the same Domain / Path so the browser matches the cookie', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const driver = cookieDriver({ domain: 'ota.com', path: '/app' });
    driver.setItem('a', '1');
    driver.setItem('b', '2');
    driver.removeItem('a');
    const last = doc.writes.at(-1);
    expect(last.startsWith('a=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT')).toBe(true);
    expect(last).toContain('Path=/app');
    expect(last).toContain('Domain=ota.com');
    expect(driver.getItem('a')).toBeNull();
    expect(driver.keys()).toEqual(['b']);
  });

  it("forces Secure for sameSite 'none' and rejects invalid options with ConfigError", () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    cookieDriver({ sameSite: 'None' }).setItem('k', 'v');
    expect(doc.writes[0]).toContain('SameSite=None');
    expect(doc.writes[0]).toContain('Secure');
    expect(() => cookieDriver({ sameSite: 'sometimes' })).toThrow(ConfigError);
    for (const maxAgeSec of ['soon', 0, -1, NaN, Infinity]) {
      expect(() => cookieDriver({ maxAgeSec })).toThrow(ConfigError);
    }
    expect(doc.writes).toHaveLength(1); // rejected configs never reach the jar
  });

  it('throws StorageError when there is no document or the browser rejects the write', () => {
    const ssr = cookieDriver();
    expect(() => ssr.getItem('k')).toThrow(StorageError);
    expect(() => ssr.setItem('k', 'v')).toThrow(StorageError);
    expect(() => ssr.removeItem('k')).toThrow(StorageError);
    expect(() => ssr.keys()).toThrow(StorageError);

    vi.stubGlobal('document', fakeDocument({ dropSecure: true }));
    const driver = cookieDriver({ secure: true });
    expect(() => driver.setItem('k', 'v')).toThrow(StorageError);
  });

  it('skips foreign cookies it cannot decode instead of failing', () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    doc.jar.set('legacy', '%E0%A4%A'); // malformed percent-encoding from another app
    doc.jar.set('flag', '');
    const driver = cookieDriver();
    driver.setItem('mine', 'x');
    expect(driver.keys().sort()).toEqual(['flag', 'mine']);
    expect(driver.getItem('flag')).toBe('');
  });
});

// ── createStorage: basics ────────────────────────────────────────────────────────────────────────

describe('createStorage / basics', () => {
  it('round-trips JSON values under namespaced keys using { v } envelopes', () => {
    const driver = memoryDriver();
    const storage = createStorage({ driver });
    expect(storage.driverName).toBe('memory');
    expect(storage.isAvailable()).toBe(true);

    const samples = {
      obj: { a: 1, b: [1, 2, { c: 'd' }] },
      arr: [1, 'two', null],
      str: 'text',
      num: 42,
      zero: 0,
      bool: false,
      nil: null,
      envelopeLike: { v: 1 }, // user data that happens to look like an envelope
    };
    for (const [k, v] of Object.entries(samples)) expect(storage.set(k, v)).toBeUndefined();
    for (const [k, v] of Object.entries(samples)) {
      expect(storage.get(k)).toEqual(v);
      expect(storage.has(k)).toBe(true);
    }
    expect(JSON.parse(driver.getItem('wf:obj'))).toEqual({ v: samples.obj });
    expect(driver.getItem('wf:nil')).toBe('{"v":null}');
    expect(storage.get('missing')).toBeUndefined();
    expect(storage.has('missing')).toBe(false);
    // the probe key never lingers
    expect(driver.keys().some((k) => k.includes('probe'))).toBe(false);
  });

  it('removes on remove() and on set(key, undefined)', () => {
    const driver = memoryDriver();
    const storage = createStorage({ driver });
    storage.set('a', 1);
    storage.set('b', 2);
    storage.remove('a');
    storage.set('b', undefined);
    expect(storage.get('a')).toBeUndefined();
    expect(storage.get('b')).toBeUndefined();
    expect(driver.keys()).toEqual([]);
    expect(() => storage.remove('never-set')).not.toThrow();
  });

  it('defaults to the memory driver when none is given', () => {
    const storage = createStorage();
    expect(storage.driverName).toBe('memory');
    storage.set('k', 'v');
    expect(storage.get('k')).toBe('v');
  });

  it('does not mutate the value or options passed to set and hands out fresh copies on get', () => {
    const storage = createStorage({ now: clock() });
    const value = { nested: { list: [1, 2] } };
    const options = Object.freeze({ ttlMs: 1000 });
    const before = JSON.stringify(value);
    storage.set('k', value, options);
    expect(JSON.stringify(value)).toBe(before);
    expect(Object.keys(value)).toEqual(['nested']); // no envelope fields leaked onto the input
    const first = storage.get('k');
    first.nested.list.push(3);
    expect(storage.get('k')).toEqual({ nested: { list: [1, 2] } });
    expect(storage.get('k')).not.toBe(first);
  });

  it('never pollutes Object.prototype through hostile keys or stored payloads', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const area = fakeArea();
    area.setItem('wf:evil', '{"__proto__":{"polluted":true},"v":1}');
    area.setItem('wf:evil2', '{"v":{"__proto__":{"polluted":true},"x":1}}');
    const storage = createStorage({ driver: webStorageDriver(area) });
    const hostile = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString'];
    for (const key of hostile) {
      storage.set(key, { marker: key });
      expect(storage.get(key)).toEqual({ marker: key });
      expect(storage.has(key)).toBe(true);
    }
    expect(storage.keys().sort()).toEqual([...hostile, 'evil', 'evil2'].sort());
    const evil = storage.get('evil'); // extra key → not an envelope → raw object, own `__proto__`
    expect(evil.v).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(evil, '__proto__')).toBe(true);
    expect(storage.get('evil2').x).toBe(1);
    const fn = vi.fn();
    const off = storage.subscribe('__proto__', fn);
    win.dispatch({ key: 'wf:__proto__', newValue: '{"v":2}', oldValue: null, storageArea: area });
    expect(fn).toHaveBeenCalledWith(2, undefined, '__proto__');
    off();
    storage.clear();
    expect(storage.keys()).toEqual([]);
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect(Object.prototype.marker).toBeUndefined();
  });

  it('validates keys, prefixes and subscribers with ValidationError', () => {
    const storage = createStorage();
    for (const bad of ['', 42, null, undefined, {}]) {
      expect(() => storage.get(bad)).toThrow(ValidationError);
      expect(() => storage.set(bad, 1)).toThrow(ValidationError);
      expect(() => storage.remove(bad)).toThrow(ValidationError);
      expect(() => storage.has(bad)).toThrow(ValidationError);
      expect(() => storage.subscribe(bad, () => {})).toThrow(ValidationError);
    }
    expect(() => storage.keys(5)).toThrow(ValidationError);
    expect(() => storage.subscribe('k', 'nope')).toThrow(ValidationError);
    try {
      storage.get('');
    } catch (e) {
      expect(e.issues).toEqual([expect.objectContaining({ path: 'key', code: 'invalid_type' })]);
    }
  });

  it('rejects bad configuration with ConfigError', () => {
    expect(() => createStorage({ driver: 'indexeddb' })).toThrow(ConfigError);
    expect(() => createStorage({ driver: { getItem() {} } })).toThrow(ConfigError);
    expect(() => createStorage({ driver: 42 })).toThrow(ConfigError);
    expect(() => createStorage({ namespace: 7 })).toThrow(ConfigError);
    expect(() => createStorage({ serializer: { serialize: JSON.stringify } })).toThrow(ConfigError);
    expect(() => createStorage({ serializer: null })).toThrow(ConfigError);
    expect(() => createStorage({ defaultTtlMs: -1 })).toThrow(ConfigError);
    expect(() => createStorage({ defaultTtlMs: 'later' })).toThrow(ConfigError);
    expect(() => createStorage({ onUnavailable: true })).toThrow(ConfigError);
    expect(() => createStorage({ now: 5 })).toThrow(ConfigError);
    expect(() => createStorage({ now: Date.now })).not.toThrow();
  });
});

// ── namespacing ──────────────────────────────────────────────────────────────────────────────────

describe('createStorage / namespacing', () => {
  it('prefixes raw keys with the namespace and isolates facades sharing one driver', () => {
    const driver = memoryDriver();
    const a = createStorage({ driver, namespace: 'appA' });
    const b = createStorage({ driver, namespace: 'appB' });
    a.set('user', 'alice');
    b.set('user', 'bob');
    expect(driver.getItem('appA:user')).toBe('{"v":"alice"}');
    expect(driver.getItem('appB:user')).toBe('{"v":"bob"}');
    expect(a.get('user')).toBe('alice');
    expect(b.get('user')).toBe('bob');
    expect(a.keys()).toEqual(['user']);
    a.clear();
    expect(a.get('user')).toBeUndefined();
    expect(b.get('user')).toBe('bob');
  });

  it('uses the "wf" namespace by default and no prefix for an empty namespace', () => {
    const driver = memoryDriver();
    createStorage({ driver }).set('k', 1);
    expect(driver.keys()).toEqual(['wf:k']);
    const bare = createStorage({ driver: memoryDriver(), namespace: '' });
    bare.set('k', 1);
    expect(bare.keys()).toEqual(['k']);
    expect(bare.get('k')).toBe(1);
  });
});

// ── keys(prefix) / clear(prefix) ─────────────────────────────────────────────────────────────────

describe('createStorage / keys and clear', () => {
  it('lists un-namespaced keys filtered by prefix and ignores foreign keys', () => {
    const driver = memoryDriver();
    driver.setItem('other:thing', '1');
    driver.setItem('wfx', '1'); // shares the first letters but not the "wf:" prefix
    const storage = createStorage({ driver });
    storage.set('cache:a', 1);
    storage.set('cache:b', 2);
    storage.set('prefs', 3);
    expect(storage.keys().sort()).toEqual(['cache:a', 'cache:b', 'prefs']);
    expect(storage.keys('cache:').sort()).toEqual(['cache:a', 'cache:b']);
    expect(storage.keys('nope')).toEqual([]);
  });

  it('clear(prefix) removes only matching keys; clear() removes every namespaced key only', () => {
    const driver = memoryDriver();
    driver.setItem('other:thing', '1');
    const storage = createStorage({ driver });
    storage.set('cache:a', 1);
    storage.set('cache:b', 2);
    storage.set('prefs', 3);
    storage.clear('cache:');
    expect(storage.keys()).toEqual(['prefs']);
    expect(storage.get('cache:a')).toBeUndefined();
    storage.clear();
    expect(storage.keys()).toEqual([]);
    expect(driver.getItem('other:thing')).toBe('1');
  });

  it('tracks keys itself for adapters without keys()', () => {
    const adapter = kvAdapter();
    const storage = createStorage({ driver: adapter });
    expect(storage.driverName).toBe('kv');
    storage.set('a', 1);
    storage.set('b:1', 2);
    storage.set('b:2', 3);
    expect(storage.keys().sort()).toEqual(['a', 'b:1', 'b:2']);
    storage.remove('a');
    storage.clear('b:');
    expect(storage.keys()).toEqual([]);
    expect(adapter.map.size).toBe(0);
  });

  it('names an anonymous adapter "custom" and forwards keys() when present', () => {
    const inner = memoryDriver();
    const anon = {
      getItem: (k) => inner.getItem(k),
      setItem: (k, v) => inner.setItem(k, v),
      removeItem: (k) => inner.removeItem(k),
      keys: () => inner.keys(),
    };
    const storage = createStorage({ driver: anon, namespace: 'n' });
    expect(storage.driverName).toBe('custom');
    storage.set('x', 1);
    expect(inner.keys()).toEqual(['n:x']);
    expect(storage.keys()).toEqual(['x']);
  });

  it('accepts an adapter whose keys() returns any iterable without falling back', () => {
    const map = new Map();
    const adapter = {
      name: 'iter',
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
      removeItem: (k) => {
        map.delete(k);
      },
      keys: () => new Set(map.keys()),
    };
    const onUnavailable = vi.fn();
    const storage = createStorage({ driver: adapter, onUnavailable });
    storage.set('a', 1);
    storage.set('b', 2);
    expect(storage.keys().sort()).toEqual(['a', 'b']);
    expect(storage.isAvailable()).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
    storage.clear();
    expect(map.size).toBe(0);
  });

  it('never lists the probe key, even when the probe could not clean it up', () => {
    const inner = memoryDriver();
    const readOnlyRemove = {
      ...inner,
      name: 'noremove',
      removeItem: () => {
        throw new Error('removeItem not supported');
      },
    };
    const onUnavailable = vi.fn();
    const storage = createStorage({ driver: readOnlyRemove, onUnavailable });
    expect(storage.driverName).toBe('memory'); // the failed probe cleanup degraded the facade
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(inner.keys()).toEqual(['wf:__wf_probe__']); // left behind in the broken driver …
    storage.set('a', 1);
    expect(storage.keys()).toEqual(['a']); // … but never surfaced through the facade
    expect(storage.has('__wf_probe__')).toBe(false);
  });

  it('wraps a raw DOM Storage area passed as driver (keys and cross-tab events work)', () => {
    const area = fakeArea();
    area.setItem('wf:old', '{"v":"persisted"}');
    vi.stubGlobal('localStorage', area);
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const storage = createStorage({ driver: area });
    expect(storage.driverName).toBe('local');
    expect(storage.get('old')).toBe('persisted');
    expect(storage.keys()).toEqual(['old']);
    const fn = vi.fn();
    storage.subscribe('old', fn);
    expect(win.listeners.size).toBe(1);
    win.dispatch({ key: 'wf:old', newValue: '{"v":2}', oldValue: null, storageArea: area });
    expect(fn).toHaveBeenCalledWith(2, undefined, 'old');
    storage.destroy();
    expect(win.listeners.size).toBe(0);
  });
});

// ── TTL ──────────────────────────────────────────────────────────────────────────────────────────

describe('createStorage / TTL', () => {
  it('stores { v, e } envelopes and expires entries through the injected clock', () => {
    const now = clock(1_000_000);
    const driver = memoryDriver();
    const storage = createStorage({ driver, now });
    storage.set('k', 'v', { ttlMs: 1000 });
    expect(JSON.parse(driver.getItem('wf:k'))).toEqual({ v: 'v', e: 1_001_000 });
    now.advance(999);
    expect(storage.get('k')).toBe('v');
    expect(storage.has('k')).toBe(true);
    now.advance(1);
    expect(storage.get('k')).toBeUndefined();
    expect(driver.getItem('wf:k')).toBeNull(); // deleted on read
    storage.set('h', 1, { ttlMs: 10 });
    now.advance(10);
    expect(storage.has('h')).toBe(false);
    expect(driver.getItem('wf:h')).toBeNull();
  });

  it('follows Date.now under fake timers when no clock is injected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    const driver = memoryDriver();
    const storage = createStorage({ driver });
    storage.set('k', { a: 1 }, { ttlMs: 60_000 });
    expect(JSON.parse(driver.getItem('wf:k')).e).toBe(Date.now() + 60_000);
    vi.advanceTimersByTime(59_999);
    expect(storage.get('k')).toEqual({ a: 1 });
    vi.advanceTimersByTime(1);
    expect(storage.get('k')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); // the facade never starts timers of its own
  });

  it('applies defaultTtlMs, lets ttlMs override it and treats 0 / null / Infinity as no expiry', () => {
    const now = clock();
    const driver = memoryDriver();
    const storage = createStorage({ driver, now, defaultTtlMs: 500 });
    storage.set('d', 1);
    storage.set('long', 2, { ttlMs: 5000 });
    storage.set('forever', 3, { ttlMs: 0 });
    storage.set('inf', 4, { ttlMs: Infinity });
    storage.set('nul', 5, { ttlMs: null });
    expect(JSON.parse(driver.getItem('wf:forever'))).toEqual({ v: 3 });
    expect(JSON.parse(driver.getItem('wf:inf'))).toEqual({ v: 4 });
    expect(JSON.parse(driver.getItem('wf:nul'))).toEqual({ v: 5 });
    now.advance(500);
    expect(storage.get('d')).toBeUndefined();
    expect(storage.get('long')).toBe(2);
    expect(storage.get('forever')).toBe(3);
    now.advance(4500);
    expect(storage.get('long')).toBeUndefined();
    expect(storage.get('forever')).toBe(3);
    expect(storage.get('inf')).toBe(4);
    expect(storage.get('nul')).toBe(5);
  });

  it('rejects invalid ttlMs with ValidationError before writing', () => {
    const driver = memoryDriver();
    const storage = createStorage({ driver });
    for (const bad of [-1, NaN, 'soon', {}]) {
      expect(() => storage.set('k', 1, { ttlMs: bad })).toThrow(ValidationError);
    }
    expect(driver.keys()).toEqual([]);
  });
});

// ── serializer & corrupt data ────────────────────────────────────────────────────────────────────

describe('createStorage / serializer', () => {
  it('uses a custom serializer for every write and read', () => {
    const serializer = {
      serialize: vi.fn((v) => `S:${JSON.stringify(v)}`),
      deserialize: vi.fn((raw) => JSON.parse(raw.slice(2))),
    };
    const driver = memoryDriver();
    const storage = createStorage({ driver, serializer });
    storage.set('k', [1, 2]);
    expect(driver.getItem('wf:k')).toBe('S:{"v":[1,2]}');
    expect(storage.get('k')).toEqual([1, 2]);
    expect(serializer.serialize).toHaveBeenCalledWith({ v: [1, 2] });
    expect(serializer.deserialize).toHaveBeenCalledWith('S:{"v":[1,2]}');
  });

  it('wraps serializer failures in StorageError without touching the driver or falling back', () => {
    const driver = memoryDriver();
    const onUnavailable = vi.fn();
    const storage = createStorage({ driver, onUnavailable });
    const circular = {};
    circular.self = circular;
    expect(() => storage.set('k', circular)).toThrow(StorageError);
    expect(() =>
      createStorage({ serializer: { serialize: () => 42, deserialize: () => 1 } }).set('k', 1)
    ).toThrow(StorageError);
    expect(driver.keys()).toEqual([]);
    expect(storage.isAvailable()).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('drops corrupt entries and passes raw foreign values through', () => {
    const driver = memoryDriver();
    driver.setItem('wf:broken', '{not json');
    driver.setItem('wf:plain', '"legacy"');
    driver.setItem('wf:obj', '{"a":1,"v":2}'); // has v but also other keys: not an envelope
    const storage = createStorage({ driver });
    expect(storage.get('broken')).toBeUndefined();
    expect(driver.getItem('wf:broken')).toBeNull();
    expect(storage.get('plain')).toBe('legacy');
    expect(storage.get('obj')).toEqual({ a: 1, v: 2 });
  });
});

// ── fallback to memory ───────────────────────────────────────────────────────────────────────────

describe('createStorage / fallback', () => {
  it('falls back to memory when the driver throws on probe, reporting once', () => {
    const driver = brokenDriver('quota');
    const onUnavailable = vi.fn();
    const events = emitter();
    const storage = createStorage({ driver, onUnavailable, events });

    expect(storage.driverName).toBe('memory');
    expect(storage.isAvailable()).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    const [error, info] = onUnavailable.mock.calls[0];
    expect(error).toBeInstanceOf(StorageError);
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(error.details).toMatchObject({ driver: 'quota' });
    expect(info).toEqual({ driver: 'quota', fallback: 'memory' });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.calls[0].type).toBe('storage:unavailable');
    expect(events.calls[0].payload).toEqual({ driver: 'quota', fallback: 'memory', error });

    storage.set('k', { ok: true });
    expect(storage.get('k')).toEqual({ ok: true });
    expect(storage.keys()).toEqual(['k']);
    expect(driver.setItem).toHaveBeenCalledTimes(1); // only the probe reached the broken driver
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('emits storage:unavailable through the real emitter with the { type, at, ...data } envelope', () => {
    const events = createEmitter({ now: () => 4242 });
    const seen = [];
    const everything = [];
    events.on('storage:unavailable', (p) => seen.push(p));
    events.on('*', (p) => everything.push(p.type));
    const storage = createStorage({ driver: brokenDriver('quota'), events });
    expect(storage.driverName).toBe('memory');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'storage:unavailable',
      at: 4242,
      driver: 'quota',
      fallback: 'memory',
    });
    expect(seen[0].error).toBeInstanceOf(StorageError);
    expect(everything).toEqual(['storage:unavailable']); // no stray `error` event
  });

  it('falls back when the probe value does not read back (silent no-op storage)', () => {
    const silent = { name: 'silent', getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const onUnavailable = vi.fn();
    const storage = createStorage({ driver: silent, onUnavailable });
    expect(storage.isAvailable()).toBe(false);
    expect(storage.driverName).toBe('memory');
    expect(onUnavailable.mock.calls[0][0]).toBeInstanceOf(StorageError);
    expect(onUnavailable.mock.calls[0][0].message).toMatch(/probe/);
  });

  it('degrades mid-life on a quota error, keeps the write and carries existing data over', () => {
    const area = fakeArea();
    const onUnavailable = vi.fn();
    const events = emitter();
    const storage = createStorage({ driver: webStorageDriver(area), onUnavailable, events });
    storage.set('a', 1);
    expect(storage.isAvailable()).toBe(true);
    expect(area.map.get('wf:a')).toBe('{"v":1}');

    area.failSet = true;
    storage.set('b', 2); // quota exceeded → memory
    expect(storage.isAvailable()).toBe(false);
    expect(storage.driverName).toBe('memory');
    expect(storage.get('a')).toBe(1); // copied from the old area
    expect(storage.get('b')).toBe(2); // the failing write landed in memory
    expect(storage.keys().sort()).toEqual(['a', 'b']);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(events.calls.map((c) => c.type)).toEqual(['storage:unavailable']);
    expect(events.calls[0].payload.driver).toBe('web');

    storage.set('c', 3);
    expect(area.map.has('wf:c')).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('carries data over for an adapter without keys() using its own bookkeeping', () => {
    const adapter = kvAdapter('flaky');
    const storage = createStorage({ driver: adapter });
    storage.set('a', 1);
    storage.set('b', 2);
    storage.remove('b');
    adapter.setItem = () => {
      throw new Error('disk full');
    };
    storage.set('c', 3);
    expect(storage.driverName).toBe('memory');
    expect(storage.keys().sort()).toEqual(['a', 'c']);
    expect(storage.get('a')).toBe(1);
    expect(storage.get('c')).toBe(3);
  });

  it('degrades on a read failure and returns undefined for that read', () => {
    const area = fakeArea();
    const storage = createStorage({ driver: webStorageDriver(area) });
    storage.set('a', 1);
    area.getItem.mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(storage.get('a')).toBeUndefined();
    expect(storage.isAvailable()).toBe(false);
    storage.set('a', 2);
    expect(storage.get('a')).toBe(2);
  });

  it("uses memory for 'local' / 'session' / 'cookie' when the runtime has none (SSR)", () => {
    for (const driver of ['local', 'session', 'cookie']) {
      const onUnavailable = vi.fn();
      const events = emitter();
      const storage = createStorage({ driver, onUnavailable, events });
      expect(storage.driverName).toBe('memory');
      expect(storage.isAvailable()).toBe(false);
      expect(onUnavailable).toHaveBeenCalledWith(expect.any(StorageError), {
        driver,
        fallback: 'memory',
      });
      expect(events.calls[0].payload.driver).toBe(driver);
      storage.set('k', 1);
      expect(storage.get('k')).toBe(1);
    }
  });

  it('falls back when merely accessing localStorage throws (Safari with cookies blocked)', () => {
    throwingGlobal('localStorage');
    const onUnavailable = vi.fn();
    const storage = createStorage({ driver: 'local', onUnavailable });
    expect(storage.driverName).toBe('memory');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0][1].driver).toBe('local');
  });

  it("uses the real localStorage / sessionStorage globals for 'local' / 'session'", () => {
    const local = fakeArea();
    const session = fakeArea();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    const onUnavailable = vi.fn();
    const l = createStorage({ driver: 'local', onUnavailable });
    const s = createStorage({ driver: 'session', onUnavailable });
    expect(l.driverName).toBe('local');
    expect(s.driverName).toBe('session');
    expect(l.isAvailable()).toBe(true);
    l.set('k', 'L');
    s.set('k', 'S');
    expect(local.map.get('wf:k')).toBe('{"v":"L"}');
    expect(session.map.get('wf:k')).toBe('{"v":"S"}');
    expect(local.map.has('wf:__wf_probe__')).toBe(false);
    expect(l.keys()).toEqual(['k']);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("uses document.cookie for 'cookie'", () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc);
    const storage = createStorage({ driver: 'cookie' });
    expect(storage.driverName).toBe('cookie');
    storage.set('k', { a: 'b c' });
    expect(storage.get('k')).toEqual({ a: 'b c' });
    expect(doc.cookie).toBe(
      `${encodeURIComponent('wf:k')}=${encodeURIComponent('{"v":{"a":"b c"}}')}`
    );
    expect(storage.keys()).toEqual(['k']);
    storage.clear();
    expect(doc.cookie).toBe('');
  });

  it('survives a throwing onUnavailable hook or emitter and works without either', () => {
    const storage = createStorage({
      driver: brokenDriver(),
      onUnavailable: () => {
        throw new Error('hook bug');
      },
      events: {
        emit: () => {
          throw new Error('emitter bug');
        },
      },
    });
    expect(storage.driverName).toBe('memory');
    storage.set('k', 1);
    expect(storage.get('k')).toBe(1);
    expect(() => createStorage({ driver: brokenDriver() })).not.toThrow();
    expect(() => createStorage({ driver: brokenDriver(), events: {} })).not.toThrow();
  });
});

// ── subscribe ────────────────────────────────────────────────────────────────────────────────────

describe('createStorage / subscribe', () => {
  it('returns a no-op off() and touches nothing when there is no window', () => {
    expect(typeof globalThis.window).toBe('undefined');
    const storage = createStorage({ driver: webStorageDriver(fakeArea()) });
    const fn = vi.fn();
    const off = storage.subscribe('k', fn);
    expect(typeof off).toBe('function');
    expect(() => {
      off();
      off();
    }).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
    storage.destroy();
  });

  it('attaches no window listener for drivers that cannot observe other tabs', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', fakeDocument());
    const drivers = { memory: memoryDriver(), cookie: 'cookie', custom: kvAdapter() };
    for (const [label, driver] of Object.entries(drivers)) {
      const storage = createStorage({ driver });
      expect(storage.isAvailable(), label).toBe(true);
      const fn = vi.fn();
      const off = storage.subscribe('k', fn);
      expect(win.addEventListener, label).not.toHaveBeenCalled();
      win.dispatch({ key: 'wf:k', newValue: '{"v":1}', oldValue: null });
      expect(fn, label).not.toHaveBeenCalled();
      expect(() => off()).not.toThrow();
      storage.destroy();
    }
    expect(win.listeners.size).toBe(0);
  });

  it('shares one window storage listener and delivers decoded values for matching keys', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const area = fakeArea();
    const storage = createStorage({ driver: webStorageDriver(area), namespace: 'ns' });
    const onPrefs = vi.fn();
    const onPrefs2 = vi.fn();
    const onHistory = vi.fn();
    const offPrefs = storage.subscribe('prefs', onPrefs);
    const offPrefs2 = storage.subscribe('prefs', onPrefs2);
    const offHistory = storage.subscribe('history', onHistory);
    expect(win.addEventListener).toHaveBeenCalledTimes(1);
    expect(win.listeners.size).toBe(1);

    win.dispatch({
      key: 'ns:prefs',
      newValue: '{"v":{"locale":"en-IN"}}',
      oldValue: '{"v":{"locale":"en-US"}}',
      storageArea: area,
    });
    expect(onPrefs).toHaveBeenCalledWith({ locale: 'en-IN' }, { locale: 'en-US' }, 'prefs');
    expect(onPrefs2).toHaveBeenCalledTimes(1);
    expect(onHistory).not.toHaveBeenCalled();

    // other namespace / unknown key / other storage area (also for clear()): ignored
    win.dispatch({ key: 'other:prefs', newValue: '{"v":1}', oldValue: null, storageArea: area });
    win.dispatch({ key: 'ns:nothing', newValue: '{"v":1}', oldValue: null, storageArea: area });
    win.dispatch({ key: 'ns:prefs', newValue: '{"v":1}', oldValue: null, storageArea: fakeArea() });
    win.dispatch({ key: null, newValue: null, oldValue: null, storageArea: fakeArea() });
    expect(onPrefs).toHaveBeenCalledTimes(1);
    expect(onHistory).not.toHaveBeenCalled();

    // removal / expired / corrupt new values arrive as undefined
    win.dispatch({ key: 'ns:prefs', newValue: null, oldValue: '{"v":1}', storageArea: area });
    expect(onPrefs).toHaveBeenLastCalledWith(undefined, 1, 'prefs');
    win.dispatch({
      key: 'ns:prefs',
      newValue: '{"v":1,"e":1}',
      oldValue: '{nope',
      storageArea: area,
    });
    expect(onPrefs).toHaveBeenLastCalledWith(undefined, undefined, 'prefs');

    // storage.clear() in another tab → every subscriber hears undefined
    win.dispatch({ key: null, newValue: null, oldValue: null, storageArea: area });
    expect(onPrefs).toHaveBeenLastCalledWith(undefined, undefined, 'prefs');
    expect(onHistory).toHaveBeenLastCalledWith(undefined, undefined, 'history');

    offPrefs();
    offPrefs();
    win.dispatch({ key: 'ns:prefs', newValue: '{"v":2}', oldValue: null, storageArea: area });
    expect(onPrefs).toHaveBeenCalledTimes(4);
    expect(onPrefs2).toHaveBeenCalledTimes(5);
    expect(win.removeEventListener).not.toHaveBeenCalled();
    offPrefs2();
    offHistory();
    expect(win.removeEventListener).toHaveBeenCalledTimes(1);
    expect(win.listeners.size).toBe(0);

    // subscribing again re-attaches a fresh listener
    const off = storage.subscribe('prefs', onPrefs);
    expect(win.addEventListener).toHaveBeenCalledTimes(2);
    off();
    expect(win.listeners.size).toBe(0);
  });

  it("relays only the local area's events for the 'local' driver", () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const local = fakeArea();
    const session = fakeArea();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    const storage = createStorage({ driver: 'local' });
    const fn = vi.fn();
    storage.subscribe('prefs', fn);
    win.dispatch({ key: 'wf:prefs', newValue: '{"v":1}', oldValue: null, storageArea: session });
    win.dispatch({ key: null, newValue: null, oldValue: null, storageArea: session });
    expect(fn).not.toHaveBeenCalled();
    win.dispatch({ key: 'wf:prefs', newValue: '{"v":1}', oldValue: null, storageArea: local });
    expect(fn).toHaveBeenCalledWith(1, undefined, 'prefs');
    // an event without storageArea (some polyfills) is accepted
    win.dispatch({ key: 'wf:prefs', newValue: '{"v":2}', oldValue: '{"v":1}' });
    expect(fn).toHaveBeenLastCalledWith(2, 1, 'prefs');
    storage.destroy();
  });

  it('keeps two subscriptions when the same function subscribes twice', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const area = fakeArea();
    const storage = createStorage({ driver: webStorageDriver(area) });
    const fn = vi.fn();
    const off1 = storage.subscribe('k', fn);
    const off2 = storage.subscribe('k', fn);
    const event = { key: 'wf:k', newValue: '{"v":1}', oldValue: null, storageArea: area };
    win.dispatch(event);
    expect(fn).toHaveBeenCalledTimes(2);
    off1();
    off1(); // idempotent: must not remove the second registration
    win.dispatch(event);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(win.listeners.size).toBe(1);
    off2();
    win.dispatch(event);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(win.listeners.size).toBe(0);
  });

  it('releases subscriptions when the driver falls back to memory', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const area = fakeArea();
    const storage = createStorage({ driver: webStorageDriver(area) });
    const fn = vi.fn();
    const off = storage.subscribe('k', fn);
    const event = { key: 'wf:k', newValue: '{"v":1}', oldValue: null, storageArea: area };
    win.dispatch(event);
    expect(fn).toHaveBeenCalledTimes(1);

    area.failSet = true;
    storage.set('x', 1); // quota → memory, which cannot see other tabs
    expect(storage.driverName).toBe('memory');
    expect(win.removeEventListener).toHaveBeenCalledTimes(1);
    expect(win.listeners.size).toBe(0);
    win.dispatch(event);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() => off()).not.toThrow();

    // later subscriptions are inert as well
    const off2 = storage.subscribe('k', fn);
    expect(win.addEventListener).toHaveBeenCalledTimes(1);
    win.dispatch(event);
    expect(fn).toHaveBeenCalledTimes(1);
    off2();
    storage.destroy();
  });

  it('isolates listener exceptions and reports them as error events', () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const events = emitter();
    const area = fakeArea();
    const storage = createStorage({ driver: webStorageDriver(area), events });
    const boom = vi.fn(() => {
      throw new TypeError('listener bug');
    });
    const after = vi.fn();
    storage.subscribe('k', boom);
    storage.subscribe('k', after);
    expect(() =>
      win.dispatch({ key: 'wf:k', newValue: '{"v":1}', oldValue: null, storageArea: area })
    ).not.toThrow();
    expect(after).toHaveBeenCalledWith(1, undefined, 'k');
    expect(events.calls).toHaveLength(1);
    expect(events.calls[0].type).toBe('error');
    expect(events.calls[0].payload.error).toBeInstanceOf(SdkError);
    expect(events.calls[0].payload.error.cause).toBeInstanceOf(TypeError);
    storage.destroy();
  });

  it('destroy() removes every subscription and the window listener, leaving no timers', () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const area = fakeArea();
    const storage = createStorage({ driver: webStorageDriver(area) });
    const fn = vi.fn();
    const off = storage.subscribe('a', fn);
    storage.subscribe('b', fn);
    expect(win.listeners.size).toBe(1);
    storage.destroy();
    expect(win.removeEventListener).toHaveBeenCalledTimes(1);
    expect(win.listeners.size).toBe(0);
    win.dispatch({ key: 'wf:a', newValue: '{"v":1}', oldValue: null, storageArea: area });
    expect(fn).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
    expect(win.removeEventListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // storage still works for data after destroy(), and subscribing again works too
    storage.set('a', 1);
    expect(storage.get('a')).toBe(1);
    const again = storage.subscribe('a', fn);
    expect(win.listeners.size).toBe(1);
    win.dispatch({ key: 'wf:a', newValue: '{"v":2}', oldValue: null, storageArea: area });
    expect(fn).toHaveBeenCalledWith(2, undefined, 'a');
    off(); // the stale off() from before destroy() must not touch the new registration
    win.dispatch({ key: 'wf:a', newValue: '{"v":3}', oldValue: null, storageArea: area });
    expect(fn).toHaveBeenCalledTimes(2);
    again();
    expect(win.listeners.size).toBe(0);
    expect(() => storage.destroy()).not.toThrow();
  });
});
