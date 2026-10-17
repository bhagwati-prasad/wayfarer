# 04 · Reference data: `places`, `content`

Scripts: `modules/places.js`, `modules/content.js`. All reads are cached (`cache` on by default, TTL from server headers or 24 h) and deduped.

---

## 1. `modules/places.js`

#### `places.search(query: string, { types?: Place['type'][], limit? = 8, country?, near?: { lat, lng }, lang? } = {}, opts?) → Promise<Place[]>`
Airport / city / metro autocomplete; metros include their `airports`. Below `minChars` (2) resolves `[]` without a request. Debounced callers should use `places.searchDebounced`.
Effects: net `GET /places/search` · storage `cache:places:*`.

#### `places.searchDebounced(query, options?, opts?) → Promise<Place[]>`
Same as `search` with a 200 ms trailing debounce and cancellation of the superseded call. Effects: as `search` · timer.

#### `places.get(code: IATA, opts?) → Promise<Place>`
Effects: net `GET /places/{code}` · storage cache. Throws: `NotFoundError`.

#### `places.getMany(codes: IATA[], opts?) → Promise<Record<IATA, Place>>`
Batch resolve (used to hydrate deep links). Effects: net `GET /places?codes=` · storage cache.

#### `places.nearby({ lat, lng } | IATA, { radiusKm? = 200, limit? = 5 } = {}, opts?) → Promise<Place[]>`
Effects: net `GET /places/nearby`.

#### `places.detectLocation({ via?: 'ip'|'geolocation'|'auto' } = {}, opts?) → Promise<Place|null>`
Suggest a home airport. `geolocation` prompts the browser permission.
Effects: net `GET /places/geoip` · browser geolocation prompt · state `prefs.homeAirport` only if unset.

#### `places.popular({ from?: IATA, market?, limit? } = {}, opts?) → Promise<Place[]>` · `places.popularRoutes({ from?, limit? }, opts?) → Promise<{ origin, destination, price?: Money }[]>`
Effects: net `GET /places/popular`, `GET /routes/popular` · storage cache.

#### `places.resolveMetro(code, opts?) → Promise<Place[]>`
Airports behind a metro/city code (LON → LHR, LGW, …). Effects: net `GET /places/{code}` · storage cache.

#### `places.airlines.list(opts?) → Promise<Airline[]>` · `places.airlines.get(code, opts?) → Promise<Airline>` · `places.airlines.logoUrl(code, { size? }) → string`
Effects: net `GET /airlines`, `GET /airlines/{code}` · storage cache (list, 24 h). `logoUrl` is pure.

#### `places.alliances(opts?) → Promise<{ code, name, airlines: string[] }[]>` · `places.aircraft.get(code, opts?) → Promise<Aircraft>`
Effects: net `GET /alliances`, `GET /aircraft/{code}` · storage cache.

#### `places.countries(opts?) → Promise<Country[]>` · `places.currencies(opts?) → Promise<Currency[]>` · `places.exchangeRates(base?, opts?) → Promise<{ base, rates, asOf }>`
Effects: net `GET /countries`, `GET /currencies`, `GET /fx` · storage cache (1 h for fx).

#### `places.recent.list() → Place[]` · `places.recent.add(place) → void` · `places.recent.remove(code) → void` · `places.recent.clear() → void`
Most‑recently‑used places (max 10). Effects: storage `recentPlaces`.

---

## 2. `modules/content.js`

#### `content.banners(slot: string, { market?, locale? } = {}, opts?) → Promise<Banner[]>`
CMS promotional slots (home hero, results sidebar, checkout). Effects: net `GET /content/banners` · state `content.cache`.

#### `content.deals({ from?: IATA, to?, limit?, theme? } = {}, opts?) → Promise<Deal[]>`
Fare deals / sale routes with price + dates. Effects: net `GET /content/deals` · state `content.cache`.

#### `content.offers({ page?: 'home'|'results'|'checkout', paymentMethod? } = {}, opts?) → Promise<PromoOffer[]>`
Bank / coupon offer cards (terms, code, validity). Effects: net `GET /content/offers`.

#### `content.faq({ category?, query? } = {}, opts?) → Promise<FaqEntry[]>`
Effects: net `GET /content/faq`.

#### `content.policy(key: 'terms'|'privacy'|'cancellation'|'refund'|'cookie'|string, opts?) → Promise<{ version, title, html, updatedAt }>`
Legal text with version (used in consent capture). Effects: net `GET /content/policies/{key}` · state `content.cache`.

#### `content.page(slug, opts?) → Promise<{ title, html, seo }>`
Effects: net `GET /content/pages/{slug}`.

#### `content.destination(code: IATA, opts?) → Promise<DestinationGuide>`
Effects: net `GET /content/destinations/{code}`.

#### `content.travelRequirements({ origin, destination, nationality, departureDate, returnDate?, transitCountries? }, opts?) → Promise<TravelRequirements>`
Visa / transit / health / document rules relevant to the itinerary (shown before traveler details).
Effects: net `GET /content/travel-requirements`.

#### `content.airlinePolicies(code, opts?) → Promise<{ baggage, checkIn, infants, pets, specialAssistance, contact }>`
Effects: net `GET /content/airlines/{code}/policies` · storage cache.

#### `content.airportInfo(code, opts?) → Promise<{ terminals, transfers, lounges, tips }>`
Effects: net `GET /content/airports/{code}`.

#### `content.announcements({ market? } = {}, opts?) → Promise<Announcement[]>`
Service notices (strikes, weather, system maintenance). Effects: net `GET /content/announcements`.

#### `content.invalidate(key?) → void`
Effects: state `content.cache` · storage cache.
