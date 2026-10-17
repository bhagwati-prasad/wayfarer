# 06 · Itinerary: `itinerary`, `travelers`, `ancillaries`

Scripts: `modules/itinerary.js`, `modules/travelers.js`, `modules/ancillaries.js`.
An **itinerary** is the server‑side cart: selected offer(s) + passenger counts + travelers + ancillaries + promo, re‑priced as a unit, with an expiry. One active itinerary per client.

---

## 1. `modules/itinerary.js`

#### `itinerary.create({ offerIds: string[], passengers?: PaxCounts, searchSessionId?, promoCode?, metadata? }, opts?) → Promise<Itinerary>`
Re‑price the offer(s), create the cart, compute traveler requirements, arm expiry timer. Replaces any existing active itinerary (previous is abandoned).
Effects: net `POST /itineraries` · state `itinerary`, `ancillaries` (reset) · storage `itinerary.id` · timer expiry · emit `itinerary:created`, `offer:priceChanged` (if price moved) · telemetry `add_to_cart`.
Throws: `OfferExpiredError`, `OfferUnavailableError`, `PriceChangedError` (only when `opts.meta.throwOnPriceChange`), `ValidationError`.

#### `itinerary.get(id?, { fresh? } = {}, opts?) → Promise<Itinerary>` · `itinerary.current() → Itinerary|null`
Effects: net `GET /itineraries/{id}` (fresh or miss) · state `itinerary`.

#### `itinerary.resume(opts?) → Promise<Itinerary|null>`
Reload the itinerary id persisted in storage (page reload, redirect return); `null` if expired/booked.
Effects: net `GET /itineraries/{id}` · state `itinerary`, `ancillaries` · timer expiry · storage remove on miss.

#### `itinerary.replaceOffer(offerId, { sliceIndex? } = {}, opts?) → Promise<Itinerary>` · `itinerary.addOffer(offerId, opts?)` · `itinerary.removeOffer(offerId, opts?)`
Change the flights (fare family swap, multi‑ticket legs). Ancillaries for removed segments are dropped.
Effects: net `PATCH /itineraries/{id}/offers` · state `itinerary`, `ancillaries` · emit `itinerary:updated`.

#### `itinerary.setPassengers(passengers: PaxCounts, opts?) → Promise<Itinerary>`
Re‑price for a different pax mix (creates new slots, keeps matching travelers).
Effects: net `PATCH /itineraries/{id}` · state `itinerary` · emit `itinerary:updated|itinerary:priceChanged`.

#### `itinerary.reprice({ force? } = {}, opts?) → Promise<{ itinerary, changed: boolean, from?: Money, to?: Money }>`
Fare re‑validation (called automatically before `booking.create` / `booking.hold`).
Effects: net `POST /itineraries/{id}/price` · state `itinerary.price`, `itinerary.priceChange` · emit `itinerary:priceChanged` (when changed).
Throws: `ItineraryExpiredError`, `OfferUnavailableError`.

#### `itinerary.acceptPriceChange(opts?) → Promise<Itinerary>`
Record user consent to the new price (required by `booking.create` when `priceChange` is pending).
Effects: net `POST /itineraries/{id}/price/accept` · state `itinerary.priceChange.acceptedAt` · telemetry.

#### `itinerary.applyPromo(code, opts?) → Promise<Itinerary>` · `itinerary.removePromo(opts?) → Promise<Itinerary>`
Effects: net `POST|DELETE /itineraries/{id}/promo` · state `itinerary.promo`, `itinerary.price` · emit `itinerary:promoApplied|itinerary:promoRemoved`.
Throws: `ApiError{code:'PROMO_INVALID'|'PROMO_NOT_ELIGIBLE'|'PROMO_EXPIRED'}`.

#### `itinerary.eligiblePromos(opts?) → Promise<Coupon[]>`
Effects: net `GET /itineraries/{id}/promos`.

#### `itinerary.requirements({ fresh? } = {}, opts?) → Promise<TravelerRequirements>`
Which traveler/contact fields and documents are mandatory for this itinerary (domestic vs international, APIS, GST, age rules, name charset).
Effects: net `GET /itineraries/{id}/requirements` (miss only) · state `itinerary.requirements`.

