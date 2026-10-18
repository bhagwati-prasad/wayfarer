// Every Amadeus-shaped fixture in src/mock/fixtures/amadeus/ must validate against the matching
// definition of the swagger file it was taken from (docs/CONTRIBUTING.md §6, BACKEND-MAPPING §6) and
// must be internally consistent in the ways the adapters rely on (ids, totals, dictionaries).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateAgainst, danglingRefs } from '../helpers/swagger.js';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(here, '../../src/mock/fixtures/amadeus');
const load = (name) => JSON.parse(readFileSync(resolve(DIR, name), 'utf8'));
// Each validateAgainst() call compiles the (large) spec; give the heavier fixtures room.
const SLOW = 60_000;

const SEARCH = 'FlightOffersSearch';
const PRICING = 'FlightOffersPrice';
const UPSELL = 'BrandedFaresUpsell';
const AVAILABILITY = 'FlightAvailabilitiesSearch';
const CREATE = 'FlightCreateOrders';
const MANAGEMENT = 'FlightOrderManagement';
const ISSUE = 'FlightOrderIssue';
const BY_REFERENCE = 'GetFlightOrderByRecordLocator';

const FIXTURES = [
  'search-roundtrip.json',
  'search-oneway-out.json',
  'search-oneway-in.json',
  'search-international.json',
  'search-multicity.json',
  'pricing.json',
  'pricing-price-changed.json',
  'upsell.json',
  'availability.json',
  'order-created.json',
  'order-held.json',
  'order-ticketed.json',
  'order-by-reference.json',
  'issuance.json',
];
// errors/<code>-<slug>.json → spec whose operation raises it and the Error_<status> definition.
const ERROR_FIXTURES = {
  '37200-price-discrepancy.json': [CREATE, 'Error_400'],
  '34651-segment-sell-failure.json': [CREATE, 'Error_400'],
  '34107-not-applicable-fare.json': [PRICING, 'Error_400'],
  '4926-invalid-data-received.json': [BY_REFERENCE, 'Error_400'],
  '2668-parameter-combination-invalid.json': [PRICING, 'Error_400'],
  '39397-no-upsell-offers.json': [UPSELL, 'Error_400'],
  '2552-simultaneous-update.json': [MANAGEMENT, 'Error_409'],
  '477-invalid-format.json': [SEARCH, 'Error_400'],
  '9112-ticketing-tkt.json': [ISSUE, 'Error_400'],
  '36870-booking-failed.json': [CREATE, 'Error_400'],
};

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FAMILY = ['1', '2', '3', '4'];
const SOLO = ['1'];

const paise = (amount) => Math.round(Number(amount) * 100);
const sum = (list) => list.reduce((a, b) => a + b, 0);
const uniq = (list) => new Set(list).size === list.length;
const segmentsOf = (offer) => offer.itineraries.flatMap((it) => it.segments);
const segmentIds = (offer) => segmentsOf(offer).map((s) => s.id);
const travelerIds = (offer) => offer.travelerPricings.map((tp) => tp.travelerId);
const fdbsOf = (offer) => offer.travelerPricings.flatMap((tp) => tp.fareDetailsBySegment);

function pointerGet(obj, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => (o == null ? o : o[k]), obj);
}

/**
 * Spec defects the fixtures are told to keep and the adapters to tolerate (BACKEND-MAPPING §4):
 * C-1 — the specs declare `format: date-time` on wall-clock fields (`departure.at`, `arrival.at`,
 *       `stops[].arrivalAt/departureAt`, `lastTicketingDateTime`, `automatedProcess[].dateTime`) that
 *       Amadeus returns as airport-local times WITHOUT an offset; the fixture keeps that wire format
 *       and this test asserts the stricter local pattern instead of RFC 3339.
 * C-35 — `LocationEntry` / `CurrencyEntry` declare a bogus required `key` property that no real
 *       response carries; ignored, the dictionary values are still validated.
 */
function isKnownSpecDefect(error, payload) {
  if (error.keyword === 'format' && error.params.format === 'date-time') {
    const value = pointerGet(payload, error.instancePath);
    return typeof value === 'string' && LOCAL_DATE_TIME.test(value);
  }
  return (
    error.keyword === 'required' &&
    error.params.missingProperty === 'key' &&
    /\/(locations|currencies)$/.test(error.instancePath)
  );
}

function expectMatches(spec, definition, payload, label) {
  const { valid, errors } = validateAgainst(spec, definition, payload);
  const real = valid ? [] : errors.filter((e) => !isKnownSpecDefect(e, payload));
  if (real.length) {
    const lines = real.map(
      (e) => `${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`
    );
    throw new Error(`${label} does not match ${spec}#${definition}:\n${lines.join('\n')}`);
  }
}

function expectDictionaryCovers(dictionaries, offer, label) {
  for (const s of segmentsOf(offer)) {
    expect(dictionaries.locations, `${label} ${s.departure.iataCode}`).toHaveProperty(
      s.departure.iataCode
    );
    expect(dictionaries.locations, `${label} ${s.arrival.iataCode}`).toHaveProperty(
      s.arrival.iataCode
    );
    for (const stop of s.stops || []) expect(dictionaries.locations).toHaveProperty(stop.iataCode);
    if (dictionaries.aircraft) expect(dictionaries.aircraft).toHaveProperty(s.aircraft.code);
    if (dictionaries.carriers) {
      expect(dictionaries.carriers).toHaveProperty(s.carrierCode);
      expect(dictionaries.carriers).toHaveProperty(s.operating.carrierCode);
    }
  }
  if (dictionaries.carriers) {
    for (const c of offer.validatingAirlineCodes) expect(dictionaries.carriers).toHaveProperty(c);
  }
  for (const v of Object.values(dictionaries.locations)) {
    expect(v.cityCode).toMatch(/^[A-Z]{3}$/);
    expect(v.countryCode).toMatch(/^[A-Z]{2}$/);
  }
}

