/**
 * Telemetry fan‑out for the Wayfarer SDK (docs/api/03-utils.md §10): `createTelemetry` returns a
 * `Telemetry` whose `track` / `page` / `identify` / `timing` hand every call to each registered
 * `TelemetryAdapter` and emit `telemetry:track` on the injected event bus (docs/README.md §6). Calls
 * are gated by `enabled`, by `consent` (when off everything but `flush` is dropped — never buffered)
 * and, for `track` / `timing`, by `sampleRate` decided per call through an injectable `random()`.
 * `context` is merged under the props of every event. `bindDomainEvents` subscribes to the SDK's
 * domain events and replays them as GA4 ecommerce events whose `items[]` are built from Offer /
 * Itinerary / Booking payloads (combined `offers[]` and split‑mode `sliceOffers[][]` alike).
 * Reference adapters: `ga4Adapter`, `gtmAdapter`, `segmentAdapter`, `consoleAdapter`,
 * `beaconAdapter`. An adapter that throws is isolated and reported to the optional logger: telemetry
 * must never break the app. This module must not touch `window`, `document`, `navigator`, `fetch`
 * or `console` at import time (adapters feature‑detect at call time), must not start timers, keep
 * module‑level mutable state or persist anything, and must never throw a plain `Error` (only
 * `ConfigError` for bad factory options and `ValidationError` for bad arguments).
 */

import { ConfigError, ValidationError } from '../errors/index.js';
import { deepMerge, isPlainObject } from './object.js';

/** @typedef {import('../types.js').TelemetryAdapter} TelemetryAdapter */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */
/** @typedef {import('../types.js').Offer} Offer */
/** @typedef {import('../types.js').Itinerary} Itinerary */
/** @typedef {import('../types.js').Booking} Booking */
/** @typedef {import('../types.js').PaymentIntent} PaymentIntent */
/** @typedef {import('../types.js').Money} Money */

/**
 * Free‑form event properties (plain JSON‑like object).
 * @typedef {Record<string, unknown>} Props
 */

/**
 * Which `Telemetry` method produced an event.
 * @typedef {'track'|'page'|'identify'|'timing'} TelemetryKind
 */

/**
 * Payload emitted as `telemetry:track` (the emitter adds `type` and `at`). `event` is exactly what
 * the adapters received as first argument: the event name (`track`), the page name (`page`), the
 * user id (`identify`) or `'timing_complete'` (`timing`, with `props.name` / `props.value`).
 * @typedef {Object} TelemetryEvent
 * @property {TelemetryKind} kind  Producing method.
 * @property {string} event        Name / id handed to the adapters.
 * @property {Props} props         Merged `context` + props (traits for `identify`, without context).
 */

/**
 * Minimal event bus the telemetry emits on (`events/emitter.js` satisfies it).
 * @typedef {{ emit: (event: string, payload?: unknown) => void }} TelemetryEmitter
 */

/**
 * Subset of `Logger` (`utils/logger.js`) that receives swallowed adapter failures. `warn` is
 * preferred, `error` is the fallback; a logger with neither is a silent sink.
 * @typedef {{ warn?: (msg: string, data?: unknown) => void, error?: (msg: string, data?: unknown) => void }} TelemetryLogger
 */

/**
 * @typedef {Object} TelemetryOptions
 * @property {TelemetryAdapter[]} [adapters]   Initial sinks (`addAdapter` adds more).
 * @property {boolean} [enabled=true]          Master switch; `false` drops everything but `flush`.
 * @property {number} [sampleRate=1]           Share of `track` / `timing` calls kept, in [0, 1].
 * @property {Props} [context]                 Merged under the props of every event.
 * @property {boolean} [consent=true]          Analytics consent; `false` drops everything but `flush`.
 * @property {() => number} [random]           Sampling source in [0, 1); defaults to `Math.random`.
 * @property {TelemetryEmitter} [events]       Bus that receives `telemetry:track`.
 * @property {TelemetryLogger} [logger]        Receives adapter / bus failures.
 */

/**
 * @typedef {Object} Telemetry
 * @property {(event: string, props?: Props) => boolean} track  Fan out an event; `true` when it
 *   passed the gates (enabled, consent, sampling) and was delivered.
 * @property {(name: string, props?: Props) => boolean} page  Page view; adapters without `page`
 *   receive `track('page_view', { ...props, name })`. Never sampled.
 * @property {(userId: string|number, traits?: Props) => boolean} identify  Identify the user on the
 *   adapters that implement `identify`. Never sampled; `context` is not merged into traits.
 * @property {(name: string, ms: number, props?: Props) => boolean} timing  Duration measurement,
 *   delivered as `track('timing_complete', { name, value: round(ms), ...props })`.
 * @property {(partial: Props) => void} setContext  Deep‑merge into the context; a key set to
 *   `undefined` is removed.
 * @property {(consent: boolean) => void} setConsent  Grant or revoke analytics consent.
 * @property {(adapter: TelemetryAdapter) => () => void} addAdapter  Register a sink; returns an
 *   idempotent remover. Registering the same adapter twice is a no‑op.
 * @property {() => Promise<void>} flush  Call every adapter's `flush` and settle when they do;
 *   never rejects and ignores `enabled` / `consent`.
 * @property {boolean} enabled        Read‑only master switch.
 * @property {boolean} consent        Read‑only current consent.
 * @property {number} sampleRate      Read‑only sample rate.
 * @property {Props} context          Read‑only copy of the current context.
 * @property {string[]} adapters      Read‑only names of the registered adapters, in fan‑out order.
 */

