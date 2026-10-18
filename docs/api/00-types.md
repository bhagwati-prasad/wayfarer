# 00 · Types

TypeScript‑style notation; the SDK ships these as `.d.ts`. Optional = `?`. All ids are opaque strings.

```ts
// ── scalars ───────────────────────────────────────────────────────────────
type Money      = { amount: string; currency: string }         // "1234.56", ISO‑4217
type DateStr    = string                                        // YYYY-MM-DD (local date)
type DateTime   = string                                        // ISO‑8601 with offset, e.g. 2026-11-02T06:45:00+05:30
type IATA       = string                                        // airport/city/metro code
type PaxType    = 'ADT'|'CHD'|'INF'|'INS'|'YTH'|'SRC'|'STU'    // INF lap infant, INS seated infant
type CabinClass = 'economy'|'premium_economy'|'business'|'first'
type TripType   = 'one_way'|'round_trip'|'multi_city'
type FareType   = 'regular'|'student'|'senior'|'armed_forces'|'doctor'|'corporate'|'youth'
type Phase      = 'upcoming'|'past'|'cancelled'

// ── request plumbing ──────────────────────────────────────────────────────
interface RequestOpts {
  signal?: AbortSignal; timeoutMs?: number; retries?: number; retryOn?: (err: SdkError, attempt: number, ctx?: HttpContext) => boolean;
  headers?: Record<string,string>; query?: Record<string,unknown>;
  idempotencyKey?: string | true;            // true = derive from payload
  cache?: false | { ttlMs: number; key?: string }; dedupe?: boolean;
  tag?: string;                              // for http.abort(tag)
  auth?: boolean | 'optional';               // false = never attach credentials
  responseType?: 'json'|'blob'|'text'|'stream';
  meta?: Record<string,unknown>;             // free‑form, visible to interceptors/hooks
}
interface Page<T> { items: T[]; cursor?: string; total?: number; hasMore: boolean }
interface ValidationIssue { path: string; code: string; message: string; params?: object }
interface ValidationResult { valid: boolean; issues: ValidationIssue[] }

// ── reference data ────────────────────────────────────────────────────────
interface Place { code: IATA; type: 'airport'|'city'|'metro'; name: string; city: string; cityCode?: IATA;
  country: string; countryCode: string; tz: string; lat?: number; lng?: number; airports?: Place[]; distanceKm?: number }
interface Airline  { code: string; name: string; logoUrl?: string; alliance?: string; lowCost?: boolean }
interface Aircraft { code: string; name: string }
interface Country  { code: string; name: string; dialCode: string; currency: string; flag?: string }
interface Currency { code: string; name: string; symbol: string; decimals: number }

// ── search ────────────────────────────────────────────────────────────────
interface PaxCounts { adults: number; children: number; infants: number; infantsSeated?: number;
  youth?: number; seniors?: number; childAges?: number[] }
interface SliceRequest { origin: IATA; destination: IATA; date: DateStr; flexDays?: 0|1|2|3;
  timeWindow?: { from?: string; to?: string } }                 // HH:mm local
interface SearchParams {
  tripType: TripType; slices: SliceRequest[]; passengers: PaxCounts; cabin: CabinClass;
  fareTypes?: FareType[]; directOnly?: boolean; maxStops?: 0|1|2; includeNearby?: boolean;
  airlines?: { include?: string[]; exclude?: string[] }; alliances?: string[];
  refundableOnly?: boolean; baggageIncluded?: boolean; allowSelfTransfer?: boolean; allowMixedCabin?: boolean;
  maxDurationMinutes?: number; currency?: string; resultMode?: 'per_slice'|'combined';   // default per_slice (split)
  context?: { bookingId?: string; sliceIds?: string[] }      // reshop for a change
}
interface SearchSession {
  id: string; status: 'pending'|'streaming'|'complete'|'expired'|'error'|'cancelled';
  params: SearchParams; resultMode: 'combined'|'per_slice';
  offers: Offer[];                 // combined mode
  sliceOffers?: SliceOffer[][];    // per_slice mode: one array per slice
  facets: Facets; summary: ResultsSummary; insights?: PriceInsight;
  meta: { total: number; currency: string; expiresAt: DateTime; providersPending: number; cursor?: string }
}
interface Offer {
  id: string; owner: Airline; slices: Slice[]; price: PriceBreakdown; passengers: PaxPrice[];
  fareFamily?: FareFamily; baggage: BaggageAllowance; conditions: Conditions;
  tags: ('cheapest'|'fastest'|'best'|'earliest'|'recommended'|string)[]; expiresAt: DateTime;
  tickets?: TicketGroup[];         // >1 = multi‑ticket / virtual interlining
  selfTransfer?: boolean; seatsLeft?: number; emissionsKg?: number; source?: string;
  hold?: HoldPolicy;               // backend‑decided per flight: free / paid / none
  lastTicketingDate?: DateStr; validatingAirlines?: string[]; oneWayCombinable?: boolean;
  raw?: unknown                    // untouched wire payload (e.g. Amadeus FlightOffer)
}
interface HoldPolicy { allowed: boolean; freeUntil?: DateTime; options: HoldOption[]; note?: string }
interface SliceOffer extends Offer { sliceIndex: number; combinableWith?: string[] }
interface Slice { id: string; origin: Place; destination: Place; departureAt: DateTime; arrivalAt: DateTime;
  durationMinutes: number; stops: number; segments: Segment[]; layovers: Layover[]; fareBrand?: string; dayChange: number }
interface Segment { id: string; marketingCarrier: Airline; operatingCarrier: Airline; flightNumber: string;
  aircraft?: Aircraft; origin: Place; destination: Place; departureAt: DateTime; arrivalAt: DateTime;
  durationMinutes: number; cabin: CabinClass; bookingClass?: string; fareBasis?: string;
  terminals?: { from?: string; to?: string }; amenities?: Amenity[]; distanceKm?: number; onTimePct?: number }
interface Layover { airport: Place; durationMinutes: number; overnight: boolean; selfTransfer: boolean; airportChange: boolean }
interface Amenity { type: 'wifi'|'power'|'meal'|'entertainment'|'seat_pitch'|'legroom'|string; value?: string; paid?: boolean }
interface TicketGroup { id: string; segmentIds: string[]; carrier: Airline }
interface PaxPrice { type: PaxType; count: number; unit: PriceBreakdown }
interface PriceBreakdown { total: Money; base: Money; taxes: Money; fees: Money; discounts?: Money;
  ancillaries?: Money; perPax: Money; items?: { code: string; label: string; amount: Money }[] }
interface Conditions { refundable: boolean|'partial'; changeable: boolean; changePenalty?: Money; cancelPenalty?: Money;
  holdAllowed?: boolean; voidUntil?: DateTime; notes?: string[] }
interface BaggageAllowance { bySegment?: boolean; items: { paxType: PaxType; segmentId?: string;
  cabin: BagRule[]; checked: BagRule[] }[] }
interface BagRule { quantity?: number; weightKg?: number; dimensionsCm?: string; included: boolean; price?: Money }
interface FareFamily { code: string; name: string; tier: number; offerId?: string; priceDelta: Money;
  features: { code: string; label: string; included: boolean|'fee'; detail?: string }[] }
interface FareRules { summary: Conditions; penalties: { type: 'change'|'cancel'|'no_show'; when: string; amount: Money }[];
  raw?: { title: string; text: string }[] }
interface OfferDetails extends Offer { fareRules: FareRules; amenitiesBySegment: Record<string, Amenity[]>; warnings: string[] }

// filters / facets
type TimeBucket = 'early_morning'|'morning'|'afternoon'|'evening'|'night'    // 00‑06, 06‑12, 12‑18, 18‑24 (+ night alias)
interface Filters { stops?: number[]; airlines?: string[]; alliances?: string[]; price?: { min?: number; max?: number };
  departure?: Record<number, TimeBucket[]>; arrival?: Record<number, TimeBucket[]>;   // keyed by slice index
  durationMax?: number; layoverMin?: number; layoverMax?: number; layoverAirports?: string[];
  excludeAirports?: string[]; baggageIncluded?: boolean; refundable?: boolean; selfTransfer?: boolean;
  aircraft?: string[]; flightNumbers?: string[]; cabinOnly?: CabinClass }
interface FacetBucket { value: string|number; count: number; minPrice?: Money; label?: string }
interface Facets { stops: FacetBucket[]; airlines: FacetBucket[]; alliances: FacetBucket[]; price: { min: number; max: number; histogram: number[] };
  duration: { min: number; max: number }; layover: { min: number; max: number }; layoverAirports: FacetBucket[];
  departure: Record<number, FacetBucket[]>; arrival: Record<number, FacetBucket[]>; aircraft: FacetBucket[];
  features: { baggageIncluded: number; refundable: number; selfTransfer: number } }
interface Sort { key: 'best'|'price'|'duration'|'departure'|'arrival'|'emissions'; dir?: 'asc'|'desc' }
interface ResultsSummary { cheapest?: Offer; fastest?: Offer; best?: Offer; earliest?: Offer; count: number }
interface PriceInsight { level: 'low'|'typical'|'high'; typicalRange: { min: Money; max: Money }; trend: 'rising'|'falling'|'flat';
  advice?: 'buy'|'wait'; history?: { date: DateStr; price: Money }[] }
interface DateGrid { rows: DateStr[]; cols?: DateStr[]; cells: ({ price: Money; offerId?: string } | null)[][] }
interface CalendarFares { month: string; days: Record<DateStr, { price: Money; level: 'low'|'typical'|'high' }> }
interface Destination { place: Place; price: Money; dates: { out: DateStr; back?: DateStr }; themes?: string[] }

// ── itinerary / travelers / ancillaries ───────────────────────────────────
interface Itinerary { id: string; status: 'active'|'expired'|'booked'|'abandoned'; offers: Offer[]; passengers: PaxCounts;
  slots: PassengerSlot[]; price: PriceBreakdown; ancillaries: SelectedAncillary[]; promo?: Promo;
  priceChange?: { from: Money; to: Money; acceptedAt?: DateTime }; requirements?: TravelerRequirements;
  travelers?: Traveler[]; contact?: Contact; expiresAt: DateTime; createdAt: DateTime; lockId?: string }
interface PassengerSlot { id: string; type: PaxType; index: number; travelerId?: string }
interface Promo { code: string; label: string; discount: Money; conditions?: string }
interface TravelerRequirements { perType: Record<PaxType, { fields: FieldRule[]; documents: DocumentRule[] }>;
  contact: FieldRule[]; apis: boolean; gstAvailable: boolean; ageRules: AgeRules; nameRules: { maxLength: number; charset: 'latin'|'any' } }
interface FieldRule { path: string; required: boolean; pattern?: string; options?: string[] }
interface DocumentRule { types: TravelDocument['type'][]; required: boolean; minValidityMonths?: number }
interface AgeRules { infantMax: number; childMax: number; refDate: 'departure'|'return'; infantPerAdult: number; maxPax: number }   // infantMax / childMax are EXCLUSIVE upper bounds in years: age < infantMax → INF, infantMax <= age < childMax → CHD
interface Traveler { id?: string; slotId?: string; type: PaxType; title?: string; firstName: string; middleName?: string; lastName: string;
  gender: 'M'|'F'|'X'; dob: DateStr; nationality?: string; documents?: TravelDocument[]; loyalty?: LoyaltyAccount[];
  knownTravelerNumber?: string; redressNumber?: string; mealPref?: string; seatPref?: string; assistance?: string[];
  email?: string; phone?: Phone }
interface TravelerProfile extends Traveler { id: string; isDefault?: boolean; relation?: string; updatedAt: DateTime }
interface TravelDocument { id?: string; type: 'passport'|'national_id'|'driving_licence'|'other'; number: string;
  issuingCountry: string; nationality?: string; expiry: DateStr; issueDate?: DateStr }
interface LoyaltyAccount { airline: string; programme?: string; number: string }
interface Phone { countryCode: string; number: string }
interface Contact { email: string; phone: Phone; emergency?: { name: string; phone: Phone };
  address?: Address; gst?: { number: string; company: string; address?: string; email?: string } }
interface Address { line1: string; line2?: string; city: string; state?: string; postalCode: string; countryCode: string }

type AncillaryType = 'seat'|'baggage'|'meal'|'insurance'|'protection'|'priority_boarding'|'lounge'|'fast_track'|'wifi'|'carbon_offset'|'bundle'|string
interface Service { id: string; type: AncillaryType; code?: string; label: string; description?: string; price: Money;
  scope: 'per_passenger'|'per_passenger_segment'|'per_passenger_slice'|'per_booking'; maxQuantity?: number;
  eligiblePassengerTypes?: PaxType[]; segmentId?: string; sliceId?: string; meta?: object }
interface AncillaryCatalog { services: Service[]; seatMapsAvailable: string[]; insurance?: InsuranceQuote[];
  protections: Protection[]; bundles?: Service[] }
interface SelectedAncillary { id: string; serviceId: string; type: AncillaryType; passengerId?: string; segmentId?: string;
  sliceId?: string; quantity: number; price: Money; detail?: string }
interface SeatMap { segmentId: string; aircraft?: Aircraft; cabins: { cabin: CabinClass; deck?: number; columns: string[];
  rows: SeatRow[] }[]; legend: { code: string; label: string }[] }
interface SeatRow { number: number; seats: Seat[]; exitRow?: boolean; wing?: boolean }
interface Seat { number: string; available: boolean; price?: Money; characteristics: string[];
  restrictions?: ('no_infant'|'adult_only'|'no_child'|string)[]; selectedBy?: string }
interface InsuranceQuote { id: string; provider: string; plan: string; price: Money; perPax: Money; coverage: { code: string; label: string; amount?: Money }[]; termsUrl: string }
interface Protection { id: string; type: 'price_drop'|'cfar'|'flexible_ticket'|'zero_cancellation'|'disruption_guarantee'|'baggage_protection'|'price_lock';
  label: string; price: Money; terms: string; termsUrl?: string; refundPct?: number; windowHours?: number }

// ── booking / payment ─────────────────────────────────────────────────────
type BookingStatus = 'draft'|'pending_payment'|'on_hold'|'processing'|'confirmed'|'ticketed'|'partially_ticketed'|'failed'|'cancelled'|'refunded'|'expired'
interface Booking { id: string; reference: string; type: 'flight'|'price_lock'; status: BookingStatus; pnr?: string;
  airlineLocators: { airline: string; locator: string }[]; tickets: { passengerId: string; number: string; segmentIds: string[] }[];
  itinerary: Itinerary; travelers: Traveler[]; contact: Contact; payment: PaymentSummary; holdExpiresAt?: DateTime;
  voidUntil?: DateTime; createdAt: DateTime; documents: Document[]; availableActions: TripAction[]; failure?: BookingFailure;
  protections: Protection[]; metadata?: object }
interface BookingFailure { code: string; message: string; recoverable: boolean; suggestedAction: 'retry_payment'|'search_again'|'contact_support'|'wait' }
interface PaymentSummary { total: Money; paid: Money; due: Money; dueBy?: DateTime; methods: { type: string; last4?: string; amount: Money }[] }
interface Document { type: 'eticket'|'invoice'|'gst_invoice'|'receipt'|'insurance_policy'|'visa_letter'|string; label: string; url?: string; available: boolean }
interface HoldOption { id: string; label: string; fee: Money; holdUntil: DateTime; refundableFee: boolean; onExpiry: 'drop'|'charge'|'convert_to_paid' }
interface PriceLockOption { id: string; durationHours: number; fee: Money; capAmount?: Money; terms: string }

type PaymentMethodType = 'card'|'upi'|'netbanking'|'wallet'|'apple_pay'|'google_pay'|'paypal'|'bnpl'|'emi'|'bank_transfer'|'pay_later'|'loyalty_points'|'gift_card'|'ota_wallet'|'voucher'
interface PaymentMethod { id: string; type: PaymentMethodType; label: string; gateway: string; fee?: Money; feePct?: number;
  supportsSave: boolean; currency?: string; options?: { banks?: {code:string;name:string}[]; wallets?: string[]; emiPlans?: EmiPlan[]; minAmount?: Money; maxAmount?: Money };
  saved?: SavedMethod[]; available: boolean; unavailableReason?: string }
interface SavedMethod { id: string; type: PaymentMethodType; brand?: string; last4?: string; expiry?: string; label: string; isDefault: boolean; gatewayToken?: string }
interface EmiPlan { id: string; bank: string; months: number; interestPct: number; monthly: Money; total: Money }
interface PaymentQuote { payable: Money; fees: Money; credits: { type: PaymentMethodType; amount: Money; ref?: string }[]; fx?: { from: Money; rate: number }; expiresAt: DateTime }
interface PaymentIntent { id: string; bookingId: string; status: 'requires_method'|'requires_confirmation'|'requires_action'|'processing'|'succeeded'|'failed'|'cancelled';
  amount: Money; method?: { type: PaymentMethodType; gateway: string; savedMethodId?: string }; clientSecret?: string;
  action?: PaymentAction; failure?: { code: string; message: string; retryable: boolean }; splits?: { type: PaymentMethodType; amount: Money; status: string }[];
  returnUrl?: string; createdAt: DateTime; expiresAt?: DateTime }
interface PaymentAction { type: 'redirect'|'iframe'|'upi_collect'|'upi_intent'|'otp'|'poll'|'native_sdk'; url?: string; html?: string;
  qr?: string; deepLink?: string; expiresAt?: DateTime; params?: object }
interface GatewayAdapter { name: string; load(opts: object): Promise<void>; mount?(container: HTMLElement, opts: object): Promise<GatewayElement>;
  tokenize?(el: GatewayElement, billing?: Address): Promise<{ token: string; brand?: string; last4?: string }>;
  confirm?(intent: PaymentIntent, el?: GatewayElement): Promise<{ status: string; payload?: object }>;
  handleAction?(action: PaymentAction, host: HTMLElement): Promise<{ status: string; payload?: object }>; unmount?(el: GatewayElement): void }
interface GatewayElement { el: HTMLElement; isComplete(): boolean; on(evt: 'change'|'ready'|'error', fn: Function): () => void }
// The isolated payments package implements this port; domain modules depend on nothing else from it.
interface PaymentsPort { methods; quote; credits; emiPlans; createIntent; mount; tokenize; confirm; handleAction; waitForResult; pay; resumeAfterRedirect; cancel; retry; intent; status; quoteState; savedMethods; receipt; refunds; gateways; validateCard; cardBrand; clear }  // see 07-booking.md §2
// RFC 9457 problem document as returned by the backend (extension members: code, errors, requestId)
interface Problem { type: string; title: string; status: number; detail?: string; instance?: string; code?: string; requestId?: string;
  errors?: { code?: string|number; title?: string; detail?: string; source?: { pointer?: string; parameter?: string; example?: string } }[]; [ext: string]: unknown }
interface Refund { id: string; bookingId: string; amount: Money; method: string; status: 'requested'|'processing'|'completed'|'failed'; eta?: DateTime; updatedAt: DateTime }

// ── trips / servicing ─────────────────────────────────────────────────────
type TripAction = 'change'|'cancel'|'cancel_partial'|'add_seats'|'add_bags'|'add_meals'|'check_in'|'name_correction'|'special_assistance'|'update_contact'|'update_documents'|'split_pnr'|'download_eticket'|'invoice'|'gst_invoice'|'resend'|'pay_now'|'void'|'rebook'|'support'
interface Trip extends Booking { phase: Phase; nextSegment?: Segment; flightStatuses?: FlightStatus[]; checkIn?: CheckInInfo; disruptions?: Disruption[] }
interface FlightStatus { segmentId: string; status: 'scheduled'|'on_time'|'delayed'|'departed'|'landed'|'cancelled'|'diverted';
  estimatedDeparture?: DateTime; estimatedArrival?: DateTime; gate?: string; terminal?: string; baggageBelt?: string; delayMinutes?: number }
interface CheckInInfo { perSegment: { segmentId: string; opensAt: DateTime; closesAt: DateTime; url?: string; status: 'not_open'|'open'|'closed'|'done' }[] }
interface ChangeOptions { changeable: boolean; slices: { sliceId: string; changeable: boolean; penalty?: Money; deadline?: DateTime }[];
  passengers: { passengerId: string; changeable: boolean }[]; notes: string[] }
interface ChangeQuote { id: string; bookingId: string; newOffer: Offer; fareDifference: Money; penalty: Money; total: Money; refundDue?: Money; expiresAt: DateTime }
interface CancelQuote { id: string; bookingId: string; scope: { passengerIds?: string[]; sliceIds?: string[] }; refund: Money; penalty: Money;
  nonRefundable: Money; protectionCover?: Money; refundMethods: ('original'|'wallet'|'voucher')[]; eta?: string; voidEligible: boolean; expiresAt: DateTime }
interface Cancellation { id: string; bookingId: string; status: 'processing'|'cancelled'|'failed'; refund?: Refund }
interface Disruption { id: string; type: 'schedule_change'|'cancellation'|'reaccommodation'; segmentIds: string[]; summary: string;
  options: { id: string; type: 'accept'|'alternative'|'refund'|'voucher'; offer?: Offer; refund?: Money }[]; respondBy?: DateTime; status: 'open'|'responded' }
interface ServiceRequest { id: string; bookingId: string; type: string; status: 'submitted'|'in_progress'|'done'|'rejected'; createdAt: DateTime; note?: string }

// ── account / wallet / alerts ─────────────────────────────────────────────
interface User { id: string; email?: string; phone?: Phone; firstName?: string; lastName?: string; verified: { email: boolean; phone: boolean };
  providers: string[]; createdAt: DateTime; tier?: string }
interface Preferences { locale: string; currency: string; homeAirport?: IATA; seatPref?: string; mealPref?: string; hour12?: boolean;
  notifications: { email: boolean; sms: boolean; push: boolean; whatsapp?: boolean; marketing: boolean } }
interface WalletBalance { cash: Money; promo: Money; expiring: { amount: Money; at: DateTime }[] }
interface LoyaltyStatus { tier: string; points: number; pointsValue: Money; nextTier?: { name: string; pointsNeeded: number }; benefits: string[] }
interface Coupon { code: string; label: string; discount: string; validUntil?: DateTime; conditions?: string; applicable?: boolean; reason?: string }
interface Voucher { id: string; code: string; amount: Money; remaining: Money; expiresAt: DateTime; source: string; restrictions?: string }
interface PriceAlert { id: string; params: SearchParams | { origin: IATA; destination: IATA; dateRange: { from: DateStr; to: DateStr } };
  targetPrice?: Money; lastPrice?: Money; lowestPrice?: Money; channels: ('email'|'push'|'sms')[]; frequency: 'instant'|'daily'|'weekly'; active: boolean; createdAt: DateTime }
interface SavedSearch { id: string; name?: string; params: SearchParams; createdAt: DateTime }
interface Ticket { id: string; subject: string; category: string; status: 'open'|'pending'|'resolved'|'closed'; bookingId?: string;
  messages: { id: string; from: 'user'|'agent'; text: string; at: DateTime; attachments?: string[] }[]; updatedAt: DateTime }

// ── client ────────────────────────────────────────────────────────────────
type AccessLevel = 'open'|'guest'|'auth'
interface AccessPolicy { default?: AccessLevel; rules?: Record<string, AccessLevel> }   // keys: 'search.*', 'booking.create', 'trips.*', …
type EndpointKey = string                                                            // e.g. 'search.create', 'booking.create' (see core/endpoints.js)
interface ClientConfig {
  baseUrl?: string;                      // default https://api.ota.com (paths carry their own version prefix)
  endpoints?: Partial<Record<EndpointKey, string>>;  // override any path template
  access?: AccessPolicy;                 // which functions need auth / guest / nothing
  errorFormat?: 'problem+json'|'envelope';           // default problem+json (RFC 9457)
  apiKey?: string; clientId?: string;    // public partner / app identifiers
  locale?: string; currency?: string; market?: string;
  fetch?: typeof fetch; timeoutMs?: number; retries?: number;
  auth?: { strategy: 'bearer'|'cookie'; refreshPath?: string; tokenStorage?: 'memory'|'session'|'local'; autoRefreshSkewMs?: number; guest?: boolean };
  storage?: 'memory'|'local'|'session'|StorageAdapter; storageNamespace?: string;
  persist?: { drafts?: boolean };        // PII drafts opt‑in
  interceptors?: { request?: Interceptor[]; response?: Interceptor[]; error?: Interceptor[] };
  hooks?: Partial<Record<HookName, HookFn>>;
  search?: { mode: 'poll'|'single'|'stream'; pollIntervalMs?: number; maxPollMs?: number; resultMode?: 'combined'|'per_slice'|'auto' };
  payments?: PaymentsPort;               // from @wayfarer/sdk/payments: createPayments({ gateways: [stripe(), paypal(), razorpay()], returnUrl })
  telemetry?: { adapters?: TelemetryAdapter[]; enabled?: boolean; sampleRate?: number };
  features?: Record<string, boolean|string>; i18n?: { messages?: object; fallback?: string };
  logger?: { level: 'silent'|'error'|'warn'|'info'|'debug'; sink?: Function | Pick<Console, 'debug'|'info'|'warn'|'error'>; redact?: string[] };
  autoBootstrap?: boolean; plugins?: Plugin[]; devtools?: boolean
}
interface Plugin { name: string; install(client: OtaClient): void | (() => void) }
type HookName = 'beforeRequest'|'afterResponse'|'onRetry'|'onError'|'onAbort'|'onTimeout'|'onAuthExpired'|'onTokenRefreshed'|'onStateChange'
```
