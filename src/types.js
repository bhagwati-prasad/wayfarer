// Shared data types of the Wayfarer flights SDK: a JSDoc mirror of docs/api/00-types.md (normative), one
// `@typedef` per documented interface / type alias with the same names, fields and comments, plus the few
// helper shapes those definitions reference from docs/api/01-core.md §3, 02 §3-4, 03 §10 and 07 §2.
// Sibling scripts reference them as `import('../types.js').Offer`; `npm run types` turns them into
// types/types.d.ts. This module carries no runtime code: it must not export values, import anything at
// runtime, or touch window/document. Behavioural contracts (ModuleContext, module APIs) live next to
// their implementations, not here.

// ── scalars ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Monetary amount: decimal string plus ISO-4217 currency (never floats, never minor units).
 * @typedef {Object} Money
 * @property {string} amount decimal string, e.g. "1234.56"
 * @property {string} currency ISO-4217 code, e.g. "INR"
 */

/**
 * Local calendar date, `YYYY-MM-DD`.
 * @typedef {string} DateStr
 */

/**
 * ISO-8601 timestamp **with UTC offset**, e.g. `2026-11-02T06:45:00+05:30` (local time at the airport is
 * preserved).
 * @typedef {string} DateTime
 */

/**
 * IATA airport / city / metro code.
 * @typedef {string} IATA
 */

/**
 * Passenger type code. `INF` lap infant, `INS` seated infant.
 * @typedef {'ADT'|'CHD'|'INF'|'INS'|'YTH'|'SRC'|'STU'} PaxType
 */

/**
 * Cabin requested or flown.
 * @typedef {'economy'|'premium_economy'|'business'|'first'} CabinClass
 */

/**
 * Shape of the journey.
 * @typedef {'one_way'|'round_trip'|'multi_city'} TripType
 */

/**
 * Special fare categories (shown by the UI only when `bootstrap.limits.fareTypes` lists them).
 * @typedef {'regular'|'student'|'senior'|'armed_forces'|'doctor'|'corporate'|'youth'} FareType
 */

/**
 * Trip lifecycle bucket used by `trips.list`.
 * @typedef {'upcoming'|'past'|'cancelled'} Phase
 */

// ── request plumbing ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-call options accepted as the trailing `opts` argument of every network function and forwarded to
 * `http`.
 * @typedef {Object} RequestOpts
 * @property {AbortSignal} [signal] caller-owned abort signal (combined with timeout and tag)
 * @property {number} [timeoutMs] per-request timeout
 * @property {number} [retries] max retry attempts (idempotent requests only)
 * @property {(err: SdkError, attempt: number) => boolean} [retryOn] custom retry predicate
 * @property {Record<string, string>} [headers] extra request headers
 * @property {Record<string, unknown>} [query] extra query parameters
 * @property {string|true} [idempotencyKey] `true` = derive from payload
 * @property {false|{ ttlMs: number, key?: string }} [cache] response cache control
 * @property {boolean} [dedupe] share identical in-flight GETs
 * @property {string} [tag] for `http.abort(tag)`
 * @property {boolean|'optional'} [auth] `false` = never attach credentials
 * @property {'json'|'blob'|'text'|'stream'} [responseType] how the body is parsed
 * @property {Record<string, unknown>} [meta] free-form, visible to interceptors/hooks
 */

/**
 * Cursor-paginated list.
 * @template T
 * @typedef {Object} Page
 * @property {T[]} items page content
 * @property {string} [cursor] cursor of the next page
 * @property {number} [total] total count when the backend knows it
 * @property {boolean} hasMore whether another page exists
 */

/**
 * One validation problem, addressed by JSON path.
 * @typedef {Object} ValidationIssue
 * @property {string} path dotted path of the offending field, e.g. `travelers[0].dob`
 * @property {string} code machine-readable code
 * @property {string} message human-readable message
 * @property {object} [params] extra data for message interpolation
 */

/**
 * Result of a validation run.
 * @typedef {Object} ValidationResult
 * @property {boolean} valid `true` when `issues` is empty
 * @property {ValidationIssue[]} issues every issue found
 */

// ── reference data ───────────────────────────────────────────────────────────────────────────────

/**
 * Airport, city or metro area.
 * @typedef {Object} Place
 * @property {IATA} code IATA code
 * @property {'airport'|'city'|'metro'} type kind of place
 * @property {string} name display name
 * @property {string} city city name
 * @property {IATA} [cityCode] city / metro code of an airport
 * @property {string} country country name
 * @property {string} countryCode ISO-3166 alpha-2
 * @property {string} tz IANA time zone
 * @property {number} [lat] latitude
 * @property {number} [lng] longitude
 * @property {Place[]} [airports] airports of a city / metro
 * @property {number} [distanceKm] distance from the query point (nearby searches)
 */

/**
 * Airline reference data.
 * @typedef {Object} Airline
 * @property {string} code IATA airline code
 * @property {string} name display name
 * @property {string} [logoUrl] logo image URL
 * @property {string} [alliance] alliance name
 * @property {boolean} [lowCost] low-cost carrier flag
 */

/**
 * Aircraft reference data.
 * @typedef {Object} Aircraft
 * @property {string} code IATA aircraft code
 * @property {string} name display name
 */

/**
 * Country reference data.
 * @typedef {Object} Country
 * @property {string} code ISO-3166 alpha-2
 * @property {string} name display name
 * @property {string} dialCode phone dial code
 * @property {string} currency ISO-4217 code
 * @property {string} [flag] flag emoji / URL
 */

/**
 * Currency reference data.
 * @typedef {Object} Currency
 * @property {string} code ISO-4217 code
 * @property {string} name display name
 * @property {string} symbol display symbol
 * @property {number} decimals minor-unit digits
 */

// ── search ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Passenger counts of a search / itinerary.
 * @typedef {Object} PaxCounts
 * @property {number} adults adults
 * @property {number} children children
 * @property {number} infants lap infants
 * @property {number} [infantsSeated] seated infants
 * @property {number} [youth] youth fares
 * @property {number} [seniors] senior fares
 * @property {number[]} [childAges] ages of the children, when the backend needs them
 */

/**
 * One requested slice (leg) of a search.
 * @typedef {Object} SliceRequest
 * @property {IATA} origin departure place
 * @property {IATA} destination arrival place
 * @property {DateStr} date departure date
 * @property {0|1|2|3} [flexDays] ± days of flexibility
 * @property {{ from?: string, to?: string }} [timeWindow] departure window, `HH:mm` local
 */

/**
 * Parameters of `search.create`.
 * @typedef {Object} SearchParams
 * @property {TripType} tripType journey shape
 * @property {SliceRequest[]} slices one per leg
 * @property {PaxCounts} passengers passenger counts
 * @property {CabinClass} cabin cabin requested
 * @property {FareType[]} [fareTypes] special fares
 * @property {boolean} [directOnly] non-stop only
 * @property {0|1|2} [maxStops] maximum stops per slice
 * @property {boolean} [includeNearby] include nearby airports
 * @property {{ include?: string[], exclude?: string[] }} [airlines] airline filter
 * @property {string[]} [alliances] alliance filter
 * @property {boolean} [refundableOnly] refundable fares only
 * @property {boolean} [baggageIncluded] fares with checked baggage only
 * @property {boolean} [allowSelfTransfer] allow virtual interlining / self-transfer offers
 * @property {boolean} [allowMixedCabin] allow mixed-cabin offers
 * @property {number} [maxDurationMinutes] maximum slice duration
 * @property {string} [currency] pricing currency
 * @property {'per_slice'|'combined'} [resultMode] default `per_slice` (split: outbound and inbound
 *   chosen separately, docs/QUESTIONS.md decision 5)
 * @property {{ bookingId?: string, sliceIds?: string[] }} [context] reshop for a change
 */

