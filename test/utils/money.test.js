import { describe, it, expect, afterEach, vi } from 'vitest';
import * as mod from '../../src/utils/money.js';
import {
  money,
  parseMoney,
  formatMoney,
  toMinor,
  fromMinor,
  add,
  subtract,
  multiply,
  sum,
  negate,
  compare,
  isZero,
  isNegative,
  min,
  max,
  allocate,
  convert,
  currencyInfo,
  pricePerPax,
} from '../../src/utils/money.js';
import { ValidationError, SdkError } from '../../src/errors/index.js';

/** Intl separates alphabetic currency units with U+00A0 / U+202F; compare on plain spaces. */
const plain = (s) => s.replace(/[\u00a0\u202f]/g, ' ');
const INR = (amount) => money(amount, 'INR');
const USD = (amount) => money(amount, 'USD');

/** Asserts a ValidationError (never a plain Error) carrying the given issue code and, optionally, path. */
function expectValidation(fn, code, path) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected a ValidationError to be thrown').toBeInstanceOf(ValidationError);
  expect(caught).toBeInstanceOf(SdkError);
  expect(caught.name).toBe('ValidationError');
  expect(caught.code).toBe('VALIDATION_FAILED');
  expect(Array.isArray(caught.issues)).toBe(true);
  expect(caught.issues.length).toBeGreaterThan(0);
  for (const i of caught.issues) {
    expect(typeof i.path).toBe('string');
    expect(typeof i.code).toBe('string');
    expect(typeof i.message).toBe('string');
  }
  if (code) expect(caught.issues.map((i) => i.code)).toContain(code);
  if (path) expect(caught.issues.map((i) => i.path)).toContain(path);
  return caught;
}

const RealIntl = globalThis.Intl;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('module surface', () => {
  it('exports exactly the functions documented in 03-utils.md §1 (named exports only)', () => {
    expect(Object.keys(mod).sort()).toEqual(
      [
        'money',
        'parseMoney',
        'formatMoney',
        'toMinor',
        'fromMinor',
        'add',
        'subtract',
        'multiply',
        'sum',
        'negate',
        'compare',
        'isZero',
        'isNegative',
        'min',
        'max',
        'allocate',
        'convert',
        'currencyInfo',
        'pricePerPax',
      ].sort()
    );
    expect(mod.default).toBeUndefined();
  });
});

