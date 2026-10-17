# Feature research → SDK coverage

What the major flight OTAs / metasearch products and the airline‑distribution APIs they are built on expose, and where each capability lives in this SDK. Compiled 2026‑10 from product pages, help centres and API docs (sources at the end); exact commercial terms (fees, caps, windows) vary and are not encoded in the SDK — they come from the backend.

Legend: GF = Google Flights · SKY = Skyscanner · EXP = Expedia · PL = Priceline · KIWI = Kiwi.com · HOP = Hopper · MMT = MakeMyTrip / Goibibo · CT = Cleartrip · DUF = Duffel API · AMA = Amadeus Self‑Service · NDC = IATA NDC servicing.

## Search & discovery

| capability | seen at | SDK |
|---|---|---|
| One‑way / round‑trip / multi‑city | all | `search.create` (`tripType`, `slices[]`) |
| Open‑jaw via multi‑city legs | GF, KIWI, EXP | `slices[]` with differing airports |
| Flexible dates (±3 days grid) | GF date grid, SKY, MMT | `search.flexibleDates`, `ui.buildDateGrid` |
| Month / calendar lowest fares | SKY, KIWI, MMT, CT | `search.calendar`, `ui.buildFareCalendar`, `buildDatePicker{showFares}` |
| Price graph over a period | GF price graph | `search.priceGraph`, `ui.buildPriceGraph` |
| "Anywhere" / Explore destinations | GF Explore, SKY Everywhere, KIWI | `search.explore`, `ui.buildExploreList/Map` |
| Nomad / reordering multi‑city | KIWI Nomad | out of scope for v1 (noted in QUESTIONS) |
| Nearby airports / cheaper alternatives | GF, SKY, KIWI | `includeNearby`, `search.nearbyAlternatives`, `ui.buildNearbyAlternatives` |
| Metro codes (LON, NYC) | GF, SKY, AMA | `Place.type 'metro'`, `places.resolveMetro` |
| Airport / city autocomplete with recent & popular | all | `places.search`, `places.recent`, `places.popular`, `ui.buildLocationInput` |
| Passenger types incl. lap vs seated infant, youth, senior | AMA, DUF, MMT | `PaxCounts`, `PaxType` |
| Special fares: student / senior / armed forces / doctor | MMT, CT (India) | `SearchParams.fareTypes`, `ui.buildFareTypeChips` |
| Cabin class incl. premium economy, mixed cabin | GF, EXP, DUF | `cabin`, `allowMixedCabin` |
| Direct‑only / max stops | all | `directOnly`, `maxStops`, filters |
| Incremental / streamed results from multiple suppliers | SKY, KIWI, MMT | `search.mode 'poll'|'stream'`, `search:results` batches, "new results" banner |
| Result expiry & refresh | all | `SearchSession.meta.expiresAt`, `search:expiring/expired`, `search.refresh` |
| Per‑slice (choose outbound then inbound) results | MMT/CT domestic, GF | `resultMode 'per_slice'`, `search.selectSliceOffer`, `offers.combine`, `ui.buildSliceStepper` |
| Sort: best / cheapest / fastest / earliest / emissions | GF, SKY, EXP | `Sort`, `filters.sortOffers`, `ui.buildSortBar` |
| Filters: stops, airlines, price, times, duration, layover airports & duration, baggage, refundable, alliances, aircraft | GF, SKY, EXP, KIWI, MMT | `Filters`, `filters.*`, `ui.buildFiltersPanel` |
| Price insights (typical range, trend, buy/wait) | GF, HOP prediction | `search.insights`, `ui.buildPriceInsightBanner` |
| CO₂ emissions per offer | GF, SKY | `Offer.emissionsKg`, `offers.emissions` |
| Deep‑linkable / shareable searches and offers | all | `search.toUrl/fromUrl`, `offers.share` |
| Recent searches | SKY, MMT, EXP | `search.history` |
| Compare offers | KIWI, MMT | `search.compare`, `ui.buildCompareTray` |
| Virtual interlining / self‑transfer itineraries + guarantee | KIWI | `Offer.selfTransfer`, `Layover.selfTransfer`, `TicketGroup[]`, `allowSelfTransfer`, protection `disruption_guarantee` |