/**
 * A search session as held in the `search` slice.
 * @typedef {Object} SearchSession
 * @property {string} id session id
 * @property {'pending'|'streaming'|'complete'|'expired'|'error'|'cancelled'} status lifecycle state
 * @property {SearchParams} params the request
 * @property {'combined'|'per_slice'} resultMode mode the results are in
 * @property {Offer[]} offers combined mode
 * @property {SliceOffer[][]} [sliceOffers] per_slice mode: one array per slice
 * @property {Facets} facets facet counts of the loaded set
 * @property {ResultsSummary} summary cheapest / fastest / best / earliest
 * @property {PriceInsight} [insights] price insight when available
 * @property {{ total: number, currency: string, expiresAt: DateTime, providersPending: number, cursor?: string }} meta result metadata
 */

/**
 * A priced flight offer (combined mode: all slices; per-slice mode: see `SliceOffer`).
 * @typedef {Object} Offer
 * @property {string} id offer id
 * @property {Airline} owner validating / selling airline
 * @property {Slice[]} slices legs
 * @property {PriceBreakdown} price total price
 * @property {PaxPrice[]} passengers per passenger type pricing
 * @property {FareFamily} [fareFamily] branded fare
 * @property {BaggageAllowance} baggage included baggage
 * @property {Conditions} conditions fare conditions summary
 * @property {('cheapest'|'fastest'|'best'|'earliest'|'recommended'|string)[]} tags badges
 * @property {DateTime} expiresAt when the offer stops being bookable
 * @property {TicketGroup[]} [tickets] >1 = multi-ticket / virtual interlining
 * @property {boolean} [selfTransfer] self-transfer between tickets
 * @property {number} [seatsLeft] seats left at this price
 * @property {number} [emissionsKg] CO2 estimate
 * @property {string} [source] supplier / provider
 * @property {HoldPolicy} [hold] backend-decided per flight: free / paid / none
 * @property {DateStr} [lastTicketingDate] ticketing deadline
 * @property {string[]} [validatingAirlines] validating airline codes
 * @property {boolean} [oneWayCombinable] can be combined with other one-way offers
 * @property {unknown} [raw] untouched wire payload (e.g. Amadeus FlightOffer)
 */

/**
 * Fare-hold policy of an offer, decided by the backend per flight.
 * @typedef {Object} HoldPolicy
 * @property {boolean} allowed whether a hold is possible
 * @property {DateTime} [freeUntil] end of the free hold window
 * @property {HoldOption[]} options paid hold options
 * @property {string} [note] backend note
 */

/**
 * An offer for one slice in per_slice (split) mode.
 * @typedef {Offer & { sliceIndex: number, combinableWith?: string[] }} SliceOffer
 */

/**
 * One leg of an offer (origin → destination, possibly several segments).
 * @typedef {Object} Slice
 * @property {string} id slice id
 * @property {Place} origin departure place
 * @property {Place} destination arrival place
 * @property {DateTime} departureAt first departure
 * @property {DateTime} arrivalAt last arrival
 * @property {number} durationMinutes total duration
 * @property {number} stops number of stops
 * @property {Segment[]} segments flights
 * @property {Layover[]} layovers connections between segments
 * @property {string} [fareBrand] brand name for this slice
 * @property {number} dayChange arrival day offset from departure (0, 1, …)
 */

/**
 * One flight.
 * @typedef {Object} Segment
 * @property {string} id segment id
 * @property {Airline} marketingCarrier marketing airline
 * @property {Airline} operatingCarrier operating airline
 * @property {string} flightNumber flight number
 * @property {Aircraft} [aircraft] aircraft
 * @property {Place} origin departure place
 * @property {Place} destination arrival place
 * @property {DateTime} departureAt departure
 * @property {DateTime} arrivalAt arrival
 * @property {number} durationMinutes duration
 * @property {CabinClass} cabin cabin flown
 * @property {string} [bookingClass] RBD
 * @property {string} [fareBasis] fare basis code
 * @property {{ from?: string, to?: string }} [terminals] terminals
 * @property {Amenity[]} [amenities] onboard amenities
 * @property {number} [distanceKm] flown distance
 * @property {number} [onTimePct] on-time performance
 */

/**
 * Connection between two segments.
 * @typedef {Object} Layover
 * @property {Place} airport connection airport
 * @property {number} durationMinutes connection time
 * @property {boolean} overnight overnight connection
 * @property {boolean} selfTransfer passenger must re-check in
 * @property {boolean} airportChange connection changes airport
 */

/**
 * Onboard amenity.
 * @typedef {Object} Amenity
 * @property {'wifi'|'power'|'meal'|'entertainment'|'seat_pitch'|'legroom'|string} type amenity kind
 * @property {string} [value] detail, e.g. seat pitch
 * @property {boolean} [paid] paid amenity
 */

/**
 * Segments issued on one ticket (multi-ticket offers).
 * @typedef {Object} TicketGroup
 * @property {string} id ticket group id
 * @property {string[]} segmentIds segments covered
 * @property {Airline} carrier issuing carrier
 */

/**
 * Pricing per passenger type.
 * @typedef {Object} PaxPrice
 * @property {PaxType} type passenger type
 * @property {number} count passengers of that type
 * @property {PriceBreakdown} unit price per passenger
 */

/**
 * Price breakdown.
 * @typedef {Object} PriceBreakdown
 * @property {Money} total grand total
 * @property {Money} base base fare
 * @property {Money} taxes taxes
 * @property {Money} fees fees / surcharges
 * @property {Money} [discounts] discounts applied
 * @property {Money} [ancillaries] ancillaries total
 * @property {Money} perPax total per passenger
 * @property {{ code: string, label: string, amount: Money }[]} [items] itemised lines
 */

/**
 * Fare conditions summary.
 * @typedef {Object} Conditions
 * @property {boolean|'partial'} refundable refundability
 * @property {boolean} changeable changeability
 * @property {Money} [changePenalty] change fee
 * @property {Money} [cancelPenalty] cancellation fee
 * @property {boolean} [holdAllowed] fare hold allowed
 * @property {DateTime} [voidUntil] free void deadline
 * @property {string[]} [notes] free-text notes
 */

/**
 * Included baggage.
 * @typedef {Object} BaggageAllowance
 * @property {boolean} [bySegment] allowance differs per segment
 * @property {{ paxType: PaxType, segmentId?: string, cabin: BagRule[], checked: BagRule[] }[]} items rules per passenger type (and segment)
 */

/**
 * One baggage rule.
 * @typedef {Object} BagRule
 * @property {number} [quantity] number of pieces
 * @property {number} [weightKg] weight limit
 * @property {string} [dimensionsCm] size limit
 * @property {boolean} included included in the fare
 * @property {Money} [price] price when not included
 */

/**
 * Branded fare.
 * @typedef {Object} FareFamily
 * @property {string} code brand code
 * @property {string} name brand name
 * @property {number} tier ordering tier
 * @property {string} [offerId] offer id of this brand
 * @property {Money} priceDelta difference to the base offer
 * @property {{ code: string, label: string, included: boolean|'fee', detail?: string }[]} features included / paid features
 */