/**
 * Internal state of one `Telemetry`.
 * @typedef {Object} TelemetryState
 * @property {boolean} enabled
 * @property {boolean} consent
 * @property {number} sampleRate
 * @property {Props} context
 * @property {() => number} random
 * @property {TelemetryEmitter|undefined} events
 * @property {TelemetryLogger|undefined} logger
 * @property {TelemetryAdapter[]} adapters
 */

const TRACK_EVENT = 'telemetry:track';
const PAGE_EVENT = 'page_view';
const TIMING_EVENT = 'timing_complete';
/** GA4 accepts at most 200 items per event. */
const MAX_ITEMS = 200;
const OPTIONAL_ADAPTER_METHODS = ['page', 'identify', 'flush'];
/** GA4 ecommerce parameters that GTM expects under `ecommerce`. */
const ECOMMERCE_KEYS = new Set([
  'items',
  'currency',
  'value',
  'transaction_id',
  'tax',
  'shipping',
  'coupon',
  'affiliation',
  'payment_type',
  'shipping_tier',
  'item_list_id',
  'item_list_name',
]);

// ── validation ──────────────────────────────────────────────────────────────────────────────────

/**
 * Build a `ValidationError` carrying one issue.
 * @param {string} path
 * @param {string} code
 * @param {string} message
 * @returns {ValidationError}
 */
function invalid(path, code, message) {
  /** @type {ValidationIssue[]} */
  const issues = [{ path, code, message }];
  return new ValidationError(message, { issues });
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object';
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isName(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Normalise a factory's `options` argument: `undefined` → `{}`, non‑objects → `ConfigError`.
 * @param {unknown} options
 * @param {string} factory
 * @returns {Record<string, any>}
 */
function optionsOf(options, factory) {
  if (options === undefined) return {};
  if (!isObj(options) || Array.isArray(options)) {
    throw new ConfigError(`${factory}: options must be an object`);
  }
  return options;
}

/**
 * Why `a` is not a usable adapter, or `null` when it is.
 * @param {unknown} a
 * @returns {string|null}
 */
function adapterProblem(a) {
  if (!isObj(a)) return 'must be an object';
  if (!isName(a.name)) return 'must have a non-empty string name';
  if (typeof a.track !== 'function') return 'must implement track(event, props)';
  for (const key of OPTIONAL_ADAPTER_METHODS) {
    if (a[key] !== undefined && a[key] !== null && typeof a[key] !== 'function') {
      return `${key} must be a function when present`;
    }
  }
  return null;
}

/**
 * @param {unknown} v
 * @param {string} path
 * @returns {string}
 */
function assertName(v, path) {
  if (!isName(v)) throw invalid(path, 'type', `${path} must be a non-empty string`);
  return v;
}

/**
 * `undefined` / `null` → `{}`; anything but a plain object is rejected.
 * @param {unknown} v
 * @param {string} path
 * @returns {Props}
 */
function assertProps(v, path) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw invalid(path, 'type', `${path} must be a plain object`);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} path
 * @returns {boolean}
 */
function assertBoolean(v, path) {
  if (typeof v !== 'boolean') throw invalid(path, 'type', `${path} must be a boolean`);
  return v;
}

/**
 * Read a boolean factory option.
 * @param {Record<string, unknown>} o
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolOption(o, key, fallback) {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ConfigError(`createTelemetry: ${key} must be a boolean`);
  return v;
}

/**
 * Read the `sampleRate` option: a finite number in [0, 1], default 1.
 * @param {unknown} v
 * @returns {number}
 */
function rateOption(v) {
  if (v === undefined || v === null) return 1;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new ConfigError('createTelemetry: sampleRate must be a number between 0 and 1');
  }
  return v;
}

// ── delivery ────────────────────────────────────────────────────────────────────────────────────

/**
 * Hand a message to the logger, if any. Never throws.
 * @param {TelemetryState} state
 * @param {string} msg
 * @param {unknown} data
 */
function log(state, msg, data) {
  const l = state.logger;
  if (!l) return;
  const fn = typeof l.warn === 'function' ? l.warn : typeof l.error === 'function' ? l.error : null;
  if (!fn) return;
  try {
    fn.call(l, msg, data);
  } catch {
    // A failing logger must never break telemetry.
  }
}

/**
 * Report an adapter failure.
 * @param {TelemetryState} state
 * @param {TelemetryAdapter} adapter
 * @param {TelemetryKind|'flush'} kind
 * @param {unknown} error
 */
function report(state, adapter, kind, error) {
  log(state, `telemetry: adapter '${adapter.name}' failed on ${kind}`, {
    adapter: adapter.name,
    kind,
    error,
  });
}

/**
 * Per‑call sampling decision. Rates of 1 and 0 never consult `random()`; a `random()` that throws or
 * returns a non‑number fails open (the event is kept).
 * @param {TelemetryState} state
 * @returns {boolean}
 */
