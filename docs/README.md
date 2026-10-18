# Wayfarer Flights SDK — API Reference (v0 draft)

Framework‑agnostic JavaScript SDK that lets an OTA build its entire flights frontend
against the OTA backend (assumed at `https://api.ota.com`; it exposes the Amadeus flight APIs
whose specs sit in `amadeus/`, plus OTA‑specific endpoints — see `BACKEND-MAPPING.md`). It covers search,
offer selection, itinerary building, traveler capture, ancillaries, booking, payment,
post‑booking servicing (change / cancel / refunds / disruptions), traveler profiles,
account, wallet / loyalty, price alerts, and a separate, optional UI layer.

This document set is intentionally minimal: for every public function it gives the
**signature**, the **task** it performs and its **side effects**. Nothing else.

---

## 1. Reading the reference

Each entry looks like this:

```
#### `search.create(params, opts?) → Promise<SearchSession>`
Validate params, open a search session, poll it until complete.
Effects: net `POST /flights/search` · state `search` · emit `search:start|results|complete` · storage `recentSearches` · timer poll
```

Side‑effect vocabulary (an entry lists only the kinds it has; `none` = pure function):

| tag | meaning |
|---|---|
| `net` | HTTP call(s) made, listed as `METHOD /path` (relative to `baseUrl`) |
| `state` | store slice(s) written (see §5) |
| `emit` | events emitted on `client.events` (see §6). `a|b` = one of |
| `storage` | keys persisted through the configured storage adapter |
| `timer` | timers / polling started (always cleared by `destroy()` or the matching `cancel`) |
| `dom` | DOM mutation (UI layer only) |
| `nav` | may navigate the page (payment redirects only) |
| `telemetry` | emits a `telemetry.track` event (only listed where not implied by `emit`) |

Conventions that apply everywhere and are therefore not repeated per entry:

- Every network function accepts a trailing `opts?: RequestOpts` (see `api/00-types.md`) and rejects with an `SdkError` subclass (see `api/02-state-events-errors.md`). The `Throws:` line appears only for domain‑specific errors.
- Backend errors are RFC 9457 `application/problem+json`; the SDK maps `status` / `type` / `code` to `SdkError` subclasses and keeps the problem document on `error.problem`.
- Access gating: every public function has an access key (`search.create`, `trips.*`, …) resolved against `config.access` to `'open' | 'guest' | 'auth'`. `'guest'` silently ensures a guest session; `'auth'` rejects with `AuthError{reason:'unauthenticated'}` and emits `auth:required` **before** any network call. Defaults are in `api/01-core.md §1.1`.
- Wire adapters: endpoints backed by Amadeus‑shaped payloads go through `src/adapters/amadeus/*` so the domain model in `00-types.md` is the only shape UI code ever sees; the untouched payload stays on `raw`.
- Every function that writes the store also emits `state:change`; it is not repeated.
- Every `net` call passes through the HTTP lifecycle (interceptors + hooks) described in `api/01-core.md §3`.
- Getters ending in `current()` / `get*()` without `opts` are synchronous reads of the store.
- Money is `{ amount: string, currency: string }`; dates are `YYYY-MM-DD`; timestamps are ISO‑8601 **with UTC offset** (local time at the airport is preserved).
- Identifiers are opaque strings issued by the backend.

---

## 2. Documents

