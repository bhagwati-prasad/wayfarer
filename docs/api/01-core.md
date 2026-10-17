# 01 · Core: client, config, HTTP, interceptors, auth

Scripts: `core/client.js`, `core/config.js`, `http/client.js`, `http/interceptors.js`, `auth/session.js`.

---

## 1. `core/client.js`

#### `createClient(config?: ClientConfig) → OtaClient`
Compose http, auth, store, events, storage, i18n, telemetry and every domain module into one client; install plugins; hydrate persisted slices; optionally bootstrap.
Effects: state all slices (initial) · storage read (hydrate) · emit `client:ready` · net `GET /config` only when `autoBootstrap`.

#### `client.bootstrap(opts?) → Promise<BootstrapConfig>`
Fetch runtime config: markets, currencies, limits (max pax / legs), feature flags, payment method catalogue, min app version.
Effects: net `GET /config` · state `bootstrap`, `prefs` (fills gaps) · emit `bootstrap:loaded`, `features:change` · storage `bootstrap` (ttl).

#### `client.use(plugin: Plugin) → OtaClient`
Install a plugin (`install(client)` may return an uninstall fn run on `destroy`).
Effects: whatever the plugin does.

#### `client.setLocale(locale) → void` · `client.setCurrency(code) → void` · `client.setMarket(market) → void`
Change presentation preference; headers for subsequent requests follow automatically. Does **not** re‑run searches.
Effects: state `prefs` · storage `prefs` · emit `prefs:change`.

#### `client.getPrefs() → Prefs` · `client.getConfig() → Readonly<ClientConfig>` · `client.version: string`
Effects: none.

#### `client.on(event, fn) → off` · `client.once` · `client.off`
Shortcuts to `client.events`. Effects: none.

#### `client.snapshot() → Snapshot` · `client.restore(snapshot) → void`
Serialise / restore store + auth for SSR hydration or redirect round‑trips.
Effects: state all (restore) · emit `state:change`.

#### `client.destroy() → void`
Abort in‑flight requests, stop pollers/timers, unsubscribe listeners, uninstall plugins, flush persistence.
Effects: net abort · timer clear · storage flush · emit `client:destroyed`.

Namespaces exposed on the client: `http`, `auth`, `access`, `store`, `events`, `storage`, `i18n`, `telemetry`, `features`, `logger`, `endpoints`, `places`, `content`, `search`, `filters`, `offers`, `itinerary`, `travelers`, `ancillaries`, `booking`, `payments` (the injected `PaymentsPort`, or a null port), `trips`, `account`, `wallet`, `alerts`, `support`, `utils`.

### 1.1 `auth/access.js` — access gating

#### `createAccess({ policy: AccessPolicy, auth, events }) → Access`
Effects: none.

#### `access.levelOf(key: string) → AccessLevel`
Resolve `'booking.create'` against `rules` (exact key, then `module.*`, then `default`). Effects: none.

#### `access.guard(key, fn) → fn`
Wrap a module function: `'open'` → call through; `'guest'` → `await auth.ensureGuestSession()` then call; `'auth'` → if not authenticated reject with `AuthError{reason:'unauthenticated', key}` and emit `auth:required` (no network call is made).
Effects: emit `auth:required` · (guest) see `auth.ensureGuestSession`.

#### `access.can(key) → boolean` · `access.setPolicy(policy) → void` · `access.policy() → AccessPolicy`
Effects: `setPolicy` emits `access:change`.

Default policy (agencies override any key): `default:'open'`; `'itinerary.*' | 'ancillaries.*' | 'booking.*' | 'payments.*' | 'alerts.createGuest' | 'booking.retrieve' | 'trips.byReference' : 'guest'`; `'travelers.*' | 'trips.*' | 'account.*' | 'wallet.*' | 'alerts.*' | 'support.tickets.*' | 'payments.savedMethods.*' : 'auth'`. Functions that are pure or read‑only reference data stay `'open'`.

