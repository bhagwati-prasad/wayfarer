/**
 * PLACEHOLDER — `@wayfarer/sdk/payments/paypal` entry (docs/api/07-booking.md §2 gateway adapters).
 * The PayPal gateway adapter is not built yet; this file only exists so the `payments-paypal` entry
 * of package.json / vite.config.js resolves. `paypalAdapter` throws `UnsupportedError` until the real
 * adapter (vendor script loaded at call time, never bundled) lands. No state, no I/O, no logic of its
 * own: replace it, do not extend it.
 */

import { UnsupportedError } from '../../errors/index.js';

/**
 * Create the PayPal `GatewayAdapter` for `createPayments({ gateways })`. Not available yet.
 * @param {Record<string, unknown>} [_options]
 * @returns {never}
 * @throws {UnsupportedError} always (`feature: 'payments.paypal'`) — the adapter is not built yet
 */
export function paypalAdapter(_options) {
  throw new UnsupportedError('payments/paypal adapter not built yet', {
    feature: 'payments.paypal',
  });
}
