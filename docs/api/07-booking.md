# 07 · Booking & payments: `booking`, `payments`

Scripts: `modules/booking.js`, `modules/payments.js`.
A **booking** is created from a validated itinerary; it then owes money (`pending_payment`) or is held (`on_hold`). A **payment intent** settles that amount through a gateway adapter; the booking is then confirmed/ticketed asynchronously.

---

## 1. `modules/booking.js`

#### `booking.create(itineraryId?, { consents: { terms: string, privacy?: string, fareRules: boolean, marketing? }, metadata?, idempotencyKey? } = {}, opts?) → Promise<Booking>`
Run `itinerary.validate()` and `itinerary.reprice()`, then create the booking (`pending_payment`). Idempotent: the key defaults to a hash of itinerary id + travelers.
Effects: net `POST /itineraries/{id}/price`, `POST /bookings` (with `Idempotency-Key`) · state `booking.current`, `itinerary.status = booked` · storage `booking.lastReference` · emit `booking:created` · telemetry `begin_checkout`.
Throws: `ValidationError`, `PriceChangedError` (unaccepted change), `ItineraryExpiredError`, `OfferUnavailableError`, `BookingError{stage:'create'}`.

#### `booking.holdOptions(itineraryId?, opts?) → Promise<HoldOption[]>`
Book‑now‑pay‑later options. The policy is decided by the backend **per flight** (`Offer.hold`): none, free for a window (e.g. 24 h), or paid for longer; `onExpiry` says whether an unpaid hold is dropped, charged or converted. Resolves `[]` when holding is not allowed.
Effects: net `GET /itineraries/{id}/hold-options` (skipped when `Offer.hold.allowed === false`).

#### `booking.hold(itineraryId?, { holdOptionId, consents, metadata? }, opts?) → Promise<Booking>`
Create an `on_hold` booking with `holdExpiresAt`; a hold fee (if any) is paid via `payments.*`. A timer emits `booking:holdExpiring` (T‑24 h and T‑1 h) and `booking:holdExpired`; after expiry the backend applies the option's `onExpiry`.
Effects: net `POST /bookings` (`mode: 'hold'`) · state `booking.current` · storage · timer · emit `booking:held`, `booking:created`.
Throws: `ApiError{code:'HOLD_NOT_ALLOWED'}` + those of `create`.

#### `booking.get(bookingId, { fresh? } = {}, opts?) → Promise<Booking>` · `booking.current() → Booking|null` · `booking.status() → BookingStatus|null`
Effects: net `GET /bookings/{id}` · state `booking.current`.

#### `booking.resume(opts?) → Promise<Booking|null>`
Reload the last booking reference from storage (used after payment redirects and reloads). Effects: net `GET /bookings/{id}` · state.

#### `booking.finalize(bookingId?, opts?) → Promise<Booking>`
Tell the backend payment is complete when the gateway confirmed client‑side (no‑op when the server already knows); then `waitForTicketing`.
Effects: net `POST /bookings/{id}/confirm` · state · emit `booking:statusChanged`.

#### `booking.waitForTicketing(bookingId?, { timeoutMs? = 120000, intervalMs? } = {}, opts?) → Promise<Booking>`
Poll until `ticketed | confirmed | partially_ticketed | failed` (or stream when available). Resolves on terminal success, rejects on failure.
Effects: net `GET /bookings/{id}` ×n | `GET /bookings/{id}/stream` · state `booking.current`, `booking.polling` · timer · emit `booking:statusChanged`, `booking:confirmed`, `booking:ticketed` | `booking:failed` · telemetry `purchase`.
Throws: `BookingError{stage:'ticketing', suggestedAction}`, `TimeoutError` (status stays `processing`; UI should show "we'll email you").

#### `booking.abandon(bookingId?, opts?) → Promise<void>`
Cancel a `pending_payment` / `on_hold` booking before paying (releases inventory).
Effects: net `POST /bookings/{id}/abandon` · state `booking` reset · storage remove · emit `booking:abandoned`.

#### `booking.retrieve({ reference, lastName, email? }, opts?) → Promise<Booking>`
Guest lookup by PNR / OTA reference + surname; grants a scoped token for servicing that booking.
Effects: net `POST /bookings/retrieve` · state `booking.current`, `trips.byId`, `session.scopedTokens[bookingId]`.
Throws: `NotFoundError`, `RateLimitError`.

#### `booking.documents(bookingId?, opts?) → Promise<Document[]>` · `booking.download(bookingId, type: Document['type'], opts?) → Promise<Blob>`
Effects: net `GET /bookings/{id}/documents`, `GET /bookings/{id}/documents/{type}`.

#### `booking.resendConfirmation(bookingId?, { email?, phone?, channel? } = {}, opts?) → Promise<void>`
Effects: net `POST /bookings/{id}/resend`.

