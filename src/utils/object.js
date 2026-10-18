/**
 * Pure object / collection helpers for the Wayfarer SDK (docs/api/03-utils.md §6): deep merge /
 * freeze / equal / clone, path `get` / immutable `set`, `pick` / `omit` / `compact`, a key‑sorted
 * `stableStringify` plus a fast non‑cryptographic `hash`, and small list utilities (`groupBy`,
 * `uniqBy`, `sortBy`, `chunk`, `range`). Everything here is side‑effect free and SSR‑safe: no I/O, no
 * DOM, no timers, no module‑level mutable state, no logging. Inputs are never mutated (`deepFreeze`
 * freezes in place by design, but adds nothing). `deepMerge` replaces arrays instead of merging them
 * and must never be prototype‑pollutable: `__proto__`, `constructor` and `prototype` keys are skipped
 * on merge and rejected on `set`. Every recursive walk is cycle‑safe and must terminate on any input,
 * including mutually cyclic structures. Plain `Error`s are never thrown — only `ValidationError`.
 */

import { ValidationError } from '../errors/index.js';

/** Keys that must never be written through from untrusted data (prototype‑pollution vectors). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Longest array `range()` will build (the engine's maximum array length). */
const MAX_RANGE_LENGTH = 2 ** 32 - 1;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Define `key` on `target` as a plain own data property, even for `"__proto__"`.
 * @param {object} target @param {string} key @param {unknown} value
 */
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

/**
 * Normalise any list‑ish input (array, iterable, nullish) to an array without copying arrays. A
 * string counts as one item, not as a list of characters.
 * @param {unknown} list
 * @returns {unknown[]}
 */
function toArray(list) {
  if (Array.isArray(list)) return list;
  if (list == null) return [];
  if (typeof list === 'string') return [list];
  const it = /** @type {{ [Symbol.iterator]?: unknown }} */ (list)[Symbol.iterator];
  return typeof it === 'function' ? Array.from(/** @type {Iterable<unknown>} */ (list)) : [];
}

/**
 * Parse a path into string segments: dotted (`'a.b.c'`), bracketed (`'a[0]'`, `'a[b]'`), quoted
 * (`'a["x.y"]'`, `"a['x]y']"`, with `\` escaping the quote) or an array (`['a', 0]`). Empty
 * segments (`'a..b'`, `'a[]'`) are dropped; a `[` without a closing `]` is an ordinary character.
 * @param {string|number|Array<string|number>|undefined|null} path
 * @returns {string[]}
 */