describe('money()', () => {
  it('normalises to the currency decimals and upper-cases the code', () => {
    expect(money('1234.5', 'inr')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(money(1234.5, 'INR')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(money('1234', 'JPY')).toEqual({ amount: '1234', currency: 'JPY' });
    expect(money('1.2', 'BHD')).toEqual({ amount: '1.200', currency: 'BHD' });
    expect(money(' 12 ', 'USD')).toEqual({ amount: '12.00', currency: 'USD' });
    expect(money('.5', 'USD')).toEqual({ amount: '0.50', currency: 'USD' });
    expect(money('-.5', 'USD')).toEqual({ amount: '-0.50', currency: 'USD' });
    expect(money('+7.', 'USD')).toEqual({ amount: '7.00', currency: 'USD' });
    expect(money('007.10', 'USD')).toEqual({ amount: '7.10', currency: 'USD' });
    expect(money(0, 'USD')).toEqual({ amount: '0.00', currency: 'USD' });
    expect(money(-0, 'USD')).toEqual({ amount: '0.00', currency: 'USD' });
  });

  it('rounds excess precision half away from zero', () => {
    expect(money('1.005', 'USD').amount).toBe('1.01');
    expect(money(1.005, 'USD').amount).toBe('1.01');
    expect(money('1.0049', 'USD').amount).toBe('1.00');
    expect(money('-1.005', 'USD').amount).toBe('-1.01');
    expect(money('1.2345', 'BHD').amount).toBe('1.235');
    expect(money(2.5, 'JPY').amount).toBe('3');
    expect(money(-2.5, 'JPY').amount).toBe('-3');
    expect(money(0.5, 'JPY').amount).toBe('1');
    expect(money('0.1', 'JPY').amount).toBe('0');
  });

  it('never produces a negative zero', () => {
    expect(money('-0.001', 'USD').amount).toBe('0.00');
    expect(money('-0', 'USD').amount).toBe('0.00');
    expect(money('-0.4', 'JPY').amount).toBe('0');
  });

  it('expands exponent notation of large and tiny numbers exactly', () => {
    expect(money(1e21, 'USD').amount).toBe('1000000000000000000000.00');
    expect(money(1.5e21, 'USD').amount).toBe('1500000000000000000000.00');
    expect(money(-1.5e-7, 'USD').amount).toBe('0.00');
    expect(money(1.5e-7, 'BHD').amount).toBe('0.000');
    expect(money(123456789.125, 'BHD').amount).toBe('123456789.125');
  });

  it('keeps the documented decimals table', () => {
    for (const c of ['JPY', 'KRW', 'VND', 'ISK', 'CLP', 'XOF', 'UGX']) {
      expect(money('1', c).amount, c).toBe('1');
    }
    for (const c of ['BHD', 'KWD', 'OMR', 'JOD', 'IQD', 'LYD', 'TND']) {
      expect(money('1', c).amount, c).toBe('1.000');
    }
    expect(money('1', 'CLF').amount).toBe('1.0000');
    for (const c of ['INR', 'USD', 'EUR', 'AED', 'GBP', 'XTS', 'ZZZ']) {
      expect(money('1', c).amount, c).toBe('1.00');
    }
  });

  it('rejects malformed amounts with a ValidationError (strict: no separators, no exponent)', () => {
    expectValidation(() => money('abc', 'USD'), 'invalid_format', 'amount');
    expectValidation(() => money('1,234', 'USD'), 'invalid_format', 'amount');
    expectValidation(() => money('1e3', 'USD'), 'invalid_format', 'amount');
    expectValidation(() => money('', 'USD'), 'invalid_format', 'amount');
    expectValidation(() => money('.', 'USD'), 'invalid_format', 'amount');
    expectValidation(() => money('1.2.3', 'USD'), 'invalid_format', 'amount');
    expectValidation(() => money(NaN, 'USD'), 'not_finite', 'amount');
    expectValidation(() => money(Infinity, 'USD'), 'not_finite', 'amount');
    expectValidation(() => money(null, 'USD'), 'required', 'amount');
    expectValidation(() => money(undefined, 'USD'), 'required', 'amount');
    expectValidation(() => money({}, 'USD'), 'invalid_type', 'amount');
    expectValidation(() => money(true, 'USD'), 'invalid_type', 'amount');
  });

  it('rejects malformed currencies', () => {
    expectValidation(() => money('1', 'US'), 'invalid_currency', 'currency');
    expectValidation(() => money('1', 'US1'), 'invalid_currency', 'currency');
    expectValidation(() => money('1', 'USDX'), 'invalid_currency', 'currency');
    expectValidation(() => money('1', ''), 'invalid_currency', 'currency');
    expectValidation(() => money('1'), 'invalid_currency', 'currency');
    expectValidation(() => money('1', 840), 'invalid_currency', 'currency');
  });
});

describe('parseMoney()', () => {
  it('parses an ISO code before or after the number', () => {
    expect(parseMoney('INR 1,234.50')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('1,234.50 INR')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('inr 1234.5')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('INR1,234.50')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('1,234.50INR')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('  JPY 1,234  ')).toEqual({ amount: '1234', currency: 'JPY' });
    expect(parseMoney('USD -1,234.50')).toEqual({ amount: '-1234.50', currency: 'USD' });
    expect(parseMoney('BHD 1.2345')).toEqual({ amount: '1.235', currency: 'BHD' });
  });

  it('accepts a symbol, words, sign or accounting parentheses only when the currency is given', () => {
    const o = { currency: 'INR' };
    expect(parseMoney('₹1,234.50', o)).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('₹ 1,234.50', o)).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('-₹1,234.50', o)).toEqual({ amount: '-1234.50', currency: 'INR' });
    expect(parseMoney('₹-1,234.50', o)).toEqual({ amount: '-1234.50', currency: 'INR' });
    expect(parseMoney('(₹1,234.50)', o)).toEqual({ amount: '-1234.50', currency: 'INR' });
    expect(parseMoney('Rs. 1,234', o)).toEqual({ amount: '1234.00', currency: 'INR' });
    expect(parseMoney('1,234.50 ₹', o)).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney('+₹5', o)).toEqual({ amount: '5.00', currency: 'INR' });
    expect(parseMoney('.5', o)).toEqual({ amount: '0.50', currency: 'INR' });
    expect(parseMoney('1234.5', { currency: 'inr' })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney('$1,234.50', { currency: 'USD' })).toEqual({
      amount: '1234.50',
      currency: 'USD',
    });
    expect(parseMoney('€1 234,50'.replace(',50', '.50'), { currency: 'EUR' })).toEqual({
      amount: '1234.50',
      currency: 'EUR',
    });
  });

  it('understands Western and Indian digit grouping', () => {
    expect(parseMoney('INR 12,34,567.89')).toEqual({ amount: '1234567.89', currency: 'INR' });
    expect(parseMoney('USD 1,234,567.89')).toEqual({ amount: '1234567.89', currency: 'USD' });
    expect(parseMoney("CHF 1'234.50")).toEqual({ amount: '1234.50', currency: 'CHF' });
    expect(parseMoney('EUR 1\u00a0234.50')).toEqual({ amount: '1234.50', currency: 'EUR' });
  });

  it('rejects symbol-only input without a currency', () => {
    expectValidation(() => parseMoney('₹1,234.50'), 'required', 'currency');
    expectValidation(() => parseMoney('1,234.50'), 'required', 'currency');
    expectValidation(() => parseMoney('$5'), 'required', 'currency');
  });

  it('rejects a code that disagrees with opts.currency', () => {
    expectValidation(() => parseMoney('USD 100', { currency: 'INR' }), 'currency_mismatch');
    expectValidation(() => parseMoney('100 USD', { currency: 'INR' }), 'currency_mismatch');
    expectValidation(
      () => parseMoney({ amount: '100', currency: 'USD' }, { currency: 'INR' }),
      'currency_mismatch'
    );
    expectValidation(
      () => parseMoney({ amount: 'USD 100', currency: 'INR' }),
      'currency_mismatch',
      'input.amount.currency'
    );
  });

  it('rejects malformed or ambiguous numbers instead of misreading them', () => {
    const o = { currency: 'INR' };
    expectValidation(() => parseMoney('1,50', o), 'invalid_format');
    expectValidation(() => parseMoney('1,2345', o), 'invalid_format');
    expectValidation(() => parseMoney('1.234,50 EUR'), 'invalid_format');
    expectValidation(() => parseMoney('INR'), 'invalid_format');
    expectValidation(() => parseMoney('₹', o), 'invalid_format');
    expectValidation(() => parseMoney('abcd', o), 'invalid_format');
    // any bare 3-letter token is read as an ISO code, so it is a mismatch rather than a bad number
    expectValidation(() => parseMoney('abc', o), 'currency_mismatch');
    expectValidation(() => parseMoney('--5', o), 'invalid_format');
    expectValidation(() => parseMoney('1.2.3', o), 'invalid_format');
    expectValidation(() => parseMoney('', o), 'required', 'input');
    expectValidation(() => parseMoney('   ', o), 'required', 'input');
    expectValidation(() => parseMoney('INR 1,234.50', { currency: 'IN' }), 'invalid_currency');
  });

  it('accepts { amount, currency } objects with string, number or bigint amounts', () => {
    expect(parseMoney({ amount: '1234.50', currency: 'INR' })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney({ amount: '1,234.50', currency: 'inr' })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney({ amount: '₹1,234.50', currency: 'INR' })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney({ amount: 1234.5, currency: 'INR' })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney({ amount: 1234n, currency: 'INR' })).toEqual({
      amount: '1234.00',
      currency: 'INR',
    });
    expect(parseMoney({ amount: '1234.5' }, { currency: 'INR' })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney({ amount: 'INR 10' })).toEqual({ amount: '10.00', currency: 'INR' });
  });

  it('rejects objects without a usable amount or currency', () => {
    expectValidation(() => parseMoney({ amount: '1234.5' }), 'required', 'currency');
    expectValidation(() => parseMoney({ currency: 'INR' }), 'required', 'input.amount');
    expectValidation(
      () => parseMoney({ amount: null, currency: 'INR' }),
      'required',
      'input.amount'
    );
    expectValidation(() => parseMoney({ amount: true, currency: 'INR' }), 'invalid_type');
    expectValidation(() => parseMoney({ amount: NaN, currency: 'INR' }), 'not_finite');
    expectValidation(() => parseMoney({ amount: '1', currency: 'INRR' }), 'invalid_currency');
    expectValidation(() => parseMoney(null), 'required', 'input');
    expectValidation(() => parseMoney(undefined), 'required', 'input');
    expectValidation(() => parseMoney(true), 'invalid_type', 'input');
    expectValidation(() => parseMoney(['1', 'INR']), 'invalid_type', 'input');
  });

  it('accepts bare numbers and bigints with opts.currency', () => {
    expect(parseMoney(1234.5, { currency: 'INR' })).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(parseMoney(1234n, { currency: 'JPY' })).toEqual({ amount: '1234', currency: 'JPY' });
    expect(parseMoney(-0.005, { currency: 'USD' })).toEqual({ amount: '-0.01', currency: 'USD' });
    expectValidation(() => parseMoney(1234.5), 'required', 'currency');
    expectValidation(() => parseMoney(Infinity, { currency: 'INR' }), 'not_finite');
  });

  it('reads minor-unit integers when opts.minor is set', () => {
    expect(parseMoney(123450, { currency: 'INR', minor: true })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney(123450n, { currency: 'INR', minor: true })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney(-5, { currency: 'INR', minor: true })).toEqual({
      amount: '-0.05',
      currency: 'INR',
    });
    expect(parseMoney('INR 123450', { minor: true })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney('1,23,450', { currency: 'INR', minor: true })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney('(123450)', { currency: 'INR', minor: true })).toEqual({
      amount: '-1234.50',
      currency: 'INR',
    });
    expect(parseMoney({ amount: 1234, currency: 'JPY' }, { minor: true })).toEqual({
      amount: '1234',
      currency: 'JPY',
    });
    expect(parseMoney({ amount: '1235', currency: 'BHD' }, { minor: true })).toEqual({
      amount: '1.235',
      currency: 'BHD',
    });
    expect(parseMoney('123450.00', { currency: 'INR', minor: true })).toEqual({
      amount: '1234.50',
      currency: 'INR',
    });
    expect(parseMoney('123456789012345678901', { currency: 'INR', minor: true })).toEqual({
      amount: '1234567890123456789.01',
      currency: 'INR',
    });
  });

  it('rejects non-integer minor units', () => {
    expectValidation(() => parseMoney('123450.5', { currency: 'INR', minor: true }), 'not_integer');
    expectValidation(() => parseMoney(1234.5, { currency: 'INR', minor: true }), 'not_integer');
    expectValidation(() => parseMoney(2 ** 53, { currency: 'INR', minor: true }), 'not_integer');
    expectValidation(
      () => parseMoney({ amount: 1.5, currency: 'INR' }, { minor: true }),
      'not_integer'
    );
    expectValidation(
      () => parseMoney(123450, { currency: 'INR', minor: 'yes' }),
      'invalid_type',
      'opts.minor'
    );
    expect(parseMoney(123450, { currency: 'INR', minor: false })).toEqual({
      amount: '123450.00',
      currency: 'INR',
    });
  });

  it('does not mutate its input', () => {
    const input = { amount: '1,234.50', currency: 'inr' };
    const out = parseMoney(input);
    expect(input).toEqual({ amount: '1,234.50', currency: 'inr' });
    expect(out).not.toBe(input);
  });
});