/** Internal consistency of one FlightOffer (search, pricing, upsell or order flavour). */
function checkOffer(offer, label, { slices, travelers } = {}) {
  expect(offer.type).toBe('flight-offer');
  if (slices) expect(offer.itineraries, `${label} slices`).toHaveLength(slices);
  const segIds = segmentIds(offer);
  expect(uniq(segIds), `${label} segment ids unique`).toBe(true);
  for (const s of segmentsOf(offer)) {
    expect(s.departure.at).toMatch(LOCAL_DATE_TIME);
    expect(s.arrival.at).toMatch(LOCAL_DATE_TIME);
    expect(s.numberOfStops).toBe((s.stops || []).length);
    for (const stop of s.stops || []) {
      expect(stop.arrivalAt).toMatch(LOCAL_DATE_TIME);
      expect(stop.departureAt).toMatch(LOCAL_DATE_TIME);
      expect(stop.duration).toMatch(/^PT/);
    }
    expect(s.duration).toMatch(/^PT/);
    expect(s.blacklistedInEU).toBe(false);
    expect(s.co2Emissions.length).toBeGreaterThan(0);
  }
  const ids = travelerIds(offer);
  expect(uniq(ids), `${label} traveler ids unique`).toBe(true);
  if (travelers) expect(ids).toEqual(travelers);
  for (const tp of offer.travelerPricings) {
    const covered = tp.fareDetailsBySegment.map((f) => f.segmentId);
    expect(
      covered.slice().sort(),
      `${label} traveler ${tp.travelerId} covers every segment`
    ).toEqual(segIds.slice().sort());
    for (const f of tp.fareDetailsBySegment) {
      expect(f.class).toMatch(/^[A-Z]$/);
      expect(f.fareBasis).toMatch(/^[A-Z0-9]{1,18}$/);
      expect(f.includedCheckedBags, `${label} includedCheckedBags`).toBeTruthy();
    }
    if (tp.travelerType === 'HELD_INFANT') {
      const adult = offer.travelerPricings.find((t) => t.travelerId === tp.associatedAdultId);
      expect(adult && adult.travelerType, `${label} infant ${tp.travelerId} adult`).toBe('ADULT');
    }
    if (tp.price.taxes) {
      expect(paise(tp.price.base) + sum(tp.price.taxes.map((t) => paise(t.amount)))).toBe(
        paise(tp.price.total)
      );
    } else {
      expect(paise(tp.price.total)).toBeGreaterThan(paise(tp.price.base));
    }
  }
  const totals = offer.travelerPricings.map((tp) => paise(tp.price.total));
  const bases = offer.travelerPricings.map((tp) => paise(tp.price.base));
  expect(paise(offer.price.total), `${label} total = Σ traveler totals`).toBe(sum(totals));
  expect(paise(offer.price.base), `${label} base = Σ traveler bases`).toBe(sum(bases));
  expect(paise(offer.price.grandTotal)).toBeGreaterThanOrEqual(paise(offer.price.total));
  expect(offer.price.currency).toBe('INR');
  expect(offer.numberOfBookableSeats).toBeGreaterThanOrEqual(1);
  expect(offer.numberOfBookableSeats).toBeLessThanOrEqual(9);
  expect(offer.lastTicketingDate).toMatch(DATE);
  expect(offer.pricingOptions.fareType.length).toBeGreaterThan(0);
  expect(offer.validatingAirlineCodes.length).toBeGreaterThan(0);
}