## Offer details & pricing

| capability | seen at | SDK |
|---|---|---|
| Segment timeline, layovers, overnight / airport‑change warnings | all | `offers.details`, `ui.renderSegmentTimeline` |
| Operated‑by / codeshare | all | `Segment.operatingCarrier` |
| Amenities (wifi, power, seat pitch, meals) | GF, EXP | `Segment.amenities` |
| Baggage allowance per pax type / segment | all | `BaggageAllowance`, `ui.renderBaggageTable` |
| Fare rules / penalties | EXP, MMT, DUF conditions | `offers.fareRules`, `Conditions` |
| Branded fares / fare family upsell | EXP, MMT, AMA Branded Fares Upsell, NDC | `offers.brandedFares`, `offers.selectFareFamily`, `ui.buildFareFamilySelector` |
| Re‑price / fare revalidation before booking | AMA Flight Offers Price, DUF | `offers.reprice`, `itinerary.reprice`, `PriceChangedError`, `ui.buildPriceChangeDialog` |
| Seats‑left scarcity | EXP, MMT | `Offer.seatsLeft`, `offers.availability` |
| Seat‑map preview before booking | AMA SeatMap Display, DUF | `offers.seatMapPreview` |
| Per‑pax vs total price display | EXP (US DOT all‑in), MMT | `prefs.pricePer`, `PriceBreakdown.perPax` |

## Cart, travelers, ancillaries

| capability | seen at | SDK |
|---|---|---|
| Server‑side cart with expiry / countdown | MMT, CT, EXP | `itinerary.*`, `itinerary:expiring/expired`, `ui.buildExpiryBanner` |
| Promo / coupon codes, bank offers | MMT, CT, EXP | `itinerary.applyPromo`, `wallet.coupons`, `content.offers` |
| Traveler requirements differ domestic vs international (APIS, passports) | DUF, AMA, NDC | `itinerary.requirements`, `TravelerRequirements` |
| Saved traveler list with documents & frequent‑flyer | EXP, MMT, CT, PL | `travelers.*`, `ui.buildTravelersManager` |
| GST invoice details (India B2B) | MMT, CT | `Contact.gst`, `account.billingProfiles`, `trips.invoice.request({gst})` |
| Known traveler / redress numbers | EXP, PL (US) | `Traveler.knownTravelerNumber/redressNumber` |
| Special assistance (SSR), meals | all | `Traveler.assistance`, `ancillaries.meals`, `trips.requests.specialAssistance` |
| Seat selection with pricing & restrictions | DUF seat maps, MMT, EXP | `ancillaries.seats.*`, `ui.buildSeatMap` |
| Extra baggage, meals, priority boarding, lounge, fast track | DUF services, MMT, CT | `ancillaries.baggage/meals/extras` |
| Travel insurance with explicit accept / decline | MMT, CT, EXP | `ancillaries.insurance.*`, `ui.buildInsuranceCard` |
| Price freeze / fare lock | HOP Price Freeze, MMT Price Lock (Hopper‑powered), Goibibo | `offers.priceLockOptions`, `itinerary.lock/fromLock`, `Booking.type 'price_lock'` |
| Price‑drop protection | EXP, MMT | `Protection.type 'price_drop'` |
| Cancel‑for‑any‑reason / zero cancellation / flexible ticket | HOP CFAR, MMT Zero Cancellation, EXP | `Protection.type 'cfar'|'zero_cancellation'|'flexible_ticket'` |
| Disruption / missed‑connection guarantee | HOP, KIWI Guarantee | `Protection.type 'disruption_guarantee'` |
| Carbon offset | SKY, GF partners | `ancillaries.extras` type `carbon_offset` |

## Booking & payment

