# 09 · Account: `account`, `wallet`, `alerts`

Scripts: `modules/account.js`, `modules/wallet.js`, `modules/alerts.js`. All require an authenticated session unless marked **guest‑ok**. Session lifecycle (login / register / logout / OTP / OAuth) lives in `auth` (`01-core.md §5`).

---

## 1. `modules/account.js`

#### `account.me({ fresh? } = {}, opts?) → Promise<User>`
Effects: net `GET /me` · state `account.user`, `session.user`.

#### `account.update(patch: Partial<User>, opts?) → Promise<User>`
Name, DOB, avatar etc. Effects: net `PATCH /me` · state `account.user` · emit `account:updated`.

#### `account.changeEmail({ email }, opts?) → Promise<{ challengeId }>` · `account.changePhone({ phone }, opts?) → Promise<{ challengeId }>` · `account.verifyChange({ challengeId, code }, opts?) → Promise<User>`
OTP‑verified identifier change. Effects: net `POST /me/email`, `POST /me/phone`, `POST /me/verify` · state `account.user` · emit `account:updated`.

#### `account.changePassword({ current, next }, opts?) → Promise<void>`
Effects: net `POST /me/password`. Throws: `AuthError{reason:'invalid_credentials'}`, `ValidationError` (policy).

#### `account.requestPasswordReset({ identifier }, opts?) → Promise<void>` **guest‑ok** · `account.resetPassword({ token, password }, opts?) → Promise<void>` **guest‑ok**
Effects: net `POST /auth/password/forgot`, `POST /auth/password/reset`.

#### `account.preferences.get({ fresh? } = {}, opts?) → Promise<Preferences>` · `account.preferences.set(patch: Partial<Preferences>, opts?) → Promise<Preferences>`
Server copy of currency / locale / home airport / seat & meal prefs / notification channels; `set` also applies to `client.prefs`.
Effects: net `GET|PATCH /me/preferences` · state `account.preferences`, `prefs` · storage `prefs` · emit `prefs:change`, `account:updated`.

#### `account.addresses.list(opts?)` · `.create(address, opts?)` · `.update(id, patch, opts?)` · `.remove(id, opts?)` · `.setDefault(id, opts?)`
Billing addresses. Effects: net `GET|POST|PATCH|DELETE /me/addresses[/{id}]` · state `account.addresses`.

#### `account.billingProfiles.list(opts?)` · `.create({ gst, company, address }, opts?)` · `.remove(id, opts?)`
Saved GST / company invoice profiles. Effects: net `GET|POST|DELETE /me/billing-profiles[/{id}]` · state `account.billingProfiles`.

#### `account.notifications.list({ unreadOnly?, cursor? } = {}, opts?) → Promise<Page<Notification>>` · `.markRead(ids|'all', opts?)` · `.unreadCount(opts?) → Promise<number>`
In‑app inbox (price alerts hit, schedule changes, refunds). Effects: net `GET /me/notifications`, `POST /me/notifications/read` · state `account.notifications`.

#### `account.notifications.registerPush({ token, platform }, opts?)` · `.unregisterPush(token, opts?)`
Effects: net `POST|DELETE /me/push-tokens`.

#### `account.sessions.list(opts?) → Promise<{ id, device, ip, lastSeen, current }[]>` · `.revoke(id, opts?)` · `.revokeOthers(opts?)`
Effects: net `GET /me/sessions`, `DELETE /me/sessions/{id}`, `POST /me/sessions/revoke-others` · state `account.sessions`.

#### `account.mfa.status(opts?) → Promise<{ enabled, methods }>` · `.enable({ method: 'totp'|'sms'|'email' }, opts?) → Promise<{ secret?, qr?, challengeId }>` · `.confirm({ challengeId, code }, opts?) → Promise<{ recoveryCodes }>` · `.disable({ code }, opts?)` · `.recoveryCodes({ regenerate? }, opts?)`
Effects: net `/me/mfa/*` · state `account.mfa`.

#### `account.providers.list(opts?)` · `.link(provider, { code|idToken, redirectUri }, opts?)` · `.unlink(provider, opts?)`
Social login linkage. Effects: net `GET|POST|DELETE /me/providers[/{p}]` · state `account.user.providers`.

#### `account.consents.get(opts?) → Promise<Consent[]>` · `account.consents.set({ marketing?, analytics?, personalization?, terms?: version }, opts?) → Promise<Consent[]>`
Records with policy version + timestamp; `analytics:false` also calls `telemetry.setConsent(false)`.
Effects: net `GET|PUT /me/consents` · state `account.consents` · telemetry consent.

#### `account.exportData(opts?) → Promise<{ requestId, eta }>` · `account.exportStatus(requestId, opts?) → Promise<{ status, url? }>`
GDPR / DPDP data portability. Effects: net `POST /me/export`, `GET /me/export/{id}`.

#### `account.delete({ password?, otpChallenge?, reason? }, opts?) → Promise<void>`
Effects: net `POST /me/delete` · then `auth.logout()` (state reset, storage cleared).