describe('toMinor() / fromMinor()', () => {
  it('scales exactly to the currency minor unit', () => {
    expect(toMinor(INR('1234.50'))).toBe(123450n);
    expect(toMinor({ amount: '1234.5', currency: 'inr' })).toBe(123450n);
    expect(toMinor({ amount: 1234.5, currency: 'INR' })).toBe(123450n);
    expect(toMinor({ amount: '1234', currency: 'JPY' })).toBe(1234n);
    expect(toMinor({ amount: '1.235', currency: 'BHD' })).toBe(1235n);
    expect(toMinor({ amount: '-0.05', currency: 'USD' })).toBe(-5n);
    expect(toMinor({ amount: '0', currency: 'USD' })).toBe(0n);
    expect(toMinor({ amount: '12345678901234567890.12', currency: 'USD' })).toBe(
      1234567890123456789012n
    );
  });

  it('rounds excess precision the same way money() does', () => {
    expect(toMinor({ amount: '0.005', currency: 'USD' })).toBe(1n);
    expect(toMinor({ amount: '0.0049', currency: 'USD' })).toBe(0n);
    expect(toMinor({ amount: '-0.005', currency: 'USD' })).toBe(-1n);
    expect(toMinor({ amount: '2.5', currency: 'JPY' })).toBe(3n);
  });

  it('builds Money from bigint, number or integer-string minor units', () => {
    expect(fromMinor(123450n, 'INR')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(fromMinor(123450, 'inr')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(fromMinor('123450', 'INR')).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(fromMinor('+5', 'INR')).toEqual({ amount: '0.05', currency: 'INR' });
    expect(fromMinor(5, 'INR')).toEqual({ amount: '0.05', currency: 'INR' });
    expect(fromMinor(-5, 'INR')).toEqual({ amount: '-0.05', currency: 'INR' });
    expect(fromMinor(0n, 'INR')).toEqual({ amount: '0.00', currency: 'INR' });
    expect(fromMinor(1234n, 'JPY')).toEqual({ amount: '1234', currency: 'JPY' });
    expect(fromMinor(1235n, 'BHD')).toEqual({ amount: '1.235', currency: 'BHD' });
    expect(fromMinor(7n, 'BHD')).toEqual({ amount: '0.007', currency: 'BHD' });
    expect(fromMinor('1234567890123456789012', 'USD')).toEqual({
      amount: '12345678901234567890.12',
      currency: 'USD',
    });
  });

  it('round-trips', () => {
    for (const m of [INR('1234.50'), USD('-0.01'), money('0', 'JPY'), money('99.999', 'KWD')]) {
      expect(fromMinor(toMinor(m), m.currency)).toEqual(m);
    }
  });

  it('rejects non-integers and invalid inputs', () => {
    expectValidation(() => fromMinor(1.5, 'INR'), 'not_integer', 'minor');
    expectValidation(() => fromMinor(2 ** 53, 'INR'), 'not_integer', 'minor');
    expectValidation(() => fromMinor('12.3', 'INR'), 'not_integer', 'minor');
    expectValidation(() => fromMinor('abc', 'INR'), 'not_integer', 'minor');
    expectValidation(() => fromMinor(NaN, 'INR'), 'not_integer', 'minor');
    expectValidation(() => fromMinor(undefined, 'INR'), 'not_integer', 'minor');
    expectValidation(() => fromMinor(5n, 'IN'), 'invalid_currency', 'currency');
    expectValidation(() => toMinor(null), 'invalid_type', 'money');
    expectValidation(() => toMinor('12.00'), 'invalid_type', 'money');
    expectValidation(() => toMinor({ amount: '12.00' }), 'invalid_currency', 'money.currency');
    expectValidation(
      () => toMinor({ amount: 'x', currency: 'INR' }),
      'invalid_format',
      'money.amount'
    );
  });
});

describe('add() / subtract() / multiply() / sum() / negate()', () => {
  it('adds and subtracts exactly where floats would not', () => {
    expect(add(USD('0.10'), USD('0.20'))).toEqual({ amount: '0.30', currency: 'USD' });
    expect(add(USD('1234567890123456789.99'), USD('0.01'))).toEqual({
      amount: '1234567890123456790.00',
      currency: 'USD',
    });
    expect(subtract(USD('0.30'), USD('0.10'))).toEqual({ amount: '0.20', currency: 'USD' });
    expect(subtract(USD('1.00'), USD('2.50'))).toEqual({ amount: '-1.50', currency: 'USD' });
    expect(add(money('1', 'JPY'), money('2', 'JPY'))).toEqual({ amount: '3', currency: 'JPY' });
  });

  it('accepts un-normalised operands and never mutates them', () => {
    const a = { amount: '1234.5', currency: 'inr' };
    const b = { amount: 0.5, currency: 'INR' };
    expect(add(a, b)).toEqual({ amount: '1235.00', currency: 'INR' });
    expect(a).toEqual({ amount: '1234.5', currency: 'inr' });
    expect(b).toEqual({ amount: 0.5, currency: 'INR' });
  });

  it('throws ValidationError on currency mismatch', () => {
    const e = expectValidation(() => add(INR('1'), USD('1')), 'currency_mismatch', 'b.currency');
    expect(e.issues[0].params).toEqual({ expected: 'INR', actual: 'USD' });
    expectValidation(() => subtract(INR('1'), USD('1')), 'currency_mismatch', 'b.currency');
    expectValidation(
      () => sum([INR('1'), INR('2'), USD('1')]),
      'currency_mismatch',
      'list[2].currency'
    );
    expectValidation(() => sum([INR('1')], 'USD'), 'currency_mismatch', 'list[0].currency');
  });

  it('rejects invalid operands', () => {
    expectValidation(() => add(INR('1'), null), 'invalid_type', 'b');
    expectValidation(() => add('1', INR('1')), 'invalid_type', 'a');
    expectValidation(() => subtract(INR('1'), { amount: '1' }), 'invalid_currency', 'b.currency');
    expectValidation(() => negate({ amount: 'x', currency: 'INR' }), 'invalid_format');
  });

  it('multiplies exactly then rounds half away from zero', () => {
    expect(multiply(INR('10.01'), 3)).toEqual({ amount: '30.03', currency: 'INR' });
    expect(multiply(INR('100.00'), 0.18)).toEqual({ amount: '18.00', currency: 'INR' });
    expect(multiply(USD('0.05'), 0.5)).toEqual({ amount: '0.03', currency: 'USD' });
    expect(multiply(USD('-0.05'), 0.5)).toEqual({ amount: '-0.03', currency: 'USD' });
    expect(multiply(USD('0.10'), 3)).toEqual({ amount: '0.30', currency: 'USD' });
    expect(multiply(USD('1.10'), 1.1)).toEqual({ amount: '1.21', currency: 'USD' });
    expect(multiply(USD('1.00'), '0.18')).toEqual({ amount: '0.18', currency: 'USD' });
    expect(multiply(USD('1.00'), 2n)).toEqual({ amount: '2.00', currency: 'USD' });
    expect(multiply(USD('1.00'), 0)).toEqual({ amount: '0.00', currency: 'USD' });
    expect(multiply(USD('1.00'), -1)).toEqual({ amount: '-1.00', currency: 'USD' });
    expect(multiply(USD('1.00'), 1e21)).toEqual({
      amount: '1000000000000000000000.00',
      currency: 'USD',
    });
    expect(multiply(USD('3.00'), 1e-7)).toEqual({ amount: '0.00', currency: 'USD' });
    expect(multiply(money('333', 'JPY'), 1.5)).toEqual({ amount: '500', currency: 'JPY' });
    expect(multiply(money('1.005', 'BHD'), 2)).toEqual({ amount: '2.010', currency: 'BHD' });
  });

  it('rejects non-finite or malformed multipliers', () => {
    expectValidation(() => multiply(USD('1'), NaN), 'not_finite', 'n');
    expectValidation(() => multiply(USD('1'), Infinity), 'not_finite', 'n');
    expectValidation(() => multiply(USD('1'), '1,5'), 'invalid_format', 'n');
    expectValidation(() => multiply(USD('1'), undefined), 'required', 'n');
    expectValidation(() => multiply(USD('1'), {}), 'invalid_type', 'n');
  });

  it('sums a list exactly and returns zero of the given currency for an empty list', () => {
    expect(sum([USD('0.10'), USD('0.20'), USD('0.30')])).toEqual({
      amount: '0.60',
      currency: 'USD',
    });
    expect(sum([{ amount: '1', currency: 'inr' }, INR('-0.5')])).toEqual({
      amount: '0.50',
      currency: 'INR',
    });
    expect(sum([INR('1')])).toEqual({ amount: '1.00', currency: 'INR' });
    expect(sum([INR('1'), INR('2')], 'INR')).toEqual({ amount: '3.00', currency: 'INR' });
    expect(sum([], 'INR')).toEqual({ amount: '0.00', currency: 'INR' });
    expect(sum([], 'jpy')).toEqual({ amount: '0', currency: 'JPY' });
  });

  it('rejects an empty list without a currency and non-arrays', () => {
    expectValidation(() => sum([]), 'empty', 'list');
    expectValidation(() => sum(null), 'invalid_type', 'list');
    expectValidation(() => sum(INR('1')), 'invalid_type', 'list');
    expectValidation(() => sum([INR('1'), 'x']), 'invalid_type', 'list[1]');
    expectValidation(() => sum([], 'IN'), 'invalid_currency', 'currency');
  });

  it('negates and keeps zero positive', () => {
    expect(negate(INR('1234.50'))).toEqual({ amount: '-1234.50', currency: 'INR' });
    expect(negate(INR('-1234.50'))).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(negate(INR('0'))).toEqual({ amount: '0.00', currency: 'INR' });
    expect(negate({ amount: '0.001', currency: 'USD' })).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
  });
});

describe('compare() / isZero() / isNegative() / min() / max()', () => {
  it('compares by value', () => {
    expect(compare(INR('1.00'), { amount: '1', currency: 'INR' })).toBe(0);
    expect(compare(INR('1.00'), INR('1.01'))).toBe(-1);
    expect(compare(INR('1.01'), INR('1.00'))).toBe(1);
    expect(compare(INR('-1'), INR('-2'))).toBe(1);
    expect(compare({ amount: '1.005', currency: 'USD' }, USD('1.01'))).toBe(0);
    expectValidation(() => compare(INR('1'), USD('1')), 'currency_mismatch', 'b.currency');
    expectValidation(() => compare(INR('1'), undefined), 'invalid_type', 'b');
  });

  it('isZero / isNegative work at the currency precision', () => {
    expect(isZero(INR('0'))).toBe(true);
    expect(isZero(INR('0.00'))).toBe(true);
    expect(isZero({ amount: '-0.001', currency: 'USD' })).toBe(true);
    expect(isZero(INR('0.01'))).toBe(false);
    expect(isNegative(INR('-0.01'))).toBe(true);
    expect(isNegative(INR('0'))).toBe(false);
    expect(isNegative({ amount: '-0.004', currency: 'USD' })).toBe(false);
    expect(isNegative(INR('5'))).toBe(false);
    expectValidation(() => isZero(null), 'invalid_type', 'money');
    expectValidation(() => isNegative({ amount: '1' }), 'invalid_currency', 'money.currency');
  });

  it('min / max return the original item, first one on ties', () => {
    const a = INR('10');
    const b = { amount: '5', currency: 'inr' };
    const c = INR('5.00');
    const d = INR('20');
    expect(min([a, b, c, d])).toBe(b);
    expect(max([a, b, c, d])).toBe(d);
    expect(min([a])).toBe(a);
    expect(max([a, INR('10.00')])).toBe(a);
    expect(min([INR('-1'), INR('-2')])).toEqual(INR('-2'));
  });

  it('min / max reject empty lists, mismatches and invalid items', () => {
    expectValidation(() => min([]), 'empty', 'list');
    expectValidation(() => max([]), 'empty', 'list');
    expectValidation(() => min(null), 'invalid_type', 'list');
    expectValidation(() => max('x'), 'invalid_type', 'list');
    expectValidation(() => min([INR('1'), USD('1')]), 'currency_mismatch', 'list[1].currency');
    expectValidation(() => max([INR('1'), 7]), 'invalid_type', 'list[1]');
  });
});

describe('allocate()', () => {
  const total = (parts) => sum(parts);

  it('splits by ratio and always sums back to the input (largest remainder)', () => {
    expect(allocate(INR('100.00'), [1, 1, 1]).map((m) => m.amount)).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ]);
    expect(allocate(USD('0.05'), [70, 30]).map((m) => m.amount)).toEqual(['0.04', '0.01']);
    expect(allocate(USD('100.01'), [0.5, 0.25, 0.25]).map((m) => m.amount)).toEqual([
      '50.01',
      '25.00',
      '25.00',
    ]);
    expect(allocate(money('1000', 'JPY'), [1, 2]).map((m) => m.amount)).toEqual(['333', '667']);
    expect(allocate(money('1.000', 'BHD'), [1, 1, 1]).map((m) => m.amount)).toEqual([
      '0.334',
      '0.333',
      '0.333',
    ]);
    expect(allocate(INR('99.99'), [1]).map((m) => m.amount)).toEqual(['99.99']);
  });

  it('gives zero ratios nothing and never hands them a remainder', () => {
    expect(allocate(USD('0.03'), [1, 0, 1]).map((m) => m.amount)).toEqual(['0.02', '0.00', '0.01']);
    expect(allocate(USD('0.01'), [0, 0, 1]).map((m) => m.amount)).toEqual(['0.00', '0.00', '0.01']);
  });

  it('splits negative amounts symmetrically', () => {
    expect(allocate(INR('-100.00'), [1, 1, 1]).map((m) => m.amount)).toEqual([
      '-33.34',
      '-33.33',
      '-33.33',
    ]);
    expect(allocate(USD('-0.05'), [70, 30]).map((m) => m.amount)).toEqual(['-0.04', '-0.01']);
  });

  it('splits zero into zeros', () => {
    expect(allocate(INR('0'), [3, 2]).map((m) => m.amount)).toEqual(['0.00', '0.00']);
  });

  it('accepts a positive integer count for an equal split', () => {
    expect(allocate(INR('100.00'), 3)).toEqual(allocate(INR('100.00'), [1, 1, 1]));
    expect(allocate(INR('10.00'), 1)).toEqual([INR('10.00')]);
  });

  it('returns normalised Money in the input currency', () => {
    const parts = allocate({ amount: '100', currency: 'inr' }, [2, 3]);
    expect(parts).toEqual([
      { amount: '40.00', currency: 'INR' },
      { amount: '60.00', currency: 'INR' },
    ]);
  });

  it('conserves the total and stays within one minor unit of the exact share (randomised)', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 300; round++) {
      const minor = BigInt(Math.floor(rand() * 10_000_000)) - 5_000_000n;
      const m = fromMinor(minor, 'INR');
      const n = 1 + Math.floor(rand() * 7);
      const ratios = Array.from({ length: n }, () => Math.floor(rand() * 1000) / 10);
      if (ratios.every((r) => r === 0)) ratios[0] = 1;
      const parts = allocate(m, ratios);
      expect(parts).toHaveLength(n);
      expect(toMinor(total(parts))).toBe(minor);
      const weight = ratios.reduce((s, r) => s + r, 0);
      parts.forEach((p, i) => {
        const exact = (Number(minor) * ratios[i]) / weight;
        expect(Math.abs(Number(toMinor(p)) - exact)).toBeLessThan(1 + 1e-6);
        if (ratios[i] === 0) expect(toMinor(p)).toBe(0n);
      });
    }
  });

  it('rejects invalid ratios', () => {
    expectValidation(() => allocate(INR('1'), []), 'invalid_type', 'ratios');
    expectValidation(() => allocate(INR('1'), [0, 0]), 'min', 'ratios');
    expectValidation(() => allocate(INR('1'), [-1, 2]), 'invalid_ratio', 'ratios[0]');
    expectValidation(() => allocate(INR('1'), [1, NaN]), 'invalid_ratio', 'ratios[1]');
    expectValidation(() => allocate(INR('1'), [1, Infinity]), 'invalid_ratio', 'ratios[1]');
    expectValidation(() => allocate(INR('1'), ['1', 2]), 'invalid_ratio', 'ratios[0]');
    expectValidation(() => allocate(INR('1'), 0), 'invalid_type', 'ratios');
    expectValidation(() => allocate(INR('1'), 2.5), 'invalid_type', 'ratios');
    expectValidation(() => allocate(INR('1'), -2), 'invalid_type', 'ratios');
    expectValidation(() => allocate(INR('1'), undefined), 'invalid_type', 'ratios');
    expectValidation(() => allocate(INR('1'), 'x'), 'invalid_type', 'ratios');
    expectValidation(() => allocate(null, [1]), 'invalid_type', 'money');
  });
});

