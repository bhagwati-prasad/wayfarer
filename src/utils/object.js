/**
 * Pure object / collection helpers for the Wayfarer SDK (docs/api/03-utils.md §6): deep merge /
 * freeze / equal / clone, path `get` / immutable `set`, `pick` / `omit` / `compact`, a key‑sorted
 * `stableStringify` plus a fast non‑cryptographic `hash`, and small list utilities (`groupBy`,
 * `uniqBy`, `sortBy`, `chunk`, `range`). Everything here is side‑effect free and SSR‑safe: no I/O, no
 * DOM, no timers, no module‑level mutable state, no logging. Inputs are never mutated (`deepFreeze`
 * freezes in place by design, but adds nothing). `deepMerge` replaces arrays instead of merging them
 * and must never be prototype‑pollutable: `__proto__`, `constructor` and `prototype` keys are skipped
 * on merge and rejected on `set`. Plain `Error`s are never thrown — only `ValidationError`.
 */

import { ValidationError } from '../errors/index.js';

/** Keys that must never be written through from untrusted data (prototype‑pollution vectors). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Define `key` on `target` as a plain own data property, even for `"__proto__"`. */
function setOwn(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** Normalise any list‑ish input (array, iterable, nullish) to an array without copying arrays. */
function toArray(list) {
  if (Array.isArray(list)) return list;
  if (list == null) return [];
  if (typeof list === 'string') return [list];
  return typeof list[Symbol.iterator] === 'function' ? Array.from(list) : [];
}

/**
 * Parse a path (`'a.b[0].c'`, `'a[b]'`, `['a', 0]`) into string segments.
 * @param {string|number|Array<string|number>|undefined|null} path
 * @returns {string[]}
 */
function toPath(path) {
  if (Array.isArray(path)) return path.map(String);
  if (typeof path === 'number') return [String(path)];
  if (typeof path !== 'string' || path === '') return [];
  return path
    .replace(/\[(?:["']([^\]"']*)["']|([^\]]*))\]/g, (_m, quoted, bare) => `.${quoted ?? bare}`)
    .split('.')
    .filter((s) => s !== '');
}

/**
 * Turn a `keyFn` argument (function, property path or nothing) into an accessor.
 * @template T
 * @param {((item: T) => unknown)|string|number|Array<string|number>|undefined} keyFn
 * @returns {(item: T) => unknown}
 */
function iteratee(keyFn) {
  if (typeof keyFn === 'function') return keyFn;
  if (typeof keyFn === 'string' || typeof keyFn === 'number' || Array.isArray(keyFn)) {
    return (item) => get(item, keyFn);
  }
  return (item) => item;
}

/** `===` with NaN equal to itself (SameValueZero). */
const sameValueZero = (a, b) => a === b || (a !== a && b !== b);

/**
 * Build a `ValidationError` with a single issue.
 * @param {string} message @param {string} path @param {string} code @param {object} [params]
 */
function invalid(message, path, code, params) {
  /** @type {import('../types.js').ValidationIssue} */
  const issue = { path, code, message };
  if (params) issue.params = params;
  return new ValidationError(message, { issues: [issue] });
}

// ── predicates ──────────────────────────────────────────────────────────────────────────────────

/**
 * True for objects created by `{}` / `new Object()` / `Object.create(null)` (also across realms);
 * false for arrays, class instances, functions, `null` and primitives.
 * @param {unknown} o
 * @returns {o is Record<string, unknown>}
 */
export function isPlainObject(o) {
  if (o === null || typeof o !== 'object') return false;
  if (Object.prototype.toString.call(o) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(o);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

// ── merge / freeze / clone ──────────────────────────────────────────────────────────────────────

/**
 * Recursively merge plain objects left‑to‑right into a fresh object. Later sources win; nested plain
 * objects are merged, arrays and every other value are **replaced** (arrays are shallow‑copied);
 * `undefined` source values do not override; non‑plain sources (null, arrays, class instances) are
 * ignored. `__proto__`, `constructor` and `prototype` keys are never copied, so merging untrusted
 * JSON cannot pollute prototypes. Inputs are never mutated.
 * @param {...unknown} objs
 * @returns {Record<string, unknown>}
 */
export function deepMerge(...objs) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const src of objs) {
    if (isPlainObject(src)) mergeInto(out, src);
  }
  return out;
}

