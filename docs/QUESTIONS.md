# Decisions & open questions

## Decision log (answered 2026‑10‑17)

| # | decision |
|---|---|
| 1 | Markets: default — multi‑market design, `en-IN` + `en-US` bundles first |
| 5 | Result model: **both**; frontend requests `resultMode: 'per_slice' | 'combined'`; **default is split (`per_slice`)** |
| 6 | Self‑transfer / multi‑ticket offers: default — types kept, UI warning badge |
| 8 | Protection products: default — generic `Protection[]` catalogue from backend; insurance explicit accept/decline |
| 9 | Fare hold: **backend decides per flight** — none / free window (24 h or longer) / paid; after the window the hold is dropped, charged or converted per backend policy (`Offer.hold`, `HoldOption.onExpiry`) |
| 12 | Post‑booking self‑service: default — all exposed, gated by `availableActions` |
| 15 | Base URL: `https://api.ota.com` (paths carry their own version prefix because the backend mirrors the Amadeus paths) |
| 16 | Auth: default model (bearer access in memory + refresh). **`auth/session.js` is a standalone script**, never merged with anything. **Access gating is configurable** per function key (`config.access`: open / guest / auth). **Guests may book**; their guest session + token are the account key and `auth.claimAccount` → email / SMS link lets them set a password and own the account |
| 18 | Errors: **RFC 9457 `application/problem+json`** (`problemInterceptor`, `errorFromProblem`) |
| 19 | Search transport: default — async session + polling, SSE optional |
| 21 | Money: default — decimal string + ISO currency |
| 22 | Times: default — ISO with offset in the SDK model; Amadeus offset‑less local times are adapted (see BACKEND-MAPPING.md) |
| 30 | Backend contract: Amadeus swagger specs in `/amadeus` (9 files). Coverage and gaps are reported in `BACKEND-MAPPING.md`; the uncovered surface keeps the SDK‑defined contract + MSW mocks |
| 31 | Payments **isolated** from the domain SDK (`@wayfarer/sdk/payments`, `PaymentsPort`); adapters for **Stripe, PayPal, Razorpay** |
| 35 | 3‑DS finalisation: default — webhook‑first, client `finalize` is a no‑op when the server already knows |
| 39 | Language: plain JS + JSDoc, generated `.d.ts` |
| 41 | Bindings: vanilla now; store exposes `subscribe/getSnapshot/toObservable` so React, Vue and Angular wrappers can be added later without touching the core |
| 42 | UI: **both** — headless builders + default renderers + `styles.css`; customers may use the stylesheet or style everything themselves |

Everything below not listed above is still open and runs on its stated default.

---

Each item has a **Default** the SDK will assume if you don't say otherwise. Answer by number ("3: INR + USD + AED", "17: ok", "22: Razorpay + Stripe"). Items marked ★ change the shape of the API; the rest mostly change defaults and bundled adapters.

## A. Product scope

1. ★ **Markets & languages at launch.** Which countries / locales / currencies first (India‑only, GCC, US, EU, global)? Drives date/number formats, special fares, GST, payment methods and which message bundles ship. — *Default: multi‑market design; `en-IN` + `en-US` bundles, INR/USD/EUR/AED verified formatting.*
2. **Domestic + international from day one?** — *Default: both; requirements endpoint decides passport/APIS fields.*
3. **Indian special fares** (student / senior / armed‑forces / doctor) and **corporate fares** in the search form? — *Default: supported via `fareTypes`, hidden by UI unless backend `bootstrap.limits.fareTypes` lists them.*
4. **Limits:** max passengers (9?), infants per adult (1), max multi‑city legs (6), max advance booking days (~330), child/infant age bands. — *Default: those numbers, overridable by `bootstrap.limits`.*
5. ★ **Result model.** Do you show one combined round‑trip price per itinerary, or outbound + inbound chosen separately (common for Indian domestic)? Both? Decided by backend per search? — *Default: both; `resultMode:'auto'` lets the backend decide per response.*
6. **Virtual interlining / self‑transfer / multi‑ticket offers** (Kiwi‑style)? If never, the `tickets[]` / `selfTransfer` parts can be dropped from UI. — *Default: types kept, UI shows warning badge, searchable via `allowSelfTransfer`.*
7. **Explore / "anywhere" search, fare calendar, ±3‑day grid, price graph, price insights** — which of these does the backend actually serve? — *Default: all exposed; each UI builder degrades to hidden when the endpoint 404s / flag is off.*
8. **Which protection products** will exist: price lock, price‑drop protection, CFAR / zero cancellation, flexible ticket, disruption guarantee, baggage protection, insurance? Third‑party insurer with its own consent text? — *Default: generic `Protection[]` catalogue from backend; insurance explicit accept/decline.*
9. **Book‑now‑pay‑later / fare hold?** Free 24 h hold, paid holds, or none? — *Default: `booking.hold` kept behind `availableActions`.*
10. **Guest checkout** allowed, and should a guest booking be merged into the account on later login? — *Default: yes, guest session token; merge is backend‑side.*
11. **Loyalty / wallet / gift cards / referrals / vouchers** — in scope for v1 or later? — *Default: module included; UI panels optional.*
12. **Post‑booking self‑service scope.** Which are online vs. "raise a request": date change, partial cancel, name correction, seat/bag add, split PNR, SSR, document update, GST invoice? — *Default: all exposed; backend `availableActions` gates them per booking.*
13. **Check‑in:** deep links only, or in‑platform check‑in / boarding passes? — *Default: links + optional boarding‑pass documents.*
14. **Kiwi‑style Nomad (auto‑reordered multi‑city)** — needed? — *Default: out of scope.*