/**
 * Fare rules.
 * @typedef {Object} FareRules
 * @property {Conditions} summary structured summary
 * @property {{ type: 'change'|'cancel'|'no_show', when: string, amount: Money }[]} penalties penalties by case
 * @property {{ title: string, text: string }[]} [raw] raw rule texts
 */

/**
 * Offer with details loaded.
 * @typedef {Offer & { fareRules: FareRules, amenitiesBySegment: Record<string, Amenity[]>, warnings: string[] }} OfferDetails
 */

// filters / facets

/**
 * Departure / arrival time bucket: 00-06, 06-12, 12-18, 18-24 (+ night alias).
 * @typedef {'early_morning'|'morning'|'afternoon'|'evening'|'night'} TimeBucket
 */

/**
 * Client-side filters applied to a result set.
 * @typedef {Object} Filters
 * @property {number[]} [stops] allowed stop counts
 * @property {string[]} [airlines] airline codes
 * @property {string[]} [alliances] alliances
 * @property {{ min?: number, max?: number }} [price] price range
 * @property {Record<number, TimeBucket[]>} [departure] departure buckets, keyed by slice index
 * @property {Record<number, TimeBucket[]>} [arrival] arrival buckets, keyed by slice index
 * @property {number} [durationMax] maximum duration in minutes
 * @property {number} [layoverMin] minimum layover in minutes
 * @property {number} [layoverMax] maximum layover in minutes
 * @property {string[]} [layoverAirports] allowed connection airports
 * @property {string[]} [excludeAirports] excluded airports
 * @property {boolean} [baggageIncluded] checked baggage included
 * @property {boolean} [refundable] refundable only
 * @property {boolean} [selfTransfer] include self-transfer offers
 * @property {string[]} [aircraft] aircraft codes
 * @property {string[]} [flightNumbers] flight numbers
 * @property {CabinClass} [cabinOnly] all segments in this cabin
 */

/**
 * One facet value with its count.
 * @typedef {Object} FacetBucket
 * @property {string|number} value facet value
 * @property {number} count matching offers
 * @property {Money} [minPrice] cheapest offer in the bucket
 * @property {string} [label] display label
 */

/**
 * Facets of the loaded result set.
 * @typedef {Object} Facets
 * @property {FacetBucket[]} stops by stop count
 * @property {FacetBucket[]} airlines by airline
 * @property {FacetBucket[]} alliances by alliance
 * @property {{ min: number, max: number, histogram: number[] }} price price range and histogram
 * @property {{ min: number, max: number }} duration duration range in minutes
 * @property {{ min: number, max: number }} layover layover range in minutes
 * @property {FacetBucket[]} layoverAirports by connection airport
 * @property {Record<number, FacetBucket[]>} departure departure buckets per slice index
 * @property {Record<number, FacetBucket[]>} arrival arrival buckets per slice index
 * @property {FacetBucket[]} aircraft by aircraft
 * @property {{ baggageIncluded: number, refundable: number, selfTransfer: number }} features feature counts
 */

/**
 * Sort order.
 * @typedef {Object} Sort
 * @property {'best'|'price'|'duration'|'departure'|'arrival'|'emissions'} key sort key
 * @property {'asc'|'desc'} [dir] direction
 */

/**
 * Highlights of a result set.
 * @typedef {Object} ResultsSummary
 * @property {Offer} [cheapest] cheapest offer
 * @property {Offer} [fastest] fastest offer
 * @property {Offer} [best] best-ranked offer
 * @property {Offer} [earliest] earliest departure
 * @property {number} count offers in the set
 */

/**
 * Price insight for a route / date.
 * @typedef {Object} PriceInsight
 * @property {'low'|'typical'|'high'} level current price level
 * @property {{ min: Money, max: Money }} typicalRange typical price range
 * @property {'rising'|'falling'|'flat'} trend price trend
 * @property {'buy'|'wait'} [advice] recommendation
 * @property {{ date: DateStr, price: Money }[]} [history] price history
 */

/**
 * Flexible-date grid (rows × cols of prices).
 * @typedef {Object} DateGrid
 * @property {DateStr[]} rows outbound dates
 * @property {DateStr[]} [cols] return dates
 * @property {({ price: Money, offerId?: string } | null)[][]} cells price per cell, `null` = no fare
 */

/**
 * Fare calendar for one month.
 * @typedef {Object} CalendarFares
 * @property {string} month `YYYY-MM`
 * @property {Record<DateStr, { price: Money, level: 'low'|'typical'|'high' }>} days lowest fare per day
 */

/**
 * Explore / "anywhere" result.
 * @typedef {Object} Destination
 * @property {Place} place destination
 * @property {Money} price lowest fare
 * @property {{ out: DateStr, back?: DateStr }} dates dates of that fare
 * @property {string[]} [themes] destination themes
 */

// ── itinerary / travelers / ancillaries ──────────────────────────────────────────────────────────

/**
 * Server-side cart: offers + passengers + travelers + ancillaries, before booking.
 * @typedef {Object} Itinerary
 * @property {string} id itinerary id
 * @property {'active'|'expired'|'booked'|'abandoned'} status lifecycle state
 * @property {Offer[]} offers selected offers (one per slice in split mode)
 * @property {PaxCounts} passengers passenger counts
 * @property {PassengerSlot[]} slots passenger slots to fill
 * @property {PriceBreakdown} price current total
 * @property {SelectedAncillary[]} ancillaries selected ancillaries
 * @property {Promo} [promo] applied promo code
 * @property {{ from: Money, to: Money, acceptedAt?: DateTime }} [priceChange] pending / accepted price change
 * @property {TravelerRequirements} [requirements] traveler data requirements
 * @property {Traveler[]} [travelers] travelers set
 * @property {Contact} [contact] booking contact
 * @property {DateTime} expiresAt itinerary expiry
 * @property {DateTime} createdAt creation time
 * @property {string} [lockId] price lock id
 */

/**
 * A passenger slot of an itinerary.
 * @typedef {Object} PassengerSlot
 * @property {string} id slot id
 * @property {PaxType} type passenger type
 * @property {number} index position among passengers
 * @property {string} [travelerId] traveler assigned to the slot
 */

/**
 * Applied promo code.
 * @typedef {Object} Promo
 * @property {string} code promo code
 * @property {string} label display label
 * @property {Money} discount discount applied
 * @property {string} [conditions] conditions text
 */

/**
 * Traveler data the backend requires for this itinerary.
 * @typedef {Object} TravelerRequirements
 * @property {Record<PaxType, { fields: FieldRule[], documents: DocumentRule[] }>} perType rules per passenger type
 * @property {FieldRule[]} contact contact field rules
 * @property {boolean} apis advance passenger information required
 * @property {boolean} gstAvailable GST invoice details may be captured
 * @property {AgeRules} ageRules age bands
 * @property {{ maxLength: number, charset: 'latin'|'any' }} nameRules name constraints
 */

/**
 * Rule for one traveler / contact field.
 * @typedef {Object} FieldRule
 * @property {string} path field path, e.g. `dob`
 * @property {boolean} required required flag
 * @property {string} [pattern] validation regex
 * @property {string[]} [options] allowed values
 */

/**
 * Rule for travel documents.
 * @typedef {Object} DocumentRule
 * @property {TravelDocument['type'][]} types accepted document types
 * @property {boolean} required required flag
 * @property {number} [minValidityMonths] minimum validity after travel
 */