/**
 * Merge `source` into `target`, which is always an object owned by the current `deepMerge` call.
 * @param {Record<string, unknown>} target @param {Record<string, unknown>} source
 */
function mergeInto(target, source) {
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const sv = source[key];
    if (sv === undefined) continue;
    if (isPlainObject(sv)) {
      const tv = target[key];
      const nested = isPlainObject(tv) ? /** @type {Record<string, unknown>} */ (tv) : {};
      mergeInto(nested, sv);
      target[key] = nested;
    } else if (Array.isArray(sv)) {
      target[key] = sv.slice();
    } else {
      target[key] = sv;
    }
  }
  return target;
}

/**
 * Recursively `Object.freeze` an object and every nested plain object / array (cycle‑safe). Class
 * instances, Dates, Maps and the like are left as they are. Returns the same reference.
 * @template T
 * @param {T} o
 * @returns {Readonly<T>}
 */
export function deepFreeze(o) {
  freezeDeep(o, new WeakSet());
  return o;
}

function freezeDeep(value, seen) {
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && 'value' in desc) freezeDeep(desc.value, seen);
  }
}

/**
 * Deep copy of plain data: plain objects, arrays, Dates, RegExps, Maps, Sets and typed arrays are
 * copied (cycle‑safe); functions, class instances and primitives are returned as they are.
 * @template T
 * @param {T} o
 * @returns {T}
 */
export function clone(o) {
  return cloneDeep(o, new WeakMap());
}

function cloneDeep(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) out[i] = cloneDeep(value[i], seen);
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(k, cloneDeep(v, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(cloneDeep(v, seen));
    return out;
  }
  if (ArrayBuffer.isView(value) && typeof value.slice === 'function') return value.slice();
  if (isPlainObject(value)) {
    const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    seen.set(value, out);
    for (const key of Object.keys(value)) setOwn(out, key, cloneDeep(value[key], seen));
    return out;
  }
  return value;
}

// ── equality ────────────────────────────────────────────────────────────────────────────────────

/**
 * Structural equality: primitives by `===` (NaN equals NaN), arrays, plain objects, Dates, RegExps,
 * Maps, Sets and typed arrays by content (cycle‑safe). Objects with different prototypes are never
 * equal, except that `{}` and `Object.create(null)` both count as plain.
 * @param {unknown} a @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  return eq(a, b, new Map());
}

function eq(a, b, seen) {
  if (sameValueZero(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (seen.get(a) === b) return true;
  const plainA = isPlainObject(a);
  const plainB = isPlainObject(b);
  if (plainA !== plainB) return false;
  if (!plainA && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  seen.set(a, b);

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i], seen)) return false;
    return true;
  }
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp)
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !eq(v, b.get(k), seen)) return false;
    return true;
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    const rest = [...b];
    outer: for (const v of a) {
      if (b.has(v)) continue;
      for (let i = 0; i < rest.length; i++) {
        if (eq(v, rest[i], seen)) {
          rest.splice(i, 1);
          continue outer;
        }
      }
      return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
    const va = a instanceof ArrayBuffer ? new Uint8Array(a) : a;
    const vb = b instanceof ArrayBuffer ? new Uint8Array(b) : b;
    if (!ArrayBuffer.isView(vb) || va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (!sameValueZero(va[i], vb[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!hasOwn(b, k) || !eq(a[k], b[k], seen)) return false;
  return true;
}

/**
 * One‑level equality: same own enumerable keys and `===` values (NaN equals NaN). Works for arrays
 * and objects; anything else compares by identity.
 * @param {unknown} a @param {unknown} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (sameValueZero(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!hasOwn(b, k) || !sameValueZero(a[k], b[k])) return false;
  return true;
}

// ── keys / paths ────────────────────────────────────────────────────────────────────────────────

/**
 * New object with only the listed own keys that exist on `o` (in the order of `keys`).
 * @template {object} T
 * @template {keyof T & string} K
 * @param {T|null|undefined} o
 * @param {K[]|K} keys
 * @returns {Pick<T, K>}
 */
export function pick(o, keys) {
  const out = {};
  if (o === null || o === undefined) return /** @type {Pick<T, K>} */ (out);
  for (const key of toArray(keys)) {
    const k = String(key);
    if (hasOwn(o, k)) setOwn(out, k, o[k]);
  }
  return /** @type {Pick<T, K>} */ (out);
}

