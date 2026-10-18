/**
 * Endpoint key → `{ method, path }` template map (docs/api/01-core.md §1.1, docs/BACKEND-MAPPING.md
 * §1.2). Keys are `module.function` (nested groups dotted: `'trips.changes.quote'`); the defaults are
 * built from every `net` effect line in docs/api/04…09. Operations that Amadeus backs use the Amadeus
 * path **with** its version prefix (`/v2/shopping/flight-offers`, `/v1/booking/flight-orders/{id}`,
 * …); everything else is the SDK‑defined `/v1/...` path from the module docs. `createEndpoints`
 * returns a per‑client copy whose `get(key, params)` fills `{id}`‑style placeholders with URL‑encoded
 * values. Pure and SSR‑safe: no I/O, no DOM, no module‑level mutable state; it never performs a
 * request and never throws a plain `Error` (`ConfigError` for unknown keys, missing params and bad
 * templates).
 */

import { ConfigError } from '../errors/index.js';
import { deepFreeze, isPlainObject } from '../utils/object.js';
import { isAbsoluteUrl } from '../utils/url.js';

/** @typedef {import('../types.js').EndpointKey} EndpointKey */
/** @typedef {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS'} HttpMethod */

/**
 * One endpoint template. `path` is relative to `baseUrl` and may contain `{name}` placeholders.
 * @typedef {Object} EndpointEntry
 * @property {HttpMethod} method
 * @property {string} path
 */

/** Values accepted for a template: a path string (method kept / `GET`) or a full entry. */
/** @typedef {string|EndpointEntry} EndpointTemplate */

/**
 * @typedef {Object} Endpoints
 * @property {(key: EndpointKey, params?: Record<string, string|number|boolean>) => string} get
 *   Resolve a key to its path with placeholders filled (URL‑encoded). Throws `ConfigError` for an
 *   unknown key or a missing/invalid placeholder value.
 * @property {(key: EndpointKey, template: EndpointTemplate) => void} set
 *   Add or replace a template. A string keeps the existing method (`GET` for a new key).
 * @property {() => Readonly<Record<EndpointKey, Readonly<EndpointEntry>>>} all
 *   Frozen snapshot of the whole table, keys sorted.
 * @property {(key: EndpointKey) => boolean} has
 */

/** @type {ReadonlySet<string>} */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** `{name}` placeholders (identifier characters only). */
const PLACEHOLDER_RE = /\{([A-Za-z_$][\w$]*)\}/g;
/** A `{` that does not open a well‑formed placeholder. */
const BAD_PLACEHOLDER_RE = /\{(?![A-Za-z_$][\w$]*\})/;
/** Endpoint key syntax: `module.fn`, `module.group.fn`, … */
const KEY_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
/** Keys that would collide with `Object.prototype` on a plain object. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Default table as `[key, method, path]`, **sorted by key** (code‑unit order). Amadeus‑backed rows
 * carry the Amadeus path; all others carry the `/v1`‑prefixed SDK path from the module docs.
 * Aliases documented in BACKEND-MAPPING §1.2 (`search.createQuick`, `search.alternatives`,
 * `itinerary.price`, `booking.patch`, `booking.issue`) and the task‑named `search.createGet` /
 * `search.availability` resolve to the same paths as their `module.function` keys.
 * @type {ReadonlyArray<readonly [string, HttpMethod, string]>}
 */
