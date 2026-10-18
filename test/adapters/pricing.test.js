import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  toPricingRequest,
  toTravelers,
  toContact,
  toIdentityDocument,
  fromIdentityDocument,
  fromPricingResponse,
  fromBookingRequirements,
  fromBags,
  fromOtherServices,
  fromCreditCardFees,
  fromDetailedFareRules,
  toAdditionalServices,
  combineOffers,
} from '../../src/adapters/amadeus/pricing.js';
import { fromFlightOffer } from '../../src/adapters/amadeus/search.js';
import { ValidationError } from '../../src/errors/index.js';
import { expectValid } from '../helpers/swagger.js';

const PRICING = 'FlightOffersPrice';
const ORDERS = 'FlightCreateOrders';
// Each validateAgainst() compiles the (large) spec; give the schema checks room.
const SLOW = { timeout: 60_000 };

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../../src/mock/fixtures/amadeus');
const load = (name) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const pricingFx = load('pricing.json');
const changedFx = load('pricing-price-changed.json');
const roundtripFx = load('search-roundtrip.json');
const onewayOutFx = load('search-oneway-out.json');
const onewayInFx = load('search-oneway-in.json');

const PRICED = pricingFx.data.flightOffers[0];
const REPRICED = changedFx.data.flightOffers[0];
const ROUNDTRIP_2 = roundtripFx.data.find((o) => o.id === '2');
const ROUNDTRIP_3 = roundtripFx.data.find((o) => o.id === '3');
const OUT_2 = onewayOutFx.data.find((o) => o.id === '2');
const IN_3 = onewayInFx.data.find((o) => o.id === '3');

const CTX = { sessionId: 's1' };
const snapshot = (v) => JSON.stringify(v);
const segmentIds = (offer) => offer.itineraries.flatMap((it) => it.segments.map((s) => s.id));
const fdbsOf = (offer, travelerId) =>
  offer.travelerPricings.find((tp) => tp.travelerId === travelerId).fareDetailsBySegment;

/**
 * Amadeus `departure.at` / `arrival.at` are local wall‑clock strings although the schema says
 * `format: date-time` (C‑1); ajv‑formats enforces RFC 3339, so structural checks run on a copy with the
 * timestamps pinned to `Z`. Nothing else is touched.
 */
function rfc(offer) {
  const at = (v) => (typeof v === 'string' && /T\d{2}:\d{2}:\d{2}$/.test(v) ? `${v}Z` : v);
  const out = {
    ...offer,
    itineraries: offer.itineraries.map((it) => ({
      ...it,
      segments: it.segments.map((s) => ({
        ...s,
        departure: { ...s.departure, at: at(s.departure.at) },
        arrival: { ...s.arrival, at: at(s.arrival.at) },
      })),
    })),
  };
  if (out.lastTicketingDateTime) out.lastTicketingDateTime = at(out.lastTicketingDateTime);
  return out;
}

const withRfcOffers = (data) => ({ ...data, flightOffers: data.flightOffers.map(rfc) });

// ── traveler capture inputs ─────────────────────────────────────────────────────────────────────

const CONTACT = {
  email: 'lead@example.com',
  phone: { countryCode: '+91', number: '98765 43210', type: 'mobile' },
  address: {
    line1: '12 MG Road',
    line2: 'Flat 4B',
    city: 'Bengalūru',
    state: 'Karnataka',
    postalCode: '560001',
    countryCode: 'in',
  },
  emergency: { name: 'Ravi Kumár', phone: { countryCode: '+91', number: '91234-56789' } },
  gst: {
    number: '29ABCDE1234F1Z5',
    company: 'Acme Travels Pvt Ltd',
    address: '7 Residency Rd, Bengaluru',
  },
  company: 'Acme',
  language: 'EN',
};

const TRAVELERS = [
  {
    type: 'ADT',
    title: 'Mr',
    firstName: 'Arjun',
    middleName: 'K',
    lastName: 'Sharma',
    gender: 'M',
    dob: '1988-02-14',
    nationality: 'in',
    documents: [
      {
        type: 'passport',
        number: 'Z1234567',
        issuingCountry: 'IN',
        expiry: '2031-05-01',
        issueDate: '2021-05-02',
        issuanceLocation: 'Bengaluru',
      },
      {
        type: 'visa',
        number: 'V998877',
        issuingCountry: 'US',
        expiry: '2027-01-01',
        validityCountry: 'us',
      },
      { type: 'driving_licence', number: 'DL1', issuingCountry: 'IN', expiry: '2030-01-01' },
    ],
    knownTravelerNumber: 'KTN123',
    loyalty: [{ airline: 'ai', number: '12345' }],
    mealPref: 'VGML',
  },
  {
    id: 'tp_9',
    type: 'ADT',
    firstName: 'Priya',
    lastName: 'Sharma',
    gender: 'F',
    dob: '1990-07-30',
    email: 'priya@example.com',
    phone: { countryCode: '1', number: '(415) 555-0101' },
    redressNumber: 'RD777',
  },
  { type: 'CHD', firstName: 'Ira', lastName: 'Sharma', gender: 'F', dob: '2018-03-03' },
  {
    type: 'INF',
    firstName: 'Vir',
    lastName: 'Sharma',
    gender: 'M',
    dob: '2025-06-06',
    associatedAdultId: '1',
  },
];

const SLOTS = [
  { id: '1', type: 'ADT', index: 0 },
  { id: '2', type: 'ADT', index: 1, travelerId: 'tp_9' },
  { id: '3', type: 'CHD', index: 2 },
  { id: '4', type: 'INF', index: 3 },
];

// ── toPricingRequest ────────────────────────────────────────────────────────────────────────────

