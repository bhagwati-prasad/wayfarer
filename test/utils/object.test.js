import { describe, it, expect } from 'vitest';
import {
  deepMerge,
  deepFreeze,
  deepEqual,
  shallowEqual,
  pick,
  omit,
  get,
  set,
  stableStringify,
  hash,
  clone,
  isPlainObject,
  compact,
  groupBy,
  uniqBy,
  sortBy,
  chunk,
  range,
} from '../../src/utils/object.js';
import { ValidationError } from '../../src/errors/index.js';

describe('isPlainObject', () => {
  it('accepts literals, Object.create(null) and new Object()', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Object())).toBe(true);
  });

  it('rejects arrays, class instances, functions, null and primitives', () => {
    class Foo {}
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Foo())).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(() => {})).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(1)).toBe(false);
  });
});

describe('deepMerge', () => {
  it('merges nested plain objects left to right, later sources winning', () => {
    const out = deepMerge(
      { a: 1, nested: { x: 1, y: 1, deep: { k: 'a' } } },
      { b: 2, nested: { y: 2, deep: { l: 'b' } } },
      { a: 3 }
    );
    expect(out).toEqual({ a: 3, b: 2, nested: { x: 1, y: 2, deep: { k: 'a', l: 'b' } } });
  });

  it('replaces arrays instead of merging them', () => {
    const out = deepMerge({ list: [1, 2, 3], o: { list: ['a'] } }, { list: [9], o: { list: [] } });
    expect(out).toEqual({ list: [9], o: { list: [] } });
  });

  it('replaces non-plain values (Dates, class instances, null) wholesale', () => {
    const d = new Date(0);
    const out = deepMerge({ a: { x: 1 }, b: 1 }, { a: d, b: null });
    expect(out.a).toBe(d);
    expect(out.b).toBeNull();
    const back = deepMerge({ a: d }, { a: { y: 2 } });
    expect(back).toEqual({ a: { y: 2 } });
  });

  it('ignores undefined values and non-object sources', () => {
    expect(
      deepMerge({ a: 1, b: { c: 1 } }, { a: undefined, b: undefined }, null, 5, 'x', [1])
    ).toEqual({ a: 1, b: { c: 1 } });
    expect(deepMerge()).toEqual({});
    expect(deepMerge(undefined, null)).toEqual({});
  });

  it('never mutates inputs and never aliases nested containers', () => {
    const a = { nested: { x: 1 }, list: [1] };
    const b = { nested: { y: 2 }, list: [2] };
    const out = deepMerge(a, b);
    expect(a).toEqual({ nested: { x: 1 }, list: [1] });
    expect(b).toEqual({ nested: { y: 2 }, list: [2] });
    expect(out.nested).not.toBe(a.nested);
    expect(out.nested).not.toBe(b.nested);
    expect(out.list).not.toBe(b.list);
    out.nested.x = 99;
    out.list.push(3);
    expect(a.nested.x).toBe(1);
    expect(b.list).toEqual([2]);
    const single = deepMerge(a);
    expect(single).toEqual(a);
    expect(single.nested).not.toBe(a.nested);
  });

  it('is not prototype-pollutable through __proto__, constructor or prototype keys', () => {
    const evil = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":1}},"prototype":{"p3":1}}'
    );
    const out = deepMerge({}, evil, { ok: 1 });
    expect(out).toEqual({ ok: 1 });
    expect(Object.keys(out)).toEqual(['ok']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
    expect({}.p2).toBeUndefined();
    expect(Object.prototype.p3).toBeUndefined();
    const nested = deepMerge({ cfg: {} }, JSON.parse('{"cfg":{"__proto__":{"polluted":true}}}'));
    expect(nested).toEqual({ cfg: {} });
    expect({}.polluted).toBeUndefined();
  });

  it('accepts null-prototype sources', () => {
    const src = Object.create(null);
    src.a = 1;
    expect(deepMerge({ b: 2 }, src)).toEqual({ a: 1, b: 2 });
  });
});