const TABLE = [
  // ── account (09 §1) ─────────────────────────────────────────────────────────────────────────
  ['account.addresses.create', 'POST', '/v1/me/addresses'],
  ['account.addresses.list', 'GET', '/v1/me/addresses'],
  ['account.addresses.remove', 'DELETE', '/v1/me/addresses/{id}'],
  ['account.addresses.setDefault', 'POST', '/v1/me/addresses/{id}/default'],
  ['account.addresses.update', 'PATCH', '/v1/me/addresses/{id}'],
  ['account.billingProfiles.create', 'POST', '/v1/me/billing-profiles'],
  ['account.billingProfiles.list', 'GET', '/v1/me/billing-profiles'],
  ['account.billingProfiles.remove', 'DELETE', '/v1/me/billing-profiles/{id}'],
  ['account.changeEmail', 'POST', '/v1/me/email'],
  ['account.changePassword', 'POST', '/v1/me/password'],
  ['account.changePhone', 'POST', '/v1/me/phone'],
  ['account.consents.get', 'GET', '/v1/me/consents'],
  ['account.consents.set', 'PUT', '/v1/me/consents'],
  ['account.delete', 'POST', '/v1/me/delete'],
  ['account.exportData', 'POST', '/v1/me/export'],
  ['account.exportStatus', 'GET', '/v1/me/export/{id}'],
  ['account.me', 'GET', '/v1/me'],
  ['account.mfa.confirm', 'POST', '/v1/me/mfa/confirm'],
  ['account.mfa.disable', 'POST', '/v1/me/mfa/disable'],
  ['account.mfa.enable', 'POST', '/v1/me/mfa/enable'],
  ['account.mfa.recoveryCodes', 'POST', '/v1/me/mfa/recovery-codes'],
  ['account.mfa.status', 'GET', '/v1/me/mfa'],
  ['account.notifications.list', 'GET', '/v1/me/notifications'],
  ['account.notifications.markRead', 'POST', '/v1/me/notifications/read'],
  ['account.notifications.registerPush', 'POST', '/v1/me/push-tokens'],
  ['account.notifications.unreadCount', 'GET', '/v1/me/notifications'],
  ['account.notifications.unregisterPush', 'DELETE', '/v1/me/push-tokens'],
  ['account.preferences.get', 'GET', '/v1/me/preferences'],
  ['account.preferences.set', 'PATCH', '/v1/me/preferences'],
  ['account.providers.link', 'POST', '/v1/me/providers/{p}'],
  ['account.providers.list', 'GET', '/v1/me/providers'],
  ['account.providers.unlink', 'DELETE', '/v1/me/providers/{p}'],
  ['account.requestPasswordReset', 'POST', '/v1/auth/password/forgot'],
  ['account.resetPassword', 'POST', '/v1/auth/password/reset'],
  ['account.sessions.list', 'GET', '/v1/me/sessions'],
  ['account.sessions.revoke', 'DELETE', '/v1/me/sessions/{id}'],
  ['account.sessions.revokeOthers', 'POST', '/v1/me/sessions/revoke-others'],
  ['account.update', 'PATCH', '/v1/me'],
  ['account.verifyChange', 'POST', '/v1/me/verify'],
  // ── alerts (09 §3) ──────────────────────────────────────────────────────────────────────────
  ['alerts.create', 'POST', '/v1/me/alerts'],
  ['alerts.createGuest', 'POST', '/v1/alerts/guest'],
  ['alerts.favorites.add', 'POST', '/v1/me/favorites'],
  ['alerts.favorites.list', 'GET', '/v1/me/favorites'],
  ['alerts.favorites.remove', 'DELETE', '/v1/me/favorites/{id}'],
  ['alerts.get', 'GET', '/v1/me/alerts/{id}'],
  ['alerts.history', 'GET', '/v1/me/alerts/{id}/history'],
  ['alerts.list', 'GET', '/v1/me/alerts'],
  ['alerts.pause', 'PATCH', '/v1/me/alerts/{id}'],
  ['alerts.remove', 'DELETE', '/v1/me/alerts/{id}'],
  ['alerts.resume', 'PATCH', '/v1/me/alerts/{id}'],
  ['alerts.savedSearches.list', 'GET', '/v1/me/saved-searches'],
  ['alerts.savedSearches.remove', 'DELETE', '/v1/me/saved-searches/{id}'],
  ['alerts.savedSearches.save', 'POST', '/v1/me/saved-searches'],
  ['alerts.unsubscribe', 'POST', '/v1/alerts/unsubscribe'],
  ['alerts.update', 'PATCH', '/v1/me/alerts/{id}'],
  // ── ancillaries (06 §3) ─────────────────────────────────────────────────────────────────────
  ['ancillaries.add', 'POST', '/v1/itineraries/{id}/ancillaries'],
  ['ancillaries.catalog', 'GET', '/v1/itineraries/{id}/ancillaries'],
  ['ancillaries.catalogForBooking', 'GET', '/v1/bookings/{id}/ancillaries'],
  ['ancillaries.clear', 'DELETE', '/v1/itineraries/{id}/ancillaries'],
  ['ancillaries.insurance.add', 'POST', '/v1/itineraries/{id}/insurance'],
  ['ancillaries.insurance.decline', 'POST', '/v1/itineraries/{id}/insurance/decline'],
  ['ancillaries.insurance.quotes', 'GET', '/v1/itineraries/{id}/insurance'],
  ['ancillaries.insurance.remove', 'DELETE', '/v1/itineraries/{id}/insurance'],
  ['ancillaries.protections.add', 'POST', '/v1/itineraries/{id}/protections'],
  ['ancillaries.protections.remove', 'DELETE', '/v1/itineraries/{id}/protections'],
  ['ancillaries.remove', 'DELETE', '/v1/itineraries/{id}/ancillaries/{selectionId}'],
  ['ancillaries.seats.autoAssign', 'POST', '/v1/itineraries/{id}/seats/auto'],
  ['ancillaries.seats.map', 'GET', '/v1/itineraries/{id}/seatmaps/{segmentId}'],
  ['ancillaries.seats.select', 'POST', '/v1/itineraries/{id}/seats'],
  ['ancillaries.seats.unselect', 'DELETE', '/v1/itineraries/{id}/seats'],
  // ── booking (07 §1) ─────────────────────────────────────────────────────────────────────────
  ['booking.abandon', 'DELETE', '/v1/booking/flight-orders/{id}'],
  ['booking.create', 'POST', '/v1/booking/flight-orders'],
  ['booking.documents', 'GET', '/v1/bookings/{id}/documents'],
  ['booking.download', 'GET', '/v1/bookings/{id}/documents/{type}'],
  ['booking.finalize', 'POST', '/v1/booking/flight-orders/{id}/issuance'],
  ['booking.get', 'GET', '/v1/booking/flight-orders/{id}'],
  ['booking.hold', 'POST', '/v1/booking/flight-orders'],
  ['booking.holdOptions', 'GET', '/v1/itineraries/{id}/hold-options'],
  ['booking.issue', 'POST', '/v1/booking/flight-orders/{id}/issuance'],
  ['booking.patch', 'PATCH', '/v1/booking/flight-orders/{id}'],
  ['booking.resendConfirmation', 'POST', '/v1/bookings/{id}/resend'],
  ['booking.resume', 'GET', '/v1/booking/flight-orders/{id}'],
  ['booking.retrieve', 'GET', '/v1/booking/flight-orders/by-reference'],
  ['booking.stream', 'GET', '/v1/bookings/{id}/stream'],
  ['booking.timeline', 'GET', '/v1/bookings/{id}/timeline'],
  ['booking.waitForTicketing', 'GET', '/v1/booking/flight-orders/{id}'],
  // ── content (04 §2) ─────────────────────────────────────────────────────────────────────────
  ['content.airlinePolicies', 'GET', '/v1/content/airlines/{code}/policies'],
  ['content.airportInfo', 'GET', '/v1/content/airports/{code}'],
  ['content.announcements', 'GET', '/v1/content/announcements'],
  ['content.banners', 'GET', '/v1/content/banners'],
  ['content.deals', 'GET', '/v1/content/deals'],
  ['content.destination', 'GET', '/v1/content/destinations/{code}'],
  ['content.faq', 'GET', '/v1/content/faq'],
  ['content.offers', 'GET', '/v1/content/offers'],
  ['content.page', 'GET', '/v1/content/pages/{slug}'],
  ['content.policy', 'GET', '/v1/content/policies/{key}'],
  ['content.travelRequirements', 'GET', '/v1/content/travel-requirements'],
  // ── itinerary (06 §1) ───────────────────────────────────────────────────────────────────────
  ['itinerary.acceptPriceChange', 'POST', '/v1/itineraries/{id}/price/accept'],
  ['itinerary.addOffer', 'PATCH', '/v1/itineraries/{id}/offers'],
  ['itinerary.applyPromo', 'POST', '/v1/itineraries/{id}/promo'],
  ['itinerary.clear', 'DELETE', '/v1/itineraries/{id}'],
  ['itinerary.create', 'POST', '/v1/itineraries'],
  ['itinerary.eligiblePromos', 'GET', '/v1/itineraries/{id}/promos'],
  ['itinerary.extend', 'POST', '/v1/itineraries/{id}/extend'],
  ['itinerary.fromLock', 'POST', '/v1/price-locks/{id}/itinerary'],
  ['itinerary.get', 'GET', '/v1/itineraries/{id}'],
  ['itinerary.lock', 'POST', '/v1/itineraries/{id}/price-lock'],
  ['itinerary.lockOptions', 'GET', '/v1/itineraries/{id}/price-lock'],
  ['itinerary.price', 'POST', '/v1/shopping/flight-offers/pricing'],
  ['itinerary.removeOffer', 'PATCH', '/v1/itineraries/{id}/offers'],
  ['itinerary.removePromo', 'DELETE', '/v1/itineraries/{id}/promo'],
  ['itinerary.replaceOffer', 'PATCH', '/v1/itineraries/{id}/offers'],
  ['itinerary.reprice', 'POST', '/v1/shopping/flight-offers/pricing'],
  ['itinerary.requirements', 'GET', '/v1/itineraries/{id}/requirements'],
  ['itinerary.resume', 'GET', '/v1/itineraries/{id}'],
  ['itinerary.setContact', 'PATCH', '/v1/itineraries/{id}/contact'],
  ['itinerary.setMetadata', 'PATCH', '/v1/itineraries/{id}'],
  ['itinerary.setPassengers', 'PATCH', '/v1/itineraries/{id}'],
  ['itinerary.setTravelers', 'PUT', '/v1/itineraries/{id}/travelers'],
  // ── offers (05 §3) ──────────────────────────────────────────────────────────────────────────
  ['offers.availability', 'POST', '/v1/shopping/availability/flight-availabilities'],
  ['offers.baggageOptions', 'GET', '/v1/flights/offers/{id}/baggage'],
  ['offers.brandedFares', 'POST', '/v1/shopping/flight-offers/upselling'],
  ['offers.combine', 'POST', '/v1/shopping/flight-offers/pricing'],
  ['offers.details', 'GET', '/v1/flights/offers/{id}/details'],
  ['offers.emissions', 'GET', '/v1/flights/offers/{id}/emissions'],
  ['offers.fareRules', 'GET', '/v1/flights/offers/{id}/fare-rules'],
  ['offers.get', 'GET', '/v1/flights/offers/{id}'],
  ['offers.priceLockOptions', 'GET', '/v1/flights/offers/{id}/price-lock'],
  ['offers.reprice', 'POST', '/v1/shopping/flight-offers/pricing'],
  ['offers.seatMapPreview', 'GET', '/v1/flights/offers/{id}/seatmaps'],
  // ── payments (07 §2) ────────────────────────────────────────────────────────────────────────
  ['payments.cancel', 'POST', '/v1/payments/{id}/cancel'],
  ['payments.confirm', 'POST', '/v1/payments/{id}/confirm'],
  ['payments.createIntent', 'POST', '/v1/bookings/{id}/payments'],
  ['payments.credits.apply', 'POST', '/v1/bookings/{id}/credits'],
  ['payments.credits.remove', 'DELETE', '/v1/bookings/{id}/credits'],
  ['payments.emiPlans', 'GET', '/v1/bookings/{id}/emi-plans'],
  ['payments.methods', 'GET', '/v1/bookings/{id}/payment-methods'],
  ['payments.quote', 'POST', '/v1/bookings/{id}/payment-quote'],
  ['payments.receipt', 'GET', '/v1/bookings/{id}/receipt'],
  ['payments.refunds', 'GET', '/v1/bookings/{id}/refunds'],
  ['payments.resumeAfterRedirect', 'GET', '/v1/payments/{id}'],
  ['payments.savedMethods.list', 'GET', '/v1/me/payment-methods'],
  ['payments.savedMethods.remove', 'DELETE', '/v1/me/payment-methods/{id}'],
  ['payments.savedMethods.setDefault', 'POST', '/v1/me/payment-methods/{id}/default'],
  ['payments.waitForResult', 'GET', '/v1/payments/{id}'],
  // ── places (04 §1) ──────────────────────────────────────────────────────────────────────────
  ['places.aircraft.get', 'GET', '/v1/aircraft/{code}'],
  ['places.airlines.get', 'GET', '/v1/airlines/{code}'],
  ['places.airlines.list', 'GET', '/v1/airlines'],
  ['places.alliances', 'GET', '/v1/alliances'],
  ['places.countries', 'GET', '/v1/countries'],
  ['places.currencies', 'GET', '/v1/currencies'],
  ['places.detectLocation', 'GET', '/v1/places/geoip'],
  ['places.exchangeRates', 'GET', '/v1/fx'],
  ['places.get', 'GET', '/v1/places/{code}'],
  ['places.getMany', 'GET', '/v1/places'],
  ['places.nearby', 'GET', '/v1/places/nearby'],
  ['places.popular', 'GET', '/v1/places/popular'],
  ['places.popularRoutes', 'GET', '/v1/routes/popular'],
  ['places.resolveMetro', 'GET', '/v1/places/{code}'],
  ['places.search', 'GET', '/v1/places/search'],
  // ── search (05 §1) ──────────────────────────────────────────────────────────────────────────
  ['search.alternatives', 'GET', '/v1/flights/search/{id}/alternatives'],
  ['search.availability', 'POST', '/v1/shopping/availability/flight-availabilities'],
  ['search.calendar', 'GET', '/v1/flights/prices/calendar'],
  ['search.create', 'POST', '/v2/shopping/flight-offers'],
  ['search.createGet', 'GET', '/v2/shopping/flight-offers'],
  ['search.createQuick', 'GET', '/v2/shopping/flight-offers'],
  ['search.explore', 'GET', '/v1/flights/explore'],
  ['search.flexibleDates', 'GET', '/v1/flights/prices/grid'],
  ['search.get', 'GET', '/v1/flights/search/{id}'],
  ['search.insights', 'GET', '/v1/flights/prices/insights'],
  ['search.nearbyAlternatives', 'GET', '/v1/flights/search/{id}/alternatives'],
  ['search.page', 'GET', '/v1/flights/search/{id}'],
  ['search.poll', 'GET', '/v1/flights/search/{id}'],
  ['search.priceGraph', 'GET', '/v1/flights/prices/graph'],
  ['search.setFilters', 'GET', '/v1/flights/search/{id}'],
  ['search.stream', 'GET', '/v1/flights/search/{id}/stream'],
  // ── support (08 §2) ─────────────────────────────────────────────────────────────────────────
  ['support.callback.request', 'POST', '/v1/support/callbacks'],
  ['support.chat.token', 'POST', '/v1/support/chat/token'],
  ['support.contactOptions', 'GET', '/v1/support/contact-options'],
  ['support.tickets.close', 'POST', '/v1/support/tickets/{id}/close'],
  ['support.tickets.create', 'POST', '/v1/support/tickets'],
  ['support.tickets.get', 'GET', '/v1/support/tickets/{id}'],
  ['support.tickets.list', 'GET', '/v1/support/tickets'],
  ['support.tickets.reply', 'POST', '/v1/support/tickets/{id}/messages'],
  // ── travelers (06 §2) ───────────────────────────────────────────────────────────────────────
  ['travelers.create', 'POST', '/v1/me/travelers'],
  ['travelers.documents.add', 'POST', '/v1/me/travelers/{id}/documents'],
  ['travelers.documents.remove', 'DELETE', '/v1/me/travelers/{id}/documents/{docId}'],
  ['travelers.documents.update', 'PATCH', '/v1/me/travelers/{id}/documents/{docId}'],
  ['travelers.get', 'GET', '/v1/me/travelers/{id}'],
  ['travelers.importFromBooking', 'POST', '/v1/me/travelers/import'],
  ['travelers.list', 'GET', '/v1/me/travelers'],
  ['travelers.loyalty.add', 'POST', '/v1/me/travelers/{id}/loyalty'],
  ['travelers.loyalty.programmes', 'GET', '/v1/loyalty-programmes'],
  ['travelers.loyalty.remove', 'DELETE', '/v1/me/travelers/{id}/loyalty'],
  ['travelers.options.assistanceCodes', 'GET', '/v1/reference/ssr'],
  ['travelers.options.mealCodes', 'GET', '/v1/reference/meals'],
  ['travelers.remove', 'DELETE', '/v1/me/travelers/{id}'],
  ['travelers.setDefault', 'POST', '/v1/me/travelers/{id}/default'],
  ['travelers.update', 'PATCH', '/v1/me/travelers/{id}'],
  // ── trips (08 §1) ───────────────────────────────────────────────────────────────────────────
  ['trips.alerts.subscribe', 'POST', '/v1/bookings/{id}/alerts'],
  ['trips.alerts.unsubscribe', 'DELETE', '/v1/bookings/{id}/alerts'],
  ['trips.amendment.confirm', 'POST', '/v1/bookings/{id}/amendments/confirm'],
  ['trips.amendment.quote', 'POST', '/v1/bookings/{id}/amendments/quote'],
  ['trips.boardingPasses', 'GET', '/v1/bookings/{id}/boarding-passes'],
  ['trips.byReference', 'GET', '/v1/booking/flight-orders/by-reference'],
  ['trips.cancellation.confirm', 'POST', '/v1/bookings/{id}/cancellations/{quoteId}/confirm'],
  ['trips.cancellation.quote', 'POST', '/v1/bookings/{id}/cancellations/quote'],
  ['trips.changes.confirm', 'POST', '/v1/bookings/{id}/changes/{quoteId}/confirm'],
  ['trips.changes.options', 'GET', '/v1/bookings/{id}/change-options'],
  ['trips.changes.quote', 'POST', '/v1/bookings/{id}/changes/quote'],
  ['trips.checkIn', 'GET', '/v1/bookings/{id}/check-in'],
  ['trips.disruptions', 'GET', '/v1/bookings/{id}/disruptions'],
  ['trips.disruptions.respond', 'POST', '/v1/bookings/{id}/disruptions/{did}/respond'],
  ['trips.flightStatus', 'GET', '/v1/flights/status'],
  ['trips.get', 'GET', '/v1/booking/flight-orders/{id}'],
  ['trips.invoice.request', 'POST', '/v1/bookings/{id}/invoice'],
  ['trips.list', 'GET', '/v1/me/trips'],
  ['trips.rate', 'POST', '/v1/bookings/{id}/rating'],
  ['trips.refundStatus', 'GET', '/v1/refunds/{id}'],
  ['trips.refunds', 'GET', '/v1/bookings/{id}/refunds'],
  ['trips.requests.list', 'GET', '/v1/bookings/{id}/requests'],
  ['trips.requests.nameCorrection', 'POST', '/v1/bookings/{id}/requests'],
  ['trips.requests.other', 'POST', '/v1/bookings/{id}/requests'],
  ['trips.requests.specialAssistance', 'POST', '/v1/bookings/{id}/requests'],
  ['trips.requests.splitPnr', 'POST', '/v1/bookings/{id}/requests'],
  ['trips.requests.updateContact', 'PATCH', '/v1/booking/flight-orders/{id}'],
  ['trips.requests.updateDocuments', 'PATCH', '/v1/booking/flight-orders/{id}'],
  ['trips.void', 'DELETE', '/v1/booking/flight-orders/{id}'],
  // ── wallet (09 §2) ──────────────────────────────────────────────────────────────────────────
  ['wallet.balance', 'GET', '/v1/me/wallet'],
  ['wallet.coupons.eligible', 'GET', '/v1/itineraries/{id}/promos'],
  ['wallet.coupons.mine', 'GET', '/v1/me/coupons'],
  ['wallet.coupons.validate', 'POST', '/v1/promos/validate'],
  ['wallet.giftCards.check', 'POST', '/v1/gift-cards/check'],
  ['wallet.giftCards.mine', 'GET', '/v1/me/gift-cards'],
  ['wallet.giftCards.redeemToWallet', 'POST', '/v1/me/gift-cards/redeem'],
  ['wallet.loyalty.earnPreview', 'GET', '/v1/itineraries/{id}/loyalty-preview'],
  ['wallet.loyalty.history', 'GET', '/v1/me/loyalty/history'],
  ['wallet.loyalty.redeemOptions', 'GET', '/v1/bookings/{id}/loyalty-redeem-options'],
  ['wallet.loyalty.status', 'GET', '/v1/me/loyalty'],
  ['wallet.referrals.apply', 'POST', '/v1/me/referrals/apply'],
  ['wallet.referrals.code', 'GET', '/v1/me/referrals'],
  ['wallet.referrals.stats', 'GET', '/v1/me/referrals/stats'],
  ['wallet.transactions', 'GET', '/v1/me/wallet/transactions'],
  ['wallet.vouchers.applicable', 'GET', '/v1/itineraries/{id}/vouchers'],
  ['wallet.vouchers.list', 'GET', '/v1/me/vouchers'],
];