## B. Backend contract (`ota.com`)

15. ★ **Base URL & versioning:** `https://api.ota.com/v1`? Header‑based versioning? — *Default: `https://api.ota.com/v1`.*
16. ★ **Auth model:** backend‑issued JWT access + refresh (bearer in JS) vs. httpOnly cookie session (needs CSRF) vs. host app owns auth (SSO) and injects tokens? Refresh endpoint shape? — *Default: bearer access token in memory + refresh via `POST /auth/refresh` with httpOnly refresh cookie; `auth.setTokens` for host‑owned.*
17. **Public identification:** `X-Api-Key` / `clientId` per OTA frontend? — *Default: optional `X-Api-Key`.*
18. ★ **Response envelope & error format:** `{ data, meta }` + `{ code, message, details, requestId }`? Or RFC 7807 problem+json? Field‑level validation errors shape? — *Default: `{data, meta, errors}` envelope, error `{code, message, details[], requestId}`; the envelope interceptor is configurable.*
19. ★ **Search transport:** single synchronous response, or async session with polling (`Retry-After`) / SSE / WebSocket as suppliers respond? — *Default: async session + polling, SSE when `search.mode:'stream'`.*
20. **Pagination:** cursor vs page/offset? — *Default: cursor.*
21. ★ **Money format:** decimal strings (`"1234.56"`), minor‑unit integers, or floats? — *Default: decimal string + ISO currency.*
22. ★ **Times:** ISO with UTC offset for every segment time + IANA tz on airports? Any UTC‑only fields? — *Default: ISO with offset.*
23. ★ **Naming:** does the backend say itinerary / cart / order / booking / PNR / trip? SDK currently uses `itinerary` (pre‑payment) and `booking` (post‑creation), `trip` (post‑purchase view). — *Default: as designed; endpoint paths are a single config map so renaming is cheap.*
24. **Idempotency:** `Idempotency-Key` honoured on booking / payment creation? — *Default: sent on all POST create calls.*
25. **Rate limiting:** 429 with `Retry-After`? Per‑IP vs per‑user? — *Default: honoured, capped wait 10 s, then error.*
26. **Realtime:** any push channel (SSE/WebSocket/webhook‑to‑browser) for booking status, price alerts, disruptions? — *Default: polling with backoff; transport pluggable.*
27. **Bootstrap/config endpoint** (`GET /config`) returning limits, flags, markets, payment catalogue? — *Default: assumed; falls back to compiled defaults if absent.*
28. **Server‑side vs client‑side filtering/sorting of results?** (client‑side needs full result sets). — *Default: client‑side on the loaded set; server mode when `meta.serverFiltered`.*
29. **Scoped tokens for guest booking retrieval** (PNR + surname → limited token)? — *Default: assumed.*
30. **Can we get an OpenAPI spec or sample payloads?** If not, the SDK ships MSW mocks matching this doc, which the backend can then target. — *Default: SDK‑defined contract + mocks.*

## C. Payments

