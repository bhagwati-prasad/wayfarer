import vm from 'node:vm';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';
import { ValidationError } from '../../src/errors/index.js';

const METHODS = ['error', 'warn', 'info', 'debug'];

/** Console-like sink with one spy per level (plus `log`). */
function consoleSink() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
}

/** Function sink that records every entry it receives. */
function entrySink() {
  const entries = [];
  const sink = vi.fn((e) => entries.push(e));
  return { sink, entries };
}

/** Which of the four methods actually wrote something. */
function written(sink) {
  return METHODS.filter((m) => sink[m].mock.calls.length > 0);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createLogger / levels', () => {
  it('defaults to warn: error and warn write, info and debug are dropped', () => {
    const sink = consoleSink();
    const log = createLogger({ sink });
    expect(log.level).toBe('warn');
    for (const m of METHODS) log[m](m);
    expect(written(sink)).toEqual(['error', 'warn']);
  });

  it.each([
    ['silent', []],
    ['error', ['error']],
    ['warn', ['error', 'warn']],
    ['info', ['error', 'warn', 'info']],
    ['debug', ['error', 'warn', 'info', 'debug']],
  ])('level %s writes %j', (level, expected) => {
    const sink = consoleSink();
    const log = createLogger({ level, sink });
    for (const m of METHODS) log[m](m);
    expect(written(sink)).toEqual(expected);
  });

  it('setLevel re-gates subsequent calls and is reflected by `level`', () => {
    const sink = consoleSink();
    const log = createLogger({ level: 'silent', sink });
    log.error('dropped');
    expect(written(sink)).toEqual([]);
    log.setLevel('debug');
    expect(log.level).toBe('debug');
    log.debug('kept');
    expect(sink.debug).toHaveBeenCalledWith('kept');
    log.setLevel('error');
    log.warn('dropped again');
    expect(sink.warn).not.toHaveBeenCalled();
  });

  it('rejects unknown levels with a ValidationError carrying an issue on `level`', () => {
    expect(() => createLogger({ level: 'verbose' })).toThrow(ValidationError);
    expect(() => createLogger({ level: 2 })).toThrow(ValidationError);
    const log = createLogger({ sink: consoleSink() });
    let caught;
    try {
      log.setLevel('loud');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.issues).toEqual([
      { path: 'level', code: 'invalid_level', message: expect.stringContaining('silent') },
    ]);
    // the failed call left the level untouched
    expect(log.level).toBe('warn');
    // an explicit set to nothing is still a bad argument
    expect(() => log.setLevel(null)).toThrow(ValidationError);
    expect(() => log.setLevel(undefined)).toThrow(ValidationError);
    expect(log.level).toBe('warn');
  });

  it('treats a nullish level option as "not given" like the other options', () => {
    expect(createLogger({ level: null, sink: consoleSink() }).level).toBe('warn');
    expect(createLogger({ level: undefined, sink: consoleSink() }).level).toBe('warn');
  });

  it('validates the other options', () => {
    expect(() => createLogger(null)).toThrow(ValidationError);
    expect(() => createLogger({ sink: 'console' })).toThrow(ValidationError);
    expect(() => createLogger({ redact: 'password' })).toThrow(ValidationError);
    expect(() => createLogger({ redact: ['ok', 1] })).toThrow(ValidationError);
    expect(() => createLogger({ scope: 42 })).toThrow(ValidationError);
    // nullish optional fields are accepted
    expect(() => createLogger({ sink: null, redact: null, scope: null })).not.toThrow();
    expect(() => createLogger()).not.toThrow();
  });

  it('exposes exactly the documented surface', () => {
    const log = createLogger({ sink: consoleSink() });
    for (const m of [...METHODS, 'child', 'setLevel', 'redact']) {
      expect(typeof log[m]).toBe('function');
    }
    expect(log.scope).toBe('');
  });
});

