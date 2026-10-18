import { describe, it, expect, vi, afterEach } from 'vitest';
import { createI18n } from '../../src/utils/i18n.js';
import { en } from '../../src/utils/messages/en.js';
import {
  AbortError,
  ApiError,
  AuthError,
  BookingError,
  ConfigError,
  ConflictError,
  ERROR_CODES,
  ItineraryExpiredError,
  NetworkError,
  NotFoundError,
  OfferExpiredError,
  OfferUnavailableError,
  PaymentError,
  PriceChangedError,
  RateLimitError,
  SdkError,
  SearchExpiredError,
  ServicingError,
  StorageError,
  TimeoutError,
  UnprocessableError,
  UnsupportedError,
  ValidationError,
  isSdkError,
  toUserMessage,
} from '../../src/errors/index.js';

/** A copy of the real `Intl` with some constructors removed (its properties are non-enumerable). */
function intlWithout(...names) {
  const fake = {};
  for (const k of Object.getOwnPropertyNames(Intl)) fake[k] = Intl[k];
  for (const n of names) fake[n] = undefined;
  return fake;
}

/** Instances covering every branch of `errors.toUserMessage`'s copy selection. */
function everyUserMessageError() {
  const money = (amount) => ({ amount, currency: 'INR' });
  return [
    new NetworkError('x'),
    new TimeoutError('x'),
    new AbortError('x'),
    new ValidationError('x'),
    new ConfigError('x'),
    new StorageError('x'),
    new UnsupportedError('x'),
    ...[
      'unauthenticated',
      'expired',
      'forbidden',
      'invalid_credentials',
      'mfa_required',
      'otp_invalid',
      'otp_expired',
      'locked',
    ].map((reason) => new AuthError('x', { reason })),
    new RateLimitError('x'),
    new RateLimitError('x', { retryAfterMs: 4000 }),
    new NotFoundError('x'),
    new ConflictError('x'),
    new SearchExpiredError('x'),
    new OfferExpiredError('x'),
    ...['sold_out', 'withdrawn', 'schedule_changed'].map(
      (reason) => new OfferUnavailableError('x', { reason })
    ),
    new PriceChangedError('x'),
    new PriceChangedError('x', { from: money('100'), to: money('120') }),
    new ItineraryExpiredError('x'),
    ...['retry_payment', 'search_again', 'contact_support', 'wait'].map(
      (suggestedAction) => new BookingError('x', { suggestedAction })
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
    ].map((reason) => new PaymentError('x', { reason })),
    new ServicingError('x'),
    new UnprocessableError('x'),
    new ApiError('x', { status: 503 }),
    new ApiError('x', { status: 400 }),
    new SdkError('x'),
    new Error('plain'),
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createI18n', () => {
  it('defaults to the fallback locale with the bundled English messages', () => {
    const i18n = createI18n();
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.locales()).toEqual(['en']);
    expect(i18n.t('ui.continue')).toBe('Continue');
    expect(i18n.dir()).toBe('ltr');
  });

  it('canonicalises the initial locale and merges host bundles over en', () => {
    const i18n = createI18n({
      locale: 'en_in',
      messages: { 'en-IN': { ui: { continue: 'Proceed' } }, fr: { ui: { back: 'Retour' } } },
    });
    expect(i18n.getLocale()).toBe('en-IN');
    expect(i18n.locales()).toEqual(['en', 'en-IN', 'fr']);
    expect(i18n.t('ui.continue')).toBe('Proceed');
    expect(i18n.t('ui.back')).toBe('Back');
  });

  it('never exposes or mutates the frozen en bundle', () => {
    const i18n = createI18n({ messages: { en: { ui: { continue: 'Go' } } } });
    expect(i18n.t('ui.continue')).toBe('Go');
    expect(en.ui.continue).toBe('Continue');
    expect(Object.isFrozen(en)).toBe(true);
    expect(Object.isFrozen(en.ui)).toBe(true);
  });

  it.each([
    ['locale', { locale: 42 }],
    ['locale', { locale: '' }],
    ['fallback', { fallback: '' }],
    ['fallback', { fallback: [] }],
    ['fallback', { fallback: ['en', 7] }],
    ['messages', { messages: 'nope' }],
    ['messages', { messages: ['en'] }],
    ['messages.fr', { messages: { fr: 'bonjour' } }],
    ['missing', { missing: 'key' }],
    ['pluralRules', { pluralRules: {} }],
    ['pluralRules', { pluralRules: 'one' }],
    ['options', null],
  ])('rejects malformed option %s with a ValidationError', (path, options) => {
    let caught;
    try {
      createI18n(options);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.issues[0].path).toBe(path);
  });
});

