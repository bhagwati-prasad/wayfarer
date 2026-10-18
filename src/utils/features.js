/**
 * Feature flags and experiment variants for the Wayfarer SDK (docs/api/03-utils.md §12):
 * `createFeatures` returns a `Features` facade over two layers of flags — the loaded layer (`initial`,
 * `set(flags)` and whatever `load()` pulls from `source`) and a dev‑only override layer
 * (`override` / `clearOverrides`) that always wins. Values are booleans or strings (numbers are
 * coerced to strings); `isEnabled` reads a flag as a boolean, `variant` as an experiment arm, `get`
 * raw. Every effective change is mirrored into the `bootstrap.flags` slice of a duck‑typed store (when
 * one with `set` is given), handed to `onChange` listeners and emitted as `features:change` on the
 * optional events bus, with the keys that changed; a change that leaves the effective flags identical
 * is silent. `load()` has no transport of its own: the client wires `source` to `GET /config`, and
 * without a source it rejects with `ConfigError`. SSR‑safe: nothing here touches `window`,
 * `document`, storage, timers or the network, and there is no module‑level mutable state or logging.
 * Plain `Error`s are never thrown — only `ConfigError` (factory options) and `ValidationError`
 * (method arguments); anything a `source` throws is normalised with `wrap`.
 */

import { ConfigError, ValidationError, wrap } from '../errors/index.js';
import { isPlainObject } from './object.js';

/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../errors/index.js').SdkError} SdkError */

/**
 * A flag's value: `true` / `false` for switches, a string for experiment arms or settings.
 * @typedef {boolean|string} FeatureValue
 */

/**
 * A map of flag name → value.
 * @typedef {Record<string, FeatureValue>} FeatureFlags
 */

/**
 * Which operation produced a change.
 * @typedef {'set'|'load'|'override'|'clearOverrides'} FeaturesChangeReason
 */

/**
 * What `onChange` listeners receive and what `features:change` carries (the emitter adds `type` and
 * `at`). `flags` and `previous` are frozen snapshots of the **effective** flags (overrides applied).
 * @typedef {Object} FeaturesChange
 * @property {Readonly<FeatureFlags>} flags      Effective flags after the change.
 * @property {Readonly<FeatureFlags>} previous   Effective flags before the change.
 * @property {string[]} changed                  Names whose effective value differs (added, removed or changed).
 * @property {FeaturesChangeReason} reason       Operation that caused the change.
 */

/**
 * Minimal event bus (`client.events` or any `{ emit }` duck type).
 * @typedef {{ emit: (event: string, payload?: unknown) => void }} FeaturesEvents
 */

/**
 * Minimal store: only `set(slice, updater, meta)` is used, and only when it is a function.
 * @typedef {{ set?: (slice: string, updater: (s: any) => any, meta?: { action: string }) => void }} FeaturesStore
 */

/**
 * @typedef {Object} FeaturesOptions
 * @property {Record<string, unknown>} [initial]  Flags known before any load (e.g. `config.features`).
 * @property {() => Promise<Record<string, unknown>>} [source]
 *   Fetches flags: resolves to a flag map, or to a bootstrap document carrying a `flags` object.
 *   The client wires it to `GET /config`.
 * @property {FeaturesEvents} [events]  Receives `features:change` (and `error` for listener faults).
 * @property {FeaturesStore} [store]    Its `bootstrap.flags` mirrors the effective flags when it has `set`.
 */

/**
 * The facade returned by `createFeatures`.
 * @typedef {Object} Features
 * @property {(flag: string, defaultValue?: boolean) => boolean} isEnabled
 *   Boolean read: a boolean flag as it is; a string flag parsed (`'false'`, `'0'`, `'off'`, `'no'`,
 *   `'disabled'` and `''` are off, any other string is on); a missing flag yields `defaultValue`.
 * @property {<D = undefined>(experiment: string, defaultValue?: D) => string | D} variant
 *   The string value of an experiment flag, or `defaultValue` when the flag is missing or boolean.
 * @property {(flag: string) => FeatureValue | undefined} get  Raw effective value (`undefined` when unset).
 * @property {(flags: Record<string, unknown>) => void} set
 *   Merge flags into the loaded layer; a `null` / `undefined` value removes that flag.
 * @property {(flag: string, value: unknown) => void} override
 *   Dev override that wins over loaded flags; `null` / `undefined` removes that one override.
 * @property {() => void} clearOverrides  Drop every override.
 * @property {() => Promise<void>} load   Call `source()` and merge what it returns (single‑flight).
 * @property {(fn: (change: FeaturesChange) => void) => () => void} onChange  Subscribe; returns `off`.
 * @property {() => void} destroy  Drop every `onChange` listener (flags are kept readable).
 */

