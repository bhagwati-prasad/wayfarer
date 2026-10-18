# 03 · Utilities

Scripts under `utils/`. Everything here is pure (`Effects: none`) unless stated. Exposed as `client.utils.<script>.*` (every script as a namespace: `client.utils.validation.isGstin`, `client.utils.async.createQueue`, …) plus, flat, every helper of §1–§5, §7 and §8 and the factories (`client.utils.formatMoney`), and as the `@wayfarer/sdk/utils` entry; `object` helpers stay namespaced (`get`, `set`, `hash` are too generic for the flat surface).

---

## 1. `utils/money.js`

| signature | task |
|---|---|
| `money(amount: string\|number, currency) → Money` | Construct, normalising to the currency's decimals |
| `parseMoney(input: string\|number\|object, { currency?, minor? }) → Money` | Accept `"INR 1,234.50"`, `"₹1,234.50"` / bare numbers with `currency`, `{amount,currency}`; a number is a **major**‑unit amount unless `minor: true` (then an integer count of minor units: `123450` → `1234.50`) |
| `formatMoney(m, { locale?, display?: 'symbol'\|'code'\|'narrow', fraction?: 'auto'\|number, signDisplay? }) → string` | `Intl.NumberFormat` with per‑currency decimals (JPY 0, BHD 3) |
| `toMinor(m) → bigint` · `fromMinor(minor, currency) → Money` | Exact integer arithmetic base |
| `add(a, b)` · `subtract(a, b)` · `multiply(m, n)` · `sum(list)` · `negate(m)` → `Money` | Exact; throw `ValidationError` on currency mismatch |
| `compare(a, b) → -1\|0\|1` · `isZero(m)` · `isNegative(m)` · `min(list)` · `max(list)` | |
| `allocate(m, ratios: number[]) → Money[]` | Split without rounding loss (fees per pax) |
| `convert(m, to, rates: Record<string, number>, { round? }) → Money` | Display‑only FX |
| `currencyInfo(code) → Currency` | decimals, symbol, name |
| `pricePerPax(total, pax: PaxCounts, { includeInfants? }) → Money` | |

## 2. `utils/datetime.js`

| signature | task |
|---|---|
| `parseLocal(dt: DateTime) → { wall: Date, offsetMinutes, iso, localTimeOnly }` | Keep airport local time intact (no tz shift); `localTimeOnly` is `true` when the input carried no offset |
| `formatTime(dt, { locale?, hour12?, tz?: 'local'\|'airport' }) → string` · `formatDate(dt\|DateStr, { style?: 'short'\|'medium'\|'long'\|'weekday' })` · `formatDateTime` · `formatDateRange(a, b)` | Intl‑based |
| `formatDuration(minutes, { style?: 'short'\|'long'\|'compact', locale? }) → string` | `2h 35m` / `2 hr 35 min` |
| `durationBetween(a: DateTime, b: DateTime) → number` | minutes, offset‑aware |
| `dayDiff(a: DateTime, b: DateTime) → number` | `+1` badges (compares local calendar dates) |
| `isOvernight(a, b) → boolean` · `timeBucket(dt, { night? }) → TimeBucket` · `minutesOfDay(dt) → number` | `night: true` returns the `night` alias instead of `early_morning` |
| `addDays(d: DateStr, n)` · `diffDays(a, b)` · `today(tz?, now?)` · `isPast(dt)` · `toDateKey(Date)` · `fromDateKey(DateStr)` · `clampDate(d, min, max)` | |
| `monthMatrix(year, month, { firstDay? }) → (DateStr\|null)[][]` | Calendar grid |
| `relativeTime(dt, { locale?, style? }) → string` | "in 3 days", "2 hours ago" (`style: 'short'` → "2 hr. ago") |
| `countdown(until: DateTime\|number, onTick: (remainingMs) => void, { intervalMs?, timers?, now? }) → stop` | **Effects: timer** (`timers` / `now` injectable for tests) |
| `ageAt(dob: DateStr, on: DateStr) → number` | years |
| `paxTypeForAge(age, rules: AgeRules) → PaxType` | |

## 3. `utils/format.js`