describe('t() interpolation', () => {
  it('replaces {name} placeholders and leaves unknown ones in place', () => {
    const i18n = createI18n();
    expect(i18n.t('ui.step', { current: 2, total: 4 })).toBe('Step 2 of 4');
    expect(i18n.t('ui.step', { current: 2 })).toBe('Step 2 of {total}');
    expect(i18n.t('ui.step')).toBe('Step {current} of {total}');
    expect(i18n.t('ui.step', { current: null, total: undefined })).toBe(
      'Step {current} of {total}'
    );
  });

  it('formats numbers and dates for the active locale', () => {
    const i18n = createI18n({ locale: 'en' });
    i18n.addMessages('en', {
      test: {
        n: '{n}',
        pct: '{n, number, percent}',
        int: '{n, number, integer}',
        num: '{n, number}',
        d: '{d, date, long}',
        dShort: '{d, date, short}',
        tm: '{d, time, short}',
        auto: '{d}',
      },
    });
    const d = new Date(Date.UTC(2026, 10, 2, 12, 0, 0));
    expect(i18n.t('test.n', { n: 1234.5 })).toBe('1,234.5');
    expect(i18n.t('test.n', { n: '42' })).toBe('42');
    expect(i18n.t('test.n', { n: 10n })).toBe('10');
    expect(i18n.t('test.pct', { n: 0.156 })).toBe('16%');
    expect(i18n.t('test.int', { n: 3.7 })).toBe('4');
    expect(i18n.t('test.num', { n: 'abc' })).toBe('abc');
    expect(i18n.t('test.d', { d })).toContain('2026');
    expect(i18n.t('test.dShort', { d })).toMatch(/26/);
    expect(i18n.t('test.tm', { d })).toMatch(/\d/);
    expect(i18n.t('test.auto', { d })).toContain('2026');
    expect(i18n.t('test.d', { d: 'not a date' })).toBe('not a date');
    i18n.setLocale('de');
    expect(i18n.t('test.n', { n: 1234.5 })).toBe('1.234,5');
  });

  it('reads dotted argument names from nested vars', () => {
    const i18n = createI18n();
    expect(i18n.t('x', { user: { name: 'Asha' } }, { default: 'Hi {user.name}' })).toBe('Hi Asha');
    expect(i18n.t('x', { 'user.name': 'Flat' }, { default: 'Hi {user.name}' })).toBe('Hi Flat');
  });

  it('stringifies other values and tolerates non-object vars / opts', () => {
    const i18n = createI18n();
    expect(i18n.t('x', { v: true }, { default: '{v}' })).toBe('true');
    expect(i18n.t('ui.continue', null, null)).toBe('Continue');
    expect(i18n.t('ui.continue', 'nope', 5)).toBe('Continue');
  });

  it.each([[''], [42], [null], [undefined], ['   ']])('rejects key %j', (key) => {
    const i18n = createI18n();
    expect(() => i18n.t(key)).toThrow(ValidationError);
    expect(() => i18n.hasKey(key)).toThrow(ValidationError);
  });
});