describe('sinks', () => {
  it('calls the console-like method with (msg) or (msg, data), bound to the sink', () => {
    const sink = consoleSink();
    const log = createLogger({ level: 'debug', sink });
    log.info('plain');
    log.warn('with data', { a: 1 });
    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.info.mock.calls[0]).toEqual(['plain']);
    expect(sink.warn.mock.calls[0]).toEqual(['with data', { a: 1 }]);
    expect(sink.warn.mock.contexts[0]).toBe(sink);
    expect(sink.log).not.toHaveBeenCalled();
  });

  it('falls back to `log` when the level method is missing, and stays quiet without either', () => {
    const log = vi.fn();
    const logger = createLogger({ level: 'debug', sink: { log } });
    logger.debug('d');
    logger.error('e', 1);
    expect(log.mock.calls).toEqual([['d'], ['e', 1]]);
    expect(() => createLogger({ level: 'debug', sink: {} }).error('nowhere')).not.toThrow();
  });

  it('hands a structured entry to a function sink', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { sink, entries } = entrySink();
    const log = createLogger({ level: 'debug', sink });
    log.info('hello');
    log.error('oops', { code: 'E' });
    expect(entries).toEqual([
      { level: 'info', scope: '', msg: 'hello', at: 1_700_000_000_000 },
      { level: 'error', scope: '', msg: 'oops', data: { code: 'E' }, at: 1_700_000_000_000 },
    ]);
    expect('data' in entries[0]).toBe(false);
    expect(sink.mock.calls[0]).toHaveLength(1);
  });

  it('defaults to globalThis.console, resolved at call time', () => {
    const fake = consoleSink();
    vi.stubGlobal('console', fake);
    const log = createLogger({ level: 'debug' });
    log.info('to console', { ok: true });
    expect(fake.info).toHaveBeenCalledWith('to console', { ok: true });
    // a later swap of the global is picked up because the sink is not captured at creation
    const later = consoleSink();
    vi.stubGlobal('console', later);
    log.warn('later');
    expect(later.warn).toHaveBeenCalledWith('later');
    expect(fake.warn).not.toHaveBeenCalled();
  });

  it('does nothing (and does not throw) when no console exists', () => {
    vi.stubGlobal('console', undefined);
    const log = createLogger({ level: 'debug' });
    expect(() => log.error('nowhere to go')).not.toThrow();
  });

  it('swallows sink failures so logging can never break the caller', () => {
    const boom = () => {
      throw new TypeError('sink down');
    };
    expect(() => createLogger({ level: 'debug', sink: boom }).info('x')).not.toThrow();
    expect(() => createLogger({ level: 'debug', sink: { info: boom } }).info('x')).not.toThrow();
    expect(() => createLogger({ level: 'debug', sink: { log: boom } }).info('x')).not.toThrow();
    const hostile = {
      get info() {
        throw new TypeError('no such method');
      },
    };
    expect(() => createLogger({ level: 'debug', sink: hostile }).info('x')).not.toThrow();
  });

  it('passes an explicit null data argument through (only undefined means "no data")', () => {
    const sink = consoleSink();
    const { sink: fn, entries } = entrySink();
    createLogger({ level: 'debug', sink }).info('n', null);
    createLogger({ level: 'debug', sink: fn }).info('n', null);
    expect(sink.info.mock.calls[0]).toEqual(['n', null]);
    expect(entries[0]).toMatchObject({ msg: 'n', data: null });
    expect('data' in entries[0]).toBe(true);
  });

  it('never throws out of a log call, whatever the message or payload does', () => {
    const { sink, entries } = entrySink();
    const log = createLogger({ level: 'debug', sink });

    const trap = { ok: 1 };
    Object.defineProperty(trap, 'secret', {
      enumerable: true,
      get() {
        throw new Error('should be isolated');
      },
    });
    expect(() => log.error('getter', trap)).not.toThrow();
    expect(entries.at(-1)).toMatchObject({
      msg: 'getter',
      data: { ok: 1, secret: '[Unreadable]' },
    });

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => log.error('revoked data', proxy)).not.toThrow();
    expect(entries.at(-1)).toMatchObject({ msg: 'revoked data', data: '[Unreadable]' });
    expect(() => log.error('nested', { list: [proxy], ok: true })).not.toThrow();
    expect(entries.at(-1).data).toEqual({ list: ['[Unreadable]'], ok: true });

    const badString = {
      toString() {
        throw new Error('no string for you');
      },
    };
    expect(() => log.error(badString)).not.toThrow();
    expect(entries.at(-1)).toMatchObject({ msg: '[Unreadable]' });
    expect(() => log.error(proxy)).not.toThrow();
    expect(entries.at(-1)).toMatchObject({ msg: '[Unreadable]' });

    // even the clock failing is not the caller's problem
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('no clock');
    });
    expect(() => log.error('no clock')).not.toThrow();
  });

  it('coerces non-string messages (an Error contributes its message)', () => {
    const sink = consoleSink();
    const log = createLogger({ level: 'debug', sink });
    log.error(new Error('failed hard'));
    log.info(42);
    expect(sink.error).toHaveBeenCalledWith('failed hard');
    expect(sink.info).toHaveBeenCalledWith('42');
  });

  it('skips redaction work entirely for suppressed calls', () => {
    const sink = consoleSink();
    const log = createLogger({ level: 'error', sink });
    const trap = {};
    Object.defineProperty(trap, 'secret', {
      enumerable: true,
      get() {
        throw new Error('should not be read');
      },
    });
    expect(() => log.debug('dropped', trap)).not.toThrow();
    expect(written(sink)).toEqual([]);
  });
});