/** Keys that can never name a flag (prototype‑pollution vectors). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Strings `isEnabled` reads as off (compared trimmed and lower‑cased). */
const OFF_WORDS = new Set(['false', '0', 'off', 'no', 'disabled', '']);

/** Store slice and action prefix used for the state mirror. */
const SLICE = 'bootstrap';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── errors ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Build one validation issue.
 * @param {string} path @param {string} code @param {string} message @param {object} [params]
 * @returns {ValidationIssue}
 */
function issue(path, code, message, params) {
  /** @type {ValidationIssue} */
  const out = { path, code, message };
  if (params) out.params = params;
  return out;
}

/**
 * Throw a `ValidationError` carrying `issues`.
 * @param {string} message @param {ValidationIssue[]} issues
 * @returns {never}
 */
function invalid(message, issues) {
  throw new ValidationError(message, { issues });
}

/**
 * Throw a `ConfigError` for a bad factory option.
 * @param {string} path @param {string} message @param {ValidationIssue[]} [issues]
 * @returns {never}
 */
function misconfigured(path, message, issues) {
  throw new ConfigError(message, { details: issues ? { path, issues } : { path } });
}

// ── normalisation ───────────────────────────────────────────────────────────────────────────────

/**
 * Normalise one flag value: booleans and strings pass through, finite numbers become strings,
 * `null` / `undefined` mean "remove" and everything else is invalid.
 * @param {unknown} value
 * @returns {{ ok: true, value: FeatureValue | undefined } | { ok: false }}
 */
function normaliseValue(value) {
  if (value === null || value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'boolean' || typeof value === 'string') return { ok: true, value };
  if (typeof value === 'number' && Number.isFinite(value))
    return { ok: true, value: String(value) };
  return { ok: false };
}

/**
 * Validate a flag name used as a method argument.
 * @param {unknown} flag @param {string} path
 * @returns {string}
 */
function assertFlagName(flag, path) {
  if (typeof flag !== 'string') {
    return invalid(`${path} must be a string`, [
      issue(path, 'invalid_type', `${path} must be a string`),
    ]);
  }
  if (flag === '') {
    return invalid(`${path} must not be empty`, [
      issue(path, 'required', `${path} must not be empty`),
    ]);
  }
  return flag;
}

/**
 * Turn a caller‑supplied flag map into `[name, value|undefined]` entries, collecting every problem.
 * In strict mode a bad value or an unsafe key is an issue; in lenient mode (remote data) it is
 * skipped.
 * @param {unknown} flags @param {string} path @param {boolean} strict
 * @returns {{ entries: Array<[string, FeatureValue|undefined]>, issues: ValidationIssue[] }}
 */
function normaliseFlags(flags, path, strict) {
  /** @type {Array<[string, FeatureValue|undefined]>} */
  const entries = [];
  /** @type {ValidationIssue[]} */
  const issues = [];
  if (!isPlainObject(flags)) {
    issues.push(issue(path, 'invalid_type', `${path} must be an object of flags`));
    return { entries, issues };
  }
  for (const key of Object.keys(flags)) {
    if (UNSAFE_KEYS.has(key)) {
      if (strict) {
        issues.push(issue(`${path}.${key}`, 'unsafe_key', `"${key}" cannot name a flag`, { key }));
      }
      continue;
    }
    const n = normaliseValue(flags[key]);
    if (n.ok) {
      if (strict || n.value !== undefined) entries.push([key, n.value]);
    } else if (strict) {
      issues.push(
        issue(`${path}.${key}`, 'invalid_type', `flag "${key}" must be a boolean or a string`, {
          key,
        })
      );
    }
  }
  return { entries, issues };
}