/**
 * Age bands and passenger limits.
 * @typedef {Object} AgeRules
 * @property {number} infantMax maximum infant age
 * @property {number} childMax maximum child age
 * @property {'departure'|'return'} refDate date the age is computed at
 * @property {number} infantPerAdult infants allowed per adult
 * @property {number} maxPax maximum passengers
 */

/**
 * A traveler (as captured for an itinerary or booking).
 * @typedef {Object} Traveler
 * @property {string} [id] traveler id
 * @property {string} [slotId] passenger slot filled
 * @property {PaxType} type passenger type
 * @property {string} [title] title
 * @property {string} firstName first name
 * @property {string} [middleName] middle name
 * @property {string} lastName last name
 * @property {'M'|'F'|'X'} gender gender
 * @property {DateStr} dob date of birth
 * @property {string} [nationality] ISO-3166 alpha-2
 * @property {TravelDocument[]} [documents] travel documents
 * @property {LoyaltyAccount[]} [loyalty] frequent flyer accounts
 * @property {string} [knownTravelerNumber] KTN / TSA PreCheck
 * @property {string} [redressNumber] redress number
 * @property {string} [mealPref] meal preference code
 * @property {string} [seatPref] seat preference code
 * @property {string[]} [assistance] special assistance codes
 * @property {string} [email] email
 * @property {Phone} [phone] phone
 */

/**
 * Saved traveler profile.
 * @typedef {Traveler & { id: string, isDefault?: boolean, relation?: string, updatedAt: DateTime }} TravelerProfile
 */

/**
 * Travel document.
 * @typedef {Object} TravelDocument
 * @property {string} [id] document id
 * @property {'passport'|'national_id'|'driving_licence'|'other'} type document type
 * @property {string} number document number
 * @property {string} issuingCountry ISO-3166 alpha-2
 * @property {string} [nationality] ISO-3166 alpha-2
 * @property {DateStr} expiry expiry date
 * @property {DateStr} [issueDate] issue date
 */

/**
 * Frequent flyer account.
 * @typedef {Object} LoyaltyAccount
 * @property {string} airline airline code
 * @property {string} [programme] programme name
 * @property {string} number membership number
 */

/**
 * Phone number.
 * @typedef {Object} Phone
 * @property {string} countryCode dial code
 * @property {string} number national number
 */

/**
 * Booking contact.
 * @typedef {Object} Contact
 * @property {string} email email
 * @property {Phone} phone phone
 * @property {{ name: string, phone: Phone }} [emergency] emergency contact
 * @property {Address} [address] postal address
 * @property {{ number: string, company: string, address?: string, email?: string }} [gst] GST invoice details
 */

/**
 * Postal address.
 * @typedef {Object} Address
 * @property {string} line1 line 1
 * @property {string} [line2] line 2
 * @property {string} city city
 * @property {string} [state] state / region
 * @property {string} postalCode postal code
 * @property {string} countryCode ISO-3166 alpha-2
 */

/**
 * Ancillary kind (open set).
 * @typedef {'seat'|'baggage'|'meal'|'insurance'|'protection'|'priority_boarding'|'lounge'|'fast_track'|'wifi'|'carbon_offset'|'bundle'|string} AncillaryType
 */

/**
 * Purchasable service from the ancillary catalogue.
 * @typedef {Object} Service
 * @property {string} id service id
 * @property {AncillaryType} type kind
 * @property {string} [code] supplier code
 * @property {string} label display label
 * @property {string} [description] description
 * @property {Money} price unit price
 * @property {'per_passenger'|'per_passenger_segment'|'per_passenger_slice'|'per_booking'} scope pricing scope
 * @property {number} [maxQuantity] maximum quantity
 * @property {PaxType[]} [eligiblePassengerTypes] eligible passenger types
 * @property {string} [segmentId] segment the service applies to
 * @property {string} [sliceId] slice the service applies to
 * @property {object} [meta] supplier-specific data
 */

/**
 * Ancillary catalogue of an itinerary.
 * @typedef {Object} AncillaryCatalog
 * @property {Service[]} services services on offer
 * @property {string[]} seatMapsAvailable segment ids with a seat map
 * @property {InsuranceQuote[]} [insurance] insurance quotes
 * @property {Protection[]} protections protection products
 * @property {Service[]} [bundles] bundles
 */

/**
 * Ancillary selected on an itinerary.
 * @typedef {Object} SelectedAncillary
 * @property {string} id selection id
 * @property {string} serviceId service selected
 * @property {AncillaryType} type kind
 * @property {string} [passengerId] passenger
 * @property {string} [segmentId] segment
 * @property {string} [sliceId] slice
 * @property {number} quantity quantity
 * @property {Money} price total price of the selection
 * @property {string} [detail] e.g. seat number
 */

/**
 * Seat map of one segment.
 * @typedef {Object} SeatMap
 * @property {string} segmentId segment
 * @property {Aircraft} [aircraft] aircraft
 * @property {{ cabin: CabinClass, deck?: number, columns: string[], rows: SeatRow[] }[]} cabins cabins with their rows
 * @property {{ code: string, label: string }[]} legend characteristic codes
 */

/**
 * One row of a seat map.
 * @typedef {Object} SeatRow
 * @property {number} number row number
 * @property {Seat[]} seats seats in the row
 * @property {boolean} [exitRow] exit row
 * @property {boolean} [wing] over the wing
 */

/**
 * One seat.
 * @typedef {Object} Seat
 * @property {string} number seat number, e.g. `12A`
 * @property {boolean} available available for selection
 * @property {Money} [price] price when paid
 * @property {string[]} characteristics characteristic codes
 * @property {('no_infant'|'adult_only'|'no_child'|string)[]} [restrictions] restrictions
 * @property {string} [selectedBy] passenger id holding the seat
 */

/**
 * Travel insurance quote.
 * @typedef {Object} InsuranceQuote
 * @property {string} id quote id
 * @property {string} provider insurer
 * @property {string} plan plan name
 * @property {Money} price total price
 * @property {Money} perPax price per passenger
 * @property {{ code: string, label: string, amount?: Money }[]} coverage coverage lines
 * @property {string} termsUrl terms URL
 */

/**
 * Protection product.
 * @typedef {Object} Protection
 * @property {string} id product id
 * @property {'price_drop'|'cfar'|'flexible_ticket'|'zero_cancellation'|'disruption_guarantee'|'baggage_protection'|'price_lock'} type product kind
 * @property {string} label display label
 * @property {Money} price price
 * @property {string} terms terms text
 * @property {string} [termsUrl] terms URL
 * @property {number} [refundPct] refund percentage
 * @property {number} [windowHours] window in hours
 */

// ── booking / payment ────────────────────────────────────────────────────────────────────────────

/**
 * Booking lifecycle state.
 * @typedef {'draft'|'pending_payment'|'on_hold'|'processing'|'confirmed'|'ticketed'|'partially_ticketed'|'failed'|'cancelled'|'refunded'|'expired'} BookingStatus
 */

/**
 * A booking (order) after creation.
 * @typedef {Object} Booking
 * @property {string} id booking id
 * @property {string} reference OTA booking reference
 * @property {'flight'|'price_lock'} type booking kind
 * @property {BookingStatus} status lifecycle state
 * @property {string} [pnr] PNR
 * @property {{ airline: string, locator: string }[]} airlineLocators airline record locators
 * @property {{ passengerId: string, number: string, segmentIds: string[] }[]} tickets issued tickets
 * @property {Itinerary} itinerary booked itinerary
 * @property {Traveler[]} travelers travelers
 * @property {Contact} contact contact
 * @property {PaymentSummary} payment payment summary
 * @property {DateTime} [holdExpiresAt] hold expiry
 * @property {DateTime} [voidUntil] free void deadline
 * @property {DateTime} createdAt creation time
 * @property {Document[]} documents documents
 * @property {TripAction[]} availableActions self-service actions allowed
 * @property {BookingFailure} [failure] failure details
 * @property {Protection[]} protections protections purchased
 * @property {object} [metadata] host metadata
 */

