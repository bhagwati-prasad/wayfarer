/**
 * Money helpers for the Wayfarer SDK (docs/api/03-utils.md §1): construction and normalisation of
 * `Money` (`{ amount: decimal string, currency: ISO‑4217 }`), lenient parsing, `Intl`‑based formatting
 * with a hand‑rolled fallback, exact arithmetic on BigInt minor units, comparison, loss‑free allocation
 * (largest remainder), display‑only FX conversion, a per‑currency decimals / symbol / name table and
 * the per‑passenger price. Amounts are never held as floats: every input is parsed to decimal digits
 * and scaled to the currency's minor unit; excess precision is rounded half away from zero. Everything
 * is pure and SSR‑safe — `Intl` is looked up on `globalThis` at call time, nothing touches the DOM,
 * storage, timers, the network or logs, and the only module‑level state is a bounded memo of
 * `Intl.NumberFormat` instances. Plain `Error`s are never thrown: every bad input raises
 * `ValidationError` with `issues[]`.
 */

import { ValidationError } from '../errors/index.js';

/** @typedef {import('../types.js').Money} Money */
/** @typedef {import('../types.js').Currency} Currency */
/** @typedef {import('../types.js').PaxCounts} PaxCounts */
/** @typedef {import('../types.js').ValidationIssue} ValidationIssue */

/** Sign plus digit strings — the only intermediate representation of an amount. @typedef {{ neg: boolean, int: string, frac: string }} Decimal */
/** A `Money` scaled to its minor unit. @typedef {{ minor: bigint, currency: string, decimals: number }} Normalized */

/**
 * @typedef {Object} ParseMoneyOptions
 * @property {string} [currency]  Currency to assume when the input carries no ISO code — required for
 *   symbol‑only strings such as `"₹1,234.50"` and for bare numbers; must match the input's code when both
 *   are present.
 * @property {boolean} [minor]  Interpret the numeric value as an integer count of minor units (paise,
 *   cents, fils) instead of major units.
 */

/**
 * @typedef {Object} FormatMoneyOptions
 * @property {string|string[]} [locale]  BCP 47 locale(s); defaults to the runtime locale.
 * @property {'symbol'|'code'|'narrow'} [display='symbol']  `₹1,234.50` · `INR 1,234.50` · narrow
 *   symbol (`$` instead of `CA$`).
 * @property {'auto'|number} [fraction='auto']  Fraction digits: `'auto'` = the currency's decimals (JPY 0,
 *   INR 2, BHD 3); a number (0–20) forces exactly that many, rounding half away from zero.
 * @property {'auto'|'never'|'always'|'exceptZero'|'negative'} [signDisplay]  As `Intl.NumberFormat`.
 */

/**
 * @typedef {Object} ConvertOptions
 * @property {'auto'|number} [round='auto']  `'auto'` rounds to the target currency's decimals; a
 *   non‑negative integer rounds to that many decimal places instead (clamped to the currency's decimals),
 *   e.g. `0` for a whole‑unit display.
 */

/**
 * @typedef {Object} PricePerPaxOptions
 * @property {boolean} [includeInfants=false]  Count lap infants (`infants`) as paying passengers.
 */

// ── currency tables ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_DECIMALS = 2;

/** ISO‑4217 minor‑unit exponents that differ from the default 2. */
const DECIMALS = Object.freeze({
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
});

/** Display symbols used by the `Intl`‑less fallback and preferred by `currencyInfo` (deterministic). */
const SYMBOLS = Object.freeze({
  AED: 'AED',
  AUD: 'A$',
  BDT: '৳',
  BHD: 'BHD',
  BRL: 'R$',
  CAD: 'CA$',
  CHF: 'CHF',
  CNY: 'CN¥',
  CZK: 'Kč',
  DKK: 'kr',
  EGP: 'E£',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  HUF: 'Ft',
  IDR: 'Rp',
  ILS: '₪',
  INR: '₹',
  JPY: '¥',
  KES: 'KSh',
  KRW: '₩',
  KWD: 'KWD',
  LKR: 'Rs',
  MXN: 'MX$',
  MYR: 'RM',
  NGN: '₦',
  NOK: 'kr',
  NPR: 'Rs',
  NZD: 'NZ$',
  OMR: 'OMR',
  PHP: '₱',
  PKR: 'Rs',
  PLN: 'zł',
  QAR: 'QAR',
  RUB: '₽',
  SAR: 'SAR',
  SEK: 'kr',
  SGD: 'S$',
  THB: '฿',
  TRY: '₺',
  TWD: 'NT$',
  UAH: '₴',
  USD: '$',
  VND: '₫',
  ZAR: 'R',
});

/** English names for the same set, used when `Intl.DisplayNames` is unavailable. */
const NAMES = Object.freeze({
  AED: 'United Arab Emirates Dirham',
  AUD: 'Australian Dollar',
  BDT: 'Bangladeshi Taka',
  BHD: 'Bahraini Dinar',
  BRL: 'Brazilian Real',
  CAD: 'Canadian Dollar',
  CHF: 'Swiss Franc',
  CNY: 'Chinese Yuan',
  CZK: 'Czech Koruna',
  DKK: 'Danish Krone',
  EGP: 'Egyptian Pound',
  EUR: 'Euro',
  GBP: 'British Pound',
  HKD: 'Hong Kong Dollar',
  HUF: 'Hungarian Forint',
  IDR: 'Indonesian Rupiah',
  ILS: 'Israeli New Shekel',
  INR: 'Indian Rupee',
  JPY: 'Japanese Yen',
  KES: 'Kenyan Shilling',
  KRW: 'South Korean Won',
  KWD: 'Kuwaiti Dinar',
  LKR: 'Sri Lankan Rupee',
  MXN: 'Mexican Peso',
  MYR: 'Malaysian Ringgit',
  NGN: 'Nigerian Naira',
  NOK: 'Norwegian Krone',
  NPR: 'Nepalese Rupee',
  NZD: 'New Zealand Dollar',
  OMR: 'Omani Rial',
  PHP: 'Philippine Peso',
  PKR: 'Pakistani Rupee',
  PLN: 'Polish Zloty',
  QAR: 'Qatari Riyal',
  RUB: 'Russian Ruble',
  SAR: 'Saudi Riyal',
  SEK: 'Swedish Krona',
  SGD: 'Singapore Dollar',
  THB: 'Thai Baht',
  TRY: 'Turkish Lira',
  TWD: 'New Taiwan Dollar',
  UAH: 'Ukrainian Hryvnia',
  USD: 'US Dollar',
  VND: 'Vietnamese Dong',
  ZAR: 'South African Rand',
});