#### `booking.calendar(booking?) → { ics: string, links: { google: string, outlook: string, yahoo: string } }`
One VEVENT per segment with PNR, terminal and check‑in reminder. Effects: none.

#### `booking.share(booking?) → { url, text }`
Effects: none.

#### `booking.timeline(bookingId?, opts?) → Promise<{ at, type, detail }[]>`
Created / paid / ticketed / changed / cancelled audit trail. Effects: net `GET /bookings/{id}/timeline`.

#### `booking.failureInfo(booking?) → BookingFailure|null`
Normalised failure with `suggestedAction` (`retry_payment` when money not taken, `search_again` when inventory lost, `wait` when ticketing is queued, `contact_support` when paid but failed). Effects: none.

#### `booking.clear() → void`
Effects: state `booking`, `payment` reset · storage remove · timer clear.

---

## 2. `payments/index.js` (isolated package `@wayfarer/sdk/payments`)

Payments are **not** part of the domain SDK. `createPayments({ gateways, returnUrl, http?, store?, events? })` returns a `PaymentsPort`; the host passes it to `createClient({ payments })`, which wires http/store/events into it. Domain modules (`booking`, `trips`, `itinerary.lock`) only call the port; with no port installed, those flows stop at `pending_payment` and `booking.failureInfo` reports `suggestedAction:'retry_payment'`. Gateway adapters ship as separate scripts so a bundle only carries the ones imported:

| adapter | script | how it works |
|---|---|---|
| `stripeAdapter({ publishableKey, appearance?, locale? })` | `payments/adapters/stripe.js` | loads Stripe.js, mounts Payment Element / Express Checkout (Apple/Google Pay) against `intent.clientSecret`, `confirm` = `stripe.confirmPayment` with `redirect:'if_required'`, 3‑DS handled by Stripe; `handleAction` for redirect returns |
| `paypalAdapter({ clientId, currency?, intent? })` | `payments/adapters/paypal.js` | loads PayPal JS SDK, mounts Smart Buttons; `createOrder` → backend intent, `onApprove` → `payments.confirm({ gatewayPayload: { orderID } })`; Pay Later / Venmo buttons when eligible |
| `razorpayAdapter({ keyId, theme?, prefill? })` | `payments/adapters/razorpay.js` | loads Checkout.js, opens Razorpay Checkout for cards / UPI (collect + intent) / net‑banking / wallets / EMI with `order_id` from the intent; `handler` → `payments.confirm({ gatewayPayload: { razorpay_payment_id, razorpay_signature } })`; dismiss → `payments.cancel` |

All adapters implement `GatewayAdapter` (00‑types). Adding Adyen / Braintree / PayU later means one more script, no domain change.

#### `payments.methods(bookingId?, { fresh? } = {}, opts?) → Promise<PaymentMethod[]>`
Methods available for this booking's amount/currency/market: cards, UPI, net‑banking, wallets, Apple/Google Pay, PayPal, BNPL/EMI, bank transfer, pay‑later, OTA wallet, loyalty points, gift cards, vouchers; each with fees and saved instruments.
Effects: net `GET /bookings/{id}/payment-methods` · state `payment.methods`.

#### `payments.quote(bookingId?, { method: PaymentMethodType, savedMethodId?, credits?, emiPlanId?, currency? }, opts?) → Promise<PaymentQuote>`
Payable total after surcharges, credits and FX for the chosen method (shown on the pay button).
Effects: net `POST /bookings/{id}/payment-quote` · state `payment.quote`.

#### `payments.credits.apply(bookingId?, { wallet?: Money|'max', points?: number|'max', giftCardCode?, voucherId? }, opts?) → Promise<PaymentQuote>` · `payments.credits.remove(bookingId?, type, opts?) → Promise<PaymentQuote>` · `payments.credits.applied() → PaymentQuote['credits']`
Split part of the amount to stored value; remainder goes to the primary method.
Effects: net `POST|DELETE /bookings/{id}/credits` · state `payment.credits`, `payment.quote` · emit `wallet:updated` (reserved balance).
Throws: `ApiError{code:'GIFT_CARD_INVALID'|'INSUFFICIENT_BALANCE'|'VOUCHER_NOT_APPLICABLE'}`.

#### `payments.emiPlans(bookingId?, { bin?, bank? }, opts?) → Promise<EmiPlan[]>`
Effects: net `GET /bookings/{id}/emi-plans`.

#### `payments.createIntent(bookingId?, { method: PaymentMethodType, gateway?, savedMethodId?, saveMethod?, emiPlanId?, billingAddress?, returnUrl?, currency?, metadata? }, opts?) → Promise<PaymentIntent>`
Create the server‑side intent for the quoted amount (after credits). Persists the intent id so a redirect round‑trip can be resumed.
Effects: net `POST /bookings/{id}/payments` (idempotent per booking+method) · state `payment.intent`, `payment.status` · storage `payment.intent.id`, `payment.returnState` · emit `payment:intentCreated`.
Throws: `PaymentError{reason:'method_unavailable'}`, `BookingError` (booking no longer payable).