/**
 * Why a booking failed and what to do next.
 * @typedef {Object} BookingFailure
 * @property {string} code error code
 * @property {string} message message
 * @property {boolean} recoverable recoverable flag
 * @property {'retry_payment'|'search_again'|'contact_support'|'wait'} suggestedAction next step
 */

/**
 * Payment summary of a booking.
 * @typedef {Object} PaymentSummary
 * @property {Money} total total
 * @property {Money} paid paid so far
 * @property {Money} due outstanding
 * @property {DateTime} [dueBy] payment deadline
 * @property {{ type: string, last4?: string, amount: Money }[]} methods methods used
 */

/**
 * Booking document (e-ticket, invoice, …).
 * @typedef {Object} Document
 * @property {'eticket'|'invoice'|'gst_invoice'|'receipt'|'insurance_policy'|'visa_letter'|string} type document kind
 * @property {string} label display label
 * @property {string} [url] download URL
 * @property {boolean} available ready to download
 */

/**
 * Paid hold option.
 * @typedef {Object} HoldOption
 * @property {string} id option id
 * @property {string} label display label
 * @property {Money} fee hold fee
 * @property {DateTime} holdUntil hold deadline
 * @property {boolean} refundableFee fee refunded on purchase
 * @property {'drop'|'charge'|'convert_to_paid'} onExpiry what happens when the hold expires
 */

/**
 * Price lock option.
 * @typedef {Object} PriceLockOption
 * @property {string} id option id
 * @property {number} durationHours lock duration
 * @property {Money} fee lock fee
 * @property {Money} [capAmount] maximum covered increase
 * @property {string} terms terms text
 */

/**
 * Payment method kind.
 * @typedef {'card'|'upi'|'netbanking'|'wallet'|'apple_pay'|'google_pay'|'paypal'|'bnpl'|'emi'|'bank_transfer'|'pay_later'|'loyalty_points'|'gift_card'|'ota_wallet'|'voucher'} PaymentMethodType
 */

/**
 * Payment method available for a booking.
 * @typedef {Object} PaymentMethod
 * @property {string} id method id
 * @property {PaymentMethodType} type kind
 * @property {string} label display label
 * @property {string} gateway gateway name
 * @property {Money} [fee] fixed surcharge
 * @property {number} [feePct] percentage surcharge
 * @property {boolean} supportsSave can be saved
 * @property {string} [currency] charging currency
 * @property {{ banks?: { code: string, name: string }[], wallets?: string[], emiPlans?: EmiPlan[], minAmount?: Money, maxAmount?: Money }} [options] method options
 * @property {SavedMethod[]} [saved] saved instruments
 * @property {boolean} available availability
 * @property {string} [unavailableReason] why unavailable
 */

/**
 * Saved payment instrument.
 * @typedef {Object} SavedMethod
 * @property {string} id instrument id
 * @property {PaymentMethodType} type kind
 * @property {string} [brand] card brand
 * @property {string} [last4] last four digits
 * @property {string} [expiry] `MM/YY`
 * @property {string} label display label
 * @property {boolean} isDefault default instrument
 * @property {string} [gatewayToken] gateway token
 */

/**
 * EMI plan.
 * @typedef {Object} EmiPlan
 * @property {string} id plan id
 * @property {string} bank bank
 * @property {number} months tenure
 * @property {number} interestPct interest rate
 * @property {Money} monthly monthly instalment
 * @property {Money} total total payable
 */

/**
 * Payable amount for a chosen method.
 * @typedef {Object} PaymentQuote
 * @property {Money} payable amount to pay
 * @property {Money} fees surcharges
 * @property {{ type: PaymentMethodType, amount: Money, ref?: string }[]} credits credits applied
 * @property {{ from: Money, rate: number }} [fx] currency conversion
 * @property {DateTime} expiresAt quote expiry
 */

/**
 * Server-side payment intent.
 * @typedef {Object} PaymentIntent
 * @property {string} id intent id
 * @property {string} bookingId booking paid
 * @property {'requires_method'|'requires_confirmation'|'requires_action'|'processing'|'succeeded'|'failed'|'cancelled'} status lifecycle state
 * @property {Money} amount amount
 * @property {{ type: PaymentMethodType, gateway: string, savedMethodId?: string }} [method] chosen method
 * @property {string} [clientSecret] gateway client secret
 * @property {PaymentAction} [action] action required
 * @property {{ code: string, message: string, retryable: boolean }} [failure] failure details
 * @property {{ type: PaymentMethodType, amount: Money, status: string }[]} [splits] split payments
 * @property {string} [returnUrl] redirect return URL
 * @property {DateTime} createdAt creation time
 * @property {DateTime} [expiresAt] expiry
 */

/**
 * Customer action required to complete a payment.
 * @typedef {Object} PaymentAction
 * @property {'redirect'|'iframe'|'upi_collect'|'upi_intent'|'otp'|'poll'|'native_sdk'} type action kind
 * @property {string} [url] redirect / iframe URL
 * @property {string} [html] iframe HTML
 * @property {string} [qr] UPI QR payload
 * @property {string} [deepLink] UPI intent deep link
 * @property {DateTime} [expiresAt] action expiry
 * @property {object} [params] gateway parameters
 */

/**
 * Payment gateway adapter (Stripe, PayPal, Razorpay, …).
 * @typedef {Object} GatewayAdapter
 * @property {string} name gateway name
 * @property {(opts: object) => Promise<void>} load load the vendor script
 * @property {(container: HTMLElement, opts: object) => Promise<GatewayElement>} [mount] mount hosted fields
 * @property {(el: GatewayElement, billing?: Address) => Promise<{ token: string, brand?: string, last4?: string }>} [tokenize] tokenize the instrument
 * @property {(intent: PaymentIntent, el?: GatewayElement) => Promise<{ status: string, payload?: object }>} [confirm] confirm with the gateway
 * @property {(action: PaymentAction, host: HTMLElement) => Promise<{ status: string, payload?: object }>} [handleAction] drive a gateway action
 * @property {(el: GatewayElement) => void} [unmount] unmount hosted fields
 */

/**
 * Mounted gateway element.
 * @typedef {Object} GatewayElement
 * @property {HTMLElement} el host element
 * @property {() => boolean} isComplete input complete
 * @property {(evt: 'change'|'ready'|'error', fn: Function) => () => void} on subscribe; returns off
 */

/**
 * Stored-value credits applied to a payment (`payments.credits.apply`, docs/api/07-booking.md §2).
 * @typedef {Object} PaymentCreditsInput
 * @property {Money|'max'} [wallet] wallet amount
 * @property {number|'max'} [points] loyalty points
 * @property {string} [giftCardCode] gift card code
 * @property {string} [voucherId] voucher id
 */

/**
 * Parameters of `payments.quote` (docs/api/07-booking.md §2).
 * @typedef {Object} PaymentQuoteParams
 * @property {PaymentMethodType} method method
 * @property {string} [savedMethodId] saved instrument
 * @property {PaymentCreditsInput} [credits] credits to apply
 * @property {string} [emiPlanId] EMI plan
 * @property {string} [currency] charging currency
 */