| file | contents |
|---|---|
| `api/00-types.md` | Data shapes used in signatures |
| `api/01-core.md` | `createClient`, config, HTTP client + lifecycle taps, built‑in interceptors, auth/session |
| `api/02-state-events-errors.md` | Store, event emitter, error taxonomy, storage adapters |
| `api/03-utils.md` | money, datetime, format, validation, async, object, id, url, i18n, telemetry, logger, features |
| `api/04-reference-data.md` | `places` (airports / airlines / countries / currencies), `content` (CMS, policies, travel requirements) |
| `api/05-search.md` | `search` (sessions, flexible dates, calendar, explore, insights, deep links), `filters` (pure engine), `offers` (details, fare rules, branded fares, reprice) |
| `api/06-itinerary.md` | `itinerary` (cart, reprice, promo, expiry, price lock), `travelers` (profiles, validation), `ancillaries` (seats, bags, meals, insurance, protections, extras) |
| `api/07-booking.md` | `booking` (create, hold, status polling, documents, guest retrieve), `payments` (methods, intents, gateway adapters, 3DS/UPI actions, credits, redirects) |
| `api/08-trips.md` | `trips` (upcoming / past / cancelled, change, cancel, refunds, disruptions, check‑in, requests), `support` |
| `api/09-account.md` | `account` (profile, security, consents, GDPR), `wallet` (wallet, loyalty, coupons, gift cards, vouchers, referrals), `alerts` (price alerts, saved searches, favourites) |
| `api/10-ui.md` | UI builders: search form, results, filters, details, summary, traveler forms, seat map, payment form, confirmation, trips, account, price insights, primitives |
| `BACKEND-MAPPING.md` | Amadeus spec → SDK function/type mapping, conflicts, gaps the OTA backend must fill |
| `CONTRIBUTING.md` | Internal conventions: module factory contract, `ctx`, slices, events, tests, mocks |
| `RESEARCH.md` | Feature matrix across OTAs / flight APIs → which module covers each |
| `QUESTIONS.md` | Decision log (answered) + remaining open items with defaults |

---

## 3. Package layout (one script = one responsibility)

```
src/
  index.js                      public entry: createClient + re‑exports (no UI)
  core/client.js                composition root, plugins, prefs, destroy
  core/config.js                defaults, validation, defineConfig
  http/client.js                fetch wrapper, lifecycle, retries, abort, cache, dedupe, streams
  http/interceptors.js          built‑in interceptor factories (auth, locale, idempotency, envelope, …)
  auth/session.js               STANDALONE: tokens, refresh (single‑flight), guest sessions, login/register/logout,
                                guest→account claim. No other script is merged into it; modules receive it via ctx
  auth/access.js                access policy resolver + guard (open / guest / auth per function key)
  state/store.js                slices, select/subscribe, batch, persist/hydrate, middleware, devtools
  events/emitter.js             typed event bus (on/once/off/emit/waitFor, wildcards)
  errors/index.js               SdkError hierarchy + normalisation helpers
  storage/adapters.js           memory / localStorage / sessionStorage / cookie / custom, TTL, namespacing
  utils/money.js  datetime.js  format.js  validation.js  async.js  object.js  id.js  url.js
  utils/i18n.js   telemetry.js logger.js  features.js
  modules/places.js             locations autocomplete, nearby, airlines, aircraft, countries, currencies
  modules/content.js            banners, deals, FAQ, policies, destination & travel‑requirement content
  modules/search.js             search sessions, polling, filters/sort wiring, flex dates, calendar, explore, insights
  modules/filters.js            pure filter / facet / sort / rank engine (no I/O)
  modules/offers.js             offer details, fare rules, branded fares, combine, reprice, selection
  modules/itinerary.js          server‑side cart: offers + pax + promo + travelers, expiry, price lock
  modules/travelers.js          saved traveler profiles, documents, loyalty, validation, drafts
  modules/ancillaries.js        catalog, seats, baggage, meals, insurance, protections, extras, bundles
  modules/booking.js            create / hold / status polling / documents / guest retrieve / calendar / share
  payments/index.js             ISOLATED payments package (entry @wayfarer/sdk/payments): methods, quotes, intents,
                                actions (3DS/UPI/redirect), credits, resume. Domain code sees only the PaymentsPort
  payments/port.js              PaymentsPort interface + null port (booking works up to pending_payment without it)
  payments/adapters/stripe.js   payments/adapters/paypal.js   payments/adapters/razorpay.js
  adapters/amadeus/search.js    pricing.js  upsell.js  availability.js  orders.js  common.js
                                wire ↔ domain converters for the Amadeus‑shaped endpoints (see BACKEND-MAPPING.md)
  core/endpoints.js             endpoint key → path template map (Amadeus paths for covered ops, /v1/… otherwise)
  modules/trips.js              my trips, change, cancel, refunds, disruptions, check‑in, post‑booking add‑ons, requests
  modules/account.js            profile, preferences, addresses, notifications, sessions, MFA, consents, GDPR
  modules/wallet.js             wallet, loyalty, coupons, gift cards, vouchers, referrals
  modules/alerts.js             price alerts (incl. guest), saved searches, favourites
  modules/support.js            tickets, callbacks, chat token, contact options
  ui/index.js                   createUI(client) → all builders (separate entry `@wayfarer/sdk/ui`)
  ui/core.js  primitives.js  search-form.js  results.js  filters.js  offer-details.js
  ui/itinerary-summary.js  traveler-form.js  ancillaries.js  payment-form.js  confirmation.js
  ui/trips.js  account.js  price-insights.js  styles.css
  mock/server.js  mock/handlers/*.js  mock/fixtures/*.json   MSW handlers for ota.com (dev / tests; entry `@wayfarer/sdk/mock`)
  bindings/react.js  vue.js  angular.js   (later) thin wrappers over store.subscribe / store.toObservable
types/                          generated .d.ts (JSDoc → d.ts)
```