const CURRENCY_RE = /^[A-Za-z]{3}$/;
/** Strict decimal: optional sign, digits, optional fraction. No exponent, no separators. */
const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;
/** `String(number)` in exponent form, e.g. `1e+21`, `-1.5e-7`. */
const EXPONENT_RE = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/;
/** ISO code at the start (`INR 1,234.50`, `INR1,234.50`) — must not be followed by another letter. */
const CODE_PREFIX_RE = /^([A-Za-z]{3})(?![A-Za-z])\s*([\s\S]*)$/;
/** ISO code at the end (`1,234.50 INR`) — must not be preceded by a letter. */
const CODE_SUFFIX_RE = /^((?:[\s\S]*[^A-Za-z])?)\s*([A-Za-z]{3})$/;
/** Anything before the first digit (or sign + digit): `₹`, `Rs. `, `R$`, … */
const LEADING_UNIT_RE = /^[^\d+-]*?(?=[+-]?(?:\d|\.\d))/;
/** Anything after the last digit or decimal point: ` ₹`, ` Rs`, … */
const TRAILING_UNIT_RE = /[^\d.]*$/;
/** Digits with group separators (`,`, space, `'`, `’`), then an optional fraction. */
const LOOSE_CORE_RE = /^(\d[\d,\s'\u2019]*)?(?:\.(\d*))?$/;
/** Group separators other than the comma, normalised to a comma before the grouping check. */
const OTHER_SEPARATOR_RE = /\s+|['\u2019]/g;
/** The Indian "no paise" marker (`500/-`): a slash‑hyphen after the number is not a minus sign. */
const NO_PAISE_RE = /\/-/g;

const DISPLAYS = Object.freeze({ symbol: 'symbol', code: 'code', narrow: 'narrowSymbol' });
const SIGN_DISPLAYS = Object.freeze(['auto', 'never', 'always', 'exceptZero', 'negative']);
const MAX_FRACTION = 20;
const FORMATTER_CACHE_SIZE = 256;

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {string} path @param {string} code @param {string} message @param {object} [params]
 * @returns {ValidationIssue}
 */
function issue(path, code, message, params) {
  return params === undefined ? { path, code, message } : { path, code, message, params };
}

/** @param {string} message @param {ValidationIssue[]} issues @returns {ValidationError} */
function invalid(message, issues) {
  return new ValidationError(message, { issues });
}

/** @param {string} path @param {string} expected @param {string} actual @returns {ValidationError} */
function mismatch(path, expected, actual) {
  return invalid(`Currency mismatch: expected ${expected}, got ${actual}`, [
    issue(`${path}.currency`, 'currency_mismatch', `expected ${expected}, got ${actual}`, {
      expected,
      actual,
    }),
  ]);
}

/**
 * Validate and canonicalise an ISO‑4217 code (upper‑case, 3 ASCII letters).
 * @param {unknown} v @param {string} path @returns {string}
 */
function normCurrency(v, path) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!CURRENCY_RE.test(s)) {
    throw invalid(`${path} must be a 3-letter ISO-4217 currency code`, [
      issue(path, 'invalid_currency', 'expected a 3-letter ISO-4217 currency code', { value: v }),
    ]);
  }
  return s.toUpperCase();
}

/** @param {string} code @returns {number} */
function decimalsFor(code) {
  return Object.prototype.hasOwnProperty.call(DECIMALS, code) ? DECIMALS[code] : DEFAULT_DECIMALS;
}

/** @param {number} n @returns {bigint} */
function pow10(n) {
  return 10n ** BigInt(n);
}

/**
 * Shortest round‑trip decimal string of a finite number, with any exponent expanded
 * (`1e21` → `1000000000000000000000`, `1.5e-7` → `0.00000015`).
 * @param {number} n @returns {string}
 */
function numberToDecimal(n) {
  const s = String(n);
  const m = EXPONENT_RE.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', exp] = m;
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Parse a strict decimal (string, finite number or bigint) into sign + digits.
 * @param {unknown} v @param {string} path @returns {Decimal}
 */
function parseDecimal(v, path) {
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw invalid(`${path} must be a finite number`, [
        issue(path, 'not_finite', 'expected a finite number', { value: String(v) }),
      ]);
    }
    s = numberToDecimal(v);
  } else if (typeof v === 'bigint') {
    s = v.toString();
  } else if (typeof v === 'string') {
    s = v.trim();
  } else if (v === undefined || v === null) {
    throw invalid(`${path} is required`, [issue(path, 'required', 'a decimal amount is required')]);
  } else {
    throw invalid(`${path} must be a decimal string or a number`, [
      issue(path, 'invalid_type', 'expected a decimal string or a number'),
    ]);
  }
  const m = DECIMAL_RE.exec(s);
  if (!m || (!m[2] && !m[3])) {
    throw invalid(`${path} is not a decimal amount`, [
      issue(path, 'invalid_format', 'expected a plain decimal such as "1234.50"', { value: s }),
    ]);
  }
  return { neg: m[1] === '-', int: m[2] || '0', frac: m[3] || '' };
}

/**
 * Scale a decimal to `decimals` places as a BigInt, rounding half away from zero.
 * @param {Decimal} d @param {number} decimals @returns {bigint}
 */
function scale(d, decimals) {
  let v = BigInt(d.int + d.frac.slice(0, decimals).padEnd(decimals, '0'));
  if (d.frac.length > decimals && d.frac.charCodeAt(decimals) >= 53 /* '5' */) v += 1n;
  return d.neg ? -v : v;
}

/**
 * Canonical amount string for a scaled value: no leading zeros, exactly `decimals` fraction digits,
 * never `-0`.
 * @param {bigint} minor @param {number} decimals @returns {string}
 */