/**
 * Parameters of `payments.createIntent` (docs/api/07-booking.md §2).
 * @typedef {Object} CreateIntentParams
 * @property {PaymentMethodType} method method
 * @property {string} [gateway] gateway name
 * @property {string} [savedMethodId] saved instrument
 * @property {boolean} [saveMethod] save the instrument
 * @property {string} [emiPlanId] EMI plan
 * @property {Address} [billingAddress] billing address
 * @property {string} [returnUrl] redirect return URL
 * @property {string} [currency] charging currency
 * @property {object} [metadata] host metadata
 */

/**
 * Parameters of `payments.confirm` (docs/api/07-booking.md §2).
 * @typedef {Object} ConfirmParams
 * @property {string} [token] gateway token
 * @property {GatewayElement} [element] mounted element
 * @property {string} [vpa] UPI VPA
 * @property {string} [bankCode] net-banking bank
 * @property {string} [walletProvider] wallet provider
 * @property {'collect'|'intent'} [upiFlow] UPI flow
 * @property {object} [deviceData] device data
 * @property {boolean} [consent] consent given
 */

/**
 * UI hooks of `payments.pay` / `payments.handleAction`.
 * @typedef {Object} PaymentUiOptions
 * @property {HTMLElement} [container] host for iframe / QR
 * @property {(url: string) => boolean} [onRedirect] return `false` to suppress the navigation
 */

/**
 * Result of `payments.pay` / `payments.retry`.
 * @typedef {Object} PaymentResult
 * @property {PaymentIntent} intent final intent
 * @property {Booking} booking booking after ticketing
 */

/**
 * Port implemented by the isolated payments package (`@wayfarer/sdk/payments`); domain modules depend on
 * nothing else from it. Member signatures follow docs/api/07-booking.md §2; `bookingId` / `intentId`
 * default to the current booking / intent when `undefined`.
 * @typedef {Object} PaymentsPort
 * @property {(bookingId?: string, options?: { fresh?: boolean }, opts?: RequestOpts) => Promise<PaymentMethod[]>} methods available methods
 * @property {(bookingId: string|undefined, params: PaymentQuoteParams, opts?: RequestOpts) => Promise<PaymentQuote>} quote payable for a method
 * @property {{ apply: (bookingId: string|undefined, credits: PaymentCreditsInput, opts?: RequestOpts) => Promise<PaymentQuote>, remove: (bookingId: string|undefined, type: PaymentMethodType, opts?: RequestOpts) => Promise<PaymentQuote>, applied: () => PaymentQuote['credits'] }} credits stored-value credits
 * @property {(bookingId?: string, params?: { bin?: string, bank?: string }, opts?: RequestOpts) => Promise<EmiPlan[]>} emiPlans EMI plans
 * @property {(bookingId: string|undefined, params: CreateIntentParams, opts?: RequestOpts) => Promise<PaymentIntent>} createIntent create the intent
 * @property {(intent: PaymentIntent, container: HTMLElement, options?: { style?: object, fields?: object }) => Promise<GatewayElement>} mount mount hosted fields
 * @property {(element: GatewayElement, billing?: Address) => Promise<{ token: string, brand?: string, last4?: string }>} tokenize tokenize the instrument
 * @property {(intentId?: string, params?: ConfirmParams, opts?: RequestOpts) => Promise<PaymentIntent>} confirm submit the instrument
 * @property {(intent?: PaymentIntent, ui?: PaymentUiOptions) => Promise<PaymentIntent>} handleAction drive 3-DS / UPI / redirect
 * @property {(intentId?: string, options?: { timeoutMs?: number }, opts?: RequestOpts) => Promise<PaymentIntent>} waitForResult poll until terminal
 * @property {(bookingId: string|undefined, params: CreateIntentParams & ConfirmParams, ui?: PaymentUiOptions) => Promise<PaymentResult>} pay full pipeline
 * @property {(options?: { url?: string }, opts?: RequestOpts) => Promise<(PaymentResult & { state?: object }) | null>} resumeAfterRedirect resume after a redirect
 * @property {(intentId?: string, opts?: RequestOpts) => Promise<PaymentIntent>} cancel abort an intent
 * @property {(bookingId: string|undefined, params: CreateIntentParams & ConfirmParams, ui?: PaymentUiOptions) => Promise<PaymentResult>} retry new intent after failure
 * @property {() => PaymentIntent|null} intent current intent
 * @property {() => PaymentIntent['status']|null} status current intent status
 * @property {{ list: (options?: { fresh?: boolean }, opts?: RequestOpts) => Promise<SavedMethod[]>, remove: (id: string, opts?: RequestOpts) => Promise<void>, setDefault: (id: string, opts?: RequestOpts) => Promise<void> }} savedMethods saved instruments
 * @property {(bookingId?: string, opts?: RequestOpts) => Promise<Document>} receipt receipt document
 * @property {(bookingId?: string, opts?: RequestOpts) => Promise<Refund[]>} refunds refunds of a booking
 * @property {{ register: (adapter: GatewayAdapter) => void, get: (name: string) => GatewayAdapter, list: () => string[] }} gateways adapter registry
 * @property {() => void} clear reset payment state
 */

/**
 * RFC 9457 problem document as returned by the backend (extension members: `code`, `errors`,
 * `requestId`; Amadeus-style `errors[]` issues carry `source.pointer` / `source.parameter`).
 * @typedef {{
 *   type: string,
 *   title: string,
 *   status: number,
 *   detail?: string,
 *   instance?: string,
 *   code?: string,
 *   requestId?: string,
 *   errors?: { code?: string|number, title?: string, detail?: string, source?: { pointer?: string, parameter?: string, example?: string } }[],
 *   [ext: string]: unknown
 * }} Problem
 */

/**
 * Refund of a booking.
 * @typedef {Object} Refund
 * @property {string} id refund id
 * @property {string} bookingId booking refunded
 * @property {Money} amount amount
 * @property {string} method refund method
 * @property {'requested'|'processing'|'completed'|'failed'} status lifecycle state
 * @property {DateTime} [eta] expected completion
 * @property {DateTime} updatedAt last update
 */

// ── trips / servicing ────────────────────────────────────────────────────────────────────────────

/**
 * Post-booking self-service action (gated per booking by `availableActions`).
 * @typedef {'change'|'cancel'|'cancel_partial'|'add_seats'|'add_bags'|'add_meals'|'check_in'|'name_correction'|'special_assistance'|'update_contact'|'update_documents'|'split_pnr'|'download_eticket'|'invoice'|'gst_invoice'|'resend'|'pay_now'|'void'|'rebook'|'support'} TripAction
 */

/**
 * Post-purchase view of a booking.
 * @typedef {Booking & { phase: Phase, nextSegment?: Segment, flightStatuses?: FlightStatus[], checkIn?: CheckInInfo, disruptions?: Disruption[] }} Trip
 */

/**
 * Live status of one flight.
 * @typedef {Object} FlightStatus
 * @property {string} segmentId segment
 * @property {'scheduled'|'on_time'|'delayed'|'departed'|'landed'|'cancelled'|'diverted'} status status
 * @property {DateTime} [estimatedDeparture] estimated departure
 * @property {DateTime} [estimatedArrival] estimated arrival
 * @property {string} [gate] gate
 * @property {string} [terminal] terminal
 * @property {string} [baggageBelt] baggage belt
 * @property {number} [delayMinutes] delay
 */

