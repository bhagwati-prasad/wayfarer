# 05 · Search: `search`, `filters`, `offers`

Scripts: `modules/search.js` (I/O + state), `modules/filters.js` (pure), `modules/offers.js`.

---

## 1. `modules/search.js`

#### `search.create(params: SearchParams, { mode?, autoPoll? = true, tag? = 'search', keepPrevious? = false } = {}, opts?) → Promise<SearchSession>`
Validate, abort any previous search with the same `tag`, open a session, then (per `mode`) poll or stream until `complete`; offers are merged incrementally, facets/summary recomputed via `filters`, default filters applied, expiry timer armed. Resolves on the **first** batch; later batches arrive through `search:results`.
Effects: net `POST /flights/search`, then `GET /flights/search/{id}` (poll) or `GET /flights/search/{id}/stream` · state `search` · storage `search.history` · timer poll + expiry · emit `search:start`, `search:results`×n, `search:complete|search:error`.
Throws: `ValidationError`, `SearchExpiredError`.

#### `search.get(sessionId, { resume? = true } = {}, opts?) → Promise<SearchSession>`
Load an existing session (back navigation / shared link); resumes polling if not complete.
Effects: net `GET /flights/search/{id}` · state `search` · timer · emit `search:results`.

#### `search.poll(sessionId?, opts?) → Promise<SearchSession>`
One manual poll (for `autoPoll: false`). Effects: net · state `search` · emit `search:results|search:complete`.

#### `search.stop() → void` · `search.cancel() → void`
`stop` ends polling but keeps results; `cancel` also aborts the request and clears results.
Effects: net abort tag · timer clear · state `search.status` · emit `search:cancelled` (cancel only).

#### `search.refresh(opts?) → Promise<SearchSession>`
Re‑run the current params (after expiry or price change); preserves filters/sort. Effects: as `create`.

#### `search.current() → SearchSession|null` · `search.status() → SearchSession['status']` · `search.params() → SearchParams|null`
Effects: none.

#### `search.setFilters(partial: Partial<Filters>, { replace? } = {}) → void` · `search.resetFilters(keys?: (keyof Filters)[]) → void`
Update filters and recompute `visibleIds` locally; when the session is server‑filtered (`meta.serverFiltered`), re‑queries with filters as params (debounced 250 ms).
Effects: state `search.filters`, `search.visibleIds` · emit `search:filtersChange` · net `GET /flights/search/{id}?filters…` (server mode only) · telemetry.

#### `search.setSort(sort: Sort) → void`
Effects: state `search.sort`, `search.visibleIds` · emit `search:sortChange`.

#### `search.visibleOffers() → Offer[]` · `search.facets() → Facets` · `search.summary() → ResultsSummary` · `search.activeFilterChips() → Chip[]`
Derived reads from state. Effects: none.

#### `search.page({ cursor?, limit? } = {}, opts?) → Promise<Offer[]>`
Fetch more when the backend paginates. Effects: net `GET /flights/search/{id}?cursor=` · state `search.offers` · emit `search:results`.

#### `search.selectSliceOffer(sliceIndex: number, sliceOfferId: string|null) → Promise<Offer|null>`
`per_slice` mode: record the choice for one slice; when every slice is chosen, calls `offers.combine` and resolves the priced combined offer. `null` clears the slice and later ones.
Effects: state `offers.selection.bySlice` · emit `offer:selected|offer:deselected` · net (via `offers.combine`).

#### `search.flexibleDates(params, { days? = 3 } = {}, opts?) → Promise<DateGrid>`
±N‑day price matrix for round‑trip (grid) or one‑way (row). Effects: net `GET /flights/prices/grid`.

#### `search.calendar(params, { month: 'YYYY-MM', returnMonth? } = {}, opts?) → Promise<CalendarFares>`
Lowest fare per day for a month. Effects: net `GET /flights/prices/calendar` · storage cache (15 min).

#### `search.priceGraph(params, { from: DateStr, to: DateStr, tripLengthDays? } = {}, opts?) → Promise<{ points: { date, price }[] }>`
Lowest price per departure date across a range. Effects: net `GET /flights/prices/graph`.

#### `search.explore({ origin, dates?: { from, to } | { month }, budget?: Money, tripLengthDays?, themes?, region?, directOnly? }, opts?) → Promise<Destination[]>`
"Anywhere" destination discovery. Effects: net `GET /flights/explore`.

#### `search.nearbyAlternatives(sessionId?, opts?) → Promise<{ airports: { place, price }[], dates: { date, price }[] }>`
Cheaper options from nearby airports / adjacent dates for the current search. Effects: net `GET /flights/search/{id}/alternatives`.

#### `search.insights(sessionId? | params, opts?) → Promise<PriceInsight>`
Typical price range, trend and buy/wait advice. Effects: net `GET /flights/prices/insights` · state `search.insights`.

#### `search.validate(params) → ValidationResult`
Uses `bootstrap.limits` (max pax, legs, advance days). Effects: none.

#### `search.defaults() → SearchParams`
Seed for the form: home airport, last search, 1 adult, economy, date = today + 7. Effects: none.

#### `search.normalize(params) → SearchParams`
Fill defaults, uppercase codes, sort multi‑city legs chronologically, drop empties. Effects: none.

#### `search.toUrl(params?, { base? } = {}) → string` · `search.fromUrl(url?: string) → SearchParams|null`
Deep‑link encode/decode (`utils/url`). Effects: none.

#### `search.expiry() → { expiresAt, remainingMs }|null`
Effects: none. (Timer emits `search:expiring` at T‑60 s and `search:expired`; results stay visible but `offers.select` rejects with `SearchExpiredError`.)

