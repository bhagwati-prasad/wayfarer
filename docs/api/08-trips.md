# 08 · Post‑booking: `trips`, `support`

Scripts: `modules/trips.js`, `modules/support.js`.
A **trip** is a booking seen after purchase: it carries `phase` (`upcoming | past | cancelled`), live flight status, check‑in windows, disruptions and the list of `availableActions` the backend permits right now. All servicing is two‑step (**quote → confirm**) so the UI can show money before committing.

---

## 1. `modules/trips.js`

#### `trips.list({ phase?: Phase|'all' = 'upcoming', cursor?, limit? = 20, includeLocks?, includeHolds? = true } = {}, opts?) → Promise<Page<Trip>>`
Requires login (guest: use `trips.byReference`). Effects: net `GET /me/trips` · state `trips.byPhase[phase]`, `trips.byId` · emit `trips:loaded`.

#### `trips.get(bookingId, { fresh? } = {}, opts?) → Promise<Trip>` · `trips.current() → Trip|null`
Effects: net `GET /bookings/{id}` (fresh or miss) · state `trips.byId`, `trips.current` · emit `trip:loaded`.

#### `trips.byReference({ reference, lastName, email? }, opts?) → Promise<Trip>`
Guest manage‑booking (delegates to `booking.retrieve`). Effects: see `booking.retrieve` · state `trips.current`.

#### `trips.phaseOf(booking) → Phase` · `trips.nextSegment(trip) → Segment|null` · `trips.summary(trip, t?) → TripSummary` · `trips.canDo(trip, action: TripAction) → boolean`
Pure view helpers. Effects: none.

#### `trips.flightStatus(bookingId | { carrier, flightNumber, date }, opts?) → Promise<FlightStatus[]>`
Effects: net `GET /flights/status` · state `trips.byId[id].flightStatuses`.

#### `trips.checkIn(bookingId, opts?) → Promise<CheckInInfo>`
Per‑segment windows and airline check‑in deep links (prefilled with PNR/surname where supported).
Effects: net `GET /bookings/{id}/check-in`.

#### `trips.boardingPasses(bookingId, opts?) → Promise<Document[]>`
When the platform ingests passes. Effects: net `GET /bookings/{id}/boarding-passes`.

#### `trips.documents(bookingId, opts?) → Promise<Document[]>` · `trips.download(bookingId, type, opts?) → Promise<Blob>`
Delegates to `booking.documents/download`.

#### `trips.invoice.request(bookingId, { gst?: Contact['gst'], email? } = {}, opts?) → Promise<Document>`
Generate (GST) invoice; may be async (`available:false` until ready). Effects: net `POST /bookings/{id}/invoice` · emit `trip:requestSubmitted`.

### Changes (date / flight change, reissue)

#### `trips.changes.options(bookingId, opts?) → Promise<ChangeOptions>`
Which slices / passengers are changeable, penalties, deadlines. Effects: net `GET /bookings/{id}/change-options` · state `trips.changeOptions`.

#### `trips.changes.search(bookingId, { sliceIds: string[], dates: Record<sliceId, DateStr>, passengerIds?, cabin? }, opts?) → Promise<SearchSession>`
Reshop within the airline's change rules (reuses `search.create` with `context.bookingId`; results are priced as differences).
Effects: as `search.create` (tag `change`).

#### `trips.changes.quote(bookingId, { offerId }, opts?) → Promise<ChangeQuote>`
Fare difference + penalty + new total, with expiry. Effects: net `POST /bookings/{id}/changes/quote` · state `trips.changeQuote` · emit `trip:changeQuoted`.
Throws: `ServicingError{action:'change'}`, `OfferExpiredError`.

#### `trips.changes.confirm(quoteId, { payment?: Parameters<payments.pay>[1] } = {}, ui?, opts?) → Promise<{ booking: Booking, intent?: PaymentIntent, refund?: Refund }>`
Apply the change; when `total > 0` runs the `payments.pay` pipeline first; when negative issues a refund record.
Effects: net `POST /bookings/{id}/changes/{quoteId}/confirm` (+ payments) · state `trips.byId`, `booking.current` · emit `trip:changed`.

### Cancellation & refunds

#### `trips.cancellation.quote(bookingId, { passengerIds?, sliceIds?, reason?: string } = {}, opts?) → Promise<CancelQuote>`
Full or partial cancellation preview: refund, penalties, non‑refundable taxes, protection cover, refund methods, void eligibility (24 h), ETA.
Effects: net `POST /bookings/{id}/cancellations/quote` · state `trips.cancelQuote` · emit `trip:cancelQuoted`.
Throws: `ServicingError{action:'cancel'|'cancel_partial'}`.

#### `trips.cancellation.confirm(quoteId, { refundMethod: 'original'|'wallet'|'voucher', reason?, acknowledge: true }, opts?) → Promise<Cancellation>`
Effects: net `POST /bookings/{id}/cancellations/{quoteId}/confirm` · state `trips.byId` (phase → cancelled), `trips.refunds` · emit `trip:cancelled` · telemetry `refund`.

#### `trips.refunds(bookingId, { fresh? } = {}, opts?) → Promise<Refund[]>` · `trips.refundStatus(refundId, opts?) → Promise<Refund>`
Effects: net `GET /bookings/{id}/refunds`, `GET /refunds/{id}` · state `trips.refunds` · emit `trip:refundUpdated`.