/** Shared checks for a POST /v2/shopping/flight-offers response. */
function checkSearch(name, { slices, travelers }) {
  const fx = load(name);
  fx.data.forEach((o, i) => expectMatches(SEARCH, 'FlightOffer', o, `${name} data[${i}]`));
  expectMatches(SEARCH, 'Collection_Meta', fx.meta, `${name} meta`);
  expectMatches(SEARCH, 'Dictionaries', fx.dictionaries, `${name} dictionaries`);
  (fx.warnings || []).forEach((w, i) =>
    expectMatches(SEARCH, 'Issue', w, `${name} warnings[${i}]`)
  );

  const ids = fx.data.map((o) => o.id);
  expect(uniq(ids)).toBe(true);
  expect(fx.meta.count).toBe(fx.data.length);
  for (const o of fx.data) {
    checkOffer(o, `${name} offer ${o.id}`, { slices: o.oneWay ? 1 : slices, travelers });
    expectDictionaryCovers(fx.dictionaries, o, `${name} offer ${o.id}`);
    expect(paise(o.price.grandTotal)).toBe(paise(o.price.total));
  }
  expect(fx.dictionaries.currencies).toHaveProperty('INR');

  const combined = fx.data.filter((o) => !o.oneWay);
  const oneWay = fx.data.filter((o) => o.oneWay);
  const ods = combined[0].itineraries.map((it) => ({
    from: it.segments[0].departure.iataCode,
    to: it.segments[it.segments.length - 1].arrival.iataCode,
  }));
  if (fx.meta.oneWayCombinations) {
    const referenced = [];
    for (const combo of fx.meta.oneWayCombinations) {
      const od = ods[Number(combo.originDestinationId) - 1];
      expect(od, `${name} originDestinationId ${combo.originDestinationId}`).toBeTruthy();
      expect(combo.flightOfferIds.length).toBeGreaterThan(0);
      for (const id of combo.flightOfferIds) {
        const offer = fx.data.find((o) => o.id === id);
        expect(offer, `${name} oneWayCombinations → offer ${id}`).toBeTruthy();
        expect(offer.oneWay).toBe(true);
        expect(offer.itineraries).toHaveLength(1);
        const segs = offer.itineraries[0].segments;
        expect(segs[0].departure.iataCode).toBe(od.from);
        expect(segs[segs.length - 1].arrival.iataCode).toBe(od.to);
        referenced.push(id);
      }
    }
    expect(uniq(referenced)).toBe(true);
    expect(referenced.slice().sort()).toEqual(oneWay.map((o) => o.id).sort());
  } else {
    expect(oneWay).toHaveLength(0);
  }
  return { fx, combined, oneWay, ods };
}

describe('Amadeus fixtures — files', () => {
  it('ships exactly the documented fixtures, each under 120 KB', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(FIXTURES.slice().sort());
    const errors = readdirSync(resolve(DIR, 'errors')).filter((f) => f.endsWith('.json'));
    expect(errors.sort()).toEqual(Object.keys(ERROR_FIXTURES).sort());
    for (const f of [...files, ...errors.map((e) => `errors/${e}`)]) {
      expect(statSync(resolve(DIR, f)).size, f).toBeLessThan(120 * 1024);
    }
  });

  it('uses schema spellings only, never the examples’ typos (C-35)', () => {
    const typos = [
      'ticketingAggreement',
      'creationDateTime',
      'fareDetailBySegment',
      'classAvailabilities',
      'availabilty',
      'commissionValue',
    ];
    for (const f of FIXTURES) {
      const text = readFileSync(resolve(DIR, f), 'utf8');
      for (const typo of typos) expect(text, `${f} contains ${typo}`).not.toContain(`"${typo}"`);
    }
  });

  it('does not rely on definitions the search spec references but never declares', () => {
    const dangling = danglingRefs(SEARCH);
    expect(dangling).toContain('commissionValue');
    expect(dangling).toContain('LoyaltyProgram');
  });
});

describe('search-roundtrip.json (DEL→BOM→DEL, 2 ADT + 1 CHD + 1 INF, INR)', () => {
  it(
    'validates and is consistent',
    () => {
      const { fx, combined, oneWay, ods } = checkSearch('search-roundtrip.json', {
        slices: 2,
        travelers: FAMILY,
      });
      expect(ods).toEqual([
        { from: 'DEL', to: 'BOM' },
        { from: 'BOM', to: 'DEL' },
      ]);
      expect(combined.length).toBeGreaterThanOrEqual(6);
      expect(oneWay.length).toBeGreaterThanOrEqual(4);
      expect(fx.meta.oneWayCombinations).toHaveLength(2);
      const types = combined[0].travelerPricings.map((tp) => tp.travelerType);
      expect(types).toEqual(['ADULT', 'ADULT', 'CHILD', 'HELD_INFANT']);

      // variety the filters / facets need
      const carriers = new Set(combined.map((o) => o.validatingAirlineCodes[0]));
      expect(carriers.size).toBeGreaterThanOrEqual(4);
      const connections = new Set(combined.map((o) => o.itineraries[0].segments.length));
      expect(connections.size).toBeGreaterThanOrEqual(2);
      const durations = new Set(combined.map((o) => o.itineraries[0].duration));
      expect(durations.size).toBeGreaterThanOrEqual(3);
      const seats = new Set(combined.map((o) => o.numberOfBookableSeats));
      expect(seats.size).toBeGreaterThanOrEqual(3);
      const cabins = new Set(fdbsOf(combined[4]).map((f) => f.cabin));
      expect(cabins).toEqual(new Set(['BUSINESS']));

      // one technical stop, aircraft / carrier / stop airport all resolvable
      const technical = combined.flatMap(segmentsOf).filter((s) => s.numberOfStops > 0);
      expect(technical.length).toBeGreaterThan(0);
      expect(technical[0].stops[0].iataCode).toBe('JAI');
      expect(fx.dictionaries.locations).toHaveProperty('JAI');

      // amenities, baggage, bag offers, fare rules, instant ticketing, CO2
      expect(fdbsOf(combined[0]).some((f) => f.amenities && f.amenities.length)).toBe(true);
      expect(fdbsOf(combined[0]).some((f) => f.includedCabinBags)).toBe(true);
      expect(combined[0].price.additionalServices[0].type).toBe('CHECKED_BAGS');
      expect(fdbsOf(combined[0])[0].additionalServices.chargeableCheckedBags.id).toBe('1');
      expect(combined.some((o) => o.fareRules && o.fareRules.rules.length)).toBe(true);
      expect(combined.some((o) => o.instantTicketingRequired)).toBe(true);
      expect(combined.some((o) => o.pricingOptions.refundableFare)).toBe(true);
      for (const s of combined.flatMap(segmentsOf)) {
        expect(s.co2Emissions[0].weightUnit).toBe('KG');
        expect(Number.isInteger(s.co2Emissions[0].weight)).toBe(true);
      }
      // branded fares on the AI offers only
      const ai = combined.find((o) => o.id === '2');
      expect(fdbsOf(ai).every((f) => f.brandedFare === 'ECOVALUE')).toBe(true);
      expect(fdbsOf(ai)[0].brandedFareLabel).toBe('ECO VALUE');
      // child / infant pricing
      const [adt, , chd, inf] = ai.travelerPricings;
      expect(paise(chd.price.base)).toBeLessThan(paise(adt.price.base));
      expect(paise(inf.price.total)).toBeLessThan(paise(chd.price.total));
    },
    SLOW
  );
});