describe('convert()', () => {
  it('converts through a base-relative table in both directions', () => {
    const rates = { USD: 1, INR: 83.25, EUR: 0.92 };
    expect(convert(USD('100.00'), 'INR', rates)).toEqual({ amount: '8325.00', currency: 'INR' });
    expect(convert(INR('8325.00'), 'USD', rates)).toEqual({ amount: '100.00', currency: 'USD' });
    expect(convert(INR('100.00'), 'EUR', rates)).toEqual({ amount: '1.11', currency: 'EUR' });
    expect(convert(USD('100.00'), 'inr', rates).currency).toBe('INR');
  });

  it('treats an omitted base as rate 1', () => {
    expect(convert(USD('100.00'), 'INR', { INR: 83.25 })).toEqual({
      amount: '8325.00',
      currency: 'INR',
    });
    expect(convert(INR('100.00'), 'USD', { INR: 83.25 })).toEqual({
      amount: '1.20',
      currency: 'USD',
    });
    expect(convert(INR('100.00'), 'USD', { INR: '83.25' })).toEqual({
      amount: '1.20',
      currency: 'USD',
    });
  });

  it('accepts pair keys (and inverts the reverse pair) and nested tables', () => {
    for (const key of ['USDINR', 'USD_INR', 'USD/INR', 'USD-INR']) {
      expect(convert(USD('2.00'), 'INR', { [key]: 83.25 }), key).toEqual({
        amount: '166.50',
        currency: 'INR',
      });
    }
    expect(convert(INR('166.50'), 'USD', { USD_INR: 83.25 })).toEqual({
      amount: '2.00',
      currency: 'USD',
    });
    expect(convert(USD('2.00'), 'INR', { USD: { INR: 83.25 } })).toEqual({
      amount: '166.50',
      currency: 'INR',
    });
    expect(convert(USD('100.00'), 'INR', { INR: { USD: 0.012 } })).toEqual({
      amount: '8333.33',
      currency: 'INR',
    });
  });

  it('is exact on the decimal digits where float arithmetic would round the wrong way', () => {
    // 100 × 1.005 = 100.5 exactly → 101; in floats 100 * 1.005 === 100.49999999999999.
    expect(100 * 1.005).toBeLessThan(100.5);
    expect(convert(USD('100.00'), 'JPY', { USD_JPY: 1.005 })).toEqual({
      amount: '101',
      currency: 'JPY',
    });
    expect(convert(USD('0.57'), 'INR', { INR: 100 })).toEqual({ amount: '57.00', currency: 'INR' });
    expect(convert(USD('12345678901234567890.00'), 'INR', { INR: 83.25 })).toEqual({
      amount: '1027777768527777776842.50',
      currency: 'INR',
    });
  });

  it('rounds to the target currency decimals, or to options.round places', () => {
    expect(convert(USD('1.00'), 'BHD', { BHD: 0.376 })).toEqual({
      amount: '0.376',
      currency: 'BHD',
    });
    expect(convert(USD('1.00'), 'JPY', { JPY: 149.5 })).toEqual({ amount: '150', currency: 'JPY' });
    expect(convert(USD('100.50'), 'INR', { INR: 83.25 }, { round: 0 })).toEqual({
      amount: '8367.00',
      currency: 'INR',
    });
    expect(convert(USD('100.50'), 'INR', { INR: 83.25 }, { round: 1 })).toEqual({
      amount: '8366.60',
      currency: 'INR',
    });
    expect(convert(USD('100.50'), 'INR', { INR: 83.25 }, { round: 'auto' })).toEqual({
      amount: '8366.63',
      currency: 'INR',
    });
    expect(convert(USD('100.50'), 'INR', { INR: 83.25 }, { round: 5 })).toEqual({
      amount: '8366.63',
      currency: 'INR',
    });
    expect(convert(USD('100.50'), 'INR', { INR: 83.25 }, undefined)).toEqual({
      amount: '8366.63',
      currency: 'INR',
    });
  });

  it('returns a normalised copy for the same currency (still honouring round)', () => {
    const m = { amount: '1234.5', currency: 'inr' };
    expect(convert(m, 'INR', {})).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(convert(m, 'INR', undefined)).toEqual({ amount: '1234.50', currency: 'INR' });
    expect(convert(m, 'INR', {}, { round: 0 })).toEqual({ amount: '1235.00', currency: 'INR' });
    expect(convert(m, 'INR', {})).not.toBe(m);
  });

  it('rejects missing or non-positive rates and bad options', () => {
    expectValidation(() => convert(USD('1'), 'INR', {}), 'rate_missing', 'rates');
    expectValidation(() => convert(USD('1'), 'INR', { EUR: 0.9 }), 'rate_missing', 'rates');
    expectValidation(() => convert(USD('1'), 'INR', null), 'invalid_type', 'rates');
    expectValidation(() => convert(USD('1'), 'INR', 83.25), 'invalid_type', 'rates');
    expectValidation(() => convert(USD('1'), 'INR', { INR: 0 }), 'invalid_rate', 'rates.INR');
    expectValidation(() => convert(USD('1'), 'INR', { INR: -1 }), 'invalid_rate', 'rates.INR');
    expectValidation(() => convert(USD('1'), 'INR', { INR: NaN }), 'not_finite', 'rates.INR');
    expectValidation(() => convert(USD('1'), 'INR', { USD_INR: 'x' }), 'invalid_format');
    expectValidation(
      () => convert(USD('1'), 'INR', { USD: 0, INR: 83 }),
      'invalid_rate',
      'rates.USD'
    );
    expectValidation(() => convert(USD('1'), 'IN', { INR: 83 }), 'invalid_currency', 'to');
    expectValidation(() => convert(USD('1'), 'INR', { INR: 83 }, { round: -1 }), 'invalid_enum');
    expectValidation(() => convert(USD('1'), 'INR', { INR: 83 }, { round: 1.5 }), 'invalid_enum');
    expectValidation(() => convert(USD('1'), 'INR', { INR: 83 }, { round: 'x' }), 'invalid_enum');
    expectValidation(() => convert('1', 'INR', { INR: 83 }), 'invalid_type', 'money');
  });
});

