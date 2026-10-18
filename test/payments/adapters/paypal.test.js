import { describe, it, expect } from 'vitest';
import { paypalAdapter } from '../../../src/payments/adapters/paypal.js';
import { UnsupportedError } from '../../../src/errors/index.js';

describe('payments/adapters/paypal.js placeholder', () => {
  it('exports paypalAdapter, which throws UnsupportedError until the adapter exists', () => {
    expect(typeof paypalAdapter).toBe('function');
    let caught;
    try {
      paypalAdapter({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    expect(caught.feature).toBe('payments.paypal');
  });
});