describe('search-oneway-*.json (fan-out path, C-8)', () => {
  it(
    'out: DEL→BOM, same travelers, no oneWay flags',
    () => {
      const { fx, ods, oneWay } = checkSearch('search-oneway-out.json', {
        slices: 1,
        travelers: FAMILY,
      });
      expect(ods).toEqual([{ from: 'DEL', to: 'BOM' }]);
      expect(oneWay).toHaveLength(0);
      expect(fx.meta.oneWayCombinations).toBeUndefined();
      expect(fx.data.length).toBeGreaterThanOrEqual(5);
      expect(fx.data.some((o) => segmentsOf(o).some((s) => s.numberOfStops > 0))).toBe(true);
      expect(fx.data.some((o) => o.itineraries[0].segments.length === 2)).toBe(true);
    },
    SLOW
  );

  it(
    'in: BOM→DEL on the return date',
    () => {
      const { fx, ods } = checkSearch('search-oneway-in.json', { slices: 1, travelers: FAMILY });
      expect(ods).toEqual([{ from: 'BOM', to: 'DEL' }]);
      expect(fx.data.length).toBeGreaterThanOrEqual(5);
      const out = load('search-oneway-out.json');
      const outDate = out.data[0].itineraries[0].segments[0].departure.at.slice(0, 10);
      const inDate = fx.data[0].itineraries[0].segments[0].departure.at.slice(0, 10);
      expect(inDate > outDate).toBe(true);
    },
    SLOW
  );
});

describe('search-international.json (DEL→DXB→LHR, 1 ADT, INR)', () => {
  it(
    'validates; one-stop EK offer via DXB, long-haul amenities, business option',
    () => {
      const { fx, combined, ods } = checkSearch('search-international.json', {
        slices: 2,
        travelers: SOLO,
      });
      expect(ods).toEqual([
        { from: 'DEL', to: 'LHR' },
        { from: 'LHR', to: 'DEL' },
      ]);
      const viaDxb = combined.find((o) =>
        o.itineraries[0].segments
          .map((s) => s.arrival.iataCode)
          .join('-')
          .startsWith('DXB-LHR')
      );
      expect(viaDxb).toBeTruthy();
      expect(viaDxb.itineraries[0].segments).toHaveLength(2);
      expect(viaDxb.itineraries[0].segments[0].departure.iataCode).toBe('DEL');
      expect(fx.dictionaries.locations.LHR).toEqual({ cityCode: 'LON', countryCode: 'GB' });
      expect(fx.dictionaries.locations.DXB.countryCode).toBe('AE');
      const amenityTypes = new Set(
        fdbsOf(viaDxb).flatMap((f) => (f.amenities || []).map((a) => a.amenityType))
      );
      expect(amenityTypes).toContain('WIFI');
      expect(amenityTypes).toContain('SEAT');
      const business = combined.find((o) => fdbsOf(o)[0].cabin === 'BUSINESS');
      expect(business).toBeTruthy();
      expect(segmentsOf(business)[0].co2Emissions[0].cabin).toBe('BUSINESS');
      // per-traveler taxes present and consistent (checked in checkOffer); UK APD on the return
      const codes = combined[0].travelerPricings[0].price.taxes.map((t) => t.code);
      expect(codes).toContain('GB');
      expect(codes).toContain('YQ');
      // piece and weight baggage concepts both appear
      const allowances = combined.map((o) => fdbsOf(o)[0].includedCheckedBags);
      expect(allowances.some((b) => b.quantity !== undefined)).toBe(true);
      expect(allowances.some((b) => b.weight !== undefined)).toBe(true);
      // a basic fare with no included bag but a chargeable one
      const basic = combined.find((o) => fdbsOf(o)[0].includedCheckedBags.quantity === 0);
      expect(basic.pricingOptions.includedCheckedBagsOnly).toBe(false);
      expect(fdbsOf(basic)[0].additionalServices.chargeableCheckedBags.quantity).toBe(1);
      // overnight arrivals keep the local date
      const back = viaDxb.itineraries[1].segments;
      expect(back[1].arrival.at.slice(0, 10) > back[0].departure.at.slice(0, 10)).toBe(true);
    },
    SLOW
  );
});