/**
 * Check-in windows per segment.
 * @typedef {Object} CheckInInfo
 * @property {{ segmentId: string, opensAt: DateTime, closesAt: DateTime, url?: string, status: 'not_open'|'open'|'closed'|'done' }[]} perSegment per segment window and link
 */

/**
 * What can be changed on a booking.
 * @typedef {Object} ChangeOptions
 * @property {boolean} changeable any change allowed
 * @property {{ sliceId: string, changeable: boolean, penalty?: Money, deadline?: DateTime }[]} slices per slice
 * @property {{ passengerId: string, changeable: boolean }[]} passengers per passenger
 * @property {string[]} notes notes
 */

/**
 * Quote for changing a booking.
 * @typedef {Object} ChangeQuote
 * @property {string} id quote id
 * @property {string} bookingId booking
 * @property {Offer} newOffer replacement offer
 * @property {Money} fareDifference fare difference
 * @property {Money} penalty change penalty
 * @property {Money} total total to pay
 * @property {Money} [refundDue] refund when cheaper
 * @property {DateTime} expiresAt quote expiry
 */

/**
 * Quote for cancelling (part of) a booking.
 * @typedef {Object} CancelQuote
 * @property {string} id quote id
 * @property {string} bookingId booking
 * @property {{ passengerIds?: string[], sliceIds?: string[] }} scope what is cancelled
 * @property {Money} refund refund amount
 * @property {Money} penalty cancellation penalty
 * @property {Money} nonRefundable non-refundable part
 * @property {Money} [protectionCover] covered by protection
 * @property {('original'|'wallet'|'voucher')[]} refundMethods refund destinations offered
 * @property {string} [eta] refund ETA text
 * @property {boolean} voidEligible free void possible
 * @property {DateTime} expiresAt quote expiry
 */

/**
 * Cancellation in progress / done.
 * @typedef {Object} Cancellation
 * @property {string} id cancellation id
 * @property {string} bookingId booking
 * @property {'processing'|'cancelled'|'failed'} status status
 * @property {Refund} [refund] refund
 */

/**
 * Schedule change / cancellation needing a response.
 * @typedef {Object} Disruption
 * @property {string} id disruption id
 * @property {'schedule_change'|'cancellation'|'reaccommodation'} type kind
 * @property {string[]} segmentIds affected segments
 * @property {string} summary summary text
 * @property {{ id: string, type: 'accept'|'alternative'|'refund'|'voucher', offer?: Offer, refund?: Money }[]} options responses offered
 * @property {DateTime} [respondBy] response deadline
 * @property {'open'|'responded'} status status
 */

/**
 * Servicing request raised on a booking.
 * @typedef {Object} ServiceRequest
 * @property {string} id request id
 * @property {string} bookingId booking
 * @property {string} type request type
 * @property {'submitted'|'in_progress'|'done'|'rejected'} status status
 * @property {DateTime} createdAt creation time
 * @property {string} [note] note
 */

// ── account / wallet / alerts ────────────────────────────────────────────────────────────────────

/**
 * Account holder.
 * @typedef {Object} User
 * @property {string} id user id
 * @property {string} [email] email
 * @property {Phone} [phone] phone
 * @property {string} [firstName] first name
 * @property {string} [lastName] last name
 * @property {{ email: boolean, phone: boolean }} verified verification state
 * @property {string[]} providers linked identity providers
 * @property {DateTime} createdAt creation time
 * @property {string} [tier] loyalty tier
 */

/**
 * Account preferences.
 * @typedef {Object} Preferences
 * @property {string} locale locale
 * @property {string} currency currency
 * @property {IATA} [homeAirport] home airport
 * @property {string} [seatPref] seat preference
 * @property {string} [mealPref] meal preference
 * @property {boolean} [hour12] 12-hour clock
 * @property {{ email: boolean, sms: boolean, push: boolean, whatsapp?: boolean, marketing: boolean }} notifications notification channels
 */

/**
 * Wallet balance.
 * @typedef {Object} WalletBalance
 * @property {Money} cash cash balance
 * @property {Money} promo promotional balance
 * @property {{ amount: Money, at: DateTime }[]} expiring amounts about to expire
 */

/**
 * Loyalty status.
 * @typedef {Object} LoyaltyStatus
 * @property {string} tier tier name
 * @property {number} points points balance
 * @property {Money} pointsValue cash value of the points
 * @property {{ name: string, pointsNeeded: number }} [nextTier] next tier
 * @property {string[]} benefits benefits
 */

/**
 * Coupon.
 * @typedef {Object} Coupon
 * @property {string} code coupon code
 * @property {string} label display label
 * @property {string} discount discount text
 * @property {DateTime} [validUntil] validity
 * @property {string} [conditions] conditions text
 * @property {boolean} [applicable] applicable to the current itinerary
 * @property {string} [reason] why not applicable
 */

/**
 * Voucher.
 * @typedef {Object} Voucher
 * @property {string} id voucher id
 * @property {string} code voucher code
 * @property {Money} amount face value
 * @property {Money} remaining remaining value
 * @property {DateTime} expiresAt expiry
 * @property {string} source origin, e.g. refund
 * @property {string} [restrictions] restrictions text
 */

/**
 * Price alert.
 * @typedef {Object} PriceAlert
 * @property {string} id alert id
 * @property {SearchParams | { origin: IATA, destination: IATA, dateRange: { from: DateStr, to: DateStr } }} params watched search or route
 * @property {Money} [targetPrice] target price
 * @property {Money} [lastPrice] last seen price
 * @property {Money} [lowestPrice] lowest seen price
 * @property {('email'|'push'|'sms')[]} channels notification channels
 * @property {'instant'|'daily'|'weekly'} frequency notification frequency
 * @property {boolean} active active flag
 * @property {DateTime} createdAt creation time
 */

/**
 * Saved search.
 * @typedef {Object} SavedSearch
 * @property {string} id saved search id
 * @property {string} [name] display name
 * @property {SearchParams} params search parameters
 * @property {DateTime} createdAt creation time
 */

/**
 * Support ticket.
 * @typedef {Object} Ticket
 * @property {string} id ticket id
 * @property {string} subject subject
 * @property {string} category category
 * @property {'open'|'pending'|'resolved'|'closed'} status status
 * @property {string} [bookingId] related booking
 * @property {{ id: string, from: 'user'|'agent', text: string, at: DateTime, attachments?: string[] }[]} messages conversation
 * @property {DateTime} updatedAt last update
 */

// ── client ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Access level of a public function: `'guest'` silently ensures a guest session, `'auth'` rejects with
 * `AuthError{reason:'unauthenticated'}` before any network call.
 * @typedef {'open'|'guest'|'auth'} AccessLevel
 */

/**
 * Access policy resolved per function key (`'search.*'`, `'booking.create'`, `'trips.*'`, …).
 * @typedef {Object} AccessPolicy
 * @property {AccessLevel} [default] level for keys without a rule
 * @property {Record<string, AccessLevel>} [rules] exact key or `module.*` rules
 */

/**
 * Endpoint key, e.g. `'search.create'`, `'booking.create'` (see core/endpoints.js).
 * @typedef {string} EndpointKey
 */