/**
 * New object with every own enumerable key of `o` except the listed ones.
 * @template {object} T
 * @template {keyof T & string} K
 * @param {T|null|undefined} o
 * @param {K[]|K} keys
 * @returns {Omit<T, K>}
 */
export function omit(o, keys) {
  const out = {};
  if (o === null || o === undefined) return /** @type {Omit<T, K>} */ (out);
  const drop = new Set(toArray(keys).map(String));
  for (const k of Object.keys(o)) {
    if (!drop.has(k)) setOwn(out, k, o[k]);
  }
  return /** @type {Omit<T, K>} */ (out);
}

/**
 * Read a nested value by path (`'offers.byId[abc].price'`, `['offers', 'byId', id]`). Returns
 * `defaultValue` when any segment is missing or the resolved value is `undefined`. `__proto__`
 * segments resolve to the default rather than walking up the prototype chain.
 * @param {unknown} o
 * @param {string|number|Array<string|number>} path
 * @param {unknown} [defaultValue]
 * @returns {any}
 */
export function get(o, path, defaultValue) {
  let cur = o;
  for (const seg of toPath(path)) {
    if (cur === null || cur === undefined || seg === '__proto__') return defaultValue;
    cur = cur[seg];
  }
  return cur === undefined ? defaultValue : cur;
}

/**
 * Immutable set: returns a copy of `o` with `value` at `path`, copying only the containers along the
 * path (structural sharing elsewhere). Missing containers are created — arrays when the next segment
 * is a non‑negative integer, plain objects otherwise. `o` itself is never mutated.
 * @template T
 * @param {T} o
 * @param {string|number|Array<string|number>} path
 * @param {unknown} value
 * @returns {T extends object ? T : Record<string, unknown>}
 * @throws {ValidationError} on an empty path or a `__proto__` / `constructor` / `prototype` segment
 */
export function set(o, path, value) {
  const segs = toPath(path);
  if (segs.length === 0) throw invalid('set() requires a non-empty path', 'path', 'required');
  for (const seg of segs) {
    if (UNSAFE_KEYS.has(seg)) {
      throw invalid(`set() refuses unsafe path segment "${seg}"`, 'path', 'unsafe_key', {
        key: seg,
      });
    }
  }
  return setAt(o, segs, 0, value);
}

function setAt(node, segs, i, value) {
  const key = segs[i];
  let copy;
  if (Array.isArray(node)) copy = node.slice();
  else if (isPlainObject(node)) copy = { ...node };
  else copy = /^\d+$/.test(key) ? [] : {};
  const next = i === segs.length - 1 ? value : setAt(copy[key], segs, i + 1, value);
  copy[Array.isArray(copy) && /^\d+$/.test(key) ? Number(key) : key] = next;
  return copy;
}

/**
 * Shallow copy without empty values: for plain objects drops keys whose value is `undefined`,
 * `null` or `''`; for arrays drops such elements. Anything else yields `{}`.
 * @template T
 * @param {T} o
 * @returns {T}
 */
export function compact(o) {
  const empty = (v) => v === undefined || v === null || v === '';
  if (Array.isArray(o)) return /** @type {T} */ (o.filter((v) => !empty(v)));
  const out = {};
  if (o === null || typeof o !== 'object') return /** @type {T} */ (out);
  for (const k of Object.keys(o)) {
    if (!empty(o[k])) setOwn(out, k, o[k]);
  }
  return /** @type {T} */ (out);
}

// ── serialisation / hashing ─────────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON: like `JSON.stringify` (honours `toJSON`, drops `undefined` / function values
 * in objects, turns them into `null` in arrays, non‑finite numbers become `null`) but object keys
 * are sorted recursively, so equal data always yields the same string. BigInts serialise as decimal
 * strings; a top‑level `undefined` serialises as `'null'` so the result is always a string.
 * @param {unknown} o
 * @returns {string}
 * @throws {ValidationError} when the value contains a cycle
 */
export function stableStringify(o) {
  const out = serialize(o, new Set(), '$');
  return out === undefined ? 'null' : out;
}