describe('search-multicity.json (DEL→BLR→HYD→DEL, 1 ADT)', () => {
  it(
    'validates; three ODs with one-way combinations for each',
    () => {
      const { fx, combined, ods } = checkSearch('search-multicity.json', {
        slices: 3,
        travelers: SOLO,
      });
      expect(ods).toEqual([
        { from: 'DEL', to: 'BLR' },
        { from: 'BLR', to: 'HYD' },
        { from: 'HYD', to: 'DEL' },
      ]);
      expect(fx.meta.oneWayCombinations.map((c) => c.originDestinationId)).toEqual(['1', '2', '3']);
      expect(combined.length).toBeGreaterThanOrEqual(3);
      for (const o of combined) {
        const dates = o.itineraries.map((it) => it.segments[0].departure.at.slice(0, 10));
        expect(dates).toEqual(dates.slice().sort());
      }
    },
    SLOW
  );
});

/** Shared checks for a POST /v1/shopping/flight-offers/pricing response. */
function checkPricing(name) {
  const fx = load(name);
  expectMatches(PRICING, 'FlightOfferPricingOut', fx.data, `${name} data`);
  expectMatches(PRICING, 'Dictionaries', fx.dictionaries, `${name} dictionaries`);
  fx.warnings.forEach((w, i) => expectMatches(PRICING, 'Issue', w, `${name} warnings[${i}]`));
  const inc = fx.included;
  for (const [k, v] of Object.entries(inc.bags)) expectMatches(PRICING, 'Bags', v, `bags[${k}]`);
  for (const [k, v] of Object.entries(inc['other-services'])) {
    expectMatches(PRICING, 'OtherServices', v, `other-services[${k}]`);
  }
  for (const [k, v] of Object.entries(inc['credit-card-fees'])) {
    expectMatches(PRICING, 'CreditCardFee', v, `credit-card-fees[${k}]`);
  }
  for (const [k, v] of Object.entries(inc['detailed-fare-rules'])) {
    expectMatches(PRICING, 'DetailedFareRules', v, `detailed-fare-rules[${k}]`);
  }

  expect(fx.data.type).toBe('flight-offers-pricing');
  expect(fx.data.flightOffers).toHaveLength(1);
  const offer = fx.data.flightOffers[0];
  checkOffer(offer, `${name} offer`, { slices: 2, travelers: FAMILY });
  expectDictionaryCovers(fx.dictionaries, offer, name);
  const ids = travelerIds(offer);
  const segIds = segmentIds(offer);
  const offerIds = fx.data.flightOffers.map((o) => o.id);
  const bagIds = Object.keys(inc.bags);

  for (const tp of offer.travelerPricings) {
    expect(tp.price.taxes.length).toBeGreaterThan(0);
    expect(tp.price.refundableTaxes).toMatch(/^\d+\.\d{2}$/);
    for (const f of tp.fareDetailsBySegment) {
      const bag = f.additionalServices && f.additionalServices.chargeableCheckedBags;
      if (bag) expect(bagIds).toContain(bag.id);
    }
  }
  const br = fx.data.bookingRequirements;
  expect(br.emailAddressRequired).toBe(true);
  expect(br.travelerRequirements.map((t) => t.travelerId)).toEqual(ids);
  for (const t of br.travelerRequirements) expect(t.dateOfBirthRequired).toBe(true);
  for (const r of br.threeDomainSecureRequirements) {
    for (const id of r.flightOfferIds) expect(offerIds).toContain(id);
    expect(typeof r.is3dsAuthenticationRequired).toBe('boolean');
  }
  for (const b of Object.values(inc.bags)) {
    for (const id of b.segmentIds) expect(segIds).toContain(id);
    for (const id of b.travelerIds) expect(ids).toContain(id);
    expect(b.price.currencyCode).toBe('INR');
  }
  for (const s of Object.values(inc['other-services'])) {
    for (const id of s.segmentIds) expect(segIds).toContain(id);
    for (const id of s.travelerIds) expect(ids).toContain(id);
  }
  const brands = Object.values(inc['credit-card-fees']).map((f) => f.brand);
  expect(uniq(brands)).toBe(true);
  for (const f of Object.values(inc['credit-card-fees']))
    expect(offerIds).toContain(f.flightOfferId);
  const fareBases = new Set(fdbsOf(offer).map((f) => f.fareBasis));
  for (const r of Object.values(inc['detailed-fare-rules'])) {
    expect(segIds).toContain(r.segmentId);
    expect(fareBases).toContain(r.fareBasis);
    expect(r.fareNotes.descriptions.length).toBeGreaterThan(0);
  }
  expect(offer.fareRules.rules.map((r) => r.category)).toContain('REFUND');
  expect(offer.fareRules.rules.map((r) => r.category)).toContain('EXCHANGE');
  return { fx, offer };
}

