/**
 * Utilities barrel of the Wayfarer SDK — the `@wayfarer/sdk/utils` entry and `client.utils`
 * (docs/api/03-utils.md). Re‑exports every `utils/*` script under its namespace (`money.formatMoney`,
 * `datetime.formatDuration`, `object.deepMerge`, …) and, flat, every documented helper of the
 * scripts without a factory (money, datetime, format, validation, async, id, url) except `object`'s
 * generic names (`get`, `set`, `hash`, `range`, …), which stay namespaced to keep the flat surface
 * unambiguous.
 * It contains no logic of its own: nothing here runs at import time beyond the re‑exports, so the
 * barrel is as SSR‑safe and dependency‑free as the scripts it aggregates. It must not re‑export
 * anything outside `src/utils/` and must not grow helpers of its own (those belong in the
 * responsible script).
 */

// ── namespaces ──────────────────────────────────────────────────────────────────────────────────

export * as money from './money.js';
export * as datetime from './datetime.js';
export * as format from './format.js';
export * as validation from './validation.js';
export * as async from './async.js';
export * as object from './object.js';
export * as id from './id.js';
export * as url from './url.js';
export * as i18n from './i18n.js';
export * as telemetry from './telemetry.js';
export * as logger from './logger.js';
export * as features from './features.js';

// ── flat re‑exports of the most used helpers ────────────────────────────────────────────────────

export { formatMoney, parseMoney, pricePerPax, currencyInfo } from './money.js';
export {
  formatTime,
  formatDate,
  formatDateTime,
  formatDateRange,
  formatDuration,
  durationBetween,
  dayDiff,
  relativeTime,
  countdown,
  ageAt,
  paxTypeForAge,
} from './datetime.js';
export {
  formatPlace,
  formatRoute,
  formatStops,
  formatLayovers,
  formatPaxSummary,
  formatFlightNumber,
  formatName,
  maskEmail,
  maskPhone,
  maskCard,
  titleCase,
  truncate,
} from './format.js';
export {
  validate,
  schemas,
  isEmail,
  isPhone,
  isIata,
  isPostalCode,
  isPassportNumber,
  isGstin,
  isPan,
  isVpa,
  isLuhn,
  isNameValid,
  namesFitTicket,
  documentValid,
  paxCountsValid,
  travelerMatchesSlot,
  cardBrand,
  cardExpiryValid,
  issuesByPath,
  firstIssue,
} from './validation.js';
export {
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
} from './async.js';
export {
  deepMerge,
  deepFreeze,
  deepEqual,
  shallowEqual,
  clone,
  pick,
  omit,
  isPlainObject,
  stableStringify,
} from './object.js';
export { uuid, shortId, requestId, idempotencyKey, isUuid } from './id.js';
export {
  buildQuery,
  parseQuery,
  joinUrl,
  withParams,
  encodeSearchParams,
  decodeSearchParams,
  encodeState,
  decodeState,
} from './url.js';
export { createI18n } from './i18n.js';
export {
  createTelemetry,
  bindDomainEvents,
  ga4Adapter,
  gtmAdapter,
  segmentAdapter,
  consoleAdapter,
  beaconAdapter,
} from './telemetry.js';
export { createLogger } from './logger.js';
export { createFeatures } from './features.js';