describe('t() plural / select', () => {
  it('selects =N exact matches before Intl.PluralRules categories', () => {
    const i18n = createI18n();
    expect(i18n.t('common.stops.count', { count: 0 })).toBe('Non-stop');
    expect(i18n.t('common.stops.count', { count: 1 })).toBe('1 stop');
    expect(i18n.t('common.stops.count', { count: 2 })).toBe('2 stops');
    expect(i18n.t('common.stops.count', { count: 1000 })).toBe('1,000 stops');
  });

  it('accepts count through the options bag (vars win when both are given)', () => {
    const i18n = createI18n();
    expect(i18n.t('ui.results', undefined, { count: 1 })).toBe('1 flight found');
    expect(i18n.t('ui.results', { count: 3 }, { count: 1 })).toBe('3 flights found');
    expect(i18n.t('ui.results', {}, { count: 0 })).toBe('No flights found');
  });

  it('supports #, offset, nested placeholders, select and selectordinal', () => {
    const i18n = createI18n();
    i18n.addMessages('en', {
      test: {
        party:
          '{who} and {n, plural, offset:1 =0{nobody} =1{just you} one{# other} other{# others}}',
        gender: '{g, select, m{He} f{She} other{They}} checked in',
        ord: '{n, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}',
        nested:
          '{n, plural, one{{g, select, m{his # bag} other{their # bag}}} other{{g, select, m{his # bags} other{their # bags}}}}',
        spaced: '{ n , plural , one { one } other { many } }',
      },
    });
    expect(i18n.t('test.party', { who: 'Asha', n: 0 })).toBe('Asha and nobody');
    expect(i18n.t('test.party', { who: 'Asha', n: 1 })).toBe('Asha and just you');
    expect(i18n.t('test.party', { who: 'Asha', n: 2 })).toBe('Asha and 1 other');
    expect(i18n.t('test.party', { who: 'Asha', n: 5 })).toBe('Asha and 4 others');
    expect(i18n.t('test.gender', { g: 'f' })).toBe('She checked in');
    expect(i18n.t('test.gender', { g: 'x' })).toBe('They checked in');
    expect(i18n.t('test.gender')).toBe('They checked in');
    expect(i18n.t('test.ord', { n: 1 })).toBe('1st');
    expect(i18n.t('test.ord', { n: 2 })).toBe('2nd');
    expect(i18n.t('test.ord', { n: 3 })).toBe('3rd');
    expect(i18n.t('test.ord', { n: 11 })).toBe('11th');
    expect(i18n.t('test.nested', { n: 1, g: 'm' })).toBe('his 1 bag');
    expect(i18n.t('test.nested', { n: 2, g: 'f' })).toBe('their 2 bags');
    expect(i18n.t('test.spaced', { n: 1 })).toBe(' one ');
    expect(i18n.t('test.spaced', { n: 4 })).toBe(' many ');
  });

  it('keeps the placeholder when the plural argument is missing or not numeric', () => {
    const i18n = createI18n();
    expect(i18n.t('common.stops.count')).toBe('{count}');
    expect(i18n.t('common.stops.count', { count: 'many' })).toBe('{count}');
    expect(i18n.t('x', { s: 'zz' }, { default: '{s, select, a{A}}' })).toBe('zz');
    expect(i18n.t('x', {}, { default: '{s, select, a{A}}' })).toBe('{s}');
  });

  it('uses the plural rules of the locale the message came from, numbers of the active one', () => {
    const i18n = createI18n({ locale: 'de' });
    expect(i18n.t('ui.results', { count: 1234 })).toBe('1.234 flights found');
    i18n.addMessages('ru', {
      files: '{count, plural, one{# файл} few{# файла} many{# файлов} other{# файла}}',
    });
    i18n.setLocale('ru');
    expect(i18n.t('files', { count: 1 })).toBe('1 файл');
    expect(i18n.t('files', { count: 3 })).toBe('3 файла');
    expect(i18n.t('files', { count: 5 })).toBe('5 файлов');
  });

  it('honours a custom pluralRules function or select() object', () => {
    const fn = vi.fn(() => 'other');
    const a = createI18n({ pluralRules: fn });
    expect(a.t('ui.results', { count: 1 })).toBe('1 flights found');
    expect(fn).toHaveBeenCalledWith(1, 'en', 'cardinal');
    const b = createI18n({ pluralRules: { select: () => 'one' } });
    expect(b.t('ui.results', { count: 7 })).toBe('7 flight found');
  });

  it('falls back to one/other when Intl.PluralRules is unavailable', () => {
    vi.stubGlobal('Intl', intlWithout('PluralRules'));
    const i18n = createI18n();
    expect(i18n.t('ui.results', { count: 1 })).toBe('1 flight found');
    expect(i18n.t('ui.results', { count: 2 })).toBe('2 flights found');
  });
});

describe('t() syntax edge cases', () => {
  it('applies ICU apostrophe quoting without breaking ordinary English apostrophes', () => {
    const i18n = createI18n();
    const d = (s, vars) => i18n.t('x', vars, { default: s });
    expect(d("don't {do} that", { do: 'DO' })).toBe("don't DO that");
    expect(d("literal '{name}' here", { name: 'x' })).toBe('literal {name} here');
    expect(d("it''s '{' and '}'")).toBe("it's { and }");
    expect(d("{n, plural, other{'#' is #}}", { n: 3 })).toBe('# is 3');
    expect(d("quoted ''{a}''", { a: 1 })).toBe("quoted '1'");
    expect(d("unterminated '{quote", {})).toBe('unterminated {quote');
  });

  it('renders malformed arguments literally instead of throwing', () => {
    const i18n = createI18n();
    const d = (s, vars) => i18n.t('x', vars, { default: s });
    expect(d('{bad, thing}')).toBe('{bad, thing}');
    expect(d('{}')).toBe('{}');
    expect(d('{n, plural}', { n: 1 })).toBe('{n, plural}');
    expect(d('{n, plural, one}', { n: 1 })).toBe('{n, plural, one}');
    expect(d('{n, plural, one{x}', { n: 1 })).toBe('{n, plural, one{x}');
    expect(d('{n, plural, offset:x one{x} other{y}}', { n: 1 })).toContain('offset:x');
    expect(d('a } b { c')).toBe('a } b { c');
    expect(d('# alone')).toBe('# alone');
    expect(d('{n number}', { n: 1 })).toBe('{n number}');
    expect(d('{n, number, }', { n: 1 })).toBe('1');
  });

  it('treats a numeric leaf as a message and other non-string leaves as missing', () => {
    const i18n = createI18n();
    i18n.addMessages('en', { test: { n: 42, arr: ['a'], obj: { x: 'y' } } });
    expect(i18n.t('test.n')).toBe('42');
    expect(i18n.t('test.arr')).toBe('test.arr');
    expect(i18n.t('test.obj')).toBe('test.obj');
    expect(i18n.t('test.obj.x')).toBe('y');
    expect(i18n.missing()).toEqual(['test.arr', 'test.obj']);
  });
});