function sampled(state) {
  if (state.sampleRate >= 1) return true;
  if (state.sampleRate <= 0) return false;
  let r;
  try {
    r = Number(state.random());
  } catch {
    return true;
  }
  return Number.isFinite(r) ? r < state.sampleRate : true;
}

/**
 * Deliver one event to every adapter, isolating failures.
 * @param {TelemetryState} state
 * @param {TelemetryKind} kind
 * @param {string} event
 * @param {Props} props
 */
function fanOut(state, kind, event, props) {
  for (const adapter of state.adapters.slice()) {
    try {
      if (kind === 'page') {
        if (typeof adapter.page === 'function') adapter.page(event, props);
        else adapter.track(PAGE_EVENT, { ...props, name: event });
      } else if (kind === 'identify') {
        if (typeof adapter.identify === 'function') adapter.identify(event, props);
      } else {
        adapter.track(event, props);
      }
    } catch (e) {
      report(state, adapter, kind, e);
    }
  }
}

/**
 * Emit `telemetry:track` on the bus, if any. Never throws.
 * @param {TelemetryState} state
 * @param {TelemetryEvent} payload
 */
function emitTrack(state, payload) {
  const bus = state.events;
  if (!bus) return;
  try {
    bus.emit(TRACK_EVENT, payload);
  } catch (e) {
    log(state, `telemetry: event bus rejected ${TRACK_EVENT}`, { error: e });
  }
}

/**
 * Run the gates, then fan out and emit.
 * @param {TelemetryState} state
 * @param {TelemetryKind} kind
 * @param {string} event
 * @param {Props} props
 * @returns {boolean} whether the event was delivered
 */
function deliver(state, kind, event, props) {
  if (!state.enabled || !state.consent) return false;
  if ((kind === 'track' || kind === 'timing') && !sampled(state)) return false;
  fanOut(state, kind, event, props);
  emitTrack(state, { kind, event, props });
  return true;
}

// ── factory ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a telemetry hub. `enabled` and `consent` default to `true` (hosts in consent‑gated markets
 * pass `consent: false` until the banner is accepted, or call `setConsent`), `sampleRate` to 1,
 * `context` to `{}` and `random` to `Math.random`. Pass `events` (the client emitter) to have every
 * delivered call emitted as `telemetry:track`.
 * Effects: none at creation (calls fan out to adapters and emit `telemetry:track`; no timers, no
 * storage, no module state).
 * @param {TelemetryOptions} [options]
 * @returns {Telemetry}
 * @throws {ConfigError} on a non‑object `options`, a non‑boolean `enabled` / `consent`, a
 *   `sampleRate` outside [0, 1], a non‑object `context`, a non‑function `random`, an `events`
 *   without `emit()`, a non‑object `logger` or an adapter that does not match `TelemetryAdapter`.
 */