describe('currencyInfo()', () => {
  it('returns decimals, symbol and name', () => {
    expect(currencyInfo('INR')).toEqual({
      code: 'INR',
      name: 'Indian Rupee',
      symbol: '₹',
      decimals: 2,
    });
    expect(currencyInfo('jpy')).toEqual({
      code: 'JPY',
      name: 'Japanese Yen',
      symbol: '¥',
      decimals: 0,
    });
    expect(currencyInfo('BHD')).toMatchObject({ code: 'BHD', decimals: 3 });
    expect(currencyInfo('KWD').decimals).toBe(3);
    expect(currencyInfo('CLF').decimals).toBe(4);
    expect(currencyInfo('USD')).toMatchObject({ symbol: '$', decimals: 2 });
    expect(currencyInfo('EUR')).toMatchObject({ symbol: '€', name: 'Euro' });
    expect(currencyInfo('CAD').symbol).toBe('CA$');
  });

  it('does not throw for an unknown but well-formed code', () => {
    const info = currencyInfo('ZZZ');
    expect(info.code).toBe('ZZZ');
    expect(info.decimals).toBe(2);
    expect(typeof info.symbol).toBe('string');
    expect(info.symbol.length).toBeGreaterThan(0);
    expect(typeof info.name).toBe('string');
    expect(info.name.length).toBeGreaterThan(0);
  });

  it('localises the name through Intl.DisplayNames when a locale is given', () => {
    const en = currencyInfo('INR', { locale: 'en' });
    const de = currencyInfo('INR', { locale: 'de' });
    expect(en.name).toBe('Indian Rupee');
    expect(typeof de.name).toBe('string');
    expect(de.symbol).toBe('₹');
  });

  it('falls back to the built-in tables without Intl', () => {
    vi.stubGlobal('Intl', undefined);
    expect(currencyInfo('INR')).toEqual({
      code: 'INR',
      name: 'Indian Rupee',
      symbol: '₹',
      decimals: 2,
    });
    expect(currencyInfo('OMR')).toEqual({
      code: 'OMR',
      name: 'Omani Rial',
      symbol: 'OMR',
      decimals: 3,
    });
    expect(currencyInfo('ZZZ')).toEqual({ code: 'ZZZ', name: 'ZZZ', symbol: 'ZZZ', decimals: 2 });
  });

  it('survives an Intl that throws', () => {
    vi.stubGlobal('Intl', {
      NumberFormat: class {
        constructor() {
          throw new RangeError('nope');
        }
      },
      DisplayNames: class {
        constructor() {
          throw new RangeError('nope');
        }
      },
    });
    expect(currencyInfo('XTS')).toEqual({ code: 'XTS', name: 'XTS', symbol: 'XTS', decimals: 2 });
    expect(currencyInfo('INR').symbol).toBe('₹');
  });

  it('rejects malformed codes', () => {
    expectValidation(() => currencyInfo('IN'), 'invalid_currency', 'code');
    expectValidation(() => currencyInfo(''), 'invalid_currency', 'code');
    expectValidation(() => currencyInfo(undefined), 'invalid_currency', 'code');
    expectValidation(() => currencyInfo('₹'), 'invalid_currency', 'code');
  });
});