describe('pricing.json / pricing-price-changed.json', () => {
  it(
    'pricing.json prices search-roundtrip offer 2 unchanged, with requirements and included.*',
    () => {
      const { offer } = checkPricing('pricing.json');
      const search = load('search-roundtrip.json');
      const source = search.data.find((o) => o.id === '2');
      expect(offer.price.grandTotal).toBe(source.price.grandTotal);
      expect(offer.price.billingCurrency).toBe('INR');
      expect(offer.price.fees.map((f) => f.type)).toContain('FORM_OF_PAYMENT');
      const flights = (o) => segmentsOf(o).map((s) => `${s.carrierCode}${s.number}@${s.id}`);
      expect(flights(offer)).toEqual(flights(source));
      expect(offer.travelerPricings.map((tp) => tp.price.total)).toEqual(
        source.travelerPricings.map((tp) => tp.price.total)
      );
    },
    SLOW
  );

  it(
    'pricing-price-changed.json differs in grandTotal and warns with 37200',
    () => {
      const before = load('pricing.json').data.flightOffers[0];
      const { fx, offer } = checkPricing('pricing-price-changed.json');
      expect(offer.price.grandTotal).not.toBe(before.price.grandTotal);
      expect(paise(offer.price.grandTotal)).toBeGreaterThan(paise(before.price.grandTotal));
      const warning = fx.warnings.find((w) => w.code === 37200);
      expect(warning).toBeTruthy();
      expect(warning.detail).toContain(offer.price.grandTotal);
      expect(warning.detail).toContain(before.price.grandTotal);
      expect(fdbsOf(offer)[0].class).not.toBe(fdbsOf(before)[0].class);
    },
    SLOW
  );
});

describe('upsell.json (branded fares for the AI round trip)', () => {
  it(
    'validates; three families, chargeable mix, combinations reference the offers',
    () => {
      const fx = load('upsell.json');
      fx.data.forEach((o, i) => expectMatches(UPSELL, 'FlightOffer', o, `upsell data[${i}]`));
      expectMatches(UPSELL, 'Collection_Meta_Upsell', fx.meta, 'upsell meta');
      expectMatches(UPSELL, 'Dictionaries', fx.dictionaries, 'upsell dictionaries');
      expect(fx.data).toHaveLength(3);
      expect(fx.meta.count).toBe(3);
      const ids = fx.data.map((o) => o.id);
      expect(uniq(ids)).toBe(true);
      const brands = [];
      for (const o of fx.data) {
        checkOffer(o, `upsell offer ${o.id}`, { slices: 2, travelers: FAMILY });
        expectDictionaryCovers(fx.dictionaries, o, `upsell offer ${o.id}`);
        const f = fdbsOf(o);
        expect(new Set(f.map((x) => x.brandedFare)).size).toBe(1);
        expect(new Set(f.map((x) => x.brandedFareLabel)).size).toBe(1);
        brands.push(f[0].brandedFare);
        expect(f.every((x) => x.amenities && x.amenities.length > 0)).toBe(true);
        for (const a of f.flatMap((x) => x.amenities)) {
          expect(typeof a.isChargeable).toBe('boolean');
          expect(a.description).toBeTruthy();
        }
      }
      expect(uniq(brands)).toBe(true);
      const all = fx.data.flatMap((o) => fdbsOf(o).flatMap((f) => f.amenities));
      expect(all.some((a) => a.isChargeable)).toBe(true);
      expect(all.some((a) => !a.isChargeable)).toBe(true);
      for (const combo of fx.meta.oneWayUpselledCombinations) {
        expect(ids).toContain(combo.flightOfferId);
        for (const id of combo.upselledFlightOfferIds) expect(ids).toContain(id);
      }
      // same flights as the priced offer, prices strictly increasing by tier
      const priced = load('pricing.json').data.flightOffers[0];
      const flights = (o) => segmentsOf(o).map((s) => `${s.carrierCode}${s.number}@${s.id}`);
      for (const o of fx.data) expect(flights(o)).toEqual(flights(priced));
      const totals = fx.data.map((o) => paise(o.price.grandTotal));
      expect(totals).toEqual(totals.slice().sort((a, b) => a - b));
      expect(uniq(totals)).toBe(true);
      expect(totals[0]).toBe(paise(priced.price.grandTotal));
      expect(fx.data.filter((o) => o.isUpsellOffer)).toHaveLength(2);
    },
    SLOW
  );
});

describe('availability.json (unpriced DEL→BOM)', () => {
  it(
    'validates; classes, waitlist / on-request, closed segment, dictionaries',
    () => {
      const fx = load('availability.json');
      fx.data.forEach((a, i) => expectMatches(AVAILABILITY, 'FlightAvailability', a, `data[${i}]`));
      expectMatches(AVAILABILITY, 'Collection_Meta_AvailSearch', fx.meta, 'meta');
      expectMatches(AVAILABILITY, 'Dictionaries', fx.dictionaries, 'dictionaries');
      expect(fx.meta.count).toBe(fx.data.length);
      expect(uniq(fx.data.map((a) => a.id))).toBe(true);
      const segIds = fx.data.flatMap((a) => a.segments.map((s) => s.id));
      expect(uniq(segIds)).toBe(true);
      const classes = [];
      let closedSegments = 0;
      for (const a of fx.data) {
        expect(a.type).toBe('flight-availability');
        expect(a.originDestinationId).toBe('1');
        expect(a.segments[0].departure.iataCode).toBe('DEL');
        expect(a.segments[a.segments.length - 1].arrival.iataCode).toBe('BOM');
        for (const s of a.segments) {
          expect(s.departure.at).toMatch(LOCAL_DATE_TIME);
          expect(s.arrival.at).toMatch(LOCAL_DATE_TIME);
          expect(fx.dictionaries.locations).toHaveProperty(s.departure.iataCode);
          expect(fx.dictionaries.aircraft).toHaveProperty(s.aircraft.code);
          expect(fx.dictionaries.carriers).toHaveProperty(s.carrierCode);
          if (s.closedStatus) closedSegments += 1;
          else expect(s.availabilityClasses.length).toBeGreaterThan(0);
          for (const c of s.availabilityClasses || []) {
            expect(c.class).toMatch(/^[A-Z]$/);
            expect(c.numberOfBookableSeats).toBeGreaterThanOrEqual(1);
            expect(c.numberOfBookableSeats).toBeLessThanOrEqual(9);
            classes.push(c);
          }
          expect(uniq((s.availabilityClasses || []).map((c) => c.class))).toBe(true);
        }
      }
      expect(closedSegments).toBeGreaterThan(0);
      expect(classes.some((c) => c.closedStatus === 'WAITLIST_OPEN')).toBe(true);
      expect(classes.some((c) => c.closedStatus === 'ON_REQUEST')).toBe(true);
      expect(classes.some((c) => c.tourAllotment)).toBe(true);
      expect(fx.data.some((a) => a.segments.length === 2)).toBe(true);
      expect(fx.data.some((a) => a.segments.some((s) => s.numberOfStops === 1))).toBe(true);
    },
    SLOW
  );
});