export function createTelemetry(options = {}) {
  const o = optionsOf(options, 'createTelemetry');
  const enabled = boolOption(o, 'enabled', true);
  const consent = boolOption(o, 'consent', true);
  const sampleRate = rateOption(o.sampleRate);
  if (o.context !== undefined && o.context !== null && !isPlainObject(o.context)) {
    throw new ConfigError('createTelemetry: context must be a plain object');
  }
  if (o.random !== undefined && o.random !== null && typeof o.random !== 'function') {
    throw new ConfigError(
      'createTelemetry: random must be a function returning a number in [0, 1)'
    );
  }
  if (o.events !== undefined && o.events !== null) {
    if (!isObj(o.events) || typeof o.events.emit !== 'function') {
      throw new ConfigError('createTelemetry: events must be an emitter with emit()');
    }
  }
  if (
    o.logger !== undefined &&
    o.logger !== null &&
    (!isObj(o.logger) || Array.isArray(o.logger))
  ) {
    throw new ConfigError('createTelemetry: logger must be an object with warn()/error()');
  }
  /** @type {TelemetryAdapter[]} */
  const adapters = [];
  if (o.adapters !== undefined && o.adapters !== null) {
    if (!Array.isArray(o.adapters))
      throw new ConfigError('createTelemetry: adapters must be an array');
    o.adapters.forEach((a, i) => {
      const problem = adapterProblem(a);
      if (problem) throw new ConfigError(`createTelemetry: adapters[${i}] ${problem}`);
      if (!adapters.includes(a)) adapters.push(a);
    });
  }

  /** @type {TelemetryState} */
  const state = {
    enabled,
    consent,
    sampleRate,
    context: deepMerge(o.context),
    random: typeof o.random === 'function' ? o.random : Math.random,
    events: o.events || undefined,
    logger: o.logger || undefined,
    adapters,
  };

  /**
   * Merge the context under the given layers (later layers win).
   * @param {...unknown} layers
   * @returns {Props}
   */
  const withContext = (...layers) => deepMerge(state.context, ...layers);

  /** @type {Telemetry['track']} */
  function track(event, props) {
    const name = assertName(event, 'event');
    const p = assertProps(props, 'props');
    return deliver(state, 'track', name, withContext(p));
  }

  /** @type {Telemetry['page']} */
  function page(name, props) {
    const n = assertName(name, 'name');
    const p = assertProps(props, 'props');
    return deliver(state, 'page', n, withContext(p));
  }

  /** @type {Telemetry['identify']} */
  function identify(userId, traits) {
    const ok = isName(userId) || (typeof userId === 'number' && Number.isFinite(userId));
    if (!ok) throw invalid('userId', 'type', 'userId must be a non-empty string or a number');
    const t = assertProps(traits, 'traits');
    return deliver(state, 'identify', String(userId), deepMerge(t));
  }

  /** @type {Telemetry['timing']} */
  function timing(name, ms, props) {
    const n = assertName(name, 'name');
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw invalid('ms', 'type', 'ms must be a non-negative finite number');
    }
    const p = assertProps(props, 'props');
    return deliver(
      state,
      'timing',
      TIMING_EVENT,
      withContext(p, { name: n, value: Math.round(ms) })
    );
  }

  /** @type {Telemetry['setContext']} */
  function setContext(partial) {
    if (!isPlainObject(partial)) throw invalid('partial', 'type', 'partial must be a plain object');
    const next = deepMerge(state.context, partial);
    for (const key of Object.keys(partial)) {
      if (partial[key] === undefined) delete next[key];
    }
    state.context = next;
  }

  /** @type {Telemetry['setConsent']} */
  function setConsent(consentGiven) {
    state.consent = assertBoolean(consentGiven, 'consent');
  }

  /** @type {Telemetry['addAdapter']} */
  function addAdapter(adapter) {
    const problem = adapterProblem(adapter);
    if (problem) throw invalid('adapter', 'type', `adapter ${problem}`);
    if (!state.adapters.includes(adapter)) state.adapters.push(adapter);
    let removed = false;
    return function remove() {
      if (removed) return;
      removed = true;
      const i = state.adapters.indexOf(adapter);
      if (i !== -1) state.adapters.splice(i, 1);
    };
  }

  /** @type {Telemetry['flush']} */
  async function flush() {
    const pending = state.adapters.slice().map((adapter) => {
      try {
        const result = typeof adapter.flush === 'function' ? adapter.flush() : undefined;
        return Promise.resolve(result).then(
          () => undefined,
          (e) => report(state, adapter, 'flush', e)
        );
      } catch (e) {
        report(state, adapter, 'flush', e);
        return undefined;
      }
    });
    await Promise.all(pending);
  }

  /** @type {Telemetry} */
  const telemetry = {
    track,
    page,
    identify,
    timing,
    setContext,
    setConsent,
    addAdapter,
    flush,
    get enabled() {
      return state.enabled;
    },
    get consent() {
      return state.consent;
    },
    get sampleRate() {
      return state.sampleRate;
    },
    get context() {
      return deepMerge(state.context);
    },
    get adapters() {
      return state.adapters.map((a) => a.name);
    },
  };
  return telemetry;
}

// ── domain events → GA4 ecommerce ───────────────────────────────────────────────────────────────

/**
 * Numeric amount of a `Money`, or `undefined` when it cannot be read.
 * @param {unknown} money
 * @returns {number|undefined}
 */