function unscale(minor, decimals) {
  const neg = minor < 0n;
  let s = (neg ? -minor : minor).toString();
  if (decimals > 0) {
    s = s.padStart(decimals + 1, '0');
    s = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  }
  return neg ? `-${s}` : s;
}

/**
 * Nearest integer of `num / den`, ties away from zero.
 * @param {bigint} num @param {bigint} den @returns {bigint}
 */
function divRound(num, den) {
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den;
  const r = num % den;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= den) return num < 0n ? q - 1n : q + 1n;
  return q;
}

/**
 * Re‑scale minor units from `from` to `to` fraction digits, rounding half away from zero when
 * precision is dropped (the result is a bigint, so it can never be a negative zero).
 * @param {bigint} minor @param {number} from @param {number} to @returns {bigint}
 */
function rescale(minor, from, to) {
  if (to > from) return minor * pow10(to - from);
  if (to < from) return divRound(minor, pow10(from - to));
  return minor;
}

/** @param {bigint} minor @param {string} currency @param {number} decimals @returns {Money} */
function make(minor, currency, decimals) {
  return { amount: unscale(minor, decimals), currency };
}

/**
 * Validate a `Money`‑like value and scale it to its minor unit (string or number amounts, any case
 * of currency, excess precision rounded half away from zero).
 * @param {unknown} m @param {string} path @returns {Normalized}
 */
function normalize(m, path) {
  if (!isObject(m)) {
    throw invalid(`${path} must be a Money object`, [
      issue(path, 'invalid_type', 'expected { amount, currency }'),
    ]);
  }
  const currency = normCurrency(m.currency, `${path}.currency`);
  const decimals = decimalsFor(currency);
  return { minor: scale(parseDecimal(m.amount, `${path}.amount`), decimals), currency, decimals };
}

/**
 * Two operands of the same currency.
 * @param {unknown} a @param {unknown} b @returns {[Normalized, Normalized]}
 */
function pair(a, b) {
  const x = normalize(a, 'a');
  const y = normalize(b, 'b');
  if (x.currency !== y.currency) throw mismatch('b', x.currency, y.currency);
  return [x, y];
}

/**
 * Integer (bigint, safe‑integer number or integer string) as a bigint.
 * @param {unknown} v @param {string} path @returns {bigint}
 */
function toBigInt(v, path) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw invalid(`${path} must be a safe integer`, [
        issue(
          path,
          'not_integer',
          'expected an integer number of minor units (use a bigint or string beyond 2^53)',
          { value: String(v) }
        ),
      ]);
    }
    return BigInt(v);
  }
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw invalid(`${path} must be an integer`, [
    issue(path, 'not_integer', 'expected an integer number of minor units'),
  ]);
}

// ── construction / conversion ───────────────────────────────────────────────────────────────────

/**
 * Construct a `Money`, normalising the amount to the currency's decimals (`"1234.5"` → `"1234.50"`
 * for INR, `"1234.6"` → `"1235"` for JPY). Strings must be plain decimals (`"1234.50"`, `"-12"`,
 * `".5"`); numbers must be finite. Excess precision is rounded half away from zero; the currency is
 * upper‑cased.
 * @param {string|number} amount
 * @param {string} currency  ISO‑4217 code
 * @returns {Money}
 * @throws {ValidationError} when the amount is not a decimal or the currency is not a 3‑letter code
 */
export function money(amount, currency) {
  const code = normCurrency(currency, 'currency');
  const decimals = decimalsFor(code);
  return make(scale(parseDecimal(amount, 'amount'), decimals), code, decimals);
}

/**
 * Lenient parser for amounts coming from users or loosely typed payloads. Accepts
 * `"INR 1,234.50"` / `"1,234.50 INR"` (code in the string), `"₹1,234.50"` / `"Rs. 1,234"` /
 * `"(₹1,234.50)"` (symbol, sign or accounting parentheses — only with `opts.currency`),
 * `{ amount, currency }` objects (amount string, number or bigint), bare numbers / bigints with
 * `opts.currency`, and integer minor units (`123450` → `"1234.50"`) when `opts.minor` is set.
 * `.` is the decimal separator; `,`, spaces, `'` and `’` are group separators (Western and
 * Indian grouping, validated — `"1,50"` / `"12 34"` are rejected instead of being misread). A
 * trailing minus (`"500-"`) is the sign; the Indian "no paise" marker (`"500/-"`) is not. A code
 * found in the input must agree with `opts.currency`, and two different codes in one string
 * (`"USD 100 INR"`) are a `currency_mismatch`.
 * @param {string|number|bigint|{ amount: string|number|bigint, currency?: string }} input
 * @param {ParseMoneyOptions} [opts]
 * @returns {Money}
 * @throws {ValidationError} when no currency can be determined, the number is malformed, the codes
 *   disagree, or `opts.minor` is set and the value is not an integer
 */
export function parseMoney(input, opts = {}) {
  const o = isObject(opts) ? opts : {};
  if (o.minor !== undefined && typeof o.minor !== 'boolean') {
    throw invalid('opts.minor must be a boolean', [
      issue('opts.minor', 'invalid_type', 'expected a boolean', { value: o.minor }),
    ]);
  }
  const minor = o.minor === true;
  const optCurrency = o.currency == null ? undefined : normCurrency(o.currency, 'opts.currency');
  if (typeof input === 'string') return parseMoneyString(input, optCurrency, minor, 'input');
  if (typeof input === 'number' || typeof input === 'bigint') {
    return parseScalar(input, requireCurrency(optCurrency), minor, 'input');
  }
  if (isObject(input)) {
    const own = input.currency == null ? undefined : normCurrency(input.currency, 'input.currency');
    if (own && optCurrency && own !== optCurrency) throw mismatch('input', optCurrency, own);
    const currency = own || optCurrency;
    const amt = input.amount;
    if (typeof amt === 'string') return parseMoneyString(amt, currency, minor, 'input.amount');
    if (typeof amt === 'number' || typeof amt === 'bigint') {
      return parseScalar(amt, requireCurrency(currency), minor, 'input.amount');
    }
    throw invalid('input.amount must be a string, number or bigint', [
      issue('input.amount', amt == null ? 'required' : 'invalid_type', 'expected an amount'),
    ]);
  }
  throw invalid('parseMoney() expects a string, number or { amount, currency }', [
    issue('input', input == null ? 'required' : 'invalid_type', 'expected an amount'),
  ]);
}