/** Shared checks for a FlightOrder envelope `data`. */
function checkOrder(order, label, spec) {
  expectMatches(spec, 'FlightOrder', order, label);
  expect(order.type).toBe('flight-order');
  expect(order.id).toMatch(/^[A-Za-z0-9%=+/]+$/);
  const offerIds = order.flightOffers.map((o) => o.id);
  const travelers = order.travelers.map((t) => t.id);
  expect(uniq(travelers)).toBe(true);
  const segIds = order.flightOffers.flatMap(segmentIds);
  for (const o of order.flightOffers) {
    checkOffer(o, `${label} offer ${o.id}`, { slices: 2 });
    expect(travelerIds(o).slice().sort(), `${label} travelerPricings ↔ travelers`).toEqual(
      travelers.slice().sort()
    );
    for (const s of segmentsOf(o)) {
      expect(s.bookingStatus).toBe('CONFIRMED');
      expect(s.segmentType).toBe('ACTIVE');
      expect(s.isFlown).toBe(false);
    }
  }
  expect(order.associatedRecords.length).toBeGreaterThan(0);
  for (const r of order.associatedRecords) {
    expect(offerIds).toContain(r.flightOfferId);
    expect(r.reference).toMatch(/^[A-Z0-9]{6}$/);
    expect(r.creationDate).toMatch(LOCAL_DATE_TIME);
  }
  expect(order.associatedRecords.some((r) => r.originSystemCode === 'GDS')).toBe(true);
  for (const fop of order.formOfPayments) {
    for (const id of fop.other.flightOfferIds) expect(offerIds).toContain(id);
  }
  for (const r of order.remarks.general) {
    for (const id of r.flightOfferIds || []) expect(offerIds).toContain(id);
    for (const id of r.travelerIds || []) expect(travelers).toContain(id);
  }
  for (const r of order.remarks.airline || []) {
    for (const id of r.travelerIds || []) expect(travelers).toContain(id);
  }
  for (const t of order.travelers) {
    expect(t.dateOfBirth).toMatch(DATE);
    for (const d of t.documents || []) {
      expect(d.expiryDate).toMatch(DATE);
      expect(d.issuanceCountry).toMatch(/^[A-Z]{2}$/);
    }
  }
  const lead = order.travelers[0];
  expect(lead.contact.emailAddress).toContain('@');
  expect(lead.contact.phones[0].countryCallingCode).toBe('91');
  expect(order.contacts.map((c) => c.purpose)).toEqual(['STANDARD', 'INVOICE']);
  expect(order.contacts[1].companyName).toBeTruthy();
  expect(order.ticketingAgreement.option).toMatch(/^(CONFIRM|DELAY_TO_QUEUE|DELAY_TO_CANCEL)$/);
  for (const id of order.ticketingAgreement.segmentIds || []) expect(segIds).toContain(id);
  for (const t of order.tickets || []) {
    expect(travelers).toContain(t.travelerId);
    for (const id of t.segmentIds) expect(segIds).toContain(id);
  }
  return { offerIds, travelers, segIds };
}

function expectFullyTicketed(order, label) {
  const { travelers, segIds } = {
    travelers: order.travelers.map((t) => t.id),
    segIds: order.flightOffers.flatMap(segmentIds),
  };
  expect(order.tickets.length).toBeGreaterThan(0);
  for (const t of order.tickets) {
    expect(t.documentType).toBe('ETICKET');
    expect(t.documentStatus).toBe('ISSUED');
    expect(t.documentNumber).toMatch(/^\d{13}$/);
  }
  expect(uniq(order.tickets.map((t) => t.documentNumber))).toBe(true);
  for (const id of travelers) {
    const covered = order.tickets.filter((t) => t.travelerId === id).flatMap((t) => t.segmentIds);
    expect(covered.slice().sort(), `${label} traveler ${id} ticketed on every segment`).toEqual(
      segIds.slice().sort()
    );
  }
}