describe('pricePerPax()', () => {
  it('divides by paying passengers, excluding lap infants by default', () => {
    const pax = { adults: 2, children: 1, infants: 1 };
    expect(pricePerPax(INR('300.00'), pax)).toEqual({ amount: '100.00', currency: 'INR' });
    expect(pricePerPax(INR('300.00'), pax, { includeInfants: true })).toEqual({
      amount: '75.00',
      currency: 'INR',
    });
    expect(
      pricePerPax(INR('300.00'), { adults: 1, children: 0, infants: 0, infantsSeated: 1 })
    ).toEqual({ amount: '150.00', currency: 'INR' });
    expect(
      pricePerPax(INR('500.00'), { adults: 1, children: 1, infants: 2, youth: 1, seniors: 2 })
    ).toEqual({ amount: '100.00', currency: 'INR' });
    expect(pricePerPax(INR('100.00'), { adults: 1 })).toEqual({
      amount: '100.00',
      currency: 'INR',
    });
  });

  it('rounds half away from zero to the currency decimals', () => {
    expect(pricePerPax(INR('100.00'), { adults: 3, children: 0, infants: 0 })).toEqual({
      amount: '33.33',
      currency: 'INR',
    });
    expect(pricePerPax(INR('200.00'), { adults: 3, children: 0, infants: 0 })).toEqual({
      amount: '66.67',
      currency: 'INR',
    });
    expect(pricePerPax(INR('0.05'), { adults: 2, children: 0, infants: 0 })).toEqual({
      amount: '0.03',
      currency: 'INR',
    });
    expect(pricePerPax(money('1000', 'JPY'), { adults: 3, children: 0, infants: 0 })).toEqual({
      amount: '333',
      currency: 'JPY',
    });
    expect(pricePerPax(INR('-100.00'), { adults: 3, children: 0, infants: 0 })).toEqual({
      amount: '-33.33',
      currency: 'INR',
    });
  });

  it('rejects zero paying passengers and malformed counts', () => {
    expectValidation(
      () => pricePerPax(INR('1'), { adults: 0, children: 0, infants: 1 }),
      'min',
      'pax'
    );
    expectValidation(() => pricePerPax(INR('1'), {}), 'min', 'pax');
    expectValidation(() => pricePerPax(INR('1'), null), 'invalid_type', 'pax');
    expectValidation(() => pricePerPax(INR('1'), 3), 'invalid_type', 'pax');
    expectValidation(() => pricePerPax(INR('1'), { adults: -1 }), 'invalid_type', 'pax.adults');
    expectValidation(() => pricePerPax(INR('1'), { adults: 1.5 }), 'invalid_type', 'pax.adults');
    expectValidation(() => pricePerPax(INR('1'), { adults: '2' }), 'invalid_type', 'pax.adults');
    expectValidation(
      () => pricePerPax(INR('1'), { adults: 1, infants: -1 }),
      'invalid_type',
      'pax.infants'
    );
    expectValidation(() => pricePerPax(null, { adults: 1 }), 'invalid_type', 'total');
  });
});