### Disruptions (airline schedule changes / cancellations)

#### `trips.disruptions(bookingId, opts?) → Promise<Disruption[]>`
Open involuntary changes with the options the airline allows (accept, alternative flights, refund, voucher).
Effects: net `GET /bookings/{id}/disruptions` · state `trips.disruptions` · emit `trip:disruption` (new ones).

#### `trips.disruptions.respond(bookingId, disruptionId, { optionId }, opts?) → Promise<Trip>`
Effects: net `POST /bookings/{id}/disruptions/{did}/respond` · state `trips.byId` · emit `trip:changed|trip:cancelled`.

### Post‑booking ancillaries

#### `trips.ancillaries(bookingId) → AncillariesApi`
Returns the `ancillaries` module bound to `context: { bookingId }` (`catalog`, `seats.*`, `baggage.*`, `meals.*`, `extras.*`). Additions create a payable amendment.
Effects: as `ancillaries.*` against `/bookings/{id}/…` · state `trips.pendingAmendment`.

#### `trips.amendment.quote(bookingId, opts?) → Promise<{ total: Money, items: SelectedAncillary[], expiresAt }>` · `trips.amendment.confirm(bookingId, { payment? }, ui?, opts?) → Promise<{ booking, intent? }>`
Pay for post‑booking add‑ons. Effects: net `POST /bookings/{id}/amendments/quote|confirm` (+ payments) · state `trips.byId` · emit `trip:changed`.

### Service requests

#### `trips.requests.nameCorrection(bookingId, { passengerId, fields: Partial<Traveler>, reason? }, opts?)`
#### `trips.requests.specialAssistance(bookingId, { passengerId, codes: string[], note? }, opts?)`
#### `trips.requests.updateContact(bookingId, contact: Partial<Contact>, opts?)`
#### `trips.requests.updateDocuments(bookingId, { passengerId, documents: TravelDocument[] }, opts?)`
#### `trips.requests.splitPnr(bookingId, { passengerIds }, opts?)`
#### `trips.requests.other(bookingId, { type, note, attachments? }, opts?)`
Each → `Promise<ServiceRequest>`; some are instant (contact), others queued for an agent.
Effects: net `POST /bookings/{id}/requests` · state `trips.byId[id].requests` · emit `trip:requestSubmitted`.
Throws: `ServicingError`, `ValidationError`.

#### `trips.requests.list(bookingId, opts?) → Promise<ServiceRequest[]>`
Effects: net `GET /bookings/{id}/requests`.

### Misc

#### `trips.alerts.subscribe(bookingId, { channels: ('push'|'sms'|'email'|'whatsapp')[] }, opts?)` · `trips.alerts.unsubscribe(bookingId, opts?)`
Flight status / gate / delay notifications. Effects: net `POST|DELETE /bookings/{id}/alerts`.

#### `trips.payNow(bookingId, params, ui?) → Promise<{ intent, booking }>`
Pay an `on_hold` booking before `holdExpiresAt` (delegates to `payments.pay`). Effects: as `payments.pay`.

#### `trips.void(bookingId, opts?) → Promise<Cancellation>`
Same‑day void inside `voidUntil` (full refund, no penalty); shortcut for quote+confirm. Effects: as cancellation.

#### `trips.rebookParams(trip) → SearchParams`
Prefill a new search from a past trip. Effects: none.

#### `trips.rate(bookingId, { score: 1|2|3|4|5, comment? }, opts?) → Promise<void>`
Effects: net `POST /bookings/{id}/rating`.

#### `trips.invalidate(bookingId?) → void`
Effects: state `trips` (drop cached entries).

---

## 2. `modules/support.js`

#### `support.contactOptions({ bookingId?, market? } = {}, opts?) → Promise<{ phone?: string, hours?: string, chat: boolean, whatsapp?: string, email?: string, callback: boolean }>`
Effects: net `GET /support/contact-options`.

#### `support.tickets.create({ bookingId?, category, subject, message, attachments?: File[] }, opts?) → Promise<Ticket>`
Effects: net `POST /support/tickets` (multipart) · emit `support:ticketUpdated`.

#### `support.tickets.list({ status?, cursor? } = {}, opts?) → Promise<Page<Ticket>>` · `support.tickets.get(id, opts?) → Promise<Ticket>`
Effects: net `GET /support/tickets[/{id}]`.

#### `support.tickets.reply(id, { message, attachments? }, opts?) → Promise<Ticket>` · `support.tickets.close(id, opts?) → Promise<Ticket>`
Effects: net `POST /support/tickets/{id}/messages`, `POST /support/tickets/{id}/close` · emit `support:ticketUpdated`.

#### `support.callback.request({ phone: Phone, preferredTime?, bookingId?, topic? }, opts?) → Promise<{ id, eta }>`
Effects: net `POST /support/callbacks`.

#### `support.chat.token({ bookingId? } = {}, opts?) → Promise<{ token, provider, expiresAt }>`
Short‑lived token to boot a third‑party chat widget with the user's context. Effects: net `POST /support/chat/token`.

#### `support.faq(query, opts?) → Promise<FaqEntry[]>`
Delegates to `content.faq({ query })`.