describe('toPricingRequest', () => {
  it(
    'builds a single-offer body with the offer ids kept, validates against FlightOfferPricingIn',
    SLOW,
    () => {
      const before = snapshot(ROUNDTRIP_2);
      const { body, query, map } = toPricingRequest([ROUNDTRIP_2]);
      expect(body.data.type).toBe('flight-offers-pricing');
      expect(body.data.flightOffers).toHaveLength(1);
      expect(body.data.flightOffers[0]).not.toBe(ROUNDTRIP_2);
      expect(body.data.flightOffers[0].id).toBe('2');
      expect(segmentIds(body.data.flightOffers[0])).toEqual(['2', '11']);
      expect(body.data.additionalInformation).toEqual({ fareRules: true });
      expect(body.data.travelers).toBeUndefined();
      expect(body.data.payments).toBeUndefined();
      expect(query).toEqual({ forceClass: true });
      expect(map.offers).toEqual({ 2: { index: 0, id: '2' } });
      expect(map.segments['11']).toEqual({ index: 0, offerId: '2', id: '11' });
      expect(snapshot(ROUNDTRIP_2)).toBe(before);
      expectValid(PRICING, 'FlightOfferPricingIn', withRfcOffers(body.data));
    }
  );

  it(
    'renumbers two one-way offers (offers 1..n, segments unique, fareDetails remapped) and validates',
    SLOW,
    () => {
      const { body, map } = toPricingRequest([OUT_2, IN_3]);
      const [first, second] = body.data.flightOffers;
      expect([first.id, second.id]).toEqual(['1', '2']);
      expect(segmentIds(first)).toEqual(['1']);
      expect(segmentIds(second)).toEqual(['2']);
      for (const tp of second.travelerPricings) {
        expect(tp.fareDetailsBySegment.map((f) => f.segmentId)).toEqual(['2']);
      }
      expect(map.offers).toEqual({ 1: { index: 0, id: '2' }, 2: { index: 1, id: '3' } });
      expect(map.byIndex[1]).toEqual({ id: '2', segments: { 3: '2' } });
      expect(map.segments['2']).toEqual({ index: 1, offerId: '2', id: '3' });
      expect(OUT_2.id).toBe('2');
      expect(IN_3.id).toBe('3');
      expectValid(PRICING, 'FlightOfferPricingIn', withRfcOffers(body.data));
    }
  );

  it('renumbers offers whose ids are distinct but whose segment ids collide', () => {
    const { body } = toPricingRequest([ROUNDTRIP_2, ROUNDTRIP_3]);
    expect(body.data.flightOffers.map((o) => o.id)).toEqual(['1', '2']);
    expect(body.data.flightOffers.flatMap(segmentIds)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('maps travelers, payments, include aliases, fareRules and forceClass options', SLOW, () => {
    const { body, query } = toPricingRequest([OUT_2, IN_3], {
      travelers: TRAVELERS,
      contact: CONTACT,
      slots: SLOTS,
      payments: [
        { brand: 'amex', bin: '3774 00' },
        { brand: 'VISA', binNumber: 411111 },
      ],
      include: ['bags', 'otherServices', 'fare_rules'],
      fareRules: false,
      forceClass: false,
    });
    expect(body.data.travelers).toHaveLength(4);
    expect(body.data.travelers.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
    expect(body.data.travelers[0].name.firstName).toBe('Arjun');
    expect(body.data.payments).toEqual([
      { brand: 'AMERICAN_EXPRESS', binNumber: 377400, flightOfferIds: ['1', '2'] },
      { brand: 'VISA', binNumber: 411111, flightOfferIds: ['1', '2'] },
    ]);
    expect(body.data.additionalInformation).toEqual({ fareRules: false });
    expect(query).toEqual({
      forceClass: false,
      include: ['credit-card-fees', 'bags', 'other-services', 'detailed-fare-rules'],
    });
    expectValid(PRICING, 'FlightOfferPricingIn', withRfcOffers(body.data));
  });

  it('accepts a csv include string and Amadeus-shaped travelers as given', () => {
    const amadeusTravelers = [{ id: '1', name: { firstName: 'A', lastName: 'B' } }];
    const { body, query } = toPricingRequest(ROUNDTRIP_2, {
      travelers: amadeusTravelers,
      include: 'detailed-fare-rules,bags',
    });
    expect(body.data.travelers).toEqual(amadeusTravelers);
    expect(body.data.travelers[0]).not.toBe(amadeusTravelers[0]);
    expect(query.include).toEqual(['bags', 'detailed-fare-rules']);
  });

  it('translates payment flightOfferIds (SDK-scoped, original wire ids) through the renumbering map', () => {
    const { body } = toPricingRequest([ROUNDTRIP_2, ROUNDTRIP_3], {
      payments: [{ brand: 'mastercard', flightOfferIds: ['s1:3'] }],
    });
    expect(body.data.payments).toEqual([{ brand: 'MASTERCARD', flightOfferIds: ['2'] }]);
  });

  it('accepts Offer objects through their raw payload', () => {
    const offer = fromFlightOffer(ROUNDTRIP_2, { ...CTX, dictionaries: roundtripFx.dictionaries });
    const { body } = toPricingRequest([offer]);
    expect(body.data.flightOffers[0].id).toBe('2');
    expect(body.data.flightOffers[0].travelerPricings).toHaveLength(4);
  });

  it('rejects no offer and more than six offers with a ValidationError', () => {
    expect(() => toPricingRequest([])).toThrow(ValidationError);
    expect(() => toPricingRequest(undefined)).toThrow(ValidationError);
    const seven = Array.from({ length: 7 }, () => ROUNDTRIP_2);
    let error;
    try {
      toPricingRequest(seven);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues[0]).toMatchObject({ path: 'offers', code: 'too_many' });
  });
});

// ── toTravelers / toContact / documents ─────────────────────────────────────────────────────────

describe('toTravelers', () => {
  it(
    'maps the family to Amadeus travelers that validate against the pricing Traveler definition',
    SLOW,
    () => {
      const before = snapshot(TRAVELERS);
      const out = toTravelers(TRAVELERS, CONTACT, SLOTS, {
        countryFor: (dial) => (dial === '+91' ? 'IN' : undefined),
      });
      expect(snapshot(TRAVELERS)).toBe(before);
      expect(out.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
      const [lead, second, child, infant] = out;

      expect(lead.dateOfBirth).toBe('1988-02-14');
      expect(lead.gender).toBe('MALE');
      expect(lead.name).toEqual({ firstName: 'Arjun', lastName: 'Sharma', middleName: 'K' });
      expect(lead.title).toBeUndefined();
      expect(lead.mealPref).toBeUndefined();
      expect(lead.documents).toHaveLength(3);
      expect(lead.documents[0]).toEqual({
        documentType: 'PASSPORT',
        number: 'Z1234567',
        issuanceDate: '2021-05-02',
        expiryDate: '2031-05-01',
        issuanceCountry: 'IN',
        issuanceLocation: 'Bengaluru',
        nationality: 'IN',
        holder: true,
      });
      expect(lead.documents[1]).toMatchObject({ documentType: 'VISA', validityCountry: 'US' });
      expect(lead.documents[2]).toEqual({
        documentType: 'KNOWN_TRAVELER',
        number: 'KTN123',
        holder: true,
      });
      expect(lead.contact.emailAddress).toBe('lead@example.com');
      expect(lead.contact.phones).toEqual([
        { deviceType: 'MOBILE', countryCallingCode: '91', number: '9876543210' },
      ]);
      expect(lead.contact.address).toEqual({
        lines: ['12 MG Road', 'Flat 4B'],
        postalCode: '560001',
        cityName: 'Bengaluru',
        stateName: 'Karnataka',
        countryCode: 'IN',
      });
      expect(lead.emergencyContact).toEqual({
        addresseeName: 'Ravi Kumar',
        countryCode: 'IN',
        number: '9123456789',
      });
      expect(lead.loyaltyPrograms).toEqual([{ programOwner: 'AI', id: '12345' }]);

      expect(second.gender).toBe('FEMALE');
      expect(second.contact).toEqual({
        emailAddress: 'priya@example.com',
        phones: [{ deviceType: 'MOBILE', countryCallingCode: '+1', number: '4155550101' }],
      });
      expect(second.emergencyContact).toBeUndefined();
      expect(second.documents).toEqual([
        { documentType: 'REDRESS', number: 'RD777', holder: true },
      ]);

      expect(child.contact).toBeUndefined();
      expect(child.documents).toBeUndefined();
      expect(infant.associatedAdultId).toBe('1');

      for (const t of out) expectValid(PRICING, 'Traveler', t);
    }
  );

  it(
    'maps gender X to UNSPECIFIED / UNDISCLOSED, which the orders Traveler definition accepts',
    SLOW,
    () => {
      const [x, undisclosed] = toTravelers([
        { type: 'ADT', firstName: 'Sam', lastName: 'Lee', gender: 'X', dob: '1990-01-01' },
        {
          type: 'ADT',
          firstName: 'Kim',
          lastName: 'Lee',
          gender: 'X',
          genderDetail: 'undisclosed',
          dob: '1991-01-01',
        },
      ]);
      expect(x.gender).toBe('UNSPECIFIED');
      expect(undisclosed.gender).toBe('UNDISCLOSED');
      expect([x.id, undisclosed.id]).toEqual(['1', '2']);
      expectValid(ORDERS, 'Traveler', x);
      expectValid(ORDERS, 'Traveler', undisclosed);
    }
  );

  it('prefers slotId, then the slot naming the traveler, then order + type, then the position', () => {
    const out = toTravelers(
      [
        { slotId: '7', type: 'ADT', firstName: 'A', lastName: 'A' },
        { id: 'tp_9', type: 'ADT', firstName: 'B', lastName: 'B' },
        { type: 'CHD', firstName: 'C', lastName: 'C' },
        { type: 'ADT', firstName: 'D', lastName: 'D' },
      ],
      undefined,
      [
        { id: '1', type: 'ADT', index: 0 },
        { id: '2', type: 'ADT', index: 1, travelerId: 'tp_9' },
        { id: '3', type: 'CHD', index: 2 },
      ]
    );
    expect(out.map((t) => t.id)).toEqual(['7', '2', '3', '1']);
    expect(toTravelers([{ type: 'ADT', firstName: 'E', lastName: 'E' }])[0].id).toBe('1');
  });

  it('gives the emergency contact an ISO country from the address when no dial lookup is given', () => {
    const [lead] = toTravelers(TRAVELERS.slice(0, 1), CONTACT, SLOTS);
    expect(lead.emergencyContact.countryCode).toBe('IN');
    const [other] = toTravelers(TRAVELERS.slice(0, 1), {
      ...CONTACT,
      address: undefined,
      emergency: { name: 'Jo', phone: { countryCode: 'us', number: '555 0100' } },
    });
    expect(other.emergencyContact).toEqual({
      addresseeName: 'Jo',
      countryCode: 'US',
      number: '5550100',
    });
  });

  it('returns [] for nothing', () => {
    expect(toTravelers(undefined)).toEqual([]);
    expect(toTravelers(null, CONTACT)).toEqual([]);
  });
});

describe('toContact', () => {
  it('serialises the standard contact and validates against the Contact definition', SLOW, () => {
    const out = toContact(CONTACT, 'standard', { addressee: TRAVELERS[0] });
    expect(out).toEqual({
      addresseeName: { firstName: 'Arjun', lastName: 'Sharma', middleName: 'K' },
      purpose: 'STANDARD',
      emailAddress: 'lead@example.com',
      phones: [{ deviceType: 'MOBILE', countryCallingCode: '91', number: '9876543210' }],
      address: {
        lines: ['12 MG Road', 'Flat 4B'],
        postalCode: '560001',
        cityName: 'Bengaluru',
        stateName: 'Karnataka',
        countryCode: 'IN',
      },
      companyName: 'Acme',
      language: 'EN',
    });
    expectValid(ORDERS, 'Contact', out);
    expect(toContact(CONTACT).purpose).toBe('STANDARD');
  });

  it('serialises the GST block as the INVOICE contact', SLOW, () => {
    const out = toContact(CONTACT, 'invoice');
    expect(out).toEqual({
      purpose: 'INVOICE',
      companyName: 'Acme Travels Pvt Ltd',
      emailAddress: 'lead@example.com',
      address: { lines: ['7 Residency Rd, Bengaluru'], countryCode: 'IN' },
      phones: [{ deviceType: 'MOBILE', countryCallingCode: '91', number: '9876543210' }],
    });
    expectValid(ORDERS, 'Contact', out);
    expect(toContact({ email: 'a@b.c' }, 'INVOICE').address).toBeUndefined();
  });

  it('gives undefined for a missing contact', () => {
    expect(toContact(undefined)).toBeUndefined();
    expect(toContact(null, 'invoice')).toBeUndefined();
  });
});

describe('toIdentityDocument / fromIdentityDocument', () => {
  const passport = {
    type: 'passport',
    number: 'Z1234567',
    issuingCountry: 'in',
    nationality: 'IN',
    expiry: '2031-05-01',
    issueDate: '2021-05-02T00:00:00.000Z',
    issuanceLocation: 'Bengaluru',
    birthPlace: 'Mysuru',
    birthCountry: 'IN',
    holder: false,
  };

  it('round-trips a passport and validates the wire document', SLOW, () => {
    const wire = toIdentityDocument(passport);
    expect(wire).toEqual({
      documentType: 'PASSPORT',
      number: 'Z1234567',
      issuanceDate: '2021-05-02',
      expiryDate: '2031-05-01',
      issuanceCountry: 'IN',
      issuanceLocation: 'Bengaluru',
      nationality: 'IN',
      birthPlace: 'Mysuru',
      birthCountry: 'IN',
      holder: false,
    });
    expectValid(PRICING, 'IdentityDocument', wire);
    const back = fromIdentityDocument(wire);
    expect(back).toEqual({
      ...passport,
      issuingCountry: 'IN',
      issueDate: '2021-05-02',
      raw: wire,
    });
  });

  it('maps the enum both ways, defaults holder and drops unsupported types', () => {
    expect(toIdentityDocument({ type: 'national_id', number: '1', issuingCountry: 'FR' })).toEqual({
      documentType: 'IDENTITY_CARD',
      number: '1',
      issuanceCountry: 'FR',
      holder: true,
    });
    expect(
      toIdentityDocument({ type: 'visa', number: 'V1' }, { nationality: 'in' }).nationality
    ).toBe('IN');
    expect(toIdentityDocument({ type: 'driving_licence', number: 'DL' })).toBeUndefined();
    expect(toIdentityDocument({ type: 'other', number: 'X' })).toBeUndefined();
    expect(toIdentityDocument(null)).toBeUndefined();
    expect(fromIdentityDocument({ documentType: 'IDENTITY_CARD', number: '1' }).type).toBe(
      'national_id'
    );
    expect(fromIdentityDocument({ documentType: 'KNOWN_TRAVELER', number: 'K' }).type).toBe(
      'known_traveler'
    );
    expect(fromIdentityDocument({ documentType: 'MYSTERY', number: 'M' }).type).toBe('other');
    expect(fromIdentityDocument(undefined)).toBeUndefined();
  });
});

// ── fromPricingResponse ─────────────────────────────────────────────────────────────────────────

describe('fromPricingResponse — pricing.json (unchanged price)', () => {
  const places = {
    DEL: { code: 'DEL', name: 'Indira Gandhi International', tz: 'Asia/Kolkata' },
    BOM: { code: 'BOM', name: 'Chhatrapati Shivaji Maharaj International', tz: 'Asia/Kolkata' },
  };
  const before = snapshot(pricingFx);
  const result = fromPricingResponse(pricingFx, {
    ctx: { ...CTX, places },
    previous: [ROUNDTRIP_2],
  });

  it('converts the priced offer with scoped ids, the priced FlightOffer on raw and hydrated places', () => {
    expect(snapshot(pricingFx)).toBe(before);
    expect(result.offers).toHaveLength(1);
    const [offer] = result.offers;
    expect(offer.id).toBe('s1:1');
    expect(offer.raw).toBe(PRICED);
    expect(offer.price.total).toEqual({ amount: '32017.54', currency: 'INR' });
    expect(offer.slices).toHaveLength(2);
    expect(offer.slices[0].origin.code).toBe('DEL');
    expect(offer.slices[0].origin.name).toBe('Indira Gandhi International');
    expect(result.combined).toBeUndefined();
    expect(result.raw).toBe(pricingFx);
  });

  it('builds partial places from dictionaries.locations when no places lookup is given', () => {
    const bare = fromPricingResponse(pricingFx, { ctx: CTX });
    const origin = bare.offers[0].slices[0].origin;
    expect(origin).toMatchObject({ code: 'DEL', cityCode: 'DEL', countryCode: 'IN' });
    expect(origin.name).toBeUndefined();
  });

  it('reports no change and equal from / to against the search offer', () => {
    expect(result.changed).toBe(false);
    expect(result.changeReasons).toEqual([]);
    expect(result.from).toEqual({ amount: '32017.54', currency: 'INR' });
    expect(result.to).toEqual({ amount: '32017.54', currency: 'INR' });
  });

  it('surfaces the warnings verbatim and attaches them to the offer they point at', () => {
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe(pricingFx.warnings[0]);
    expect(result.offers[0].warnings).toEqual([pricingFx.warnings[0]]);
  });

  it('derives TravelerRequirements: per-type OR, per-traveler kept, contact rules, 3DS', () => {
    const { requirements } = result;
    expect(Object.keys(requirements.perType).sort()).toEqual(['ADT', 'CHD', 'INF']);
    expect(requirements.perType.ADT.fields).toEqual([
      { path: 'gender', required: true, options: ['M', 'F'] },
      { path: 'dob', required: true },
    ]);
    expect(requirements.perType.ADT.documents).toEqual([
      { types: ['passport', 'national_id', 'visa'], required: false },
    ]);
    expect(requirements.perType.INF.fields).toContainEqual({
      path: 'contact.address',
      required: false,
    });
    expect(requirements.perType.CHD.fields).not.toContainEqual(
      expect.objectContaining({ path: 'contact.address' })
    );
    expect(requirements.apis).toBe(false);
    expect(requirements.contact).toEqual([
      { path: 'email', required: true },
      { path: 'phone.number', required: true, pattern: '^[0-9]{1,15}$' },
      { path: 'phone.countryCode', required: true, pattern: '^[0-9+]{2,5}$' },
      { path: 'phone.type', required: true, options: ['mobile'] },
    ]);
    expect(requirements.threeDsRequired).toBe(true);
    expect(result.threeDsRequired).toBe(true);
    expect(Object.keys(requirements.perTraveler)).toEqual(['1', '2', '3', '4']);
    expect(requirements.perTraveler['4'].fields).toContainEqual({
      path: 'contact.address',
      required: false,
    });
    expect(requirements.perTraveler['1'].documents).toEqual([
      { types: ['passport', 'national_id', 'visa'], required: false },
    ]);
    expect(requirements.ageRules).toEqual({
      infantMax: 2,
      childMax: 12,
      refDate: 'departure',
      infantPerAdult: 1,
      maxPax: 9,
    });
    expect(requirements.nameRules).toEqual({
      maxLength: 35,
      charset: 'latin',
      maxCombinedLength: 59,
    });
    expect(requirements.gstAvailable).toBe(false);
    expect(requirements.raw).toBe(pricingFx.data.bookingRequirements);
  });

  it('seeds the ancillary catalogue from included.bags and included[other-services]', () => {
    const { catalog } = result;
    expect(catalog.seatMapsAvailable).toEqual([]);
    expect(catalog.protections).toEqual([]);
    expect(catalog.services).toHaveLength(5);
    const [bag1, bag2, priority, checkin, fastTrack] = catalog.services;
    expect(bag1).toMatchObject({
      id: '1',
      type: 'baggage',
      code: 'CHECKED_BAG',
      label: '1 × 10 KG',
      price: { amount: '1500.00', currency: 'INR' },
      scope: 'per_passenger',
      eligiblePassengerTypes: ['ADT', 'CHD'],
    });
    expect(bag1.segmentId).toBeUndefined();
    expect(bag1.sliceId).toBeUndefined();
    expect(bag1.meta).toMatchObject({
      quantity: 1,
      weight: 10,
      weightUnit: 'KG',
      weightKg: 10,
      segmentIds: ['2', '11'],
      travelerIds: ['1', '2', '3'],
      bookableByItinerary: false,
    });
    expect(bag1.raw).toBe(pricingFx.included.bags['1']);
    expect(bag2).toMatchObject({ id: '2', label: '1 × 15 KG', price: { amount: '2250.00' } });
    expect(priority).toMatchObject({
      id: '1',
      type: 'priority_boarding',
      code: 'PRIORITY_BOARDING',
      label: 'PRIORITY BOARDING',
      price: { amount: '499.00', currency: 'INR' },
      scope: 'per_passenger',
      eligiblePassengerTypes: ['ADT', 'CHD'],
    });
    expect(checkin).toMatchObject({ type: 'airport_checkin', scope: 'per_passenger' });
    expect(fastTrack).toMatchObject({
      id: '3',
      type: 'fast_track',
      scope: 'per_passenger_slice',
      segmentId: 's1:1:2',
      sliceId: 's1:1:0',
      price: { amount: '350.00', currency: 'INR' },
    });
  });

  it('maps credit card fees and detailed fare rules', () => {
    expect(result.cardFees).toHaveLength(3);
    expect(result.cardFees[2]).toEqual({
      id: '3',
      brand: 'AMERICAN_EXPRESS',
      amount: { amount: '1250.00', currency: 'INR' },
      offerId: '1',
      raw: pricingFx.included['credit-card-fees']['3'],
    });
    expect(result.detailedFareRules).toHaveLength(4);
    expect(result.detailedFareRules[0]).toMatchObject({
      title: 'ECONOMY VALUE — Penalties',
      fareBasis: 'UU1YXSII',
      segmentId: '2',
      category: 'PENALTIES',
    });
    expect(result.detailedFareRules[0].text).toContain('CHARGE INR 3500');
    expect(result.detailedFareRules[1].title).toBe('ECONOMY VALUE — Min stay');
  });

  it('accepts the unwrapped HttpResponse shape (raw envelope) and a bare FlightOfferPricingOut', () => {
    const viaResponse = fromPricingResponse(
      { data: pricingFx.data, meta: { dictionaries: pricingFx.dictionaries }, raw: pricingFx },
      { ctx: CTX }
    );
    expect(viaResponse.offers[0].id).toBe('s1:1');
    expect(viaResponse.catalog.services).toHaveLength(5);
    const bare = fromPricingResponse(pricingFx.data, { ctx: CTX });
    expect(bare.offers).toHaveLength(1);
    expect(bare.catalog.services).toEqual([]);
    expect(bare.cardFees).toEqual([]);
    expect(bare.warnings).toEqual([]);
    expect(bare.changed).toBe(false);
    expect(bare.from).toBeUndefined();
    expect(bare.to).toEqual({ amount: '32017.54', currency: 'INR' });
  });

  it('copes with an empty or missing envelope', () => {
    const empty = fromPricingResponse(undefined);
    expect(empty.offers).toEqual([]);
    expect(empty.changed).toBe(false);
    expect(empty.requirements.perType).toEqual({});
    expect(empty.threeDsRequired).toBe(false);
  });
});

describe('fromPricingResponse — pricing-price-changed.json (price moved)', () => {
  it('diffs grandTotal, per-traveler totals and booking class against the previous raw offer', () => {
    const result = fromPricingResponse(changedFx, { ctx: CTX, previous: [PRICED] });
    expect(result.changed).toBe(true);
    expect(result.from).toEqual({ amount: '32017.54', currency: 'INR' });
    expect(result.to).toEqual({ amount: '34411.54', currency: 'INR' });
    expect(result.changeReasons).toEqual(
      expect.arrayContaining(['grandTotal', 'travelerTotal', 'class', 'warning'])
    );
    expect(result.changeReasons).not.toContain('brandedFare');
    expect(result.changeReasons).not.toContain('currency');
    expect(result.offers[0].raw).toBe(REPRICED);
    expect(result.offers[0].price.total.amount).toBe('34411.54');
    expect(result.warnings[0].code).toBe(37200);
  });

  it('accepts the previous offer as a converted Offer and as a single object', () => {
    const previousOffer = fromFlightOffer(PRICED, CTX);
    expect(fromPricingResponse(changedFx, { ctx: CTX, previous: previousOffer }).from.amount).toBe(
      '32017.54'
    );
    expect(fromPricingResponse(changedFx, { ctx: CTX, previous: PRICED }).changed).toBe(true);
  });

  it('flags a silent class or brand change even when the totals are identical (C-21)', () => {
    const reclassed = JSON.parse(JSON.stringify(pricingFx));
    reclassed.warnings = [];
    reclassed.data.flightOffers[0].travelerPricings[1].fareDetailsBySegment[1].class = 'W';
    const byClass = fromPricingResponse(reclassed, { ctx: CTX, previous: [PRICED] });
    expect(byClass.changed).toBe(true);
    expect(byClass.changeReasons).toEqual(['class']);
    expect(byClass.from).toEqual(byClass.to);

    const rebranded = JSON.parse(JSON.stringify(pricingFx));
    rebranded.warnings = [];
    rebranded.data.flightOffers[0].travelerPricings[0].fareDetailsBySegment[0].brandedFare =
      'ECOFLEX';
    expect(fromPricingResponse(rebranded, { ctx: CTX, previous: [PRICED] }).changeReasons).toEqual([
      'brandedFare',
    ]);
  });

  it('counts a 37200 warning as a change even without a previous offer', () => {
    const result = fromPricingResponse(changedFx, { ctx: CTX });
    expect(result.changed).toBe(true);
    expect(result.changeReasons).toEqual(['warning']);
    expect(result.from).toBeUndefined();
  });
});

describe('fromPricingResponse — several offers (split mode)', () => {
  it('prices the renumbered one-way pair and synthesises the combined offer named after the originals', () => {
    const request = toPricingRequest([OUT_2, IN_3]);
    const envelope = {
      data: { type: 'flight-offers-pricing', flightOffers: request.body.data.flightOffers },
      dictionaries: onewayOutFx.dictionaries,
    };
    const result = fromPricingResponse(envelope, { ctx: CTX, previous: [OUT_2, IN_3] });
    expect(result.offers.map((o) => o.id)).toEqual(['s1:1', 's1:2']);
    expect(result.changed).toBe(false);
    expect(result.from).toEqual({ amount: '32451.45', currency: 'INR' });
    expect(result.to).toEqual({ amount: '32451.45', currency: 'INR' });
    const { combined } = result;
    expect(combined.id).toBe('s1:2+3');
    expect(combined.slices).toHaveLength(2);
    expect(combined.price.total).toEqual({ amount: '32451.45', currency: 'INR' });
    expect(combined.tickets).toHaveLength(2);
    expect(combined.raw).toEqual([
      request.body.data.flightOffers[0],
      request.body.data.flightOffers[1],
    ]);
  });
});

// ── fromBookingRequirements ─────────────────────────────────────────────────────────────────────

describe('fromBookingRequirements', () => {
  const tps = [
    { travelerId: '1', travelerType: 'ADULT' },
    { travelerId: '2', travelerType: 'ADULT' },
    { travelerId: '3', travelerType: 'CHILD' },
  ];

  it('ORs per-traveler flags per PaxType and keeps them per traveler', () => {
    const br = {
      mailingAddressRequired: true,
      invoiceAddressRequired: true,
      postalCodeRequired: false,
      travelerRequirements: [
        {
          travelerId: '1',
          documentRequired: true,
          genderRequired: false,
          dateOfBirthRequired: true,
        },
        {
          travelerId: '2',
          documentRequired: false,
          genderRequired: true,
          redressRequiredIfAny: true,
          spanishResidentDiscountRequired: true,
          documentIssuanceCityRequired: true,
        },
        { travelerId: '3', airFranceDiscountRequired: false },
      ],
    };
    const out = fromBookingRequirements(br, tps);
    expect(out.perType.ADT.documents).toEqual([
      { types: ['passport', 'national_id', 'visa'], required: true },
    ]);
    expect(out.perType.ADT.fields).toEqual([
      { path: 'gender', required: true, options: ['M', 'F'] },
      { path: 'dob', required: true },
      { path: 'documents[].issuanceLocation', required: true },
      { path: 'redressNumber', required: false },
      { path: 'discountEligibility', required: true, options: ['SPANISH_RESIDENT'] },
    ]);
    expect(out.perType.CHD).toEqual({
      fields: [{ path: 'discountEligibility', required: false }],
      documents: [],
    });
    expect(out.perTraveler['1'].documents[0].required).toBe(true);
    expect(out.perTraveler['2'].documents[0].required).toBe(false);
    expect(out.perTraveler['1'].fields).toEqual([
      { path: 'gender', required: false, options: ['M', 'F'] },
      { path: 'dob', required: true },
    ]);
    expect(out.apis).toBe(true);
    expect(out.contact).toEqual([
      { path: 'address.postalCode', required: false },
      { path: 'address', required: true },
      { path: 'gst.address', required: true },
    ]);
    expect(out.gstAvailable).toBe(true);
    expect(out.threeDsRequired).toBeUndefined();
  });

  it('falls back to ADT for an unknown traveler, honours options and copes with no input', () => {
    const out = fromBookingRequirements(
      {
        travelerRequirements: [{ travelerId: '9', genderRequired: true }],
        threeDomainSecureRequirements: [
          { flightOfferIds: ['1'], is3dsAuthenticationRequired: false },
        ],
      },
      [],
      { ageRules: { maxPax: 18 }, nameRules: { maxLength: 29 }, gstAvailable: true }
    );
    expect(Object.keys(out.perType)).toEqual(['ADT']);
    expect(out.threeDsRequired).toBe(false);
    expect(out.ageRules.maxPax).toBe(18);
    expect(out.ageRules.infantMax).toBe(2);
    expect(out.nameRules).toEqual({ maxLength: 29, charset: 'latin', maxCombinedLength: 59 });
    expect(out.gstAvailable).toBe(true);

    const empty = fromBookingRequirements(undefined, tps);
    expect(Object.keys(empty.perType).sort()).toEqual(['ADT', 'CHD']);
    expect(empty.perType.ADT).toEqual({ fields: [], documents: [] });
    expect(empty.contact).toEqual([]);
    expect(empty.apis).toBe(false);
    expect(empty.perTraveler).toBeUndefined();
    expect(empty.threeDsRequired).toBeUndefined();
    expect(empty.raw).toBeUndefined();
  });
});

// ── catalogue helpers ───────────────────────────────────────────────────────────────────────────

describe('fromBags / fromOtherServices / fromCreditCardFees / fromDetailedFareRules', () => {
  it('strips the additional-collection suffix, converts LB and copes without a context', () => {
    const [bag] = fromBags({
      7: {
        quantity: 2,
        weight: 50,
        weightUnit: 'LB',
        name: 'CHECKED_BAG',
        price: { amount: '514.13A', currencyCode: 'usd' },
        bookableByItinerary: true,
        segmentIds: ['40'],
        travelerIds: ['1'],
        descriptions: ['TWO BAGS', 'UP TO 23KG EACH'],
      },
    });
    expect(bag).toMatchObject({
      id: '7',
      type: 'baggage',
      label: 'TWO BAGS',
      description: 'UP TO 23KG EACH',
      price: { amount: '514.13', currency: 'USD' },
      scope: 'per_passenger_slice',
      segmentId: '40',
    });
    expect(bag.eligiblePassengerTypes).toBeUndefined();
    expect(bag.meta).toMatchObject({ additionalCollection: true, weightKg: 22.7, quantity: 2 });
    expect(fromBags({ 1: { name: 'CHECKED_BAG' } })).toEqual([]);
    expect(fromBags(undefined)).toEqual([]);
    expect(
      fromBags({ 2: { name: 'CABIN_BAG', price: { amount: '5', currencyCode: 'EUR' } } })[0]
    ).toMatchObject({
      type: 'cabin_baggage',
      label: 'Cabin bag',
      price: { amount: '5.00', currency: 'EUR' },
    });
  });

  it('derives the service scope from the bookable flags and lower-cases unknown names', () => {
    const price = { amount: '10.00', currencyCode: 'EUR' };
    const services = fromOtherServices({
      a: { name: 'FAST_TRACK', price, bookableByTraveler: true, bookableByItinerary: true },
      b: { name: 'PRIORITY_BOARDING', price, bookableByTraveler: true },
      c: { name: 'AIRPORT_CHECKIN', price, bookableByItinerary: true },
      d: { name: 'LOUNGE_ACCESS', price },
      e: { name: 'NO_PRICE' },
    });
    expect(services.map((s) => [s.id, s.type, s.scope, s.label])).toEqual([
      ['a', 'fast_track', 'per_passenger_slice', 'Fast track'],
      ['b', 'priority_boarding', 'per_passenger', 'Priority boarding'],
      ['c', 'airport_checkin', 'per_booking', 'Airport checkin'],
      ['d', 'lounge_access', 'per_booking', 'Lounge access'],
    ]);
    expect(fromOtherServices(null)).toEqual([]);
  });

  it('maps card fees and skips entries without an amount', () => {
    expect(
      fromCreditCardFees({
        1: { brand: 'VISA' },
        2: { brand: 'DINERS', amount: '3', currency: 'EUR' },
      })
    ).toEqual([
      {
        id: '2',
        brand: 'DINERS',
        amount: { amount: '3.00', currency: 'EUR' },
        raw: { brand: 'DINERS', amount: '3', currency: 'EUR' },
      },
    ]);
    expect(fromCreditCardFees([])).toEqual([]);
    expect(fromCreditCardFees('nope')).toEqual([]);
  });

  it('parses detailed fare rules as a map, a single object or an array, dropping duplicates', () => {
    const single = {
      fareBasis: 'YFLEX',
      fareNotes: {
        descriptions: [{ descriptionType: 'PENALTIES', text: 'NONE' }, { text: 'FREE TEXT' }],
      },
    };
    expect(fromDetailedFareRules(single)).toEqual([
      { title: 'YFLEX — Penalties', text: 'NONE', fareBasis: 'YFLEX', category: 'PENALTIES' },
      { title: 'YFLEX', text: 'FREE TEXT', fareBasis: 'YFLEX' },
    ]);
    const duplicated = fromDetailedFareRules([single, { ...single, segmentId: '2' }]);
    expect(duplicated).toHaveLength(2);
    expect(fromDetailedFareRules(pricingFx.included['detailed-fare-rules'])).toHaveLength(4);
    expect(fromDetailedFareRules(undefined)).toEqual([]);
    expect(fromDetailedFareRules({ 1: { fareBasis: 'X' } })).toEqual([]);
  });
});

// ── toAdditionalServices ────────────────────────────────────────────────────────────────────────

describe('toAdditionalServices', () => {
  const selections = [
    {
      id: 'sel1',
      serviceId: '1',
      type: 'baggage',
      passengerId: 's1:1',
      quantity: 1,
      price: { amount: '1500.00', currency: 'INR' },
    },
    {
      id: 'sel2',
      serviceId: '1',
      type: 'baggage',
      passengerId: '1',
      segmentId: 's1:1:11',
      quantity: 1,
      price: { amount: '1500.00', currency: 'INR' },
    },
    {
      id: 'sel3',
      serviceId: 'seat-2-12A',
      type: 'seat',
      passengerId: '2',
      segmentId: 's1:1:2',
      quantity: 1,
      detail: '12a',
      price: { amount: '0', currency: 'INR' },
    },
    {
      id: 'sel4',
      serviceId: '1',
      type: 'priority_boarding',
      sliceId: 's1:1:1',
      quantity: 1,
      price: { amount: '499.00', currency: 'INR' },
    },
    {
      id: 'sel5',
      serviceId: 'm1',
      type: 'meal',
      passengerId: '3',
      quantity: 1,
      price: { amount: '0', currency: 'INR' },
    },
    {
      id: 'sel6',
      serviceId: '2',
      type: 'cabin_baggage',
      passengerId: '3',
      quantity: 2,
      price: { amount: '0', currency: 'INR' },
    },
  ];

  it(
    'rebuilds fareDetailsBySegment[].additionalServices from the selection and validates the offer',
    SLOW,
    () => {
      const before = snapshot(PRICED);
      const out = toAdditionalServices(selections, PRICED);
      expect(snapshot(PRICED)).toBe(before);
      expect(out).not.toBe(PRICED);

      const t1 = fdbsOf(out, '1');
      expect(t1[0].additionalServices).toEqual({ chargeableCheckedBags: { id: '1', quantity: 1 } });
      expect(t1[1].additionalServices).toEqual({
        chargeableCheckedBags: { id: '1', quantity: 2 },
        otherServices: ['PRIORITY_BOARDING'],
      });

      const t2 = fdbsOf(out, '2');
      expect(t2[0].additionalServices).toEqual({
        chargeableSeat: { id: 'seat-2-12A', number: '12A' },
      });
      expect(t2[1].additionalServices).toEqual({ otherServices: ['PRIORITY_BOARDING'] });

      const t3 = fdbsOf(out, '3');
      expect(t3[0].additionalServices).toEqual({ chargeableCabinBags: { id: '2', quantity: 2 } });
      expect(t3[1].additionalServices).toEqual({
        chargeableCabinBags: { id: '2', quantity: 2 },
        otherServices: ['PRIORITY_BOARDING'],
      });

      const t4 = fdbsOf(out, '4');
      expect(t4[0].additionalServices).toBeUndefined();
      expect(t4[1].additionalServices).toEqual({ otherServices: ['PRIORITY_BOARDING'] });

      expectValid(PRICING, 'FlightOffer', rfc(out));
    }
  );

  it('clears the previous additionalServices when nothing is selected and accepts an Offer', () => {
    expect(fdbsOf(PRICED, '1')[0].additionalServices).toBeDefined();
    const cleared = toAdditionalServices([], fromFlightOffer(PRICED, CTX));
    for (const tp of cleared.travelerPricings) {
      for (const f of tp.fareDetailsBySegment) expect(f.additionalServices).toBeUndefined();
    }
    expect(cleared.id).toBe('1');
    expect(toAdditionalServices(undefined, undefined)).toEqual({});
  });
});

// ── combineOffers ───────────────────────────────────────────────────────────────────────────────

describe('combineOffers', () => {
  const request = toPricingRequest([OUT_2, IN_3]);
  const [rawOut, rawIn] = request.body.data.flightOffers;
  const ctx = { ...CTX, dictionaries: onewayOutFx.dictionaries };
  const outOffer = fromFlightOffer(rawOut, ctx);
  const inOffer = fromFlightOffer(rawIn, ctx);

  it('synthesises the combined offer: ids joined, slices concatenated, price summed, tickets per offer', () => {
    const combined = combineOffers([outOffer, inOffer], { ...ctx, ids: ['2', '3'] });
    expect(combined.id).toBe('s1:2+3');
    expect(combined.slices).toEqual([...outOffer.slices, ...inOffer.slices]);
    expect(combined.price.total).toEqual({ amount: '32451.45', currency: 'INR' });
    expect(combined.price.base.amount).toBe(
      (Number(outOffer.price.base.amount) + Number(inOffer.price.base.amount)).toFixed(2)
    );
    expect(combined.passengers.map((p) => [p.type, p.count])).toEqual([
      ['ADT', 2],
      ['CHD', 1],
      ['INF', 1],
    ]);
    const adult = combined.passengers.find((p) => p.type === 'ADT');
    const adultOut = outOffer.passengers.find((p) => p.type === 'ADT');
    const adultIn = inOffer.passengers.find((p) => p.type === 'ADT');
    expect(adult.unit.total.amount).toBe(
      (Number(adultOut.unit.total.amount) + Number(adultIn.unit.total.amount)).toFixed(2)
    );
    expect(combined.tickets).toHaveLength(2);
    expect(combined.tickets.map((t) => t.segmentIds)).toEqual([['s1:1:1'], ['s1:2:2']]);
    expect(combined.tickets.map((t) => t.carrier)).toEqual([outOffer.owner, inOffer.owner]);
    expect(new Set(combined.tickets.map((t) => t.id)).size).toBe(2);
    const synthesised = combineOffers(
      [
        { ...outOffer, tickets: undefined },
        { ...inOffer, tickets: [] },
      ],
      CTX
    );
    expect(synthesised.tickets).toEqual([
      { id: 's1:1', segmentIds: ['s1:1:1'], carrier: outOffer.owner },
      { id: 's1:2', segmentIds: ['s1:2:2'], carrier: inOffer.owner },
    ]);
    expect(combined.owner).toEqual(outOffer.owner);
    expect(combined.oneWayCombinable).toBe(false);
    expect(combined.selfTransfer).toBe(false);
    expect(combined.baggage.bySegment).toBe(true);
    expect(combined.raw).toEqual([rawOut, rawIn]);
    expect(combined.lastTicketingDate).toBe(
      [outOffer.lastTicketingDate, inOffer.lastTicketingDate].filter(Boolean).sort()[0]
    );
  });

  it('names the offer after the wire ids when no ids are given', () => {
    expect(combineOffers([outOffer, inOffer], CTX).id).toBe('s1:1+2');
    expect(combineOffers([outOffer, inOffer]).id).toBe('1+2');
  });

  it('keeps the most restrictive conditions, the smallest seat counts and the earliest deadline', () => {
    const base = (over) => ({
      ...outOffer,
      ...over,
      price: outOffer.price,
      passengers: outOffer.passengers,
    });
    const a = base({
      id: 'a',
      conditions: {
        refundable: true,
        changeable: true,
        changePenalty: { amount: '3000.00', currency: 'INR' },
        holdAllowed: true,
        notes: ['n1'],
        voidUntil: '2026-11-02T00:00:00+05:30',
      },
      seatsLeft: 7,
      bookableSeats: 7,
      emissionsKg: 95,
      lastTicketingDate: '2026-10-25',
      tickets: [{ id: 'tk', segmentIds: ['x'], carrier: outOffer.owner }],
      instantTicketingRequired: true,
      warnings: [{ code: 1 }],
    });
    const b = base({
      id: 'b',
      conditions: {
        refundable: 'partial',
        changeable: false,
        changePenalty: { amount: '4500.00', currency: 'INR' },
        cancelPenalty: { amount: '1000.00', currency: 'INR' },
        holdAllowed: false,
        notes: ['n1', 'n2'],
        voidUntil: '2026-11-01T00:00:00+05:30',
      },
      seatsLeft: 3,
      bookableSeats: 3,
      emissionsKg: 105,
      lastTicketingDate: '2026-10-21',
    });
    const combined = combineOffers([a, b], CTX);
    expect(combined.conditions).toEqual({
      refundable: 'partial',
      changeable: false,
      changePenalty: { amount: '4500.00', currency: 'INR' },
      cancelPenalty: { amount: '1000.00', currency: 'INR' },
      holdAllowed: false,
      voidUntil: '2026-11-01T00:00:00+05:30',
      notes: ['n1', 'n2'],
    });
    expect(combined.seatsLeft).toBe(3);
    expect(combined.bookableSeats).toBe(3);
    expect(combined.emissionsKg).toBe(200);
    expect(combined.lastTicketingDate).toBe('2026-10-21');
    expect(combined.instantTicketingRequired).toBe(true);
    expect(combined.paymentCardRequired).toBeUndefined();
    expect(combined.tickets[0]).toEqual({ id: 'tk', segmentIds: ['x'], carrier: outOffer.owner });
    expect(combined.tickets).toHaveLength(2);
    expect(combined.warnings).toEqual([{ code: 1 }]);
    const c = base({ id: 'c', conditions: { refundable: false, changeable: true } });
    expect(combineOffers([a, c], CTX).conditions.refundable).toBe(false);
  });

  it('refuses offers priced in different currencies with a ValidationError', () => {
    const euro = {
      ...inOffer,
      price: { ...inOffer.price, total: { amount: '200.00', currency: 'EUR' } },
    };
    let error;
    try {
      combineOffers([outOffer, euro], CTX);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues[0]).toMatchObject({
      path: 'offers[1].price.total.currency',
      code: 'currency_mismatch',
      params: { expected: 'INR', actual: 'EUR' },
    });
  });

  it('returns a single offer as it is and undefined for none', () => {
    expect(combineOffers([outOffer], CTX)).toBe(outOffer);
    expect(combineOffers([], CTX)).toBeUndefined();
    expect(combineOffers(undefined)).toBeUndefined();
  });
});