Entry points: `@wayfarer/sdk` (core + modules), `@wayfarer/sdk/payments` (+ `/payments/stripe|paypal|razorpay`), `@wayfarer/sdk/ui`, `@wayfarer/sdk/utils`, `@wayfarer/sdk/mock`, `@wayfarer/sdk/styles.css`. ESM + CJS + UMD (`window.Wayfarer`). Tree‑shakeable; zero runtime dependencies in core.

---

## 4. Request lifecycle (where tokens / headers are managed)

```
spec ─▶ prepare ─▶ request interceptors ─▶ hook beforeRequest ─▶ cache/dedupe ─▶ fetch
     ◀─ resolve ◀─ response interceptors ◀─ parse ◀─ hook afterResponse ◀─────────┘
                └─ on error: normalise ─▶ error interceptors ─▶ retry? ─▶ hook onRetry ─▶ fetch again
```

| stage | can mutate | typical use |
|---|---|---|
| `prepare` | — | merge defaults, resolve lazy headers, assign `requestId` |
| `request` interceptors | spec | `Authorization`, `X-Api-Key`, `Accept-Language`, `X-Currency`, `Idempotency-Key`, CSRF, device id; may short‑circuit with a cached `Response` |
| hook `beforeRequest` | no (observe / abort) | telemetry start, logging |
| `fetch` | — | `AbortSignal` = user signal + timeout + tag |
| hook `afterResponse` | no | timing, raw status logging |
| `parse` | — | json / blob / text by `responseType` |
| `response` interceptors | data | envelope unwrapping, token rotation from headers, pagination meta |
| `error` interceptors | error → Response or Error | 401 → `auth.refresh()` then `ctx.retry()`; 429 → wait `Retry-After`; parse RFC 9457 problem → `SdkError` subclass |
| hook `onRetry` / `onAbort` / `onTimeout` | no | metrics |

Full API in `api/01-core.md §3`.

---

## 5. State shape (single store, one slice per domain)

```
session     { status: 'anonymous'|'guest'|'authenticated'|'refreshing', user, guestId, accessExpiresAt }
prefs       { locale, currency, market, homeAirport, pricePer: 'pax'|'total', hour12 }
bootstrap   { loaded, flags, limits, markets, currencies, paymentMethods, version }
search      { status, sessionId, params, offers: {byId, allIds}, sliceOffers, facets, filters, sort,
              visibleIds, summary, expiresAt, resultMode, error, history[], compare[] }
offers      { selection: { offerId, bySlice }, detailsById, fareFamiliesById, repriceById }
itinerary   { current, status, priceChange, requirements, travelers[], contact, promo, expiresAt, error }
ancillaries { catalog, seatMapsBySegment, selected[], insurance, protections, total }
booking     { current, status, polling, error, lastReference }
payment     { methods, quote, intent, credits, action, status, savedMethods, error }
trips       { byId, byPhase: { upcoming, past, cancelled } → { ids, cursor, loaded }, current,
              changeQuote, cancelQuote, refunds, disruptions }
travelers   { profiles[], loaded, drafts: { [slotId]: Partial<Traveler> } }
account     { user, preferences, addresses, notifications, consents, sessions, mfa }
wallet      { balance, loyalty, vouchers, coupons }
alerts      { items[], savedSearches[], favorites[] }
content     { cache: { [key]: {data, expiresAt} } }
ui          { busy: {}, toasts[], dialogs[], forms: {} }          (UI layer only)
```