/**
 * Default endpoint table: key → `{ method, path }`, frozen, keys sorted. Amadeus‑backed operations
 * keep the Amadeus path with its version prefix; everything else is `/v1/...` as written in the
 * module docs (docs/BACKEND-MAPPING.md §1.2).
 * @type {Readonly<Record<EndpointKey, Readonly<EndpointEntry>>>}
 */
export const DEFAULT_ENDPOINTS = deepFreeze(
  Object.fromEntries(TABLE.map(([key, method, path]) => [key, { method, path }]))
);

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} key
 * @returns {string}
 */
function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || RESERVED_KEYS.has(key)) {
    throw new ConfigError(`Invalid endpoint key '${String(key)}' (expected 'module.function')`, {
      details: { key },
    });
  }
  return key;
}

/**
 * @param {string} key
 * @param {unknown} path
 * @returns {string}
 */
function normalizePath(key, path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new ConfigError(`endpoints['${key}'] must have a non-empty path`, { details: { key } });
  }
  const p = path.trim();
  if (!(p.startsWith('/') || isAbsoluteUrl(p))) {
    throw new ConfigError(`endpoints['${key}'] path must start with '/' or be an absolute URL`, {
      details: { key, path: p },
    });
  }
  if (BAD_PLACEHOLDER_RE.test(p)) {
    throw new ConfigError(`endpoints['${key}'] has a malformed placeholder (expected '{name}')`, {
      details: { key, path: p },
    });
  }
  return p;
}

