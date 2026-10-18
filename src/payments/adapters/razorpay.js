/**
 * PLACEHOLDER — `@wayfarer/sdk/payments/razorpay` entry (docs/api/07-booking.md §2 gateway adapters).
 * The Razorpay gateway adapter is not built yet; this file only exists so the `payments-razorpay` entry
 * of package.json / vite.config.js resolves. `razorpayAdapter` throws `UnsupportedError` until the real
 * adapter (vendor script loaded at call time, never bundled) lands. No state, no I/O, no logic of its
 * own: replace it, do not extend it.
 */

import { UnsupportedError } from '../../errors/index.js';

/**
 * Create the Razorpay `GatewayAdapter` for `createPayments({ gateways })`. Not available yet.
 * @param {Record<string, unknown>} [_options]
 * @returns {never}
 * @throws {UnsupportedError} always (`feature: 'payments.razorpay'`) — the adapter is not built yet
 */
export function razorpayAdapter(_options) {
  throw new UnsupportedError('payments/razorpay adapter not built yet', {
    feature: 'payments.razorpay',
  });
}