Persistence defaults: `session` (refresh token only when `auth.strategy = 'bearer'` and no httpOnly cookie), `prefs`, `search.history`, `itinerary.current.id`, `booking.lastReference`, `payment.intent.id` (for redirect return), `travelers.drafts` (sessionStorage, opt‑in because PII). Everything else is memory‑only.

---

## 6. Event catalogue

| namespace | events |
|---|---|
| http | `http:request`, `http:response`, `http:error`, `http:retry`, `http:abort` |
| auth | `auth:login`, `auth:logout`, `auth:refreshed`, `auth:expired`, `auth:guest`, `auth:mfaRequired`, `auth:required`, `auth:claimSent`, `auth:claimed`, `access:change` |
| client | `client:ready`, `client:destroyed`, `bootstrap:loaded`, `prefs:change`, `features:change` |
| search | `search:start`, `search:results`, `search:complete`, `search:error`, `search:cancelled`, `search:expiring`, `search:expired`, `search:filtersChange`, `search:sortChange` |
| offer | `offer:selected`, `offer:deselected`, `offer:priceChanged`, `offer:expired`, `offer:unavailable`, `offer:fareFamilyChanged` |
| itinerary | `itinerary:created`, `itinerary:updated`, `itinerary:priceChanged`, `itinerary:expiring`, `itinerary:expired`, `itinerary:travelersSet`, `itinerary:promoApplied`, `itinerary:promoRemoved`, `itinerary:locked`, `itinerary:cleared` |
| ancillaries | `ancillaries:changed`, `seats:changed`, `insurance:changed`, `protections:changed` |
| booking | `booking:created`, `booking:held`, `booking:holdExpiring`, `booking:holdExpired`, `booking:statusChanged`, `booking:confirmed`, `booking:ticketed`, `booking:failed`, `booking:abandoned` |
| payment | `payment:intentCreated`, `payment:actionRequired`, `payment:processing`, `payment:succeeded`, `payment:failed`, `payment:cancelled`, `payment:redirecting` |
| trips | `trips:loaded`, `trip:loaded`, `trip:changeQuoted`, `trip:changed`, `trip:cancelQuoted`, `trip:cancelled`, `trip:refundUpdated`, `trip:disruption`, `trip:requestSubmitted` |
| profile | `travelers:changed`, `account:updated`, `wallet:updated`, `alerts:changed`, `support:ticketUpdated` |
| system | `state:change`, `error`, `telemetry:track`, `storage:unavailable` |

Every event payload is `{ type, at: number, ...data }`; errors carry `{ error: SdkError }`.

---

## 7. End‑to‑end flow (what calls what)

```
places.search ─▶ search.create ─▶ (filters.*) ─▶ offers.select / offers.selectFareFamily / offers.combine
  ─▶ itinerary.create ─▶ itinerary.requirements ─▶ itinerary.setTravelers
  ─▶ ancillaries.* (seats / bags / meals / insurance / protections) ─▶ itinerary.reprice
  ─▶ booking.create | booking.hold ─▶ payments.methods ─▶ payments.createIntent ─▶ gateway.tokenize
  ─▶ payments.confirm ─▶ payments.handleAction (3DS / UPI / redirect) ─▶ payments.waitForResult
  ─▶ booking.waitForTicketing ─▶ booking.documents / booking.calendar / trips.get
post‑booking: trips.list ─▶ trips.get ─▶ trips.changes.* | trips.cancellation.* | trips.ancillaries.* | trips.requests.*
```

Status machines:

- `SearchSession.status`: `pending → streaming → complete | expired | error | cancelled`
- Result mode: **`per_slice` (split) is the default**; the frontend may request `combined`. When the backend only returns combined offers (Amadeus Flight Offers Search), the SDK fans out one search per slice and keeps `oneWayCombinable` offers; `offers.combine` prices the chosen slices together (Flight Offers Price accepts several offers).
- `Itinerary.status`: `active → (priceChanged) → booked | expired | abandoned`
- `Booking.status`: `draft → pending_payment | on_hold → processing → confirmed → ticketed | partially_ticketed | failed | cancelled | refunded | expired`
- `PaymentIntent.status`: `requires_method → requires_confirmation → requires_action → processing → succeeded | failed | cancelled`