/**
 * Apply `[name, value|undefined]` entries to a layer; `undefined` deletes.
 * @param {Map<string, FeatureValue>} layer
 * @param {Array<[string, FeatureValue|undefined]>} entries
 */
function applyEntries(layer, entries) {
  for (const [key, value] of entries) {
    if (value === undefined) layer.delete(key);
    else layer.set(key, value);
  }
}

/**
 * Names whose value differs between two flag snapshots (added, removed or changed), in `next` order
 * followed by removed names.
 * @param {Readonly<FeatureFlags>} prev @param {Readonly<FeatureFlags>} next
 * @returns {string[]}
 */
function diffKeys(prev, next) {
  const out = [];
  for (const key of Object.keys(next)) {
    if (!hasOwn(prev, key) || prev[key] !== next[key]) out.push(key);
  }
  for (const key of Object.keys(prev)) {
    if (!hasOwn(next, key)) out.push(key);
  }
  return out;
}

/**
 * Pick the flag map out of whatever `source()` resolved to: a bootstrap document (`{ flags }`) or a
 * bare flag map.
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
function flagsFromSource(result) {
  if (!isPlainObject(result)) {
    return invalid('features source must resolve to an object of flags', [
      issue('source', 'invalid_type', 'source() must resolve to an object of flags'),
    ]);
  }
  const doc = /** @type {Record<string, unknown>} */ (result);
  return isPlainObject(doc.flags) ? /** @type {Record<string, unknown>} */ (doc.flags) : doc;
}

// ── factory ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a feature‑flag facade. `initial` seeds the loaded layer; `source` is what `load()` calls
 * (the client wires `GET /config`); `events` receives `features:change`; a `store` with `set` gets
 * its `bootstrap.flags` kept in sync with the effective flags (written once at creation when
 * `initial` is non‑empty, then on every effective change, action `features/<reason>`).
 * Effects: state `bootstrap.flags` when `initial` is non‑empty and a store with `set` is given;
 * otherwise none.
 * @param {FeaturesOptions} [options]
 * @returns {Features}
 * @throws {ConfigError} on a non‑object `initial`, an `initial` value that is not a boolean / string
 *   / number, a non‑function `source`, or an `events` without `emit`.
 */