#### `core/endpoints.js` — `createEndpoints(overrides?) → { get(key, params?) → string, set(key, template), all() }`
Path templates per endpoint key (`'search.create' → '/v2/shopping/flight-offers'`, `'offers.reprice' → '/v1/shopping/flight-offers/pricing'`, `'booking.create' → '/v1/booking/flight-orders'`, … SDK‑defined `/v1/...` for everything the Amadeus specs don't cover; full table in `BACKEND-MAPPING.md`). Effects: none.

---

## 2. `core/config.js`

#### `defineConfig(partial: Partial<ClientConfig>) → ClientConfig`
Deep‑merge with `DEFAULTS`, validate, freeze. Throws `ConfigError`. Effects: none.

#### `validateConfig(config) → ValidationResult`
Effects: none.

#### `DEFAULTS: ClientConfig`
`baseUrl https://api.ota.com`, `errorFormat 'problem+json'`, `timeoutMs 20000`, `retries 2`, `auth.strategy 'bearer'`, `auth.tokenStorage 'memory'`, `auth.guest true`, `access` (see §1.1), `storage 'local'`, `search.mode 'poll'`, `search.resultMode 'per_slice'`, `search.pollIntervalMs 1500`, `search.maxPollMs 45000`, `logger.level 'warn'`, `autoBootstrap true`.

---

## 3. `http/client.js`

#### `createHttp(options: HttpOptions) → Http`
`HttpOptions = { baseUrl, fetch, timeoutMs, retries, headers, events, logger, storage }`. Effects: none until used.

#### `http.request<T>(spec: RequestSpec) → Promise<HttpResponse<T>>`
`RequestSpec = RequestOpts & { method, path?: string, url?: string, body?: unknown }`. Run the full lifecycle (§3.1). Resolves `{ data, status, headers, requestId, fromCache, attempts, durationMs }`.
Effects: net · emit `http:request`, `http:response|http:error`, `http:retry` (per retry) · telemetry timing.
Throws: `NetworkError`, `TimeoutError`, `AbortError`, `ApiError` (+ mapped subclasses), `RateLimitError`.

#### `http.get(path, opts?)` · `http.post(path, body?, opts?)` · `http.put` · `http.patch` · `http.delete`
Sugar over `request`. Effects: as `request`.

#### `http.download(path, opts?) → Promise<Blob>` · `http.upload(path, formData, opts?) → Promise<HttpResponse>`
Binary helpers (`responseType 'blob'`; multipart with progress via `opts.onProgress`). Effects: as `request`.

#### `http.stream(path, opts?) → AsyncIterable<StreamEvent> & { close() }`
Open an SSE / NDJSON stream (incremental search results, booking status). Reconnects with backoff while `opts.signal` is not aborted.
Effects: net (long‑lived) · emit `http:request` · timer reconnect.

#### `http.interceptors.request.use(fn, { priority?, name? }) → off`
`fn(spec, ctx) → spec | HttpResponse | void`. Return an `HttpResponse` to short‑circuit (cache / mock). Lower priority runs first. Effects: none (registration).

#### `http.interceptors.response.use(fn, { priority?, name? }) → off`
`fn(response, ctx) → response | void`. Throw to turn a 2xx into an error. Effects: none.

#### `http.interceptors.error.use(fn, { priority?, name? }) → off`
`fn(error, ctx) → HttpResponse | Error | void`. Return a response to recover (after `await ctx.retry()`), return/throw an error to replace it. Effects: none.

#### `http.use(bundle: { request?, response?, error? }, opts?) → off`
Register a bundle of the three in one call. Effects: none.

#### `http.hooks.on(name: HookName, fn) → off`
Observe‑only taps: `beforeRequest(ctx)` (may call `ctx.abort(reason)`), `afterResponse(ctx)`, `onRetry(ctx, delayMs)`, `onError(ctx)`, `onAbort(ctx)`, `onTimeout(ctx)`. Exceptions inside hooks are swallowed and logged. Effects: none.

#### `http.setHeader(name, value | (() => string|undefined)) → void` · `http.removeHeader(name) → void`
Default headers; a function is evaluated per request (lazy tokens). Effects: none.

#### `http.setBaseUrl(url) → void` · `http.setFetch(fn) → void`
Effects: none.

#### `http.abort(tag: string, reason?) → number` · `http.abortAll(reason?) → number`
Abort in‑flight requests by tag / all; returns count. Effects: emit `http:abort` per request; pending promises reject with `AbortError`.

#### `http.cache.clear(pattern?: string|RegExp) → void` · `http.cache.invalidate(key) → void`
Effects: storage (cache namespace).

#### `http.inflight(tag?) → number` · `http.lastRequestId() → string|undefined`
Effects: none.

### 3.1 Lifecycle context (`ctx`) passed to interceptors and hooks

```
ctx = {
  id, spec, attempt, startedAt, tag, meta,          // meta: Map for cross‑stage data
  request?: Request, response?: Response, data?, error?,
  setHeader(name, value), setQuery(name, value),
  retry({ delayMs?, spec? }) → Promise<HttpResponse>, // re‑enter at cache/dedupe stage (counts an attempt)
  abort(reason), signal: AbortSignal,
  auth: { getToken(), refresh() },                    // injected by authInterceptor
}
```

Order: `prepare → request interceptors (asc priority) → beforeRequest → cache/dedupe → fetch → afterResponse → parse → response interceptors → resolve`; on failure `normalise → error interceptors → retry policy (network, 408, 425, 429, 5xx when idempotent or Idempotency‑Key set) → onRetry → back to cache/dedupe`.

---

## 4. `http/interceptors.js` (factories; each returns a bundle for `http.use`)

| factory | task | side effects |
|---|---|---|
| `authInterceptor({ auth, exclude?: RegExp[] })` | Attach `Authorization: Bearer <token>` (or `X-Session-Id` for guests); on 401 run `auth.refresh()` single‑flight, then `ctx.retry()`; on refresh failure clear session | emit `auth:expired` · state `session` |
| `apiKeyInterceptor({ key, header = 'X-Api-Key' })` | Public key header | none |
| `localeInterceptor({ store })` | `Accept-Language`, `X-Currency`, `X-Market` from `prefs` | none |
| `correlationInterceptor({ header = 'X-Request-Id', sessionHeader = 'X-Client-Session' })` | Per‑request id + per‑tab session id; echoes server `X-Request-Id` into errors | storage `clientSession` |
| `idempotencyInterceptor({ header = 'Idempotency-Key' })` | Add key for POST/PUT/PATCH when `spec.idempotencyKey` set (`true` → hash of path+body) | none |
| `envelopeInterceptor({ dataKey = 'data', metaKey = 'meta', dictionariesKey = 'dictionaries' })` | Unwrap `{data, meta, dictionaries}` envelopes (Amadeus responses carry `dictionaries` for carriers/aircraft/locations); attach `meta` + `dictionaries` to the response for the adapters | none |
| `problemInterceptor({ map? })` | Parse RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, extensions `code`, `errors[]`, `requestId`) → `SdkError` subclass by `code`, then `type`, then `status`; non‑problem bodies fall back to status mapping | none |
| `rateLimitInterceptor({ maxWaitMs = 10000 })` | On 429 wait `Retry-After` (capped) then `ctx.retry()` | emit `http:retry` · timer |
| `cacheInterceptor({ storage, defaultTtlMs, methods = ['GET'] })` | Serve / store responses when `spec.cache` set; keys by url+query+locale+currency | storage `cache:*` |
| `dedupeInterceptor()` | Share the promise of identical in‑flight GETs | none |
| `csrfInterceptor({ cookieName, header = 'X-CSRF-Token' })` | Cookie auth mode: copy CSRF cookie into header; `credentials: 'include'` | none |
| `deviceInterceptor({ getDeviceId })` | `X-Device-Id` (fingerprint supplied by host) | storage `deviceId` |
| `telemetryInterceptor({ telemetry })` | Timing + status per request, errors by code | telemetry `http_request` |
| `loggingInterceptor({ logger, redact = ['authorization','password','card','documents'] })` | Debug log of request/response with redaction | none |
| `mockInterceptor(handlers, { delayMs? })` | Dev only: short‑circuit matching requests with fixtures | none |

