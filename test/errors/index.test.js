import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SdkError,
  ConfigError,
  ValidationError,
  NetworkError,
  TimeoutError,
  AbortError,
  StorageError,
  UnsupportedError,
  ApiError,
  AuthError,
  RateLimitError,
  NotFoundError,
  ConflictError,
  SearchExpiredError,
  OfferExpiredError,
  OfferUnavailableError,
  PriceChangedError,
  ItineraryExpiredError,
  BookingError,
  PaymentError,
  ServicingError,
  UnprocessableError,
  isSdkError,
  isRetryable,
  is,
  errorFromProblem,
  errorFromResponse,
  wrap,
  toUserMessage,
  ERROR_CODES,
} from '../../src/errors/index.js';

const SERVER_DETAIL = 'pg: connection refused at db-internal.ota.svc:5432 (trace 0xdeadbeef)';
const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' };

const BASE_CLASSES = [
  [SdkError, 'SDK_ERROR', false],
  [ConfigError, 'CONFIG_ERROR', false],
  [ValidationError, 'VALIDATION_FAILED', false],
  [NetworkError, 'NETWORK_ERROR', true],
  [TimeoutError, 'TIMEOUT', true],
  [AbortError, 'ABORTED', false],
  [StorageError, 'STORAGE_ERROR', false],
  [UnsupportedError, 'UNSUPPORTED', false],
];

const API_CLASSES = [
  [ApiError, 'API_ERROR', false, 0],
  [AuthError, 'UNAUTHENTICATED', false, 401],
  [RateLimitError, 'RATE_LIMITED', true, 429],
  [NotFoundError, 'NOT_FOUND', false, 404],
  [ConflictError, 'CONFLICT', false, 409],
  [SearchExpiredError, 'SEARCH_EXPIRED', false, 410],
  [OfferExpiredError, 'OFFER_EXPIRED', false, 410],
  [OfferUnavailableError, 'OFFER_UNAVAILABLE', false, 410],
  [PriceChangedError, 'PRICE_CHANGED', false, 409],
  [ItineraryExpiredError, 'ITINERARY_EXPIRED', false, 410],
  [BookingError, 'BOOKING_FAILED', false, 422],
  [PaymentError, 'PAYMENT_GATEWAY_ERROR', true, 402],
  [ServicingError, 'SERVICING_NOT_ALLOWED', false, 409],
  [UnprocessableError, 'UNPROCESSABLE', false, 422],
];

afterEach(() => {
  vi.useRealTimers();
});

describe('class tree', () => {
  it.each(BASE_CLASSES)(
    '%o has name, stable code and retryable default',
    (Class, code, retryable) => {
      const err = new Class('boom');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SdkError);
      expect(err).toBeInstanceOf(Class);
      expect(err.name).toBe(Class.name);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.message).toBe('boom');
      expect(typeof err.at).toBe('number');
      expect(err.stack).toBeDefined();
    }
  );

  it.each(API_CLASSES)(
    '%o is an ApiError with name, code, retryable and status defaults',
    (Class, code, retryable, status) => {
      const err = new Class('boom');
      expect(err).toBeInstanceOf(SdkError);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toBeInstanceOf(Class);
      expect(err.name).toBe(Class.name);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.status).toBe(status);
      expect(err.meta).toEqual({});
      expect(err.details).toEqual({});
      expect(err.problem).toBeUndefined();
    }
  );

  it('ApiError subclasses are not instances of their siblings', () => {
    expect(new AuthError('x')).not.toBeInstanceOf(RateLimitError);
    expect(new NotFoundError('x')).not.toBeInstanceOf(ConflictError);
    expect(new NetworkError('x')).not.toBeInstanceOf(ApiError);
  });

  it('SdkError keeps the common fields and defaults the message', () => {
    const cause = new Error('inner');
    const err = new SdkError('', {
      code: 'CUSTOM',
      cause,
      requestId: 'req-1',
      retryable: true,
      details: { a: 1 },
      at: 1000,
    });
    expect(err.message).toBe('Unknown error');
    expect(err.code).toBe('CUSTOM');
    expect(err.cause).toBe(cause);
    expect(err.requestId).toBe('req-1');
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ a: 1 });
    expect(err.at).toBe(1000);
    expect(new SdkError('x', { code: '' }).code).toBe('SDK_ERROR');
    expect(new SdkError('x', { retryable: 'yes' }).retryable).toBe(false);
  });

  it('toJSON drops cause and stack but keeps class fields', () => {
    const err = new OfferExpiredError('gone', { offerId: 'o1', cause: new Error('x'), at: 5 });
    const json = JSON.parse(JSON.stringify(err));
    expect(json).toMatchObject({
      name: 'OfferExpiredError',
      code: 'OFFER_EXPIRED',
      message: 'gone',
      offerId: 'o1',
      status: 410,
      retryable: false,
      at: 5,
    });
    expect(json.cause).toBeUndefined();
    expect(json.stack).toBeUndefined();
  });

  it('caller options override class defaults but undefined does not clobber them', () => {
    const err = new NotFoundError('x', {
      code: undefined,
      status: undefined,
      retryable: undefined,
    });
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
    const custom = new NotFoundError('x', { code: 'TRIP_NOT_FOUND', status: 410, retryable: true });
    expect(custom.code).toBe('TRIP_NOT_FOUND');
    expect(custom.status).toBe(410);
    expect(custom.retryable).toBe(true);
  });

  it('ValidationError carries issues[]', () => {
    const issues = [{ path: 'origin', code: 'required', message: 'Origin is required' }];
    expect(new ValidationError('bad', { issues }).issues).toBe(issues);
    expect(new ValidationError('bad').issues).toEqual([]);
    expect(new ValidationError('bad', { issues: 'nope' }).issues).toEqual([]);
  });

  it('TimeoutError, AbortError and UnsupportedError carry their fields', () => {
    expect(new TimeoutError('t', { timeoutMs: 2000 }).timeoutMs).toBe(2000);
    expect(new TimeoutError('t').timeoutMs).toBeUndefined();
    expect(new AbortError('a', { reason: 'destroyed' }).reason).toBe('destroyed');
    expect(new AbortError('a').reason).toBe('aborted');
    expect(new UnsupportedError('u', { feature: 'sse' }).feature).toBe('sse');
    expect(new UnsupportedError('u').feature).toBe('unknown');
  });

  it('ApiError keeps problem, issues, details (extensions) and meta', () => {
    const problem = {
      type: 'https://api.ota.com/problems/x',
      title: 'X',
      status: 400,
      errors: [{ code: 1, detail: 'd' }],
      offerId: 'o1',
    };
    const err = new ApiError('x', { status: 400, problem, meta: { contentType: 'a' } });
    expect(err.problem).toBe(problem);
    expect(err.issues).toBe(problem.errors);
    expect(err.details).toEqual({ offerId: 'o1' });
    expect(err.meta).toEqual({ contentType: 'a' });
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('x');
    expect(new ApiError('', { status: 503 }).message).toBe('Service unavailable (HTTP 503)');
    expect(new ApiError('', { status: 418 }).code).toBe('HTTP_418');
    expect(new ApiError('', { status: '404' }).status).toBe(404);
  });

  it('ApiError retryable follows the transport policy (408/425/429/5xx)', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(new ApiError('x', { status }).retryable).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      expect(new ApiError('x', { status }).retryable).toBe(false);
    }
  });

  it('AuthError derives code, status and message from reason', () => {
    expect(new AuthError('x').reason).toBe('unauthenticated');
    const forbidden = new AuthError('', { reason: 'forbidden' });
    expect(forbidden.code).toBe('FORBIDDEN');
    expect(forbidden.status).toBe(403);
    expect(forbidden.message).toBe('Access denied');
    const expired = new AuthError('', { reason: 'expired' });
    expect(expired.code).toBe('SESSION_EXPIRED');
    expect(expired.status).toBe(401);
    expect(new AuthError('x', { reason: 'locked' }).code).toBe('ACCOUNT_LOCKED');
    expect(new AuthError('x', { reason: 'otp_invalid' }).code).toBe('OTP_INVALID');
    expect(new AuthError('x', { reason: 'bogus' }).reason).toBe('unauthenticated');
    expect(new AuthError('x', { reason: 'expired' }).retryable).toBe(false);
  });

  it('RateLimitError keeps a non-negative retryAfterMs', () => {
    expect(new RateLimitError('x', { retryAfterMs: 1500 }).retryAfterMs).toBe(1500);
    expect(new RateLimitError('x', { retryAfterMs: -1 }).retryAfterMs).toBeUndefined();
    expect(new RateLimitError('x').retryAfterMs).toBeUndefined();
  });

  it('domain subclasses carry their identifying fields', () => {
    expect(new SearchExpiredError('x', { sessionId: 's1' }).sessionId).toBe('s1');
    expect(new OfferExpiredError('x', { offerId: 'o1' }).offerId).toBe('o1');
    const unavailable = new OfferUnavailableError('x', { offerId: 'o2', reason: 'withdrawn' });
    expect(unavailable.offerId).toBe('o2');
    expect(unavailable.reason).toBe('withdrawn');
    expect(new OfferUnavailableError('x').reason).toBe('sold_out');
    const price = new PriceChangedError('x', {
      from: { amount: '100.00', currency: 'INR' },
      to: { amount: 120, currency: 'INR' },
      newOfferId: 'o3',
      itineraryId: 'i1',
    });
    expect(price.from).toEqual({ amount: '100.00', currency: 'INR' });
    expect(price.to).toEqual({ amount: '120', currency: 'INR' });
    expect(price.newOfferId).toBe('o3');
    expect(price.itineraryId).toBe('i1');
    expect(new PriceChangedError('x', { from: 'nope' }).from).toBeUndefined();
    expect(new ItineraryExpiredError('x', { itineraryId: 'i2' }).itineraryId).toBe('i2');
  });

  it('BookingError defaults stage/recoverable/suggestedAction and ties retryable to recoverable', () => {
    const err = new BookingError('x');
    expect(err.stage).toBe('create');
    expect(err.recoverable).toBe(false);
    expect(err.suggestedAction).toBe('contact_support');
    expect(err.retryable).toBe(false);
    const rec = new BookingError('x', { stage: 'ticketing', recoverable: true });
    expect(rec.stage).toBe('ticketing');
    expect(rec.suggestedAction).toBe('retry_payment');
    expect(rec.retryable).toBe(true);
    expect(new BookingError('x', { suggestedAction: 'wait' }).suggestedAction).toBe('wait');
    expect(new BookingError('x', { stage: 'nope' }).stage).toBe('create');
  });

  it('PaymentError derives code and retryable from reason', () => {
    const declined = new PaymentError('x', { reason: 'declined' });
    expect(declined.code).toBe('PAYMENT_DECLINED');
    expect(declined.retryable).toBe(true);
    const fraud = new PaymentError('x', { reason: 'fraud' });
    expect(fraud.code).toBe('PAYMENT_FRAUD');
    expect(fraud.retryable).toBe(false);
    expect(new PaymentError('x', { reason: 'requires_action' }).code).toBe(
      'PAYMENT_REQUIRES_ACTION'
    );
    expect(new PaymentError('x', { reason: 'declined', retryable: false }).retryable).toBe(false);
    expect(new PaymentError('x', { reason: 'bogus' }).reason).toBe('gateway');
  });

  it('ServicingError derives code from action', () => {
    const change = new ServicingError('x', { action: 'change', reason: 'past_departure' });
    expect(change.code).toBe('CHANGE_NOT_ALLOWED');
    expect(change.action).toBe('change');
    expect(change.reason).toBe('past_departure');
    expect(new ServicingError('x', { action: 'cancel_partial' }).code).toBe('CANCEL_NOT_ALLOWED');
    const other = new ServicingError('x', { action: 'split_pnr' });
    expect(other.code).toBe('SERVICING_NOT_ALLOWED');
    expect(other.reason).toBe('not_allowed');
    expect(new ServicingError('x', { action: 'nope' }).action).toBe('support');
  });

  it('UnprocessableError derives fieldErrors from options or issues', () => {
    const explicit = new UnprocessableError('x', {
      fieldErrors: { email: ['Invalid'], name: 'Req' },
    });
    expect(explicit.fieldErrors).toEqual({ email: ['Invalid'], name: ['Req'] });
    const fromIssues = new UnprocessableError('x', {
      issues: [
        {
          code: 477,
          detail: 'Invalid format',
          source: { pointer: '/data/travelers/0/dateOfBirth' },
        },
        { title: 'Missing', source: { parameter: 'promoCode' } },
        { code: 'E1' },
      ],
    });
    expect(fromIssues.fieldErrors).toEqual({
      'data.travelers.0.dateOfBirth': ['Invalid format'],
      promoCode: ['Missing'],
      _: ['E1'],
    });
    expect(new UnprocessableError('x').fieldErrors).toEqual({});
  });
});