#### `payments.gateways.register(adapter: GatewayAdapter) → void` · `payments.gateways.get(name) → GatewayAdapter` · `payments.gateways.list() → string[]`
Adapters wrap Stripe / Adyen / Razorpay / Braintree / Checkout.com / Juspay etc.; the SDK never sees raw PANs when the adapter uses hosted fields.
Effects: none (registration); `adapter.load()` may inject a script tag.

#### `payments.mount(intent, container: HTMLElement, { style?, fields? } = {}) → Promise<GatewayElement>`
Mount the gateway's hosted payment element for `intent.method.gateway`. Effects: dom · gateway script load.

#### `payments.tokenize(element: GatewayElement, billing?: Address) → Promise<{ token, brand?, last4? }>`
For gateways that tokenize before confirm. Effects: gateway network call (not through `http`).

#### `payments.confirm(intentId?, { token?, element?, vpa?, bankCode?, walletProvider?, upiFlow?: 'collect'|'intent', deviceData?, consent? } = {}, opts?) → Promise<PaymentIntent>`
Submit the instrument. Resolves with status `processing | requires_action | succeeded`.
Effects: net `POST /payments/{id}/confirm` (and/or gateway `confirm`) · state `payment.intent` · emit `payment:processing | payment:actionRequired | payment:succeeded`.
Throws: `PaymentError`.

#### `payments.handleAction(intent?, { container?: HTMLElement, onRedirect?: (url) => boolean } = {}) → Promise<PaymentIntent>`
Drive `intent.action`: 3‑DS iframe challenge, full‑page redirect (persists state first), UPI collect polling with countdown, UPI intent deep link / QR, OTP, native wallet SDK. Then continues to `waitForResult`.
Effects: dom (iframe / QR) · nav (redirect; `onRedirect` returning `false` suppresses) · storage `payment.returnState` · state `payment.action` · timer · emit `payment:actionRequired`, `payment:redirecting`.

#### `payments.waitForResult(intentId?, { timeoutMs? = 180000 } = {}, opts?) → Promise<PaymentIntent>`
Poll / stream until terminal. Effects: net `GET /payments/{id}` ×n · state · timer · emit `payment:succeeded | payment:failed | payment:cancelled`.
Throws: `PaymentError`, `TimeoutError`.

#### `payments.pay(bookingId?, params: Parameters<createIntent>[1] & Parameters<confirm>[1], ui?: { container, onRedirect }) → Promise<{ intent, booking }>`
Convenience pipeline: `quote → createIntent → (mount/tokenize) → confirm → handleAction → waitForResult → booking.waitForTicketing`.
Effects: union of the steps.

#### `payments.resumeAfterRedirect({ url? } = {}, opts?) → Promise<{ intent: PaymentIntent, booking: Booking, state?: object }|null>`
Call on page load: detects gateway return params / persisted intent id, restores the store snapshot saved before redirect, fetches the intent and continues `waitForResult`. `null` when nothing to resume.
Effects: net `GET /payments/{id}`, `GET /bookings/{id}` · state restore + `payment`, `booking` · storage consume `payment.returnState` · emit per outcome.

#### `payments.cancel(intentId?, opts?) → Promise<PaymentIntent>`
Abort an unconfirmed / awaiting‑action intent (e.g. user closes UPI prompt). Effects: net `POST /payments/{id}/cancel` · state · emit `payment:cancelled`.

#### `payments.retry(bookingId?, params, ui?) → Promise<{ intent, booking }>`
New intent after a failure (same as `pay`, but checks booking still payable and reuses credits). Effects: as `pay`.

#### `payments.intent() → PaymentIntent|null` · `payments.status() → PaymentIntent['status']|null` · `payments.quoteState() → PaymentQuote|null`
Effects: none.

#### `payments.savedMethods.list({ fresh? } = {}, opts?) → Promise<SavedMethod[]>` · `.remove(id, opts?)` · `.setDefault(id, opts?)`
Effects: net `GET|DELETE|POST /me/payment-methods[/{id}]` · state `payment.savedMethods`.

#### `payments.receipt(bookingId?, opts?) → Promise<Document>` · `payments.refunds(bookingId?, opts?) → Promise<Refund[]>`
Effects: net `GET /bookings/{id}/receipt`, `GET /bookings/{id}/refunds` · state `trips.refunds`.

#### `payments.validateCard(card: { number, expMonth, expYear, cvc, name }) → ValidationResult` · `payments.cardBrand(number) → string`
Only for non‑hosted entry (merchant is PCI‑SAQ‑D). Effects: none.

#### `payments.clear() → void`
Effects: state `payment` reset · storage remove intent/return state · timer clear.