describe('key resolution and fallback chain', () => {
  it('resolves nested, flat and mixed dotted keys', () => {
    const i18n = createI18n({
      messages: {
        en: {
          a: { b: { c: 'nested' } },
          'x.y.z': 'flat',
          m: { 'n.o': { p: 'mixed' } },
          'q.r': { s: 'mixed2' },
        },
      },
    });
    expect(i18n.t('a.b.c')).toBe('nested');
    expect(i18n.t('x.y.z')).toBe('flat');
    expect(i18n.t('m.n.o.p')).toBe('mixed');
    expect(i18n.t('q.r.s')).toBe('mixed2');
    expect(i18n.hasKey('a.b')).toBe(false);
    expect(i18n.hasKey('a.b.c.d')).toBe(false);
    expect(i18n.hasKey('__proto__.toString')).toBe(false);
    expect(i18n.t('constructor')).toBe('constructor');
  });

  it('walks en-IN → en → fallback, then the fallback chain', () => {
    const i18n = createI18n({
      locale: 'en-IN',
      fallback: 'fr',
      messages: {
        'en-IN': { k: { regional: 'IN' } },
        en: { k: { regional: 'EN', language: 'EN' } },
        fr: { k: { regional: 'FR', language: 'FR', fallbackOnly: 'FR' } },
      },
    });
    expect(i18n.t('k.regional')).toBe('IN');
    expect(i18n.t('k.language')).toBe('EN');
    expect(i18n.t('k.fallbackOnly')).toBe('FR');
    expect(i18n.t('ui.continue')).toBe('Continue');
    i18n.setLocale('zh-Hant-TW');
    expect(i18n.t('k.fallbackOnly')).toBe('FR');
    i18n.addMessages('zh-Hant', { k: { regional: 'ZH-HANT' } });
    i18n.addMessages('zh', { k: { regional: 'ZH', language: 'ZH' } });
    expect(i18n.t('k.regional')).toBe('ZH-HANT');
    expect(i18n.t('k.language')).toBe('ZH');
  });

  it('accepts an array of fallbacks in order', () => {
    const i18n = createI18n({
      locale: 'de',
      fallback: ['fr', 'en'],
      messages: { fr: { only: { fr: 'FR' } } },
    });
    expect(i18n.t('only.fr')).toBe('FR');
    expect(i18n.t('ui.continue')).toBe('Continue');
  });

  it('hasKey reports the current or an explicit locale', () => {
    const i18n = createI18n({ messages: { fr: { only: 'FR' } } });
    expect(i18n.hasKey('ui.continue')).toBe(true);
    expect(i18n.hasKey('only')).toBe(false);
    expect(i18n.hasKey('only', 'fr-CA')).toBe(true);
    expect(i18n.hasKey('ui.continue', 'fr')).toBe(true);
    expect(i18n.hasKey('nope', 'fr')).toBe(false);
  });
});

describe('missing keys', () => {
  it('returns the key, records it once and lists it through missing()', () => {
    const i18n = createI18n();
    expect(i18n.t('does.not.exist')).toBe('does.not.exist');
    expect(i18n.t('does.not.exist')).toBe('does.not.exist');
    expect(i18n.t('another')).toBe('another');
    expect(i18n.missing()).toEqual(['does.not.exist', 'another']);
    const list = i18n.missing();
    list.push('mutated');
    expect(i18n.missing()).toEqual(['does.not.exist', 'another']);
  });

  it('renders the default option (with vars) when given', () => {
    const i18n = createI18n();
    expect(i18n.t('nope', { n: 2 }, { default: '{n, plural, one{# item} other{# items}}' })).toBe(
      '2 items'
    );
    expect(i18n.missing()).toEqual(['nope']);
  });

  it('consults a custom missing handler when there is no default', () => {
    const missing = vi.fn((key) => `[${key}]`);
    const i18n = createI18n({ locale: 'fr', missing });
    expect(i18n.t('nope', { a: 1 })).toBe('[nope]');
    expect(missing).toHaveBeenCalledWith('nope', 'fr', { a: 1 });
    expect(i18n.t('nope2', {}, { default: 'dflt' })).toBe('dflt');
    expect(missing).toHaveBeenCalledTimes(1);
    missing.mockReturnValueOnce(undefined);
    expect(i18n.t('nope3')).toBe('nope3');
    expect(i18n.missing()).toEqual(['nope', 'nope2', 'nope3']);
  });

  it('does not record keys that resolve', () => {
    const i18n = createI18n();
    i18n.t('ui.continue');
    i18n.t('ui.step', { current: 1, total: 2 });
    expect(i18n.missing()).toEqual([]);
  });
});