| capability | seen at | SDK |
|---|---|---|
| Guest checkout + later account merge | EXP, KIWI, CT | `auth.ensureGuestSession`, `booking.retrieve` |
| Book‑now‑pay‑later / hold | DUF hold orders, MMT, airlines | `booking.holdOptions/hold`, `trips.payNow`, `ui.buildHoldOptions` |
| Idempotent order creation | DUF, AMA | `Idempotency-Key` interceptor, `booking.create` |
| Async ticketing status | DUF, AMA | `booking.waitForTicketing`, `ui.buildBookingStatusTracker` |
| Cards via hosted fields / 3‑DS | all | `GatewayAdapter`, `payments.mount/confirm/handleAction` |
| UPI (collect / intent / QR), net‑banking, wallets, EMI | MMT, CT, Goibibo | `PaymentMethodType`, `payments.confirm{vpa,bankCode}`, `ui.buildUpiPanel`, `payments.emiPlans` |
| Apple Pay / Google Pay / PayPal / BNPL | EXP, PL, KIWI, HOP | `PaymentMethodType` |
| Split payment with wallet / points / gift card / voucher | MMT wallet, EXP OneKeyCash, PL | `payments.credits.*` |
| Saved cards / tokens | all | `payments.savedMethods` |
| Redirect‑based payments with state restore | all (3‑DS, net‑banking) | `payments.resumeAfterRedirect`, `client.snapshot/restore` |
| Surcharges / payment fees per method | KIWI, CT | `PaymentMethod.fee`, `payments.quote` |
| E‑ticket, receipt, invoice downloads | all | `booking.documents/download` |
| Add to calendar / share itinerary | GF, EXP, MMT | `booking.calendar/share` |

## Post‑booking

| capability | seen at | SDK |
|---|---|---|
| Upcoming / past / cancelled trips | all | `trips.list({phase})`, `ui.buildTripsList` |
| Retrieve booking by PNR + surname (guest) | EXP, KIWI, CT | `booking.retrieve`, `ui.buildRetrieveBookingForm` |
| Date / flight change with quote then confirm | DUF order changes, NDC OrderReshop, EXP, MMT | `trips.changes.options/search/quote/confirm`, `ui.buildChangeFlow` |
| Full / partial cancellation with refund preview | DUF pending cancellation, MMT, CT | `trips.cancellation.quote/confirm`, `ui.buildCancelFlow` |
| 24 h free cancellation / same‑day void | US DOT rule, HOP, NDC void | `Conditions.voidUntil`, `Booking.voidUntil`, `trips.void` |
| Refund status tracking | all | `trips.refunds`, `ui.buildRefundTracker` |
| Airline schedule changes / involuntary options | NDC OrderChangeNotif, DUF airline‑initiated changes | `trips.disruptions`, `trips.disruptions.respond`, `ui.buildDisruptionNotice` |
| Post‑booking seats / bags / meals | DUF, MMT, EXP | `trips.ancillaries`, `trips.amendment.*` |
| Web check‑in links / boarding passes | MMT, CT, AMA Check‑in Links | `trips.checkIn`, `trips.boardingPasses` |
| Flight status & alerts | GF, MMT, HOP | `trips.flightStatus`, `trips.alerts.*` |
| Name correction, contact update, document update, split PNR | OTA support flows | `trips.requests.*` |
| GST / company invoice after travel | MMT, CT | `trips.invoice.request` |
| Rebook from a past trip | EXP, MMT | `trips.rebookParams` |

## Account & engagement

| capability | seen at | SDK |
|---|---|---|
| Email / phone OTP / social / magic‑link login, MFA | MMT (OTP‑first), EXP, KIWI | `auth.*`, `ui.buildAuthPanel` |
| Preferences: currency, locale, home airport | all | `account.preferences`, `client.setLocale/Currency` |
| Price alerts (incl. guest email alerts) & saved searches | GF, SKY, HOP, KIWI, EXP | `alerts.*`, `ui.buildAlertsManager` |
| Wallet / loyalty tiers / referrals | MMT (MyCash), EXP (One Key), PL (VIP) | `wallet.*` |
| Notifications inbox & push | HOP, MMT | `account.notifications.*` |
| Consents, data export, account deletion (GDPR / DPDP) | EU/India regulation | `account.consents/exportData/delete` |
| Support tickets, callback, chat hand‑off | all | `support.*` |