/**
 * @param {string} key
 * @param {unknown} template
 * @param {EndpointEntry|undefined} previous
 * @returns {Readonly<EndpointEntry>}
 */
function normalizeEntry(key, template, previous) {
  const fallbackMethod = previous ? previous.method : 'GET';
  if (typeof template === 'string') {
    return Object.freeze({ method: fallbackMethod, path: normalizePath(key, template) });
  }
  if (isPlainObject(template)) {
    const method =
      template.method === undefined
        ? fallbackMethod
        : typeof template.method === 'string'
          ? template.method.toUpperCase()
          : '';
    if (!METHODS.has(method)) {
      throw new ConfigError(
        `endpoints['${key}'].method must be one of ${[...METHODS].join(' | ')}`,
        { details: { key, method: template.method } }
      );
    }
    return Object.freeze({
      method: /** @type {HttpMethod} */ (method),
      path: normalizePath(key, template.path),
    });
  }
  throw new ConfigError(`endpoints['${key}'] must be a path string or { method, path }`, {
    details: { key },
  });
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isScalar(s) {
  return (
    typeof s === 'string' || (typeof s === 'number' && Number.isFinite(s)) || typeof s === 'boolean'
  );
}

// ── factory ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a per‑client endpoint table: the defaults plus `overrides` (`config.endpoints`), each value a
 * path string or `{ method, path }`. Throws `ConfigError` for an invalid override. Effects: none.
 * @param {Record<string, EndpointTemplate>|null} [overrides]
 * @returns {Endpoints}
 */
export function createEndpoints(overrides) {
  /** @type {Map<string, Readonly<EndpointEntry>>} */
  const table = new Map(Object.entries(DEFAULT_ENDPOINTS));

  /** @type {Endpoints['set']} */
  function set(key, template) {
    const k = assertKey(key);
    table.set(k, normalizeEntry(k, template, table.get(k)));
  }

  if (overrides !== undefined && overrides !== null) {
    if (!isPlainObject(overrides)) {
      throw new ConfigError('endpoints overrides must be an object of key → path', {
        details: { path: 'endpoints' },
      });
    }
    for (const key of Object.keys(overrides)) set(key, overrides[key]);
  }

  /** @type {Endpoints['has']} */
  function has(key) {
    return typeof key === 'string' && table.has(key);
  }

  /** @type {Endpoints['get']} */
  function get(key, params) {
    const entry = typeof key === 'string' ? table.get(key) : undefined;
    if (!entry) {
      throw new ConfigError(`Unknown endpoint key '${String(key)}'`, { details: { key } });
    }
    /** @type {Record<string, unknown>} */
    let values = {};
    if (params !== undefined && params !== null) {
      if (!isPlainObject(params)) {
        throw new ConfigError(`Endpoint params for '${key}' must be an object`, {
          details: { key },
        });
      }
      values = params;
    }
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const invalid = [];
    const path = entry.path.replace(PLACEHOLDER_RE, (_match, name) => {
      const value = values[name];
      if (value === undefined || value === null || value === '') {
        missing.push(name);
        return '';
      }
      if (!isScalar(value)) {
        invalid.push(name);
        return '';
      }
      return encodeURIComponent(String(value));
    });
    if (missing.length > 0 || invalid.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
      if (invalid.length > 0) parts.push(`not a string/number/boolean: ${invalid.join(', ')}`);
      throw new ConfigError(`Cannot build endpoint '${key}' (${parts.join('; ')})`, {
        details: { key, template: entry.path, missing, invalid },
      });
    }
    return path;
  }

  /** @type {Endpoints['all']} */
  function all() {
    /** @type {Record<string, Readonly<EndpointEntry>>} */
    const out = {};
    for (const key of [...table.keys()].sort()) {
      out[key] = /** @type {Readonly<EndpointEntry>} */ (table.get(key));
    }
    return Object.freeze(out);
  }

  return { get, set, all, has };
}