describe('isSdkError / isRetryable / is', () => {
  it('isSdkError recognises the tree and branded foreign copies, rejects the rest', () => {
    expect(isSdkError(new SdkError('x'))).toBe(true);
    expect(isSdkError(new PaymentError('x'))).toBe(true);
    expect(isSdkError(new Error('x'))).toBe(false);
    expect(isSdkError(null)).toBe(false);
    expect(isSdkError('x')).toBe(false);
    const foreign = Object.create({ [Symbol.for('@wayfarer/sdk/SdkError')]: true });
    foreign.code = 'OFFER_EXPIRED';
    expect(isSdkError(foreign)).toBe(true);
  });

  it('isRetryable is correct per class and normalises non-SDK values', () => {
    expect(isRetryable(new NetworkError('x'))).toBe(true);
    expect(isRetryable(new TimeoutError('x'))).toBe(true);
    expect(isRetryable(new RateLimitError('x'))).toBe(true);
    expect(isRetryable(new ApiError('x', { status: 503 }))).toBe(true);
    expect(isRetryable(new ApiError('x', { status: 400 }))).toBe(false);
    expect(isRetryable(new ValidationError('x'))).toBe(false);
    expect(isRetryable(new AuthError('x'))).toBe(false);
    expect(isRetryable(new OfferExpiredError('x'))).toBe(false);
    expect(isRetryable(new PaymentError('x', { reason: 'fraud' }))).toBe(false);
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryable(new Error('nope'))).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it('is() matches classes across the tree and codes by string', () => {
    const err = new OfferExpiredError('x');
    expect(is(err, OfferExpiredError)).toBe(true);
    expect(is(err, ApiError)).toBe(true);
    expect(is(err, SdkError)).toBe(true);
    expect(is(err, NotFoundError)).toBe(false);
    expect(is(err, 'OFFER_EXPIRED')).toBe(true);
    expect(is(err, 'NOT_FOUND')).toBe(false);
    expect(is(new Error('x'), SdkError)).toBe(false);
    expect(is(null, SdkError)).toBe(false);
    expect(is(err, 42)).toBe(false);
  });

  it('is() falls back to constructor names for branded errors from another SDK copy', () => {
    class ForeignSdkError extends Error {}
    Object.defineProperty(ForeignSdkError.prototype, Symbol.for('@wayfarer/sdk/SdkError'), {
      value: true,
    });
    class ForeignApiError extends ForeignSdkError {}
    Object.defineProperty(ForeignApiError, 'name', { value: 'ApiError' });
    Object.defineProperty(ForeignSdkError, 'name', { value: 'SdkError' });
    const foreign = new ForeignApiError('x');
    expect(foreign instanceof ApiError).toBe(false);
    expect(is(foreign, ApiError)).toBe(true);
    expect(is(foreign, SdkError)).toBe(true);
    expect(is(foreign, NotFoundError)).toBe(false);
  });
});

describe('errorFromProblem', () => {
  const problem = (over = {}) => ({
    type: 'https://api.ota.com/problems/offer-expired',
    title: 'Offer expired',
    status: 410,
    detail: 'Offer o-1 expired at 10:00',
    instance: '/flights/offers/o-1/price',
    requestId: 'req-9',
    offerId: 'o-1',
    ...over,
  });

  it('maps by problem.code first and keeps problem, requestId, details and message', () => {
    const err = errorFromProblem(problem({ code: 'SOLD_OUT' }));
    expect(err).toBeInstanceOf(OfferUnavailableError);
    expect(err.code).toBe('SOLD_OUT');
    expect(err.reason).toBe('sold_out');
    expect(err.offerId).toBe('o-1');
    expect(err.status).toBe(410);
    expect(err.message).toBe('Offer o-1 expired at 10:00');
    expect(err.requestId).toBe('req-9');
    expect(err.problem).toMatchObject({
      type: problem().type,
      title: 'Offer expired',
      status: 410,
    });
    expect(err.details).toEqual({ offerId: 'o-1' });
    expect(err.problem.instance).toBe('/flights/offers/o-1/price');
    expect(err.retryable).toBe(false);
  });

  it('falls back to the last path segment of type, then to status', () => {
    const byType = errorFromProblem(problem());
    expect(byType).toBeInstanceOf(OfferExpiredError);
    expect(byType.code).toBe('OFFER_EXPIRED');
    expect(byType.offerId).toBe('o-1');

    const camel = errorFromProblem({ type: 'urn:ota:problem:priceChanged', status: 409 });
    expect(camel).toBeInstanceOf(PriceChangedError);
    expect(camel.code).toBe('PRICE_CHANGED');

    const blank = errorFromProblem({ type: 'about:blank', title: 'Nope', status: 404 });
    expect(blank).toBeInstanceOf(NotFoundError);
    expect(blank.code).toBe('NOT_FOUND');
    expect(blank.message).toBe('Nope');

    const numericType = errorFromProblem({ type: 'https://httpstatuses.com/409', status: 409 });
    expect(numericType).toBeInstanceOf(ConflictError);
    expect(numericType.code).toBe('CONFLICT');
  });

  it('an unknown code keeps the code and maps the class by status', () => {
    const err = errorFromProblem({ type: 'about:blank', status: 400, code: 'weird-thing' });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.constructor).toBe(ApiError);
    expect(err.code).toBe('WEIRD_THING');
    const unknown500 = errorFromProblem({
      type: 'about:blank',
      status: 500,
      code: 'UPSTREAM_DOWN',
    });
    expect(unknown500.code).toBe('UPSTREAM_DOWN');
    expect(unknown500.retryable).toBe(true);
    const seat = errorFromProblem({ type: 'about:blank', status: 409, code: 'SEAT_TAKEN' });
    expect(seat).toBeInstanceOf(ConflictError);
    expect(seat.code).toBe('SEAT_TAKEN');
  });

  it.each([
    [401, AuthError, 'UNAUTHENTICATED', false],
    [403, AuthError, 'FORBIDDEN', false],
    [404, NotFoundError, 'NOT_FOUND', false],
    [409, ConflictError, 'CONFLICT', false],
    [422, UnprocessableError, 'UNPROCESSABLE', false],
    [429, RateLimitError, 'RATE_LIMITED', true],
    [400, ApiError, 'BAD_REQUEST', false],
    [500, ApiError, 'INTERNAL_ERROR', true],
    [502, ApiError, 'BAD_GATEWAY', true],
    [503, ApiError, 'SERVER_UNAVAILABLE', true],
  ])('status %i falls back to %o', (status, Class, code, retryable) => {
    const err = errorFromProblem({ type: 'about:blank', title: 'T', status });
    expect(err).toBeInstanceOf(Class);
    expect(err.constructor).toBe(Class);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(retryable);
    expect(err.name).toBe(Class.name);
  });

  it('403 yields AuthError{forbidden}, 401 unauthenticated, codes set the reason', () => {
    expect(errorFromProblem({ type: 'about:blank', status: 403 }).reason).toBe('forbidden');
    expect(errorFromProblem({ type: 'about:blank', status: 401 }).reason).toBe('unauthenticated');
    const expired = errorFromProblem({ type: 'about:blank', status: 401, code: 'SESSION_EXPIRED' });
    expect(expired).toBeInstanceOf(AuthError);
    expect(expired.reason).toBe('expired');
    expect(expired.code).toBe('SESSION_EXPIRED');
    const mfa = errorFromProblem({ type: 'about:blank', status: 401, code: 'MFA_REQUIRED' });
    expect(mfa.reason).toBe('mfa_required');
    const explicitReason = errorFromProblem({ type: 'about:blank', status: 401, reason: 'locked' });
    expect(explicitReason.reason).toBe('locked');
  });

  it.each([
    ['OFFER_EXPIRED', OfferExpiredError],
    ['PRICE_CHANGED', PriceChangedError],
    ['SOLD_OUT', OfferUnavailableError],
    ['OFFER_UNAVAILABLE', OfferUnavailableError],
    ['SEARCH_EXPIRED', SearchExpiredError],
    ['ITINERARY_EXPIRED', ItineraryExpiredError],
    ['PAYMENT_DECLINED', PaymentError],
    ['PAYMENT_REQUIRES_ACTION', PaymentError],
    ['HOLD_NOT_ALLOWED', BookingError],
    ['CHANGE_NOT_ALLOWED', ServicingError],
    ['CANCEL_NOT_ALLOWED', ServicingError],
    ['NAME_MISMATCH', UnprocessableError],
    ['DOCUMENT_INVALID', UnprocessableError],
    ['PROMO_INVALID', UnprocessableError],
    ['SESSION_EXPIRED', AuthError],
    ['RATE_LIMITED', RateLimitError],
    ['UNAUTHENTICATED', AuthError],
    ['FORBIDDEN', AuthError],
    ['NOT_FOUND', NotFoundError],
    ['CONFLICT', ConflictError],
    ['VALIDATION_FAILED', UnprocessableError],
  ])('default map: %s → %o (code wins over status)', (code, Class) => {
    const err = errorFromProblem({ type: 'about:blank', title: 'T', status: 400, code });
    expect(err).toBeInstanceOf(Class);
    expect(err.constructor).toBe(Class);
    expect(err.code).toBe(code);
    expect(err.name).toBe(Class.name);
    expect(err.status).toBe(400);
    expect(err.message).toBe('T');
  });

  it('extracts class-specific fields from extension members', () => {
    const price = errorFromProblem({
      type: 'about:blank',
      status: 409,
      code: 'PRICE_CHANGED',
      from: { amount: '5000.00', currency: 'INR' },
      to: { amount: '5400.00', currency: 'INR' },
      newOfferId: 'o-2',
      itineraryId: 'it-1',
    });
    expect(price.from).toEqual({ amount: '5000.00', currency: 'INR' });
    expect(price.to).toEqual({ amount: '5400.00', currency: 'INR' });
    expect(price.newOfferId).toBe('o-2');
    expect(price.itineraryId).toBe('it-1');

    const search = errorFromProblem({
      type: 'about:blank',
      status: 410,
      code: 'SEARCH_EXPIRED',
      sessionId: 's-1',
    });
    expect(search.sessionId).toBe('s-1');

    const itin = errorFromProblem({
      type: 'about:blank',
      status: 410,
      code: 'ITINERARY_EXPIRED',
      itineraryId: 'it-2',
    });
    expect(itin.itineraryId).toBe('it-2');

    const withdrawn = errorFromProblem({
      type: 'about:blank',
      status: 410,
      code: 'OFFER_UNAVAILABLE',
      offerId: 'o-9',
    });
    expect(withdrawn.reason).toBe('withdrawn');
    expect(withdrawn.offerId).toBe('o-9');
    const schedule = errorFromProblem({
      type: 'about:blank',
      status: 410,
      code: 'SOLD_OUT',
      reason: 'schedule_changed',
    });
    expect(schedule.reason).toBe('schedule_changed');

    const hold = errorFromProblem({ type: 'about:blank', status: 409, code: 'HOLD_NOT_ALLOWED' });
    expect(hold.stage).toBe('hold');
    expect(hold.recoverable).toBe(false);
    expect(hold.suggestedAction).toBe('retry_payment');
    expect(hold.retryable).toBe(false);
    const booking = errorFromProblem({
      type: 'about:blank',
      status: 500,
      code: 'BOOKING_FAILED',
      stage: 'ticketing',
      recoverable: true,
      suggestedAction: 'wait',
    });
    expect(booking.stage).toBe('ticketing');
    expect(booking.recoverable).toBe(true);
    expect(booking.suggestedAction).toBe('wait');
    expect(booking.retryable).toBe(true);

    const declined = errorFromProblem({
      type: 'about:blank',
      status: 402,
      code: 'PAYMENT_DECLINED',
    });
    expect(declined.reason).toBe('declined');
    expect(declined.retryable).toBe(true);
    const action = errorFromProblem({
      type: 'about:blank',
      status: 402,
      code: 'PAYMENT_REQUIRES_ACTION',
    });
    expect(action.reason).toBe('requires_action');
    const fraud = errorFromProblem({
      type: 'about:blank',
      status: 402,
      code: 'PAYMENT_DECLINED',
      reason: 'fraud',
    });
    expect(fraud.reason).toBe('fraud');
    expect(fraud.retryable).toBe(false);
    const balance = errorFromProblem({
      type: 'about:blank',
      status: 402,
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(balance).toBeInstanceOf(PaymentError);
    expect(balance.reason).toBe('insufficient_funds');

    const change = errorFromProblem({
      type: 'about:blank',
      status: 409,
      code: 'CHANGE_NOT_ALLOWED',
      reason: 'departed',
    });
    expect(change.action).toBe('change');
    expect(change.reason).toBe('departed');
    const cancel = errorFromProblem({
      type: 'about:blank',
      status: 409,
      code: 'CANCEL_NOT_ALLOWED',
    });
    expect(cancel.action).toBe('cancel');
    expect(cancel.reason).toBe('not_allowed');
    const servicing = errorFromProblem({
      type: 'about:blank',
      status: 409,
      code: 'CANCEL_NOT_ALLOWED',
      action: 'cancel_partial',
    });
    expect(servicing.action).toBe('cancel_partial');

    const rate = errorFromProblem({ type: 'about:blank', status: 429, retryAfter: 7 });
    expect(rate.retryAfterMs).toBe(7000);
    const rateMs = errorFromProblem({ type: 'about:blank', status: 429, retryAfterMs: 250 });
    expect(rateMs.retryAfterMs).toBe(250);
    expect(errorFromProblem({ type: 'about:blank', status: 429 }).retryAfterMs).toBeUndefined();
  });

  it('keeps Amadeus-style errors[] as issues and builds fieldErrors from them', () => {
    const err = errorFromProblem({
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [
        {
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'invalid date',
          source: { pointer: '/data/travelers/0/dateOfBirth' },
        },
        {
          status: 400,
          code: 32171,
          title: 'MANDATORY DATA MISSING',
          source: { parameter: 'originLocationCode' },
        },
      ],
    });
    expect(err).toBeInstanceOf(UnprocessableError);
    expect(err.issues).toHaveLength(2);
    expect(err.issues[0].code).toBe(477);
    expect(err.fieldErrors).toEqual({
      'data.travelers.0.dateOfBirth': ['invalid date'],
      originLocationCode: ['MANDATORY DATA MISSING'],
    });
    const explicit = errorFromProblem({
      type: 'about:blank',
      status: 422,
      code: 'NAME_MISMATCH',
      fieldErrors: { lastName: ['Does not match the booking'] },
    });
    expect(explicit.fieldErrors).toEqual({ lastName: ['Does not match the booking'] });
  });

  it('options.requestId wins over problem.requestId; retryable extension is honoured', () => {
    const err = errorFromProblem(problem(), { requestId: 'from-header' });
    expect(err.requestId).toBe('from-header');
    expect(errorFromProblem(problem()).requestId).toBe('req-9');
    expect(errorFromProblem({ type: 'about:blank', status: 400 }).requestId).toBeUndefined();
    const flagged = errorFromProblem({ type: 'about:blank', status: 400, retryable: true });
    expect(flagged.retryable).toBe(true);
    const unflagged = errorFromProblem({ type: 'about:blank', status: 503, retryable: false });
    expect(unflagged.retryable).toBe(false);
  });

  it('honours a custom map with classes and factories, including status-derived codes', () => {
    class TripNotFoundError extends NotFoundError {
      constructor(message, options) {
        super(message, options);
        this.name = 'TripNotFoundError';
      }
    }
    const map = {
      TRIP_NOT_FOUND: TripNotFoundError,
      NOT_FOUND: TripNotFoundError,
      PRICE_CHANGED: (ctx) =>
        new ConflictError(`custom: ${ctx.code}`, { status: ctx.status, code: ctx.code }),
      BROKEN: () => 'not an error',
    };
    const byCode = errorFromProblem(
      { type: 'about:blank', status: 404, code: 'TRIP_NOT_FOUND' },
      { map }
    );
    expect(byCode).toBeInstanceOf(TripNotFoundError);
    expect(byCode).toBeInstanceOf(NotFoundError);
    expect(byCode.name).toBe('TripNotFoundError');
    expect(byCode.code).toBe('TRIP_NOT_FOUND');
    const byStatus = errorFromProblem({ type: 'about:blank', status: 404 }, { map });
    expect(byStatus).toBeInstanceOf(TripNotFoundError);
    const factory = errorFromProblem(
      { type: 'about:blank', status: 409, code: 'PRICE_CHANGED' },
      { map }
    );
    expect(factory).toBeInstanceOf(ConflictError);
    expect(factory.message).toBe('custom: PRICE_CHANGED');
    const broken = errorFromProblem({ type: 'about:blank', status: 404, code: 'BROKEN' }, { map });
    expect(broken).toBeInstanceOf(NotFoundError);
    expect(broken.code).toBe('BROKEN');
    const throwing = errorFromProblem(
      { type: 'about:blank', status: 409, code: 'THROWS' },
      {
        map: {
          THROWS: () => {
            throw new Error('factory bug');
          },
        },
      }
    );
    expect(throwing).toBeInstanceOf(ConflictError);
    expect(throwing.code).toBe('THROWS');
    const nonApi = errorFromProblem(
      { type: 'about:blank', status: 500, code: 'X' },
      { map: { X: ValidationError } }
    );
    expect(nonApi).toBeInstanceOf(ApiError);
    expect(nonApi.constructor).toBe(ApiError);
  });

  it('survives garbage input', () => {
    const err = errorFromProblem(null);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('API_ERROR');
    expect(err.message).toBe('Request failed');
    expect(err.problem).toEqual({ type: 'about:blank', title: 'Request failed', status: 0 });
    expect(errorFromProblem({ status: 'abc', code: 123 }).code).toBe('API_ERROR');
    expect(errorFromProblem({ status: '404' })).toBeInstanceOf(NotFoundError);
  });
});

describe('errorFromResponse', () => {
  const offerExpired = {
    type: 'https://api.ota.com/problems/offer-expired',
    title: 'Offer expired',
    status: 410,
    detail: 'The offer is no longer available',
    code: 'OFFER_EXPIRED',
    offerId: 'o-1',
    requestId: 'req-body',
  };

  it('detects application/problem+json from a Headers instance (parsed body)', () => {
    const headers = new Headers({
      'content-type': 'application/problem+json; charset=utf-8',
      'x-request-id': 'req-h',
    });
    const err = errorFromResponse(410, offerExpired, headers);
    expect(err).toBeInstanceOf(OfferExpiredError);
    expect(err.code).toBe('OFFER_EXPIRED');
    expect(err.offerId).toBe('o-1');
    expect(err.requestId).toBe('req-h');
    expect(err.message).toBe('The offer is no longer available');
    expect(err.meta).toEqual({ contentType: 'application/problem+json; charset=utf-8' });
    expect(err.problem).toMatchObject(offerExpired);
  });

  it('accepts plain-object headers (any case) and a JSON string body', () => {
    const err = errorFromResponse(410, JSON.stringify(offerExpired), {
      'CONTENT-TYPE': 'application/problem+json',
    });
    expect(err).toBeInstanceOf(OfferExpiredError);
    expect(err.requestId).toBe('req-body');
    const arr = errorFromResponse(410, offerExpired, {
      'content-type': ['application/problem+json'],
    });
    expect(arr).toBeInstanceOf(OfferExpiredError);
    const map = errorFromResponse(
      410,
      offerExpired,
      new Map([['content-type', 'application/problem+json']])
    );
    expect(map).toBeInstanceOf(OfferExpiredError);
  });

  it('treats a problem-shaped body as a problem even when the content type is plain json', () => {
    const err = errorFromResponse(410, offerExpired, { 'content-type': 'application/json' });
    expect(err).toBeInstanceOf(OfferExpiredError);
    expect(err.problem.status).toBe(410);
    const noStatus = errorFromResponse(
      409,
      { type: 'about:blank', title: 'Conflict' },
      PROBLEM_HEADERS
    );
    expect(noStatus).toBeInstanceOf(ConflictError);
    expect(noStatus.status).toBe(409);
    expect(noStatus.problem.status).toBe(409);
  });

  it('legacy { code, message } bodies keep code and message and map by known code, else status', () => {
    const known = errorFromResponse(
      400,
      {
        code: 'PRICE_CHANGED',
        message: 'Price moved',
        from: { amount: '1', currency: 'USD' },
        to: { amount: '2', currency: 'USD' },
      },
      { 'content-type': 'application/json' }
    );
    expect(known).toBeInstanceOf(PriceChangedError);
    expect(known.code).toBe('PRICE_CHANGED');
    expect(known.message).toBe('Price moved');
    expect(known.from).toEqual({ amount: '1', currency: 'USD' });
    expect(known.to).toEqual({ amount: '2', currency: 'USD' });

    const unknown = errorFromResponse(
      409,
      { code: 'E_LEGACY_42', message: 'Legacy failure', requestId: 'req-l' },
      {}
    );
    expect(unknown).toBeInstanceOf(ConflictError);
    expect(unknown.code).toBe('E_LEGACY_42');
    expect(unknown.message).toBe('Legacy failure');
    expect(unknown.requestId).toBe('req-l');
    expect(unknown.problem).toMatchObject({
      type: 'about:blank',
      status: 409,
      code: 'E_LEGACY_42',
      detail: 'Legacy failure',
    });

    const nested = errorFromResponse(
      401,
      { error: { code: 'SESSION_EXPIRED', message: 'Token expired' } },
      null
    );
    expect(nested).toBeInstanceOf(AuthError);
    expect(nested.reason).toBe('expired');
    expect(nested.message).toBe('Token expired');

    const envelope = errorFromResponse(
      422,
      {
        errors: [
          {
            code: 'DOCUMENT_INVALID',
            message: 'Passport expired',
            source: { pointer: '/travelers/0/document' },
          },
        ],
      },
      undefined
    );
    expect(envelope).toBeInstanceOf(UnprocessableError);
    expect(envelope.code).toBe('DOCUMENT_INVALID');
    expect(envelope.message).toBe('Passport expired');
    expect(envelope.issues).toHaveLength(1);
    expect(envelope.fieldErrors).toEqual({ 'travelers.0.document': ['Passport expired'] });

    const details = errorFromResponse(
      400,
      {
        code: 'VALIDATION_FAILED',
        message: 'Bad',
        details: [{ path: 'origin', message: 'Required' }],
      },
      {}
    );
    expect(details).toBeInstanceOf(UnprocessableError);
    expect(details.fieldErrors).toEqual({ origin: ['Required'] });

    const messageOnly = errorFromResponse(500, { message: 'Boom' }, {});
    expect(messageOnly).toBeInstanceOf(ApiError);
    expect(messageOnly.code).toBe('INTERNAL_ERROR');
    expect(messageOnly.message).toBe('Boom');
    expect(messageOnly.retryable).toBe(true);
  });

  it.each([
    [401, AuthError, 'UNAUTHENTICATED', 'unauthenticated'],
    [403, AuthError, 'FORBIDDEN', 'forbidden'],
    [404, NotFoundError, 'NOT_FOUND', undefined],
    [409, ConflictError, 'CONFLICT', undefined],
    [422, UnprocessableError, 'UNPROCESSABLE', undefined],
    [429, RateLimitError, 'RATE_LIMITED', undefined],
    [500, ApiError, 'INTERNAL_ERROR', undefined],
    [503, ApiError, 'SERVER_UNAVAILABLE', undefined],
  ])('empty body with status %i → %o', (status, Class, code, reason) => {
    for (const body of [undefined, null, '', '   ']) {
      const err = errorFromResponse(status, body, {});
      expect(err).toBeInstanceOf(Class);
      expect(err.constructor).toBe(Class);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.name).toBe(Class.name);
      expect(err.problem).toEqual({ type: 'about:blank', title: err.message, status });
      if (reason) expect(err.reason).toBe(reason);
      if (status >= 500) expect(err.retryable).toBe(true);
    }
  });

  it('429 reads Retry-After as seconds or HTTP-date, undefined when missing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    const seconds = errorFromResponse(429, '', { 'Retry-After': '3' });
    expect(seconds).toBeInstanceOf(RateLimitError);
    expect(seconds.retryAfterMs).toBe(3000);
    expect(seconds.retryable).toBe(true);
    expect(seconds.meta).toEqual({ retryAfterMs: 3000 });

    const date = errorFromResponse(
      429,
      null,
      new Headers({ 'retry-after': 'Sat, 17 Oct 2026 10:00:30 GMT' })
    );
    expect(date.retryAfterMs).toBe(30000);

    const past = errorFromResponse(429, null, { 'retry-after': 'Sat, 17 Oct 2026 09:00:00 GMT' });
    expect(past.retryAfterMs).toBe(0);

    const injected = errorFromResponse(
      429,
      null,
      { 'retry-after': 'Sat, 17 Oct 2026 10:01:00 GMT' },
      { now: Date.parse('2026-10-17T10:00:45Z') }
    );
    expect(injected.retryAfterMs).toBe(15000);

    expect(errorFromResponse(429, null, {}).retryAfterMs).toBeUndefined();
    expect(errorFromResponse(429, null, { 'retry-after': 'soon' }).retryAfterMs).toBeUndefined();

    const header = errorFromResponse(
      429,
      { type: 'about:blank', status: 429, retryAfter: 60 },
      { ...PROBLEM_HEADERS, 'retry-after': '2' }
    );
    expect(header.retryAfterMs).toBe(2000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('non-JSON text bodies (HTML error pages) fall back to status without leaking the body', () => {
    const html = '<html><body><h1>502 Bad Gateway</h1>nginx</body></html>';
    const err = errorFromResponse(502, html, { 'content-type': 'text/html' });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('BAD_GATEWAY');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Bad gateway (HTTP 502)');
    expect(err.message).not.toContain('<html>');
    expect(err.meta.bodyPreview).toBe(html);
    expect(err.meta.contentType).toBe('text/html');
    const broken = errorFromResponse(500, '{not json', {});
    expect(broken.code).toBe('INTERNAL_ERROR');
    expect(broken.meta.bodyPreview).toBe('{not json');
  });

  it('forwards map and requestId options, and a JSON array body becomes issues', () => {
    class MyErr extends ApiError {}
    const mapped = errorFromResponse(
      418,
      { code: 'TEAPOT', message: 'short and stout' },
      {},
      { map: { TEAPOT: MyErr }, requestId: 'req-o' }
    );
    expect(mapped).toBeInstanceOf(MyErr);
    expect(mapped.requestId).toBe('req-o');
    const list = errorFromResponse(400, [{ code: 'PROMO_INVALID', message: 'Unknown promo' }], {});
    expect(list).toBeInstanceOf(UnprocessableError);
    expect(list.code).toBe('PROMO_INVALID');
    expect(list.issues).toHaveLength(1);
    const weird = errorFromResponse('503', 42, {});
    expect(weird.status).toBe(503);
    expect(weird.code).toBe('SERVER_UNAVAILABLE');
  });
});

describe('wrap', () => {
  it('passes SdkErrors through untouched', () => {
    const err = new OfferExpiredError('x');
    expect(wrap(err)).toBe(err);
  });

  it('maps DOMException abort / timeout / quota', () => {
    const abort = wrap(new DOMException('The operation was aborted.', 'AbortError'));
    expect(abort).toBeInstanceOf(AbortError);
    expect(abort.reason).toBe('aborted');
    expect(abort.message).toBe('The operation was aborted.');
    expect(abort.cause).toBeInstanceOf(DOMException);
    expect(abort.retryable).toBe(false);

    const timeout = wrap(new DOMException('signal timed out', 'TimeoutError'));
    expect(timeout).toBeInstanceOf(TimeoutError);
    expect(timeout.retryable).toBe(true);

    const quota = wrap(new DOMException('quota', 'QuotaExceededError'));
    expect(quota).toBeInstanceOf(StorageError);
    const security = wrap(new DOMException('denied', 'SecurityError'));
    expect(security).toBeInstanceOf(StorageError);

    const withReason = Object.assign(new Error('aborted'), {
      name: 'AbortError',
      reason: 'destroyed',
    });
    expect(wrap(withReason).reason).toBe('destroyed');
  });

  it('maps fetch TypeErrors and Node socket errors to NetworkError', () => {
    const fetchErr = wrap(new TypeError('Failed to fetch'));
    expect(fetchErr).toBeInstanceOf(NetworkError);
    expect(fetchErr.retryable).toBe(true);
    expect(fetchErr.cause).toBeInstanceOf(TypeError);
    expect(wrap(new TypeError('NetworkError when attempting to fetch resource.'))).toBeInstanceOf(
      NetworkError
    );
    expect(wrap(new TypeError('Load failed'))).toBeInstanceOf(NetworkError);
    const socket = wrap(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(socket).toBeInstanceOf(NetworkError);
    expect(socket.details).toEqual({ code: 'ECONNREFUSED' });
    const undici = wrap(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    );
    expect(undici).toBeInstanceOf(NetworkError);
    expect(
      wrap(new TypeError("Cannot read properties of undefined (reading 'x')"))
    ).not.toBeInstanceOf(NetworkError);
  });

  it('maps gateway card errors to PaymentError', () => {
    const declined = wrap({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
    });
    expect(declined).toBeInstanceOf(PaymentError);
    expect(declined.reason).toBe('declined');
    expect(declined.code).toBe('PAYMENT_DECLINED');
    expect(declined.message).toBe('Your card was declined.');
    expect(declined.details).toEqual({
      gatewayCode: 'card_declined',
      declineCode: 'generic_decline',
    });
    expect(
      wrap({ type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' }).reason
    ).toBe('insufficient_funds');
    expect(
      wrap({ type: 'card_error', code: 'card_declined', decline_code: 'fraudulent' }).reason
    ).toBe('fraud');
    expect(wrap({ type: 'card_error', code: 'authentication_required' }).reason).toBe(
      'requires_action'
    );
    expect(wrap({ type: 'api_connection_error', message: 'offline' })).toBeInstanceOf(NetworkError);
  });

  it('normalises plain errors, strings, objects and nothing with fallbacks', () => {
    const plain = wrap(new Error('kaboom'));
    expect(plain).toBeInstanceOf(SdkError);
    expect(plain.constructor).toBe(SdkError);
    expect(plain.code).toBe('UNKNOWN_ERROR');
    expect(plain.message).toBe('kaboom');
    expect(plain.cause).toBeInstanceOf(Error);
    expect(plain.retryable).toBe(false);

    const withFallback = wrap(new Error(''), {
      code: 'GATEWAY_LOAD',
      message: 'Could not load gateway',
    });
    expect(withFallback.code).toBe('GATEWAY_LOAD');
    expect(withFallback.message).toBe('Could not load gateway');

    const coded = wrap(Object.assign(new Error('x'), { code: 'some-code' }));
    expect(coded.code).toBe('SOME_CODE');

    const string = wrap('just text');
    expect(string.message).toBe('just text');
    expect(string.code).toBe('UNKNOWN_ERROR');

    const nothing = wrap(null, { code: 'NOTHING' });
    expect(nothing.message).toBe('Unknown error');
    expect(nothing.code).toBe('NOTHING');
    expect(wrap(undefined).code).toBe('UNKNOWN_ERROR');

    const number = wrap(42);
    expect(number.details).toBe(42);
    expect(number.message).toBe('Unknown error');

    const obj = wrap({ code: 'razorpay_failed', message: 'Payment failed at bank' });
    expect(obj.code).toBe('RAZORPAY_FAILED');
    expect(obj.message).toBe('Payment failed at bank');
    expect(obj.details).toEqual({ code: 'razorpay_failed', message: 'Payment failed at bank' });
    expect(obj.cause).toEqual({ code: 'razorpay_failed', message: 'Payment failed at bank' });
  });
});

describe('toUserMessage', () => {
  const ACTIONS = ['retry', 'search_again', 'login', 'contact_support'];
  const everyError = () => [
    new SdkError(SERVER_DETAIL),
    new ConfigError(SERVER_DETAIL),
    new ValidationError(SERVER_DETAIL, {
      issues: [{ path: 'x', code: 'c', message: SERVER_DETAIL }],
    }),
    new NetworkError(SERVER_DETAIL),
    new TimeoutError(SERVER_DETAIL),
    new AbortError(SERVER_DETAIL),
    new StorageError(SERVER_DETAIL),
    new UnsupportedError(SERVER_DETAIL),
    new ApiError(SERVER_DETAIL, { status: 400, details: { sql: SERVER_DETAIL } }),
    new ApiError(SERVER_DETAIL, { status: 503 }),
    ...[
      'unauthenticated',
      'expired',
      'forbidden',
      'invalid_credentials',
      'mfa_required',
      'otp_invalid',
      'otp_expired',
      'locked',
    ].map((reason) => new AuthError(SERVER_DETAIL, { reason })),
    new RateLimitError(SERVER_DETAIL),
    new RateLimitError(SERVER_DETAIL, { retryAfterMs: 4200 }),
    new NotFoundError(SERVER_DETAIL),
    new ConflictError(SERVER_DETAIL),
    new SearchExpiredError(SERVER_DETAIL),
    new OfferExpiredError(SERVER_DETAIL),
    ...['sold_out', 'withdrawn', 'schedule_changed'].map(
      (reason) => new OfferUnavailableError(SERVER_DETAIL, { reason })
    ),
    new PriceChangedError(SERVER_DETAIL),
    new PriceChangedError(SERVER_DETAIL, {
      from: { amount: '1', currency: 'INR' },
      to: { amount: '2', currency: 'INR' },
    }),
    new ItineraryExpiredError(SERVER_DETAIL),
    ...['retry_payment', 'search_again', 'contact_support', 'wait'].map(
      (suggestedAction) => new BookingError(SERVER_DETAIL, { suggestedAction })
    ),
    ...[
      'declined',
      'insufficient_funds',
      'authentication_failed',
      'expired',
      'cancelled',
      'gateway',
      'fraud',
      'method_unavailable',
      'requires_action',
    ].map((reason) => new PaymentError(SERVER_DETAIL, { reason })),
    new ServicingError(SERVER_DETAIL, { action: 'change', reason: SERVER_DETAIL }),
    new UnprocessableError(SERVER_DETAIL, { fieldErrors: { x: [SERVER_DETAIL] } }),
    errorFromProblem({
      type: 'about:blank',
      title: SERVER_DETAIL,
      detail: SERVER_DETAIL,
      status: 500,
      hint: SERVER_DETAIL,
    }),
  ];

  it('returns user-safe copy for every class and never leaks server detail', () => {
    for (const err of everyError()) {
      const msg = toUserMessage(err);
      expect(typeof msg.title).toBe('string');
      expect(msg.title.length).toBeGreaterThan(0);
      expect(typeof msg.message).toBe('string');
      expect(msg.message.length).toBeGreaterThan(0);
      expect(msg.title).not.toContain(SERVER_DETAIL);
      expect(msg.message).not.toContain(SERVER_DETAIL);
      expect(msg.title).not.toMatch(/db-internal|0xdeadbeef|5432/);
      expect(msg.message).not.toMatch(/db-internal|0xdeadbeef|5432|\{\w+\}/);
      if ('action' in msg) expect(ACTIONS).toContain(msg.action);
      expect(Object.keys(msg).sort()).toEqual(
        msg.action ? ['action', 'message', 'title'] : ['message', 'title']
      );
    }
  });

  it('picks the right action per class', () => {
    expect(toUserMessage(new NetworkError('x')).action).toBe('retry');
    expect(toUserMessage(new TimeoutError('x')).action).toBe('retry');
    expect(toUserMessage(new RateLimitError('x')).action).toBe('retry');
    expect(toUserMessage(new ApiError('x', { status: 503 })).action).toBe('retry');
    expect(toUserMessage(new ApiError('x', { status: 400 })).action).toBe('contact_support');
    expect(toUserMessage(new AuthError('x')).action).toBe('login');
    expect(toUserMessage(new AuthError('x', { reason: 'expired' })).action).toBe('login');
    expect(toUserMessage(new AuthError('x', { reason: 'forbidden' })).action).toBeUndefined();
    expect(toUserMessage(new AuthError('x', { reason: 'locked' })).action).toBe('contact_support');
    expect(toUserMessage(new SearchExpiredError('x')).action).toBe('search_again');
    expect(toUserMessage(new OfferExpiredError('x')).action).toBe('search_again');
    expect(toUserMessage(new OfferUnavailableError('x')).action).toBe('search_again');
    expect(toUserMessage(new ItineraryExpiredError('x')).action).toBe('search_again');
    expect(toUserMessage(new PriceChangedError('x')).action).toBeUndefined();
    expect(toUserMessage(new BookingError('x', { suggestedAction: 'retry_payment' })).action).toBe(
      'retry'
    );
    expect(toUserMessage(new BookingError('x', { suggestedAction: 'search_again' })).action).toBe(
      'search_again'
    );
    expect(toUserMessage(new BookingError('x')).action).toBe('contact_support');
    expect(toUserMessage(new PaymentError('x', { reason: 'declined' })).action).toBe('retry');
    expect(toUserMessage(new PaymentError('x', { reason: 'fraud' })).action).toBe(
      'contact_support'
    );
    expect(toUserMessage(new ServicingError('x')).action).toBe('contact_support');
    expect(toUserMessage(new ConfigError('x')).action).toBe('contact_support');
    expect(toUserMessage(new ValidationError('x')).action).toBeUndefined();
    expect(toUserMessage(new AbortError('x')).action).toBeUndefined();
    expect(toUserMessage(new Error('x')).action).toBe('retry');
    expect(toUserMessage(new TypeError('Failed to fetch')).title).toBe('Connection problem');
  });

  it('interpolates safe domain values (amounts, wait seconds)', () => {
    const price = toUserMessage(
      new PriceChangedError('x', {
        from: { amount: '5000.00', currency: 'INR' },
        to: { amount: '5400.00', currency: 'INR' },
      })
    );
    expect(price.title).toBe('Price changed');
    expect(price.message).toContain('INR 5000.00');
    expect(price.message).toContain('INR 5400.00');
    expect(toUserMessage(new PriceChangedError('x')).message).not.toContain('{');
    const rate = toUserMessage(new RateLimitError('x', { retryAfterMs: 4200 }));
    expect(rate.message).toContain('5 seconds');
    expect(toUserMessage(new RateLimitError('x')).message).toBe(
      'Please wait a moment and try again.'
    );
    expect(toUserMessage(new OfferUnavailableError('x', { reason: 'sold_out' })).title).toBe(
      'Sold out'
    );
    expect(
      toUserMessage(new OfferUnavailableError('x', { reason: 'schedule_changed' })).title
    ).toBe('Schedule changed');
    expect(toUserMessage(new PaymentError('x', { reason: 'insufficient_funds' })).title).toBe(
      'Insufficient funds'
    );
  });

  it('uses the t function with errors.<key>.<field> keys, vars and a default', () => {
    const t = vi.fn((key, vars, opts) => {
      if (key === 'errors.rate_limit.seconds.message') return `Espera ${vars.seconds} segundos`;
      if (key === 'errors.rate_limit.seconds.title') return 'Demasiadas solicitudes';
      return opts.default;
    });
    const msg = toUserMessage(new RateLimitError(SERVER_DETAIL, { retryAfterMs: 10000 }), t);
    expect(msg).toEqual({
      title: 'Demasiadas solicitudes',
      message: 'Espera 10 segundos',
      action: 'retry',
    });
    expect(t).toHaveBeenCalledWith(
      'errors.rate_limit.seconds.title',
      { seconds: 10 },
      { default: 'Too many requests' }
    );
    expect(t).toHaveBeenCalledWith(
      'errors.rate_limit.seconds.message',
      { seconds: 10 },
      { default: 'Please wait 10 seconds and try again.' }
    );

    const keys = [];
    toUserMessage(new AuthError('x', { reason: 'expired' }), (k) => {
      keys.push(k);
      return k;
    });
    expect(keys).toEqual(['errors.auth.expired.title', 'errors.auth.expired.message']);
    toUserMessage(new PaymentError('x', { reason: 'declined' }), (k) => keys.push(k) && k);
    expect(keys.slice(-2)).toEqual([
      'errors.payment.declined.title',
      'errors.payment.declined.message',
    ]);
  });

  it('falls back to the default copy when t returns the key, empty, non-strings or throws', () => {
    const def = toUserMessage(new NotFoundError('x'));
    expect(toUserMessage(new NotFoundError('x'), (k) => k)).toEqual(def);
    expect(toUserMessage(new NotFoundError('x'), () => '')).toEqual(def);
    expect(toUserMessage(new NotFoundError('x'), () => undefined)).toEqual(def);
    expect(toUserMessage(new NotFoundError('x'), () => 42)).toEqual(def);
    expect(
      toUserMessage(new NotFoundError('x'), () => {
        throw new Error('missing bundle');
      })
    ).toEqual(def);
    expect(toUserMessage(new NotFoundError('x'), 'not a function')).toEqual(def);
    expect(def).toEqual({
      title: 'Not found',
      message: "We couldn't find what you were looking for.",
    });
  });
});

describe('ERROR_CODES', () => {
  it('is a frozen identity map covering the canonical codes', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    for (const [k, v] of Object.entries(ERROR_CODES)) expect(k).toBe(v);
    for (const code of [
      'OFFER_EXPIRED',
      'PRICE_CHANGED',
      'SOLD_OUT',
      'OFFER_UNAVAILABLE',
      'SEARCH_EXPIRED',
      'ITINERARY_EXPIRED',
      'PAYMENT_DECLINED',
      'PAYMENT_REQUIRES_ACTION',
      'HOLD_NOT_ALLOWED',
      'CHANGE_NOT_ALLOWED',
      'CANCEL_NOT_ALLOWED',
      'NAME_MISMATCH',
      'DOCUMENT_INVALID',
      'PROMO_INVALID',
      'SESSION_EXPIRED',
      'RATE_LIMITED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'VALIDATION_FAILED',
      'SEAT_TAKEN',
      'PROMO_NOT_ELIGIBLE',
      'PROMO_EXPIRED',
      'DUPLICATE_TRAVELER',
      'GIFT_CARD_INVALID',
      'INSUFFICIENT_BALANCE',
      'VOUCHER_NOT_APPLICABLE',
      'SERVICE_UNAVAILABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
      'ABORTED',
    ]) {
      expect(ERROR_CODES[code]).toBe(code);
    }
    expect(() => {
      ERROR_CODES.NEW = 'NEW';
    }).toThrow();
  });

  it('every class default code is a canonical code', () => {
    const classes = [...BASE_CLASSES, ...API_CLASSES].map(([Class]) => Class);
    for (const Class of classes) {
      expect(ERROR_CODES[new Class('x').code]).toBe(new Class('x').code);
    }
    expect(ERROR_CODES.PAYMENT_DECLINED).toBe(new PaymentError('x', { reason: 'declined' }).code);
    expect(ERROR_CODES.FORBIDDEN).toBe(new AuthError('x', { reason: 'forbidden' }).code);
  });
});

describe('module hygiene', () => {
  it('leaves no timers behind and touches no browser globals', () => {
    vi.useFakeTimers();
    errorFromResponse(429, null, { 'retry-after': '1' });
    toUserMessage(new TimeoutError('x'));
    wrap(new Error('x'));
    expect(vi.getTimerCount()).toBe(0);
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
  });
});

describe('hardening against hostile and unusual input', () => {
  const offerExpiredBody = {
    type: 'https://api.ota.com/problems/offer-expired',
    title: 'Offer expired',
    status: 410,
    code: 'OFFER_EXPIRED',
    offerId: 'o-1',
  };

  it('server-controlled paths and keys never crash or reach Object.prototype', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const err = errorFromProblem({
      type: 'about:blank',
      status: 422,
      errors: [
        { detail: 'bad', source: { pointer: '/__proto__' } },
        { detail: 'bad2', source: { pointer: '/__proto__' } },
        { detail: 'nope', source: { parameter: 'constructor' } },
        { detail: 'x', path: 'prototype' },
        { detail: 'y', field: 'hasOwnProperty' },
        { detail: 'z', source: { pointer: '/__proto__/polluted' } },
      ],
    });
    expect(err).toBeInstanceOf(UnprocessableError);
    expect(Object.hasOwn(err.fieldErrors, '__proto__')).toBe(true);
    expect(err.fieldErrors['__proto__']).toEqual(['bad', 'bad2']);
    expect(err.fieldErrors.constructor).toEqual(['nope']);
    expect(err.fieldErrors.prototype).toEqual(['x']);
    expect(err.fieldErrors.hasOwnProperty).toEqual(['y']);
    expect(err.fieldErrors['__proto__.polluted']).toEqual(['z']);
    expect(Object.getPrototypeOf(err.fieldErrors)).toBe(Object.prototype);

    const hostile = JSON.parse(
      '{"type":"about:blank","status":422,"code":"NAME_MISMATCH",' +
        '"fieldErrors":{"__proto__":["p"],"constructor":"c"},' +
        '"__proto__":{"polluted":true},"constructor":{"polluted":true}}'
    );
    const explicit = errorFromProblem(hostile);
    expect(explicit).toBeInstanceOf(UnprocessableError);
    expect(Object.hasOwn(explicit.fieldErrors, '__proto__')).toBe(true);
    expect(explicit.fieldErrors['__proto__']).toEqual(['p']);
    expect(explicit.fieldErrors.constructor).toEqual(['c']);
    expect(Object.getPrototypeOf(explicit.fieldErrors)).toBe(Object.prototype);
    expect(Object.hasOwn(explicit.details, '__proto__')).toBe(true);
    expect(explicit.details.constructor).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(explicit.details)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(explicit.problem)).toBe(Object.prototype);

    const legacy = errorFromResponse(
      400,
      JSON.parse('{"code":"PROMO_INVALID","message":"m","__proto__":{"polluted":true}}'),
      {}
    );
    expect(legacy).toBeInstanceOf(UnprocessableError);
    expect(Object.getPrototypeOf(legacy.problem)).toBe(Object.prototype);
    expect(Object.hasOwn(legacy.problem, '__proto__')).toBe(false);

    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const byCode = errorFromProblem({ type: 'about:blank', status: 404, code }, { map: {} });
      expect(byCode).toBeInstanceOf(NotFoundError);
    }
    expect({}.polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });

  it('is() never throws for classes without a usable prototype', () => {
    const arrow = () => {};
    const err = new NotFoundError('x');
    expect(() => is(err, arrow)).not.toThrow();
    expect(is(err, arrow)).toBe(false);
    expect(is(err, Math.max.bind(null))).toBe(false);
    expect(
      is(
        err,
        Object.assign(function () {}, { prototype: null })
      )
    ).toBe(false);
    expect(is(err, Error)).toBe(true);
  });

  it('toUserMessage never surfaces server text smuggled through Money fields', () => {
    const err = errorFromProblem({
      type: 'about:blank',
      status: 409,
      code: 'PRICE_CHANGED',
      from: { amount: SERVER_DETAIL, currency: 'INR' },
      to: { amount: '5400.00', currency: SERVER_DETAIL },
    });
    expect(err).toBeInstanceOf(PriceChangedError);
    expect(err.from).toBeUndefined();
    expect(err.to).toBeUndefined();
    const msg = toUserMessage(err);
    expect(msg.message).not.toContain(SERVER_DETAIL);
    expect(msg.message).not.toContain('{');
    expect(msg.title).toBe('Price changed');
    expect(err.details.from.amount).toBe(SERVER_DETAIL);

    const ok = new PriceChangedError('x', {
      from: { amount: ' 10.5 ', currency: 'inr' },
      to: { amount: 12, currency: 'INR' },
    });
    expect(ok.from).toEqual({ amount: '10.5', currency: 'INR' });
    expect(ok.to).toEqual({ amount: '12', currency: 'INR' });
    expect(toUserMessage(ok).message).toContain('from INR 10.5 to INR 12');
    for (const bad of [
      { amount: '1,000', currency: 'INR' },
      { amount: '1e3', currency: 'INR' },
      { amount: '10', currency: '' },
      { amount: '10' },
      { amount: NaN, currency: 'INR' },
      { amount: Infinity, currency: 'INR' },
      { amount: '10', currency: 'INRX' },
      { amount: '10', currency: 'IN R' },
      { amount: ['10'], currency: 'INR' },
    ]) {
      expect(new PriceChangedError('x', { from: bad, to: bad }).from).toBeUndefined();
    }
  });

  it('derives codes from type URLs without mistaking hosts, statuses or files for codes', () => {
    expect(errorFromProblem({ type: 'https://api.ota.com', status: 404 }).code).toBe('NOT_FOUND');
    expect(errorFromProblem({ type: 'https://api.ota.com/', status: 409 }).code).toBe('CONFLICT');
    expect(errorFromProblem({ type: 'HTTPS://API.OTA.COM', status: 409 }).code).toBe('CONFLICT');
    expect(errorFromProblem({ type: 'https://api.ota.com/problems/404', status: 404 }).code).toBe(
      'NOT_FOUND'
    );
    expect(errorFromProblem({ type: 'ABOUT:BLANK', status: 404 }).code).toBe('NOT_FOUND');
    expect(
      errorFromProblem({
        type: 'https://api.ota.com/problems/offer-expired.html?lang=en#top',
        status: 410,
      })
    ).toBeInstanceOf(OfferExpiredError);
    expect(
      errorFromProblem({ type: 'tag:ota.com,2026:search-expired', status: 410 })
    ).toBeInstanceOf(SearchExpiredError);
    expect(errorFromProblem({ type: '/problems/itinerary-expired/', status: 410 })).toBeInstanceOf(
      ItineraryExpiredError
    );
    expect(errorFromProblem({ type: 'price_changed', status: 409 })).toBeInstanceOf(
      PriceChangedError
    );
    const twoFa = errorFromProblem({ type: 'about:blank', status: 401, code: '2fa-required' });
    expect(twoFa.code).toBe('2FA_REQUIRED');
    expect(twoFa).toBeInstanceOf(AuthError);
    expect(errorFromProblem({ type: 'about:blank', status: 404, code: '404' }).code).toBe(
      'NOT_FOUND'
    );
    expect(errorFromProblem({ type: 'about:blank', status: 400, code: '___' }).code).toBe(
      'BAD_REQUEST'
    );
    expect(errorFromProblem({ type: 'about:blank', status: 400, code: 'a/b' }).code).toBe(
      'BAD_REQUEST'
    );
  });

  it('a problem without status takes the class default status for a known code', () => {
    const err = errorFromProblem({ type: 'about:blank', code: 'OFFER_EXPIRED' });
    expect(err).toBeInstanceOf(OfferExpiredError);
    expect(err.status).toBe(410);
    expect(errorFromProblem({ code: 'SESSION_EXPIRED' }).status).toBe(401);
    expect(errorFromProblem({ code: 'FORBIDDEN' }).status).toBe(403);
    expect(errorFromProblem({ code: 'VALIDATION_FAILED' }).status).toBe(422);
    expect(errorFromProblem({ code: 'RATE_LIMITED' }).status).toBe(429);
    expect(errorFromProblem({ code: 'WHATEVER' }).status).toBe(0);
    expect(errorFromProblem({ code: 'OFFER_EXPIRED', status: 400 }).status).toBe(400);
    expect(errorFromProblem({}).status).toBe(0);
  });

  it('every ApiError default code maps back to the same class through errorFromProblem', () => {
    for (const [Class] of API_CLASSES) {
      const sample = new Class('x');
      const err = errorFromProblem({
        type: 'about:blank',
        status: sample.status,
        code: sample.code,
      });
      expect(err.constructor).toBe(Class);
      expect(err.code).toBe(sample.code);
      expect(err.status).toBe(sample.status);
    }
    const servicing = errorFromProblem({
      type: 'about:blank',
      status: 409,
      code: 'SERVICING_NOT_ALLOWED',
      action: 'split_pnr',
      reason: 'ticketed',
    });
    expect(servicing).toBeInstanceOf(ServicingError);
    expect(servicing.action).toBe('split_pnr');
    expect(servicing.reason).toBe('ticketed');
  });

  it('wrap recognises network failures from another realm, undici causes and more socket codes', () => {
    const foreignTypeError = Object.assign(Object.create(Error.prototype), {
      name: 'TypeError',
      message: 'Failed to fetch',
    });
    expect(foreignTypeError instanceof TypeError).toBe(false);
    expect(wrap(foreignTypeError)).toBeInstanceOf(NetworkError);

    const undici = wrap(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.ota.com'), {
          code: 'ENOTFOUND',
        }),
      })
    );
    expect(undici).toBeInstanceOf(NetworkError);
    expect(undici.details).toEqual({ code: 'ENOTFOUND' });
    const causeOnly = wrap(
      Object.assign(new Error('request failed'), { cause: { code: 'ECONNRESET' } })
    );
    expect(causeOnly).toBeInstanceOf(NetworkError);
    expect(causeOnly.details).toEqual({ code: 'ECONNRESET' });
    for (const code of ['ETIMEDOUT', 'ECONNABORTED', 'ERR_NETWORK', 'ENETDOWN', 'EHOSTDOWN']) {
      expect(wrap(Object.assign(new Error('x'), { code }))).toBeInstanceOf(NetworkError);
    }
    expect(wrap(new DOMException('A network error occurred.', 'NetworkError'))).toBeInstanceOf(
      NetworkError
    );
    expect(wrap(Object.assign(new Error('x'), { cause: { code: 'OTHER' } })).constructor).toBe(
      SdkError
    );
    expect(wrap(Object.assign(new Error('x'), { cause: 'ENOTFOUND' })).constructor).toBe(SdkError);
    expect(wrap(Object.assign(new Error('x'), { code: 'OTHER' })).code).toBe('OTHER');
  });

  it('toUserMessage gives branded errors from another SDK copy the same copy as local ones', () => {
    const brand = Symbol.for('@wayfarer/sdk/SdkError');
    class ForeignSdkError extends Error {}
    Object.defineProperty(ForeignSdkError.prototype, brand, { value: true });
    Object.defineProperty(ForeignSdkError, 'name', { value: 'SdkError' });
    class ForeignApiError extends ForeignSdkError {}
    Object.defineProperty(ForeignApiError, 'name', { value: 'ApiError' });
    class ForeignAuthError extends ForeignApiError {}
    Object.defineProperty(ForeignAuthError, 'name', { value: 'AuthError' });
    class ForeignPriceChangedError extends ForeignApiError {}
    Object.defineProperty(ForeignPriceChangedError, 'name', { value: 'PriceChangedError' });

    const expired = Object.assign(new ForeignAuthError(SERVER_DETAIL), {
      code: 'SESSION_EXPIRED',
      reason: 'expired',
      retryable: false,
    });
    expect(wrap(expired)).toBe(expired);
    expect(toUserMessage(expired)).toEqual({
      title: 'Session expired',
      message: 'Your session has expired. Please sign in again.',
      action: 'login',
    });
    const bogusReason = Object.assign(new ForeignAuthError('x'), { reason: SERVER_DETAIL });
    expect(toUserMessage(bogusReason).title).toBe('Sign in required');
    const forged = Object.assign(new ForeignPriceChangedError('x'), {
      from: { amount: SERVER_DETAIL, currency: 'INR' },
      to: { amount: '2', currency: 'INR' },
    });
    const msg = toUserMessage(forged);
    expect(msg.title).toBe('Price changed');
    expect(msg.message).not.toContain(SERVER_DETAIL);
    const retryable = Object.assign(new ForeignApiError('x'), { retryable: true });
    expect(toUserMessage(retryable).action).toBe('retry');
    expect(isRetryable(retryable)).toBe(true);
    expect(toUserMessage(new ForeignSdkError('x')).title).toBe('Something went wrong');
  });

  it('legacy error strings: code-shaped → code, sentences → message; error_description is read', () => {
    const oauth = errorFromResponse(
      400,
      { error: 'invalid_grant', error_description: 'Refresh token expired' },
      {}
    );
    expect(oauth.code).toBe('INVALID_GRANT');
    expect(oauth.message).toBe('Refresh token expired');
    expect(oauth.details).toEqual({});
    const sentence = errorFromResponse(500, { error: 'Something went wrong' }, {});
    expect(sentence.code).toBe('INTERNAL_ERROR');
    expect(sentence.message).toBe('Something went wrong');
    expect(sentence.problem.code).toBeUndefined();
    const mislabeled = errorFromResponse(
      400,
      { code: 'PROMO_INVALID', message: 'Unknown promo' },
      PROBLEM_HEADERS
    );
    expect(mislabeled).toBeInstanceOf(UnprocessableError);
    expect(mislabeled.message).toBe('Unknown promo');
  });

  it('Retry-After decimals are seconds, letters are dates, anything else is ignored', () => {
    const now = Date.parse('2026-10-17T10:00:00Z');
    const at = (header) => errorFromResponse(429, null, { 'retry-after': header }, { now });
    expect(at('1.5').retryAfterMs).toBe(1500);
    expect(at('0').retryAfterMs).toBe(0);
    expect(at('-3').retryAfterMs).toBeUndefined();
    expect(at('1.2.3').retryAfterMs).toBeUndefined();
    expect(at('2026-10-17T10:00:05Z').retryAfterMs).toBe(5000);
    expect(at('Sat, 17 Oct 2026 09:59:00 GMT').retryAfterMs).toBe(0);
    expect(toUserMessage(at('1.5')).message).toContain('2 seconds');
  });

  it('reads headers from a mixed-case Map, tuple arrays, and survives broken containers', () => {
    const mixedMap = errorFromResponse(
      429,
      null,
      new Map([
        ['Retry-After', '4'],
        ['X-Request-Id', 'req-m'],
      ])
    );
    expect(mixedMap.retryAfterMs).toBe(4000);
    expect(mixedMap.requestId).toBe('req-m');
    const tuples = errorFromResponse(410, offerExpiredBody, [
      ['Content-Type', 'application/problem+json'],
      ['x-request-id', ['req-t', 'ignored']],
    ]);
    expect(tuples).toBeInstanceOf(OfferExpiredError);
    expect(tuples.requestId).toBe('req-t');
    expect(tuples.meta.contentType).toBe('application/problem+json');
    const throwing = {
      get() {
        throw new Error('nope');
      },
    };
    expect(errorFromResponse(404, null, throwing).code).toBe('NOT_FOUND');
    expect(errorFromResponse(404, null, 'not-headers').code).toBe('NOT_FOUND');
    expect(errorFromResponse(404, null, [null, 'x', ['content-type']]).code).toBe('NOT_FOUND');
  });

  it('never throws on hostile input to any exported function', () => {
    const nasty = [
      undefined,
      null,
      0,
      1,
      NaN,
      '',
      'x',
      true,
      Symbol('s'),
      () => {},
      [],
      [null],
      {},
      { status: 'abc' },
      { type: 42, title: null, status: {} },
      { errors: 'x' },
      { errors: [null, 1, 'a', { source: 'x' }], code: 'UNPROCESSABLE' },
      { fieldErrors: [1], code: 'NAME_MISMATCH' },
      { from: 1, to: [], code: 'PRICE_CHANGED' },
      { code: 'RATE_LIMITED', retryAfter: 'soon', retryAfterMs: {} },
      Object.create(null),
      new Proxy({}, {}),
      JSON.parse('{"__proto__":{"a":1},"constructor":{"prototype":{}}}'),
      { code: 'x'.repeat(10000) },
      { type: '://' },
      { type: 'https://' },
      { type: 'about:blank', status: 400, code: 'X', message: 42, detail: [] },
    ];
    for (const input of nasty) {
      expect(isSdkError(errorFromProblem(input))).toBe(true);
      expect(isSdkError(errorFromProblem(input, input))).toBe(true);
      expect(isSdkError(errorFromResponse(input, input, input, input))).toBe(true);
      expect(isSdkError(wrap(input, input))).toBe(true);
      expect(typeof toUserMessage(input, input).message).toBe('string');
      expect(typeof isRetryable(input)).toBe('boolean');
      expect(is(input, SdkError)).toBe(false);
      expect(is(new SdkError('x'), input)).toBe(false);
    }
  });

  it('does not mutate its inputs; frozen problems, bodies, headers and options are fine', () => {
    const problem = Object.freeze({
      type: 'https://api.ota.com/problems/price-changed',
      status: 409,
      from: Object.freeze({ amount: '1', currency: 'INR' }),
      to: Object.freeze({ amount: '2', currency: 'INR' }),
      errors: Object.freeze([
        Object.freeze({ detail: 'd', source: Object.freeze({ pointer: '/a' }) }),
      ]),
    });
    const snapshot = JSON.stringify(problem);
    const headers = Object.freeze({
      'content-type': 'application/problem+json',
      'retry-after': '1',
    });
    const err = errorFromResponse(409, problem, headers, Object.freeze({ requestId: 'r' }));
    expect(err).toBeInstanceOf(PriceChangedError);
    expect(err.from).toEqual({ amount: '1', currency: 'INR' });
    expect(err.problem).not.toBe(problem);
    expect(JSON.stringify(problem)).toBe(snapshot);
    const direct = errorFromProblem(problem, Object.freeze({ map: Object.freeze({}) }));
    expect(direct).toBeInstanceOf(PriceChangedError);
    expect(JSON.stringify(problem)).toBe(snapshot);
    const opts = Object.freeze({ reason: 'expired', meta: Object.freeze({ a: 1 }) });
    const auth = new AuthError('x', opts);
    auth.meta.b = 2;
    expect(opts.meta).toEqual({ a: 1 });
    expect(auth.meta).toEqual({ a: 1, b: 2 });
    const frozenError = Object.freeze(new Error('x'));
    expect(wrap(frozenError).cause).toBe(frozenError);
    expect(toUserMessage(frozenError).title).toBe('Something went wrong');
  });

  it('imports and runs where browser globals throw on access (SSR)', async () => {
    const names = ['window', 'document', 'localStorage', 'navigator'];
    const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
    for (const n of names) {
      Object.defineProperty(globalThis, n, {
        configurable: true,
        get() {
          throw new Error(`${n} accessed`);
        },
      });
    }
    try {
      vi.resetModules();
      const fresh = await import('../../src/errors/index.js');
      const err = fresh.errorFromResponse(429, '{"code":"RATE_LIMITED"}', { 'retry-after': '1' });
      expect(err.code).toBe('RATE_LIMITED');
      expect(fresh.toUserMessage(err).action).toBe('retry');
      expect(fresh.isSdkError(fresh.wrap(new TypeError('Failed to fetch')))).toBe(true);
      expect(fresh.is(err, RateLimitError)).toBe(true);
    } finally {
      for (const [i, n] of names.entries()) {
        if (saved[i]) Object.defineProperty(globalThis, n, saved[i]);
        else delete globalThis[n];
      }
    }
    expect(typeof globalThis.window).toBe('undefined');
  });
});

describe('wrap — undici transport messages', () => {
  it("maps undici's `TypeError: terminated` (body dropped mid-read) to NetworkError", () => {
    const e = wrap(new TypeError('terminated'));
    expect(e).toBeInstanceOf(NetworkError);
    expect(isRetryable(e)).toBe(true);
  });
});
