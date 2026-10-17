import { describe, it, expect } from 'vitest';
import { validateAgainst, loadSpec, danglingRefs } from './swagger.js';

describe('swagger helper', () => {
  it('loads a spec by prefix and validates a minimal FlightOffer', () => {
    const spec = loadSpec('FlightOffersSearch');
    expect(spec.definitions.FlightOffer).toBeTruthy();
    const { valid } = validateAgainst('FlightOffersSearch', 'FlightOffer', { type: 'flight-offer', id: '1' });
    expect(valid).toBe(true);
  });
  it('reports the dangling refs the Amadeus files are known to contain', () => {
    expect(danglingRefs('FlightOffersSearch')).toContain('commissionValue');
  });
  it('rejects a wrong type', () => {
    const { valid, errors } = validateAgainst('FlightOffersSearch', 'FlightOffer', { type: 'flight-offer', id: 1 });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});