---

## 2. `modules/wallet.js`

#### `wallet.balance({ fresh? } = {}, opts?) → Promise<WalletBalance>`
Effects: net `GET /me/wallet` · state `wallet.balance` · emit `wallet:updated`.

#### `wallet.transactions({ cursor?, limit?, type? } = {}, opts?) → Promise<Page<WalletTxn>>`
Effects: net `GET /me/wallet/transactions`.

#### `wallet.loyalty.status({ fresh? } = {}, opts?) → Promise<LoyaltyStatus>` · `wallet.loyalty.history({ cursor? } = {}, opts?) → Promise<Page<LoyaltyTxn>>`
Effects: net `GET /me/loyalty`, `GET /me/loyalty/history` · state `wallet.loyalty`.

#### `wallet.loyalty.earnPreview(itineraryId?, opts?) → Promise<{ points, tierProgress }>`
"Earn 540 points on this booking". Effects: net `GET /itineraries/{id}/loyalty-preview`.

#### `wallet.loyalty.redeemOptions(bookingId?, opts?) → Promise<{ maxPoints, value: Money, step }>`
Effects: net `GET /bookings/{id}/loyalty-redeem-options`.

#### `wallet.coupons.eligible(itineraryId?, opts?) → Promise<Coupon[]>` **guest‑ok** · `wallet.coupons.validate(code, itineraryId?, opts?) → Promise<Coupon>` **guest‑ok** · `wallet.coupons.mine(opts?) → Promise<Coupon[]>`
Effects: net `GET /itineraries/{id}/promos`, `POST /promos/validate`, `GET /me/coupons` · state `wallet.coupons`.

#### `wallet.giftCards.check(code, { pin? } = {}, opts?) → Promise<{ balance: Money, expiresAt }>` **guest‑ok** · `wallet.giftCards.mine(opts?)` · `wallet.giftCards.redeemToWallet(code, opts?)`
Effects: net `POST /gift-cards/check`, `GET /me/gift-cards`, `POST /me/gift-cards/redeem` · state `wallet.balance`.

#### `wallet.vouchers.list({ fresh? } = {}, opts?) → Promise<Voucher[]>` · `wallet.vouchers.applicable(itineraryId?, opts?) → Promise<Voucher[]>`
Airline / OTA credits issued on cancellations. Effects: net `GET /me/vouchers`, `GET /itineraries/{id}/vouchers` · state `wallet.vouchers`.

#### `wallet.referrals.code(opts?) → Promise<{ code, url, reward }>` · `wallet.referrals.stats(opts?) → Promise<{ invited, joined, earned: Money }>` · `wallet.referrals.apply(code, opts?) → Promise<void>`
Effects: net `GET /me/referrals`, `GET /me/referrals/stats`, `POST /me/referrals/apply`.

---

## 3. `modules/alerts.js`

#### `alerts.create({ params: PriceAlert['params'], targetPrice?, channels?, frequency? }, opts?) → Promise<PriceAlert>`
Watch a route/dates; `params` may be the current `SearchParams`. Effects: net `POST /me/alerts` · state `alerts.items` · emit `alerts:changed` · telemetry.

#### `alerts.createGuest({ email, params, targetPrice?, consent: true }, opts?) → Promise<{ id, verifyRequired }>` **guest‑ok** · `alerts.unsubscribe(token, opts?) → Promise<void>` **guest‑ok**
Email‑only alerts for anonymous users (verify / unsubscribe via emailed token). Effects: net `POST /alerts/guest`, `POST /alerts/unsubscribe`.

#### `alerts.list({ fresh? } = {}, opts?) → Promise<PriceAlert[]>` · `alerts.get(id, opts?) → Promise<PriceAlert>`
Effects: net `GET /me/alerts[/{id}]` · state `alerts.items`.

#### `alerts.update(id, patch, opts?) → Promise<PriceAlert>` · `alerts.pause(id, opts?)` · `alerts.resume(id, opts?)` · `alerts.remove(id, opts?) → Promise<void>`
Effects: net `PATCH|DELETE /me/alerts/{id}` · state · emit `alerts:changed`.

#### `alerts.history(id, opts?) → Promise<{ date: DateStr, price: Money }[]>`
Observed price points for the alert. Effects: net `GET /me/alerts/{id}/history`.

#### `alerts.forSearch(params) → PriceAlert|null`
Is the current search already tracked? Effects: none.

#### `alerts.savedSearches.save(params, { name? } = {}, opts?) → Promise<SavedSearch>` · `.list(opts?)` · `.remove(id, opts?)` · `.run(id, opts?) → Promise<SearchSession>`
Effects: net `POST|GET|DELETE /me/saved-searches[/{id}]` · state `alerts.savedSearches`; `run` → `search.create`.

#### `alerts.favorites.add(offerId|{ route }, opts?)` · `.list(opts?)` · `.remove(id, opts?)`
Favourite routes / offers (offers expire; route is kept). Effects: net `/me/favorites` · state `alerts.favorites`.