export function createFeatures(options = {}) {
  if (options === null || typeof options !== 'object') {
    return misconfigured('options', 'createFeatures() options must be an object');
  }
  const { initial, source, events, store } = options;

  if (source !== undefined && source !== null && typeof source !== 'function') {
    return misconfigured('source', 'features source must be a function returning a promise');
  }
  if (events !== undefined && events !== null && typeof events?.emit !== 'function') {
    return misconfigured('events', 'features events must expose emit()');
  }
  const emit = events && typeof events.emit === 'function' ? events.emit.bind(events) : undefined;
  const writeStore =
    store !== null && typeof store === 'object' && typeof store.set === 'function'
      ? store.set.bind(store)
      : undefined;

  /** @type {Map<string, FeatureValue>} */
  const loaded = new Map();
  /** @type {Map<string, FeatureValue>} */
  const overrides = new Map();
  /** @type {Set<{ fn: (change: FeaturesChange) => void }>} */
  const listeners = new Set();
  /** @type {Promise<void>|null} */
  let inflight = null;

  if (initial !== undefined && initial !== null) {
    const { entries, issues } = normaliseFlags(initial, 'initial', true);
    if (issues.length) return misconfigured('initial', 'invalid initial feature flags', issues);
    applyEntries(loaded, entries);
  }

  /** @returns {Readonly<FeatureFlags>} */
  function snapshot() {
    /** @type {FeatureFlags} */
    const out = {};
    for (const [k, v] of loaded) out[k] = v;
    for (const [k, v] of overrides) out[k] = v;
    return Object.freeze(out);
  }

  /** @type {Readonly<FeatureFlags>} */
  let current = snapshot();

  /**
   * Mirror the effective flags into the store slice.
   * @param {string} action
   */
  function mirror(action) {
    if (!writeStore) return;
    const flags = current;
    writeStore(SLICE, (s) => ({ ...(isPlainObject(s) ? s : {}), flags }), {
      action: `features/${action}`,
    });
  }

  if (writeStore && loaded.size > 0) mirror('init');

  /**
   * Recompute the effective flags and, when they differ, mirror them, notify listeners and emit.
   * @param {FeaturesChangeReason} reason
   */
  function commit(reason) {
    const previous = current;
    const next = snapshot();
    const changed = diffKeys(previous, next);
    if (changed.length === 0) return;
    current = next;
    mirror(reason);

    /** @type {FeaturesChange} */
    const change = Object.freeze({ flags: next, previous, changed, reason });
    /** @type {SdkError|undefined} */
    let firstError;
    for (const entry of Array.from(listeners)) {
      if (!listeners.has(entry)) continue;
      try {
        entry.fn(change);
      } catch (e) {
        const error = wrap(e);
        if (emit) emit('error', { error, event: 'features:change' });
        else if (!firstError) firstError = error;
      }
    }
    if (emit) emit('features:change', change);
    if (firstError) throw firstError;
  }

  /** @type {Features['get']} */
  function get(flag) {
    const name = assertFlagName(flag, 'flag');
    return hasOwn(current, name) ? current[name] : undefined;
  }

  /** @type {Features['isEnabled']} */
  function isEnabled(flag, defaultValue = false) {
    const value = get(flag);
    if (value === undefined) return defaultValue === true;
    if (typeof value === 'boolean') return value;
    return !OFF_WORDS.has(value.trim().toLowerCase());
  }

  /** @type {Features['variant']} */
  function variant(experiment, defaultValue) {
    const value = get(experiment);
    return typeof value === 'string' ? value : defaultValue;
  }

  /** @type {Features['set']} */
  function set(flags) {
    const { entries, issues } = normaliseFlags(flags, 'flags', true);
    if (issues.length) invalid('invalid feature flags', issues);
    applyEntries(loaded, entries);
    commit('set');
  }

  /** @type {Features['override']} */
  function override(flag, value) {
    const name = assertFlagName(flag, 'flag');
    if (UNSAFE_KEYS.has(name)) {
      invalid(`"${name}" cannot name a flag`, [
        issue('flag', 'unsafe_key', `"${name}" cannot name a flag`, { key: name }),
      ]);
    }
    const n = normaliseValue(value);
    if (!n.ok) {
      invalid('override value must be a boolean or a string', [
        issue('value', 'invalid_type', 'override value must be a boolean or a string'),
      ]);
    }
    applyEntries(overrides, [[name, n.ok ? n.value : undefined]]);
    commit('override');
  }

  /** @type {Features['clearOverrides']} */
  function clearOverrides() {
    if (overrides.size === 0) return;
    overrides.clear();
    commit('clearOverrides');
  }

  /** @type {Features['load']} */
  function load() {
    if (inflight) return inflight;
    if (typeof source !== 'function') {
      return Promise.reject(
        new ConfigError('features.load() needs a source (the client wires GET /config)', {
          details: { path: 'source' },
        })
      );
    }
    const run = async () => {
      let result;
      try {
        result = await source();
      } catch (e) {
        throw wrap(e, {
          code: 'FEATURES_LOAD_FAILED',
          message: 'feature flags could not be loaded',
        });
      }
      const { entries } = normaliseFlags(flagsFromSource(result), 'source', false);
      applyEntries(loaded, entries);
      commit('load');
    };
    const promise = run().finally(() => {
      if (inflight === promise) inflight = null;
    });
    inflight = promise;
    return promise;
  }

  /** @type {Features['onChange']} */
  function onChange(fn) {
    if (typeof fn !== 'function') {
      return invalid('onChange(fn) requires a function', [
        issue('fn', 'invalid_type', 'onChange(fn) requires a function'),
      ]);
    }
    const entry = { fn };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  }

  /** @type {Features['destroy']} */
  function destroy() {
    listeners.clear();
  }

  return { isEnabled, variant, get, set, override, clearOverrides, load, onChange, destroy };
}
