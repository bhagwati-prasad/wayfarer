import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAccess, DEFAULT_ACCESS_POLICY } from '../../src/auth/access.js';
import { AuthError, ConfigError, ValidationError } from '../../src/errors/index.js';
import { createEmitter } from '../../src/events/emitter.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Minimal `Auth` double whose state the test can flip. */
function fakeAuth({ authenticated = false, guest = false } = {}) {
  const state = { authenticated, guest };
  return {
    state,
    isAuthenticated: vi.fn(() => state.authenticated),
    isGuest: vi.fn(() => state.guest),
    ensureGuestSession: vi.fn(async () => {
      state.guest = true;
      return { guestId: 'g-1', guestToken: 'gt' };
    }),
  };
}

function fakeEvents() {
  return { emit: vi.fn() };
}

/** Resolve a promise and return `{ ok, value }` / `{ ok: false, error }` without throwing. */
async function settle(p) {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('module surface', () => {
  it('exports createAccess and the frozen default policy', () => {
    expect(typeof createAccess).toBe('function');
    expect(Object.isFrozen(DEFAULT_ACCESS_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ACCESS_POLICY.rules)).toBe(true);
  });

  it('returns the documented API', () => {
    const access = createAccess();
    expect(Object.keys(access).sort()).toEqual(
      ['can', 'guard', 'levelOf', 'policy', 'setPolicy', 'wrap'].sort()
    );
    for (const fn of Object.values(access)) expect(typeof fn).toBe('function');
  });
});

describe('DEFAULT_ACCESS_POLICY', () => {
  it('matches docs/api/01-core.md §1.1 exactly', () => {
    expect(DEFAULT_ACCESS_POLICY).toEqual({
      default: 'open',
      rules: {
        'itinerary.*': 'guest',
        'ancillaries.*': 'guest',
        'booking.*': 'guest',
        'payments.*': 'guest',
        'alerts.createGuest': 'guest',
        'booking.retrieve': 'guest',
        'trips.byReference': 'guest',
        'travelers.*': 'auth',
        'trips.*': 'auth',
        'account.*': 'auth',
        'wallet.*': 'auth',
        'alerts.*': 'auth',
        'support.tickets.*': 'auth',
        'payments.savedMethods.*': 'auth',
      },
    });
  });

  it('is what createAccess uses when no policy is given', () => {
    expect(createAccess().policy()).toBe(DEFAULT_ACCESS_POLICY);
    expect(createAccess({ policy: undefined }).policy()).toBe(DEFAULT_ACCESS_POLICY);
    expect(createAccess({ policy: null }).policy()).toBe(DEFAULT_ACCESS_POLICY);
  });
});

describe('levelOf', () => {
  it('resolves exact key, then module.group.*, then module.*, then default', () => {
    const access = createAccess({
      policy: {
        default: 'guest',
        rules: { 'a.*': 'auth', 'a.b.*': 'open', 'a.b.c': 'auth' },
      },
    });
    expect(access.levelOf('a.b.c')).toBe('auth'); // exact
    expect(access.levelOf('a.b.d')).toBe('open'); // a.b.*
    expect(access.levelOf('a.x')).toBe('auth'); // a.*
    expect(access.levelOf('a.b.c.d')).toBe('open'); // nearest group wildcard a.b.*
    expect(access.levelOf('z.y')).toBe('guest'); // default
    expect(access.levelOf('z')).toBe('guest');
  });

  it("falls back to 'open' when the policy has no default", () => {
    const access = createAccess({ policy: { rules: { 'x.*': 'auth' } } });
    expect(access.levelOf('x.fn')).toBe('auth');
    expect(access.levelOf('y.fn')).toBe('open');
    expect(createAccess({ policy: {} }).levelOf('booking.create')).toBe('open');
  });

  it('applies the documented defaults', () => {
    const access = createAccess();
    const expected = {
      'places.search': 'open',
      'search.create': 'open',
      'offers.reprice': 'open',
      'content.faq': 'open',
      'filters.applyFilters': 'open',
      'support.contactOptions': 'open',
      'itinerary.create': 'guest',
      'ancillaries.seats.map': 'guest',
      'booking.create': 'guest',
      'booking.retrieve': 'guest',
      'payments.createIntent': 'guest',
      'alerts.createGuest': 'guest',
      'trips.byReference': 'guest',
      'payments.savedMethods.list': 'auth',
      'travelers.documents.add': 'auth',
      'trips.list': 'auth',
      'trips.changes.quote': 'auth',
      'account.me': 'auth',
      'wallet.balance': 'auth',
      'alerts.create': 'auth',
      'support.tickets.create': 'auth',
    };
    for (const [key, level] of Object.entries(expected)) {
      expect(access.levelOf(key), key).toBe(level);
    }
  });

  it('rejects malformed keys with a ValidationError', () => {
    const access = createAccess();
    for (const bad of ['', ' ', 'a..b', '.a', 'a.', 42, null, undefined, 'a b', 'a.*.b']) {
      let caught;
      try {
        access.levelOf(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught, String(bad)).toBeInstanceOf(ValidationError);
      expect(caught.issues[0].path).toBe('key');
    }
  });
});

describe('guard', () => {
  it("'open' calls straight through, keeping synchronous results and arguments", () => {
    const auth = fakeAuth();
    const events = fakeEvents();
    const access = createAccess({ auth, events });
    const fn = vi.fn((a, b) => a + b);
    const guarded = access.guard('search.summary', fn);
    expect(guarded(1, 2)).toBe(3); // not a Promise
    expect(fn).toHaveBeenCalledWith(1, 2);
    expect(auth.isAuthenticated).not.toHaveBeenCalled();
    expect(auth.ensureGuestSession).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("'open' passes promises and `this` through untouched", async () => {
    const access = createAccess();
    const api = {
      v: 7,
      fn: access.guard('m.fn', async function () {
        return this.v;
      }),
    };
    await expect(api.fn()).resolves.toBe(7);
  });

  it("'auth' rejects unauthenticated callers with AuthError{reason:'unauthenticated', key} and emits auth:required first", async () => {
    const auth = fakeAuth();
    const events = fakeEvents();
    const access = createAccess({ auth, events });
    const fn = vi.fn(async () => 'never');
    const guarded = access.guard('trips.list', fn);

    const result = guarded();
    expect(result).toBeInstanceOf(Promise);
    // emitted synchronously, before anyone awaits
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('auth:required', { key: 'trips.list' });

    const { ok, error } = await settle(result);
    expect(ok).toBe(false);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.reason).toBe('unauthenticated');
    expect(error.key).toBe('trips.list');
    expect(error.status).toBe(401);
    expect(fn).not.toHaveBeenCalled(); // no network call is made
    expect(auth.ensureGuestSession).not.toHaveBeenCalled();
  });

  it("'auth' calls through when authenticated (no emit, no guest session)", async () => {
    const auth = fakeAuth({ authenticated: true });
    const events = fakeEvents();
    const access = createAccess({ auth, events });
    const fn = vi.fn(async (x) => x * 2);
    await expect(access.guard('trips.list', fn)(21)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledWith(21);
    expect(events.emit).not.toHaveBeenCalled();
    expect(auth.ensureGuestSession).not.toHaveBeenCalled();
  });

  it("'auth' keeps synchronous results for authenticated callers", () => {
    const access = createAccess({ auth: fakeAuth({ authenticated: true }) });
    expect(access.guard('trips.phaseOf', () => 'upcoming')()).toBe('upcoming');
  });

  it("'guest' ensures a guest session first when neither authenticated nor guest", async () => {
    const auth = fakeAuth();
    const gate = deferred();
    auth.ensureGuestSession.mockImplementation(() => gate.promise);
    const access = createAccess({ auth, events: fakeEvents() });
    const fn = vi.fn(async (a) => `ok:${a}`);
    const guarded = access.guard('booking.create', fn);

    const pending = guarded('it-1');
    await Promise.resolve();
    expect(auth.ensureGuestSession).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled(); // waits for the session

    gate.resolve({ guestId: 'g' });
    await expect(pending).resolves.toBe('ok:it-1');
    expect(fn).toHaveBeenCalledWith('it-1');
  });

  it("'guest' skips ensureGuestSession for guests and authenticated users", async () => {
    for (const state of [{ guest: true }, { authenticated: true }]) {
      const auth = fakeAuth(state);
      const access = createAccess({ auth });
      const fn = vi.fn(() => 'sync');
      expect(access.guard('itinerary.create', fn)()).toBe('sync');
      expect(auth.ensureGuestSession).not.toHaveBeenCalled();
    }
  });

  it("'guest' propagates ensureGuestSession failures and does not call fn", async () => {
    const auth = fakeAuth();
    const boom = new AuthError('no guests', { reason: 'forbidden' });
    auth.ensureGuestSession.mockRejectedValue(boom);
    const access = createAccess({ auth });
    const fn = vi.fn();
    const { ok, error } = await settle(access.guard('booking.create', fn)());
    expect(ok).toBe(false);
    expect(error).toBe(boom);
    expect(fn).not.toHaveBeenCalled();
  });

  it("'guest' turns a synchronous throw from ensureGuestSession into a rejection", async () => {
    const auth = fakeAuth();
    const boom = new ConfigError('guest disabled');
    auth.ensureGuestSession.mockImplementation(() => {
      throw boom;
    });
    const access = createAccess({ auth });
    const { ok, error } = await settle(access.guard('booking.create', vi.fn())());
    expect(ok).toBe(false);
    expect(error).toBe(boom);
  });

  it('resolves the level at call time, so setPolicy affects already-guarded functions', async () => {
    const auth = fakeAuth();
    const events = fakeEvents();
    const access = createAccess({ auth, events, policy: { default: 'open' } });
    const fn = vi.fn(() => 'value');
    const guarded = access.guard('m.fn', fn);
    expect(guarded()).toBe('value');

    access.setPolicy({ rules: { 'm.*': 'auth' } });
    const { ok, error } = await settle(guarded());
    expect(ok).toBe(false);
    expect(error).toBeInstanceOf(AuthError);

    auth.state.authenticated = true;
    expect(guarded()).toBe('value');
  });

  it("works without an auth object: 'auth' rejects, 'guest' and 'open' call through", async () => {
    const access = createAccess({ policy: { rules: { 'a.x': 'auth', 'a.y': 'guest' } } });
    const { ok, error } = await settle(access.guard('a.x', vi.fn())());
    expect(ok).toBe(false);
    expect(error).toBeInstanceOf(AuthError);
    expect(access.guard('a.y', () => 'y')()).toBe('y');
    expect(access.guard('a.z', () => 'z')()).toBe('z');
  });

  it('never throws out of a misbehaving emitter', async () => {
    const events = {
      emit: vi.fn(() => {
        throw new Error('listener bug');
      }),
    };
    const access = createAccess({ auth: fakeAuth(), events });
    const { ok, error } = await settle(access.guard('trips.list', vi.fn())());
    expect(ok).toBe(false);
    expect(error).toBeInstanceOf(AuthError);
    expect(events.emit).toHaveBeenCalled();
  });

  it('keeps the wrapped function name for debugging', () => {
    const access = createAccess();
    function listTrips() {}
    expect(access.guard('trips.list', listTrips).name).toBe('listTrips');
  });

  it('validates its arguments with ValidationError', () => {
    const access = createAccess();
    expect(() => access.guard('bad key', () => {})).toThrow(ValidationError);
    expect(() => access.guard('m.fn', 'not a function')).toThrow(ValidationError);
    expect(() => access.guard('m.fn')).toThrow(ValidationError);
    expect(() => access.guard('m.fn', () => {})).not.toThrow(Error);
  });
});

describe('wrap', () => {
  function sampleApi() {
    const disruptions = vi.fn(async () => 'list');
    disruptions.respond = vi.fn(async () => 'responded');
    return {
      list: vi.fn(async () => ['t']),
      phaseOf: vi.fn(() => 'past'),
      changes: { quote: vi.fn(async () => 'q'), confirm: vi.fn(async () => 'c') },
      requests: { nested: { deep: vi.fn(async () => 'd') } },
      disruptions,
      destroy: vi.fn(() => 'destroyed'),
      VERSION: '1.0',
      limits: { max: 9 },
      list2: null,
      tags: ['a', 'b'],
    };
  }

  it('returns the same shape with functions guarded under module.group.fn keys', async () => {
    const auth = fakeAuth();
    const events = fakeEvents();
    const access = createAccess({
      auth,
      events,
      policy: {
        default: 'open',
        rules: {
          'trips.list': 'auth',
          'trips.changes.*': 'auth',
          'trips.requests.nested.deep': 'auth',
          'trips.disruptions.respond': 'auth',
        },
      },
    });
    const api = sampleApi();
    const wrapped = access.wrap('trips', api);

    expect(wrapped).not.toBe(api);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(api).sort());

    // guarded (auth) functions reject while anonymous …
    for (const [key, call] of [
      ['trips.list', () => wrapped.list()],
      ['trips.changes.quote', () => wrapped.changes.quote()],
      ['trips.changes.confirm', () => wrapped.changes.confirm()],
      ['trips.requests.nested.deep', () => wrapped.requests.nested.deep()],
      ['trips.disruptions.respond', () => wrapped.disruptions.respond()],
    ]) {
      events.emit.mockClear();
      const { ok, error } = await settle(call());
      expect(ok, key).toBe(false);
      expect(error.key, key).toBe(key);
      expect(events.emit).toHaveBeenCalledWith('auth:required', { key });
    }
    expect(api.list).not.toHaveBeenCalled();
    expect(api.changes.quote).not.toHaveBeenCalled();

    // … open ones call through synchronously
    expect(wrapped.phaseOf()).toBe('past');
    await expect(wrapped.disruptions()).resolves.toBe('list');

    // … and after login everything works
    auth.state.authenticated = true;
    await expect(wrapped.list()).resolves.toEqual(['t']);
    await expect(wrapped.changes.quote()).resolves.toBe('q');
    await expect(wrapped.requests.nested.deep()).resolves.toBe('d');
    await expect(wrapped.disruptions.respond()).resolves.toBe('responded');
  });

  it('preserves non-function values as they are', () => {
    const access = createAccess();
    const api = sampleApi();
    const wrapped = access.wrap('trips', api);
    expect(wrapped.VERSION).toBe('1.0');
    expect(wrapped.list2).toBeNull();
    expect(wrapped.tags).toBe(api.tags);
    expect(wrapped.limits).toEqual({ max: 9 });
    expect(wrapped.limits).not.toBe(api.limits); // plain objects are re-created (functions inside get wrapped)
  });

  it('leaves class instances alone (only plain objects are walked)', () => {
    class Store {
      get() {
        return 1;
      }
    }
    const store = new Store();
    const access = createAccess({ policy: { default: 'auth' } });
    const wrapped = access.wrap('m', { store });
    expect(wrapped.store).toBe(store);
  });

  it("never gates the module's destroy() even under an auth-only policy", async () => {
    const auth = fakeAuth();
    const access = createAccess({ auth, policy: { default: 'auth' } });
    const api = sampleApi();
    const wrapped = access.wrap('trips', api);
    expect(wrapped.destroy()).toBe('destroyed'); // synchronous, no rejection
    expect(api.destroy).toHaveBeenCalledTimes(1);
    // but a nested `destroy` is an ordinary function
    const { ok } = await settle(wrapped.changes.quote());
    expect(ok).toBe(false);
  });

  it('uses the default policy when wrapping real module names', async () => {
    const auth = fakeAuth();
    const access = createAccess({ auth, events: fakeEvents() });
    const booking = access.wrap('booking', { create: vi.fn(async () => 'b'), current: () => null });
    const account = access.wrap('account', { me: vi.fn(async () => 'me') });

    // anonymous: 'guest' level → the guest session is created first, so even a sync read is a Promise
    await expect(booking.current()).resolves.toBeNull();
    expect(auth.ensureGuestSession).toHaveBeenCalledTimes(1);
    expect(auth.state.guest).toBe(true);
    // once a guest session exists, calls go straight through (sync reads stay sync)
    expect(booking.current()).toBeNull();
    await expect(booking.create()).resolves.toBe('b');
    expect(auth.ensureGuestSession).toHaveBeenCalledTimes(1);

    const { ok, error } = await settle(account.me());
    expect(ok).toBe(false);
    expect(error.key).toBe('account.me');
  });

  it('validates its arguments', () => {
    const access = createAccess();
    expect(() => access.wrap('', {})).toThrow(ValidationError);
    expect(() => access.wrap('m', null)).toThrow(ValidationError);
    expect(() => access.wrap('m', [])).toThrow(ValidationError);
    expect(() => access.wrap('m', () => {})).toThrow(ValidationError);
    expect(access.wrap('m', {})).toEqual({});
  });
});

describe('can', () => {
  it("is true for 'open' and 'guest', and follows isAuthenticated for 'auth'", () => {
    const auth = fakeAuth();
    const access = createAccess({ auth });
    expect(access.can('search.create')).toBe(true);
    expect(access.can('booking.create')).toBe(true);
    expect(access.can('trips.list')).toBe(false);
    auth.state.authenticated = true;
    expect(access.can('trips.list')).toBe(true);
  });

  it("is false for 'auth' keys without an auth object", () => {
    expect(createAccess().can('account.me')).toBe(false);
    expect(createAccess().can('booking.create')).toBe(true);
  });
});

describe('setPolicy / policy', () => {
  it('replaces the policy and emits access:change with the new and previous policies', () => {
    const events = fakeEvents();
    const access = createAccess({ events });
    const before = access.policy();
    access.setPolicy({ default: 'guest', rules: { 'trips.*': 'auth' } });
    const after = access.policy();
    expect(after).toEqual({ default: 'guest', rules: { 'trips.*': 'auth' } });
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.rules)).toBe(true);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('access:change', { policy: after, previous: before });
    expect(access.levelOf('search.create')).toBe('guest');
    expect(access.levelOf('trips.list')).toBe('auth');
  });

  it('fills in default:open and empty rules for partial policies', () => {
    const access = createAccess({ events: fakeEvents() });
    access.setPolicy({ rules: { 'a.b': 'auth' } });
    expect(access.policy()).toEqual({ default: 'open', rules: { 'a.b': 'auth' } });
    access.setPolicy({ default: 'guest' });
    expect(access.policy()).toEqual({ default: 'guest', rules: {} });
  });

  it('resets to the default policy when called without an argument', () => {
    const access = createAccess({ policy: { default: 'auth' } });
    access.setPolicy();
    expect(access.policy()).toBe(DEFAULT_ACCESS_POLICY);
  });

  it('does not keep a reference to the caller’s object', () => {
    const access = createAccess();
    const mine = { default: 'open', rules: { 'a.b': 'auth' } };
    access.setPolicy(mine);
    mine.rules['a.b'] = 'open';
    mine.default = 'auth';
    expect(access.levelOf('a.b')).toBe('auth');
    expect(access.levelOf('z.z')).toBe('open');
  });

  it('rejects invalid policies with ConfigError and keeps the current one', () => {
    const events = fakeEvents();
    const access = createAccess({ events, policy: { default: 'guest' } });
    const invalid = [
      'open',
      42,
      [],
      { default: 'admin' },
      { default: 1 },
      { rules: 'trips.*' },
      { rules: { 'trips.*': 'superuser' } },
      { rules: { 'bad key': 'auth' } },
      { rules: { '': 'auth' } },
    ];
    for (const policy of invalid) {
      expect(() => access.setPolicy(policy), JSON.stringify(policy)).toThrow(ConfigError);
    }
    expect(() => createAccess({ policy: { default: 'nope' } })).toThrow(ConfigError);
    expect(access.policy()).toEqual({ default: 'guest', rules: {} });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('returns a frozen policy that cannot be mutated by callers', () => {
    const access = createAccess();
    const policy = access.policy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      'use strict';
      policy.rules['booking.*'] = 'auth';
    }).toThrow(TypeError);
    expect(access.levelOf('booking.create')).toBe('guest');
  });
});

describe('integration with the real emitter', () => {
  it('emits auth:required and access:change as enveloped events and registers no listeners itself', async () => {
    const events = createEmitter();
    const auth = fakeAuth();
    const access = createAccess({ auth, events });
    expect(events.listenerCount('auth:required')).toBe(0);

    const required = [];
    const changes = [];
    const offA = events.on('auth:required', (e) => required.push(e));
    const offB = events.on('access:change', (e) => changes.push(e));

    const { ok, error } = await settle(access.guard('account.me', vi.fn())());
    expect(ok).toBe(false);
    expect(error).toBeInstanceOf(AuthError);
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ type: 'auth:required', key: 'account.me' });
    expect(typeof required[0].at).toBe('number');

    access.setPolicy({ default: 'open' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: 'access:change', policy: { default: 'open' } });

    offA();
    offB();
    expect(events.listenerCount('auth:required')).toBe(0);
    expect(events.listenerCount('access:change')).toBe(0);
  });

  it('starts no timers', () => {
    vi.useFakeTimers();
    const access = createAccess({ auth: fakeAuth(), events: createEmitter() });
    access.wrap('trips', { list: async () => [] });
    access.setPolicy({ default: 'open' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