function toPath(path) {
  if (Array.isArray(path)) return path.map(String);
  if (typeof path === 'number') return [String(path)];
  if (typeof path !== 'string' || path === '') return [];
  /** @type {string[]} */
  const out = [];
  const n = path.length;
  let i = 0;
  while (i < n) {
    const ch = path[i];
    if (ch === '.') {
      i++;
      continue;
    }
    if (ch === '[' && path.indexOf(']', i) !== -1) {
      const quote = path[i + 1];
      if (quote === '"' || quote === "'") {
        let seg = '';
        let j = i + 2;
        while (j < n && path[j] !== quote) {
          if (path[j] === '\\' && j + 1 < n) j++;
          seg += path[j++];
        }
        if (path[j] === quote && path[j + 1] === ']') {
          out.push(seg);
          i = j + 2;
          continue;
        }
      }
      const close = path.indexOf(']', i + 1);
      const seg = path.slice(i + 1, close);
      if (seg !== '') out.push(seg);
      i = close + 1;
      continue;
    }
    let j = i + 1;
    while (j < n && path[j] !== '.' && !(path[j] === '[' && path.indexOf(']', j) !== -1)) j++;
    out.push(path.slice(i, j));
    i = j;
  }
  return out;
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

/** True for boxed primitives (`new Number(1)`, `Object(1n)`, …), which compare by their value. */
function isBoxedPrimitive(o) {
  return (
    o instanceof Number ||
    o instanceof String ||
    o instanceof Boolean ||
    o instanceof BigInt ||
    o instanceof Symbol
  );
}

/**
 * Build a `ValidationError` with a single issue.
 * @param {string} message @param {string} path @param {string} code @param {object} [params]
 * @returns {ValidationError}
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
 * objects are merged, arrays and every other value are **replaced** (arrays are shallow‑copied, so
 * objects inside them stay shared with the source); `undefined` source values do not override;
 * non‑plain sources (null, arrays, class instances) are ignored. `__proto__`, `constructor` and
 * `prototype` keys are never copied, so merging untrusted JSON cannot pollute prototypes. Inputs are
 * never mutated and no nested plain object of a source is ever aliased by the result.
 * @param {...unknown} objs
 * @returns {Record<string, unknown>}
 */
export function deepMerge(...objs) {
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {WeakMap<object, Record<string, unknown>>} */
  const seen = new WeakMap();
  for (const src of objs) {
    if (isPlainObject(src)) mergeInto(out, src, seen);
  }
  return out;
}

/**
 * Merge `source` into `target`, which is always an object owned by the current `deepMerge` call.
 * `seen` maps every source object already being merged to the target object it produced, so a
 * cyclic source (or one that aliases the same object twice) terminates and the result mirrors the
 * structure instead of overflowing the stack.
 * @param {Record<string, unknown>} target @param {Record<string, unknown>} source
 * @param {WeakMap<object, Record<string, unknown>>} seen
 * @returns {Record<string, unknown>}
 */
function mergeInto(target, source, seen) {
  seen.set(source, target);
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const sv = source[key];
    if (sv === undefined) continue;
    if (isPlainObject(sv)) {
      const done = seen.get(sv);
      if (done) {
        target[key] = done;
        continue;
      }
      const tv = hasOwn(target, key) ? target[key] : undefined;
      const nested = isPlainObject(tv) ? /** @type {Record<string, unknown>} */ (tv) : {};
      mergeInto(nested, sv, seen);
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
 * instances, Dates, Maps, typed arrays and the like are left as they are, and accessor properties
 * are not evaluated. Returns the same reference.
 * @template T
 * @param {T} o
 * @returns {Readonly<T>}
 */
export function deepFreeze(o) {
  freezeDeep(o, new WeakSet());
  return o;
}

/** @param {unknown} value @param {WeakSet<object>} seen */
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
 * Deep copy of plain data: plain objects (keeping a `null` prototype), arrays, Dates, RegExps
 * (including `lastIndex`), Maps, Sets, ArrayBuffers, typed arrays and DataViews are copied
 * (cycle‑safe); functions, class instances and primitives are returned as they are. Only own
 * enumerable string keys are copied; the result is never frozen, whatever the input.
 * @template T
 * @param {T} o
 * @returns {T}
 */
export function clone(o) {
  return cloneDeep(o, new WeakMap());
}

/** @param {unknown} value @param {WeakMap<object, unknown>} seen @returns {any} */
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
  if (value instanceof RegExp) {
    const out = new RegExp(value.source, value.flags);
    out.lastIndex = value.lastIndex;
    return out;
  }
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
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof DataView) {
    const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new DataView(buf);
  }
  if (ArrayBuffer.isView(value)) return /** @type {{ slice(): unknown }} */ (value).slice();
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
 * boxed primitives, Errors (name, message and own keys), Maps, Sets, ArrayBuffers, DataViews and
 * typed arrays by content. Map keys and Set members match by identity first and structurally
 * otherwise, so `new Set([{ a: 1 }])` equals `new Set([{ a: 1 }])`. Cycle‑safe, including mutually
 * cyclic inputs with different cycle lengths (which compare equal when their unfoldings agree).
 * Objects with different prototypes are never equal, except that `{}` and `Object.create(null)`
 * both count as plain. Only own enumerable string keys take part.
 * @param {unknown} a @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  return eq(a, b, new Map());
}

/**
 * `deepEqual` worker. `stack` maps every object on the current comparison path to the objects it is
 * being compared with; meeting such a pair again means a cycle, which is assumed equal
 * (coinductively). Pairs are removed on the way back out, so a comparison that failed while
 * trying one Set / Map candidate never leaks into the next one.
 * @param {unknown} a @param {unknown} b @param {Map<object, Set<object>>} stack
 * @returns {boolean}
 */
function eq(a, b, stack) {
  if (sameValueZero(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const plainA = isPlainObject(a);
  if (plainA !== isPlainObject(b)) return false;
  if (!plainA && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  let partners = stack.get(a);
  if (partners) {
    if (partners.has(b)) return true;
  } else {
    partners = new Set();
    stack.set(a, partners);
  }
  partners.add(b);
  const result = eqContents(a, b, stack);
  partners.delete(b);
  if (partners.size === 0) stack.delete(a);
  return result;
}

/** @param {object} a @param {object} b @param {Map<object, Set<object>>} stack */
function eqContents(a, b, stack) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i], stack)) return false;
    return true;
  }
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (isBoxedPrimitive(a)) return isBoxedPrimitive(b) && sameValueZero(a.valueOf(), b.valueOf());
  if (a instanceof Map) return b instanceof Map && eqMaps(a, b, stack);
  if (a instanceof Set) return b instanceof Set && eqSets(a, b, stack);
  if (a instanceof ArrayBuffer || a instanceof DataView) {
    return (b instanceof ArrayBuffer || b instanceof DataView) && eqBytes(a, b);
  }
  if (ArrayBuffer.isView(a)) {
    const ta = /** @type {ArrayLike<unknown>} */ (a);
    const tb = /** @type {ArrayLike<unknown>} */ (b);
    if (!ArrayBuffer.isView(b) || ta.length !== tb.length) return false;
    for (let i = 0; i < ta.length; i++) if (!sameValueZero(ta[i], tb[i])) return false;
    return true;
  }
  if (a instanceof Error) {
    if (!(b instanceof Error) || a.name !== b.name || a.message !== b.message) return false;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!hasOwn(b, k) || !eq(a[k], b[k], stack)) return false;
  return true;
}

