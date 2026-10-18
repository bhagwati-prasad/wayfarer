# 02 · State store, events, errors, storage

Scripts: `state/store.js`, `events/emitter.js`, `errors/index.js`, `storage/adapters.js`.

---

## 1. `state/store.js`

#### `createStore({ slices?, middleware?, persist?, devtools?, storage }) → Store`
Immutable, slice‑based store. Effects: storage read (hydrate persisted slices).

#### `store.getState() → State` · `store.get(path: string) → unknown`
Synchronous reads (`get('search.filters.stops')`). Effects: none.

#### `store.select(selector: (s) => T, equality? = Object.is) → T`
Memoised read. Effects: none.

#### `store.subscribe(listener: (state, prev, change) => void) → off`
#### `store.subscribe(selector, listener: (value, prev) => void, { equality?, fireImmediately? }) → off`
Notify after each batched commit; selector form only fires when the selected value changes. Effects: none.

#### `store.set(slice: string, updater: Partial<S> | ((s: S) => S), meta?: { action: string }) → void`
Commit a change (structural sharing; batched per microtask). Effects: state `slice` · emit `state:change` `{ slice, action }` · storage (if slice persisted, debounced).

#### `store.batch(fn: () => void) → void`
Group several `set`s into one notification. Effects: as the inner sets.

#### `store.reset(slice?: string) → void`
Back to initial state (all slices when omitted). Effects: state · storage remove · emit `state:change`.

#### `store.registerSlice(name, { initial, persist?: { storage?: 'local'|'session'|'memory', ttlMs?, pick?: string[] }, migrate?(old, version) }) → void`
Used by modules at install time; idempotent. Effects: state (initial) · storage read.

#### `store.hasSlice(name) → boolean`
Whether a slice is registered (used by `auth/session.js` before touching `account`). Effects: none.

#### `store.use(middleware: (ctx: { slice, action, prev, next }, proceed) => void) → off`
Wrap every commit (logging, analytics, devtools). Effects: none.

#### `store.persist.flush() → Promise<void>` · `store.persist.hydrate(slice?) → Promise<void>` · `store.persist.clear(slice?) → void`
Effects: storage write / read / remove.

#### `store.snapshot() → Snapshot` · `store.restore(snapshot) → void`
Serialisable copy (persisted + transient slices, minus secrets). Effects: state (restore) · emit `state:change`.

#### `store.getSnapshot() → State` · `store.toObservable(selector?) → { subscribe(observer) → { unsubscribe() } }`
Framework interop kept dependency‑free: `subscribe` + `getSnapshot` are `useSyncExternalStore`‑compatible (React); Svelte binds `toObservable()` (its `$store` syntax calls `subscribe(run, invalidate)` with two functions, which the store itself reads as the selector form above); `toObservable` follows the TC39/RxJS observable contract (Angular `async` pipe, Vue `from`). The later `bindings/react|vue|angular.js` wrappers are thin layers over these. Effects: none.

#### `store.destroy() → void`
Effects: storage flush · listeners cleared.

#### `createSelector(...inputs, combiner) → selector` · `shallowEqual(a, b) → boolean`
Effects: none.

---

## 2. `events/emitter.js`

#### `createEmitter({ logger?, now? }) → Emitter`
`now` is the injectable clock (ms) stamped on `payload.at` (the client passes its own). Effects: none.

#### `emitter.on(event: string | string[], fn) → off` · `emitter.once(event, fn) → off` · `emitter.off(event, fn?) → void`
Supports exact names, namespace wildcards (`'search:*'`) and `'*'`. Effects: none.

#### `emitter.emit(event, payload?) → void`
Synchronous fan‑out; listener exceptions are caught and re‑emitted as `error` (never thrown to the emitter). Effects: emit.

#### `emitter.waitFor(event, { timeoutMs?, filter?, signal? }) → Promise<payload>`
Resolve on next matching event. Never throws synchronously. Effects: timer. Rejects: `TimeoutError`, `AbortError` (signal, or `clear()`), `ValidationError` (bad arguments), the wrapped `SdkError` when `filter` throws.

#### `emitter.listenerCount(event?) → number` · `emitter.clear() → void`
Effects: none / listeners cleared.

---

## 3. `errors/index.js`