describe('child', () => {
  it('prefixes messages with the dotted scope', () => {
    const sink = consoleSink();
    const root = createLogger({ level: 'debug', sink });
    const search = root.child('search');
    const poll = search.child('poll');
    root.info('r');
    search.info('s');
    poll.info('p', { n: 1 });
    expect(sink.info.mock.calls).toEqual([['r'], ['[search] s'], ['[search.poll] p', { n: 1 }]]);
    expect(search.scope).toBe('search');
    expect(poll.scope).toBe('search.poll');
  });

  it('starts from the root scope option and trims the names', () => {
    const sink = consoleSink();
    const root = createLogger({ level: 'debug', sink, scope: 'wayfarer' });
    root.warn('w');
    root.child('  http ').warn('h');
    expect(sink.warn.mock.calls).toEqual([['[wayfarer] w'], ['[wayfarer.http] h']]);
    // a blank root scope is the same as none
    const blank = createLogger({ level: 'debug', sink, scope: '   ' });
    blank.info('b');
    expect(blank.scope).toBe('');
    expect(sink.info.mock.calls).toEqual([['b']]);
  });

  it('masks PANs in a scoped message after prefixing', () => {
    const sink = consoleSink();
    createLogger({ level: 'debug', sink }).child('pay').warn('card 4111 1111 1111 1111 declined');
    createLogger({ level: 'debug', sink })
      .child('pay')
      .error(new Error('declined 4111111111111111'));
    expect(sink.warn).toHaveBeenCalledWith('[pay] card **** **** **** 1111 declined');
    expect(sink.error).toHaveBeenCalledWith('[pay] declined ************1111');
  });

  it('reports the scope separately to function sinks, message still prefixed', () => {
    const { sink, entries } = entrySink();
    createLogger({ level: 'debug', sink }).child('booking').child('status').debug('tick');
    expect(entries[0]).toMatchObject({
      level: 'debug',
      scope: 'booking.status',
      msg: '[booking.status] tick',
    });
  });

  it('inherits sink and level; root setLevel propagates until a child sets its own', () => {
    const sink = consoleSink();
    const root = createLogger({ level: 'warn', sink });
    const a = root.child('a');
    const aa = a.child('aa');
    const b = root.child('b');
    expect(a.level).toBe('warn');
    expect(aa.level).toBe('warn');

    root.setLevel('debug');
    expect([a.level, aa.level, b.level]).toEqual(['debug', 'debug', 'debug']);
    aa.debug('visible');
    expect(sink.debug).toHaveBeenCalledWith('[a.aa] visible');

    a.setLevel('error'); // overrides a and its subtree, not b
    expect([a.level, aa.level, b.level]).toEqual(['error', 'error', 'debug']);
    aa.warn('hidden');
    b.warn('shown');
    expect(sink.warn.mock.calls).toEqual([['[b] shown']]);

    root.setLevel('silent'); // b follows, a's subtree keeps its own level
    expect([a.level, aa.level, b.level]).toEqual(['error', 'error', 'silent']);
    aa.error('still');
    b.error('muted');
    expect(sink.error.mock.calls).toEqual([['[a.aa] still']]);
  });

  it('shares the redact list with the parent', () => {
    const { sink, entries } = entrySink();
    const child = createLogger({ level: 'debug', sink, redact: ['ssn'] }).child('x');
    child.info('m', { ssn: '1', password: '2', fine: '3' });
    expect(entries[0].data).toEqual({ ssn: '[REDACTED]', password: '[REDACTED]', fine: '3' });
    expect(child.redact({ ssn: 'a' })).toEqual({ ssn: '[REDACTED]' });
  });

  it('requires a non-empty string scope', () => {
    const root = createLogger({ sink: consoleSink() });
    for (const bad of ['', '   ', 42, null, undefined, {}]) {
      expect(() => root.child(bad)).toThrow(ValidationError);
    }
  });
});