## Technical patterns borrowed from the distribution APIs

| pattern | source | SDK |
|---|---|---|
| Offer request → offers → order (orders separate from offers) | DUF, AMA | `search` → `offers` → `itinerary` → `booking` |
| Pending change / cancellation that is previewed then confirmed | DUF | every servicing op is `quote → confirm` |
| Price guarantee / offer expiry timestamps | DUF `expires_at`, AMA | `Offer.expiresAt`, `Itinerary.expiresAt` |
| Available services (bags/seats) listed per offer/order | DUF, AMA | `ancillaries.catalog` |
| Airline‑initiated change notifications | NDC `OrderChangeNotif`, DUF webhooks | `trips.disruptions`, `trip:disruption` |
| Same‑day void then refund waiver | ARC/BSP via NDC | `voidUntil`, `trips.void` |

## Sources

- Duffel API overview and endpoints (offer requests, orders, seat maps, order changes, cancellations) — https://providers.apievangelist.com/providers/duffel/ , https://phptravels.com/blog/duffel-flight-api-integration , https://duffel.com/guides/getting-started
- Amadeus Self‑Service flight APIs (Flight Offers Search / Price, Create Orders, SeatMap, Branded Fares Upsell, Order Management) — https://github.com/amadeus4dev/amadeus-node , https://pypi.org/project/amadeus , https://www.adivaha.com/Amadeus-Flight-Booking-API.html
- IATA NDC servicing: OrderChangeNotif, involuntary changes, voids — https://www.iata.org/contentassets/6de4dce5f38b45ce82b0db42acd23d1c/ndc-infocus-servicing.pdf , https://support.travelport.com/webhelp/ndcPlugin/Content/SPC/NDCFAQs-Service.htm , https://ndc.virginatlantic.com/docs/orderchangenotif
- Kiwi.com virtual interlining, Nomad, Everywhere search, Guarantee — https://en.wikipedia.org/wiki/Kiwi.com , https://www.kiwi.com/stories/this-is-how-kiwi-com-works/ , https://www.kiwi.com/stories/kiwi-coms-travel-hacks-explained/
- Hopper Price Freeze, Cancel For Any Reason, disruption protection — https://techcrunch.com/2022/06/07/hopper-launches-offerings-more-flexibility-before-during-trips/ , https://milesopedia.com/en/reviews/products/hopper , https://www.shopback.com/blog/travel/is-hopper-reliable-us-2026
- MakeMyTrip Price Lock (Hopper‑powered), Zero Cancellation, Price Drop Protection — https://www.webintravel.com/?p=57092 , https://gulfnews.com/business/corporate-news/makemytrip-portal-addresses-traveler-concerns-over-cancellation-charges-1.94691328 , https://www.franchiseindia.com/insights/en/news/makemytrips-newly-launched-price-drop-protection-refunds-flyers-if-fares-drop-after-booking.59819
- Cleartrip special fares (student / senior / armed forces), business fares, GST invoice — https://www.cleartrip.com/flights
- Google Flights date grid, price graph, Explore, tracking, emissions; Skyscanner Everywhere & alerts — https://www.going.com/guides/google-flights-vs-skyscanner , https://www.australianfrequentflyer.com.au/google-flights-guide , https://withautopilot.com/blog/google-flights-tips
- Expedia Price Drop Protection terms — https://www.expedia.com/lp/b/one-key-price-drop-protection , https://www.expedia.com/lp/b/price-drop-protection/terms-original , https://www.expedia.com/newsroom/?p=45222
- Priceline Express Deals, bundling — https://www.nerdwallet.com/travel/learn/priceline-guide , https://apps.apple.com/us/app/-/id336381998