describe('deepFreeze', () => {
  it('freezes nested plain objects and arrays and returns the same reference', () => {
    const o = { a: { b: [1, { c: 2 }] } };
    const out = deepFreeze(o);
    expect(out).toBe(o);
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.a)).toBe(true);
    expect(Object.isFrozen(o.a.b)).toBe(true);
    expect(Object.isFrozen(o.a.b[1])).toBe(true);
  });

  it('leaves class instances alone and survives cycles and primitives', () => {
    const d = new Date(0);
    const o = { d };
    o.self = o;
    deepFreeze(o);
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(d)).toBe(false);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBeNull();
  });
});

describe('clone', () => {
  it('deep copies plain data, Dates, RegExps, Maps, Sets and typed arrays', () => {
    const src = {
      a: [1, { b: 2 }],
      d: new Date(1000),
      r: /x/gi,
      m: new Map([['k', { v: 1 }]]),
      s: new Set([{ v: 1 }]),
      t: new Uint8Array([1, 2]),
      n: null,
    };
    const out = clone(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.a).not.toBe(src.a);
    expect(out.a[1]).not.toBe(src.a[1]);
    expect(out.d).not.toBe(src.d);
    expect(out.r).not.toBe(src.r);
    expect(out.m).not.toBe(src.m);
    expect(out.m.get('k')).not.toBe(src.m.get('k'));
    expect(out.s).not.toBe(src.s);
    expect(out.t).not.toBe(src.t);
    expect(out.t).toEqual(new Uint8Array([1, 2]));
  });

  it('returns primitives, functions and class instances by reference', () => {
    class Foo {}
    const f = new Foo();
    const fn = () => 1;
    expect(clone(f)).toBe(f);
    expect(clone(fn)).toBe(fn);
    expect(clone(3)).toBe(3);
    expect(clone('s')).toBe('s');
    expect(clone(undefined)).toBeUndefined();
  });

  it('handles cycles and keeps null prototypes', () => {
    const o = { name: 'x' };
    o.self = o;
    const out = clone(o);
    expect(out.self).toBe(out);
    expect(out).not.toBe(o);
    const np = Object.create(null);
    np.a = 1;
    const npc = clone(np);
    expect(Object.getPrototypeOf(npc)).toBeNull();
    expect(npc.a).toBe(1);
  });
});

