import { describe, it, expect } from 'vitest';
import { razorpayAdapter } from '../../../src/payments/adapters/razorpay.js';
import { UnsupportedError } from '../../../src/errors/index.js';

describe('payments/adapters/razorpay.js placeholder', () => {
  it('exports razorpayAdapter, which throws UnsupportedError until the adapter exists', () => {
    expect(typeof razorpayAdapter).toBe('function');
    let caught;
    try {
      razorpayAdapter({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    expect(caught.feature).toBe('payments.razorpay');
  });
});