/** @param {ArrayBuffer|DataView} a @param {ArrayBuffer|DataView} b */
function eqBytes(a, b) {
  const va =
    a instanceof ArrayBuffer
      ? new Uint8Array(a)
      : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const vb =
    b instanceof ArrayBuffer
      ? new Uint8Array(b)
      : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (va.length !== vb.length) return false;
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

/**
 * Unordered comparison of two Sets: identical members pair up first, the rest are matched
 * structurally (greedy is exact because structural equality is an equivalence relation).
 * @param {Set<unknown>} a @param {Set<unknown>} b @param {Map<object, Set<object>>} stack
 */
function eqSets(a, b, stack) {
  if (a.size !== b.size) return false;
  const unmatched = new Set(b);
  const pending = [];
  for (const v of a) {
    if (unmatched.has(v)) unmatched.delete(v);
    else pending.push(v);
  }
  const candidates = [...unmatched];
  outer: for (const v of pending) {
    for (let i = 0; i < candidates.length; i++) {
      if (eq(v, candidates[i], stack)) {
        candidates.splice(i, 1);
        continue outer;
      }
    }
    return false;
  }
  return candidates.length === 0;
}

/**
 * Unordered comparison of two Maps as multisets of `[key, value]` entries: entries with an identical
 * key and value pair up first, the rest are matched structurally on both key and value.
 * @param {Map<unknown, unknown>} a @param {Map<unknown, unknown>} b
 * @param {Map<object, Set<object>>} stack
 */
function eqMaps(a, b, stack) {
  if (a.size !== b.size) return false;
  const unmatched = new Map(b);
  /** @type {Array<[unknown, unknown]>} */
  const pending = [];
  for (const [k, v] of a) {
    if (unmatched.has(k) && sameValueZero(v, unmatched.get(k))) unmatched.delete(k);
    else pending.push([k, v]);
  }
  const candidates = [...unmatched];
  outer: for (const [k, v] of pending) {
    for (let i = 0; i < candidates.length; i++) {
      const [ck, cv] = candidates[i];
      if (eq(k, ck, stack) && eq(v, cv, stack)) {
        candidates.splice(i, 1);
        continue outer;
      }
    }
    return false;
  }
  return candidates.length === 0;
}

/**
 * One‑level equality for arrays and plain objects: same own enumerable keys and `===` values (NaN
 * equals NaN). Anything else — class instances, Dates, Maps, a plain object against an array —
 * compares by identity only, so two distinct Dates are never shallow‑equal (use `deepEqual`).
 * @param {unknown} a @param {unknown} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (sameValueZero(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const arrays = Array.isArray(a);
  if (arrays !== Array.isArray(b)) return false;
  if (!arrays && !(isPlainObject(a) && isPlainObject(b))) return false;
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
 * Read a nested value by path (`'offers.byId[abc].price'`, `'a["dotted.key"]'`,
 * `['offers', 'byId', id]`). Returns `defaultValue` when any segment is missing or the resolved
 * value is `undefined`. `__proto__` segments resolve to the default rather than walking up the
 * prototype chain. An empty path returns `o` itself.
 * @param {unknown} o
 * @param {string|number|Array<string|number>|undefined|null} path
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
 * path (structural sharing elsewhere; a `null` prototype is kept). Missing containers — and any
 * non‑container value met on the way (primitive, Date, class instance) — are replaced by a new
 * array when the next segment is a non‑negative integer, a plain object otherwise. `o` itself is
 * never mutated and the copies are never frozen, even when `o` was.
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

/**
 * @param {unknown} node @param {string[]} segs @param {number} i @param {unknown} value
 * @returns {any}
 */
function setAt(node, segs, i, value) {
  const key = segs[i];
  let copy;
  if (Array.isArray(node)) copy = node.slice();
  else if (isPlainObject(node)) {
    copy =
      Object.getPrototypeOf(node) === null ? Object.assign(Object.create(null), node) : { ...node };
  } else copy = /^\d+$/.test(key) ? [] : {};
  const next = i === segs.length - 1 ? value : setAt(copy[key], segs, i + 1, value);
  copy[Array.isArray(copy) && /^\d+$/.test(key) ? Number(key) : key] = next;
  return copy;
}

/**
 * Shallow copy without empty values: for plain objects drops keys whose value is `undefined`,
 * `null` or `''`; for arrays drops such elements. Anything else yields `{}`. `0`, `false`, `NaN`
 * and empty containers are kept.
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
 * Deterministic JSON: like `JSON.stringify` (honours `toJSON(key)` once per value, unwraps boxed
 * primitives, drops `undefined` / function / symbol values in objects, turns them into `null` in
 * arrays, non‑finite numbers become `null`) but object keys are sorted recursively, so equal data
 * always yields the same string. BigInts serialise as decimal strings; a top‑level `undefined`
 * serialises as `'null'` so the result is always a string.
 * @param {unknown} o
 * @returns {string}
 * @throws {ValidationError} when the value contains a cycle
 */
export function stableStringify(o) {
  const out = serialize(o, '', new Set(), '$');
  return out === undefined ? 'null' : out;
}

/**
 * @param {unknown} raw @param {string} key @param {Set<object>} stack @param {string} path
 * @returns {string|undefined}
 */
function serialize(raw, key, stack, path) {
  let value = raw;
  if (value !== null && (typeof value === 'object' || typeof value === 'bigint')) {
    const toJSON = /** @type {{ toJSON?: unknown }} */ (value).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value, key);
  }
  if (value !== null && typeof value === 'object' && isBoxedPrimitive(value)) {
    value = /** @type {{ valueOf(): unknown }} */ (value).valueOf();
  }
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
  const obj = /** @type {object} */ (value);
  if (stack.has(obj)) {
    throw invalid('stableStringify() cannot serialise a circular structure', path, 'circular');
  }
  stack.add(obj);
  let result;
  if (Array.isArray(obj)) {
    const parts = new Array(obj.length);
    for (let i = 0; i < obj.length; i++) {
      parts[i] = serialize(obj[i], String(i), stack, `${path}[${i}]`) ?? 'null';
    }
    result = `[${parts.join(',')}]`;
  } else {
    const parts = [];
    for (const k of Object.keys(obj).sort()) {
      const s = serialize(obj[k], k, stack, `${path}.${k}`);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    result = `{${parts.join(',')}}`;
  }
  stack.delete(obj);
  return result;
}

/**
 * Fast, non‑cryptographic 53‑bit string hash (cyrb53: FNV‑style xor/multiply mixing over UTF‑16
 * code units) rendered as a short base36 string (≤ 11 chars). Deterministic across runs and
 * engines. Non‑string input is first passed through `stableStringify`, so structurally equal
 * objects hash alike whatever their key order. Not for security purposes.
 * @param {unknown} str  A string, or any value `stableStringify` accepts.
 * @returns {string}
 * @throws {ValidationError} when a non‑string input contains a cycle
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
 * @param {((item: T) => unknown)|string|number|Array<string|number>} keyFn
 * @returns {Record<string, T[]>}
 */
export function groupBy(list, keyFn) {
  const fn = iteratee(keyFn);
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of /** @type {T[]} */ (toArray(list))) {
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
 * @param {((item: T) => unknown)|string|number|Array<string|number>} [keyFn]
 * @returns {T[]}
 */
export function uniqBy(list, keyFn) {
  const fn = iteratee(keyFn);
  const seen = new Set();
  /** @type {T[]} */
  const out = [];
  for (const item of /** @type {T[]} */ (toArray(list))) {
    const key = fn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Stable sort into a new array by one or more keys: property paths (`'price.amount'`, prefix `-` for
 * descending), or accessor functions. Values compare with `<` / `>` (strings by UTF‑16 code unit,
 * Dates by time). Ties fall through to the next key; `null` / `undefined` / NaN sort last whatever
 * the direction. With no keys, items sort by their own value.
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
  return /** @type {T[]} */ (toArray(list)).slice().sort((a, b) => {
    for (const { fn, desc } of comparators) {
      const c = compareValues(fn(a), fn(b), desc);
      if (c !== 0) return c;
    }
    return 0;
  });
}

const isMissing = (v) => v === undefined || v === null || (typeof v === 'number' && v !== v);

/** @param {unknown} x @param {unknown} y @param {boolean} desc @returns {-1|0|1} */
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
  const arr = /** @type {T[]} */ (toArray(list));
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
 * @throws {ValidationError} when a bound is not a safe integer (`code: 'invalid'`) or the result
 *   would exceed the maximum array length (`code: 'max'`)
 */
export function range(a, b) {
  const start = b === undefined ? 0 : a;
  const end = b === undefined ? a : b;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    const path = b === undefined || !Number.isSafeInteger(a) ? 'a' : 'b';
    throw invalid('range() bounds must be safe integers', path, 'invalid');
  }
  const length = Math.abs(end - start);
  if (length > MAX_RANGE_LENGTH) {
    throw invalid('range() would exceed the maximum array length', 'b', 'max', {
      max: MAX_RANGE_LENGTH,
    });
  }
  const step = start <= end ? 1 : -1;
  const out = new Array(length);
  for (let i = 0; i < length; i++) out[i] = start + i * step;
  return out;
}