#### `itinerary.setTravelers(travelers: Traveler[], contact: Contact, { validateOnly? } = {}, opts?) → Promise<ValidationResult>`
Validate against `requirements` (local) then persist to the cart; slots are matched by `slotId` or by order+type.
Effects: net `PUT /itineraries/{id}/travelers` (when valid and not `validateOnly`) · state `itinerary.travelers`, `itinerary.contact` · storage `travelers.drafts` (only if `persist.drafts`) · emit `itinerary:travelersSet`.
Throws: `ValidationError`, `ApiError{code:'NAME_MISMATCH'|'DOCUMENT_INVALID'|'DUPLICATE_TRAVELER'}`.

#### `itinerary.setContact(contact: Contact, opts?) → Promise<Itinerary>`
Contact / GST / emergency only. Effects: net `PATCH /itineraries/{id}/contact` · state `itinerary.contact`.

#### `itinerary.travelers() → Traveler[]` · `itinerary.contact() → Contact|null` · `itinerary.slots() → PassengerSlot[]`
Effects: none.

#### `itinerary.setMetadata(meta: object, opts?) → Promise<Itinerary>`
Host‑defined data (campaign, affiliate id, remarks) carried to the booking. Effects: net `PATCH /itineraries/{id}` · state.

#### `itinerary.priceBreakdown({ perPax? } = {}) → PriceBreakdown`
Flights + ancillaries + protections + insurance − promo + fees, from state. Effects: none.

#### `itinerary.validate() → ValidationResult`
Pre‑booking gate: not expired, travelers complete, contact valid, insurance decision made (if required), consents present, seat selections not conflicting, no pending price change.
Effects: none.

#### `itinerary.expiry() → { expiresAt, remainingMs }|null` · `itinerary.extend(opts?) → Promise<Itinerary>`
Timer emits `itinerary:expiring` (T‑120 s) and `itinerary:expired` (status → expired). `extend` asks the backend for a fresh hold when allowed.
Effects (extend): net `POST /itineraries/{id}/extend` · state `itinerary.expiresAt` · timer re‑arm.

#### `itinerary.lockOptions(opts?) → Promise<PriceLockOption[]>` · `itinerary.lock(optionId, opts?) → Promise<Booking>`
Price‑lock / fare‑freeze: creates a `Booking{type:'price_lock'}` whose fee is paid through the normal `payments` flow.
Effects: net `GET /itineraries/{id}/price-lock`, `POST /itineraries/{id}/price-lock` · state `itinerary.lockId`, `booking.current` · emit `itinerary:locked`, `booking:created`.

#### `itinerary.fromLock(lockId, opts?) → Promise<Itinerary>`
Resume a locked fare into a fresh itinerary (price capped per lock terms). Effects: net `POST /price-locks/{id}/itinerary` · state `itinerary` · emit `itinerary:created`.

#### `itinerary.summary() → ItinerarySummary`
Compact view model for UI (`route, dates, pax, perPax, total, countdown, items[]`). Effects: none.

#### `itinerary.holdPolicy() → HoldPolicy|null`
Merged hold policy of the itinerary's offers (backend‑decided per flight; the most restrictive wins). Effects: none.

#### `itinerary.clear({ abandon? = true } = {}) → void`
Effects: net `DELETE /itineraries/{id}` (best effort, when `abandon`) · state `itinerary`, `ancillaries`, `booking` reset · storage remove · timer clear · emit `itinerary:cleared`.

---

## 2. `modules/travelers.js` (saved traveler profiles + traveler helpers)

#### `travelers.list({ fresh? } = {}, opts?) → Promise<TravelerProfile[]>`
Requires login (resolves `[]` for guests). Effects: net `GET /me/travelers` · state `travelers.profiles`.

#### `travelers.get(id, opts?) → Promise<TravelerProfile>`
Effects: net (miss only) · state.

#### `travelers.create(profile: Omit<TravelerProfile,'id'>, opts?) → Promise<TravelerProfile>` · `travelers.update(id, patch, opts?) → Promise<TravelerProfile>` · `travelers.remove(id, opts?) → Promise<void>`
Effects: net `POST|PATCH|DELETE /me/travelers[/{id}]` · state `travelers.profiles` · emit `travelers:changed`.
Throws: `ValidationError`.