/** @returns {string|undefined} */
function serialize(value, stack, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (typeof value.toJSON === 'function') return serialize(value.toJSON(), stack, path);
  if (stack.has(value)) {
    throw invalid('stableStringify() cannot serialise a circular structure', path, 'circular');
  }
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    const parts = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      parts[i] = serialize(value[i], stack, `${path}[${i}]`) ?? 'null';
    }
    result = `[${parts.join(',')}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const s = serialize(value[key], stack, `${path}.${key}`);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }
    result = `{${parts.join(',')}}`;
  }
  stack.delete(value);
  return result;
}

/**
 * Fast, non‑cryptographic 53‑bit string hash (cyrb53: FNV‑style xor/multiply mixing over UTF‑16
 * code units) rendered as a short base36 string (≤ 11 chars). Deterministic across runs and
 * engines. Non‑string input is first passed through `stableStringify`. Not for security purposes.
 * @param {string} str
 * @returns {string}
 */
export function hash(str) {
  const s = typeof str === 'string' ? str : stableStringify(str);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ── lists ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Group items by the string form of `keyFn(item)` (a function or a property path), keeping order.
 * @template T
 * @param {Iterable<T>|null|undefined} list
 * @param {((item: T) => unknown)|string} keyFn
 * @returns {Record<string, T[]>}
 */
export function groupBy(list, keyFn) {
  const fn = iteratee(keyFn);
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of toArray(list)) {
    const key = String(fn(item));
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return Object.fromEntries(groups);
}

/**
 * Items whose `keyFn(item)` (a function or a property path) has not been seen before; the first
 * occurrence wins and order is kept. Keys compare by SameValueZero.
 * @template T
 * @param {Iterable<T>|null|undefined} list
 * @param {((item: T) => unknown)|string} [keyFn]
 * @returns {T[]}
 */
export function uniqBy(list, keyFn) {
  const fn = iteratee(keyFn);
  const seen = new Set();
  const out = [];
  for (const item of toArray(list)) {
    const key = fn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Stable sort into a new array by one or more keys: property paths (`'price.amount'`, prefix `-` for
 * descending), or accessor functions. Ties fall through to the next key; `null` / `undefined` / NaN
 * sort last whatever the direction. With no keys, items sort by their own value.
 * @template T
 * @param {Iterable<T>|null|undefined} list
 * @param {...(string|((item: T) => unknown))} keys
 * @returns {T[]}
 */
export function sortBy(list, ...keys) {
  const comparators = (keys.length ? keys : [undefined]).map((k) => {
    if (typeof k === 'string' && k.startsWith('-')) {
      const path = k.slice(1);
      return { fn: (item) => get(item, path), desc: true };
    }
    return { fn: iteratee(k), desc: false };
  });
  return toArray(list)
    .slice()
    .sort((a, b) => {
      for (const { fn, desc } of comparators) {
        const c = compareValues(fn(a), fn(b), desc);
        if (c !== 0) return c;
      }
      return 0;
    });
}

const isMissing = (v) => v === undefined || v === null || (typeof v === 'number' && v !== v);

function compareValues(x, y, desc) {
  const mx = isMissing(x);
  const my = isMissing(y);
  if (mx || my) return mx && my ? 0 : mx ? 1 : -1;
  if (x < y) return desc ? 1 : -1;
  if (x > y) return desc ? -1 : 1;
  return 0;
}

/**
 * Split a list into consecutive chunks of `n` items (the last may be shorter).
 * @template T
 * @param {Iterable<T>|null|undefined} list
 * @param {number} n
 * @returns {T[][]}
 * @throws {ValidationError} when `n` is not a positive integer
 */
export function chunk(list, n) {
  if (!Number.isInteger(n) || n < 1) {
    throw invalid('chunk() size must be a positive integer', 'n', 'min', { min: 1 });
  }
  const arr = toArray(list);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Integers from `a` up to but excluding `b` (`range(3)` → `[0, 1, 2]`, `range(2, 5)` → `[2, 3, 4]`);
 * counts down when `a > b` (`range(3, 0)` → `[3, 2, 1]`).
 * @param {number} a
 * @param {number} [b]
 * @returns {number[]}
 * @throws {ValidationError} when a bound is not a finite number
 */
export function range(a, b) {
  const start = b === undefined ? 0 : a;
  const end = b === undefined ? a : b;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw invalid('range() bounds must be finite numbers', b === undefined ? 'a' : 'b', 'invalid');
  }
  const step = start <= end ? 1 : -1;
  const out = [];
  for (let v = start; step > 0 ? v < end : v > end; v += step) out.push(v);
  return out;
}