function amountOf(money) {
  if (!isObj(money)) return undefined;
  const n = Number(money.amount);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {unknown} money
 * @returns {string|undefined}
 */
function currencyOf(money) {
  return isObj(money) && isName(money.currency) ? money.currency : undefined;
}

/**
 * IATA / airline code of a place, airline or bare code string.
 * @param {unknown} v
 * @returns {string|undefined}
 */
function codeOf(v) {
  if (isName(v)) return v;
  return isObj(v) && isName(v.code) ? v.code : undefined;
}

/**
 * `DEL-BOM / BOM-DEL` from slices (offer slices or search slice requests).
 * @param {unknown} slices
 * @returns {string|undefined}
 */
function routeOf(slices) {
  if (!Array.isArray(slices)) return undefined;
  /** @type {string[]} */
  const legs = [];
  for (const s of slices) {
    const o = isObj(s) ? codeOf(s.origin) : undefined;
    const d = isObj(s) ? codeOf(s.destination) : undefined;
    if (o && d) legs.push(`${o}-${d}`);
  }
  return legs.length ? legs.join(' / ') : undefined;
}

/**
 * First non‑empty string among the candidates.
 * @param {...unknown} values
 * @returns {string|undefined}
 */
function firstName(...values) {
  return values.find(isName);
}

/**
 * Drop `undefined` values (top level).
 * @param {Props} o
 * @returns {Props}
 */
function defined(o) {
  /** @type {Props} */
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * GA4 item for an offer: `item_id` = offer id, `item_name` = route, `item_brand` = owner airline
 * code, `price` = per‑pax amount (total when per‑pax is missing), `currency`, optional `index`.
 * @param {unknown} offer
 * @param {number} [index]
 * @returns {Props|undefined} `undefined` when neither id nor route can be read
 */
function offerItem(offer, index) {
  if (!isObj(offer)) return undefined;
  const price = isObj(offer.price) ? offer.price : undefined;
  const perPax = price && isObj(price.perPax) ? price.perPax : price?.total;
  const item = defined({
    item_id: isName(offer.id) ? offer.id : undefined,
    item_name: routeOf(offer.slices),
    item_brand: codeOf(offer.owner),
    price: amountOf(perPax),
    currency: currencyOf(perPax) || currencyOf(price?.total),
    index,
  });
  return item.item_id !== undefined || item.item_name !== undefined ? item : undefined;
}

/**
 * Items for a list of offers, indexed by position and capped at the GA4 limit.
 * @param {unknown} offers
 * @returns {Props[]}
 */
function itemsOf(offers) {
  /** @type {Props[]} */
  const out = [];
  if (!Array.isArray(offers)) return out;
  for (let i = 0; i < offers.length && out.length < MAX_ITEMS; i++) {
    const item = offerItem(offers[i], out.length);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Offers of a search session / results payload: combined `offers[]`, the store's `{ byId, allIds }`
 * map, or split‑mode `sliceOffers[][]` flattened.
 * @param {unknown} source
 * @returns {unknown[]}
 */
function offersOf(source) {
  if (!isObj(source)) return [];
  const { offers, sliceOffers } = source;
  if (Array.isArray(offers) && offers.length) return offers;
  if (isObj(offers) && Array.isArray(offers.allIds) && isObj(offers.byId)) {
    return offers.allIds.map((id) => offers.byId[id]);
  }
  if (Array.isArray(sliceOffers)) return sliceOffers.flat();
  return [];
}

/**
 * Find the entity an event payload carries: under one of `keys`, or the payload itself when the
 * module emitted the entity directly (the emitter spreads it next to `type` / `at`).
 * @param {unknown} payload
 * @param {string[]} keys
 * @param {(v: Record<string, any>) => boolean} looksLike
 * @returns {Record<string, any>|undefined}
 */
function entity(payload, keys, looksLike) {
  if (!isObj(payload)) return undefined;
  for (const k of keys) if (isObj(payload[k])) return payload[k];
  return looksLike(payload) ? payload : undefined;
}

/** @param {Record<string, any>} o */
const looksLikeOffer = (o) => Array.isArray(o.slices) && isObj(o.price);
/** @param {Record<string, any>} o */
const looksLikeItinerary = (o) => Array.isArray(o.offers) && isObj(o.price);
/** @param {Record<string, any>} o */
const looksLikeBooking = (o) => isObj(o.itinerary);
/** @param {Record<string, any>} o */
const looksLikeIntent = (o) => isObj(o.amount) && isName(o.bookingId);
/** @param {Record<string, any>} o */
const looksLikeSession = (o) =>
  Array.isArray(o.offers) || Array.isArray(o.sliceOffers) || isObj(o.offers);

/**
 * @param {unknown} itinerary
 * @returns {string|undefined}
 */
function couponOf(itinerary) {
  return isObj(itinerary) && isObj(itinerary.promo) && isName(itinerary.promo.code)
    ? itinerary.promo.code
    : undefined;
}

/**
 * `search:complete` → `view_item_list`.
 * @param {unknown} payload
 * @returns {Props}
 */
function viewItemList(payload) {
  const session = entity(payload, ['session', 'results', 'search'], looksLikeSession);
  const params = isObj(session) && isObj(session.params) ? session.params : undefined;
  const p = isObj(payload) ? payload : {};
  return defined({
    item_list_id: firstName(session?.id, p.sessionId, p.id),
    item_list_name: routeOf(params?.slices),
    items: itemsOf(offersOf(session)),
  });
}

/**
 * `offer:selected` → `select_item`.
 * @param {unknown} payload
 * @returns {Props}
 */
function selectItem(payload) {
  const p = isObj(payload) ? payload : {};
  const offer = entity(payload, ['offer', 'selected', 'item'], looksLikeOffer);
  const index = typeof p.index === 'number' && Number.isFinite(p.index) ? p.index : undefined;
  const item = offer ? offerItem(offer, index) : undefined;
  const items = item ? [item] : isName(p.offerId) ? [defined({ item_id: p.offerId, index })] : [];
  return defined({
    item_list_id: firstName(p.sessionId, p.searchSessionId),
    items,
  });
}

/**
 * Cart‑level params shared by `add_to_cart` / `begin_checkout`.
 * @param {unknown} itinerary
 * @returns {Props}
 */
function cartProps(itinerary) {
  const price = isObj(itinerary) && isObj(itinerary.price) ? itinerary.price : undefined;
  return defined({
    currency: currencyOf(price?.total),
    value: amountOf(price?.total),
    coupon: couponOf(itinerary),
    items: itemsOf(isObj(itinerary) ? itinerary.offers : undefined),
  });
}

/**
 * `itinerary:created` → `add_to_cart`.
 * @param {unknown} payload
 * @returns {Props}
 */
function addToCart(payload) {
  return cartProps(entity(payload, ['itinerary', 'cart'], looksLikeItinerary));
}

/**
 * The itinerary behind a booking‑shaped payload (or a bare itinerary payload).
 * @param {unknown} payload
 * @returns {{ booking: Record<string, any>|undefined, itinerary: Record<string, any>|undefined }}
 */
function bookingOf(payload) {
  const booking = entity(payload, ['booking', 'order', 'trip'], looksLikeBooking);
  const itinerary = booking
    ? booking.itinerary
    : entity(payload, ['itinerary'], looksLikeItinerary);
  return { booking, itinerary };
}

/**
 * `booking:created` → `begin_checkout`.
 * @param {unknown} payload
 * @returns {Props}
 */
function beginCheckout(payload) {
  return cartProps(bookingOf(payload).itinerary);
}

/**
 * `payment:intentCreated` → `add_payment_info`.
 * @param {unknown} payload
 * @returns {Props}
 */
function addPaymentInfo(payload) {
  const intent = entity(payload, ['intent', 'paymentIntent'], looksLikeIntent);
  const { itinerary } = bookingOf(payload);
  const amount = intent && isObj(intent.amount) ? intent.amount : itinerary?.price?.total;
  return defined({
    currency: currencyOf(amount),
    value: amountOf(amount),
    payment_type:
      intent && isObj(intent.method) && isName(intent.method.type) ? intent.method.type : undefined,
    coupon: couponOf(itinerary),
    items: itemsOf(itinerary?.offers),
  });
}

/**
 * `booking:ticketed` → `purchase`.
 * @param {unknown} payload
 * @returns {Props}
 */
function purchase(payload) {
  const { booking, itinerary } = bookingOf(payload);
  const p = isObj(payload) ? payload : {};
  const paid = booking && isObj(booking.payment) ? booking.payment.total : undefined;
  const total = isObj(paid) ? paid : itinerary?.price?.total;
  return defined({
    transaction_id: firstName(booking?.reference, booking?.id, p.bookingId),
    currency: currencyOf(total),
    value: amountOf(total),
    tax: amountOf(itinerary?.price?.taxes),
    coupon: couponOf(itinerary),
    items: itemsOf(itinerary?.offers),
  });
}

/**
 * `trip:cancelled` → `refund`. `value` is the refunded amount when the payload carries one
 * (`cancellation.refund.amount` / `refund.amount`); it is never assumed to be the full total.
 * @param {unknown} payload
 * @returns {Props}
 */
function refund(payload) {
  const { booking, itinerary } = bookingOf(payload);
  const p = isObj(payload) ? payload : {};
  const cancellation = isObj(p.cancellation) ? p.cancellation : undefined;
  const refundObj = cancellation && isObj(cancellation.refund) ? cancellation.refund : p.refund;
  const refunded = isObj(refundObj) ? refundObj.amount : undefined;
  const paid = booking && isObj(booking.payment) ? booking.payment.total : undefined;
  return defined({
    transaction_id: firstName(
      booking?.reference,
      booking?.id,
      cancellation?.bookingId,
      p.bookingId
    ),
    currency: currencyOf(refunded) || currencyOf(paid) || currencyOf(itinerary?.price?.total),
    value: amountOf(refunded),
    items: itemsOf(itinerary?.offers),
  });
}

/**
 * SDK event → `[GA4 event name, props builder]` (docs/api/03-utils.md §10).
 * @type {Readonly<Record<string, [string, (payload: unknown) => Props]>>}
 */
const DOMAIN_EVENTS = Object.freeze({
  'search:complete': ['view_item_list', viewItemList],
  'offer:selected': ['select_item', selectItem],
  'itinerary:created': ['add_to_cart', addToCart],
  'booking:created': ['begin_checkout', beginCheckout],
  'payment:intentCreated': ['add_payment_info', addPaymentInfo],
  'booking:ticketed': ['purchase', purchase],
  'trip:cancelled': ['refund', refund],
});

/**
 * Subscribe to the SDK's domain events and replay them as GA4 ecommerce events through
 * `telemetry.track`: `search:complete` → `view_item_list`, `offer:selected` → `select_item`,
 * `itinerary:created` → `add_to_cart`, `booking:created` → `begin_checkout`,
 * `payment:intentCreated` → `add_payment_info`, `booking:ticketed` → `purchase`,
 * `trip:cancelled` → `refund`. Each payload may carry the entity under its usual key (`session`,
 * `offer`, `itinerary`, `booking`, `trip`, `intent`, `cancellation`) or be the entity itself.
 * Items: `item_id` = offer id, `item_name` = route, `item_brand` = owner airline code, `price` =
 * per‑pax amount, `currency`; lists cover both combined `offers[]` and split‑mode `sliceOffers[][]`
 * and are capped at 200 items. The gates of `telemetry` (enabled, consent, sampling) still apply.
 * Effects: listeners on `events` until the returned `off()` is called (idempotent).
 * @param {Telemetry} telemetry
 * @param {{ on: (event: string, fn: (payload: any) => void) => (() => void) | void, off?: (event: string, fn: (payload: any) => void) => void }} events
 * @returns {() => void} unsubscribe everything
 * @throws {ValidationError} when `telemetry` has no `track()` or `events` has no `on()`
 */
export function bindDomainEvents(telemetry, events) {
  if (!isObj(telemetry) || typeof telemetry.track !== 'function') {
    throw invalid('telemetry', 'type', 'telemetry must be a Telemetry with track()');
  }
  if (!isObj(events) || typeof events.on !== 'function') {
    throw invalid('events', 'type', 'events must be an emitter with on()');
  }
  /** @type {(() => void)[]} */
  const offs = [];
  for (const name of Object.keys(DOMAIN_EVENTS)) {
    const [commerceEvent, toProps] = DOMAIN_EVENTS[name];
    /** @param {unknown} payload */
    const listener = (payload) => {
      telemetry.track(commerceEvent, toProps(payload));
    };
    const remove = events.on(name, listener);
    offs.push(
      typeof remove === 'function'
        ? remove
        : () => {
            if (typeof events.off === 'function') events.off(name, listener);
          }
    );
  }
  let bound = true;
  return function off() {
    if (!bound) return;
    bound = false;
    for (const remove of offs) {
      try {
        remove();
      } catch {
        // Already unsubscribed (e.g. the emitter was cleared).
      }
    }
  };
}

// ── adapters ────────────────────────────────────────────────────────────────────────────────────

/**
 * A vendor global looked up at call time (never at import time): `globalThis[key]` when it has the
 * expected shape.
 * @param {string} key
 * @param {'function'|'object'} type
 * @returns {any}
 */
function vendorGlobal(key, type) {
  const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis))[key];
  if (type === 'function') return typeof g === 'function' ? g : undefined;
  return isObj(g) || typeof g === 'function' ? g : undefined;
}

/**
 * Google Analytics 4 through `gtag.js`: `track` → `gtag('event', name, props)`, `page` →
 * `gtag('event', 'page_view', { page_title, ...props })`, `identify` → `gtag('set', { user_id })`
 * plus `gtag('set', 'user_properties', traits)` when traits are given. `gtag` defaults to
 * `globalThis.gtag` resolved per call; calls are dropped while it is absent.
 * Effects: none beyond the `gtag` calls.
 * @param {{ gtag?: (...args: any[]) => void }} [options]
 * @returns {TelemetryAdapter}
 * @throws {ConfigError} when `gtag` is given but not a function
 */
export function ga4Adapter(options = {}) {
  const o = optionsOf(options, 'ga4Adapter');
  if (o.gtag !== undefined && o.gtag !== null && typeof o.gtag !== 'function') {
    throw new ConfigError('ga4Adapter: gtag must be a function');
  }
  /** @param {...unknown} args */
  const call = (...args) => {
    const fn = o.gtag || vendorGlobal('gtag', 'function');
    if (fn) fn(...args);
  };
  return {
    name: 'ga4',
    track(event, props) {
      call('event', event, props || {});
    },
    page(name, props) {
      call('event', PAGE_EVENT, { page_title: name, ...props });
    },
    identify(userId, traits) {
      call('set', { user_id: userId });
      if (traits && Object.keys(traits).length) call('set', 'user_properties', traits);
    },
  };
}

/**
 * Google Tag Manager through the `dataLayer`: `track` pushes `{ event, ...props }`; when `props.items`
 * is an array the GA4 ecommerce params (`items`, `currency`, `value`, `transaction_id`, `tax`,
 * `coupon`, `payment_type`, …) go under `ecommerce`, preceded by `{ ecommerce: null }` as GTM
 * recommends. `page` pushes `page_view` with `page_title`; `identify` pushes
 * `{ event: 'identify', user_id, user_properties }`. `dataLayer` defaults to `globalThis.dataLayer`
 * resolved per call; pushes are dropped while it is absent.
 * Effects: none beyond the `dataLayer` pushes.
 * @param {{ dataLayer?: { push: (entry: object) => unknown } }} [options]
 * @returns {TelemetryAdapter}
 * @throws {ConfigError} when `dataLayer` is given but has no `push()`
 */
export function gtmAdapter(options = {}) {
  const o = optionsOf(options, 'gtmAdapter');
  if (o.dataLayer !== undefined && o.dataLayer !== null) {
    if (!isObj(o.dataLayer) || typeof o.dataLayer.push !== 'function') {
      throw new ConfigError('gtmAdapter: dataLayer must expose push()');
    }
  }
  /** @param {Props} entry */
  const push = (entry) => {
    const layer = o.dataLayer || vendorGlobal('dataLayer', 'object');
    if (layer && typeof layer.push === 'function') layer.push(entry);
  };
  return {
    name: 'gtm',
    track(event, props) {
      const p = props || {};
      if (!Array.isArray(p.items)) {
        push({ ...p, event });
        return;
      }
      /** @type {Props} */
      const ecommerce = {};
      /** @type {Props} */
      const rest = {};
      for (const key of Object.keys(p)) (ECOMMERCE_KEYS.has(key) ? ecommerce : rest)[key] = p[key];
      push({ ecommerce: null });
      push({ ...rest, ecommerce, event });
    },
    page(name, props) {
      push({ page_title: name, ...props, event: PAGE_EVENT });
    },
    identify(userId, traits) {
      push({ event: 'identify', user_id: userId, user_properties: traits || {} });
    },
  };
}

/**
 * Segment (`analytics.js` / `@segment/analytics-next`): `track`, `page` and `identify` are forwarded
 * one‑to‑one; `flush` awaits `analytics.flush()` when the SDK has one. `analytics` defaults to
 * `globalThis.analytics` resolved per call; calls are dropped while it is absent.
 * Effects: none beyond the `analytics` calls.
 * @param {{ analytics?: { track?: Function, page?: Function, identify?: Function, flush?: Function } }} [options]
 * @returns {TelemetryAdapter}
 * @throws {ConfigError} when `analytics` is given but is not an object
 */
export function segmentAdapter(options = {}) {
  const o = optionsOf(options, 'segmentAdapter');
  if (o.analytics !== undefined && o.analytics !== null && !isObj(o.analytics)) {
    throw new ConfigError('segmentAdapter: analytics must be an object');
  }
  /**
   * @param {string} method
   * @param {...unknown} args
   * @returns {unknown}
   */
  const call = (method, ...args) => {
    const sdk = o.analytics || vendorGlobal('analytics', 'object');
    return sdk && typeof sdk[method] === 'function' ? sdk[method](...args) : undefined;
  };
  return {
    name: 'segment',
    track(event, props) {
      call('track', event, props || {});
    },
    page(name, props) {
      call('page', name, props || {});
    },
    identify(userId, traits) {
      call('identify', userId, traits || {});
    },
    flush() {
      return Promise.resolve(call('flush')).then(() => undefined);
    },
  };
}

/**
 * Development sink. A function `sink` receives `{ kind, event, props }`; a console‑like `sink` gets
 * `debug('[wayfarer:telemetry] <kind> <event>', props)` (falling back to `log`). Without `sink`,
 * `globalThis.console` is used, resolved per call (SSR‑safe, silent where there is none).
 * Effects: writes to the sink.
 * @param {{ sink?: ((entry: TelemetryEvent) => void) | { debug?: Function, log?: Function } }} [options]
 * @returns {TelemetryAdapter}
 * @throws {ConfigError} when `sink` is neither a function nor an object
 */
export function consoleAdapter(options = {}) {
  const o = optionsOf(options, 'consoleAdapter');
  if (o.sink !== undefined && o.sink !== null && typeof o.sink !== 'function' && !isObj(o.sink)) {
    throw new ConfigError('consoleAdapter: sink must be a function or a console-like object');
  }
  /**
   * @param {TelemetryKind} kind
   * @param {string} event
   * @param {Props} props
   */
  const write = (kind, event, props) => {
    const target = o.sink || vendorGlobal('console', 'object');
    if (!target) return;
    if (typeof target === 'function') {
      target({ kind, event, props });
      return;
    }
    const fn = typeof target.debug === 'function' ? target.debug : target.log;
    if (typeof fn === 'function') fn.call(target, `[wayfarer:telemetry] ${kind} ${event}`, props);
  };
  return {
    name: 'console',
    track(event, props) {
      write('track', event, props || {});
    },
    page(name, props) {
      write('page', name, props || {});
    },
    identify(userId, traits) {
      write('identify', String(userId), traits || {});
    },
  };
}

/**
 * First‑party collector: every call is POSTed to `url` as JSON `{ kind, event, props, at }`, through
 * `navigator.sendBeacon` when the runtime has it (a `Blob` of type `application/json`), else through
 * `fetch(url, { method: 'POST', keepalive: true })` (`fetch` option, default `globalThis.fetch`,
 * both resolved per call). A beacon the browser refuses (queue full) falls back to `fetch`. Fetch
 * failures are swallowed; `flush` settles once the in‑flight fetches have. Nothing is sent when
 * neither transport exists.
 * Effects: net `POST <url>`.
 * @param {{ url: string, fetch?: typeof fetch }} options
 * @returns {TelemetryAdapter}
 * @throws {ConfigError} when `url` is missing or `fetch` is not a function
 */
export function beaconAdapter(options) {
  const o = optionsOf(options, 'beaconAdapter');
  if (!isName(o.url)) throw new ConfigError('beaconAdapter: url must be a non-empty string');
  if (o.fetch !== undefined && o.fetch !== null && typeof o.fetch !== 'function') {
    throw new ConfigError('beaconAdapter: fetch must be a function');
  }
  const url = o.url;
  /** @type {Set<Promise<unknown>>} */
  const inflight = new Set();

  /**
   * @param {TelemetryKind} kind
   * @param {string} event
   * @param {Props} props
   */
  const send = (kind, event, props) => {
    const body = JSON.stringify({ kind, event, props, at: Date.now() });
    const nav = vendorGlobal('navigator', 'object');
    if (nav && typeof nav.sendBeacon === 'function') {
      try {
        const BlobCtor = vendorGlobal('Blob', 'function');
        const payload = BlobCtor ? new BlobCtor([body], { type: 'application/json' }) : body;
        if (nav.sendBeacon(url, payload) === true) return;
      } catch {
        // Fall through to fetch.
      }
    }
    const f = o.fetch || vendorGlobal('fetch', 'function');
    if (!f) return;
    const request = Promise.resolve(
      f.call(globalThis, url, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body,
      })
    );
    inflight.add(request);
    const settle = () => inflight.delete(request);
    request.then(settle, settle);
  };
  return {
    name: 'beacon',
    track(event, props) {
      send('track', event, props || {});
    },
    page(name, props) {
      send('page', name, props || {});
    },
    identify(userId, traits) {
      send('identify', String(userId), traits || {});
    },
    flush() {
      return Promise.allSettled([...inflight]).then(() => undefined);
    },
  };
}