#### `travelers.setDefault(id, opts?) → Promise<void>`
Primary traveler used to prefill slot 1. Effects: net `POST /me/travelers/{id}/default` · state.

#### `travelers.documents.add(travelerId, doc: TravelDocument, opts?)` · `.update(travelerId, docId, patch, opts?)` · `.remove(travelerId, docId, opts?)`
Effects: net `POST|PATCH|DELETE /me/travelers/{id}/documents[/{docId}]` · state · emit `travelers:changed`.

#### `travelers.loyalty.add(travelerId, account: LoyaltyAccount, opts?)` · `.remove(travelerId, airline, opts?)` · `travelers.loyalty.programmes(opts?) → Promise<{ airline, name, pattern }[]>`
Effects: net `POST|DELETE /me/travelers/{id}/loyalty`, `GET /loyalty-programmes` (cached) · state.

#### `travelers.suggestFor(slot: PassengerSlot, travelDate: DateStr, rules: AgeRules) → TravelerProfile[]`
Saved profiles whose age at travel date fits the slot type, unused by other slots first. Effects: none.

#### `travelers.toTraveler(profile: TravelerProfile, slot: PassengerSlot) → Traveler`
Map a profile into a booking traveler for a slot (copies documents/loyalty, sets `slotId`, `type`). Effects: none.

#### `travelers.validate(traveler: Traveler, { requirements, slot, travelDate, lastTravelDate, international }) → ValidationResult`
Full per‑traveler validation (names, age vs type, document rules and expiry, loyalty pattern, assistance codes). Effects: none.

#### `travelers.validateAll(travelers: Traveler[], contact: Contact, ctx) → ValidationResult`
Adds cross‑traveler checks (duplicates, infants per adult, exactly one contact). Effects: none.

#### `travelers.paxTypeFor(dob: DateStr, travelDate: DateStr, rules: AgeRules) → PaxType` · `travelers.ageAt(dob, date) → number`
Effects: none.

#### `travelers.drafts.save(slotId, partial: Partial<Traveler>) → void` · `travelers.drafts.get(slotId) → Partial<Traveler>|undefined` · `travelers.drafts.all()` · `travelers.drafts.clear(slotId?) → void`
Unsaved form progress per slot; memory by default, sessionStorage when `persist.drafts` is on (documents are never persisted).
Effects: state `travelers.drafts` · storage `travelers.drafts` (opt‑in).

#### `travelers.importFromBooking(bookingId, { select?: string[] } = {}, opts?) → Promise<TravelerProfile[]>`
Save travelers from a past booking as profiles. Effects: net `POST /me/travelers/import` · state · emit `travelers:changed`.

#### `travelers.options.titles(paxType?) → string[]` · `.genders() → string[]` · `.mealCodes(airline?, opts?) → Promise<{ code, label }[]>` · `.assistanceCodes(opts?) → Promise<{ code, label, requiresNote }[]>` · `.documentTypes(country?) → TravelDocument['type'][]`
Static lists or cached lookups (`GET /reference/ssr`, `GET /reference/meals`). Effects: net (first call) · storage cache.

---

## 3. `modules/ancillaries.js` (operates on the current itinerary; `context: { bookingId }` switches to post‑booking)

#### `ancillaries.catalog({ fresh?, context? } = {}, opts?) → Promise<AncillaryCatalog>`
Everything purchasable for this itinerary: services (bags, meals, extras), seat‑map availability per segment, insurance quotes, protection products, bundles.
Effects: net `GET /itineraries/{id}/ancillaries` | `GET /bookings/{id}/ancillaries` · state `ancillaries.catalog`.

#### `ancillaries.selected(type?: AncillaryType) → SelectedAncillary[]` · `ancillaries.total(type?) → Money` · `ancillaries.summary(t?) → { items, total }`
Effects: none.

#### `ancillaries.add({ serviceId, passengerId?, segmentId?, sliceId?, quantity? = 1 }, opts?) → Promise<Itinerary>` · `ancillaries.remove(selectionId, opts?) → Promise<Itinerary>` · `ancillaries.clear(type?, opts?) → Promise<Itinerary>`
Generic add/remove; validates scope and `maxQuantity` locally; cart is re‑priced by the server.
Effects: net `POST|DELETE /itineraries/{id}/ancillaries[/{selectionId}]` · state `ancillaries.selected`, `itinerary.price` · emit `ancillaries:changed`.
Throws: `ValidationError`, `ApiError{code:'SERVICE_UNAVAILABLE'}`.