describe('addMessages', () => {
  it('deep-merges by default and replaces with merge: false, invalidating lookups', () => {
    const i18n = createI18n();
    expect(i18n.t('ui.continue')).toBe('Continue');
    i18n.addMessages('en', { ui: { continue: 'Go on' } });
    expect(i18n.t('ui.continue')).toBe('Go on');
    expect(i18n.t('ui.back')).toBe('Back');
    i18n.addMessages('en', { ui: { continue: 'Only' } }, { merge: false });
    expect(i18n.t('ui.continue')).toBe('Only');
    expect(i18n.t('ui.back')).toBe('ui.back');
  });

  it('copies the given bundle so later host mutation has no effect', () => {
    const i18n = createI18n();
    const bundle = { greet: { hi: 'Hi' } };
    i18n.addMessages('fr', bundle);
    bundle.greet.hi = 'Changed';
    i18n.setLocale('fr');
    expect(i18n.t('greet.hi')).toBe('Hi');
  });

  it('normalises the locale tag and notifies listeners', () => {
    const i18n = createI18n();
    const fn = vi.fn();
    i18n.onChange(fn);
    i18n.addMessages('fr_ca', { x: 'y' });
    expect(i18n.locales()).toEqual(['en', 'fr-CA']);
    expect(fn).toHaveBeenCalledWith({ type: 'messages', locale: 'fr-CA', dir: 'ltr' });
  });

  it('ignores prototype-polluting keys', () => {
    const i18n = createI18n();
    i18n.addMessages('en', JSON.parse('{"__proto__": {"polluted": "yes"}, "ok": "fine"}'));
    expect({}.polluted).toBeUndefined();
    expect(i18n.t('ok')).toBe('fine');
  });

  it.each([
    ['', {}],
    [42, {}],
    ['en', null],
    ['en', 'str'],
    ['en', ['a']],
  ])('rejects locale %j / messages %j', (locale, messages) => {
    const i18n = createI18n();
    expect(() => i18n.addMessages(locale, messages)).toThrow(ValidationError);
  });
});

describe('loadMessages', () => {
  it('calls the loader with the canonical locale, adds the bundle and notifies', async () => {
    const i18n = createI18n();
    const fn = vi.fn();
    i18n.onChange(fn);
    const loader = vi.fn(async () => ({ ui: { continue: 'Continuer' } }));
    await expect(i18n.loadMessages('fr_FR', loader)).resolves.toBeUndefined();
    expect(loader).toHaveBeenCalledWith('fr-FR');
    i18n.setLocale('fr-FR');
    expect(i18n.t('ui.continue')).toBe('Continuer');
    expect(fn).toHaveBeenCalledWith({ type: 'messages', locale: 'fr-FR', dir: 'ltr' });
  });

  it('accepts { default }, module namespaces named after the locale and single-export modules', async () => {
    const i18n = createI18n({ locale: 'fr' });
    await i18n.loadMessages('fr', async () => ({ default: { a: 'A' } }));
    await i18n.loadMessages('fr-CA', async () =>
      Object.freeze(
        Object.create(null, {
          [Symbol.toStringTag]: { value: 'Module' },
          fr_CA: { value: { b: 'B' }, enumerable: true },
        })
      )
    );
    await i18n.loadMessages('fr-BE', async () =>
      Object.create(null, {
        [Symbol.toStringTag]: { value: 'Module' },
        messages: { value: { c: 'C' }, enumerable: true },
        version: { value: '1', enumerable: true },
      })
    );
    expect(i18n.t('a')).toBe('A');
    i18n.setLocale('fr-CA');
    expect(i18n.t('b')).toBe('B');
    i18n.setLocale('fr-BE');
    expect(i18n.t('c')).toBe('C');
  });

  it('shares one in-flight load per locale and loader, but reloads with a new loader', async () => {
    const i18n = createI18n();
    let resolve;
    const loader = vi.fn(() => new Promise((r) => (resolve = r)));
    const p1 = i18n.loadMessages('fr', loader);
    const p2 = i18n.loadMessages('fr', loader);
    expect(p1).toBe(p2);
    expect(loader).toHaveBeenCalledTimes(1);
    resolve({ x: '1' });
    await p1;
    expect(i18n.loadMessages('fr', loader)).toBe(p1);
    const other = vi.fn(async () => ({ y: '2' }));
    await i18n.loadMessages('fr', other);
    expect(other).toHaveBeenCalledTimes(1);
    expect(i18n.hasKey('x', 'fr')).toBe(true);
    expect(i18n.hasKey('y', 'fr')).toBe(true);
  });

  it('wraps loader failures as an SdkError and allows a retry', async () => {
    const i18n = createI18n();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: 'yes' });
    let caught;
    try {
      await i18n.loadMessages('fr', loader);
    } catch (e) {
      caught = e;
    }
    expect(isSdkError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(SdkError);
    expect(caught.code).toBe('I18N_LOAD_FAILED');
    expect(caught.cause).toBeInstanceOf(Error);
    await i18n.loadMessages('fr', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(i18n.hasKey('ok', 'fr')).toBe(true);
  });

  it('rejects when the loader returns something that is not a bundle, or throws synchronously', async () => {
    const i18n = createI18n();
    await expect(i18n.loadMessages('fr', async () => 'nope')).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(i18n.loadMessages('fr', async () => null)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      i18n.loadMessages('fr', () => {
        throw new Error('sync');
      })
    ).rejects.toMatchObject({ code: 'I18N_LOAD_FAILED' });
    expect(() => i18n.loadMessages('fr', 'not a function')).toThrow(ValidationError);
    expect(() => i18n.loadMessages('', async () => ({}))).toThrow(ValidationError);
  });
});

