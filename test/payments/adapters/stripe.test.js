import { describe, it, expect } from 'vitest';
import { stripeAdapter } from '../../../src/payments/adapters/stripe.js';
import { UnsupportedError } from '../../../src/errors/index.js';

describe('payments/adapters/stripe.js placeholder', () => {
  it('exports stripeAdapter, which throws UnsupportedError until the adapter exists', () => {
    expect(typeof stripeAdapter).toBe('function');
    let caught;
    try {
      stripeAdapter({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    expect(caught.feature).toBe('payments.stripe');
  });
});
