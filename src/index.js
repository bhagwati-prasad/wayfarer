/**
 * Public entry of `@wayfarer/sdk` (docs/README.md §3): `createClient` plus every core building block
 * a host may wire by hand — config (`defineConfig`, `DEFAULTS`), HTTP (`createHttp`, the interceptor
 * factories and `installDefaultInterceptors`), auth (`createAuth`, `createAccess`,
 * `DEFAULT_ACCESS_POLICY`), endpoints, store, events, storage, the error taxonomy, i18n, telemetry
 * (+ adapters), features, logger, the `utils` namespace and `VERSION`. Domain modules attach to the
 * client as they register in `src/modules/index.js`. This entry carries no UI (`@wayfarer/sdk/ui`),
 * no payments package (`@wayfarer/sdk/payments`) and no mock server (`@wayfarer/sdk/mock`); it has
 * no logic of its own and nothing here runs at import time beyond the re‑exports.
 */

// ── client + config ─────────────────────────────────────────────────────────────────────────────
export { createClient, VERSION } from './core/client.js';
export { defineConfig, validateConfig, DEFAULTS } from './core/config.js';
export { createEndpoints, DEFAULT_ENDPOINTS } from './core/endpoints.js';

// ── http ────────────────────────────────────────────────────────────────────────────────────────
export { createHttp } from './http/client.js';
export {
  installDefaultInterceptors,
  DEFAULT_PRIORITIES,
  authInterceptor,
  apiKeyInterceptor,
  localeInterceptor,
  correlationInterceptor,
  idempotencyInterceptor,
  envelopeInterceptor,
  problemInterceptor,
  rateLimitInterceptor,
  cacheInterceptor,
  dedupeInterceptor,
  csrfInterceptor,
  deviceInterceptor,
  telemetryInterceptor,
  loggingInterceptor,
  mockInterceptor,
} from './http/interceptors.js';

// ── auth ────────────────────────────────────────────────────────────────────────────────────────
export { createAuth } from './auth/session.js';
export { createAccess, DEFAULT_ACCESS_POLICY } from './auth/access.js';

// ── state, events, storage ──────────────────────────────────────────────────────────────────────
export { createStore, createSelector, shallowEqual } from './state/store.js';
export { createEmitter } from './events/emitter.js';
export { createStorage, memoryDriver, webStorageDriver, cookieDriver } from './storage/adapters.js';

// ── errors ──────────────────────────────────────────────────────────────────────────────────────
export * from './errors/index.js';

// ── utilities with a factory ────────────────────────────────────────────────────────────────────
export { createI18n } from './utils/i18n.js';
export {
  createTelemetry,
  bindDomainEvents,
  ga4Adapter,
  gtmAdapter,
  segmentAdapter,
  consoleAdapter,
  beaconAdapter,
} from './utils/telemetry.js';
export { createFeatures } from './utils/features.js';
export { createLogger } from './utils/logger.js';

// ── utils namespace (`client.utils`, `@wayfarer/sdk/utils`) ─────────────────────────────────────
export * as utils from './utils/index.js';