| signature | task |
|---|---|
| `formatPlace(p: Place, style: 'code'\|'city'\|'city_code'\|'airport'\|'full' = 'city_code') → string` | `Delhi (DEL)` |
| `formatRoute(slices\|params, { arrow?, style? }) → string` | `DEL → BOM → DEL` (`style` as in `formatPlace`) |
| `formatStops(n, t) → string` · `formatLayovers(slice, t) → string` | `1 stop · 2h 10m in DXB` |
| `formatPaxSummary(pax: PaxCounts, t) → string` | `2 adults, 1 child` |
| `formatFlightNumber(seg) → string` · `formatOperatedBy(seg, t) → string\|null` | `AI 101`, `Operated by Vistara` |
| `formatCabin(cabin, t)` · `formatFareType(ft, t)` · `formatPaxType(pt, t)` | |
| `formatBaggage(rule: BagRule, t) → string` | `1 × 23 kg` |
| `formatName(traveler, { order?: 'given_first'\|'family_first', middle? = true, title? = false })` · `initials(traveler)` | |
| `maskEmail(e)` · `maskPhone(p)` · `maskCard(last4, brand)` · `maskDocument(number)` | PII‑safe display |
| `formatReference(ref) → string` · `formatSeat(seat)` · `titleCase(s)` · `truncate(s, n, ellipsis = '…')` | |

## 4. `utils/validation.js`

| signature | task |
|---|---|
| `validate(schema: Schema, value, ctx?) → ValidationResult` | Tiny schema runner (required / pattern / min / max / custom / when) |
| `schemas.searchParams(limits)` · `schemas.traveler(requirements, paxType)` · `schemas.contact(requirements)` · `schemas.document(rule)` · `schemas.gst()` · `schemas.address(country)` · `schemas.promo()` · `schemas.card()` · `schemas.password(policy)` | Prebuilt schemas |
| `isEmail(s)` · `isPhone(p: Phone)` · `isIata(s)` · `isPostalCode(s, country)` · `isPassportNumber(s, country?)` · `isGstin(s)` · `isPan(s)` · `isVpa(s)` · `isLuhn(s)` | |
| `isNameValid(s, { maxLength, charset })` · `namesFitTicket(first, last, max = 60)` | Airline name constraints |
| `documentValid(doc, travelDate, { minValidityMonths }) → ValidationIssue[]` | Expiry vs last travel date |
| `paxCountsValid(pax, rules: AgeRules) → ValidationIssue[]` | infants ≤ adults, total ≤ max, child ages |
| `travelerMatchesSlot(traveler, slot, rules, travelDate) → ValidationIssue[]` | Age vs type at travel date |
| `cardBrand(number) → 'visa'\|'mastercard'\|'amex'\|'rupay'\|'discover'\|'diners'\|'jcb'\|'unknown'` · `cardExpiryValid(mm, yy)` | Non‑hosted card entry only |
| `issuesByPath(result) → Record<string, ValidationIssue[]>` · `firstIssue(result, path)` | For UI binding |

## 5. `utils/async.js`

| signature | task / effects |
|---|---|
| `debounce(fn, ms, { leading?, trailing?, maxWait? })` · `throttle(fn, ms)` | returns fn with `.cancel()`, `.flush()` · **timer** |
| `singleFlight(keyFn, fn) → fn` | Share one in‑flight promise per key |
| `retry(fn, { retries, baseMs, maxMs, factor, jitter, retryOn, signal, onRetry }) → Promise` | Exponential backoff · **timer** |
| `poll(fn, { intervalMs, maxIntervalMs?, backoff?, until: (r) => boolean, maxAttempts?, maxMs?, signal?, onTick? }) → Promise & { cancel() }` | Honour `Retry-After` when `fn` returns `{ retryAfterMs }` · **timer** |
| `withTimeout(promise, ms, signal?)` · `sleep(ms, signal?)` · `deferred()` | **timer** |
| `combineSignals(...signals) → AbortSignal` · `timeoutSignal(ms)` · `isAbort(e)` | |
| `createQueue({ concurrency }) → { add(fn), size, onIdle() }` | |
| `onceAsync(fn)` · `memoAsync(fn, { ttlMs, keyFn })` | |

## 6. `utils/object.js`

`deepMerge(...objs)` · `deepFreeze(o)` · `deepEqual(a, b)` · `shallowEqual(a, b)` · `pick(o, keys)` · `omit(o, keys)` · `get(o, path, default?)` · `set(o, path, value) → newObj` · `stableStringify(o)` · `hash(str) → string` · `clone(o)` · `isPlainObject(o)` · `compact(o)` (drop `undefined`/`null`/`''`) · `groupBy(list, keyFn)` · `uniqBy(list, keyFn)` · `sortBy(list, ...keys)` · `chunk(list, n)` · `range(a, b)`

## 7. `utils/id.js`

`uuid()` · `shortId(n = 8)` · `requestId()` · `idempotencyKey(scope: string, payload?: object) → string` (stable 53‑bit hash of scope + payload: two different payloads in one scope collide with probability ≈ n²/2⁵⁴, fine per user / booking flow, not a cross‑tenant dedupe key) · `isUuid(s)`