```
SdkError            { code, message, cause?, requestId?, retryable: boolean, details?, at }
├─ ConfigError
├─ ValidationError  { issues: ValidationIssue[] }
├─ NetworkError
├─ TimeoutError     { timeoutMs }
├─ AbortError       { reason }
├─ StorageError
├─ UnsupportedError { feature }
├─ ApiError         { status, code, problem?: Problem, issues?: Problem['errors'], details, meta }   // RFC 9457 fields kept on `problem`
│  ├─ AuthError      { reason: 'unauthenticated'|'expired'|'forbidden'|'invalid_credentials'|'mfa_required'|'otp_invalid'|'otp_expired'|'locked' }
│  ├─ RateLimitError { retryAfterMs }
│  ├─ NotFoundError
│  ├─ ConflictError
│  ├─ SearchExpiredError   { sessionId }
│  ├─ OfferExpiredError    { offerId }
│  ├─ OfferUnavailableError{ offerId, reason: 'sold_out'|'withdrawn'|'schedule_changed'|'waitlist'|'on_request' }   // waitlist / on_request ← availability closedStatus
│  ├─ PriceChangedError    { from: Money, to: Money, newOfferId?, itineraryId? }
│  ├─ ItineraryExpiredError{ itineraryId }
│  ├─ BookingError         { stage: 'create'|'hold'|'confirm'|'ticketing', recoverable, suggestedAction: 'retry_payment'|'search_again'|'contact_support'|'wait' }
│  ├─ PaymentError         { reason: 'declined'|'insufficient_funds'|'authentication_failed'|'requires_action'|'expired'|'cancelled'|'gateway'|'fraud'|'method_unavailable', retryable }   // 'requires_action' ← code PAYMENT_REQUIRES_ACTION (3‑DS / UPI step pending)
│  ├─ ServicingError       { action: TripAction, reason }
│  └─ UnprocessableError   { fieldErrors }
```

#### `isSdkError(e) → boolean` · `isRetryable(e) → boolean` · `is(e, Class) → boolean`
Effects: none.

#### `errorFromProblem(problem: Problem, { requestId, map? }) → ApiError`
Build the right subclass from an RFC 9457 document: `problem.code` (extension) wins, then the last path segment of `problem.type` (e.g. `https://api.ota.com/problems/offer-expired` → `OFFER_EXPIRED`), then `status`. Amadeus‑style `errors[]` issues are kept as `issues`. Effects: none.

#### `errorFromResponse(status, body, headers, { requestId, map? }) → ApiError`
Detects `application/problem+json` and delegates to `errorFromProblem`; legacy `{ code, message }` bodies and empty bodies fall back to status mapping. Effects: none.

#### `wrap(e: unknown, fallback?: { code, message }) → SdkError`
Normalise anything thrown (DOMException, TypeError from fetch, gateway errors). Effects: none.

#### `toUserMessage(e, t?: I18n['t']) → { title, message, action?: 'retry'|'search_again'|'login'|'contact_support' }`
Localised, user‑safe message (never leaks server details). Effects: none.

#### `ERROR_CODES: Record<string, string>`
Canonical backend codes the SDK understands (`OFFER_EXPIRED`, `PRICE_CHANGED`, `SOLD_OUT`, `ITINERARY_EXPIRED`, `PAYMENT_DECLINED`, `PAYMENT_REQUIRES_ACTION`, `HOLD_NOT_ALLOWED`, `CHANGE_NOT_ALLOWED`, `CANCEL_NOT_ALLOWED`, `NAME_MISMATCH`, `DOCUMENT_INVALID`, `PROMO_INVALID`, `SESSION_EXPIRED`, `RATE_LIMITED`, …).

---

## 4. `storage/adapters.js`

#### `createStorage({ driver: 'memory'|'local'|'session'|'cookie'|StorageAdapter, namespace = 'wf', serializer?, defaultTtlMs?, onUnavailable?, events?, now? }) → Storage`
Namespaced, TTL‑aware key/value facade; falls back to memory when the browser driver throws (private mode, quota). `events` receives `storage:unavailable`; `now` is the injectable clock for TTLs.
Effects: storage probe write · emit `storage:unavailable` on fallback.

#### `storage.get<T>(key) → T|undefined` · `storage.set(key, value, { ttlMs? }) → void` · `storage.remove(key) → void` · `storage.has(key) → boolean`
Expired entries read as `undefined` and are deleted. Effects: storage.

#### `storage.keys(prefix?) → string[]` · `storage.clear(prefix?) → void` · `storage.isAvailable() → boolean` · `storage.driverName → string`
Effects: storage (clear).

#### `storage.subscribe(key, fn) → off`
Cross‑tab change notifications (`storage` event) for `local` driver. Effects: none.

#### `storage.destroy() → void`
Drop every subscriber and the window `storage` listener (data is kept). Called by `client.destroy()` for each facade it created. Effects: none.

#### `memoryDriver()` · `webStorageDriver(area: Storage)` · `cookieDriver({ domain?, secure?, sameSite?, path?, maxAgeSec? })`
`StorageAdapter = { getItem, setItem, removeItem, keys?, name }`. Effects: none until used.