describe('redact', () => {
  const log = createLogger({ level: 'debug', sink: consoleSink() });

  it('returns a deep clone and never mutates the input', () => {
    const input = { user: { name: 'Ann', password: 'pw', tags: ['a'] }, list: [{ token: 't' }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = log.redact(input);
    expect(out).not.toBe(input);
    expect(out.user).not.toBe(input.user);
    expect(out.user.tags).not.toBe(input.user.tags);
    expect(out.list[0]).not.toBe(input.list[0]);
    expect(input).toEqual(snapshot);
    expect(out).toEqual({
      user: { name: 'Ann', password: '[REDACTED]', tags: ['a'] },
      list: [{ token: '[REDACTED]' }],
    });
  });

  it('masks every default key, case-insensitively', () => {
    const keys = [
      'authorization',
      'password',
      'card',
      'documents',
      'token',
      'refreshToken',
      'cvc',
      'cvv',
      'pan',
      'passport',
    ];
    for (const key of keys) {
      for (const variant of [key, key.toUpperCase(), key[0].toUpperCase() + key.slice(1)]) {
        expect(log.redact({ [variant]: 'x' })).toEqual({ [variant]: '[REDACTED]' });
      }
    }
  });

  it('matches keys word-wise across camelCase, snake_case, kebab-case and headers', () => {
    const out = log.redact({
      accessToken: 'a',
      refresh_token: 'b',
      'X-Guest-Token': 'c',
      cardNumber: 'd',
      passportNumber: 'e',
      newPassword: 'f',
      document: { number: 'g' },
      'Proxy-Authorization': 'h',
      card2: 'i',
    });
    expect(Object.values(out).every((v) => v === '[REDACTED]')).toBe(true);
  });

  it('does not over-match keys that merely contain a redacted word', () => {
    const input = {
      companyName: 'Acme',
      expand: true,
      panel: 'left',
      japan: 'JP',
      tokenizerVersion: 2,
      cardinal: 'N',
      discard: false,
      tokenless: 1,
    };
    expect(log.redact(input)).toEqual(input);
  });

  it('keeps null / undefined under redacted keys but masks every other type', () => {
    expect(
      log.redact({ token: null, password: undefined, card: {}, cvc: 123, documents: [], pan: true })
    ).toEqual({
      token: null,
      password: undefined,
      card: '[REDACTED]',
      cvc: '[REDACTED]',
      documents: '[REDACTED]',
      pan: '[REDACTED]',
    });
  });

  it('extends (never replaces) the default list with the redact option', () => {
    const custom = createLogger({ redact: ['ssn', 'secretAnswer'], sink: consoleSink() });
    expect(
      custom.redact({ ssn: '1', secret_answer: '2', password: '3', card: '4', other: '5' })
    ).toEqual({
      ssn: '[REDACTED]',
      secret_answer: '[REDACTED]',
      password: '[REDACTED]',
      card: '[REDACTED]',
      other: '5',
    });
  });

  it.each([
    ['4111111111111111', '************1111'],
    ['4111 1111 1111 1111', '**** **** **** 1111'],
    ['4111-1111-1111-1111', '****-****-****-1111'],
    ['378282246310005', '***********0005'],
    ['4222222222222', '*********2222'],
    ['6200000000000000000', '***************0000'],
    ['card 4111111111111111 declined', 'card ************1111 declined'],
    ['a=4111111111111111;b=5555555555554444', 'a=************1111;b=************4444'],
  ])('masks Luhn-valid 13-19 digit runs anywhere in a string: %s', (input, expected) => {
    expect(log.redact(input)).toBe(expected);
    expect(log.redact({ note: input })).toEqual({ note: expected });
    expect(log.redact([input])).toEqual([expected]);
  });

  it.each([
    ['order 20251018 4111 1111 1111 1111', 'order 20251018 **** **** **** 1111'],
    ['ref 1234 4111 1111 1111 1111', 'ref 1234 **** **** **** 1111'],
    ['4111 1111 1111 1111 123', '**** **** **** 1111 123'],
    ['4111 1111 1111 1111 12', '**** **** **** 1111 12'],
    ['4111-1111-1111-1111 exp 12-26', '****-****-****-1111 exp 12-26'],
    ['41111111 11111111 123', '******** ****1111 123'],
    ['3782 822463 10005', '**** ****** *0005'],
    ['seat 12A 4111111111111111', 'seat 12A ************1111'],
  ])('masks a PAN that shares a separated digit group with other digits: %s', (input, expected) => {
    expect(log.redact(input)).toBe(expected);
    expect(log.redact({ note: input })).toEqual({ note: expected });
  });

  it('masks every PAN when two share one digit group (over-masking is the safe side)', () => {
    const out = log.redact('4111 1111 1111 1111 5555 5555 5555 4444');
    expect(out).not.toContain('4111');
    expect(out).not.toContain('5555');
    expect(out).toMatch(/^[* ]+4444$/);
  });

  it.each([
    ['4111111111111112', 'Luhn-invalid'],
    ['411111111111', 'too short (12)'],
    ['41111111111111110000', 'part of a longer digit run'],
    [
      '12344111111111111111',
      'PAN glued to a digit prefix without a separator (single run, 20 digits)',
    ],
    ['1700000000000', 'Luhn-invalid 13-digit timestamp'],
    ['12 14 16 18 20 22 24', 'separated numbers whose only 13+ window is Luhn-invalid'],
    ['ids 1001 1002 1003 1004', 'separated ids, Luhn-invalid'],
    ['4111  1111  1111  1111', 'double separators break the group'],
    ['PNR ABC123 flight AI 101', 'ordinary text'],
    ['', 'empty'],
  ])('leaves %s alone (%s)', (input) => {
    expect(log.redact(input)).toBe(input);
  });

  it('unboxes boxed primitives instead of spreading them one character per index', () => {
    expect(log.redact(new String('4111111111111111'))).toBe('************1111');
    expect(log.redact({ n: new Number(5), b: new Boolean(false), s: new String('x') })).toEqual({
      n: 5,
      b: false,
      s: 'x',
    });
    expect(log.redact({ card: new String('4111111111111111') })).toEqual({ card: '[REDACTED]' });
  });

  it('passes primitives through untouched', () => {
    for (const v of [0, 4111111111111111, true, false, null, undefined, 12n, Symbol.for('s')]) {
      expect(log.redact(v)).toBe(v);
    }
  });

  it('walks Map, Set and arrays, clones Dates and RegExps', () => {
    const d = new Date(0);
    const re = /x/g;
    const out = log.redact({
      m: new Map([
        ['token', 't'],
        ['k', '4111111111111111'],
      ]),
      s: new Set(['4111111111111111', 1]),
      arr: [['4111111111111111'], { password: 'p' }],
      d,
      re,
    });
    expect(out.m).toEqual(
      new Map([
        ['token', '[REDACTED]'],
        ['k', '************1111'],
      ])
    );
    expect(out.s).toEqual(new Set(['************1111', 1]));
    expect(out.arr).toEqual([['************1111'], { password: '[REDACTED]' }]);
    expect(out.d).toEqual(d);
    expect(out.d).not.toBe(d);
    expect(out.re).toEqual(re);
    expect(out.re).not.toBe(re);
  });

  it('turns errors into plain records with masked message and stack and redacted own fields', () => {
    const err = new Error('declined 4111111111111111');
    err.code = 'CARD_DECLINED';
    err.token = 'abc';
    const out = log.redact({ err });
    expect(out.err).not.toBeInstanceOf(Error);
    expect(out.err).toMatchObject({
      name: 'Error',
      message: 'declined ************1111',
      code: 'CARD_DECLINED',
      token: '[REDACTED]',
    });
    expect(out.err.stack).toContain('declined ************1111');
    expect(out.err.stack).not.toContain('4111111111111111');
  });

  it('recognises errors from another realm', () => {
    const foreign = vm.runInNewContext(
      'const e = new Error("foreign 4111111111111111"); e.code = "X"; e.token = "t"; e'
    );
    expect(foreign instanceof Error).toBe(false);
    const out = log.redact({ foreign });
    expect(out.foreign).toMatchObject({
      name: 'Error',
      message: 'foreign ************1111',
      code: 'X',
      token: '[REDACTED]',
    });
    expect(out.foreign.stack).toContain('foreign ************1111');
    expect(out.foreign.stack).not.toContain('4111111111111111');
    // and as a message
    const sink = consoleSink();
    createLogger({ level: 'debug', sink }).error(foreign);
    expect(sink.error).toHaveBeenCalledWith('foreign ************1111');
  });

  it('carries `cause` and AggregateError `errors` (non-enumerable on native errors), redacted', () => {
    const err = new Error('outer', { cause: { token: 't', pan: '4111111111111111', ok: 1 } });
    expect(Object.keys(err)).not.toContain('cause');
    expect(log.redact(err)).toMatchObject({
      name: 'Error',
      message: 'outer',
      cause: { token: '[REDACTED]', pan: '[REDACTED]', ok: 1 },
    });

    const chained = new Error('top', {
      cause: new Error('mid 4111111111111111', { cause: 'leaf' }),
    });
    const out = log.redact(chained);
    expect(out.cause).toMatchObject({
      name: 'Error',
      message: 'mid ************1111',
      cause: 'leaf',
    });

    const loop = new Error('loop');
    loop.cause = loop;
    expect(log.redact(loop)).toMatchObject({ message: 'loop', cause: '[Circular]' });

    const agg = new AggregateError([new Error('a 4111111111111111'), { token: 't' }], 'many');
    expect(Object.keys(agg)).not.toContain('errors');
    expect(log.redact(agg)).toMatchObject({
      name: 'AggregateError',
      message: 'many',
      errors: [{ name: 'Error', message: 'a ************1111' }, { token: '[REDACTED]' }],
    });
  });

  it('never throws on unreadable input; the unreadable part becomes [Unreadable]', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(log.redact(proxy)).toBe('[Unreadable]');
    expect(log.redact([proxy, 1])).toEqual(['[Unreadable]', 1]);

    const trap = { ok: 1 };
    Object.defineProperty(trap, 'secret', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(log.redact(trap)).toEqual({ ok: 1, secret: '[Unreadable]' });

    const noKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys');
        },
      }
    );
    expect(log.redact({ noKeys, ok: 1 })).toEqual({ noKeys: '[Unreadable]', ok: 1 });

    const fn = function named() {};
    Object.defineProperty(fn, 'name', {
      get() {
        throw new Error('no name');
      },
    });
    expect(log.redact({ fn })).toEqual({ fn: '[Unreadable]' });
  });

  it('replaces cycles with [Circular] but clones repeated non-cyclic references', () => {
    const shared = { v: 1 };
    const cyc = { shared, again: shared };
    cyc.self = cyc;
    cyc.list = [cyc];
    const out = log.redact(cyc);
    expect(out).toEqual({
      shared: { v: 1 },
      again: { v: 1 },
      self: '[Circular]',
      list: ['[Circular]'],
    });
    expect(out.shared).not.toBe(out.again);
  });

  it('summarises functions and binary data, flattens class instances', () => {
    class Thing {
      constructor() {
        this.password = 'p';
        this.ok = 1;
      }
    }
    const out = log.redact({
      fn: function named() {},
      anon: () => {},
      buf: new Uint8Array(3),
      t: new Thing(),
    });
    expect(out.fn).toBe('[Function: named]');
    expect(out.anon).toBe('[Function: anon]');
    expect(out.buf).toBe('[Binary: 3 bytes]');
    expect(out.t).toEqual({ password: '[REDACTED]', ok: 1 });
    expect(out.t).not.toBeInstanceOf(Thing);
  });

  it('stops at a depth limit instead of recursing forever', () => {
    const root = {};
    let cur = root;
    for (let i = 0; i < 80; i++) {
      cur.n = {};
      cur = cur.n;
    }
    let out = log.redact(root);
    let depth = 0;
    while (out && typeof out === 'object') {
      out = out.n;
      depth++;
    }
    expect(out).toBe('[Truncated]');
    expect(depth).toBe(64);
  });

  it('copies a "__proto__" key as an own property without polluting prototypes', () => {
    const out = log.redact(JSON.parse('{"__proto__": {"polluted": 1}, "password": "x"}'));
    expect(Object.keys(out)).toEqual(['__proto__', 'password']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
    expect(out.password).toBe('[REDACTED]');
  });

  it('redacts the message and data of every log call before they reach the sink', () => {
    const sink = consoleSink();
    const l = createLogger({ level: 'debug', sink });
    const data = { Authorization: 'Bearer x', body: { card: { number: '1' } }, pnr: 'ABC123' };
    l.info('paid with 4111 1111 1111 1111', data);
    expect(sink.info).toHaveBeenCalledWith('paid with **** **** **** 1111', {
      Authorization: '[REDACTED]',
      body: { card: '[REDACTED]' },
      pnr: 'ABC123',
    });
    // the caller's object was not touched
    expect(data.Authorization).toBe('Bearer x');
  });
});

describe('cleanup', () => {
  it('starts no timers and keeps no state beyond the logger itself', () => {
    vi.useFakeTimers();
    const sink = consoleSink();
    const log = createLogger({ level: 'debug', sink });
    const child = log.child('x');
    for (let i = 0; i < 20; i++) {
      log.debug('a', { i });
      child.error('b', { token: i });
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(sink.debug).toHaveBeenCalledTimes(20);
    expect(sink.error).toHaveBeenCalledTimes(20);
    // two independent roots never share level state
    const other = createLogger({ level: 'silent', sink });
    log.setLevel('error');
    expect(other.level).toBe('silent');
    other.setLevel('debug');
    expect(log.level).toBe('error');
  });
});
