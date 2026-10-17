# Backend mapping — Amadeus specs (`amadeus/`) → Wayfarer SDK

How the nine Amadeus swagger files in `amadeus/` back the SDK documented in `docs/api/*.md`, what the
OTA backend (`https://api.ota.com`) must add on top, and where the SDK's assumed contract simply stands
because no Amadeus API covers it. Evidence: the nine specs (versions in §1) checked with `python3 -I`
queries; decisions already taken in `QUESTIONS.md` are applied, not re‑opened.

**Standing decisions applied throughout**

| decision | consequence in this document |
|---|---|
| SDK keeps its own domain model (`00-types.md`); Amadeus payloads are converted by `src/adapters/amadeus/*.js`; the untouched payload stays on `raw` | §3 maps SDK fields ← Amadeus paths; §6 lists the adapter functions |
| `baseUrl` = `https://api.ota.com` (no version suffix); Amadeus‑covered operations default to the Amadeus path **with** its version prefix; everything else keeps the SDK‑defined `/v1/...` path | §1.2 endpoint‑key table |
| Money = `{ amount: decimal string, currency }` | every Amadeus `amount` string gets the enclosing `Price.currency` (or `billingCurrency` / `ElementaryPrice.currencyCode`) attached |
| Times: SDK model is ISO‑8601 **with offset**; Amadeus local wall‑clock times are airport‑local; the adapter appends the offset from airport tz data when known, otherwise leaves the offset off and sets `localTimeOnly: true` | §3 DateTime row, §4 C‑1 |
| Errors: the backend answers RFC 9457 `application/problem+json`; the Amadeus `errors[]` (`Issue[]`) travel as the `errors` extension member | §4 C‑5, §6 `fromIssue` / `fromIssueArray` |
| Result mode: **`per_slice` (split) is the default**, `combined` on request (QUESTIONS #5, updated) | §2 search, §4 C‑8 (Amadeus returns combined offers natively; split needs `addOneWayOffers` or a client fan‑out) |

Legend used in §2: **backed by** = an Amadeus operation serves it (notes say how); **backend‑defined** =
no Amadeus coverage, the SDK contract in the module doc stands and the OTA backend implements it (MSW mocks
match the doc); **client‑side** = pure function, no network. "(partial)" marks a backed function whose
Amadeus payload fills only part of the SDK shape.

---

## 1. Scope

### 1.1 Amadeus APIs present in `amadeus/`

| file | API (title · version) | format | base path | operations (`operationId`) |
|---|---|---|---|---|
| `FlightOffersSearch_v2_Version_1.0_…json` | Flight Offers Search · 2.17.0 | Swagger 2.0 | `/v2` | `POST /shopping/flight-offers` (`searchFlightOffers`, header `X-HTTP-Method-Override: GET` **required**) · `GET /shopping/flight-offers` (`getFlightOffers`, query params, 1–2 bounds) |
| `FlightOffersPrice_v1_Version_1.15_…json` | Flight Offers Price · 1.15.0 | Swagger 2.0 | `/v1` | `POST /shopping/flight-offers/pricing` (`quoteAirOffers`; query `include=credit-card-fees,bags,other-services,detailed-fare-rules` csv, `forceClass`) |
| `BrandedFaresUpsell_v1_Version_1.4_…json` | Branded Fares Upsell · 1.4.1 | Swagger 2.0 | `/v1` | `POST /shopping/flight-offers/upselling` (`upsellAirOffers`) |
| `FlightAvailabilitiesSearch_v1_Version_1.0_…json` | Flight Availabilities Search ("Amadeus QuickConnect") · 1.0.0 | Swagger 2.0 | `/v1` | `POST /shopping/availability/flight-availabilities` (`searchFlightAvailabilities`, header `X-HTTP-Method-Override: GET` **required**) |
| `FlightCreateOrders_v1_Version_1.16_…json` | Flight Create Orders · 1.16.0 | Swagger 2.0 | `/v1` | `POST /booking/flight-orders` (`createFligtOrders` [sic]; query `issue`; **201**) |
| `FlightOrderManagement_v1_Version_1.15_…json` | Flight Order Management · 1.15.0 | Swagger 2.0 | `/v1` | `GET /booking/flight-orders/{flight-orderId}` (`getFlightOrder`; `include=bags`, `fareRules=rebooks,refunds`) · `PATCH …` (`patchFlightOrder`) · `DELETE …` (`cancelFlightOrder`, 204) |
| `FlightOrderIssue_v1_Version_1.8_…json` | Flight Order Issue · 1.8.0 | Swagger 2.0 | `/v1` | `POST /booking/flight-orders/{flight-orderId}/issuance` (`issueFlightOrder`; body `{data:{formOfPayments[]}}` optional for GDS) |
| `GetFlightOrderByRecordLocator_v1_Version_1.10_…json` | Get Flight Order By Record Locator · 1.10.0 | Swagger 2.0 | `/v1` | `GET /booking/flight-orders/by-reference` (`getFlightOrder`; `reference`*, `originSystemCode`* = `GDS`, `include=bags`; `data` is an **array**) |
| `QueueList_v1_Version_1.0_…json` | GET Queue‑list · 1.0 | **OpenAPI 3.0** | `https://…/v1` | `GET /office/queues/{queue-id}` (path key is literally `GET/office/queues/{queue-id}`; query `max`, `category`, `officeId`) — **back‑office only, not used by the SDK** (§5.5) |

All eight Swagger files: host `test.travel.api.amadeus.com`, `consumes`/`produces` `application/vnd.amadeus+json`,
no `securityDefinitions` (Amadeus client‑credentials OAuth2 held by the OTA backend), errors as
`{ errors: Issue[] }` with `Issue { status, code (int64), title, detail, source { pointer | parameter | example } }`.
`README.md` in the folder is a 14‑byte title. **Not present** (and therefore gaps, §5): SeatMap Display,
Flight Cheapest Date / Inspiration / Price Analysis, Airport & City Search, Flight Status, Check‑in Links,
any reissue / refund / EMD / document API.

### 1.2 Endpoint keys (`src/core/endpoints.js` defaults)

| endpoint key | default path template | Amadeus operation | note |
|---|---|---|---|
| `search.create` | `POST /v2/shopping/flight-offers` | searchFlightOffers | synchronous; OTA facade adds `meta.sessionId`, `meta.expiresAt` |
| `search.createQuick` | `GET /v2/shopping/flight-offers` | getFlightOffers | optional fast path (1–2 bounds, no filters); same adapter |
| `search.get`, `search.poll`, `search.page`, `search.stream`, `search.alternatives` | `/v1/flights/search/{id}[…]` | — | backend‑defined, served from the facade's cached result set |
| `offers.reprice`, `offers.combine`, `itinerary.price` | `POST /v1/shopping/flight-offers/pricing` | quoteAirOffers | one key family, one adapter |
| `offers.brandedFares` | `POST /v1/shopping/flight-offers/upselling` | upsellAirOffers | body carries the full `FlightOffer` (`raw`), not an id |
| `offers.availability` | `POST /v1/shopping/availability/flight-availabilities` | searchFlightAvailabilities | re‑query by segments; not a GET by id |
| `booking.create`, `booking.hold` | `POST /v1/booking/flight-orders` | createFligtOrders | body `{ data: FlightOrder, meta: { itineraryId, consents, metadata } }` — facade strips `meta` |
| `booking.get`, `trips.get` | `GET /v1/booking/flight-orders/{id}` | getFlightOrder (management) | `include=bags`, `fareRules=rebooks,refunds` on demand |
| `booking.abandon`, `trips.cancellation.confirm` (full, un‑ticketed) | `DELETE /v1/booking/flight-orders/{id}` | cancelFlightOrder | 204, no refund data |
| `booking.patch` (used by `trips.requests.updateDocuments` / `updateContact`, post‑booking seats/bags, remarks) | `PATCH /v1/booking/flight-orders/{id}` | patchFlightOrder | immediate, no quote |
| `booking.finalize` (`booking.issue`) | `POST /v1/booking/flight-orders/{id}/issuance` | issueFlightOrder | called by the facade after payment settles; SDK call is a trigger |
| `booking.retrieve`, `trips.byReference` | `GET /v1/booking/flight-orders/by-reference` | getFlightOrder (by‑reference) | facade **adds** `lastName`/`email` verification (Amadeus has none) |
| everything else (`places.*`, `content.*`, `itinerary.*`, `travelers.*`, `ancillaries.*`, `payments.*`, `trips.*` servicing, `account.*`, `wallet.*`, `alerts.*`, `support.*`) | `/v1/...` as written in the module docs | — | backend‑defined |

The order id (`FlightOrder.id`) is base64‑like and may contain `=`/`+`/`/`: templates URL‑encode `{id}`.

---

## 2. Function → operation mapping

### 2.1 `places` (04‑reference‑data §1)

| function | backing | notes |
|---|---|---|
| `places.search`, `places.searchDebounced` | backend‑defined | no Amadeus autocomplete spec in `amadeus/` |
| `places.get`, `places.getMany` | backend‑defined (partial from `dictionaries.locations`) | search/pricing/order responses give `{cityCode,countryCode}` per IATA code only — no name, tz, coordinates. Adapters hydrate `Place` via `places.getMany` (cached); until resolved, `Place{code,cityCode,countryCode,type: cityCode===code?'city':'airport'}` with `name`/`tz` undefined |
| `places.nearby`, `places.detectLocation`, `places.popular`, `places.popularRoutes`, `places.resolveMetro` | backend‑defined | — |
| `places.airlines.list`, `places.airlines.get` | backend‑defined (partial from `dictionaries.carriers`) | `code → name` for carriers present in a response; `operating.carrierName` (search spec) when no IATA code; no logo/alliance/lowCost |
| `places.airlines.logoUrl` | client‑side | — |
| `places.alliances` | backend‑defined | Amadeus has no alliance concept; `SearchParams.alliances` is expanded to carrier codes client‑side before `toSearchRequest` |
| `places.aircraft.get` | backend‑defined (partial from `dictionaries.aircraft`) | `code → name` |
| `places.countries`, `places.currencies`, `places.exchangeRates` | backend‑defined | `dictionaries.currencies` gives `code → name` only; `billingCurrency` may differ from requested currency without a rate |
| `places.recent.*` | client‑side | storage only |

### 2.2 `search` (05 §1) and `filters` (05 §2)

| function | backing | notes |
|---|---|---|
| `search.create` | backed by `POST /v2/shopping/flight-offers` (`toSearchRequest` / `fromSearchResponse`) | **Request**: `slices[i]` → `originDestinations[i] { id: String(i+1), originLocationCode, destinationLocationCode, departureDateTimeRange: { date, time: timeWindow.from+':00', timeWindow: ceil(span/2)+'H' (1..12), dateWindow: flexDays ? 'I'+flexDays+'D' } }` (round_trip ⇒ 2 ODs, multi_city ≤ 6); `passengers` → `travelers[]` with ids `'1'..'N'`: ADULT, CHILD, HELD_INFANT (+`associatedAdultId` = nth adult), SEATED_INFANT, YOUNG, SENIOR; `fareTypes`: student/senior/youth ⇒ traveler types STUDENT/SENIOR/YOUNG, corporate ⇒ `pricingOptions.fareType ['CORPORATE']` + `corporateCodes` (from bootstrap), regular ⇒ `fareOptions ['STANDARD']`, armed_forces/doctor ⇒ dropped + `ValidationIssue{code:'fare_type_unsupported'}`; `cabin` → `flightFilters.cabinRestrictions [{ cabin: UPPER, coverage: allowMixedCabin ? 'MOST_SEGMENTS' : 'ALL_SEGMENTS', originDestinationIds: all }]`; `directOnly` ⇒ `connectionRestriction.maxNumberOfConnections 0`; `maxStops` ⇒ same (0\|1\|2); `includeNearby` ⇒ `originRadius`/`destinationRadius` (km, ≤300; **drops** `flexDays`/`timeWindow`, mutually exclusive); `airlines.include/exclude` ⇒ `carrierRestrictions.included/excludedCarrierCodes` (≤99); `alliances` ⇒ expanded codes; `refundableOnly` ⇒ `pricingOptions.refundableFare`; `baggageIncluded` ⇒ `includedCheckedBagsOnly`; `allowSelfTransfer` ⇒ `connectionRestriction.airportChangeAllowed` (no self‑transfer product); `maxDurationMinutes` ⇒ **not sent** (`maxFlightTime` is a %), applied client‑side; `currency` ⇒ `currencyCode`; `context` ⇒ no equivalent. Always: `sources` (config, default `['GDS']`), `searchCriteria.maxFlightOffers 250`, `maxUpsellOffers` (config 0..6), `additionalInformation { chargeableCheckedBags, brandedFares, fareRules: true }`, `addOneWayOffers: resultMode !== 'combined'`. Header `X-HTTP-Method-Override: GET`. **Response**: synchronous `{ data: FlightOffer[], meta: { count, oneWayCombinations[] }, dictionaries, warnings }` → `SearchSession{ id: meta.sessionId (facade), status: 'complete', providersPending: 0, resultMode: any data[].oneWay ? 'per_slice' : 'combined', offers: data.filter(!oneWay).map(fromFlightOffer), sliceOffers[i]: oneWay offers grouped by meta.oneWayCombinations[].originDestinationId, combinableWith from the same entry, meta.total: meta.count, meta.currency, meta.expiresAt: facade TTL, warnings }`. Split‑mode decision in §4 C‑8 (fan‑out fallback when no `oneWay` offers come back). GET variant (`search.createQuick`): `originLocationCode, destinationLocationCode, departureDate, returnDate?, adults, children, infants, travelClass, included/excludedAirlineCodes, nonStop, currencyCode, maxPrice, max` |
| `search.get`, `search.poll`, `search.page`, `search.stop`, `search.cancel` | backend‑defined (`/v1/flights/search/{id}`) | Amadeus has no session, cursor or stream: the facade caches the converted result set under `sessionId`; `GET` returns the same envelope (`status: 'complete'`, `hasMore: false`); 404 ⇒ SDK re‑runs `search.create`. `cancel` only aborts the in‑flight HTTP call |
| `search.refresh` | backed by `POST /v2/shopping/flight-offers` (re‑run) | new response‑scoped ids: selection is re‑matched by segment signature (`carrierCode+number+departure.at`), `offer:priceChanged` when `grandTotal` differs |
| `search.current`, `search.status`, `search.params`, `search.visibleOffers`, `search.facets`, `search.summary`, `search.activeFilterChips`, `search.expiry`, `search.history.*`, `search.compare.*`, `search.defaults`, `search.normalize`, `search.toUrl`, `search.fromUrl` | client‑side | `normalize`: uppercase IATA, chronological ODs (spec requirement), dedupe carrier lists, clamp `maxStops` 0..2 |
| `search.validate` | client‑side | limits seeded from the specs when the backend is Amadeus‑backed: slices 1..6; seated pax (ADT+CHD+INS+YTH+SRC+STU) ≤ 9; lap infants ≤ adults; total ≤ 18; dates not past and ≤ 365 days ahead; `flexDays` ≤ 3; `timeWindow` span ≤ 24 h; carrier lists ≤ 99; codes `[A-Z]{3}`, `[0-9A-Z]{2}`; `includeNearby` incompatible with `flexDays`/`timeWindow` |
| `search.setFilters`, `search.resetFilters`, `search.setSort` | client‑side (server mode: backed by a **new** `POST /v2/shopping/flight-offers`) | server‑side pre‑filters available: `maxNumberOfConnections`, `included/excludedCarrierCodes`, `cabinRestrictions`, `maxPrice` (integer, per traveler), `includedCheckedBagsOnly`, `refundableFare`, `departureDateTimeRange.time`+`timeWindow`, `included/excludedConnectionPoints` (≤2/≤3). No server equivalent for alliances, aircraft, flight numbers, layover min/max, arrival buckets, duration. Every re‑query yields new ids and possibly new prices ⇒ keep `meta.serverFiltered = false` by default |
| `search.selectSliceOffer` | client‑side → `offers.combine` | validates the pair against `combinableWith` (from `meta.oneWayCombinations`) before pricing |
| `search.flexibleDates` | backed by `POST /v2/shopping/flight-offers` (partial) | `departureDateTimeRange.dateWindow 'I{days}D'` (days ≤ 3, pattern `^[MPI][1-3]D`) + `oneFlightOfferPerDay: true`; `DateGrid` cells = min `grandTotal` per (out date × back date); empty cells likely (≤250 offers, not a full matrix); incompatible with nearby radius |
| `search.calendar`, `search.priceGraph`, `search.explore`, `search.insights` | backend‑defined | no fare‑calendar / inspiration / price‑analysis spec in `amadeus/` (§5.1) |
| `search.nearbyAlternatives` | backed by `POST /v2/shopping/flight-offers` ×2 (partial) | airports: `originRadius`/`destinationRadius` or `alternativeOrigins/DestinationsCodes` (≤2) + `crossBorderAllowed`; dates: `dateWindow 'I3D'` + `oneFlightOfferPerDay`; two calls because radius and date window are mutually exclusive; grouped min price per airport / date |
| `search.track` | backend‑defined (→ `alerts.create`) | — |
| `filters.*` (`applyFilters`, `matches`, `sortOffers`, `rank`, `tagOffers`, `computeFacets`, `defaultFilters`, `isDefault`, `activeChips`, `mergeFacets`, `dedupeOffers`, `groupBySlice`, `priceBounds`, `priceHistogram`, `summarize`, `combinable`, constants) | client‑side | derived inputs: stops = `segments.length−1` (technical stops separately from `numberOfStops`), airlines = distinct `carrierCode`, duration = ISO‑8601 parse, layover = offset‑corrected `next.departure − prev.arrival`; `combinable(out, in)` = both ids present in the same `oneWayCombinations` entry; must tolerate unpriced offers (`availability` results) |

### 2.3 `offers` (05 §3)

| function | backing | notes |
|---|---|---|
| `offers.get` | backend‑defined (state hit; miss re‑runs pricing) | Amadeus has no `GET /flight-offers/{id}`; ids are `'1'..'n'` per response. SDK ids are `${sessionId}:${FlightOffer.id}`; the raw `FlightOffer` is kept on `Offer.raw` because pricing/upsell/order calls need the whole object. `fresh: true` ⇒ `offers.reprice` |
| `offers.details` | backed by data already in the search/pricing response (partial) | `amenitiesBySegment[segmentId]` ← `travelerPricings[0].fareDetailsBySegment[].amenities[]` (search spec: 24 `amenityType` values incl. WIFI, POWER, SEAT, BEVERAGE; ATPCO RouteHappy); `baggage` ← `includedCheckedBags`/`includedCabinBags`; `fareRules` ← `FlightOffer.fareRules` (summary) or pricing `include=detailed-fare-rules`; `warnings` derived: `blacklistedInEU`, airport change, overnight / long / short layover, `nonHomogeneous` (multiple PNRs), `instantTicketingRequired`, `paymentCardRequired`, `stops[]` technical stop. Visa‑required transit and on‑time stats: no source |
| `offers.fareRules` | backed by `FlightOffer.fareRules` (summary) / `POST /v1/shopping/flight-offers/pricing?include=detailed-fare-rules` + `additionalInformation.fareRules` (full) | categories REFUND, EXCHANGE, REVALIDATION, REISSUE, REBOOK, CANCELLATION → `penalties[].type` cancel / change; `when` ← `circumstances`; amount ← `{ maxPenaltyAmount, fareRules.currency }`; `raw[]` ← `included['detailed-fare-rules']` (declared as one object, described as a map keyed by fare basis — parse both). No `no_show` category |
| `offers.brandedFares` | backed by `POST /v1/shopping/flight-offers/upselling` (`toUpsellRequest` / `fromUpsell`) | body `{ data: { type: 'flight-offers-upselling', flightOffers: [raw] } }` (≤6 offers; optional `payments[]{brand,binNumber,flightOfferIds}` for FOP fees). Response `data[]` = complete, priceable `FlightOffer`s with **new ids**; `FareFamily.code` ← distinct `fareDetailsBySegment[].brandedFare` (GDS only); `name` ← `brandedFareLabel` (search spec) else code; `tier` ← rank by `grandTotal`; `priceDelta` ← `U.grandTotal − base.grandTotal`; `features` ← union of `amenities[]` `{ code, label: description, included: isChargeable ? 'fee' : true, detail: amenityType }`; each `data[i]` also stored as an `Offer` (`fareFamiliesById` + `search.offers.byId`). Per‑slice mode: `meta.oneWayUpselledCombinations[] { flightOfferId, upselledFlightOfferIds[] }` maps families back to the slice offer. 400 code **39397 UNABLE TO RETRIEVE UPSELL OFFER** = "no families" ⇒ resolve `[]` (not an error). Search prefetch alternative: `searchCriteria.maxUpsellOffers 1..6` ⇒ inline offers with `isUpsellOffer` / `upsellFlightOfferIds` |
| `offers.selectFareFamily` | client‑side | swaps selection to the upsold `FlightOffer` (already priced); still re‑priced before the cart |
| `offers.combine` | backed by `POST /v1/shopping/flight-offers/pricing` (`toPricingRequest` with N offers) | `data.flightOffers` = one `oneWay` `FlightOffer` per slice (≤6), `forceClass=true`, optional `include=bags,other-services`. Amadeus prices them side by side and never merges: the adapter synthesises the combined `Offer` (`id` = `${sessionId}:${ids.join('+')}`, slices concatenated, `price` = Σ `grandTotal` same currency, `passengers` merged by type, `conditions` = most restrictive, `tickets` = one `TicketGroup` per offer, `lastTicketingDate` = earliest). Offer **and segment ids must be unique within one request**: the adapter renumbers (`'1'`,`'2'`, segments `'11'`,`'21'`…) and keeps the map to restore `raw`. 400 code 2668 ⇒ `ValidationError('not combinable')`, other 400 ⇒ `OfferUnavailableError`. With split default this is the primary pre‑cart path |
| `offers.reprice` | backed by `POST /v1/shopping/flight-offers/pricing` (`toPricingRequest` / `fromPricingResponse`) | body `{ data: { type: 'flight-offers-pricing', flightOffers: [raw], additionalInformation: { fareRules: true } } }`, `forceClass=true` when a specific fare/brand was chosen. `changed` = out `grandTotal`/currency ≠ in (also diff per‑traveler totals and `fareDetailsBySegment[].class`, which may move when `forceClass=false`); `from`/`to` built by the SDK (Amadeus returns only the new price); `warnings[]` surfaced; the priced `FlightOffer` **replaces** `raw` (Create Orders needs the priced object). Sell‑failure / 4926 ⇒ `OfferUnavailableError`; `OfferExpiredError` is inferred locally (no Amadeus code). Response also carries `bookingRequirements` (§2.4) |
| `offers.availability` | backed by `POST /v1/shopping/availability/flight-availabilities` (`toAvailabilityRequest` / `fromAvailability`) | re‑query from the cached offer: `originDestinations[]` from each slice (`departureDateTime { date, time }`), `travelers[]` from `passengers`, `sources` (`GDS\|LTC\|PYTON\|EAC`, no NDC), `searchCriteria { includeClosedContent: true, flightFilters.carrierRestrictions.includedCarrierCodes, class }`; header `X-HTTP-Method-Override: GET`. Match `data[]` by `(carrierCode, number, departure.iataCode, departure.at)`; `seatsLeft` = min `availabilityClasses[class===bookingClass].numberOfBookableSeats` (1..9, **9 = "9 or more"**); `available` = all segments matched, no `closedStatus`; `closedStatus` NOT_AVAILABLE/CANCELLED/DEPARTED ⇒ `OfferUnavailableError{reason:'sold_out'\|'schedule_changed'\|'withdrawn'}`; class `WAITLIST_OPEN\|WAITLIST_CLOSED\|ON_REQUEST` ⇒ `available:false`. Static fallback: `FlightOffer.numberOfBookableSeats` |
| `offers.select`, `offers.deselect`, `offers.selection`, `offers.selected`, `offers.share`, `offers.toUrl`, `offers.fromUrl` | client‑side | deep links embed `sessionId:offerId`; re‑match after refresh |
| `offers.seatMapPreview` | backend‑defined | no SeatMap Display spec; only `chargeableSeat{id,number}` / `amenitySeat{legSpace,tilt}` exist (§5.1) |
| `offers.baggageOptions` | backed by `POST /v1/shopping/flight-offers/pricing?include=bags` (partial) | `included.bags` map → `Service{ id: key, type:'baggage', code: name ('CHECKED_BAG'), label: descriptions[0] ?? quantity×weight+unit, price: { amount (strip trailing 'A' = additional collection), currency: price.currencyCode }, scope: bookableByItinerary ? 'per_passenger_slice' : 'per_passenger', eligiblePassengerTypes ← travelerIds, segmentId/sliceId ← segmentIds }`; search‑time first‑extra‑bag price from `additionalServices.chargeableCheckedBags` + `price.additionalServices[CHECKED_BAGS]` (Amadeus Ancillary Services carriers only). No dimensions, no piece tiers |
| `offers.emissions` | backed by `Segment.co2Emissions[]` in search/pricing/availability responses (partial) | `kg` = Σ segments `co2Emissions[cabin match].weight` (LB × 0.4536); `vsTypicalPct` has no source |
| `offers.priceLockOptions` | backend‑defined | no fare‑freeze product; nearest is a `DELAY_TO_CANCEL` hold (§5.3) |

### 2.4 `itinerary` (06 §1)

| function | backing | notes |
|---|---|---|
| `itinerary.create` | backend‑defined cart; the re‑price step is backed by `POST /v1/shopping/flight-offers/pricing?include=bags,other-services,detailed-fare-rules` | Amadeus is stateless: the facade stores the priced `FlightOffer` JSON per itinerary (≤6 offers ⇒ cart cap). `passengers` cannot change the mix (`travelerPricings` fixed by the search ⇒ new search); `promoCode`/`metadata` have no Amadeus field (metadata → `remarks` at booking). `requirements` ← `bookingRequirements`; `priceChange` ← `grandTotal` diff; `threeDomainSecureRequirements[].is3dsAuthenticationRequired` stored for payments; catalogue seeded from `included.bags` / `included['other-services']` |
| `itinerary.get`, `itinerary.current`, `itinerary.resume`, `itinerary.expiry`, `itinerary.extend`, `itinerary.clear` | backend‑defined | no cart id / expiry / extend in Amadeus; `expiresAt` is the facade's TTL |
| `itinerary.replaceOffer`, `itinerary.addOffer`, `itinerary.removeOffer` | backend‑defined; re‑price backed by pricing | facade re‑runs pricing with the new offer set (≤6), drops `additionalServices` whose segments vanished |
| `itinerary.setPassengers` | backend‑defined | **not possible on Amadeus without a new search**; facade must re‑search + re‑price |
| `itinerary.reprice` | backed by `POST /v1/shopping/flight-offers/pricing` (`forceClass=true`, `include=credit-card-fees` with `payments[]` when a brand/BIN is known) | selected ancillaries are folded into `travelerPricings[].fareDetailsBySegment[].additionalServices` (`chargeableCheckedBags`, `chargeableCabinBags`, `chargeableSeat`, `otherServices[]`) so `grandTotal` includes them; `PriceBreakdown.ancillaries` ← Σ `price.additionalServices[]`; card fee ← `included['credit-card-fees'][brand]` / `fees[type=FORM_OF_PAYMENT]` |
| `itinerary.acceptPriceChange` | backend‑defined | consent record; Amadeus alternative is `price.margin` tolerance at booking |
| `itinerary.applyPromo`, `itinerary.removePromo`, `itinerary.eligiblePromos` | backend‑defined | `Price.discounts[] (AGENT_DISCOUNT)` / `margins[]` are agency margin‑manager values, **not** promo codes; never conflate |
| `itinerary.requirements` | backed by `bookingRequirements` of `POST /v1/shopping/flight-offers/pricing` (partial) | per‑traveler flags → `FieldRule` paths: `genderRequired`→`gender` (options `['M','F']` — Amadeus pricing gender enum is MALE\|FEMALE; orders accept UNSPECIFIED\|UNDISCLOSED), `dateOfBirthRequired`→`dob`, `documentRequired`→`DocumentRule{types:['passport','national_id','visa'], required}`, `documentIssuanceCityRequired`→`documents[].issuanceLocation`, `redressRequiredIfAny`→`redressNumber`, `residenceRequired`→`contact.address`, `airFranceDiscountRequired`/`spanishResidentDiscountRequired`→`discountEligibility`; booking‑level `emailAddressRequired`, `phoneNumberRequired` (`^[0-9]{1,15}$`), `phoneCountryCodeRequired` (`^[0-9+]{2,5}$`), `mobilePhoneNumberRequired`, `postalCodeRequired`, `mailingAddressRequired`, `invoiceAddressRequired`; `apis` ← any `documentRequired`; `ageRules` ← spec text `{ infantMax: 2, childMax: 12, refDate: 'departure', infantPerAdult: 1, maxPax: 9 }`; `gstAvailable`, `nameRules` ← OTA config (`cityName` pattern `[a-zA-Z -]{1,35}` suggests charset `'latin'`). Flags are per `travelerId` ⇒ OR‑ed per `PaxType`, kept per traveler too |
| `itinerary.setTravelers` | backend‑defined persistence; validation pass may be backed by pricing with `data.travelers[]` | mapping of `Traveler`/`Contact` → Amadeus `Traveler`/`Contact` in §3; 400 Issues (477, 2781, 32171, 4926) → `ValidationIssue{ path: pointer re‑based, code: String(code) }`. `NAME_MISMATCH`/`DOCUMENT_INVALID`/`DUPLICATE_TRAVELER` have no Amadeus codes |
| `itinerary.setContact`, `itinerary.setMetadata` | backend‑defined | serialised at booking into `contacts[]` (purpose STANDARD / INVOICE), `travelers[].contact`, `emergencyContact`, `remarks.general[]` |
| `itinerary.travelers`, `itinerary.contact`, `itinerary.slots`, `itinerary.priceBreakdown`, `itinerary.validate`, `itinerary.summary`, `itinerary.holdPolicy` | client‑side | `holdPolicy` derived from `raw`: `allowed = !instantTicketingRequired && source==='GDS'`, `freeUntil ≤ lastTicketingDate`, card needed when `paymentCardRequired` |
| `itinerary.lockOptions`, `itinerary.lock`, `itinerary.fromLock` | backend‑defined | no price‑lock product (§5.3) |

### 2.5 `travelers` (06 §2)

| function | backing | notes |
|---|---|---|
| `travelers.list`, `get`, `create`, `update`, `remove`, `setDefault`, `documents.*`, `loyalty.add/remove`, `importFromBooking` | backend‑defined | no profile store in Amadeus; profiles must round‑trip the Amadeus `Traveler` shape losslessly (documents incl. VISA/KTN/REDRESS, `loyaltyPrograms` ≤10). `importFromBooking` can read `FlightOrder.travelers[]` via `GET /v1/booking/flight-orders/{id}` |
| `travelers.loyalty.programmes`, `travelers.options.mealCodes`, `travelers.options.assistanceCodes` | backend‑defined | `LoyaltyProgram` is `{ programOwner: airline code, id }` only; no SSR catalogue |
| `travelers.suggestFor`, `toTraveler`, `validate`, `validateAll`, `paxTypeFor`, `ageAt`, `drafts.*`, `options.titles/genders/documentTypes` | client‑side | rules to encode from the specs: phone `[0-9]{1,15}`, calling code `[0-9+]{2,5}` (single‑digit codes need `'+1'`), country codes `[a-zA-Z]{2}`, `cityName [a-zA-Z -]{1,35}` (transliterate), gender set per provider, document types VISA\|PASSPORT\|IDENTITY_CARD\|KNOWN_TRAVELER\|REDRESS (**no driving licence**), ≤3 phones, ≤10 loyalty, HELD_INFANT needs an adult, travelers ≤18, seated ≤9, age bands CHILD <12, infants <2, SENIOR ≥60; `options.documentTypes` must not offer `driving_licence` for Amadeus‑backed itineraries |

### 2.6 `ancillaries` (06 §3)

| function | backing | notes |
|---|---|---|
| `ancillaries.catalog` (pre‑booking) | backed by `POST /v1/shopping/flight-offers/pricing?include=bags,other-services` (partial) | services = checked bags (`Bags`), chargeable cabin bags, `OtherServices` `PRIORITY_BOARDING\|AIRPORT_CHECKIN\|FAST_TRACK` (`scope` from `bookableByTraveler`/`bookableByItinerary`); `seatMapsAvailable` ← segments with any `chargeableSeat` (indicator only); `insurance`, `protections`, `bundles` ← OTA |
| `ancillaries.catalog` (`context.bookingId`) | backed by `GET /v1/booking/flight-orders/{id}?include=bags` (partial) | bags only |
| `ancillaries.add`, `remove`, `clear`, `baggage.set`, `extras.add/remove` | backend‑defined selection; realised on the wire by re‑pricing (`itinerary.reprice`) and at booking in `fareDetailsBySegment[].additionalServices`; post‑booking by `PATCH /v1/booking/flight-orders/{id}` | `SelectedAncillary{type:'baggage'}` → `chargeableCheckedBags { id, quantity, weight, weightUnit }` per traveler × segment (`per_passenger_slice` ⇒ every segment of the slice); cabin bag → `chargeableCabinBags`; priority boarding / fast track / airport check‑in → `otherServices[]`; prices come back aggregated in `price.additionalServices[type]`; 400 code 38034 ONE OR MORE SERVICES ARE NOT AVAILABLE ⇒ `ApiError{code:'SERVICE_UNAVAILABLE'}` |
| `ancillaries.baggage.options`, `baggage.selection`, `selected`, `total`, `summary`, `extras.list`, `seats.selection`, `seats.canSelect`, `validate` | client‑side | from the catalogue above |
| `ancillaries.seats.map`, `seats.autoAssign` | backend‑defined | no seat‑map spec (§5.1) |
| `ancillaries.seats.select`, `seats.unselect` | backend‑defined selection; wire = `chargeableSeat { id, number }` (pattern `[1-9][0-9]{0,2}[A-Z]?`) in pricing / create / PATCH | blind seat number without availability; `SEAT_TAKEN` surfaces only as 38034 |
| `ancillaries.meals.*` | backend‑defined | `mealServices[].label` is informational (meal served); `MEALS` exists only as a price bucket |
| `ancillaries.insurance.*`, `protections.*`, `bundles.*` | backend‑defined | no Amadeus product (§5.3); bundles ≈ fare families on Amadeus |

### 2.7 `booking` (07 §1)

| function | backing | notes |
|---|---|---|
| `booking.create` | backed by `POST /v1/booking/flight-orders?issue=false` (`toFlightOrderRequest` / `fromFlightOrder`) | body `data { type:'flight-order', flightOffers: itinerary.offers.map(raw) (priced objects verbatim, one per slice in split mode, ≤6), travelers[] (ids = `travelerPricings[].travelerId`), contacts[] (STANDARD + INVOICE from `gst`), remarks (metadata, GST number as `INVOICE` remark), ticketingAgreement (facade policy, e.g. `{ option:'DELAY_TO_CANCEL', delay:'1D' }`), formOfPayments omitted or `{ other: { method:'CASH' } }` }`; `meta { itineraryId, consents, metadata, idempotencyKey }` for the facade. 201 `Success_Booking` → `Booking` (§3). The facade **redacts** `formOfPayments[].creditCard.number/securityCode` and CONFIDENTIAL/BACKOFFICE remarks before answering. Error table in §4 C‑5 (37200 PRICE DISCREPANCY ⇒ facade re‑prices and returns `PriceChangedError` with `from/to`). **Never auto‑retry** (no idempotency on Amadeus; retry = second PNR) |
| `booking.holdOptions` | backend‑defined (derivable from `raw`) | `allowed = !instantTicketingRequired && source==='GDS'`; `holdUntil ≤ lastTicketingDate`; fees are OTA products |
| `booking.hold` | backed by `POST /v1/booking/flight-orders?issue=false` with `ticketingAgreement` | `onExpiry 'drop'` → `DELAY_TO_CANCEL`; `'charge'`/`'convert_to_paid'` → `DELAY_TO_QUEUE` (agent queue; OTA actions it); `delay` = whole days `'nD'`; `holdExpiresAt` ← readOnly `ticketingAgreement.dateTime` (date ⇒ local 00:00 office time, documented approximate); `HOLD_NOT_ALLOWED` when `instantTicketingRequired` |
| `booking.get`, `booking.current`, `booking.status`, `booking.resume` | backed by `GET /v1/booking/flight-orders/{id}` (`fromFlightOrder`) | status derived (§3 BookingStatus) |
| `booking.finalize` | backed by `POST /v1/booking/flight-orders/{id}/issuance` (facade‑triggered) | synchronous: 200 returns the order with `tickets[]`; `finalize` resolves immediately when every traveler × segment has an `ISSUED ETICKET`, otherwise falls through to `waitForTicketing`. FOP translation (`other.method CASH\|ACCOUNT`, or airline‑merchant `creditCard` + `paymentOperationContext.threeDomainSecure`) is server‑side only. 400 9112 TICKETING ‑ TKT ⇒ `BookingError{stage:'ticketing'}`; 409 2552 SIMULTANEOUS UPDATE ⇒ `ConflictError{retryable:true}` |
| `booking.waitForTicketing` | backed by polling `GET /v1/booking/flight-orders/{id}` | terminal when `tickets[]` covers all travelers (`ticketed`), some (`partially_ticketed`), any segment `DENIED` (`failed`); no stream |
| `booking.abandon` | backed by `DELETE /v1/booking/flight-orders/{id}` | 204; un‑ticketed orders only; 404 treated as already gone |
| `booking.retrieve` | backed by `GET /v1/booking/flight-orders/by-reference?reference=&originSystemCode=GDS` (partial) | `data` is `FlightOrder[]` → pick the order whose `associatedRecords[]` holds the reference; the **facade** verifies `lastName` (+`email`) against `travelers[].name.lastName` / contacts and mints the scoped token; Amadeus has no 404 on this op (unknown locator ⇒ 400 4926/32171 or empty `data`) ⇒ `NotFoundError` |
| `booking.documents` | backed by `FlightOrder.tickets[]` (partial) | `Document{type:'eticket', label, available: documentStatus==='ISSUED', url: undefined}`; PDFs/invoices/receipts are OTA‑rendered |
| `booking.download`, `booking.resendConfirmation`, `booking.timeline` | backend‑defined | timeline can be seeded from `associatedRecords[].creationDate` + ticket statuses |
| `booking.calendar`, `booking.share`, `booking.failureInfo`, `booking.clear` | client‑side | `failureInfo` uses the code table in §4 C‑5 |

### 2.8 `payments` (07 §2)

| function | backing | notes |
|---|---|---|
| `payments.methods`, `quote`, `credits.*`, `emiPlans`, `createIntent`, `mount`, `tokenize`, `confirm`, `handleAction`, `waitForResult`, `pay`, `resumeAfterRedirect`, `cancel`, `retry`, `intent`, `status`, `quoteState`, `savedMethods.*`, `receipt`, `refunds`, `gateways.*`, `clear` | backend‑defined (gateway / OTA) | Amadeus only records a `FormOfPayment` on the order (`creditCard` raw PAN + 3DS proof, `b2bWallet` agency virtual card, `other ACCOUNT\|CHECK\|CASH\|NONREFUNDABLE\|PYTON`) at create or issuance. Two touch points: card surcharge preview ← `POST /v1/shopping/flight-offers/pricing?include=credit-card-fees` with `payments[]{brand,binNumber,flightOfferIds}` → `PaymentMethod.fee` by brand; 3DS obligation ← `bookingRequirements.threeDomainSecureRequirements`. Brand enum (VISA, AMERICAN_EXPRESS, MASTERCARD, VISA_ELECTRON, VISA_DEBIT, MASTERCARD_DEBIT, MAESTRO, DINERS, EASYPAY/IXARIS/AIRPLUS/UATP/PYTON) covers cards only: UPI, net‑banking, wallets, BNPL, EMI, RuPay never have Amadeus‑side fees. Refunds: no Amadeus operation (`documentStatus REFUNDED` is read‑only evidence) |
| `payments.validateCard`, `payments.cardBrand` | client‑side | brand vocabulary above when the backend passes cards through (NDC); expiry must be re‑formatted `YYYY-MM` |

### 2.9 `trips` (08 §1)

| function | backing | notes |
|---|---|---|
| `trips.list` | backend‑defined | no per‑user listing; `QueueList` lists an **office queue** (every customer) and is back‑office only (§5.5) |
| `trips.get`, `trips.current` | backed by `GET /v1/booking/flight-orders/{id}` (`fromFlightOrder`) | `phase` from `segments[].isFlown` / `bookingStatus`; `nextSegment` = first ACTIVE segment not flown |
| `trips.byReference` | backed by `GET /v1/booking/flight-orders/by-reference` (as `booking.retrieve`) | — |
| `trips.phaseOf`, `nextSegment`, `summary`, `canDo`, `rebookParams`, `invalidate` | client‑side | `rebookParams` from `itineraries[].segments[0].departure` / last arrival / `travelerPricings` |
| `trips.flightStatus`, `trips.checkIn`, `trips.boardingPasses`, `trips.alerts.*`, `trips.rate` | backend‑defined | no flight‑status / check‑in spec; `bookingStatus` is a booking state, not operational |
| `trips.documents` | backed by `FlightOrder.tickets[]` (partial, as `booking.documents`) | `Document{type:'eticket', label, available: documentStatus==='ISSUED', url: undefined}`; non‑ticket documents (receipt, invoice, insurance, visa letter) are OTA‑rendered |
| `trips.download`, `trips.invoice.request` | backend‑defined | no document‑rendering operation in `amadeus/`; invoices: only `contacts[].purpose INVOICE` + `INVOICE` remark exist (§5.2) |
| `trips.changes.options` | backed by `GET /v1/booking/flight-orders/{id}?fareRules=rebooks` (partial) | `Extended_TermAndCondition` (REBOOK\|EXCHANGE\|REISSUE\|REVALIDATION: `notApplicable`, `maxPenaltyAmount`, `isChargeable`, `applicability { travelerIds, segmentIds }`, `rebookConditions { reshopValidatingAirlineCodes, waiverCode }`) → `ChangeOptions` grouped by itinerary; no deadlines |
| `trips.changes.search` | backed by `POST /v2/shopping/flight-offers` (reshop as a normal search) | prices are full fares, not differences; `context.bookingId` not transmittable |
| `trips.changes.quote`, `trips.changes.confirm` | backend‑defined | **no reissue / exchange operation in `amadeus/`** (§5.2) |
| `trips.cancellation.quote` | backed by `GET /v1/booking/flight-orders/{id}?fareRules=refunds` (partial) | `refundingPreview` (`TicketRefund { farePaid, fareUsed, fareRefund, totalRefund, cancellationPenalty, totalTax, paymentDetails[] }`, `ElementaryPrice` with `currencyCode`) → `CancelQuote` for the **whole order**; partial scope, protection cover, refund methods, ETA, void eligibility: OTA |
| `trips.cancellation.confirm` | backed by `DELETE /v1/booking/flight-orders/{id}` (full cancellation of un‑ticketed orders) | 204, no refund record; voiding/refunding issued tickets is **not** covered |
| `trips.refunds`, `trips.refundStatus` | backend‑defined | — |
| `trips.disruptions`, `trips.disruptions.respond` | backend‑defined | detection hints only: `segments[].bookingStatus` CANCELLED/PENDING/WAITLISTED, `segmentType GHOST`, PNR on an office queue |
| `trips.ancillaries(bookingId)` | backed by `GET …?include=bags` (catalogue) + `PATCH /v1/booking/flight-orders/{id}` (seats/bags/other services) | PATCH applies immediately and returns the whole order; no quote |
| `trips.amendment.quote`, `trips.amendment.confirm` | backend‑defined | facade prices from `included.bags` and holds the intent; PATCH on confirm; EMD issuance via issuance |
| `trips.requests.updateDocuments`, `trips.requests.updateContact` | backed by `PATCH /v1/booking/flight-orders/{id}` | documented PATCH example (`travelers[].documents[]`); contact PATCH is schema‑valid but undocumented; `ServiceRequest{status:'done'}` synthesised |
| `trips.requests.nameCorrection` | backed by `PATCH` (best effort) | undocumented; 400 4926 ⇒ fall back to a queued request |
| `trips.requests.specialAssistance`, `trips.requests.other` | backed by `PATCH` remarks (partial) | free‑text `remarks.general[] { subType GENERAL_MISCELLANEOUS }` / `remarks.airline[] { subType OTHER_SERVICE_INFORMATION, airlineCode }` (≤200 each); no coded SSR |
| `trips.requests.splitPnr` | backend‑defined | no split operation |
| `trips.requests.list` | backend‑defined (partial read‑back of `remarks`) | no status lifecycle |
| `trips.payNow` | backend‑defined (payments) → facade issuance | ticketing step = `POST …/issuance` |
| `trips.void` | backed by `DELETE` only while un‑ticketed | `documentStatus VOID` is read‑only; no void window |

### 2.10 `account`, `wallet`, `alerts`, `content`, `support` (09, 04 §2, 08 §2)

| module | functions | backing |
|---|---|---|
| `account` | `me`, `update`, `changeEmail`, `changePhone`, `verifyChange`, `changePassword`, `requestPasswordReset`, `resetPassword`, `preferences.*`, `addresses.*`, `billingProfiles.*`, `notifications.*`, `sessions.*`, `mfa.*`, `providers.*`, `consents.*`, `exportData`, `exportStatus`, `delete` | backend‑defined (all). Amadeus auth is agency client‑credentials; no end‑user identity |
| `wallet` | `balance`, `transactions`, `loyalty.status/history/earnPreview/redeemOptions`, `coupons.eligible/validate/mine`, `giftCards.check/mine/redeemToWallet`, `vouchers.list/applicable`, `referrals.code/stats/apply` | backend‑defined (all). Airline FF numbers are the only Amadeus loyalty touch point (`loyaltyPrograms`) |
| `alerts` | `create`, `createGuest`, `unsubscribe`, `list`, `get`, `update`, `pause`, `resume`, `remove`, `history`, `savedSearches.*`, `favorites.*` | backend‑defined; `forSearch` client‑side; `savedSearches.run` → `search.create` |
| `content` | `banners`, `deals`, `offers`, `faq`, `policy`, `page`, `destination`, `travelRequirements`, `airlinePolicies`, `airportInfo`, `announcements` | backend‑defined (CMS); `invalidate` client‑side. Fare‑family marketing names/feature labels also come from here (Amadeus gives `brandedFare` codes + uppercase ATPCO descriptions) |
| `support` | `contactOptions`, `tickets.*`, `callback.request`, `chat.token` | backend‑defined; `faq` → `content.faq` |

---

## 3. Type alignment

Conventions: `Σ` = sum of decimal strings via `utils/money`; `dict.*` = response `dictionaries`; `tp0` =
first ADULT `travelerPricings[]` entry; `fdbs(seg)` = `tp0.fareDetailsBySegment.find(segmentId === seg.id)`.

### 3.1 Requests (SDK → Amadeus)

| SDK (`SearchParams` / `SliceRequest` / `PaxCounts`) | Amadeus (`GetFlightOffersQuery`) | note |
|---|---|---|
| `slices[i].origin` / `.destination` | `originDestinations[i].originLocationCode` / `.destinationLocationCode` (`originLocationSubtype` CITY\|AIRPORT optional) | `id: String(i+1)` |
| `slices[i].date`, `.timeWindow.from`, span, `.flexDays` | `departureDateTimeRange.date`, `.time` (`hh:mm:ss`), `.timeWindow` (`^([1-9]\|10\|11\|12)H`, symmetric), `.dateWindow` (`^[MPI][1-3]D`) | asymmetric windows (P/M) unused; `arrivalDateTimeRange` unused |
| `passengers.adults/children/infants/infantsSeated/youth/seniors`, `childAges` | `travelers[] { id, travelerType ADULT\|CHILD\|HELD_INFANT\|SEATED_INFANT\|YOUNG\|SENIOR\|STUDENT, associatedAdultId, fareOptions[], loyaltyPrograms[] }` | `childAges` dropped (fixed bands) |
| `cabin`, `allowMixedCabin` | `flightFilters.cabinRestrictions[] { cabin, coverage MOST_SEGMENTS\|AT_LEAST_ONE_SEGMENT\|ALL_SEGMENTS, originDestinationIds }` | GET: `travelClass` ("most of the flight time in this cabin or higher") |
| `fareTypes` | traveler types (student/senior/youth), `pricingOptions.fareType PUBLISHED\|NEGOTIATED\|CORPORATE` + `corporateCodes ([0-9A-Z]{6}, ≤6)`, `fareOptions` (STANDARD, INCLUSIVE_TOUR, SPANISH_*_RESIDENT, AIR_FRANCE_*, COMPANION, VISIT_FRIENDS_RELATIVES, CONTRACT_BULK) | armed_forces / doctor: no equivalent |
| `directOnly`, `maxStops`, `allowSelfTransfer` | `connectionRestriction.maxNumberOfConnections 0\|1\|2`, `.airportChangeAllowed`, (`.technicalStopsAllowed`, `.nonStopPreferred(+Weight)` config) | GET: `nonStop` |
| `includeNearby` | `originRadius` / `destinationRadius` (km ≤300), `alternativeOrigins/DestinationsCodes` (≤2) | excludes date/time windows |
| `airlines.include/exclude`, `alliances` | `carrierRestrictions.includedCarrierCodes / excludedCarrierCodes` (1..99), `.blacklistedInEUAllowed` | alliances expanded client‑side |
| `refundableOnly`, `baggageIncluded` | `pricingOptions.refundableFare`, `.includedCheckedBagsOnly` (also `noRestrictionFare`, `noPenaltyFare`, `minimumDelayBeforeTicketing 'nD'`) | — |
| `maxDurationMinutes` | — (`flightFilters.maxFlightTime` is a % of the shortest solution) | client‑side filter |
| `currency` | `currencyCode` | GET: `currencyCode` |
| `resultMode` | `searchCriteria.addOneWayOffers` (`per_slice` ⇒ true) | see §4 C‑8 |
| — (config) | `sources[]` (GDS\|LTC\|PYTON\|EAC\|NDC; availability has no NDC), `maxFlightOffers` (≤250), `maxUpsellOffers` (0..6), `additionalInformation { chargeableCheckedBags, brandedFares, fareRules }`, `excludeAllotments`, `oneFlightOfferPerDay`, `flightFilters.crossBorderAllowed / moreOvernightsAllowed / returnToDepartureAirport / railSegmentAllowed / busSegmentAllowed`, `included/excludedConnectionPoints` | recommended additions: `SearchParams.nearbyRadiusKm?`, `corporateCodes?`, `sources?`, `via?: { include?, exclude? }` |

### 3.2 `Offer` ← `FlightOffer` (search · pricing · upsell · orders)

| SDK field | Amadeus path | note |
|---|---|---|
| `id` | `id` (`'1'…`, response‑scoped) | SDK id = `${sessionId}:${id}`; `raw` keeps the wire id |
| `owner` | `validatingAirlineCodes[0]` + `dict.carriers[code]` | add `validatingAirlines` ← whole array (already in type) |
| `slices[]` | `itineraries[]` | §3.3 |
| `price` | `price` (`Extended_Price`) | §3.5 |
| `passengers[]` | `travelerPricings[]` grouped by `travelerType` | §3.6 |
| `fareFamily` | `fdbs.brandedFare` / `brandedFareLabel` (search spec) ; upsell siblings via `isUpsellOffer`, `upsellFlightOfferIds` | §3.9 |
| `baggage` | `travelerPricings[].fareDetailsBySegment[].includedCheckedBags / includedCabinBags` | §3.7 |
| `conditions` | `fareRules.rules[]` (+ `pricingOptions.refundableFare / noPenaltyFare` fallback) | §3.8 |
| `tags` | — | computed by `filters.tagOffers` |
| `expiresAt` | — | facade result‑cache TTL; **never** `lastTicketingDate` |
| `tickets[]` | `nonHomogeneous` + `validatingAirlineCodes[]`; one group per `FlightOffer` in a combined (split) offer | `nonHomogeneous` = multiple PNRs, not self‑transfer |
| `selfTransfer` | — | always `false` for Amadeus content |
| `seatsLeft` | `numberOfBookableSeats` (1..9) | semantics "bookable in one request"; show only when `< 9` (§4 C‑9) |
| `emissionsKg` | Σ `itineraries[].segments[].co2Emissions[cabin match].weight` (`weightUnit` LB → ×0.4536) | — |
| `source` | `source` (GDS\|LTC\|PYTON\|EAC\|NDC) | — |
| `hold` | — (derived: `instantTicketingRequired`, `paymentCardRequired`, `lastTicketingDate`, `source`) | OTA policy |
| `lastTicketingDate` | `lastTicketingDate` (YYYY‑MM‑DD; example in 6 specs is `…T00:00:00.000Z`) | normalise with `/^\d{4}-\d{2}-\d{2}/` |
| `oneWayCombinable` | `oneWay` | — |
| `raw` | the whole `FlightOffer` | mandatory for Amadeus‑backed offers |

### 3.3 `Slice` ← `itineraries[]` (inline `{ duration, segments[1..9] }`)

| SDK field | Amadeus path | note |
|---|---|---|
| `id` | — | `${offerId}:${index}` |
| `origin` / `destination` | `segments[0].departure.iataCode` / `segments[last].arrival.iataCode` + `dict.locations[code]` | hydrated via `places` |
| `departureAt` / `arrivalAt` | `segments[0].departure.at` / `segments[last].arrival.at` | local, no offset → offset attached or `localTimeOnly` |
| `durationMinutes` | `duration` (ISO‑8601 `PT18H30M`, optional) | fallback Σ segments + layovers |
| `stops` | `segments.length − 1` | technical stops separately (`Segment.technicalStops`) |
| `segments[]` | `segments[]` | §3.4 |
| `layovers[]` | derived from consecutive segments | `airportChange` = `arrival.iataCode !== next.departure.iataCode`; `overnight` by local dates; `selfTransfer` false |
| `fareBrand` | `fdbs(segments[0]).brandedFareLabel ?? brandedFare` | — |
| `dayChange` | local date diff arrival − departure | safe without offsets |

### 3.4 `Segment` ← `Segment` (= `FlightSegment` + `id`, `numberOfStops`, `blacklistedInEU`, `co2Emissions`)

| SDK field | Amadeus path | note |
|---|---|---|
| `id` | `id` (`'40'`, scoped to the offer) | SDK `${offerId}:${id}`; keep wire id for `fareDetailsBySegment.segmentId`, `tickets[].segmentIds`, `Bags.segmentIds`, PATCH |
| `marketingCarrier` | `carrierCode` (1–2 chars) + `dict.carriers` | — |
| `operatingCarrier` | `operating.carrierCode ?? carrierCode` (+ `operating.carrierName` in search spec) | make optional in type or default to marketing |
| `flightNumber` | `number` (string 1–4, keep as string) | — |
| `aircraft` | `aircraft.code` (`[a-zA-Z0-9]{3}`) + `dict.aircraft` | — |
| `origin` / `destination` | `departure.iataCode` / `arrival.iataCode` | — |
| `departureAt` / `arrivalAt` | `departure.at` / `arrival.at` (`YYYY-MM-ddThh:mm:ss`, local, `format: date-time` but no offset) | + `localTimeOnly` flag |
| `durationMinutes` | `duration` (ISO‑8601) | — |
| `cabin` / `bookingClass` / `fareBasis` | `fdbs(seg).cabin` (lowercased) / `.class` (`[A-Z]`) / `.fareBasis` | per traveler per segment on Amadeus; availability results have no cabin (take the requested one) |
| `terminals.from / .to` | `departure.terminal` / `arrival.terminal` | — |
| `amenities[]` | `fdbs(seg).amenities[]` → `{ type: map(amenityType), value: description, paid: isChargeable }` + `mealServices[].label` → `{type:'meal'}` | map WIFI→wifi, POWER→power, MEAL/BEVERAGE→meal, ENTERTAINMENT→entertainment, SEAT→seat_pitch (`amenitySeat.legSpace spaceUnit`, `tilt`), others lower‑cased |
| `distanceKm`, `onTimePct` | — | no source |

### 3.5 `PriceBreakdown` / `Money` ← `Extended_Price` / `Price` / `Fee` / `Tax` / `BilledPrice` / `ElementaryPrice`

| SDK field | Amadeus path | note |
|---|---|---|
| `total` | `{ amount: grandTotal ?? total, currency }` | `grandTotal` includes fees + selected additional services |
| `base` | `base` + `currency` | — |
| `taxes` | Σ `travelerPricings[].price.taxes[].amount` (offer‑level `taxes[]` is often absent) else `total − base − Σfees` | — |
| `fees` | Σ `fees[].amount` (`type` TICKETING\|FORM_OF_PAYMENT\|SUPPLIER) | — |
| `discounts` | Σ `discounts[].amount` (`AGENT_DISCOUNT`) | agency margin, not promo |
| `ancillaries` | Σ `additionalServices[].amount` (`type` CHECKED_BAGS\|CABIN_BAGS\|MEALS\|SEATS\|OTHER_SERVICES) | `CABIN_BAGS` only in pricing/orders specs |
| `perPax` | `tp0.price.total` | — |
| `items[]` | `taxes[] {code}`, `fees[] {type}`, `additionalServices[] {type}`, `margins[] {AGENT_MARKUP\|AGENT_FEE}`, `refundableTaxes`, card fee `included['credit-card-fees'][brand]` | `ElementaryPrice.amount` may end in `'A'` (additional collection) — strip, flag in label; key is `currencyCode` |
| *(add)* `billing?: Money` | `billedPrice { currency, grandTotal }` / `billingCurrency` | may differ from display currency |

### 3.6 `PaxPrice` / `PaxCounts` ← `TravelerPricing`

| SDK field | Amadeus path | note |
|---|---|---|
| `type` | `travelerType` | ADULT↔ADT, CHILD↔CHD, HELD_INFANT↔INF, SEATED_INFANT↔INS, YOUNG↔YTH, SENIOR↔SRC, STUDENT↔STU |
| `count` | group size | — |
| `unit` | `price { currency, total, base, taxes[], fees[], refundableTaxes }` of the first member | — |
| *(add)* `fareOption?`, `travelerIds?` | `fareOption` (14 values), `travelerId`, `associatedAdultId` | needed to rebuild `travelerPricings` for pricing/orders |

### 3.7 `BaggageAllowance` / `BagRule` / `Service` ← baggage structures

| SDK field | Amadeus path | note |
|---|---|---|
| `items[].paxType`, `.segmentId`, `bySegment: true` | `travelerPricings[].travelerType` × `fareDetailsBySegment[].segmentId` | per traveler × segment |
| `checked[] { quantity, weightKg, included: true }` | `includedCheckedBags { quantity \| weight + weightUnit }` | LB → kg; `dimensionsCm` undefined |
| `checked[] { included: false, price }` | `additionalServices.chargeableCheckedBags { id, quantity, weight, weightUnit, descriptions[] }` + `price.additionalServices[CHECKED_BAGS]` / `included.bags[id].price` | — |
| `cabin[]` | `includedCabinBags` (search spec) / `additionalServices.chargeableCabinBags` | otherwise empty |
| `Service` (baggage) | `included.bags[id] { name, price { amount, currencyCode }, quantity, weight, weightUnit, bookableByItinerary, segmentIds, travelerIds, descriptions }` | §2.3 `offers.baggageOptions` |
| `Service` (extras) | `included['other-services'][id] { name PRIORITY_BOARDING\|AIRPORT_CHECKIN\|FAST_TRACK, price, bookableByTraveler, bookableByItinerary, segmentIds, travelerIds, descriptions }` | add `'airport_checkin'` to `AncillaryType` |

### 3.8 `Conditions` / `FareRules` ← `FareRules { currency, rules: TermAndCondition[] }`

| SDK field | Amadeus path | note |
|---|---|---|
| `refundable` | rule `REFUND`/`CANCELLATION`: `!notApplicable`; `'partial'` when `isChargeable && maxPenaltyAmount > 0`; fallback `pricingOptions.refundableFare` | — |
| `changeable` | rule `EXCHANGE`/`REISSUE`/`REBOOK`/`REVALIDATION`: `!notApplicable` | — |
| `changePenalty` / `cancelPenalty` | `maxPenaltyAmount` + `fareRules.currency` | — |
| `holdAllowed` | `!instantTicketingRequired` | — |
| `voidUntil` | — | no source |
| `notes[]` | `descriptions[].text`, `circumstances` | — |
| `FareRules.penalties[]` | `{ type: cancel\|change, when: circumstances ?? 'before_departure', amount }` | no `no_show` |
| `FareRules.raw[]` | `included['detailed-fare-rules'][fareBasis] { fareBasis, name, fareNotes.descriptions[].text, segmentId }` | pricing only |
| post‑booking extras | `Extended_TermAndCondition.applicability`, `rebookConditions`, `refundingPreview` (management spec) | §2.9 |

### 3.9 `FareFamily` ← upsold `FlightOffer` (+ `Collection_Meta_Upsell`)

| SDK field | Amadeus path | note |
|---|---|---|
| `code` / `name` | distinct `fdbs.brandedFare` joined by `+` / `brandedFareLabel` (search) else code | GDS only; NDC/LTC/EAC/PYTON may have none |
| `tier` | rank of `price.grandTotal` ascending | — |
| `offerId` | `data[i].id` (new ids, e.g. `'2'..'6'` for input `'1'`) | SDK‑scoped |
| `priceDelta` | `data[i].price.grandTotal − base.raw.price.grandTotal` | Amadeus returns absolute prices |
| `features[]` | union over segments of `amenities[] { code, description, isChargeable, amenityType }` + `includedCheckedBags` | amenities present on some segments only |
| *(add)* `isCurrent?`, `sliceIndex?`, `brandedFareBySegment?`, `features[].type?` | `brandedFare === base brandedFare`; `meta.oneWayUpselledCombinations[]` | — |

### 3.10 Traveler capture ← `Traveler` / `IdentityDocument` / `Contact` / `Phone` / `Address` / `LoyaltyProgram`

| SDK field | Amadeus path | note |
|---|---|---|
| `Traveler.id` / `slotId` | `id` (`'1'..'18'`, = `travelerPricings[].travelerId`) | — |
| `type` | `travelerPricings[].travelerType` (not on the traveler) | — |
| `title` | — | dropped |
| `firstName` / `middleName` / `lastName` | `name.firstName` / `.middleName` / `.lastName` (+ `secondLastName`) | add `secondLastName?`; GDS expects Latin; concatenated name + PTC + DOB < 59 chars (QueueList note) |
| `gender` | `MALE`↔M, `FEMALE`↔F, `UNSPECIFIED`←X (read `UNDISCLOSED` as X) | pricing spec enum is MALE\|FEMALE only |
| `dob` | `dateOfBirth` (date) | — |
| `nationality` | `documents[].nationality` | not top‑level on Amadeus |
| `documents[]` | `documents[] { documentType VISA\|PASSPORT\|IDENTITY_CARD\|KNOWN_TRAVELER\|REDRESS, number, issuanceDate, expiryDate, issuanceCountry, issuanceLocation, nationality, birthPlace, validityCountry, birthCountry, holder }` | passport↔PASSPORT, national_id↔IDENTITY_CARD, add `'visa'`; `driving_licence` unsupported (only `FormOfIdentification.DRIVERS_LICENSE` for e‑ticket pickup); add `issuanceLocation?`, `birthPlace?`, `birthCountry?`, `validityCountry?`, `holder?` |
| `knownTravelerNumber` / `redressNumber` | `documents[] { documentType: KNOWN_TRAVELER \| REDRESS, number }` | — |
| `loyalty[] { airline, number }` | `loyaltyPrograms[] { programOwner, id }` (≤10) | `programme` dropped |
| `mealPref`, `seatPref`, `assistance[]` | — (free‑text `remarks.airline` only) | OTA SSR channel |
| `email` / `phone` | `contact.emailAddress` / `contact.phones[0] { deviceType MOBILE, countryCallingCode [0-9+]{2,5}, number [0-9]{1,15} }` | add `Phone.type?` |
| `Contact.email`, `.phone` | `contacts[purpose STANDARD].emailAddress`, `.phones[]` (≤3) | — |
| `Contact.address` | `address { lines[line1,line2], postalCode, cityName [a-zA-Z -]{1,35}, stateName, countryCode, postalBox }` | transliterate city |
| `Contact.emergency { name, phone }` | `travelers[lead].emergencyContact { addresseeName [a-zA-Z -], countryCode (ISO alpha‑2, **not** a dial code), number [0-9]{1,15}, text }` | convert dial code ↔ ISO via `places.countries` |
| `Contact.gst` | — → `contacts[] { purpose: INVOICE, companyName, address, emailAddress }` + `remarks.general { subType: INVOICE, text }` | no tax‑id field |
| *(add)* `Traveler.associatedAdultId?`, `discountEligibility?[] { subType SPANISH_RESIDENT\|AIR_FRANCE_*, travelerType, cityName, cardNumber, certificateNumber }`, `Contact.language?`, `Contact.company?` | `associatedAdultId`, `discountEligibility[]`, `contact.language`, `companyName` | — |

### 3.11 `TravelerRequirements` ← `FlightOfferPricingOut.bookingRequirements` — see §2.4 `itinerary.requirements`; add `threeDsRequired?: boolean` and `perTraveler?: Record<slotId, …>`.

### 3.12 `Booking` / `Trip` ← `FlightOrder` (+ `Success_Booking` envelope)

| SDK field | Amadeus path | note |
|---|---|---|
| `id` | `id` (readOnly, base64‑like) | URL‑encode in paths |
| `reference` | — | OTA reference (facade) |
| `pnr` | `associatedRecords[].reference` where `originSystemCode ∈ {GDS,1A}` | — |
| `airlineLocators[]` | other `associatedRecords[] { reference, originSystemCode, flightOfferId, creationDate }` | airline resolved via `flightOfferId → validatingAirlineCodes[0]`; add `records?[]` to keep multi‑PNR detail (split bookings produce one record per one‑way offer) |
| `status` | derived: all travelers × segments covered by `tickets[] { documentType ETICKET, documentStatus ISSUED }` → `ticketed`; some → `partially_ticketed`; all VOID → `cancelled`; all REFUNDED → `refunded`; no tickets & `ticketingAgreement.option DELAY_TO_*` → `on_hold` / `pending_payment`; segments PENDING/WAITLISTED → `processing`; any DENIED → `failed`; all segments CANCELLED or 404 after DELETE → `cancelled`; `dateTime` passed with no tickets → `expired`; else `confirmed` | no status field on Amadeus |
| `tickets[] { passengerId, number, segmentIds }` | `tickets[] { travelerId, documentNumber, segmentIds }` filtered `documentType ETICKET` | add `type? eticket\|emd\|mco\|pticket`, `status? issued\|refunded\|void\|original\|exchanged` |
| `itinerary.offers[]` | `flightOffers[]` → §3.2 | `itinerary.id` = order id |
| `travelers[]` | `travelers[]` → §3.10 | type via `travelerPricings` |
| `contact` | `contacts[purpose STANDARD] ∪ travelers[0].contact`; `gst` ← `contacts[purpose INVOICE]` | — |
| `payment` | `total/due` ← Σ `flightOffers[].price.grandTotal` in `billingCurrency ?? currency`; `paid` ← tickets ISSUED ? total : 0 (OTA ledger authoritative); `dueBy` ← `ticketingAgreement.dateTime`; `methods[]` ← `formOfPayments[]` (`creditCard` → `{type:'card', last4}`, `b2bWallet` → `'ota_wallet'`, `other.method` lower‑cased) | facade redacts PAN/CVV |
| `holdExpiresAt` | `ticketingAgreement.dateTime` (readOnly; schema `YYYY-MM-DD`, example `…T10:15:00.000`) when option ≠ CONFIRM; else `automatedProcess[code DELAYED].dateTime` | local office time |
| `voidUntil` | — | no source |
| `createdAt` | `associatedRecords[0].creationDate` (`YYYY-MM-ddThh:mm:ss.sss`, local; example key `creationDateTime`) | facade should replace with its UTC timestamp |
| `documents[]` | `tickets[]` ISSUED → `{type:'eticket', available:true}` | no URLs |
| `availableActions[]`, `failure`, `protections[]` | — | facade policy / products |
| `metadata` | `queuingOfficeId`, `ownerOfficeId`, `remarks`, `automatedProcess[]`, `commissions[]`, `formOfIdentifications[]`, `warnings[]`, `raw` | — |
| `Trip.phase` | `segments[].isFlown` / last `arrival.at` vs now / status cancelled | — |
| `Trip.nextSegment` | first `segmentType ACTIVE`, `isFlown !== true` | skip PASSIVE/GHOST/STAFF |
| `Trip.flightStatuses` | `bookingStatus` CANCELLED → `'cancelled'`, `isFlown` → `'landed'`, else `'scheduled'` | not operational status |

### 3.13 `HoldOption` / `HoldPolicy` ← `TicketingAgreement` / `AutomatedProcess`

| SDK field | Amadeus path | note |
|---|---|---|
| `onExpiry` | `'drop'` ↔ `DELAY_TO_CANCEL`; `'charge'`/`'convert_to_paid'` → `DELAY_TO_QUEUE` (agent queue) | consider adding `'queue'` |
| `holdUntil` | `delay 'nD'` (whole days) → readOnly `dateTime` | hour precision impossible |
| `fee`, `refundableFee` | — | OTA |
| `HoldPolicy.allowed` | `!instantTicketingRequired && source === 'GDS'` | `paymentCardRequired` ⇒ card on file |

### 3.14 `CancelQuote` / `ChangeOptions` ← management `fareRules=refunds|rebooks` — see §2.9; add `CancelQuote.breakdown? { farePaid, fareUsed, fareRefund, totalTax }` and `ChangeOptions.slices[].rebookConditions?`.

### 3.15 Availability result ← `FlightAvailability` (unpriced)

| SDK field | Amadeus path | note |
|---|---|---|
| `SliceOffer.sliceIndex` | `Number(originDestinationId) − 1` | inherently per slice |
| `slices[0].segments[]` | `segments[]` (`Extended_Segment` = `Segment` + `closedStatus`, `availabilityClasses[1..50] { numberOfBookableSeats 1..9, class [A-Z], closedStatus WAITLIST_OPEN\|WAITLIST_CLOSED\|ON_REQUEST, tourAllotment }`) | spec example uses `classAvailabilities[].availabilty` (sic) — read both |
| `price`, `passengers`, `baggage`, `conditions` | — | **no money in this API**; result flagged `priced: false`; facets/sort tolerate missing price; booking requires a backend "availability → `FlightOffer`" bridge not covered by any spec |
| `seatsLeft` | min `numberOfBookableSeats` for the booked class | `9` = "9+" |

### 3.16 Reference / envelope / errors

| SDK type | Amadeus | note |
|---|---|---|
| `Place` | `dict.locations[iata] { cityCode, countryCode }` | no name/tz/lat/lng → `places.getMany` |
| `Airline` / `Aircraft` / `Currency` | `dict.carriers`, `dict.aircraft`, `dict.currencies` (`code → name`; currency example is inverted `'Euro' → 'EUR'` — treat as `code → name`) | no logo/alliance/symbol/decimals |
| `DateTime` | `FlightEndPoint.at`, `FlightStop.arrivalAt/departureAt`, `lastTicketingDateTime` (search: `YYYY-MM-ddThh:mm:ss`, no offset), `AssociatedRecord.creationDate` (`…ss.sss`), `TicketingAgreement.dateTime` (date or `…ss.sss`), `AutomatedProcess.dateTime` | offset attached from airport tz (`Place.tz`) or `localTimeOnly: true`; office‑level stamps use the office tz when the facade knows it |
| `Page<T>` | `Collection_Meta { count, oneWayCombinations[] }` (POST search), `Collection_Meta_Link { count, links { self, next, previous, last, first, up } }` (GET search, orders) | no cursors; `hasMore: false`; `links.next` could be an opaque cursor for the GET search path only |
| `Problem` | `Error_400 / 404 / 409 / 500 { errors: Issue[] }`, `warnings: Issue[]` on 200/201 | `Problem.errors[]` is already `Issue`‑shaped; `code` numeric int64 |
| `ValidationIssue` | `Issue.source.pointer` (JSON Pointer into the Amadeus body) / `.parameter` / `.example` | adapter re‑bases pointers to SDK paths (`/originDestinations/0/…` → `slices[0].…`, `/data/travelers/1/documents/0/expiryDate` → `travelers[1].documents[0].expiry`) |

### 3.17 Fields the SDK should add (consolidated)

| type | additions (all optional) | source |
|---|---|---|
| `Offer` | `ticketingDeadline { date, dateTime? }` (`lastTicketingDate`/`lastTicketingDateTime`), `bookableSeats` (= `numberOfBookableSeats`, keep `seatsLeft` for backend scarcity), `instantTicketingRequired`, `paymentCardRequired`, `multiplePnrs` (`nonHomogeneous`), `isUpsell`, `upsellOfferIds`, `sourceReference`, `pricingOptions { fareType[], corporateCodes[], includedCheckedBagsOnly, refundableFare, noRestrictionFare, noPenaltyFare }`, `billing: Money` (`billedPrice`), `fareOptions[]`, `warnings[]` | search / pricing / orders |
| `Segment` | `localTimeOnly`, `technicalStops[] { airport, arrivalAt, departureAt, durationMinutes }` (`stops[]`, `numberOfStops`), `blacklistedInEU`, `emissionsKg`, `status` (`bookingStatus` confirmed\|waitlisted\|cancelled\|pending\|denied), `flown` (`isFlown`), `segmentType`, `cabinByPaxType`, `brandedFare`, `includedCheckedBags` passthrough | all |
| `PriceBreakdown` | `billing`, `refundableTaxes`, `margins` | all |
| `PaxPrice` | `fareOption`, `travelerIds` | all |
| `Amenity` | `code`, `label`, widened `type` (baggage, lounge, miles, fare_feature, …) | search / upsell |
| `FareFamily` | `isCurrent`, `sliceIndex`, `brandedFareBySegment`, `features[].type` | upsell |
| `SearchSession.meta` | `warnings[]`, `sessionMode: 'native_split'\|'fanout'\|'combined'` | search |
| `SearchParams` | `nearbyRadiusKm`, `corporateCodes`, `sources`, `via { include, exclude }` | search |
| `Traveler` | `secondLastName`, `associatedAdultId`, `discountEligibility[]`, `genderDetail` | pricing / orders |
| `TravelDocument` | type `'visa'`; `issuanceLocation`, `birthPlace`, `birthCountry`, `validityCountry`, `holder` | pricing / orders |
| `Phone` / `Contact` / `Address` | `Phone.type mobile\|landline\|fax`; `Contact.language`, `Contact.company`, `Contact.purpose`; `Address.postalBox` | orders |
| `TravelerRequirements` | `threeDsRequired`, `perTraveler`, `nameRules.maxCombinedLength` (59) | pricing / queue |
| `Booking` | `records[] { reference, system, offerId, createdAt }`, `tickets[].type/status`, `warnings[]`, `source`, `emds[]` | orders |
| `HoldOption` | `onExpiry: 'queue'`, `ticketingAgreement { option, delayDays }` | orders |
| `CancelQuote` / `ChangeOptions` | `breakdown`, `rebookConditions` | management |
| `AncillaryType` | `'airport_checkin'`, `'cabin_baggage'` | pricing / orders |
| `OfferUnavailableError.reason` | `'waitlist'`, `'on_request'` | availability |

### 3.18 Fields with no Amadeus source (stay backend‑ or client‑owned)

`Offer.tags`, `Offer.hold`, `Offer.expiresAt`, `Offer.selfTransfer`, `Segment.distanceKm/onTimePct`, `Place.name/tz/lat/lng`, `Airline.logoUrl/alliance/lowCost`, `Currency.symbol/decimals`, `Conditions.voidUntil`, `FareRules.penalties.type 'no_show'`, `FareFamily.name` (marketing), `PriceInsight`, `CalendarFares`, `DateGrid` (beyond ±3 days), `Destination`, `SeatMap/SeatRow/Seat`, `InsuranceQuote`, `Protection`, `PriceLockOption`, `Promo/Coupon`, `Itinerary.id/expiresAt/lockId`, `Booking.reference/status/documents[].url/availableActions/failure/protections/payment.paid`, `BookingFailure`, `PaymentMethod/Intent/Action/Quote`, `Refund`, `Disruption`, `ServiceRequest.status`, `FlightStatus`, `CheckInInfo`, everything under `account`, `wallet`, `alerts`, `content`, `support`.

---

## 4. Conflicts and decisions

| # | topic | SDK assumption | Amadeus behaviour | resolution |
|---|---|---|---|---|
| C‑1 | Timestamps | ISO‑8601 with UTC offset everywhere | `departure.at`, `arrival.at`, `stops[].arrivalAt/departureAt`, `lastTicketingDateTime` are local wall‑clock without offset; `creationDate` `…ss.sss` local; `ticketingAgreement.dateTime` date or local date‑time; `dict.locations` has no tz | `common.toDateTime(local, iata)` attaches the offset from `places` tz data; unknown tz ⇒ keep the string, set `localTimeOnly: true`; never `new Date(at)` in the browser; durations from ISO‑8601 strings, layovers from offset‑corrected instants only; office stamps use the office tz when configured |
| C‑2 | Money | `Money` per figure | one `currency` per `Price`; `fees[]/taxes[]/additionalServices[]/margins[]/discounts[]` bare amounts; `total` vs `grandTotal`; `billingCurrency`/`billedPrice` may differ; `ElementaryPrice.currencyCode`, alphanumeric `'514.13A'`; amounts like `'6'` | `common.toMoney(amount, currency)` normalises; `total ← grandTotal`; billing exposed separately; `'A'` suffix flagged; never floats |
| C‑3 | Identifiers | opaque, backend‑issued, resolvable by id | offer/segment/traveler ids are `'1'..` scoped to one response; upsell renumbers; order id is base64; no GET‑by‑id for offers; pricing/upsell/orders need the **whole** `FlightOffer` | SDK ids `${sessionId}:${id}`, segments `${offerId}:${id}`; `raw` retained; facade caches `FlightOffer` JSON per session TTL; requests rebuilt from `raw`; URL‑encode order ids |
| C‑4 | Search transport | async session, poll/stream, cursor paging, `providersPending` | single synchronous POST (≤250 offers), no session/cursor/stream; GET has `links` only | facade wraps the response with `meta.sessionId/expiresAt` and caches it; SDK treats the first response as `complete` (`search.mode 'single'` semantics when the Amadeus path is configured); `search.get/page` served from cache; polling retained only for multi‑supplier backends |
| C‑5 | Error envelope | RFC 9457 problem+json; `SdkError` by `code`/`type`/`status` | `{ errors: Issue[] }` as `application/vnd.amadeus+json`, numeric codes, no `requestId`, `warnings[]` on success; media type and `X-HTTP-Method-Override` header on POST search/availability | facade emits problem+json: `status` ← HTTP, `title/detail` ← `errors[0]`, `code` ← canonical SDK code, `errors` ← `Issue[]` verbatim; `fromIssueArray` maps: 400 `425/477/572/2668/2781/4926/9880/10661/32171` → `ValidationError` (paths from `source.pointer/parameter`); `37200 PRICE DISCREPANCY` → `PriceChangedError` (facade re‑prices for `to`); `34651 SEGMENT SELL FAILURE` → `OfferUnavailableError{sold_out}`; `34107 NOT APPLICABLE FARE` → `OfferUnavailableError{withdrawn}`; `38034` → `ApiError{SERVICE_UNAVAILABLE}`; `1304 CREDIT CARD NOT ACCEPTED` → `PaymentError{declined}`; `34733` → `PaymentError{gateway}`; `9112 TICKETING ‑ TKT` → `BookingError{ticketing}`; `36870 BOOKING FAILED` → `BookingError{create}`; `39397` (upsell) → empty result; `1797` → `NotFoundError`; `2552 SIMULTANEOUS UPDATE` → `ConflictError{retryable}`; `141` / default → `ApiError` retryable; `warnings[]` surfaced on `SearchSession.meta.warnings` / `Booking.warnings`. The SDK never talks to Amadeus directly, so the vendor media type and override header are facade concerns (`envelopeInterceptor` keeps `dictionaries` + `warnings`) |
| C‑6 | Pax / leg / date limits | 9 pax, 6 legs, ~330 days (QUESTIONS #4) | 9 seated + 1 lap infant per adult (18 total, `associatedAdultId`), 6 ODs, 365 days (`9880` beyond), `numberOfBookableSeats ≤ 9`, GET path caps each pax type at 9 | `bootstrap.limits` defaults for Amadeus markets: `maxSeated 9, maxTotal 18, infantPerAdult 1, maxLegs 6, advanceDays 365`; `search.validate` enforces seated vs total separately |
| C‑7 | `lastTicketingDate` | treated as "pay by" / offer expiry | fare guaranteed ticketable until that date **only if booked the same day as the search**; informational; absent when ticketing isn't controlled; example format inconsistent (date vs `…Z`) | never maps to `expiresAt`/`holdExpiresAt`; exposed as `ticketingDeadline` (date part); `holdExpiresAt` comes from `ticketingAgreement.dateTime` |
| C‑8 | Default result mode (QUESTIONS #5, **updated: split**) | `per_slice` default; backend may only return combined offers | Amadeus natively returns combined offers; `searchCriteria.addOneWayOffers: true` adds `oneWay` offers + `meta.oneWayCombinations` (carrier/market dependent); pricing/orders accept ≤6 offers but never merge them; upsell relates families via `oneWayUpselledCombinations` | **Decision**: (1) `toSearchRequest` always sends `addOneWayOffers: true` unless `resultMode === 'combined'`; `sliceOffers` built from `oneWay` offers + `oneWayCombinations`, `combinableWith` filled; (2) when the response holds no `oneWay` offers (or the facade flags `meta.split: 'unsupported'`) the SDK **fans out one one‑way `POST /v2/shopping/flight-offers` per slice** in parallel (same traveler ids, same `sources`), marks every slice offer `combinableWith: undefined` (combinability unknown) and lets `offers.combine` → pricing validate the pair (2668 ⇒ "not combinable"); (3) `combined` offers from the same response stay available for `resultMode: 'combined'` and as a fallback when pricing rejects a pair. `offers.combine` renumbers offer/segment ids before pricing (C‑3). Record the mode on `SearchSession.meta.sessionMode` |
| C‑9 | `seatsLeft` | scarcity ("3 seats left") | `numberOfBookableSeats` = seats bookable in one request, 1..9, `9` means "9 or more"; availability classes also WAITLIST/ON_REQUEST | map only when `< 9` and `≥` requested seated pax; expose `bookableSeats`; live counts only via availability |
| C‑10 | Cabin | required, one per trip and per segment, lowercase | optional filter with `coverage`; per traveler per segment in results, mixed cabins common; availability has no cabin | allow `cabin` omitted ⇒ no `cabinRestrictions`; `Segment.cabin` from `tp0`, `cabinByPaxType` when travelers differ; optional for unpriced results |
| C‑11 | Fare types | `regular\|student\|senior\|armed_forces\|doctor\|corporate\|youth` | student/senior/youth are traveler types; corporate = `fareType CORPORATE` + `corporateCodes`; `fareOptions` are market programmes; no armed‑forces/doctor | open `FareType` string driven by `bootstrap.limits.fareTypes`; unsupported values rejected in `search.validate` for Amadeus markets |
| C‑12 | Stops / direct | `maxStops` per offer, `directOnly` | `maxNumberOfConnections` per itinerary; `numberOfStops`/`stops[]` are **technical** stops inside a flight | `Slice.stops` = connections; `technicalStops` separate; `directOnly` → 0 connections (`nonStop` on GET) |
| C‑13 | Flex dates vs nearby airports | independent params | `dateWindow`/`timeWindow` cannot combine with `originRadius`/`destinationRadius` (≤300 km); windows ≤ ±3 days / ±12 h | `search.validate` rejects the combination for Amadeus backends; `nearbyAlternatives` uses two calls |
| C‑14 | Max duration | absolute minutes | `maxFlightTime` is a % of the shortest solution | client‑side only |
| C‑15 | Alliances | server filter | none | expanded to carrier codes (≤99) before the request |
| C‑16 | Baggage | per pax type, `weightKg`, `dimensionsCm`, cabin + checked | per traveler × segment, piece **or** weight (`KG`/`LB`), chargeable price offer‑level or in `included.bags`, cabin only as chargeable/amenity text | `bySegment: true`, LB→kg, offer‑level amount attached to chargeable rules, dimensions undefined |
| C‑17 | Per‑pax prices | `PaxPrice` by type | one `travelerPricings[]` entry per traveler (same type may price differently via `fareOption`) | group by type, keep per‑traveler array for pricing/orders |
| C‑18 | Owner / validating carrier | single `Airline` | `validatingAirlineCodes[1..9]`, optional; operating may be name‑only | `owner` = first + name from dictionaries; `validatingAirlines[]`; `Airline.code` may be empty when only `carrierName` exists |
| C‑19 | Place hydration | full `Place` required | code + `cityCode`/`countryCode` only | adapters resolve through `places.getMany` before `search:results`; partial `Place` until then |
| C‑20 | Upsell input | id in path | full `FlightOffer` in body; new ids out; prices absolute; `brandedFare` GDS‑only | `toUpsellRequest(raw)`; delta computed; `39397` ⇒ no families (hide step); families per slice via `oneWayUpselledCombinations` |
| C‑21 | Reprice semantics | `{changed, from, to}` returned | only the new offer; `forceClass=false` may change RBD/brand silently; request body `type` is `'flight-offers-pricing'` (schema example says `flight-offer-pricing`) | SDK diffs `grandTotal`, per‑traveler totals, `class`/`brandedFare`; `forceClass=true` once a fare is chosen; send `'flight-offers-pricing'`, accept both |
| C‑22 | Cart / itinerary | server‑side cart with id, expiry, promo, pax changes | stateless pricing; `travelerPricings` fixed; no promo (agent discounts only) | facade owns the cart around the priced `FlightOffer` JSON; `setPassengers` ⇒ new search; promos OTA‑side |
| C‑23 | Traveler requirements | per `PaxType` rules, age/name/GST rules from backend | per `travelerId` boolean flags + booking‑level flags + 3DS; no age/name/GST rules | OR per type, keep per traveler; `ageRules` from spec prose; name/GST from OTA config; `threeDsRequired` added |
| C‑24 | Gender / document enums | `M\|F\|X`; passport\|national_id\|driving_licence\|other | MALE\|FEMALE(\|UNSPECIFIED\|UNDISCLOSED in orders); VISA\|PASSPORT\|IDENTITY_CARD\|KNOWN_TRAVELER\|REDRESS; KTN/redress are documents | bidirectional maps in `common.js`; `'visa'` added; `driving_licence` rejected; pricing‑time gender limited to M/F via `FieldRule.options` |
| C‑25 | Phone / address | free‑form | `countryCallingCode [0-9+]{2,5}`, `number [0-9]{1,15}`, `deviceType`, ≤3 phones; `cityName [a-zA-Z -]{1,35}`; emergency `countryCode` is ISO alpha‑2 | `Phone.countryCode` documented as dial digits (keep `'+'` for one‑digit codes); digits‑only normalisation; transliteration; ISO↔dial conversion for emergency contact |
| C‑26 | Contact model | one contact, one phone, GST block | `contacts[]` with `purpose`, `travelers[].contact`, per‑traveler `emergencyContact`, no GST field | fan‑out at booking (STANDARD + INVOICE + lead traveler contact); GST number as INVOICE remark |
| C‑27 | Hold / BNPL | `HoldOption` with fee, hour‑precise `holdUntil`, drop/charge/convert | `ticketingAgreement` CONFIRM\|DELAY_TO_QUEUE\|DELAY_TO_CANCEL, whole days, action at local 00:00; no fee; `instantTicketingRequired` forbids holds | OTA product layered on `DELAY_TO_*`; days rounded down; fees via payments; `HoldPolicy.allowed` derived |
| C‑28 | Booking status | explicit enum | none; distributed over `tickets[].documentStatus`, `segments[].bookingStatus`, `ticketingAgreement` | `deriveStatus(order)` (§3.12) in `orders.js`; facade may override |
| C‑29 | Payments / PCI | gateway intents, hosted fields, no PANs | `FormOfPayment.creditCard` carries raw PAN + CVV, echoed back on 201/200; `other` ACCOUNT\|CHECK\|CASH\|NONREFUNDABLE\|PYTON; `b2bWallet`; no amounts/status | OTA‑merchant default: book with `other CASH`/omitted FOP + `ticketingAgreement`, charge via `PaymentsPort`, issue via issuance; facade redacts FOP; airline‑merchant card pass‑through server‑side only (SAQ‑D) with 3DS proof in `paymentOperationContext` |
| C‑30 | Synchronous issuance | `finalize` then poll | issuance returns the ticketed order in one 200 | `finalize` short‑circuits when tickets cover all travelers; `processing` only for NDC late issuance / webhook gap |
| C‑31 | Idempotency / retries | `Idempotency-Key` on creates, retries on 5xx | none on Amadeus; replaying create = second PNR; 409 `2552` = PNR locked | facade persists `(idempotencyKey) → result` and reconciles via by‑reference before re‑booking; SDK `retries: 0` for `booking.create`/`hold`/`finalize`; `2552` retried with backoff after a re‑GET |
| C‑32 | Guest retrieval | PNR + surname (+email), scoped token, 404 | reference + `originSystemCode=GDS` only; full PII returned; no 404 | facade enforces surname/email, mints token, rate‑limits, redacts; empty `data`/4926 ⇒ `NotFoundError` |
| C‑33 | Servicing model | quote → confirm, partial scope, refunds | PATCH immediate, DELETE immediate whole‑order, no refund/reissue ops | facade owns quotes; PATCH/DELETE on confirm; §5.2 gaps |
| C‑34 | Query arrays | unspecified | `include`, `fareRules` are csv (`collectionFormat csv`) | `http` serialises array query values comma‑joined |
| C‑35 | Spec defects to tolerate | adapters generated from schema | dangling `#/definitions/LoyaltyProgram` and `commissionValue` (search); malformed `fareBasis` pattern `'[[A-Z0-9]{1,18}'`; example keys `ticketingAggreement`, `creationDateTime`, `includedCheckedBags`, `fareDetailBySegment`, `classAvailabilities[].availabilty`; `flightOfferIds` as integers; `co2Emissions.weight` as string; `sliceDiceIndicator 'ABCDEF'`; QueueList path key `GET/office/queues/{queue-id}`, example self link `/v1/queue-list/pnr?queueNumber=` | parsers read both spellings, coerce numeric strings, pass unknown enum values through; fixtures follow the schema (`validateAgainst` with the dictionaries' bogus `key` property ignored); `fareBasis` pattern not compiled as‑is |
| C‑36 | Access | SDK calls from the browser with user/guest token | Amadeus needs agency OAuth2, office context, vendor media type | the SDK only ever talks to the OTA facade; issuance and queue reads are server‑to‑server |

---

## 5. Gaps (no Amadeus coverage) — what the OTA backend must provide

Format: capability → backend must provide → SDK assumed contract (docs pointer).

### 5.1 Shopping extras

| gap | backend provides | SDK contract |
|---|---|---|
| Airport / city / metro autocomplete, place details with tz & coordinates, nearby, geo‑IP, popular, metro resolution | reference‑data service (Amadeus Airport & City Search is **not** in `amadeus/`); must also back the adapters' tz lookup | `places.*` (04 §1); `GET /v1/places/...` |
| Airline list / logos / alliances, aircraft, countries, currencies, FX | reference data | `places.airlines.*`, `places.alliances`, `places.aircraft.get`, `places.countries/currencies/exchangeRates` |
| Seat maps (pre‑ and post‑booking), seat availability & characteristics, auto‑assign | SeatMap provider (Amadeus SeatMap Display not included) | `offers.seatMapPreview`, `ancillaries.seats.map/select/unselect/autoAssign`, `SeatMap` types (05 §3, 06 §3) |
| Fare calendar (month), price graph, ±N‑day grid beyond ±3 days, "anywhere" explore, price insights / buy‑wait advice | Flight Cheapest Date / Inspiration / Price Analysis or OTA data warehouse | `search.calendar/priceGraph/explore/insights`, `search.flexibleDates` beyond 3 days (05 §1) |
| Search session persistence, cursor paging, streaming, server‑side filtering, expiry | result cache keyed by `sessionId` with TTL (synthesises `SearchSession.meta`) | `GET /v1/flights/search/{id}[?cursor]`, `/stream` (05 §1) |
| Offer lookup by id, deep links, compare tray across reloads | same cache (`raw` `FlightOffer` per id) | `offers.get` (05 §3) |
| Native split results when `addOneWayOffers` yields nothing | optional facade split (two one‑way Amadeus calls server‑side) or let the SDK fan out (C‑8) | `SearchSession.sliceOffers` |
| Per‑segment hardware amenities (wifi/power/pitch) on non‑GDS content, on‑time %, distance, visa‑transit warnings | third‑party content | `offers.details` warnings/amenities |
| Live availability by offer id | re‑query bridge (availability → priceable `FlightOffer`) | `offers.availability` |

### 5.2 Servicing

| gap | backend provides | SDK contract |
|---|---|---|
| Order change / reissue / exchange (quote as fare difference + penalty, confirm, payment) | reissue engine (no Amadeus Flight Order Change spec here); `fareRules=rebooks` gives eligibility only | `trips.changes.quote/confirm`, `ChangeQuote` (08 §1) |
| Refund processing, refund records / status, void of issued tickets, partial cancellation (per pax / slice), split PNR | ticketing/refund back office; DELETE only cancels un‑ticketed orders | `trips.cancellation.*` (partial scope), `trips.refunds`, `trips.refundStatus`, `trips.void`, `trips.requests.splitPnr`, `Refund`, `Cancellation` |
| Disruptions (schedule change / cancellation objects, options, respond‑by, respond) | airline message ingestion (queue‑driven detection is agent‑side, §5.5) | `trips.disruptions`, `trips.disruptions.respond`, `Disruption` |
| Flight status, check‑in windows / links, boarding passes, status alerts | flight‑status provider, airline links | `trips.flightStatus`, `trips.checkIn`, `trips.boardingPasses`, `trips.alerts.*` |
| Documents: e‑ticket PDF, receipt, invoice / GST invoice, insurance policy, visa letter; resend confirmation; timeline | document rendering, notifications, audit log | `booking.documents/download/resendConfirmation/timeline`, `trips.documents/download`, `trips.invoice.request` |
| My‑trips listing per user, `availableActions`, `BookingStatus`, `BookingFailure` | user ↔ order index, policy engine, status derivation (or accept `orders.deriveStatus`) | `trips.list`, `Booking.availableActions/status/failure` |
| Coded SSR / special assistance, name‑correction rules, service‑request tracking | agent workflow; only free‑text remarks exist on Amadeus | `trips.requests.*`, `ServiceRequest` |
| Post‑booking amendment quote / payment | pricing of PATCH additions from `included.bags`; EMD issuance | `trips.amendment.quote/confirm` |

### 5.3 Commerce

| gap | backend provides | SDK contract |
|---|---|---|
| Payments end‑to‑end: methods per market, quotes/surcharges (beyond card brand fees), credits, EMI, intents, gateway confirm, 3DS/UPI actions, redirects, saved instruments, receipts, refunds | gateway integration (Stripe / PayPal / Razorpay) behind `PaymentsPort`; facade records `other CASH` or passes cards to the airline server‑side | `payments.*` (07 §2) |
| Holds as a product (free window, paid holds, fees, hourly deadlines, charge/convert on expiry) | policy over `ticketingAgreement` + `lastTicketingDate` | `booking.holdOptions`, `booking.hold`, `HoldOption`, `Offer.hold` |
| Price lock / fare freeze | OTA product | `offers.priceLockOptions`, `itinerary.lockOptions/lock/fromLock`, `PriceLockOption` |
| Cart: id, expiry, extend, promo codes, pax‑mix change, metadata, price‑change consent | facade cart around priced `FlightOffer` JSON | `itinerary.*` (06 §1) |
| Ancillary catalogue beyond bags / priority boarding / airport check‑in / fast track: meals (purchasable), lounge, wifi, carbon offset, transfers, bundles; insurance quotes; protections (price drop, CFAR, flexible ticket, zero cancellation, disruption guarantee, baggage protection) | OTA / third‑party catalogues | `ancillaries.meals.*`, `extras.*`, `bundles.*`, `insurance.*`, `protections.*`, `AncillaryCatalog`, `InsuranceQuote`, `Protection` |
| Card‑fee preview for non‑card methods, DCC / FX | gateway | `PaymentQuote.fx`, `PaymentMethod.fee` |
| Idempotent booking creation, duplicate‑PNR reconciliation | facade | `booking.create` `Idempotency-Key` (C‑31) |

### 5.4 Accounts, traveler profiles, alerts, content, support

| gap | backend provides | SDK contract |
|---|---|---|
| Accounts: profile, identifiers, password, preferences, addresses, billing/GST profiles, notifications, push tokens, sessions, MFA, social providers, consents, GDPR export/delete | identity & profile service | `account.*` (09 §1), `auth` (01 §5) |
| Saved traveler profiles, documents, loyalty accounts, loyalty programme catalogue, SSR/meal code lists, import from booking | profile store shaped to round‑trip the Amadeus `Traveler` | `travelers.*` (06 §2) |
| Wallet, loyalty points, coupons, gift cards, vouchers, referrals | commerce services | `wallet.*` (09 §2) |
| Price alerts (incl. guest), saved searches, favourites, alert history | scheduler re‑running searches | `alerts.*` (09 §3), `search.track` |
| CMS: banners, deals, offers, FAQ, policies (versions for consents), pages, destinations, travel requirements, airline policies, airport info, announcements; fare‑family marketing names/feature labels | CMS | `content.*` (04 §2) |
| Support: contact options, tickets, callbacks, chat token | CRM | `support.*` (08 §2) |
| Bootstrap `/config`: limits (C‑6), flags (split support, Amadeus‑backed), markets, payment catalogue, `fareTypes` | facade | `bootstrap` slice (01 §1) |

### 5.5 `QueueList` — back‑office, not part of the frontend SDK

`GET /v1/office/queues/{queue-id}` lists the PNRs on an **agency office queue** (every customer of the
office: names, flights), ordered by PNR creation date, with no status, price, tickets or contact, arrival
endpoints only, no pagination (`max` cap + `meta.count`), no `dictionaries`, and a route the spec's own
example contradicts (`/v1/queue-list/pnr?queueNumber=`). It is where `ticketingAgreement.option
DELAY_TO_QUEUE` / `automatedProcess` orders land for agents. It is **not** wired to any endpoint key, never
proxied through the OTA edge, and never used for `trips.list`; the facade may poll it server‑side to detect
time‑limit or schedule‑change work items, then enrich each PNR through `GET /v1/booking/flight-orders/by-reference`
before anything reaches the SDK.

---

## 6. Adapter scripts to implement (`src/adapters/amadeus/`)

All pure functions (no I/O, no state); each takes `dictionaries` and an optional `places` lookup for
hydration; every converted object keeps the wire payload on `raw`. Enum maps and helpers live in `common.js`.

| script | exports |
|---|---|
| `common.js` | `toMoney(amount, currency)` (decimal normalisation, `'A'` suffix flag, `currencyCode` alias) · `toDateTime(localIso, iata, tzLookup)` → `{ value, localTimeOnly }` · `parseIsoDuration(str)` → minutes · `normalizeDate(str)` (`YYYY-MM-DD` from date or `…Z` forms) · `PAX_TYPE` (ADT↔ADULT …) · `CABIN` (economy↔ECONOMY …) · `GENDER` (M/F/X ↔ MALE/FEMALE/UNSPECIFIED/UNDISCLOSED) · `DOCUMENT_TYPE` (passport↔PASSPORT, national_id↔IDENTITY_CARD, visa↔VISA; KTN/REDRESS ↔ traveler fields) · `AMENITY_TYPE` · `SERVICE_NAME` (PRIORITY_BOARDING/AIRPORT_CHECKIN/FAST_TRACK ↔ ancillary types) · `ADDITIONAL_SERVICE_TYPE` · `resolveCarrier(code, dict)`, `resolveAircraft(code, dict)`, `resolvePlace(iata, dict, places)` · `scopeId(sessionId, id)` / `unscopeId(id)` · `renumberOffers(rawOffers)` → `{ offers, map }` (unique offer/segment ids for multi‑offer requests, C‑3) · `fromIssue(issue, { httpStatus })` → `{ code, title, detail, path, example }` · `fromIssueArray(errors, { httpStatus, requestId })` → `Problem` (RFC 9457 with `errors` extension) + SDK error class choice per the C‑5 table · `fromWarnings(warnings)` → `string[]` · `readEither(obj, 'ticketingAgreement', 'ticketingAggreement')`‑style tolerant getters (C‑35) |
| `search.js` | `toSearchRequest(params, { sources, maxUpsellOffers, resultMode, limits })` → `GetFlightOffersQuery` (+ `addOneWayOffers`, `additionalInformation`) · `toQuickSearchQuery(params)` → GET query params · `toFlexibleDatesRequest(params, days)` · `toNearbyRequests(params)` → `[airportsBody, datesBody]` · `fromSearchResponse(envelope, { sessionId, params, dictionaries, places })` → `SearchSession` (offers / `sliceOffers` via `oneWayCombinations`, `meta.warnings`, `sessionMode`) · `fromFlightOffer(fo, ctx)` → `Offer` (shared by pricing/upsell/orders) · `fromItinerary(it, ctx)` → `Slice` · `fromSegment(seg, fdbs, ctx)` → `Segment` · `fromPrice(price, travelerPricings)` → `PriceBreakdown` · `fromTravelerPricings(tps)` → `PaxPrice[]` · `fromBaggage(tps)` → `BaggageAllowance` · `fromFareRules(fareRules, pricingOptions)` → `{ conditions, fareRules }` · `fromAmenities(list)` → `Amenity[]` · `toDateGrid(offers)` · `matchOfferSignature(a, b)` (segment signature for `search.refresh` re‑selection) · `mergeOneWaySearches(responses)` (fan‑out mode, C‑8) |
| `pricing.js` | `toPricingRequest(rawOffers, { travelers?, payments?, fareRules = true })` → `{ body: { data: { type: 'flight-offers-pricing', … } }, query: { include, forceClass } }` (uses `renumberOffers`) · `toTravelers(travelers, contact, slots)` → Amadeus `Traveler[]` (shared with orders) · `toContact(contact, purpose)` · `toIdentityDocument(doc)` / `fromIdentityDocument(doc)` · `fromPricingResponse(envelope, { ctx, previous })` → `{ offers, changed, from, to, requirements, catalog, cardFees, threeDsRequired, warnings }` · `fromBookingRequirements(br, travelerPricings)` → `TravelerRequirements` · `fromBags(includedBags, ctx)` → `Service[]` · `fromOtherServices(map, ctx)` → `Service[]` · `fromCreditCardFees(map)` · `fromDetailedFareRules(included)` → `FareRules.raw[]` · `toAdditionalServices(selectedAncillaries, rawOffer)` (folds seats/bags/other services into `fareDetailsBySegment[].additionalServices`) · `combineOffers(pricedOffers, ctx)` → synthesised combined `Offer` (split mode) |
| `upsell.js` | `toUpsellRequest(rawOffers, { payments? })` → `{ data: { type: 'flight-offers-upselling', flightOffers, payments } }` · `fromUpsell(envelope, { baseOffers, ctx })` → `{ families: FareFamily[], offers: Offer[], bySliceOffer: Record<id, FareFamily[]> }` (via `oneWayUpselledCombinations`) · `fromAmenityFeatures(amenities)` → `FareFamily.features` · `isNoUpsell(problem)` (code 39397) |
| `availability.js` | `toAvailabilityRequest(offer \| params, { sources, includeClosedContent = true })` → `GetFlightAvailabilitiesQuery` (+ required override header noted in `meta`) · `fromAvailability(envelope, { ctx, offer? })` → `{ available, seatsLeft, classes, reason }` or unpriced `SliceOffer[]` (`priced: false`) · `matchSegments(offer, availabilities)` · `fromClosedStatus(status)` → `OfferUnavailableError.reason` · tolerant readers for `availabilityClasses ?? classAvailabilities` |
| `orders.js` | `toFlightOrderRequest(itinerary, { travelers, contact, metadata, ticketingAgreement?, formOfPayments?, remarks? })` → `{ data: FlightOrder }` (uses `toTravelers`, `toContact`, `toAdditionalServices`; GST → INVOICE contact + remark) · `toHoldAgreement(holdOption)` → `TicketingAgreement` · `toPatchRequest({ documents?, contact?, seats?, bags?, otherServices?, remarks?, name? })` → partial `{ data: { type: 'flight-order', … } }` · `toIssuanceRequest(formOfPayments?)` · `fromFlightOrder(envelope, ctx)` → `Booking` (shared by create 201, management GET, issuance 200, by‑reference `data[0]`) · `deriveStatus(order)` → `BookingStatus` · `fromTickets(tickets)` · `fromAssociatedRecords(records, flightOffers)` → `{ pnr, airlineLocators, records }` · `fromFormOfPayments(fops)` → `PaymentSummary.methods` (redacted) · `fromTicketingAgreement(ta, officeTz)` → `{ holdExpiresAt, onExpiry }` · `fromTravelerRecord(traveler, travelerPricings)` → `Traveler` · `fromContacts(contacts, travelers)` → `Contact` · `fromRebookRules(fareRules)` → `ChangeOptions` · `fromRefundPreview(fareRules)` → `CancelQuote` (whole order) · `selectOrderByReference(dataArray, reference)` · `toTrip(booking, now)` → `Trip` (phase, nextSegment) · `fromRemarks(remarks)` → `ServiceRequest[]` |

Error mapping (`fromIssueArray`) is consumed by `problemInterceptor` only when a body carries `errors[]`
without a problem `type` (direct Amadeus passthrough in dev/mocks); in production the facade has already
produced problem+json and the `errors` extension is kept on `ApiError.problem.errors`.

Fixtures for every adapter must validate against the matching definition in `amadeus/*.json`
(`test/helpers/swagger.js → validateAgainst`), using schema spellings, not the examples' (C‑35).