## 8. `utils/url.js`

| signature | task |
|---|---|
| `buildQuery(obj, { arrayFormat?: 'repeat'\|'comma'\|'bracket', skipNull? }) → string` · `parseQuery(str) → object` | |
| `joinUrl(base, path)` · `withParams(url, params)` · `isAbsoluteUrl(s)` · `sameOrigin(a, b)` | `sameOrigin` resolves relative inputs against `window.location` at call time (SSR: two relative URLs are same‑origin, relative vs absolute is not) |
| `encodeSearchParams(p: SearchParams) → string` · `decodeSearchParams(str) → SearchParams\|null` | Compact, human‑readable deep‑link format (`DEL-BOM/2026-11-02/2026-11-09?a=2&c=1&cabin=Y`); the decoder also accepts a full URL / mount prefix and returns `null` on malformed input (never throws) |
| `encodeState(obj) → string` · `decodeState(str) → object\|null` | base64url JSON (objects / arrays only) for redirect round‑trips; `null` on malformed input |
| `currentUrlParams() → object` | Browser only |

## 9. `utils/i18n.js`

| signature | task / effects |
|---|---|
| `createI18n({ locale, messages?, fallback = 'en', pluralRules?, missing? }) → I18n` | |
| `i18n.t(key, vars?, { count?, default? }) → string` | ICU‑lite (`{name}`, `{count, plural, one{} other{}}`) |
| `i18n.setLocale(locale)` · `i18n.getLocale()` · `i18n.dir() → 'ltr'\|'rtl'` | **emit** `prefs:change` (via client) |
| `i18n.addMessages(locale, messages, { merge? })` · `i18n.hasKey(key, locale?)` · `i18n.loadMessages(locale, loader)` | `loader()` may resolve a `Messages` bundle, a `{ default }` module or a module namespace |
| `i18n.formatList(items)` · `i18n.formatNumber(n)` · `i18n.formatPercent(n)` | |
| `i18n.onChange(fn) → off` | `fn({ type: 'locale'\|'messages', locale, previous?, dir })` |
| `i18n.missing() → string[]` · `i18n.locales() → string[]` · `i18n.destroy()` | keys asked for but unresolved · locales with a bundle · drop listeners |

## 10. `utils/telemetry.js`

| signature | task / effects |
|---|---|
| `createTelemetry({ adapters?, enabled?, sampleRate?, context?, consent? }) → Telemetry` | |
| `telemetry.track(event, props?)` · `telemetry.page(name, props?)` · `telemetry.identify(userId, traits?)` · `telemetry.timing(name, ms, props?)` | Fan‑out to adapters · **emit** `telemetry:track` |
| `telemetry.setContext(partial)` · `telemetry.setConsent(bool)` · `telemetry.addAdapter(a) → remove` · `telemetry.flush()` | |
| `bindDomainEvents(telemetry, events) → off` | Maps SDK events → commerce events (`search:complete` → `view_item_list`, `offer:selected` → `select_item`, `itinerary:created` → `add_to_cart`, `booking:created` → `begin_checkout`, `payment:intentCreated` → `add_payment_info`, `booking:ticketed` → `purchase`, `trip:cancelled` → `refund`) |
| `ga4Adapter({ gtag })` · `gtmAdapter({ dataLayer })` · `segmentAdapter({ analytics })` · `consoleAdapter()` · `beaconAdapter({ url })` | `TelemetryAdapter = { name, track, page?, identify?, flush? }` |

## 11. `utils/logger.js`

`createLogger({ level, sink?, redact?, scope? }) → Logger` · `logger.debug/info/warn/error(msg, data?)` · `logger.child(scope)` · `logger.setLevel(level)` · `logger.redact(obj) → obj` (masks matching keys — `authorization`, `password`, `card`, `documents`, `passport`, … — and card‑PAN‑like values; document numbers have no detectable shape and are masked by key only)

## 12. `utils/features.js`

| signature | task / effects |
|---|---|
| `createFeatures({ initial?, source?: () => Promise<Record<string, unknown>>, events?, store? }) → Features` | `events` receives `features:change`; `store.bootstrap.flags` mirrors the effective flags |
| `features.isEnabled(flag, default = false) → boolean` · `features.variant(experiment, default?) → string` · `features.get(flag)` | |
| `features.set(flags)` · `features.override(flag, value)` (dev) · `features.clearOverrides()` | **state** `bootstrap.flags` · **emit** `features:change` |
| `features.load() → Promise<void>` | **net** via `source` (the client wires `client.bootstrap()`, i.e. `GET /v1/config`) |
| `features.onChange(fn) → off` · `features.destroy()` | |