/** @param {string|undefined} currency @returns {string} */
function requireCurrency(currency) {
  if (currency) return currency;
  throw invalid('parseMoney() could not determine the currency', [
    issue('currency', 'required', 'the input carries no ISO-4217 code; pass opts.currency'),
  ]);
}

/**
 * @param {number|bigint} v @param {string} currency @param {boolean} minor @param {string} path
 * @returns {Money}
 */
function parseScalar(v, currency, minor, path) {
  const decimals = decimalsFor(currency);
  if (minor) return make(toBigInt(v, path), currency, decimals);
  return make(scale(parseDecimal(v, path), decimals), currency, decimals);
}

/**
 * @param {string} s @param {string|undefined} currency @param {boolean} minor @param {string} path
 * @returns {Money}
 */
function parseMoneyString(s, currency, minor, path) {
  let t = s.trim();
  if (!t) throw invalid(`${path} is empty`, [issue(path, 'required', 'expected an amount')]);
  let code;
  let m = CODE_PREFIX_RE.exec(t);
  if (m) {
    code = m[1].toUpperCase();
    t = m[2];
    // a second code after the number must agree with the first (`USD 100 INR` is not an amount)
    const tail = CODE_SUFFIX_RE.exec(t);
    if (tail) {
      const suffix = tail[2].toUpperCase();
      if (suffix !== code) throw mismatch(path, code, suffix);
      t = tail[1];
    }
  } else if ((m = CODE_SUFFIX_RE.exec(t))) {
    code = m[2].toUpperCase();
    t = m[1];
  }
  if (code && currency && code !== currency) throw mismatch(path, currency, code);
  const cur = requireCurrency(currency || code);
  const d = parseLoose(t, path);
  const decimals = decimalsFor(cur);
  if (minor) {
    if (/[1-9]/.test(d.frac)) {
      throw invalid(`${path} must be an integer number of minor units`, [
        issue(path, 'not_integer', 'minor units must be an integer', { value: s }),
      ]);
    }
    const v = BigInt(d.int);
    return make(d.neg ? -v : v, cur, decimals);
  }
  return make(scale(d, decimals), cur, decimals);
}

/**
 * Numeric part of a loosely formatted string: sign, parentheses, symbols / words around the number,
 * group separators.
 * @param {string} text @param {string} path @returns {Decimal}
 */
function parseLoose(text, path) {
  const fail = (why) =>
    invalid(`${path} is not a recognisable amount`, [
      issue(path, 'invalid_format', why, { value: text }),
    ]);
  let t = text.trim();
  let neg = false;
  let signed = false;
  if (t.startsWith('(') && t.endsWith(')')) {
    neg = true;
    t = t.slice(1, -1).trim();
  }
  const takeSign = () => {
    if (t[0] === '-' || t[0] === '+') {
      if (signed) throw fail('more than one sign');
      signed = true;
      if (t[0] === '-') neg = !neg;
      t = t.slice(1).trim();
    }
  };
  takeSign();
  const lead = LEADING_UNIT_RE.exec(t);
  if (lead) t = t.slice(lead[0].length);
  takeSign();
  // Whatever trails the number is a unit (`1,234.50 ₹`) or a trailing sign (`500-`); `500/-` is the
  // Indian "no paise" marker, not a sign.
  const trail = /** @type {RegExpExecArray} */ (TRAILING_UNIT_RE.exec(t))[0];
  t = t.slice(0, t.length - trail.length);
  const trailingSigns = trail.replace(NO_PAISE_RE, '').match(/[+-]/g) || [];
  if (trailingSigns.length > 0) {
    if (signed || trailingSigns.length > 1) throw fail('more than one sign');
    signed = true;
    if (trailingSigns[0] === '-') neg = !neg;
  }
  const m = LOOSE_CORE_RE.exec(t);
  if (!m || (!m[1] && !m[2])) throw fail('expected digits with "." as the decimal separator');
  let int = '0';
  if (m[1]) {
    // every separator must leave well-formed Western (3) or Indian (2,2,...,3) groups
    const compact = m[1].replace(OTHER_SEPARATOR_RE, ',');
    if (compact.includes(',')) {
      const chunks = compact.split(',');
      const last = chunks.length - 1;
      const grouped = chunks.every((c, i) =>
        i === 0 ? c.length >= 1 && c.length <= 3 : i === last ? c.length === 3 : /^.{2,3}$/.test(c)
      );
      if (!grouped) throw fail('ambiguous digit grouping; use "." as the decimal separator');
      int = chunks.join('');
    } else {
      int = compact;
    }
  }
  return { neg, int, frac: m[2] || '' };
}

/**
 * Exact minor units (paise, cents, fils) of a `Money` as a bigint. Amounts with more precision than
 * the currency allows are rounded half away from zero, exactly as `money()` does.
 * @param {Money} m
 * @returns {bigint}
 * @throws {ValidationError} when `m` is not a valid Money
 */
export function toMinor(m) {
  return normalize(m, 'money').minor;
}

/**
 * `Money` from an integer count of minor units (`fromMinor(123450n, 'INR')` → `"1234.50"`).
 * @param {bigint|number|string} minor  bigint, safe‑integer number or integer string
 * @param {string} currency
 * @returns {Money}
 * @throws {ValidationError} when `minor` is not an integer or the currency is invalid
 */
export function fromMinor(minor, currency) {
  const code = normCurrency(currency, 'currency');
  return make(toBigInt(minor, 'minor'), code, decimalsFor(code));
}

// ── arithmetic ──────────────────────────────────────────────────────────────────────────────────

/**
 * Exact `a + b`.
 * @param {Money} a @param {Money} b
 * @returns {Money}
 * @throws {ValidationError} on currency mismatch or invalid operands
 */
export function add(a, b) {
  const [x, y] = pair(a, b);
  return make(x.minor + y.minor, x.currency, x.decimals);
}