describe('formatMoney() with Intl', () => {
  it('formats with per-currency decimals and locale rules', () => {
    expect(formatMoney(INR('1234.5'), { locale: 'en-IN' })).toBe('₹1,234.50');
    expect(formatMoney(INR('1234567.5'), { locale: 'en-IN' })).toBe('₹12,34,567.50');
    expect(formatMoney(USD('1234.5'), { locale: 'en-US' })).toBe('$1,234.50');
    expect(formatMoney(money('1234', 'JPY'), { locale: 'en-US' })).toBe('¥1,234');
    expect(plain(formatMoney(money('1.235', 'BHD'), { locale: 'en-US' }))).toBe('BHD 1.235');
    expect(plain(formatMoney(money('1234.5', 'EUR'), { locale: 'de-DE' }))).toBe('1.234,50 €');
    expect(formatMoney(USD('-1234.5'), { locale: 'en-US' })).toBe('-$1,234.50');
    expect(formatMoney(USD('0'), { locale: 'en-US' })).toBe('$0.00');
  });

  it('normalises the amount before formatting', () => {
    expect(formatMoney({ amount: '1234.5', currency: 'inr' }, { locale: 'en-IN' })).toBe(
      '₹1,234.50'
    );
    expect(formatMoney({ amount: 1.005, currency: 'USD' }, { locale: 'en-US' })).toBe('$1.01');
    expect(formatMoney({ amount: '-0.001', currency: 'USD' }, { locale: 'en-US' })).toBe('$0.00');
  });

  it('honours display, fraction and signDisplay', () => {
    expect(plain(formatMoney(USD('1234.5'), { locale: 'en-US', display: 'code' }))).toBe(
      'USD 1,234.50'
    );
    expect(formatMoney(money('1234.5', 'CAD'), { locale: 'en-US', display: 'symbol' })).toBe(
      'CA$1,234.50'
    );
    expect(formatMoney(money('1234.5', 'CAD'), { locale: 'en-US', display: 'narrow' })).toBe(
      '$1,234.50'
    );
    expect(formatMoney(USD('1234.5'), { locale: 'en-US', fraction: 0 })).toBe('$1,235');
    expect(formatMoney(USD('1234.4'), { locale: 'en-US', fraction: 0 })).toBe('$1,234');
    expect(formatMoney(USD('1234.5'), { locale: 'en-US', fraction: 'auto' })).toBe('$1,234.50');
    expect(formatMoney(money('1234', 'JPY'), { locale: 'en-US', fraction: 2 })).toBe('¥1,234.00');
    expect(formatMoney(USD('1234.5'), { locale: 'en-US', signDisplay: 'always' })).toBe(
      '+$1,234.50'
    );
    expect(formatMoney(USD('-1234.5'), { locale: 'en-US', signDisplay: 'never' })).toBe(
      '$1,234.50'
    );
    expect(formatMoney(USD('0'), { locale: 'en-US', signDisplay: 'exceptZero' })).toBe('$0.00');
    expect(formatMoney(USD('1'), { locale: 'en-US', signDisplay: 'exceptZero' })).toBe('+$1.00');
    expect(formatMoney(USD('-1'), { locale: 'en-US', signDisplay: 'negative' })).toBe('-$1.00');
    expect(formatMoney(USD('1234.5'), { locale: ['xx-ZZ', 'en-US'] })).toBe('$1,234.50');
  });

  it('formats big amounts exactly (the amount is passed as a decimal string)', () => {
    expect(formatMoney(USD('12345678901234567890.12'), { locale: 'en-US' })).toBe(
      '$12,345,678,901,234,567,890.12'
    );
  });

  it('does not throw for a currency Intl does not know', () => {
    const s = formatMoney(money('1234.56', 'XTS'), { locale: 'en-US' });
    expect(s).toContain('1,234.56');
    expect(s).toContain('XTS');
    expect(plain(formatMoney(money('1', 'ZZZ'), { locale: 'en-US', fraction: 3 }))).toBe(
      'ZZZ 1.000'
    );
  });

  it('falls back to the runtime locale when the given one is invalid', () => {
    const s = formatMoney(USD('1234.5'), { locale: 'not a locale !!' });
    expect(s).toContain('1');
    expect(s).toContain('234');
  });

  it('reuses Intl.NumberFormat instances for the same locale and options', () => {
    let constructed = 0;
    const Real = RealIntl.NumberFormat;
    vi.stubGlobal('Intl', {
      NumberFormat: class extends Real {
        constructor(...args) {
          super(...args);
          constructed++;
        }
      },
    });
    for (let i = 0; i < 25; i++) {
      expect(formatMoney(INR(String(i)), { locale: 'en-IN' })).toBe(`₹${i}.00`);
    }
    expect(constructed).toBe(1);
    formatMoney(INR('1'), { locale: 'en-IN', display: 'code' });
    expect(constructed).toBe(2);
  });

  it('rejects invalid money and options', () => {
    expectValidation(() => formatMoney(null), 'invalid_type', 'money');
    expectValidation(() => formatMoney({ amount: 'x', currency: 'INR' }), 'invalid_format');
    expectValidation(
      () => formatMoney(INR('1'), { display: 'bogus' }),
      'invalid_enum',
      'options.display'
    );
    expectValidation(
      () => formatMoney(INR('1'), { fraction: -1 }),
      'invalid_enum',
      'options.fraction'
    );
    expectValidation(
      () => formatMoney(INR('1'), { fraction: 1.5 }),
      'invalid_enum',
      'options.fraction'
    );
    expectValidation(
      () => formatMoney(INR('1'), { fraction: 21 }),
      'invalid_enum',
      'options.fraction'
    );
    expectValidation(
      () => formatMoney(INR('1'), { fraction: 'x' }),
      'invalid_enum',
      'options.fraction'
    );
    expectValidation(
      () => formatMoney(INR('1'), { signDisplay: 'maybe' }),
      'invalid_enum',
      'options.signDisplay'
    );
    expectValidation(() => formatMoney(INR('1'), { locale: 42 }), 'invalid_type', 'options.locale');
    expectValidation(
      () => formatMoney(INR('1'), { locale: ['en', 7] }),
      'invalid_type',
      'options.locale'
    );
  });
});