describe('deepEqual', () => {
  it('compares primitives with NaN equal to itself', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(0, -0)).toBe(true);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('compares nested structures by content regardless of key order', () => {
    expect(deepEqual({ a: [1, { b: 2 }], c: 'x' }, { c: 'x', a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('understands Dates, RegExps, Maps, Sets and typed arrays', () => {
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepEqual(/a/g, /a/g)).toBe(true);
    expect(deepEqual(/a/g, /a/i)).toBe(false);
    expect(deepEqual(new Map([['a', { x: 1 }]]), new Map([['a', { x: 1 }]]))).toBe(true);
    expect(deepEqual(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(false);
    expect(deepEqual(new Set([{ x: 1 }, 2]), new Set([2, { x: 1 }]))).toBe(true);
    expect(deepEqual(new Set([1]), new Set([2]))).toBe(false);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(deepEqual(new Uint8Array([1]).buffer, new Uint8Array([1]).buffer)).toBe(true);
  });

  it('treats different prototypes as unequal but {} and null-proto as plain', () => {
    class Foo {
      constructor() {
        this.a = 1;
      }
    }
    expect(deepEqual(new Foo(), { a: 1 })).toBe(false);
    expect(deepEqual(new Foo(), new Foo())).toBe(true);
    const np = Object.create(null);
    np.a = 1;
    expect(deepEqual(np, { a: 1 })).toBe(true);
  });

  it('survives cycles', () => {
    const a = { v: 1 };
    a.self = a;
    const b = { v: 1 };
    b.self = b;
    expect(deepEqual(a, b)).toBe(true);
    const c = { v: 2 };
    c.self = c;
    expect(deepEqual(a, c)).toBe(false);
  });
});

describe('shallowEqual', () => {
  it('compares one level only', () => {
    const inner = { x: 1 };
    expect(shallowEqual({ a: 1, b: inner }, { b: inner, a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 1 } })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1, 2], [1, 3])).toBe(false);
    expect(shallowEqual([1], { 0: 1 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: NaN }, { a: NaN })).toBe(true);
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual(1, 1)).toBe(true);
  });
});

describe('pick / omit', () => {
  const src = { a: 1, b: 2, c: undefined };

  it('pick keeps only listed own keys that exist, in list order', () => {
    expect(pick(src, ['b', 'a', 'zzz'])).toEqual({ b: 2, a: 1 });
    expect(Object.keys(pick(src, ['b', 'a']))).toEqual(['b', 'a']);
    expect(pick(src, 'a')).toEqual({ a: 1 });
    expect(pick(src, ['c'])).toEqual({ c: undefined });
    expect(Object.keys(pick(src, ['c']))).toEqual(['c']);
    expect(pick(null, ['a'])).toEqual({});
    expect(pick(src, ['toString'])).toEqual({});
  });

  it('omit drops listed keys and copies the rest', () => {
    const out = omit(src, ['b']);
    expect(out).toEqual({ a: 1, c: undefined });
    expect(Object.keys(out)).toEqual(['a', 'c']);
    expect(omit(src, 'a')).toEqual({ b: 2, c: undefined });
    expect(omit(src, [])).toEqual(src);
    expect(omit(src, [])).not.toBe(src);
    expect(omit(undefined, ['a'])).toEqual({});
  });

  it('never trips over a __proto__ key', () => {
    const weird = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    const picked = pick(weird, ['__proto__']);
    expect(Object.hasOwn(picked, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(picked)).toBe(Object.prototype);
    const omitted = omit(weird, ['a']);
    expect(Object.hasOwn(omitted, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(omitted)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
  });
});

describe('get', () => {
  const o = { a: { b: [{ c: 1 }, { c: 2 }], 'odd key': 'k' }, zero: 0, nil: null };

  it('reads dotted, bracketed and array paths', () => {
    expect(get(o, 'a.b[1].c')).toBe(2);
    expect(get(o, 'a.b.0.c')).toBe(1);
    expect(get(o, ['a', 'b', 0, 'c'])).toBe(1);
    expect(get(o, "a['odd key']")).toBe('k');
    expect(get(o, 'a["odd key"]')).toBe('k');
    expect(get(o, 'zero')).toBe(0);
    expect(get(o, 'nil')).toBeNull();
    expect(get([10, 20], 1)).toBe(20);
    expect(get(o, '')).toBe(o);
    expect(get(o, undefined)).toBe(o);
  });

  it('returns the default for missing segments or undefined values', () => {
    expect(get(o, 'a.x.y')).toBeUndefined();
    expect(get(o, 'a.x.y', 'dflt')).toBe('dflt');
    expect(get(o, 'nil.x', 'dflt')).toBe('dflt');
    expect(get(null, 'a', 'dflt')).toBe('dflt');
    expect(get(undefined, 'a')).toBeUndefined();
    expect(get({ a: undefined }, 'a', 'dflt')).toBe('dflt');
    expect(get({ a: null }, 'a', 'dflt')).toBeNull();
  });

  it('does not walk __proto__', () => {
    expect(get({}, '__proto__')).toBeUndefined();
    expect(get({}, '__proto__.polluted', 'dflt')).toBe('dflt');
  });
});

describe('set', () => {
  it('returns a new object with the value set and leaves the input untouched', () => {
    const o = { a: { b: 1, keep: { k: 1 } }, list: [1, 2] };
    const out = set(o, 'a.b', 2);
    expect(out).toEqual({ a: { b: 2, keep: { k: 1 } }, list: [1, 2] });
    expect(o.a.b).toBe(1);
    expect(out).not.toBe(o);
    expect(out.a).not.toBe(o.a);
    expect(out.a.keep).toBe(o.a.keep);
    expect(out.list).toBe(o.list);
  });

  it('copies arrays along the path and creates missing containers by segment type', () => {
    const o = { list: [{ v: 1 }, { v: 2 }] };
    const out = set(o, 'list[1].v', 9);
    expect(out.list).toEqual([{ v: 1 }, { v: 9 }]);
    expect(out.list).not.toBe(o.list);
    expect(out.list[0]).toBe(o.list[0]);
    expect(o.list[1].v).toBe(2);
    expect(set({}, 'a.b[0].c', 1)).toEqual({ a: { b: [{ c: 1 }] } });
    expect(set({}, ['x', 2], 'v')).toEqual({ x: [undefined, undefined, 'v'] });
    expect(set(undefined, 'a', 1)).toEqual({ a: 1 });
    expect(set(null, '0', 1)).toEqual([1]);
    expect(set({ a: 'str' }, 'a.b', 1)).toEqual({ a: { b: 1 } });
  });

  it('rejects empty and unsafe paths with ValidationError', () => {
    expect(() => set({}, '', 1)).toThrow(ValidationError);
    expect(() => set({}, [], 1)).toThrow(ValidationError);
    for (const bad of ['__proto__.polluted', 'a.constructor.prototype.polluted', 'prototype.x']) {
      let err;
      try {
        set({}, bad, true);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.issues[0]).toMatchObject({ path: 'path', code: 'unsafe_key' });
    }
    expect({}.polluted).toBeUndefined();
  });
});

describe('compact', () => {
  it('drops undefined, null and empty-string values but keeps 0 and false', () => {
    expect(compact({ a: 1, b: undefined, c: null, d: '', e: 0, f: false, g: [] })).toEqual({
      a: 1,
      e: 0,
      f: false,
      g: [],
    });
  });

  it('filters arrays, is shallow and returns {} for non-objects', () => {
    expect(compact([1, null, '', undefined, 0, false])).toEqual([1, 0, false]);
    expect(compact({ nested: { a: null } })).toEqual({ nested: { a: null } });
    expect(compact(null)).toEqual({});
    expect(compact(undefined)).toEqual({});
    expect(compact(5)).toEqual({});
    const src = { a: 1 };
    expect(compact(src)).not.toBe(src);
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}'
    );
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });

  it('matches JSON.stringify semantics for scalars, undefined, toJSON and non-finite numbers', () => {
    expect(stableStringify('s"q')).toBe('"s\\"q"');
    expect(stableStringify(1.5)).toBe('1.5');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify({ a: undefined, b: () => 1, c: Symbol('s'), d: 1 })).toBe('{"d":1}');
    expect(stableStringify([undefined, () => 1, NaN, Infinity])).toBe('[null,null,null,null]');
    expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(stableStringify({ toJSON: () => ({ z: 1, a: 2 }) })).toBe('{"a":2,"z":1}');
    expect(stableStringify(new Map([['a', 1]]))).toBe('{}');
  });

  it('always returns a string and serialises bigints as decimal strings', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(() => 1)).toBe('null');
    expect(stableStringify({ n: 10n })).toBe('{"n":"10"}');
  });

  it('throws ValidationError on cycles', () => {
    const o = { a: { b: 1 } };
    o.a.self = o;
    let err;
    try {
      stableStringify(o);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues[0]).toMatchObject({ code: 'circular', path: '$.a.self' });
    const shared = { x: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('hash', () => {
  it('is deterministic and returns a short base36 string', () => {
    const h = hash('hello world');
    expect(h).toBe(hash('hello world'));
    expect(h).toMatch(/^[0-9a-z]{1,11}$/);
    expect(hash('')).toMatch(/^[0-9a-z]{1,11}$/);
    expect(hash('a'.repeat(5000))).toMatch(/^[0-9a-z]{1,11}$/);
  });

  it('differs for different inputs (including order and unicode)', () => {
    expect(hash('ab')).not.toBe(hash('ba'));
    expect(hash('a')).not.toBe(hash('b'));
    expect(hash('')).not.toBe(hash(' '));
    expect(hash('déjà vu')).not.toBe(hash('deja vu'));
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(hash(`key-${i}`));
    expect(seen.size).toBe(2000);
  });

  it('stable-stringifies non-string input', () => {
    expect(hash({ b: 1, a: 2 })).toBe(hash('{"a":2,"b":1}'));
    expect(hash(123)).toBe(hash('123'));
  });
});

describe('groupBy / uniqBy', () => {
  const list = [
    { id: 1, airline: 'AI', price: { amount: 10 } },
    { id: 2, airline: '6E', price: { amount: 5 } },
    { id: 3, airline: 'AI', price: { amount: 7 } },
  ];

  it('groupBy accepts a function or a path and preserves order', () => {
    expect(groupBy(list, (x) => x.airline)).toEqual({
      AI: [list[0], list[2]],
      '6E': [list[1]],
    });
    expect(groupBy(list, 'airline')).toEqual(groupBy(list, (x) => x.airline));
    expect(Object.keys(groupBy(list, 'airline'))).toEqual(['AI', '6E']);
    expect(groupBy(list, 'price.amount')).toEqual({ 10: [list[0]], 5: [list[1]], 7: [list[2]] });
    expect(groupBy([], 'x')).toEqual({});
    expect(groupBy(null, 'x')).toEqual({});
    expect(groupBy(new Set([1, 2, 3]), (n) => n % 2)).toEqual({ 1: [1, 3], 0: [2] });
    expect(groupBy([{ a: undefined }], 'a')).toEqual({ undefined: [{ a: undefined }] });
  });

  it('groupBy keeps a __proto__ group as an own key', () => {
    const out = groupBy([{ k: '__proto__' }, { k: 'x' }], 'k');
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.x).toHaveLength(1);
  });

  it('uniqBy keeps the first occurrence by key', () => {
    expect(uniqBy(list, 'airline')).toEqual([list[0], list[1]]);
    expect(uniqBy(list, (x) => x.price.amount > 6)).toEqual([list[0], list[1]]);
    expect(uniqBy([1, 1, 2, NaN, NaN, 3])).toEqual([1, 2, NaN, 3]);
    expect(uniqBy([], 'x')).toEqual([]);
    expect(uniqBy(undefined, 'x')).toEqual([]);
    const input = [1, 2];
    expect(uniqBy(input)).not.toBe(input);
  });
});

describe('sortBy', () => {
  const list = [
    { n: 'c', p: 3, nested: { v: 'z' } },
    { n: 'a', p: 1, nested: { v: 'y' } },
    { n: 'b', p: 3, nested: { v: 'x' } },
    { n: 'd', p: null, nested: {} },
  ];

  it('sorts by path, nested path, descending prefix and functions, with ties falling through', () => {
    expect(sortBy(list, 'p', 'n').map((x) => x.n)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortBy(list, '-p', 'n').map((x) => x.n)).toEqual(['b', 'c', 'a', 'd']);
    expect(sortBy(list, 'nested.v').map((x) => x.n)).toEqual(['b', 'a', 'c', 'd']);
    // -null is -0, a real number, so d sorts by value here rather than as missing.
    expect(sortBy(list, (x) => -x.p, 'n').map((x) => x.n)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('is stable, non-mutating and sorts primitives by value without keys', () => {
    const out = sortBy(list, 'p');
    expect(out.map((x) => x.n)).toEqual(['a', 'c', 'b', 'd']);
    expect(list[0].n).toBe('c');
    expect(out).not.toBe(list);
    expect(sortBy([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sortBy(['b', 'a'])).toEqual(['a', 'b']);
    // Array.prototype.sort always moves undefined elements last without calling the comparator.
    expect(sortBy([2, undefined, 1, NaN])).toEqual([1, 2, NaN, undefined]);
    expect(sortBy([{ v: 2 }, { v: null }, { v: 1 }, { v: NaN }], 'v').map((x) => x.v)).toEqual([
      1,
      2,
      null,
      NaN,
    ]);
    expect(sortBy(null, 'x')).toEqual([]);
  });
});

describe('chunk / range', () => {
  it('chunk splits into consecutive groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk(null, 2)).toEqual([]);
    expect(chunk(new Set([1, 2, 3]), 1)).toEqual([[1], [2], [3]]);
  });

  it('chunk rejects a non-positive or non-integer size with ValidationError', () => {
    for (const n of [0, -1, 1.5, NaN, Infinity, '2', undefined]) {
      let err;
      try {
        chunk([1], n);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.issues[0]).toMatchObject({ path: 'n', code: 'min' });
    }
  });

  it('range counts up, from a start, or down', () => {
    expect(range(3)).toEqual([0, 1, 2]);
    expect(range(0)).toEqual([]);
    expect(range(2, 5)).toEqual([2, 3, 4]);
    expect(range(5, 5)).toEqual([]);
    expect(range(3, 0)).toEqual([3, 2, 1]);
    expect(range(-2, 1)).toEqual([-2, -1, 0]);
  });

  it('range rejects non-finite bounds with ValidationError', () => {
    expect(() => range(NaN)).toThrow(ValidationError);
    expect(() => range(0, Infinity)).toThrow(ValidationError);
    expect(() => range('3')).toThrow(ValidationError);
  });
});