#### `search.history.list() → SearchParams[]` · `search.history.remove(index) → void` · `search.history.clear() → void`
Effects: storage `search.history` · state `search.history`.

#### `search.compare.add(offerId) → void` · `search.compare.remove(offerId)` · `search.compare.list() → Offer[]` · `search.compare.clear()`
Compare tray (max 4). Effects: state `search.compare`.

#### `search.track(params?, alertOpts?, opts?) → Promise<PriceAlert>`
Shortcut to `alerts.create` for the current search. Effects: see `alerts.create`.

---

## 2. `modules/filters.js` (pure; no I/O, no state)

#### `applyFilters(offers: Offer[], filters: Filters) → Offer[]` · `matches(offer, filters) → boolean`
#### `sortOffers(offers, sort: Sort, { weights? }) → Offer[]`
`best` = weighted score of price, duration, stops, departure sanity, self‑transfer penalty (weights overridable).
#### `rank(offers, weights?) → Offer[]` · `tagOffers(offers) → Offer[]`
Adds `cheapest | fastest | best | earliest` tags (ties broken deterministically).
#### `computeFacets(offers, { currency, sliceCount }) → Facets`
Counts and min prices per bucket; price histogram (20 bins); per‑slice departure/arrival buckets.
#### `defaultFilters(facets) → Filters` · `isDefault(filters, facets) → boolean` · `activeChips(filters, facets, t) → Chip[]`
`Chip = { key, label, remove: Partial<Filters> }`.
#### `mergeFacets(a, b) → Facets` (incremental batches) · `dedupeOffers(offers) → Offer[]` · `groupBySlice(offers, sliceIndex) → Map<string, Offer[]>`
#### `priceBounds(offers) → { min, max }` · `priceHistogram(offers, bins) → number[]`
#### `summarize(offers) → ResultsSummary`
#### `combinable(outbound: SliceOffer, inbound: SliceOffer) → boolean`
#### `TIME_BUCKETS`, `SORT_KEYS`, `DEFAULT_WEIGHTS` constants

All `Effects: none`.

---

## 3. `modules/offers.js`

#### `offers.get(offerId, { fresh? } = {}, opts?) → Promise<Offer>`
From state when present, else fetched. Effects: net `GET /flights/offers/{id}` (miss only) · state `search.offers.byId`.

#### `offers.details(offerId, opts?) → Promise<OfferDetails>`
Per‑segment amenities, baggage, fare rules summary, warnings (overnight layover, airport change, self‑transfer, long layover, short connection, visa‑required transit).
Effects: net `GET /flights/offers/{id}/details` · state `offers.detailsById` · telemetry `view_item`.

#### `offers.fareRules(offerId, { full? } = {}, opts?) → Promise<FareRules>`
Effects: net `GET /flights/offers/{id}/fare-rules`.

#### `offers.brandedFares(offerId, opts?) → Promise<FareFamily[]>`
Upsell families (Basic / Standard / Flex …) with feature matrix and price delta; each carries its own `offerId`.
Effects: net `POST /flights/offers/{id}/upsell` · state `offers.fareFamiliesById`.

#### `offers.selectFareFamily(offerId, familyCode) → Promise<Offer>`
Swap the selection to the family's priced offer. Effects: state `offers.selection` · emit `offer:fareFamilyChanged`, `offer:selected`.

#### `offers.combine(sliceOfferIds: string[], opts?) → Promise<Offer>`
Price a combination of per‑slice offers into one bookable offer. Effects: net `POST /flights/offers/combine` · state `search.offers.byId`.
Throws: `OfferUnavailableError`, `ValidationError` (not combinable).

#### `offers.reprice(offerId, opts?) → Promise<{ offer: Offer, changed: boolean, from?: Money, to?: Money }>`
Fare re‑validation before cart creation. Effects: net `POST /flights/offers/{id}/price` · state `offers.repriceById`, `search.offers.byId` · emit `offer:priceChanged` (when changed).
Throws: `OfferExpiredError`, `OfferUnavailableError`.

#### `offers.availability(offerId, opts?) → Promise<{ seatsLeft?: number, available: boolean }>`
Effects: net `GET /flights/offers/{id}/availability`.

#### `offers.select(offerId, { sliceIndex? } = {}) → void` · `offers.deselect() → void`
Record the user's pick (combined mode or a slice). Effects: state `offers.selection` · emit `offer:selected|offer:deselected` · telemetry `select_item`.
Throws: `SearchExpiredError`.

#### `offers.selection() → { offerId?, bySlice: Record<number, string> }` · `offers.selected() → Offer|null`
Effects: none.

#### `offers.seatMapPreview(offerId, opts?) → Promise<SeatMap[]>`
Read‑only seat maps before a cart exists (for "seat selection available" badges / previews). Effects: net `GET /flights/offers/{id}/seatmaps`.

#### `offers.baggageOptions(offerId, opts?) → Promise<Service[]>`
Pre‑cart bag prices ("add 23 kg from ₹1,200"). Effects: net `GET /flights/offers/{id}/baggage`.

#### `offers.emissions(offerId, opts?) → Promise<{ kg: number, vsTypicalPct?: number }>`
Effects: net `GET /flights/offers/{id}/emissions`.

#### `offers.share(offerId) → { url, text }` · `offers.toUrl(offerId)` · `offers.fromUrl(url) → { sessionId, offerId }|null`
Effects: none.

#### `offers.priceLockOptions(offerId, opts?) → Promise<PriceLockOption[]>`
Fare‑freeze products for an offer (purchase happens through `itinerary.lock`). Effects: net `GET /flights/offers/{id}/price-lock`.