31. ★ **Gateways:** Stripe, Adyen, Razorpay, PayU, Juspay, Braintree, Checkout.com, CCAvenue? Hosted fields vs. redirect vs. native SDK? — *Default: adapter interface + reference adapters for Stripe and Razorpay.*
32. **Methods per market:** cards, UPI (collect/intent/QR), net‑banking, wallets (Paytm/PhonePe), Apple/Google Pay, PayPal, BNPL/EMI, bank transfer, pay‑later. — *Default: list comes from backend; UI renders whatever is returned.*
33. **Split payments** (wallet/points/gift card + card) and partial payments? — *Default: credits + one primary method.*
34. **Saved instruments / tokenisation** (RBI card‑on‑file tokens in India, network tokens)? — *Default: via gateway tokens exposed as `SavedMethod`.*
35. **3‑DS / SCA flow:** iframe challenge vs. full redirect; return URL ownership; does the backend finalise via webhook (SDK only polls) or does the client have to call `confirm`? — *Default: both handled; webhook‑first, `booking.finalize` is a no‑op when server already knows.*
36. **Multi‑currency charging / DCC** or always charge in display currency? — *Default: display currency; `PaymentQuote.fx` shown if backend returns it.*
37. **PCI scope:** will any frontend ever handle raw card numbers (SAQ‑D)? — *Default: never; `payments.validateCard` exists only for that case.*

## D. Platform & engineering

38. **Package name / distribution:** `@wayfarer/sdk` on npm + CDN UMD (`window.Wayfarer`)? Private registry? — *Default: `@wayfarer/sdk`, ESM + CJS + UMD.*
39. ★ **Language:** plain JS + JSDoc with generated `.d.ts` (as requested: "javascript SDK"), or TypeScript source? — *Default: JS + JSDoc, `.d.ts` generated and shipped.*
40. **Browser / runtime support:** evergreen only (ES2020, native `fetch`, `AbortController`)? Node 18+ for SSR? — *Default: yes; no IE11.*
41. **Framework bindings:** React hooks / Vue composables package, or vanilla store `subscribe` is enough for now? — *Default: vanilla; thin `@wayfarer/sdk/react` later.*
42. **UI layer depth:** headless only, default DOM renderers (as documented), or both? Ship CSS? — *Default: both + `styles.css` with CSS variables.*
43. **Build/test tooling:** Vite/Rollup, Vitest, MSW mock server, Playwright for UI, ESLint/Prettier, Changesets for versioning? — *Default: exactly that.*
44. **i18n:** which message bundles ship, who owns translations, RTL (Arabic) required? — *Default: `en` bundle in repo, loader hook for others, RTL‑ready CSS.*
45. **Analytics:** GA4 / GTM / Segment / in‑house? Event taxonomy (GA4 ecommerce) acceptable? — *Default: GA4 ecommerce mapping + console adapter.*
46. **Feature flags / experiments** source (backend `/config`, LaunchDarkly, GrowthBook)? — *Default: `/config` flags + `features.override`.*
47. **Persistence & PII:** OK to keep traveler form drafts in `sessionStorage` (opt‑in)? Recent searches in `localStorage`? Never documents? — *Default: as stated.*
48. **Error reporting:** Sentry / Datadog hook via `hooks.onError`? — *Default: hook only.*
49. **SSR / Next.js** support needed (core must not touch `window`; UI browser‑only)? CSP nonce for injected styles? — *Default: SSR‑safe core; `injectStyles` accepts a nonce.*
50. **Accessibility target:** WCAG 2.1 AA for UI builders? — *Default: yes.*
51. **Deep‑link URL format** preference (`/flights/DEL-BOM/2026-11-02?...`) — must match existing SEO URLs? — *Default: compact format in `utils/url`; encoder/decoder replaceable.*
52. **Price display rules per market:** all‑in totals (US DOT) vs per‑pax base fare first (India habit)? — *Default: all‑in total, per‑pax toggle.*
53. **Logging/redaction policy:** which fields must never be logged (names, documents, cards, phone)? — *Default: redact list in `logger`.*
54. **Versioning/compat:** semver with `client.version`, minimum backend version check via `/config`? — *Default: yes.*

## E. Compliance

55. **Consent capture:** terms + fare rules acknowledgement at booking, marketing opt‑in, cookie/analytics consent coupling — which versions must be recorded? — *Default: `consents` object on `booking.create`, versions from `content.policy`.*
56. **GDPR / DPDP:** data export and deletion flows required in v1? — *Default: endpoints wired, UI optional.*
57. **Document retention:** may saved traveler profiles store passport numbers? Masked display only? — *Default: stored server‑side, masked in UI, never persisted client‑side.*