/**
 * Exact `a - b`.
 * @param {Money} a @param {Money} b
 * @returns {Money}
 * @throws {ValidationError} on currency mismatch or invalid operands
 */
export function subtract(a, b) {
  const [x, y] = pair(a, b);
  return make(x.minor - y.minor, x.currency, x.decimals);
}

/**
 * `m × n` computed exactly on decimal digits, then rounded half away from zero to the currency's
 * decimals (`multiply(₹100.00, 0.18)` → `₹18.00`, `multiply($0.05, 0.5)` → `$0.03`).
 * @param {Money} m
 * @param {number|string|bigint} n  finite number, plain decimal string or bigint
 * @returns {Money}
 * @throws {ValidationError} when `n` is not a finite decimal or `m` is invalid
 */
export function multiply(m, n) {
  const x = normalize(m, 'money');
  const f = parseDecimal(n, 'n');
  const num = x.minor * BigInt(f.int + f.frac) * (f.neg ? -1n : 1n);
  return make(divRound(num, pow10(f.frac.length)), x.currency, x.decimals);
}

/**
 * Exact sum of a list of `Money`. An empty list has no currency of its own, so it needs the optional
 * `currency` and returns zero in it.
 * @param {Money[]} list
 * @param {string} [currency]  currency of the result for an empty list; must match the items otherwise
 * @returns {Money}
 * @throws {ValidationError} on currency mismatch, an empty list without `currency`, or invalid items
 */
export function sum(list, currency) {
  if (!Array.isArray(list)) {
    throw invalid('sum() expects an array of Money', [
      issue('list', 'invalid_type', 'expected an array of Money'),
    ]);
  }
  const fallback = currency == null ? undefined : normCurrency(currency, 'currency');
  if (list.length === 0) {
    if (!fallback) {
      throw invalid('sum() of an empty list needs a currency', [
        issue('list', 'empty', 'pass a currency to sum an empty list'),
      ]);
    }
    return make(0n, fallback, decimalsFor(fallback));
  }
  let total = 0n;
  let code = fallback;
  let decimals = fallback ? decimalsFor(fallback) : DEFAULT_DECIMALS;
  list.forEach((m, i) => {
    const x = normalize(m, `list[${i}]`);
    if (code === undefined) {
      code = x.currency;
      decimals = x.decimals;
    } else if (x.currency !== code) {
      throw mismatch(`list[${i}]`, code, x.currency);
    }
    total += x.minor;
  });
  return make(total, /** @type {string} */ (code), decimals);
}

/**
 * `-m` (zero stays `"0.00"`, never `"-0.00"`).
 * @param {Money} m
 * @returns {Money}
 * @throws {ValidationError} when `m` is invalid
 */
export function negate(m) {
  const x = normalize(m, 'money');
  return make(-x.minor, x.currency, x.decimals);
}

// ── comparison ──────────────────────────────────────────────────────────────────────────────────

/**
 * Three‑way comparison by value (`"1.00"` equals `"1"`).
 * @param {Money} a @param {Money} b
 * @returns {-1|0|1}
 * @throws {ValidationError} on currency mismatch or invalid operands
 */
export function compare(a, b) {
  const [x, y] = pair(a, b);
  if (x.minor < y.minor) return -1;
  if (x.minor > y.minor) return 1;
  return 0;
}

/**
 * True when the amount is zero at the currency's precision.
 * @param {Money} m
 * @returns {boolean}
 * @throws {ValidationError} when `m` is invalid
 */
export function isZero(m) {
  return normalize(m, 'money').minor === 0n;
}

/**
 * True when the amount is below zero at the currency's precision.
 * @param {Money} m
 * @returns {boolean}
 * @throws {ValidationError} when `m` is invalid
 */
export function isNegative(m) {
  return normalize(m, 'money').minor < 0n;
}

/**
 * @param {unknown} list @param {string} name @param {(a: bigint, b: bigint) => boolean} better
 * @returns {Money}
 */
function extreme(list, name, better) {
  if (!Array.isArray(list) || list.length === 0) {
    throw invalid(`${name}() expects a non-empty array of Money`, [
      issue('list', Array.isArray(list) ? 'empty' : 'invalid_type', 'expected a non-empty array'),
    ]);
  }
  /** @type {Money} */
  let best = list[0];
  /** @type {bigint|undefined} */
  let bestMinor;
  let code;
  list.forEach((m, i) => {
    const x = normalize(m, `list[${i}]`);
    if (code === undefined) code = x.currency;
    else if (x.currency !== code) throw mismatch(`list[${i}]`, code, x.currency);
    if (bestMinor === undefined || better(x.minor, bestMinor)) {
      best = m;
      bestMinor = x.minor;
    }
  });
  return best;
}

/**
 * The smallest item (the original object, first one on ties).
 * @param {Money[]} list
 * @returns {Money}
 * @throws {ValidationError} on an empty list, currency mismatch or invalid items
 */
export function min(list) {
  return extreme(list, 'min', (a, b) => a < b);
}

/**
 * The largest item (the original object, first one on ties).
 * @param {Money[]} list
 * @returns {Money}
 * @throws {ValidationError} on an empty list, currency mismatch or invalid items
 */
export function max(list) {
  return extreme(list, 'max', (a, b) => a > b);
}

// ── allocation / FX / per pax ───────────────────────────────────────────────────────────────────

/**
 * Split `m` in proportion to `ratios` without rounding loss: the shares always sum exactly to `m`
 * (largest‑remainder method — each share is floored, then the leftover minor units go to the shares
 * with the largest remainders, lowest index first on ties). Ratios may be any non‑negative finite
 * numbers (`[1, 1, 1]`, `[50, 30, 20]`, `[0.5, 0.25, 0.25]`); a zero ratio always gets zero. A
 * positive integer instead of an array splits into that many equal shares. Negative amounts split
 * symmetrically.
 * @param {Money} m
 * @param {number[]|number} ratios
 * @returns {Money[]}
 * @throws {ValidationError} when ratios are empty, negative, non‑finite or all zero
 */