/**
 * Client configuration accepted by `createClient`. Defaults are in docs/api/01-core.md §2.
 * @typedef {Object} ClientConfig
 * @property {string} [baseUrl] default `https://api.ota.com` (paths carry their own version prefix)
 * @property {Partial<Record<EndpointKey, string>>} [endpoints] override any path template
 * @property {AccessPolicy} [access] which functions need auth / guest / nothing
 * @property {'problem+json'|'envelope'} [errorFormat] default `problem+json` (RFC 9457)
 * @property {string} [apiKey] public partner identifier
 * @property {string} [clientId] public app identifier
 * @property {string} [locale] initial locale
 * @property {string} [currency] initial currency
 * @property {string} [market] initial market
 * @property {typeof fetch} [fetch] fetch implementation
 * @property {number} [timeoutMs] default request timeout
 * @property {number} [retries] default retry count
 * @property {{ strategy: 'bearer'|'cookie', refreshPath?: string, tokenStorage?: 'memory'|'session'|'local', autoRefreshSkewMs?: number, guest?: boolean }} [auth] auth model
 * @property {'memory'|'local'|'session'|StorageAdapter} [storage] storage driver
 * @property {string} [storageNamespace] storage key prefix
 * @property {{ drafts?: boolean }} [persist] PII drafts opt-in
 * @property {{ request?: Interceptor[], response?: Interceptor[], error?: Interceptor[] }} [interceptors] extra interceptors
 * @property {Partial<Record<HookName, HookFn>>} [hooks] observe-only lifecycle hooks
 * @property {{ mode: 'poll'|'single'|'stream', pollIntervalMs?: number, maxPollMs?: number, resultMode?: 'combined'|'per_slice'|'auto' }} [search] search transport; `resultMode` defaults to `per_slice` (split, docs/QUESTIONS.md decision 5)
 * @property {PaymentsPort} [payments] from `@wayfarer/sdk/payments`: `createPayments({ gateways: [stripe(), paypal(), razorpay()], returnUrl })`
 * @property {{ adapters?: TelemetryAdapter[], enabled?: boolean, sampleRate?: number }} [telemetry] telemetry fan-out
 * @property {Record<string, boolean|string>} [features] initial feature flags
 * @property {{ messages?: object, fallback?: string }} [i18n] message bundles
 * @property {{ level: 'silent'|'error'|'warn'|'info'|'debug', sink?: Function, redact?: string[] }} [logger] logging
 * @property {boolean} [autoBootstrap] fetch `GET /config` on create
 * @property {Plugin[]} [plugins] plugins to install
 * @property {boolean} [devtools] store devtools
 */

/**
 * Client plugin; `install` may return an uninstall function run on `client.destroy()`.
 * @typedef {Object} Plugin
 * @property {string} name plugin name
 * @property {(client: OtaClient) => void | (() => void)} install install hook
 */

/**
 * Names of the observe-only lifecycle hooks (`ClientConfig.hooks`, `http.hooks.on`).
 * @typedef {'beforeRequest'|'afterResponse'|'onRetry'|'onError'|'onAbort'|'onTimeout'|'onAuthExpired'|'onTokenRefreshed'|'onStateChange'} HookName
 */

// ── referenced by 00-types.md, defined by sibling scripts ────────────────────────────────────────

/**
 * Base error class of the SDK (docs/api/02-state-events-errors.md §3); every rejection is a subclass.
 * @typedef {import('./errors/index.js').SdkError} SdkError
 */

/**
 * The client returned by `createClient` (docs/api/01-core.md §1).
 * @typedef {ReturnType<typeof import('./core/client.js').createClient>} OtaClient
 */

/**
 * Request specification run through the HTTP lifecycle (docs/api/01-core.md §3).
 * @typedef {RequestOpts & { method: string, path?: string, url?: string, body?: unknown }} RequestSpec
 */

/**
 * Resolved HTTP response (docs/api/01-core.md §3).
 * @template T
 * @typedef {Object} HttpResponse
 * @property {T} data parsed body
 * @property {number} status HTTP status
 * @property {Headers} headers response headers
 * @property {string} [requestId] correlation id
 * @property {boolean} fromCache served from cache
 * @property {number} attempts attempts made
 * @property {number} durationMs wall time
 */

/**
 * Lifecycle context passed to interceptors and hooks (docs/api/01-core.md §3.1).
 * @typedef {Object} HttpContext
 * @property {string} id request id
 * @property {RequestSpec} spec request spec (mutable in request interceptors)
 * @property {number} attempt attempt number, 1-based
 * @property {number} startedAt start time (ms)
 * @property {string} [tag] request tag
 * @property {Map<string, unknown>} meta cross-stage data
 * @property {Request} [request] fetch Request once built
 * @property {Response} [response] fetch Response once received
 * @property {unknown} [data] parsed body
 * @property {unknown} [error] current error
 * @property {(name: string, value: string) => void} setHeader set a request header
 * @property {(name: string, value: unknown) => void} setQuery set a query parameter
 * @property {(options?: { delayMs?: number, spec?: RequestSpec }) => Promise<HttpResponse<unknown>>} retry re-enter at the cache/dedupe stage (counts an attempt)
 * @property {(reason?: unknown) => void} abort abort the request
 * @property {AbortSignal} signal combined abort signal
 * @property {{ getToken: () => string|null, refresh: () => Promise<unknown> }} [auth] injected by `authInterceptor`
 */

/**
 * Request interceptor: may mutate / replace the spec, or return an `HttpResponse` to short-circuit.
 * @typedef {(spec: RequestSpec, ctx: HttpContext) => RequestSpec | HttpResponse<unknown> | void | Promise<RequestSpec | HttpResponse<unknown> | void>} RequestInterceptor
 */

/**
 * Response interceptor: may replace the response; throw to turn a 2xx into an error.
 * @typedef {(response: HttpResponse<unknown>, ctx: HttpContext) => HttpResponse<unknown> | void | Promise<HttpResponse<unknown> | void>} ResponseInterceptor
 */

/**
 * Error interceptor: return a response to recover (after `await ctx.retry()`), return / throw an error
 * to replace it.
 * @typedef {(error: SdkError, ctx: HttpContext) => HttpResponse<unknown> | Error | void | Promise<HttpResponse<unknown> | Error | void>} ErrorInterceptor
 */

/**
 * Any interceptor (docs/api/01-core.md §3); the stage decides which form is called.
 * @typedef {RequestInterceptor | ResponseInterceptor | ErrorInterceptor} Interceptor
 */

/**
 * Observe-only lifecycle hook (docs/api/01-core.md §3): `beforeRequest(ctx)`, `afterResponse(ctx)`,
 * `onRetry(ctx, delayMs)`, `onError(ctx)`, `onAbort(ctx)`, `onTimeout(ctx)`, `onAuthExpired()`,
 * `onTokenRefreshed(tokens)`, `onStateChange(change)`. Exceptions are swallowed and logged.
 * @typedef {(...args: any[]) => void} HookFn
 */

/**
 * Custom storage driver (docs/api/02-state-events-errors.md §4).
 * @typedef {Object} StorageAdapter
 * @property {string} name driver name
 * @property {(key: string) => string | null | undefined} getItem read a raw value
 * @property {(key: string, value: string) => void} setItem write a raw value
 * @property {(key: string) => void} removeItem delete a key
 * @property {() => string[]} [keys] list keys
 */

/**
 * Telemetry sink (docs/api/03-utils.md §10).
 * @typedef {Object} TelemetryAdapter
 * @property {string} name adapter name
 * @property {(event: string, props?: Record<string, unknown>) => void} track track an event
 * @property {(name: string, props?: Record<string, unknown>) => void} [page] page view
 * @property {(userId: string, traits?: Record<string, unknown>) => void} [identify] identify the user
 * @property {() => void | Promise<void>} [flush] flush buffered events
 */

export {};
