import { describe, it, expect } from 'vitest';
import { createPayments } from '../../src/payments/index.js';
import { UnsupportedError } from '../../src/errors/index.js';

describe('payments/index.js placeholder', () => {
  it('exports createPayments, which throws UnsupportedError{feature:"payments"} until the port exists', () => {
    expect(typeof createPayments).toBe('function');
    let caught;
    try {
      createPayments({ gateways: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    expect(caught.feature).toBe('payments');
  });
});