#### `ancillaries.seats.map(segmentId, { fresh? } = {}, opts?) → Promise<SeatMap>`
Effects: net `GET /itineraries/{id}/seatmaps/{segmentId}` · state `ancillaries.seatMapsBySegment`.

#### `ancillaries.seats.select({ segmentId, passengerId, seatNumber }, opts?) → Promise<Itinerary>` · `ancillaries.seats.unselect({ segmentId, passengerId }, opts?)`
Enforces `Seat.restrictions` (infant‑on‑lap, exit‑row age) locally before calling the server.
Effects: net `POST|DELETE /itineraries/{id}/seats` · state `ancillaries.selected`, `ancillaries.seatMapsBySegment` (mark taken) · emit `seats:changed`.
Throws: `ValidationError`, `ApiError{code:'SEAT_TAKEN'}` (map refreshed automatically).

#### `ancillaries.seats.canSelect(seat: Seat, passenger: Traveler, segment) → { ok: boolean, reason?: string }` · `ancillaries.seats.selection(segmentId?) → SelectedAncillary[]`
Effects: none.

#### `ancillaries.seats.autoAssign({ segmentIds?, together? = true, preference?: 'window'|'aisle'|'front' } = {}, opts?) → Promise<Itinerary>`
Effects: net `POST /itineraries/{id}/seats/auto` · state · emit `seats:changed`.

#### `ancillaries.baggage.options({ passengerId?, sliceId? } = {}) → Service[]` · `ancillaries.baggage.set({ passengerId, sliceId, serviceId|null }, opts?) → Promise<Itinerary>` · `ancillaries.baggage.selection() → SelectedAncillary[]`
One checked‑bag choice per pax per slice (replace semantics). Effects: as `add/remove`.

#### `ancillaries.meals.options(segmentId, passengerId?) → Service[]` · `ancillaries.meals.set({ segmentId, passengerId, serviceId|null }, opts?)` · `ancillaries.meals.selection()`
Effects: as `add/remove`.

#### `ancillaries.insurance.quotes({ fresh? } = {}, opts?) → Promise<InsuranceQuote[]>` · `ancillaries.insurance.add(quoteId, { passengerIds? } = {}, opts?) → Promise<Itinerary>` · `ancillaries.insurance.remove(opts?)` · `ancillaries.insurance.decline(opts?) → Promise<void>` · `ancillaries.insurance.decision() → 'added'|'declined'|'pending'`
Explicit accept/decline is recorded (some markets require it). Effects: net `GET /itineraries/{id}/insurance`, `POST|DELETE /itineraries/{id}/insurance`, `POST /itineraries/{id}/insurance/decline` · state `ancillaries.insurance` · emit `insurance:changed`.

#### `ancillaries.protections.list() → Protection[]` · `ancillaries.protections.add(id, opts?) → Promise<Itinerary>` · `ancillaries.protections.remove(id, opts?)` · `ancillaries.protections.selected() → Protection[]`
Price‑drop protection, cancel‑for‑any‑reason / zero cancellation, flexible ticket, disruption guarantee, baggage protection. Effects: net `POST|DELETE /itineraries/{id}/protections` · state `ancillaries.protections` · emit `protections:changed`.

#### `ancillaries.extras.list(type?) → Service[]` · `ancillaries.extras.add(serviceId, scope?, opts?)` · `ancillaries.extras.remove(selectionId, opts?)`
Priority boarding, lounge, fast track, wifi, carbon offset, airport transfer. Effects: as `add/remove`.

#### `ancillaries.bundles.list() → Service[]` · `ancillaries.bundles.apply(bundleId, opts?) → Promise<Itinerary>`
Seat+bag+meal bundles priced as one. Effects: as `add/remove`.

#### `ancillaries.validate() → ValidationResult`
Seat for each pax per segment is optional; flags conflicts (seat for lap infant, bag on segment not in itinerary, insurance pending when mandatory decision). Effects: none.