describe('flight orders', () => {
  it(
    'order-created.json: 201 body with hold agreement, CASH FOP, contacts and remarks',
    () => {
      const fx = load('order-created.json');
      checkOrder(fx.data, 'order-created', CREATE);
      expectMatches(CREATE, 'Dictionaries', fx.dictionaries, 'order-created dictionaries');
      expect(fx.data.tickets).toBeUndefined();
      expect(fx.data.ticketingAgreement.option).toBe('DELAY_TO_CANCEL');
      expect(fx.data.ticketingAgreement.delay).toMatch(/^\d+D$/);
      expect(fx.data.formOfPayments).toEqual([
        { other: { method: 'CASH', flightOfferIds: ['1'] } },
      ]);
      expect(fx.data.remarks.general.some((r) => r.subType === 'INVOICE')).toBe(true);
      expect(fx.data.travelers.map((t) => t.gender)).toEqual(['MALE', 'FEMALE', 'MALE', 'FEMALE']);
      expect(fx.data.travelers[0].documents[0].documentType).toBe('PASSPORT');
      expect(fx.data.travelers[0].emergencyContact.countryCode).toBe('IN');
      const priced = load('pricing.json').data.flightOffers[0];
      expect(fx.data.flightOffers[0].price.grandTotal).toBe(priced.price.grandTotal);
    },
    SLOW
  );

  it(
    'order-held.json: management GET of a queued hold, no tickets, included bags',
    () => {
      const fx = load('order-held.json');
      checkOrder(fx.data, 'order-held', MANAGEMENT);
      for (const [k, v] of Object.entries(fx.included.bags)) {
        expectMatches(MANAGEMENT, 'Bags', v, `order-held bags[${k}]`);
      }
      expect(fx.data.tickets).toBeUndefined();
      expect(fx.data.ticketingAgreement.option).toBe('DELAY_TO_QUEUE');
      expect(fx.data.ticketingAgreement.dateTime).toMatch(LOCAL_DATE_TIME);
      expect(fx.data.automatedProcess[0].code).toBe('DELAYED');
      expect(fx.data.automatedProcess[0].queue.number).toBeTruthy();
      expect(fx.data.id).not.toBe(load('order-created.json').data.id);
    },
    SLOW
  );

  it(
    'order-ticketed.json: tickets per traveler and segment, refund / rebook rules',
    () => {
      const fx = load('order-ticketed.json');
      checkOrder(fx.data, 'order-ticketed', MANAGEMENT);
      expectFullyTicketed(fx.data, 'order-ticketed');
      expect(fx.data.id).toBe(load('order-created.json').data.id);
      const rules = fx.data.flightOffers[0].fareRules.rules;
      const refund = rules.find((r) => r.category === 'REFUND');
      expect(refund.refundingPreview.totalRefund.currencyCode).toBe('INR');
      expect(paise(refund.refundingPreview.fareRefund.amount)).toBe(
        paise(refund.refundingPreview.farePaid.amount) -
          paise(refund.refundingPreview.cancellationPenalty.amount)
      );
      const rebook = rules.find((r) => r.category === 'EXCHANGE');
      expect(rebook.rebookConditions.reshopValidatingAirlineCodes).toEqual(['AI']);
      for (const r of [refund, rebook]) {
        for (const id of r.applicability.travelerIds) {
          expect(fx.data.travelers.map((t) => t.id)).toContain(id);
        }
      }
    },
    SLOW
  );

  it(
    'order-by-reference.json: data is an array of orders found by PNR',
    () => {
      const fx = load('order-by-reference.json');
      expect(Array.isArray(fx.data)).toBe(true);
      expect(fx.data).toHaveLength(1);
      expectMatches(BY_REFERENCE, 'Collection_Meta_Link', fx.meta, 'by-reference meta');
      checkOrder(fx.data[0], 'order-by-reference', BY_REFERENCE);
      expectFullyTicketed(fx.data[0], 'order-by-reference');
      const pnr = fx.data[0].associatedRecords.find((r) => r.originSystemCode === 'GDS').reference;
      expect(fx.meta.links.self).toContain(`reference=${pnr}`);
      expect(fx.meta.count).toBe(1);
    },
    SLOW
  );

  it(
    'issuance.json: the order returned by POST …/issuance is fully ticketed',
    () => {
      const fx = load('issuance.json');
      checkOrder(fx.data, 'issuance', ISSUE);
      expectFullyTicketed(fx.data, 'issuance');
      expect(fx.data.id).toBe(load('order-created.json').data.id);
      expect(fx.data.formOfPayments[0].other.method).toBe('CASH');
    },
    SLOW
  );
});

describe('errors/*.json (Issue bodies)', () => {
  it('each file validates as { errors: Issue[] } with the code in its name', () => {
    for (const [file, [spec, definition]] of Object.entries(ERROR_FIXTURES)) {
      const fx = load(`errors/${file}`);
      expectMatches(spec, definition, fx, `errors/${file}`);
      expect(fx.errors).toHaveLength(1);
      const issue = fx.errors[0];
      expect(file.startsWith(`${issue.code}-`)).toBe(true);
      expect(Number.isInteger(issue.code)).toBe(true);
      expect(issue.status).toBe(definition === 'Error_409' ? 409 : 400);
      expect(issue.title).toMatch(/^[A-Z0-9 /-]+$/);
      expect(issue.detail.length).toBeGreaterThan(10);
      if (issue.source) expect(Object.keys(issue.source)).toHaveLength(1);
    }
    const codes = Object.keys(ERROR_FIXTURES).map((f) => Number(f.split('-')[0]));
    expect(codes.sort((a, b) => a - b)).toEqual(
      [37200, 34651, 34107, 4926, 2668, 39397, 2552, 477, 9112, 36870].sort((a, b) => a - b)
    );
  });
});
