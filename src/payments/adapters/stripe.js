/**
 * PLACEHOLDER — `@wayfarer/sdk/payments/stripe` entry (docs/api/07-booking.md §2 gateway adapters).
 * The Stripe gateway adapter is not built yet; this file only exists so the `payments-stripe` entry
 * of package.json / vite.config.js resolves. `stripeAdapter` throws `UnsupportedError` until the real
 * adapter (vendor script loaded at call time, never bundled) lands. No state, no I/O, no logic of its
 * own: replace it, do not extend it.
 */

import { UnsupportedError } from '../../errors/index.js';

/**
 * Create the Stripe `GatewayAdapter` for `createPayments({ gateways })`. Not available yet.
 * @param {Record<string, unknown>} [_options]
 * @returns {never}
 * @throws {UnsupportedError} always (`feature: 'payments.stripe'`) — the adapter is not built yet
 */
export function stripeAdapter(_options) {
  throw new UnsupportedError('payments/stripe adapter not built yet', {
    feature: 'payments.stripe',
  });
}
