/**
 * UMD entry of the Wayfarer SDK: everything the single‑file build exposes as `window.Wayfarer`
 * (docs/README.md §3). Today it is the public core entry (`createClient`, config, http, auth, store,
 * events, storage, errors, i18n, telemetry, features, logger, `utils`, `VERSION`) plus the `ui` and
 * `payments` namespaces (`@wayfarer/sdk/ui`, `@wayfarer/sdk/payments`, placeholders until those
 * packages are built). No logic lives in this file and nothing runs at import time beyond the
 * re‑exports.
 */

export * from './index.js';
export * as ui from './ui/index.js';
export * as payments from './payments/index.js';