describe('formatMoney() fallback (no usable Intl)', () => {
  it('formats with the symbol table, grouping and per-currency decimals when Intl is missing', () => {
    vi.stubGlobal('Intl', undefined);
    expect(formatMoney(INR('1234.5'))).toBe('₹1,234.50');
    expect(formatMoney(INR('1234567.5'), { locale: 'en-IN' })).toBe('₹1,234,567.50');
    expect(formatMoney(USD('-1234.5'))).toBe('-$1,234.50');
    expect(plain(formatMoney(USD('-1234.5'), { display: 'code' }))).toBe('-USD 1,234.50');
    expect(formatMoney(money('1234', 'JPY'))).toBe('¥1,234');
    expect(plain(formatMoney(money('1.235', 'BHD')))).toBe('BHD 1.235');
    expect(plain(formatMoney(money('1234.56', 'XTS')))).toBe('XTS 1,234.56');
    expect(plain(formatMoney(money('1234.5', 'SEK')))).toBe('kr 1,234.50');
    expect(formatMoney(money('1234.5', 'CAD'), { display: 'narrow' })).toBe('CA$1,234.50');
    expect(formatMoney(USD('0.05'))).toBe('$0.05');
    expect(formatMoney(USD('0'))).toBe('$0.00');
    expect(formatMoney(USD('999'))).toBe('$999.00');
    expect(formatMoney(USD('1000'))).toBe('$1,000.00');
    expect(formatMoney(USD('12345678901234567890.12'))).toBe('$12,345,678,901,234,567,890.12');
  });

  it('honours fraction and signDisplay in the fallback', () => {
    vi.stubGlobal('Intl', undefined);
    expect(formatMoney(INR('1234.5'), { fraction: 0 })).toBe('₹1,235');
    expect(formatMoney(INR('-1234.5'), { fraction: 0 })).toBe('-₹1,235');
    expect(formatMoney(INR('1234.4'), { fraction: 0 })).toBe('₹1,234');
    expect(formatMoney(money('1234', 'JPY'), { fraction: 2 })).toBe('¥1,234.00');
    expect(formatMoney(INR('1.5'), { fraction: 1 })).toBe('₹1.5');
    expect(formatMoney(INR('1234.5'), { signDisplay: 'always' })).toBe('+₹1,234.50');
    expect(formatMoney(INR('-1234.5'), { signDisplay: 'always' })).toBe('-₹1,234.50');
    expect(formatMoney(INR('-1234.5'), { signDisplay: 'never' })).toBe('₹1,234.50');
    expect(formatMoney(INR('0'), { signDisplay: 'exceptZero' })).toBe('₹0.00');
    expect(formatMoney(INR('1'), { signDisplay: 'exceptZero' })).toBe('+₹1.00');
    expect(formatMoney(INR('-1'), { signDisplay: 'exceptZero' })).toBe('-₹1.00');
    expect(formatMoney(INR('-1'), { signDisplay: 'negative' })).toBe('-₹1.00');
    expect(formatMoney(INR('1'), { signDisplay: 'negative' })).toBe('₹1.00');
    expect(formatMoney(INR('-0.004'), { fraction: 2 })).toBe('₹0.00');
  });

  it('falls back when Intl.NumberFormat rejects the currency', () => {
    vi.stubGlobal('Intl', {
      NumberFormat: class {
        constructor() {
          throw new RangeError('Invalid currency code');
        }
      },
    });
    expect(formatMoney(INR('1234.5'), { locale: 'en-IN' })).toBe('₹1,234.50');
    expect(plain(formatMoney(money('1', 'XTS'), { locale: 'en-IN', display: 'code' }))).toBe(
      'XTS 1.00'
    );
  });

  it('falls back when the formatter throws at format time', () => {
    vi.stubGlobal('Intl', {
      NumberFormat: class {
        format() {
          throw new TypeError('boom');
        }
      },
    });
    expect(formatMoney(USD('1234.5'), { locale: 'en-US' })).toBe('$1,234.50');
  });

  it('downgrades narrowSymbol to symbol when the engine does not support it', () => {
    const Real = RealIntl.NumberFormat;
    const seen = [];
    vi.stubGlobal('Intl', {
      NumberFormat: class extends Real {
        constructor(locale, opts) {
          seen.push(opts.currencyDisplay);
          if (opts.currencyDisplay === 'narrowSymbol') throw new RangeError('unsupported');
          super(locale, opts);
        }
      },
    });
    expect(formatMoney(money('1234.5', 'CAD'), { locale: 'en-US', display: 'narrow' })).toBe(
      'CA$1,234.50'
    );
    expect(seen).toEqual(['narrowSymbol', 'symbol']);
  });

  it('falls back when Intl.NumberFormat is not a constructor', () => {
    vi.stubGlobal('Intl', { NumberFormat: 'nope' });
    expect(formatMoney(INR('1'))).toBe('₹1.00');
    vi.stubGlobal('Intl', {});
    expect(formatMoney(INR('1'))).toBe('₹1.00');
  });

  it('does not serve a formatter cached for a different Intl', () => {
    expect(formatMoney(INR('1234.5'), { locale: 'en-IN' })).toBe('₹1,234.50');
    vi.stubGlobal('Intl', undefined);
    expect(formatMoney(INR('1234567.5'), { locale: 'en-IN' })).toBe('₹1,234,567.50');
    vi.unstubAllGlobals();
    expect(formatMoney(INR('1234567.5'), { locale: 'en-IN' })).toBe('₹12,34,567.50');
  });
});

describe('purity and SSR safety', () => {
  it('returns fresh plain objects and never mutates inputs', () => {
    const m = Object.freeze({ amount: '1234.5', currency: 'inr' });
    expect(() => add(m, m)).not.toThrow();
    expect(() => allocate(m, [1, 2])).not.toThrow();
    expect(() => formatMoney(m, { locale: 'en-IN' })).not.toThrow();
    expect(() => convert(m, 'USD', { INR: 83 })).not.toThrow();
    const out = negate(m);
    expect(out).not.toBe(m);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(m).toEqual({ amount: '1234.5', currency: 'inr' });
  });

  it('never throws a plain Error for bad input', () => {
    const calls = [
      () => money(),
      () => parseMoney(),
      () => formatMoney(),
      () => toMinor(),
      () => fromMinor(),
      () => add(),
      () => subtract(),
      () => multiply(),
      () => sum(),
      () => negate(),
      () => compare(),
      () => isZero(),
      () => isNegative(),
      () => min(),
      () => max(),
      () => allocate(),
      () => convert(),
      () => currencyInfo(),
      () => pricePerPax(),
    ];
    for (const fn of calls) {
      let caught;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ValidationError);
    }
  });

  it('does not touch the DOM or storage at import or call time', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof localStorage).toBe('undefined');
    expect(formatMoney(INR('1'), { locale: 'en-IN' })).toBe('₹1.00');
    expect(currencyInfo('INR').symbol).toBe('₹');
  });
});
