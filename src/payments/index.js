/**
 * PLACEHOLDER — `@wayfarer/sdk/payments` entry (docs/api/07-booking.md §2, docs/README.md §3). The
 * isolated payments package is not built yet; this file only exists so the `payments` entry of
 * package.json / vite.config.js resolves. `createPayments` throws `UnsupportedError{feature:'payments'}`
 * until the real port lands (`createClient` without `config.payments` already runs on its null port).
 * No state, no I/O, no logic of its own: replace it, do not extend it.
 */

import { UnsupportedError } from '../errors/index.js';

/**
 * Create the `PaymentsPort` for `createClient({ payments })` (docs/api/07-booking.md §2). Not
 * available yet.
 * @param {Record<string, unknown>} [_options]  `{ gateways, returnUrl, http?, store?, events? }`
 * @returns {never}
 * @throws {UnsupportedError} always (`feature: 'payments'`) — the payments package is not built yet
 */
export function createPayments(_options) {
  throw new UnsupportedError('payments not built yet', { feature: 'payments' });
}