describe('setLocale / getLocale / onChange', () => {
  it('switches locale, canonicalises it and notifies with previous and dir', () => {
    const i18n = createI18n();
    const fn = vi.fn();
    const off = i18n.onChange(fn);
    i18n.setLocale('ar_eg');
    expect(i18n.getLocale()).toBe('ar-EG');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({
      type: 'locale',
      locale: 'ar-EG',
      previous: 'en',
      dir: 'rtl',
    });
    i18n.setLocale('ar-EG');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    i18n.setLocale('en');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates listener failures and keeps notifying the others', () => {
    const i18n = createI18n();
    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    const good = vi.fn();
    i18n.onChange(bad);
    i18n.onChange(good);
    expect(() => i18n.setLocale('fr')).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid locales and listeners', () => {
    const i18n = createI18n();
    expect(() => i18n.setLocale('')).toThrow(ValidationError);
    expect(() => i18n.setLocale(null)).toThrow(ValidationError);
    expect(() => i18n.onChange('x')).toThrow(ValidationError);
    expect(() => i18n.dir(5)).toThrow(ValidationError);
    expect(i18n.getLocale()).toBe('en');
  });

  it('re-resolves messages after a locale change', () => {
    const i18n = createI18n({ messages: { fr: { ui: { continue: 'Continuer' } } } });
    expect(i18n.t('ui.continue')).toBe('Continue');
    i18n.setLocale('fr');
    expect(i18n.t('ui.continue')).toBe('Continuer');
    i18n.setLocale('en-GB');
    expect(i18n.t('ui.continue')).toBe('Continue');
  });
});

describe('dir()', () => {
  it.each([
    ['en', 'ltr'],
    ['en-IN', 'ltr'],
    ['hi', 'ltr'],
    ['ar', 'rtl'],
    ['ar-AE', 'rtl'],
    ['he', 'rtl'],
    ['iw', 'rtl'],
    ['fa-IR', 'rtl'],
    ['ur', 'rtl'],
    ['ur-Latn', 'ltr'],
    ['pa-Arab', 'rtl'],
    ['zh-Hant-TW', 'ltr'],
  ])('%s → %s', (locale, expected) => {
    const i18n = createI18n({ locale });
    expect(i18n.dir()).toBe(expected);
    expect(createI18n().dir(locale)).toBe(expected);
  });
});