export function allocate(m, ratios) {
  const x = normalize(m, 'money');
  /** @type {bigint[]} */
  let weights;
  if (typeof ratios === 'number' && Number.isInteger(ratios) && ratios >= 1) {
    weights = Array.from({ length: ratios }, () => 1n);
  } else if (Array.isArray(ratios) && ratios.length > 0) {
    const parsed = ratios.map((r, i) => {
      if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) {
        throw invalid('allocate() ratios must be finite numbers >= 0', [
          issue(`ratios[${i}]`, 'invalid_ratio', 'expected a finite number >= 0', { value: r }),
        ]);
      }
      return parseDecimal(r, `ratios[${i}]`);
    });
    const places = parsed.reduce((n, p) => (p.frac.length > n ? p.frac.length : n), 0);
    weights = parsed.map((p) => BigInt(p.int + p.frac.padEnd(places, '0')));
  } else {
    throw invalid('allocate() expects a non-empty array of ratios or a positive integer count', [
      issue('ratios', 'invalid_type', 'expected number[] or a positive integer'),
    ]);
  }
  const totalWeight = weights.reduce((s, w) => s + w, 0n);
  if (totalWeight === 0n) {
    throw invalid('allocate() ratios must not all be zero', [
      issue('ratios', 'min', 'at least one ratio must be positive'),
    ]);
  }
  const neg = x.minor < 0n;
  const total = neg ? -x.minor : x.minor;
  const shares = weights.map((w) => (total * w) / totalWeight);
  const remainders = weights.map((w) => (total * w) % totalWeight);
  let left = total - shares.reduce((s, v) => s + v, 0n);
  const order = remainders
    .map((_, i) => i)
    .sort((a, b) => {
      if (remainders[a] === remainders[b]) return a - b;
      return remainders[a] > remainders[b] ? -1 : 1;
    });
  for (const i of order) {
    if (left === 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map((s) => make(neg ? -s : s, x.currency, x.decimals));
}

/**
 * Exact positive rational for a rate value (number or decimal string).
 * @param {unknown} v @param {string} path @returns {{ num: bigint, den: bigint }}
 */
function toRational(v, path) {
  const d = parseDecimal(v, path);
  const num = BigInt(d.int + d.frac);
  if (d.neg || num === 0n) {
    throw invalid(`${path} must be a positive exchange rate`, [
      issue(path, 'invalid_rate', 'exchange rates must be positive numbers', { value: String(v) }),
    ]);
  }
  return { num, den: pow10(d.frac.length) };
}

/**
 * Own property of a table, or `undefined` — inherited (or prototype‑polluted) keys are never rates.
 * @param {Record<string, unknown>} table @param {string} key @returns {unknown}
 */
function own(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Whether a rate value is exactly 1 (`1`, `1n`, `"1.00"`).
 * @param {unknown} v @returns {boolean}
 */
function isUnitRate(v) {
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'bigint') return v === 1n;
  return typeof v === 'string' && /^\+?0*1(?:\.0*)?$/.test(v.trim());
}

/**
 * Whether a flat table lists its base currency explicitly (some currency code at rate 1).
 * @param {Record<string, unknown>} rates @returns {boolean}
 */
function hasExplicitBase(rates) {
  return Object.keys(rates).some((k) => CURRENCY_RE.test(k) && isUnitRate(rates[k]));
}

/**
 * Rate `from → to` from a rates table: a pair key (`USDINR`, `USD_INR`, `USD/INR`, `USD-INR`, or
 * the reverse pair inverted), a nested `rates[from][to]`, or a flat table relative to one base
 * currency. In a flat table one side may be missing only as the omitted base (rate 1); when some
 * listed currency already has rate 1 the base is explicit, so an unlisted currency is unknown
 * rather than the base.
 * @param {Record<string, unknown>} rates @param {string} from @param {string} to
 * @returns {{ num: bigint, den: bigint }}
 */
function findRate(rates, from, to) {
  for (const sep of ['', '_', '/', '-']) {
    const direct = own(rates, `${from}${sep}${to}`);
    if (direct !== undefined && direct !== null)
      return toRational(direct, `rates.${from}${sep}${to}`);
    const inverse = own(rates, `${to}${sep}${from}`);
    if (inverse !== undefined && inverse !== null) {
      const r = toRational(inverse, `rates.${to}${sep}${from}`);
      return { num: r.den, den: r.num };
    }
  }
  const rawFrom = own(rates, from);
  const rawTo = own(rates, to);
  const nestedFrom = isObject(rawFrom) ? rawFrom : undefined;
  const nestedFromTo = nestedFrom ? own(nestedFrom, to) : undefined;
  if (nestedFromTo !== undefined && nestedFromTo !== null) {
    return toRational(nestedFromTo, `rates.${from}.${to}`);
  }
  const nestedTo = isObject(rawTo) ? rawTo : undefined;
  const nestedToFrom = nestedTo ? own(nestedTo, from) : undefined;
  if (nestedToFrom !== undefined && nestedToFrom !== null) {
    const r = toRational(nestedToFrom, `rates.${to}.${from}`);
    return { num: r.den, den: r.num };
  }
  const flatFrom = nestedFrom ? undefined : rawFrom;
  const flatTo = nestedTo ? undefined : rawTo;
  const hasFrom = flatFrom !== undefined && flatFrom !== null;
  const hasTo = flatTo !== undefined && flatTo !== null;
  if ((!hasFrom && !hasTo) || ((!hasFrom || !hasTo) && hasExplicitBase(rates))) {
    throw invalid(`convert(): no exchange rate from ${from} to ${to}`, [
      issue('rates', 'rate_missing', `no exchange rate for ${from} -> ${to}`, { from, to }),
    ]);
  }
  const f = hasFrom ? toRational(flatFrom, `rates.${from}`) : { num: 1n, den: 1n };
  const t = hasTo ? toRational(flatTo, `rates.${to}`) : { num: 1n, den: 1n };
  return { num: t.num * f.den, den: t.den * f.num };
}

/**
 * Display‑only currency conversion (never use it to charge). `rates` is a base‑relative table
 * (`{ USD: 1, INR: 83.25 }`; the base may be omitted, but once some currency is listed at rate 1
 * every other currency must be listed too — an unlisted one is `rate_missing`, never silently the
 * base), a pair‑keyed table (`{ USD_INR: 83.25 }`, also `USDINR`, `USD/INR`, `USD-INR`; the reverse
 * pair is inverted) or nested (`{ USD: { INR: 83.25 } }`). Arithmetic is exact on the decimal
 * digits of amount and rate; only the final result is rounded.
 * @param {Money} m
 * @param {string} to  target currency
 * @param {Record<string, number|string|Record<string, number|string>>} rates
 * @param {ConvertOptions} [options]
 * @returns {Money}
 * @throws {ValidationError} when no rate links the currencies, a rate is not positive, or `round` is invalid
 */
export function convert(m, to, rates, options = {}) {
  const x = normalize(m, 'money');
  const target = normCurrency(to, 'to');
  const toDecimals = decimalsFor(target);
  const round = isObject(options) && options.round !== undefined ? options.round : 'auto';
  if (round !== 'auto' && !(Number.isInteger(round) && round >= 0)) {
    throw invalid("options.round must be 'auto' or a non-negative integer", [
      issue('options.round', 'invalid_enum', "expected 'auto' or a non-negative integer"),
    ]);
  }
  const places = round === 'auto' ? toDecimals : Math.min(round, toDecimals);
  const shift = pow10(toDecimals - places);
  if (target === x.currency) {
    return make(divRound(x.minor, shift) * shift, target, toDecimals);
  }
  if (!isObject(rates)) {
    throw invalid('convert() expects a rates table', [
      issue('rates', 'invalid_type', 'expected an object of exchange rates'),
    ]);
  }
  const rate = findRate(rates, x.currency, target);
  const num = x.minor * rate.num * pow10(places);
  const den = pow10(x.decimals) * rate.den;
  return make(divRound(num, den) * shift, target, toDecimals);
}

/**
 * The `Intl.NumberFormat` constructor when the runtime has one.
 * @returns {typeof Intl.NumberFormat|undefined}
 */
function intlNumberFormat() {
  const I = globalThis.Intl;
  return I && typeof I.NumberFormat === 'function' ? I.NumberFormat : undefined;
}

/**
 * Localised currency symbol from `Intl`, or `undefined` when unavailable.
 * @param {string} code @param {string|string[]|undefined} locale @returns {string|undefined}
 */
function intlSymbol(code, locale) {
  const Ctor = intlNumberFormat();
  if (!Ctor) return undefined;
  try {
    const nf = new Ctor(locale || 'en', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    });
    if (typeof nf.formatToParts !== 'function') return undefined;
    const part = nf.formatToParts(0).find((p) => p.type === 'currency');
    return part && part.value ? part.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Localised currency name from `Intl.DisplayNames`, or `undefined` when unavailable / unknown.
 * @param {string} code @param {string|string[]|undefined} locale @returns {string|undefined}
 */
function intlName(code, locale) {
  const I = globalThis.Intl;
  if (!I || typeof I.DisplayNames !== 'function') return undefined;
  try {
    const dn = new I.DisplayNames(locale || 'en', { type: 'currency', fallback: 'none' });
    const name = dn.of(code);
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decimals, symbol and name of a currency. Decimals come from the built‑in ISO‑4217 table (default 2);
 * the symbol from the built‑in table, then `Intl`, then the code; the name from `Intl.DisplayNames`
 * (in `locale`, default `en`), then the built‑in table, then the code. Never throws for an unknown but
 * well‑formed code.
 * @param {string} code
 * @param {{ locale?: string|string[] }} [options]
 * @returns {Currency}
 * @throws {ValidationError} when `code` is not a 3‑letter code
 */
export function currencyInfo(code, options = {}) {
  const c = normCurrency(code, 'code');
  const locale = isObject(options) ? options.locale : undefined;
  return {
    code: c,
    name: intlName(c, locale) || NAMES[c] || c,
    symbol: SYMBOLS[c] || intlSymbol(c, locale) || c,
    decimals: decimalsFor(c),
  };
}

/**
 * Total divided by the number of paying passengers (adults, children, seated infants, youth,
 * seniors; lap infants only with `includeInfants`), rounded half away from zero to the currency's
 * decimals. Missing counts are treated as zero.
 * @param {Money} total
 * @param {PaxCounts} pax
 * @param {PricePerPaxOptions} [options]
 * @returns {Money}
 * @throws {ValidationError} when a count is not a non‑negative integer or no passenger pays
 */
export function pricePerPax(total, pax, options = {}) {
  const x = normalize(total, 'total');
  if (!isObject(pax)) {
    throw invalid('pricePerPax() expects PaxCounts', [
      issue('pax', 'invalid_type', 'expected { adults, children, infants, ... }'),
    ]);
  }
  const includeInfants = isObject(options) && options.includeInfants === true;
  const counted = ['adults', 'children', 'infantsSeated', 'youth', 'seniors', 'infants'];
  let count = 0;
  for (const key of counted) {
    const v = pax[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw invalid(`pax.${key} must be a non-negative integer`, [
        issue(`pax.${key}`, 'invalid_type', 'expected a non-negative integer', { value: v }),
      ]);
    }
    if (key !== 'infants' || includeInfants) count += v;
  }
  if (count === 0) {
    throw invalid('pricePerPax() needs at least one paying passenger', [
      issue('pax', 'min', 'at least one paying passenger is required', { min: 1 }),
    ]);
  }
  return make(divRound(x.minor, BigInt(count)), x.currency, x.decimals);
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

/** Memoised formatters per `Intl.NumberFormat` constructor (so a swapped `Intl` never serves stale ones). */
const FORMATTERS = new WeakMap();

/**
 * Construct (or reuse) a formatter; `null` when the runtime rejects these options.
 * @param {typeof Intl.NumberFormat} Ctor @param {string|string[]|undefined} locale @param {object} opts
 * @returns {Intl.NumberFormat|null}
 */
function cachedFormatter(Ctor, locale, opts) {
  let map = FORMATTERS.get(Ctor);
  if (!map) {
    map = new Map();
    FORMATTERS.set(Ctor, map);
  }
  const key = JSON.stringify([locale, opts]);
  if (map.has(key)) return map.get(key);
  let formatter = null;
  try {
    const nf = new Ctor(locale, opts);
    if (nf && typeof nf.format === 'function') formatter = nf;
  } catch {
    // the runtime rejected the currency, locale or an option: remember the miss
  }
  if (map.size >= FORMATTER_CACHE_SIZE) map.clear();
  map.set(key, formatter);
  return formatter;
}

/**
 * Best available `Intl` formatter: as requested, then `narrowSymbol` → `symbol`, then without the
 * locale. `signDisplay` is never dropped silently (the fallback honours it instead).
 * @param {string|string[]|undefined} locale @param {string} currency @param {string} currencyDisplay
 * @param {number} digits @param {string|undefined} signDisplay
 * @returns {Intl.NumberFormat|undefined}
 */
function intlFormatter(locale, currency, currencyDisplay, digits, signDisplay) {
  const Ctor = intlNumberFormat();
  if (!Ctor) return undefined;
  const base = {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  };
  if (signDisplay !== undefined) base.signDisplay = signDisplay;
  const displays =
    currencyDisplay === 'narrowSymbol' ? ['narrowSymbol', 'symbol'] : [currencyDisplay];
  const locales = locale === undefined ? [undefined] : [locale, undefined];
  for (const loc of locales) {
    for (const display of displays) {
      const f = cachedFormatter(Ctor, loc, { ...base, currencyDisplay: display });
      if (f) return f;
    }
  }
  return undefined;
}

/**
 * Sign prefix per `Intl` `signDisplay` semantics.
 * @param {boolean} neg @param {boolean} zero @param {string} signDisplay @returns {string}
 */
function signPrefix(neg, zero, signDisplay) {
  switch (signDisplay) {
    case 'never':
      return '';
    case 'always':
      return neg ? '-' : '+';
    case 'exceptZero':
      return zero ? '' : neg ? '-' : '+';
    default:
      return neg ? '-' : '';
  }
}

/**
 * `en`‑style formatting used when `Intl` is missing or rejects the request: 3‑digit grouping, `.`
 * decimal, symbol (or code) before the number with a no‑break space after alphabetic units.
 * @param {bigint} scaled  amount already scaled to `digits` fraction digits
 * @param {string} currency @param {string} display @param {number} digits
 * @param {string} signDisplay @returns {string}
 */
function formatFallback(scaled, currency, display, digits, signDisplay) {
  const neg = scaled < 0n;
  let s = (neg ? -scaled : scaled).toString();
  let frac = '';
  if (digits > 0) {
    s = s.padStart(digits + 1, '0');
    frac = s.slice(-digits);
    s = s.slice(0, -digits);
  }
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = digits > 0 ? `${grouped}.${frac}` : grouped;
  const unit = display === 'code' ? currency : SYMBOLS[currency] || currency;
  const space = /[A-Za-z]$/.test(unit) ? '\u00a0' : '';
  return `${signPrefix(neg, scaled === 0n, signDisplay)}${unit}${space}${body}`;
}

/**
 * Localised currency string via `Intl.NumberFormat` with per‑currency decimals (`₹1,234.50`,
 * `¥1,234`, `BHD 1.235`). The amount is rounded to the displayed digits here (half away from zero,
 * never a negative zero) and passed as a decimal string, so modern engines format it exactly and
 * the engine's rounding mode never applies. When the runtime has no `Intl`, rejects the currency,
 * locale or an option, a built‑in `en`‑style fallback is used instead (symbol table, `,` grouping,
 * `.` decimal) — it never throws for a well‑formed currency.
 * @param {Money} m
 * @param {FormatMoneyOptions} [options]
 * @returns {string}
 * @throws {ValidationError} when `m` or an option is invalid
 */
export function formatMoney(m, options = {}) {
  const x = normalize(m, 'money');
  const o = isObject(options) ? options : {};
  const display = o.display === undefined ? 'symbol' : o.display;
  if (!Object.prototype.hasOwnProperty.call(DISPLAYS, display)) {
    throw invalid("options.display must be 'symbol', 'code' or 'narrow'", [
      issue('options.display', 'invalid_enum', "expected 'symbol' | 'code' | 'narrow'", {
        value: display,
      }),
    ]);
  }
  const fraction = o.fraction === undefined ? 'auto' : o.fraction;
  if (
    fraction !== 'auto' &&
    !(Number.isInteger(fraction) && fraction >= 0 && fraction <= MAX_FRACTION)
  ) {
    throw invalid(`options.fraction must be 'auto' or an integer 0-${MAX_FRACTION}`, [
      issue('options.fraction', 'invalid_enum', `expected 'auto' or an integer 0-${MAX_FRACTION}`, {
        value: fraction,
      }),
    ]);
  }
  const signDisplay = o.signDisplay;
  if (signDisplay !== undefined && !SIGN_DISPLAYS.includes(signDisplay)) {
    throw invalid('options.signDisplay is not a valid Intl signDisplay', [
      issue('options.signDisplay', 'invalid_enum', `expected one of ${SIGN_DISPLAYS.join(', ')}`, {
        value: signDisplay,
      }),
    ]);
  }
  const locale = o.locale;
  if (
    locale !== undefined &&
    typeof locale !== 'string' &&
    !(Array.isArray(locale) && locale.every((l) => typeof l === 'string'))
  ) {
    throw invalid('options.locale must be a string or an array of strings', [
      issue('options.locale', 'invalid_type', 'expected a BCP 47 locale string or string[]'),
    ]);
  }
  const digits = fraction === 'auto' ? x.decimals : fraction;
  // Round to the displayed digits here (half away from zero, on a bigint), so the engine's rounding
  // mode never applies and `-0.40` at 0 digits renders as `$0`, never `-$0`.
  const scaled = rescale(x.minor, x.decimals, digits);
  const formatter = intlFormatter(locale, x.currency, DISPLAYS[display], digits, signDisplay);
  if (formatter) {
    try {
      return formatter.format(unscale(scaled, digits));
    } catch {
      // fall through to the built-in formatter
    }
  }
  return formatFallback(scaled, x.currency, display, digits, signDisplay || 'auto');
}