Default installation order (priority): correlation(10) → apiKey(20) → locale(30) → device(35) → csrf(40) → auth(50) → idempotency(60) → cache(70) → dedupe(80) → logging(90) → telemetry(95); response: envelope(10) → problem(20); error: problem(10) → auth(20) → rateLimit(30).

---

## 5. `auth/session.js`

Standalone script: it imports only `errors`, `utils` and the `http`/`store`/`events`/`storage` instances it is given. No domain module imports it; they get it through `ctx.auth`. Guest identity: the guest session id is also the **account key** — a guest can search, build an itinerary and book; afterwards `auth.claimAccount` lets the backend send an access link / OTP to the booking contact so the guest can set a password and own the account (bookings made under the guest token are attached to it).

#### `createAuth({ http, store, storage, events, config }) → Auth`
Effects: storage read (`refreshToken`, `guestId` if persisted) · state `session`.

#### `auth.getAccessToken() → string|null` · `auth.isAuthenticated() → boolean` · `auth.getUser() → User|null` · `auth.getSessionId() → string|null`
Synchronous reads. Effects: none.

#### `auth.setTokens({ accessToken, refreshToken?, expiresAt?, user? }) → void`
Host‑owned auth (SSO) injects tokens; schedules proactive refresh at `expiresAt - skew`.
Effects: state `session` · storage `refreshToken` (per `tokenStorage`) · timer refresh · emit `auth:login`.