describe('formatting helpers', () => {
  it('formatList uses Intl.ListFormat for the active locale', () => {
    const i18n = createI18n();
    expect(i18n.formatList([])).toBe('');
    expect(i18n.formatList(['Delhi'])).toBe('Delhi');
    expect(i18n.formatList(['Delhi', 'Mumbai'])).toBe('Delhi and Mumbai');
    expect(i18n.formatList(['Delhi', 'Mumbai', 'Goa'])).toBe('Delhi, Mumbai, and Goa');
    expect(i18n.formatList(['Delhi', 'Mumbai'], { type: 'disjunction' })).toBe('Delhi or Mumbai');
    expect(i18n.formatList([1, 2], { type: 'unit', style: 'short' })).toMatch(/1.*2/);
    i18n.setLocale('de');
    expect(i18n.formatList(['A', 'B', 'C'])).toBe('A, B und C');
    expect(() => i18n.formatList('not a list')).toThrow(ValidationError);
  });

  it('formatList degrades to a plain join without Intl.ListFormat', () => {
    vi.stubGlobal('Intl', intlWithout('ListFormat'));
    const i18n = createI18n();
    expect(i18n.formatList([])).toBe('');
    expect(i18n.formatList(['a'])).toBe('a');
    expect(i18n.formatList(['a', 'b'])).toBe('a and b');
    expect(i18n.formatList(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(i18n.formatList(['a', 'b', 'c'], { type: 'disjunction' })).toBe('a, b, or c');
    expect(i18n.formatList(['a', 'b', 'c'], { type: 'unit' })).toBe('a, b, c');
  });

  it('formatNumber / formatPercent follow the active locale and accept Intl options', () => {
    const i18n = createI18n({ locale: 'en-IN' });
    expect(i18n.formatNumber(1234567.891)).toBe('12,34,567.891');
    expect(i18n.formatNumber('42')).toBe('42');
    expect(i18n.formatNumber(10n)).toBe('10');
    expect(i18n.formatNumber(0.5, { style: 'percent' })).toBe('50%');
    expect(i18n.formatPercent(0.156)).toBe('16%');
    expect(i18n.formatPercent(0.156, { maximumFractionDigits: 1 })).toBe('15.6%');
    i18n.setLocale('de-DE');
    expect(i18n.formatNumber(1234.5)).toBe('1.234,5');
    expect(i18n.formatPercent(0.5)).toMatch(/^50\s%$/);
  });

  it('formatNumber rejects non-numeric input and invalid Intl options', () => {
    const i18n = createI18n();
    for (const bad of [NaN, Infinity, 'abc', '', null, undefined, {}]) {
      expect(() => i18n.formatNumber(bad)).toThrow(ValidationError);
    }
    expect(() => i18n.formatNumber(1, { style: 'bogus' })).toThrow(ValidationError);
  });

  it('falls back to the fallback locale when Intl rejects the active tag', () => {
    const i18n = createI18n({ locale: 'en' });
    i18n.setLocale('not-a-real-tag-!!');
    expect(i18n.formatNumber(1234.5)).toBe('1,234.5');
    expect(i18n.t('ui.results', { count: 2 })).toBe('2 flights found');
    expect(i18n.formatList(['a', 'b'])).toBe('a and b');
  });

  it('formats without Intl.NumberFormat / Intl.DateTimeFormat', () => {
    vi.stubGlobal('Intl', intlWithout('NumberFormat', 'DateTimeFormat'));
    const i18n = createI18n();
    expect(i18n.formatNumber(1234.5)).toBe('1234.5');
    expect(i18n.t('ui.results', { count: 1234 })).toBe('1234 flights found');
    const d = new Date(Date.UTC(2026, 10, 2, 12, 0, 0));
    expect(i18n.t('x', { d }, { default: '{d, date}' })).toBe(d.toISOString());
  });
});

describe('errors integration (toUserMessage)', () => {
  it('provides en copy for every key toUserMessage asks for', () => {
    const i18n = createI18n();
    const asked = new Set();
    const t = (key, vars, opts) => {
      asked.add(key);
      return i18n.t(key, vars, opts);
    };
    for (const err of everyUserMessageError()) {
      const out = toUserMessage(err, t);
      expect(out.title).toBeTruthy();
      expect(out.message).toBeTruthy();
    }
    expect(asked.size).toBeGreaterThan(80);
    for (const key of asked) expect(i18n.hasKey(key), key).toBe(true);
    expect(i18n.missing()).toEqual([]);
  });

  it('interpolates the vars toUserMessage passes', () => {
    const i18n = createI18n();
    expect(toUserMessage(new RateLimitError('x', { retryAfterMs: 1000 }), i18n.t).message).toBe(
      'Please wait 1 second and try again.'
    );
    expect(toUserMessage(new RateLimitError('x', { retryAfterMs: 4200 }), i18n.t).message).toBe(
      'Please wait 5 seconds and try again.'
    );
    const priced = new PriceChangedError('x', {
      from: { amount: '100', currency: 'INR' },
      to: { amount: '120', currency: 'INR' },
    });
    expect(toUserMessage(priced, i18n.t).message).toContain('from INR 100 to INR 120');
  });

  it('lets a host locale override the error copy', () => {
    const i18n = createI18n({
      locale: 'fr',
      messages: { fr: { errors: { offer_expired: { title: 'Tarif expiré' } } } },
    });
    const out = toUserMessage(new OfferExpiredError('server text'), i18n.t);
    expect(out.title).toBe('Tarif expiré');
    expect(out.message).toBe(en.errors.offer_expired.message);
    expect(out.message).not.toContain('server text');
  });
});

describe('en bundle completeness', () => {
  const i18n = createI18n();
  const codesOfClasses = [
    new SdkError('x'),
    new ConfigError('x'),
    new ValidationError('x'),
    new NetworkError('x'),
    new TimeoutError('x'),
    new AbortError('x'),
    new StorageError('x'),
    new UnsupportedError('x'),
    new ApiError('x'),
    new AuthError('x'),
    new RateLimitError('x'),
    new NotFoundError('x'),
    new ConflictError('x'),
    new SearchExpiredError('x'),
    new OfferExpiredError('x'),
    new OfferUnavailableError('x'),
    new PriceChangedError('x'),
    new ItineraryExpiredError('x'),
    new BookingError('x'),
    new PaymentError('x'),
    new ServicingError('x'),
    new UnprocessableError('x'),
  ].map((e) => e.code);

  it('has errors.<CODE>.title and .message for every ERROR_CODES entry and class default', () => {
    const codes = new Set([...Object.keys(ERROR_CODES), ...codesOfClasses]);
    expect(codes.size).toBeGreaterThan(60);
    for (const code of codes) {
      expect(i18n.hasKey(`errors.${code}.title`), code).toBe(true);
      expect(i18n.hasKey(`errors.${code}.message`), code).toBe(true);
      expect(i18n.t(`errors.${code}.title`)).not.toBe(`errors.${code}.title`);
    }
  });

  it.each([
    ['common.cabins', ['economy', 'premium_economy', 'business', 'first']],
    ['common.paxTypes', ['ADT', 'CHD', 'INF', 'INS', 'YTH', 'SRC', 'STU']],
    ['common.paxCount', ['ADT', 'CHD', 'INF', 'INS', 'YTH', 'SRC', 'STU']],
    [
      'common.fareTypes',
      ['regular', 'student', 'senior', 'armed_forces', 'doctor', 'corporate', 'youth'],
    ],
    ['common.timeBuckets', ['early_morning', 'morning', 'afternoon', 'evening', 'night']],
    ['common.sortKeys', ['best', 'price', 'duration', 'departure', 'arrival', 'emissions']],
    [
      'common.bookingStatuses',
      [
        'draft',
        'pending_payment',
        'on_hold',
        'processing',
        'confirmed',
        'ticketed',
        'partially_ticketed',
        'failed',
        'cancelled',
        'refunded',
        'expired',
      ],
    ],
    [
      'common.paymentStatuses',
      [
        'requires_method',
        'requires_confirmation',
        'requires_action',
        'processing',
        'succeeded',
        'failed',
        'cancelled',
      ],
    ],
    ['common.tripPhases', ['upcoming', 'past', 'cancelled']],
    ['common.tripTypes', ['one_way', 'round_trip', 'multi_city']],
    ['common.resultModes', ['per_slice', 'combined']],
    [
      'common.searchStatuses',
      ['pending', 'streaming', 'complete', 'expired', 'error', 'cancelled'],
    ],
    [
      'common.paymentMethods',
      [
        'card',
        'upi',
        'netbanking',
        'wallet',
        'apple_pay',
        'google_pay',
        'paypal',
        'bnpl',
        'emi',
        'bank_transfer',
        'pay_later',
        'loyalty_points',
        'gift_card',
        'ota_wallet',
        'voucher',
      ],
    ],
    [
      'common.tripActions',
      [
        'change',
        'cancel',
        'cancel_partial',
        'add_seats',
        'add_bags',
        'add_meals',
        'check_in',
        'name_correction',
        'special_assistance',
        'update_contact',
        'update_documents',
        'split_pnr',
        'download_eticket',
        'invoice',
        'gst_invoice',
        'resend',
        'pay_now',
        'void',
        'rebook',
        'support',
      ],
    ],
    [
      'ui',
      [
        'continue',
        'back',
        'retry',
        'apply',
        'reset',
        'close',
        'loading',
        'selectFlight',
        'pricePerPax',
        'total',
      ],
    ],
  ])('%s labels every value', (ns, values) => {
    for (const v of values) {
      const key = `${ns}.${v}`;
      expect(i18n.hasKey(key), key).toBe(true);
      expect(i18n.t(key, { count: 2 })).not.toBe(key);
    }
  });

  it('stops / passenger counts pluralise', () => {
    expect(i18n.t('common.paxCount.ADT', { count: 1 })).toBe('1 adult');
    expect(i18n.t('common.paxCount.CHD', { count: 2 })).toBe('2 children');
    expect(i18n.t('common.passengers', { count: 3 })).toBe('3 passengers');
    expect(i18n.t('common.seatsLeft', { count: 1 })).toBe('Only 1 seat left');
    expect(i18n.t('common.dayChange', { count: 0 })).toBe('');
    expect(i18n.t('common.dayChange', { count: 1 })).toBe('+1 day');
    expect(i18n.t('common.stops.upTo', { count: 1 })).toBe('Up to 1 stop');
  });

  it('every leaf renders without leaving ICU syntax behind', () => {
    const leaves = [];
    const walk = (node, prefix) => {
      for (const [k, v] of Object.entries(node)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') leaves.push(key);
        else walk(v, key);
      }
    };
    walk(en, '');
    expect(leaves.length).toBeGreaterThan(400);
    const vars = {
      count: 2,
      seconds: 2,
      from: 'A',
      to: 'B',
      min: 2,
      max: 2,
      months: 2,
      current: 1,
      total: 2,
      time: 't',
      duration: 'd',
      airport: 'DEL',
      airline: 'AI',
      index: 1,
      days: 3,
      key: 'k',
      kg: 23,
    };
    for (const key of leaves) {
      const out = i18n.t(key, vars);
      expect(out, key).not.toMatch(/[{}#]/);
    }
    expect(i18n.missing()).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('starts no timers and destroy() drops listeners, loads and the missing list', async () => {
    vi.useFakeTimers();
    const i18n = createI18n({ locale: 'en-IN' });
    const fn = vi.fn();
    i18n.onChange(fn);
    i18n.t('gone');
    i18n.setLocale('fr');
    i18n.formatNumber(1);
    i18n.formatList(['a', 'b']);
    const loader = vi.fn(async () => ({ z: 'Z' }));
    await i18n.loadMessages('de', loader);
    expect(vi.getTimerCount()).toBe(0);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(i18n.missing()).toEqual(['gone']);

    i18n.destroy();
    expect(i18n.missing()).toEqual([]);
    i18n.setLocale('en');
    i18n.addMessages('en', { late: 'L' });
    expect(fn).toHaveBeenCalledTimes(2);
    await i18n.loadMessages('de', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(i18n.t('late')).toBe('L');
    expect(i18n.t('ui.continue')).toBe('Continue');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is SSR-safe: works with no window / document and reads Intl lazily', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const i18n = createI18n({ locale: 'ar' });
    expect(i18n.dir()).toBe('rtl');
    expect(i18n.t('ui.close')).toBe('Close');
  });
});