#### `auth.clearTokens() → void`
Effects: state `session` → anonymous · storage remove · timer clear · emit `auth:logout`.

#### `auth.refresh(opts?) → Promise<Tokens>`
Single‑flight token refresh; concurrent callers share one request; requests queued by `authInterceptor` resume after.
Effects: net `POST /auth/refresh` · state `session` · storage · emit `auth:refreshed` | `auth:expired`.
Throws: `AuthError{reason:'expired'}`.

#### `auth.ensureGuestSession(opts?) → Promise<{ guestId, guestToken }>`
Create or reuse an anonymous session so carts / bookings work before login; the guest token is sent as `X-Guest-Token` and is the account key for later claim / merge.
Effects: net `POST /v1/sessions/guest` (only when none) · state `session.guestId`, `session.status='guest'` · storage `guestId`, `guestToken` · emit `auth:guest`.

#### `auth.isGuest() → boolean` · `auth.getGuestToken() → string|null`
Effects: none.

#### `auth.claimAccount({ bookingId?, channel: 'email'|'sms'|'whatsapp', destination? }, opts?) → Promise<{ sentTo: string, expiresAt: DateTime, challengeId: string }>`
Ask the backend to message the guest's booking contact with an access link / OTP to take over the account created from the guest session.
Effects: net `POST /v1/auth/claim` · state `session.claim` · emit `auth:claimSent`.
Throws: `AuthError{reason:'forbidden'}` (not a guest), `RateLimitError`.

#### `auth.completeClaim({ token?, challengeId?, otp?, password, consents? }, opts?) → Promise<User>`
Convert the guest session into a full account (keeps all bookings / travelers created under the guest token), set the password, log in.
Effects: net `POST /v1/auth/claim/complete` · state `session`, `account.user` · storage tokens (guest token removed) · emit `auth:claimed`, `auth:login`.
Throws: `AuthError{reason:'otp_invalid'|'otp_expired'}`, `ValidationError` (password policy).

#### `auth.register({ email?, phone?, password?, firstName?, lastName?, consents, otpChallengeId? }, opts?) → Promise<User>`
Create account, log in. Effects: net `POST /auth/register` · state `session`, `account.user` · storage · emit `auth:login`.

#### `auth.loginWithPassword({ identifier, password, remember? }, opts?) → Promise<User>`
Effects: net `POST /auth/login` · state `session`, `account.user` · storage · emit `auth:login` | `auth:mfaRequired`.
Throws: `AuthError{reason:'invalid_credentials'|'mfa_required'|'locked'}`.

#### `auth.requestOtp({ channel: 'sms'|'email'|'whatsapp', identifier, purpose: 'login'|'register'|'verify'|'reset' }, opts?) → Promise<{ challengeId, expiresAt, resendAfterMs }>`
Effects: net `POST /auth/otp/request`.

#### `auth.verifyOtp({ challengeId, code, remember? }, opts?) → Promise<User | { challengeId, requires: 'register' }>`
Effects: net `POST /auth/otp/verify` · state `session` · storage · emit `auth:login`. Throws: `AuthError{reason:'otp_invalid'|'otp_expired'}`.

#### `auth.getProviderUrl(provider, { redirectUri, state? }) → Promise<string>` · `auth.loginWithProvider({ provider, code?, idToken?, redirectUri?, nonce? }, opts?) → Promise<User>`
OAuth / OIDC (google, apple, facebook, …). Effects: net `GET /auth/providers/{p}/url`, `POST /auth/providers/{p}/callback` · state `session` · storage · emit `auth:login`.

#### `auth.requestMagicLink({ email, redirectUri }, opts?) → Promise<void>` · `auth.consumeMagicLink(token, opts?) → Promise<User>`
Effects: net `POST /auth/magic-link`, `POST /auth/magic-link/consume` · state · storage · emit `auth:login`.

#### `auth.mfa.verify({ challengeId, code, method }, opts?) → Promise<User>`
Second factor after `auth:mfaRequired`. Effects: net `POST /auth/mfa/verify` · state · emit `auth:login`.

#### `auth.logout({ everywhere? }, opts?) → Promise<void>`
Effects: net `POST /auth/logout` (best effort) · state `session`, `account`, `travelers`, `trips`, `wallet`, `alerts` reset · storage remove tokens · http abort tag `authed` · emit `auth:logout`.

#### `auth.onChange(fn: (session) => void) → off`
Effects: none.

#### `auth.willExpireWithin(ms) → boolean` · `auth.getExpiry() → DateTime|null`
Effects: none.
