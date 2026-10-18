/**
 * Amadeus Flight Offers Price ↔ SDK conversions (docs/BACKEND-MAPPING.md §6 `pricing.js`, §2.3
 * `offers.reprice` / `offers.combine` / `offers.baggageOptions`, §2.4 `itinerary.create` / `reprice` /
 * `requirements` / `setTravelers`, §3.5–3.7, §3.10, §3.11, §4 C‑3 / C‑21 … C‑26): the pricing request
 * (`toPricingRequest`, renumbering offer and segment ids for multi‑offer bodies), traveler capture on the
 * wire (`toTravelers`, `toContact`, `toIdentityDocument` / `fromIdentityDocument` — shared with orders),
 * the priced response (`fromPricingResponse`: offers via `search.js#fromFlightOffer`, the `{ changed,
 * from, to }` diff the SDK has to compute itself because Amadeus only returns the new price, booking
 * requirements, the ancillary catalogue seeded from `included.bags` / `included['other-services']`, card
 * fees, detailed fare rules, 3DS), `fromBookingRequirements` (per‑`travelerId` flags OR‑ed per `PaxType`
 * and kept per traveler), `toAdditionalServices` (folds selected seats / bags / services into
 * `fareDetailsBySegment[].additionalServices` so the next pricing includes them) and `combineOffers`
 * (the synthesised combined `Offer` of split mode: Amadeus prices several one‑way offers side by side and
 * never merges them). Pure functions only: no I/O, no state, no timers, no DOM, no logging; inputs are
 * never mutated; every converted object keeps the untouched wire payload on `raw`; ids are scoped with
 * `common.scopeId`; places come from the optional `places` lookup or partial `Place`s built from
 * `dictionaries.locations` (C‑19). The only errors constructed are `ValidationError`s for a request that
 * cannot be built (no offer, more than six) and for offers that cannot be combined (mixed currencies).
 */

import { ValidationError } from '../../errors/index.js';
import { add as addMoney, compare as compareMoney } from '../../utils/money.js';
import { clone } from '../../utils/object.js';
import {
  DOCUMENT_TYPE,
  GENDER,
  PAX_TYPE,
  SERVICE_NAME,
  fromWire,
  normalizeDate,
  readEither,
  renumberOffers,
  scopeId,
  toMoney,
  toWire,
  unscopeId,
} from './common.js';
import { fromFlightOffer } from './search.js';

/** @typedef {import('../../types.js').Money} Money */
/** @typedef {import('../../types.js').Offer} Offer */
/** @typedef {import('../../types.js').PaxType} PaxType */
/** @typedef {import('../../types.js').PaxPrice} PaxPrice */
/** @typedef {import('../../types.js').PriceBreakdown} PriceBreakdown */
/** @typedef {import('../../types.js').Conditions} Conditions */
/** @typedef {import('../../types.js').TicketGroup} TicketGroup */
/** @typedef {import('../../types.js').Traveler} Traveler */
/** @typedef {import('../../types.js').TravelDocument} TravelDocument */
/** @typedef {import('../../types.js').Contact} Contact */
/** @typedef {import('../../types.js').Phone} Phone */
/** @typedef {import('../../types.js').Address} Address */
/** @typedef {import('../../types.js').PassengerSlot} PassengerSlot */
/** @typedef {import('../../types.js').TravelerRequirements} TravelerRequirements */
/** @typedef {import('../../types.js').FieldRule} FieldRule */
/** @typedef {import('../../types.js').DocumentRule} DocumentRule */
/** @typedef {import('../../types.js').AgeRules} AgeRules */
/** @typedef {import('../../types.js').Service} Service */
/** @typedef {import('../../types.js').SelectedAncillary} SelectedAncillary */
/** @typedef {import('../../types.js').AncillaryCatalog} AncillaryCatalog */
/** @typedef {import('../../types.js').Issue} Issue */
/** @typedef {import('./common.js').Dictionaries} Dictionaries */
/** @typedef {import('./common.js').PlacesLookup} PlacesLookup */
/** @typedef {import('./common.js').RenumberResult} RenumberResult */

/**
 * Conversion context handed to every `from*` function here and through to `fromFlightOffer`: the search
 * session the ids are scoped under, the response `dictionaries`, the optional `Place` hydration source
 * and, for the catalogue builders, the raw offers / traveler pricings the services refer to.
 * `ids` lets `combineOffers` name the combined offer after the original slice offer ids.
 * @typedef {Object} ConversionContext
 * @property {string} [sessionId]
 * @property {Dictionaries} [dictionaries]
 * @property {PlacesLookup} [places]
 * @property {Record<string, unknown>[]} [rawOffers]  Raw `FlightOffer`s the services / ids belong to
 * @property {Record<string, unknown>[]} [travelerPricings]  `travelerPricings[]` across those offers
 * @property {(string|number)[]} [ids]  Wire ids to join with `'+'` for a combined offer
 */

/**
 * A `Payment` entry of the pricing body in SDK terms: `brand` in SDK (`'visa'`, `'amex'`) or wire
 * spelling, the first six digits as `bin` / `binNumber`, and the offers it pays (defaults to all).
 * @typedef {{ brand?: string, bin?: string|number, binNumber?: string|number, flightOfferIds?: (string|number)[] }} PaymentInput
 */

/**
 * Options of `toPricingRequest`.
 * @typedef {Object} PricingRequestOptions
 * @property {Traveler[]|Record<string, unknown>[]} [travelers]  SDK `Traveler`s (converted with
 *   `toTravelers`) or Amadeus `Traveler`s (sent as given)
 * @property {Contact} [contact]  Booking contact folded into the lead traveler (SDK travelers only)
 * @property {PassengerSlot[]} [slots]  Slots used to assign wire ids (SDK travelers only)
 * @property {PaymentInput[]} [payments]  Card brands / BINs for `include=credit-card-fees`
 * @property {boolean} [fareRules=true]  `additionalInformation.fareRules`
 * @property {(string)[]|string} [include]  Sub‑resources: `bags`, `other-services`,
 *   `detailed-fare-rules`, `credit-card-fees` (SDK aliases accepted; csv string accepted)
 * @property {boolean} [forceClass=true]  Price the booking classes as given (C‑21)
 */

/**
 * Result of `toPricingRequest`: the body (`Get_Price_Query`), the query parameters and the renumbering
 * map (`map.offers[newId]` → input position and wire id; identity for a single offer).
 * @typedef {{
 *   body: { data: Record<string, unknown> },
 *   query: { forceClass: boolean, include?: string[] },
 *   map: RenumberResult['map'],
 * }} PricingRequest
 */

/**
 * Card fee of `included['credit-card-fees']`.
 * @typedef {{ id: string, brand: string, amount: Money, offerId?: string, raw: Record<string, unknown> }} CardFee
 */

/**
 * One detailed fare rule text (`FareRules.raw[]` entry plus its locators).
 * @typedef {{ title: string, text: string, fareBasis?: string, segmentId?: string, category?: string }} FareRuleText
 */

/**
 * Result of `fromPricingResponse`.
 * @typedef {Object} PricingResult
 * @property {Offer[]} offers  One `Offer` per `data.flightOffers[]` (raw replaced by the priced object)
 * @property {Offer} [combined]  The synthesised combined offer when more than one offer was priced
 * @property {boolean} changed  The price or the fare moved against `previous` (or Amadeus warned 37200)
 * @property {Money} [from]  Previous grand total (sum over offers), when `previous` was given
 * @property {Money} [to]  New grand total (sum over offers)
 * @property {string[]} changeReasons  What moved: `grandTotal`, `currency`, `travelerTotal`, `class`, `brandedFare`, `warning`
 * @property {TravelerRequirements} requirements
 * @property {AncillaryCatalog} catalog  Services seeded from `included.bags` / `included['other-services']`
 * @property {CardFee[]} cardFees
 * @property {FareRuleText[]} detailedFareRules
 * @property {boolean} threeDsRequired
 * @property {Issue[]} warnings  `warnings[]` of the envelope, verbatim
 * @property {Record<string, unknown>} raw  The untouched envelope
 */

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

const MAX_OFFERS = 6;
const WIRE_TYPE = 'flight-offers-pricing';

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {string|undefined} */
function str(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** @param {unknown} v @returns {number|undefined} */
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Own‑property read that never hits the prototype. */
function own(table, key) {
  return isObject(table) && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : undefined;
}

/** Assign `value` under `key` only when it is defined (keeps wire bodies free of `undefined`). */
function put(target, key, value) {
  if (value !== undefined && value !== null && key !== '__proto__') target[key] = value;
  return target;
}

/** Array of plain objects out of anything (`undefined` / scalars give `[]`). */
function objects(list) {
  return Array.isArray(list) ? list.filter(isObject) : [];
}

/** Entries of a wire map (`included.bags`), tolerating an array or a single object (C‑35). */
function mapEntries(map) {
  if (Array.isArray(map)) return map.map((v, i) => [String(i + 1), v]).filter(([, v]) => isObject(v));
  if (!isObject(map)) return [];
  if (!Object.values(map).some(isObject) && Object.keys(map).length > 0) return [['1', map]];
  return Object.entries(map).filter(([, v]) => isObject(v));
}

/** Unique strings, first occurrence wins. */
function uniq(list) {
  return [...new Set(list)];
}

/** Part of an SDK id after the last `':'` (`'sess:1:2'` → `'2'`), the whole string without one. */
function tail(id) {
  if (id === null || id === undefined) return undefined;
  const text = String(id);
  const at = text.lastIndexOf(':');
  return at < 0 ? text : text.slice(at + 1);
}

/** `PRIORITY_BOARDING` → `Priority boarding`. */
function titleize(code) {
  const text = String(code).replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Latin‑only text for GDS name / city fields (`[a-zA-Z -]`): diacritics stripped, the rest spaced. */
function latin(text, max) {
  const value = str(text);
  if (!value) return undefined;
  const ascii = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ascii === '') return undefined;
  return max ? ascii.slice(0, max).trim() : ascii;
}

/** ISO‑3166 alpha‑2 upper‑cased, else `undefined`. */
function country(v) {
  const code = str(v);
  return code && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : undefined;
}

/** Digits only (`'+91 98765-43210'` → `'919876543210'`); `undefined` when nothing is left. */
function digits(v) {
  const text = str(v)?.replace(/\D+/g, '');
  return text ? text : undefined;
}

/**
 * Amadeus `countryCallingCode` (`[0-9+]{2,5}`): digits only, a one‑digit code keeps its `'+'` so it
 * reaches the two‑character minimum (C‑25).
 */
function callingCode(v) {
  const d = digits(v);
  if (!d) return undefined;
  return d.length === 1 ? `+${d}` : d.slice(0, 5);
}

/** Raw `FlightOffer` out of an `Offer` (`.raw`) or a wire object. */
function rawOf(offer) {
  if (!isObject(offer)) return undefined;
  if (isObject(offer.raw) && (offer.raw.itineraries || offer.raw.travelerPricings)) return offer.raw;
  return offer;
}

/** Raw `FlightOffer[]` out of an array (or one) of raw offers / `Offer`s. */
function rawOffersOf(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return list.map(rawOf).filter(isObject);
}

/** Segments of a raw offer in itinerary order, each with its itinerary index. */
function rawSegments(offer) {
  /** @type {{ itinerary: number, segment: Record<string, unknown> }[]} */
  const out = [];
  objects(offer?.itineraries).forEach((it, itinerary) => {
    for (const segment of objects(it.segments)) out.push({ itinerary, segment });
  });
  return out;
}

/** `fareDetailsBySegment` tolerant of the example spelling (C‑35). */
function fareDetails(tp) {
  return objects(readEither(tp, 'fareDetailsBySegment', 'fareDetailBySegment'));
}

/** Grand total of a raw offer as `Money` (`grandTotal`, else `total`). */
function grandTotalOf(raw) {
  const price = isObject(raw?.price) ? raw.price : {};
  return toMoney(price.grandTotal ?? price.total, price);
}

/** `Money` equality by value and currency (`'1.0'` equals `'1.00'`); `undefined`s compare by presence. */
function sameMoney(a, b) {
  if (!a || !b) return !a && !b;
  if (a.currency !== b.currency) return false;
  try {
    return compareMoney(a, b) === 0;
  } catch {
    return a.amount === b.amount;
  }
}

/** Sum of `Money`s (`undefined` entries skipped); `undefined` for nothing to sum; throws on mismatch. */
function sumMoney(list) {
  let total;
  for (const m of list) {
    if (!m) continue;
    total = total ? addMoney(total, m) : { amount: m.amount, currency: m.currency };
  }
  return total;
}

/** `PaxType` of a raw `travelerPricings[]` entry. */
function paxTypeOf(tp) {
  return /** @type {PaxType|undefined} */ (fromWire(PAX_TYPE, str(tp?.travelerType)));
}

/** `travelerId → PaxType` out of `travelerPricings[]`. */
function travelerTypes(travelerPricings) {
  /** @type {Map<string, PaxType>} */
  const out = new Map();
  for (const tp of objects(travelerPricings)) {
    const id = str(tp.travelerId);
    const type = paxTypeOf(tp);
    if (id && type && !out.has(id)) out.set(id, type);
  }
  return out;
}

// ── request: toPricingRequest ───────────────────────────────────────────────────────────────────

/** Spec order of the `include` query values. */
const INCLUDE_VALUES = ['credit-card-fees', 'bags', 'other-services', 'detailed-fare-rules'];

/** SDK spellings → `include` values. */
const INCLUDE_ALIASES = Object.freeze({
  bags: 'bags',
  bag: 'bags',
  baggage: 'bags',
  'other-services': 'other-services',
  otherservices: 'other-services',
  services: 'other-services',
  'detailed-fare-rules': 'detailed-fare-rules',
  detailedfarerules: 'detailed-fare-rules',
  'fare-rules': 'detailed-fare-rules',
  farerules: 'detailed-fare-rules',
  'credit-card-fees': 'credit-card-fees',
  creditcardfees: 'credit-card-fees',
  'card-fees': 'credit-card-fees',
  cardfees: 'credit-card-fees',
});

/** SDK card brand spellings → `PaymentBrand`. */
const CARD_BRANDS = Object.freeze({
  visa: 'VISA',
  amex: 'AMERICAN_EXPRESS',
  'american-express': 'AMERICAN_EXPRESS',
  mastercard: 'MASTERCARD',
  'master-card': 'MASTERCARD',
  mc: 'MASTERCARD',
  maestro: 'MAESTRO',
  diners: 'DINERS',
  'diners-club': 'DINERS',
  'visa-electron': 'VISA_ELECTRON',
  'visa-debit': 'VISA_DEBIT',
  'mastercard-debit': 'MASTERCARD_DEBIT',
  uatp: 'UATP_AIRPLUS',
  airplus: 'UATP_AIRPLUS',
});

/** Normalise an `include` list (array or csv string, SDK aliases) into spec values in spec order. */
function normaliseInclude(include, withCardFees) {
  const raw = Array.isArray(include)
    ? include
    : typeof include === 'string'
      ? include.split(',')
      : [];
  const wanted = new Set();
  for (const entry of raw) {
    const key = str(entry)
      ?.toLowerCase()
      .replace(/[_\s]+/g, '-');
    if (!key) continue;
    wanted.add(own(INCLUDE_ALIASES, key) ?? own(INCLUDE_ALIASES, key.replace(/-/g, '')) ?? key);
  }
  if (withCardFees) wanted.add('credit-card-fees');
  return [
    ...INCLUDE_VALUES.filter((v) => wanted.has(v)),
    ...[...wanted].filter((v) => !INCLUDE_VALUES.includes(v)),
  ];
}

/** SDK or wire card brand → `PaymentBrand` (unknown values upper‑cased, C‑35). */
function toBrand(v) {
  const text = str(v);
  if (!text) return undefined;
  const key = text.toLowerCase().replace(/[\s_]+/g, '-');
  return own(CARD_BRANDS, key) ?? text.toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * `payments[]` of the body: brand mapped, `binNumber` as the integer the schema declares (first six
 * digits), `flightOfferIds` translated through the renumbering map (defaults to every offer).
 */
function toPayments(payments, map, offerIds) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const p of objects(payments)) {
    const entry = {};
    put(entry, 'brand', toBrand(p.brand));
    const bin = digits(p.binNumber ?? p.bin);
    if (bin && bin.length >= 6) entry.binNumber = Number(bin.slice(0, 6));
    const ids = Array.isArray(p.flightOfferIds)
      ? uniq(
          p.flightOfferIds
            .map((id) => translateOfferId(id, map, offerIds))
            .filter((id) => id !== undefined)
        )
      : offerIds;
    if (ids.length) entry.flightOfferIds = ids;
    if (Object.keys(entry).length) out.push(entry);
  }
  return out;
}

/** An input / SDK offer id → the id it carries in the request body (via the renumbering map). */
function translateOfferId(id, map, offerIds) {
  const wire = tail(unscopeId(id).id ?? id);
  if (wire === undefined) return undefined;
  if (offerIds.includes(wire)) return wire;
  for (const [newId, entry] of Object.entries(map.offers)) {
    if (entry.id === wire) return newId;
  }
  return wire;
}

/** True when offer ids and segment ids are already unique across the offers (no renumbering needed). */
function idsUnique(offers) {
  const offerIds = new Set();
  const segmentIds = new Set();
  for (const offer of offers) {
    const id = str(offer.id);
    if (!id || offerIds.has(id)) return false;
    offerIds.add(id);
    for (const { segment } of rawSegments(offer)) {
      const sid = str(segment.id);
      if (!sid || segmentIds.has(sid)) return false;
      segmentIds.add(sid);
    }
  }
  return true;
}

/** Identity `RenumberResult` for offers sent with their own ids (deep copies, untouched ids). */
function keepIds(offers) {
  /** @type {RenumberResult} */
  const result = { offers: [], map: { offers: {}, segments: {}, byIndex: [] } };
  offers.forEach((source, index) => {
    const offer = clone(source);
    const id = String(offer.id);
    /** @type {Record<string, string>} */
    const segments = {};
    for (const { segment } of rawSegments(offer)) {
      const sid = String(segment.id);
      segments[sid] = sid;
      result.map.segments[sid] = { index, offerId: id, id: sid };
    }
    result.map.offers[id] = { index, id };
    result.map.byIndex.push({ id, segments });
    result.offers.push(offer);
  });
  return result;
}

/** True when the list looks like SDK `Traveler`s rather than Amadeus ones. */
function isSdkTravelers(list) {
  return list.some((t) => t.firstName !== undefined || t.lastName !== undefined || t.dob !== undefined);
}

/**
 * Build the `POST /v1/shopping/flight-offers/pricing` request (§2.3 `offers.reprice` / `offers.combine`,
 * §2.4): `{ body: { data: { type: 'flight-offers-pricing', flightOffers, travelers?, payments?,
 * additionalInformation: { fareRules } } }, query: { forceClass, include? }, map }`. `rawOffers` are raw
 * `FlightOffer`s or `Offer`s (their `raw` is used), one or up to six. Several offers — or offers whose
 * ids collide — are renumbered with `renumberOffers` (offers `'1'..'n'`, segments unique across the body,
 * `fareDetailsBySegment[].segmentId` remapped, C‑3 / C‑8) and `map` says how; a single offer with unique
 * ids is sent as it is (deep copy, identity `map`) so its SDK ids survive the round trip. `travelers`
 * may be SDK `Traveler`s (converted through `toTravelers` with `contact` / `slots`) or Amadeus ones.
 * `payments` add `include=credit-card-fees` automatically. The request `type` is `'flight-offers-pricing'`
 * (C‑21). `forceClass` defaults to `true` (a fare has been chosen); `fareRules` to `true`.
 * @param {Record<string, unknown>[]|Record<string, unknown>|Offer[]|Offer} rawOffers
 * @param {PricingRequestOptions} [options]
 * @returns {PricingRequest}
 * @throws {ValidationError} when no offer is given or more than six
 */
export function toPricingRequest(rawOffers, options = {}) {
  const o = isObject(options) ? options : {};
  const offers = rawOffersOf(rawOffers);
  if (offers.length === 0) {
    throw new ValidationError('At least one flight offer is required to price', {
      issues: [{ path: 'offers', code: 'empty', message: 'no flight offer to price' }],
    });
  }
  if (offers.length > MAX_OFFERS) {
    throw new ValidationError(`At most ${MAX_OFFERS} flight offers can be priced together`, {
      issues: [
        {
          path: 'offers',
          code: 'too_many',
          message: `Amadeus prices at most ${MAX_OFFERS} offers per request`,
          params: { max: MAX_OFFERS, actual: offers.length },
        },
      ],
    });
  }
  const renumbered = offers.length > 1 || !idsUnique(offers) ? renumberOffers(offers) : keepIds(offers);
  const offerIds = renumbered.offers.map((offer) => String(offer.id));

  /** @type {Record<string, unknown>} */
  const data = { type: WIRE_TYPE, flightOffers: renumbered.offers };

  const travelerInput = objects(o.travelers);
  const travelers = isSdkTravelers(travelerInput)
    ? toTravelers(/** @type {Traveler[]} */ (travelerInput), o.contact, o.slots)
    : travelerInput.map((t) => clone(t));
  if (travelers.length) data.travelers = travelers;

  const payments = toPayments(o.payments, renumbered.map, offerIds);
  if (payments.length) data.payments = payments;

  data.additionalInformation = { fareRules: o.fareRules !== false };

  /** @type {PricingRequest['query']} */
  const query = { forceClass: o.forceClass !== false };
  const include = normaliseInclude(o.include, payments.length > 0);
  if (include.length) query.include = include;

  return { body: { data }, query, map: renumbered.map };
}

// ── travelers and contacts (§3.10, C‑24 … C‑26) ─────────────────────────────────────────────────

/** `Phone.type` → `PhoneDeviceType`. */
const PHONE_TYPES = Object.freeze({ mobile: 'MOBILE', landline: 'LANDLINE', fax: 'FAX' });

/** Wire document types `toIdentityDocument` can produce. */
const WIRE_DOCUMENT_TYPES = new Set(['VISA', 'PASSPORT', 'IDENTITY_CARD', 'KNOWN_TRAVELER', 'REDRESS']);

/** Passenger types that may act as the lead traveler (carry the booking contact). */
const LEAD_TYPES = new Set(['ADT', 'SRC', 'YTH', 'STU']);

/**
 * SDK `TravelDocument` → Amadeus `IdentityDocument` (§3.10, C‑24): `passport` ↔ `PASSPORT`, `national_id`
 * ↔ `IDENTITY_CARD`, `visa` ↔ `VISA` (wire spellings pass through); `issueDate` → `issuanceDate`, `expiry`
 * → `expiryDate`, `issuingCountry` → `issuanceCountry` (alpha‑2 upper‑cased), `nationality` (else
 * `defaults.nationality`, the traveler's), `issuanceLocation`, `birthPlace`, `birthCountry`,
 * `validityCountry`, `holder` (defaults to `true`). `driving_licence` / `other` have no Amadeus
 * counterpart and give `undefined` (the modules reject them before any request).
 * @param {TravelDocument|Record<string, unknown>|null|undefined} doc
 * @param {{ nationality?: string }} [defaults]
 * @returns {Record<string, unknown>|undefined}
 */
export function toIdentityDocument(doc, defaults = {}) {
  if (!isObject(doc)) return undefined;
  const documentType = toWire(DOCUMENT_TYPE, str(doc.type ?? doc.documentType));
  if (!documentType || !WIRE_DOCUMENT_TYPES.has(documentType)) return undefined;
  const d = isObject(defaults) ? defaults : {};
  /** @type {Record<string, unknown>} */
  const out = { documentType };
  put(out, 'number', str(doc.number));
  put(out, 'issuanceDate', normalizeDate(doc.issueDate ?? doc.issuanceDate));
  put(out, 'expiryDate', normalizeDate(doc.expiry ?? doc.expiryDate));
  put(out, 'issuanceCountry', country(doc.issuingCountry ?? doc.issuanceCountry));
  put(out, 'issuanceLocation', str(doc.issuanceLocation));
  put(out, 'nationality', country(doc.nationality ?? d.nationality));
  put(out, 'birthPlace', str(doc.birthPlace));
  put(out, 'birthCountry', country(doc.birthCountry));
  put(out, 'validityCountry', country(doc.validityCountry));
  out.holder = typeof doc.holder === 'boolean' ? doc.holder : true;
  return out;
}

/**
 * Amadeus `IdentityDocument` → SDK `TravelDocument` (§3.10): the reverse field mapping, `type` through
 * `DOCUMENT_TYPE` (`KNOWN_TRAVELER` / `REDRESS` read as `known_traveler` / `redress` so `orders.js` can
 * move them to `knownTravelerNumber` / `redressNumber`; unknown wire types read as `other`), the wire
 * object on `raw`. Non‑object input gives `undefined`.
 * @param {Record<string, unknown>|null|undefined} doc
 * @returns {(TravelDocument & { raw: Record<string, unknown> })|undefined}
 */
export function fromIdentityDocument(doc) {
  if (!isObject(doc)) return undefined;
  const wireType = str(doc.documentType);
  const mapped = wireType ? fromWire(DOCUMENT_TYPE, wireType) : undefined;
  const type = mapped && mapped !== wireType ? mapped : 'other';
  /** @type {TravelDocument & { raw: Record<string, unknown> }} */
  const out = {
    type: /** @type {TravelDocument['type']} */ (type),
    number: str(doc.number) ?? '',
    issuingCountry: country(doc.issuanceCountry) ?? '',
    expiry: normalizeDate(doc.expiryDate) ?? '',
    raw: doc,
  };
  put(out, 'nationality', country(doc.nationality));
  put(out, 'issueDate', normalizeDate(doc.issuanceDate));
  put(out, 'issuanceLocation', str(doc.issuanceLocation));
  put(out, 'birthPlace', str(doc.birthPlace));
  put(out, 'birthCountry', country(doc.birthCountry));
  put(out, 'validityCountry', country(doc.validityCountry));
  if (typeof doc.holder === 'boolean') out.holder = doc.holder;
  return out;
}

/** SDK `Phone` → Amadeus `Phone` (digits only, C‑25); `undefined` without a number. */
function toPhone(phone) {
  if (!isObject(phone)) return undefined;
  const number = digits(phone.number)?.slice(0, 15);
  if (!number) return undefined;
  /** @type {Record<string, unknown>} */
  const out = { deviceType: own(PHONE_TYPES, str(phone.type)?.toLowerCase()) ?? 'MOBILE' };
  put(out, 'countryCallingCode', callingCode(phone.countryCode));
  out.number = number;
  return out;
}

/** SDK `Address` → Amadeus `Address` (`cityName` Latin, ≤35); `undefined` when nothing maps. */
function toAddress(address) {
  if (!isObject(address)) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  const lines = [str(address.line1), str(address.line2)].filter((l) => l !== undefined);
  if (lines.length) out.lines = lines;
  put(out, 'postalCode', str(address.postalCode));
  put(out, 'cityName', latin(address.city, 35));
  put(out, 'stateName', str(address.state));
  put(out, 'countryCode', country(address.countryCode));
  put(out, 'postalBox', str(address.postalBox));
  return Object.keys(out).length ? out : undefined;
}

/** Amadeus `Name` out of an SDK traveler; `undefined` without first and last name. */
function toName(t) {
  /** @type {Record<string, unknown>} */
  const out = {};
  put(out, 'firstName', str(t.firstName));
  put(out, 'lastName', str(t.lastName));
  put(out, 'middleName', str(t.middleName));
  put(out, 'secondLastName', str(t.secondLastName));
  return Object.keys(out).length ? out : undefined;
}

/** `Traveler.gender` (+ `genderDetail`) → `StakeholderGender` (C‑24). */
function toGender(t) {
  const detail = str(t.genderDetail)?.toLowerCase();
  if (str(t.gender) === 'X' && detail === 'undisclosed') return 'UNDISCLOSED';
  return toWire(GENDER, str(t.gender));
}

/** Documents of an SDK traveler, KTN / redress included (C‑24). */
function toDocuments(t) {
  const out = objects(t.documents)
    .map((doc) => toIdentityDocument(doc, { nationality: str(t.nationality) }))
    .filter((doc) => doc !== undefined);
  const ktn = str(t.knownTravelerNumber);
  if (ktn) out.push({ documentType: 'KNOWN_TRAVELER', number: ktn, holder: true });
  const redress = str(t.redressNumber);
  if (redress) out.push({ documentType: 'REDRESS', number: redress, holder: true });
  return out;
}

/** `travelers[].contact` out of the traveler's own email / phone, else the booking contact (lead). */
function toTravelerContact(t, bookingContact) {
  const bc = isObject(bookingContact) ? bookingContact : undefined;
  const email = str(t.email) ?? str(bc?.email);
  const phone = toPhone(t.phone) ?? toPhone(bc?.phone);
  const address = bc ? toAddress(bc.address) : undefined;
  if (!email && !phone && !address) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  put(out, 'emailAddress', email);
  if (phone) out.phones = [phone];
  put(out, 'address', address);
  return out;
}

/**
 * `Contact.emergency` → Amadeus `EmergencyContact`: `countryCode` is ISO alpha‑2, not a dial code
 * (C‑25): an alpha‑2 `Phone.countryCode` is taken as is, a dial code goes through `countryFor`, else the
 * contact address country is assumed.
 */
function toEmergencyContact(emergency, contact, options) {
  if (!isObject(emergency)) return undefined;
  const phone = isObject(emergency.phone) ? emergency.phone : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  put(out, 'addresseeName', latin(emergency.name));
  const dial = str(phone.countryCode);
  let iso = country(dial);
  if (!iso && dial && typeof options?.countryFor === 'function') {
    try {
      iso = country(options.countryFor(dial));
    } catch {
      iso = undefined;
    }
  }
  if (!iso && isObject(contact?.address)) iso = country(contact.address.countryCode);
  put(out, 'countryCode', iso);
  put(out, 'number', digits(phone.number)?.slice(0, 15));
  return out.number || out.addresseeName ? out : undefined;
}

/** `Traveler.discountEligibility[]` → Amadeus `Discount[]`. */
function toDiscounts(list) {
  return objects(list)
    .map((d) => {
      /** @type {Record<string, unknown>} */
      const out = {};
      put(out, 'subType', str(d.subType)?.toUpperCase());
      put(out, 'travelerType', str(d.travelerType)?.toUpperCase());
      put(out, 'cityName', latin(d.cityName, 35)?.toUpperCase());
      put(out, 'cardNumber', str(d.cardNumber)?.toUpperCase());
      put(out, 'certificateNumber', str(d.certificateNumber)?.toUpperCase());
      return out;
    })
    .filter((d) => Object.keys(d).length > 0);
}

/** Index of the lead traveler: the first adult‑like one, else the first. */
function leadIndex(travelers) {
  const at = travelers.findIndex((t) => LEAD_TYPES.has(str(t.type) ?? 'ADT'));
  return at < 0 ? 0 : at;
}

/**
 * Wire id of a traveler: its `slotId`, the slot that names it, the first free slot of its type, the
 * first free slot, else its position.
 */
function travelerWireId(t, index, slots, used) {
  const claim = (id) => {
    if (id === undefined || used.has(id)) return undefined;
    used.add(id);
    return id;
  };
  const declared = claim(str(t.slotId));
  if (declared) return declared;
  const byTravelerId = slots.find((s) => str(s.travelerId) !== undefined && s.travelerId === t.id);
  const named = claim(str(byTravelerId?.id));
  if (named) return named;
  const type = str(t.type);
  const byType = slots.find((s) => !used.has(str(s.id)) && (!type || s.type === type));
  const typed = claim(str(byType?.id));
  if (typed) return typed;
  const free = slots.find((s) => !used.has(str(s.id)));
  const any = claim(str(free?.id));
  if (any) return any;
  let candidate = index + 1;
  while (used.has(String(candidate))) candidate++;
  used.add(String(candidate));
  return String(candidate);
}

/**
 * SDK `Traveler[]` + booking `Contact` → Amadeus `Traveler[]` (`data.travelers` of pricing, `travelers`
 * of Create Orders; §3.10, C‑24 … C‑26). Ids are the `slotId`s (else matched to `slots` by `travelerId`,
 * order + type, or the position); `gender` M/F/X → MALE/FEMALE/UNSPECIFIED (`genderDetail:
 * 'undisclosed'` → UNDISCLOSED); `dob` → `dateOfBirth`; `name` from first / middle / last / second last;
 * `documents[]` through `toIdentityDocument` (traveler `nationality` filled in) plus `knownTravelerNumber`
 * / `redressNumber` as KNOWN_TRAVELER / REDRESS documents; `loyalty[]` → `loyaltyPrograms[] {
 * programOwner, id }`; `discountEligibility[]`; `contact` from the traveler's own email / phone, the lead
 * traveler (first adult) also carrying the booking contact's email, phone, address and `emergencyContact`
 * (`countryCode` ISO alpha‑2: alpha‑2 input kept, a dial code resolved with `options.countryFor`, else
 * the address country). Phones are digits only, a one‑digit calling code keeps its `'+'`.
 * `title`, `mealPref`, `seatPref`, `assistance` have no Amadeus field and are dropped.
 * @param {Traveler[]|null|undefined} travelers
 * @param {Contact} [contact]
 * @param {PassengerSlot[]} [slots]
 * @param {{ countryFor?: (dialCode: string) => string|undefined }} [options]
 * @returns {Record<string, unknown>[]}
 */
export function toTravelers(travelers, contact, slots, options = {}) {
  const list = objects(travelers);
  const slotList = objects(slots);
  const lead = leadIndex(list);
  const used = new Set();
  return list.map((t, index) => {
    /** @type {Record<string, unknown>} */
    const out = { id: travelerWireId(t, index, slotList, used) };
    put(out, 'dateOfBirth', normalizeDate(t.dob));
    put(out, 'gender', toGender(t));
    put(out, 'name', toName(t));
    const documents = toDocuments(t);
    if (documents.length) out.documents = documents;
    put(out, 'contact', toTravelerContact(t, index === lead ? contact : undefined));
    if (index === lead && isObject(contact)) {
      put(out, 'emergencyContact', toEmergencyContact(contact.emergency, contact, options));
    }
    const loyalty = objects(t.loyalty)
      .map((l) => put(put({}, 'programOwner', str(l.airline)?.toUpperCase()), 'id', str(l.number)))
      .filter((l) => l.id !== undefined);
    if (loyalty.length) out.loyaltyPrograms = loyalty.slice(0, 10);
    const discounts = toDiscounts(t.discountEligibility);
    if (discounts.length) out.discountEligibility = discounts.slice(0, 10);
    put(out, 'associatedAdultId', str(t.associatedAdultId));
    return out;
  });
}

/** SDK / wire purpose → `ContactPurpose`. */
function toPurpose(purpose) {
  const text = str(purpose)?.toUpperCase();
  if (!text) return 'STANDARD';
  if (text === 'STANDARD' || text === 'INVOICE' || text === 'STANDARD_WITHOUT_TRANSMISSION') {
    return text;
  }
  return text.replace(/[\s-]+/g, '_');
}

/**
 * SDK `Contact` → Amadeus `Contact` for `contacts[]` (§3.10, C‑26). `purpose` `'standard'` (default) maps
 * email, phone (digits only), postal `address` (Latin `cityName`), `company` → `companyName` and
 * `language`; `'invoice'` serialises the GST block: `gst.company` → `companyName`, `gst.email` (else the
 * contact email) → `emailAddress`, `gst.address` (free text) → `address.lines[0]` with the contact's
 * country when known (the GST number itself travels as an INVOICE remark, built by `orders.js`).
 * `options.addressee` (a traveler) fills `addresseeName`. Non‑object input gives `undefined`.
 * @param {Contact|null|undefined} contact
 * @param {'standard'|'invoice'|string} [purpose='standard']
 * @param {{ addressee?: Traveler }} [options]
 * @returns {Record<string, unknown>|undefined}
 */
export function toContact(contact, purpose = 'standard', options = {}) {
  if (!isObject(contact)) return undefined;
  const wirePurpose = toPurpose(purpose);
  /** @type {Record<string, unknown>} */
  const out = {};
  const addressee = isObject(options?.addressee) ? toName(options.addressee) : undefined;
  put(out, 'addresseeName', addressee);
  out.purpose = wirePurpose;
  if (wirePurpose === 'INVOICE') {
    const gst = isObject(contact.gst) ? contact.gst : {};
    put(out, 'companyName', str(gst.company) ?? str(contact.company));
    put(out, 'emailAddress', str(gst.email) ?? str(contact.email));
    const gstAddress = str(gst.address);
    if (gstAddress) {
      const address = { lines: [gstAddress] };
      put(address, 'countryCode', country(contact.address?.countryCode));
      out.address = address;
    } else {
      put(out, 'address', toAddress(contact.address));
    }
    const phone = toPhone(contact.phone);
    if (phone) out.phones = [phone];
    return out;
  }
  put(out, 'emailAddress', str(contact.email));
  const phone = toPhone(contact.phone);
  if (phone) out.phones = [phone];
  put(out, 'address', toAddress(contact.address));
  put(out, 'companyName', str(contact.company));
  put(out, 'language', str(contact.language));
  return out;
}

// ── response: requirements (§2.4, §3.11, C‑23) ──────────────────────────────────────────────────

/** Age bands from the spec prose (C‑6, C‑23). @type {Readonly<AgeRules>} */
const DEFAULT_AGE_RULES = Object.freeze({
  infantMax: 2,
  childMax: 12,
  refDate: 'departure',
  infantPerAdult: 1,
  maxPax: 9,
});

/** Name constraints: OTA config in production; GDS Latin charset and the 59‑character PNR line. */
const DEFAULT_NAME_RULES = Object.freeze({ maxLength: 35, charset: 'latin', maxCombinedLength: 59 });

/** Document types a `documentRequired` flag accepts (C‑24). */
const DOCUMENT_TYPES = Object.freeze(['passport', 'national_id', 'visa']);

const PHONE_NUMBER_PATTERN = '^[0-9]{1,15}$';
const PHONE_COUNTRY_PATTERN = '^[0-9+]{2,5}$';

/** Discount sub‑types behind the two discount flags. */
const DISCOUNT_SUBTYPES = Object.freeze({
  spanishResidentDiscountRequired: ['SPANISH_RESIDENT'],
  airFranceDiscountRequired: ['AIR_FRANCE_DOMESTIC', 'AIR_FRANCE_COMBINED', 'AIR_FRANCE_METROPOLITAN'],
});

/** Merge a `FieldRule` into a path‑keyed table: `required` OR‑ed, `options` united, first `pattern` kept. */
function mergeField(table, rule) {
  const existing = table.get(rule.path);
  if (!existing) {
    table.set(rule.path, { ...rule, options: rule.options ? [...rule.options] : undefined });
    return;
  }
  existing.required = existing.required || rule.required;
  if (rule.options) existing.options = uniq([...(existing.options ?? []), ...rule.options]);
  if (!existing.pattern && rule.pattern) existing.pattern = rule.pattern;
}

/** Merge a `DocumentRule` into a one‑slot table (types united, `required` OR‑ed). */
function mergeDocument(table, rule) {
  const existing = table.get('document');
  if (!existing) {
    table.set('document', { ...rule, types: [...rule.types] });
    return;
  }
  existing.required = existing.required || rule.required;
  existing.types = uniq([...existing.types, ...rule.types]);
}

/** Field rules without their `undefined` members, in insertion order. */
function rulesOf(table) {
  return [...table.values()].map((rule) => {
    /** @type {FieldRule} */
    const out = { path: rule.path, required: rule.required };
    if (rule.pattern) out.pattern = rule.pattern;
    if (rule.options && rule.options.length) out.options = rule.options;
    return out;
  });
}

/** `PassengerConditions` → the `FieldRule`s / `DocumentRule`s it implies (§2.4 table). */
function travelerRules(pc) {
  /** @type {Map<string, FieldRule & { options?: string[] }>} */
  const fields = new Map();
  /** @type {Map<string, DocumentRule>} */
  const documents = new Map();
  const flag = (key) => (typeof pc[key] === 'boolean' ? pc[key] : undefined);
  const gender = flag('genderRequired');
  if (gender !== undefined) mergeField(fields, { path: 'gender', required: gender, options: ['M', 'F'] });
  const dob = flag('dateOfBirthRequired');
  if (dob !== undefined) mergeField(fields, { path: 'dob', required: dob });
  const document = flag('documentRequired');
  if (document !== undefined) {
    mergeDocument(documents, { types: [...DOCUMENT_TYPES], required: document });
  }
  const issuanceCity = flag('documentIssuanceCityRequired');
  if (issuanceCity !== undefined) {
    mergeField(fields, { path: 'documents[].issuanceLocation', required: issuanceCity });
  }
  if (flag('redressRequiredIfAny') === true) {
    mergeField(fields, { path: 'redressNumber', required: false });
  }
  const residence = flag('residenceRequired');
  if (residence !== undefined) mergeField(fields, { path: 'contact.address', required: residence });
  for (const [key, subTypes] of Object.entries(DISCOUNT_SUBTYPES)) {
    const value = flag(key);
    if (value === undefined) continue;
    mergeField(fields, {
      path: 'discountEligibility',
      required: value,
      options: value ? subTypes : undefined,
    });
  }
  return { fields, documents };
}

/**
 * `FlightOfferPricingOut.bookingRequirements` → `TravelerRequirements` (§2.4 `itinerary.requirements`,
 * §3.11, C‑23). Per‑traveler flags become `FieldRule`s / `DocumentRule`s: `genderRequired` → `gender`
 * (options `['M','F']`, the pricing gender enum), `dateOfBirthRequired` → `dob`, `documentRequired` →
 * `DocumentRule{ types: ['passport','national_id','visa'] }`, `documentIssuanceCityRequired` →
 * `documents[].issuanceLocation`, `redressRequiredIfAny` → `redressNumber` (optional), `residenceRequired`
 * → `contact.address`, `airFranceDiscountRequired` / `spanishResidentDiscountRequired` →
 * `discountEligibility` (options = the discount sub‑types). Flags are per `travelerId`: they are OR‑ed per
 * `PaxType` (`perType`, the type read from the matching `travelerPricings[]` entry, `ADT` when unknown;
 * every type present gets an entry) and kept per traveler (`perTraveler`, keyed by `travelerId` =
 * slot id). Booking‑level flags → `contact` rules: `emailAddressRequired` → `email`,
 * `phoneNumberRequired` / `mobilePhoneNumberRequired` → `phone.number` (`^[0-9]{1,15}$`; mobile also
 * `phone.type` ∈ `['mobile']`), `phoneCountryCodeRequired` → `phone.countryCode` (`^[0-9+]{2,5}$`),
 * `postalCodeRequired` → `address.postalCode`, `mailingAddressRequired` (or any `residenceRequired`) →
 * `address`, `invoiceAddressRequired` → `gst.address`. `apis` = any `documentRequired`; `threeDsRequired`
 * = any `threeDomainSecureRequirements[].is3dsAuthenticationRequired`; `gstAvailable` defaults to
 * `invoiceAddressRequired`; `ageRules` from the spec prose (`{ infantMax: 2, childMax: 12, refDate:
 * 'departure', infantPerAdult: 1, maxPax: 9 }`) and `nameRules` (`{ maxLength: 35, charset: 'latin',
 * maxCombinedLength: 59 }`) are OTA‑configurable through `options`. The wire object stays on `raw`.
 * @param {Record<string, unknown>|null|undefined} br
 * @param {Record<string, unknown>[]} [travelerPricings]
 * @param {{ ageRules?: Partial<AgeRules>, nameRules?: Partial<TravelerRequirements['nameRules']>, gstAvailable?: boolean }} [options]
 * @returns {TravelerRequirements & { raw: Record<string, unknown>|undefined }}
 */
export function fromBookingRequirements(br, travelerPricings, options = {}) {
  const b = isObject(br) ? br : {};
  const o = isObject(options) ? options : {};
  const types = travelerTypes(travelerPricings);
  const conditions = objects(b.travelerRequirements);

  /** @type {Map<PaxType, { fields: Map<string, FieldRule>, documents: Map<string, DocumentRule> }>} */
  const perTypeTables = new Map();
  for (const type of uniq([...types.values()])) {
    perTypeTables.set(type, { fields: new Map(), documents: new Map() });
  }
  /** @type {Record<string, { fields: FieldRule[], documents: DocumentRule[] }>} */
  const perTraveler = {};
  let apis = false;
  let residence = false;

  for (const pc of conditions) {
    const travelerId = str(pc.travelerId);
    const type = (travelerId && types.get(travelerId)) || 'ADT';
    if (!perTypeTables.has(type)) perTypeTables.set(type, { fields: new Map(), documents: new Map() });
    const typed = /** @type {NonNullable<ReturnType<typeof perTypeTables.get>>} */ (
      perTypeTables.get(type)
    );
    const rules = travelerRules(pc);
    for (const rule of rules.fields.values()) mergeField(typed.fields, rule);
    for (const rule of rules.documents.values()) mergeDocument(typed.documents, rule);
    if (pc.documentRequired === true) apis = true;
    if (pc.residenceRequired === true) residence = true;
    if (travelerId) {
      perTraveler[travelerId] = {
        fields: rulesOf(rules.fields),
        documents: [...rules.documents.values()],
      };
    }
  }

  /** @type {Record<string, { fields: FieldRule[], documents: DocumentRule[] }>} */
  const perType = {};
  for (const [type, tables] of perTypeTables) {
    perType[type] = { fields: rulesOf(tables.fields), documents: [...tables.documents.values()] };
  }

  /** @type {Map<string, FieldRule>} */
  const contact = new Map();
  const flag = (key) => (typeof b[key] === 'boolean' ? b[key] : undefined);
  const email = flag('emailAddressRequired');
  if (email !== undefined) mergeField(contact, { path: 'email', required: email });
  const phone = flag('phoneNumberRequired');
  const mobile = flag('mobilePhoneNumberRequired');
  if (phone !== undefined || mobile !== undefined) {
    mergeField(contact, {
      path: 'phone.number',
      required: phone === true || mobile === true,
      pattern: PHONE_NUMBER_PATTERN,
    });
  }
  const phoneCountry = flag('phoneCountryCodeRequired');
  if (phoneCountry !== undefined) {
    mergeField(contact, {
      path: 'phone.countryCode',
      required: phoneCountry,
      pattern: PHONE_COUNTRY_PATTERN,
    });
  }
  if (mobile !== undefined) {
    mergeField(contact, { path: 'phone.type', required: mobile, options: ['mobile'] });
  }
  const postalCode = flag('postalCodeRequired');
  if (postalCode !== undefined) {
    mergeField(contact, { path: 'address.postalCode', required: postalCode });
  }
  const mailing = flag('mailingAddressRequired');
  if (mailing !== undefined || residence) {
    mergeField(contact, { path: 'address', required: mailing === true || residence });
  }
  const invoice = flag('invoiceAddressRequired');
  if (invoice !== undefined) mergeField(contact, { path: 'gst.address', required: invoice });

  const threeDs = objects(b.threeDomainSecureRequirements);

  /** @type {TravelerRequirements & { raw: Record<string, unknown>|undefined }} */
  const out = {
    perType: /** @type {TravelerRequirements['perType']} */ (perType),
    contact: rulesOf(contact),
    apis,
    gstAvailable: typeof o.gstAvailable === 'boolean' ? o.gstAvailable : invoice === true,
    ageRules: { ...DEFAULT_AGE_RULES, ...(isObject(o.ageRules) ? o.ageRules : {}) },
    nameRules: { ...DEFAULT_NAME_RULES, ...(isObject(o.nameRules) ? o.nameRules : {}) },
    raw: isObject(br) ? br : undefined,
  };
  if (threeDs.length) {
    out.threeDsRequired = threeDs.some((r) => r.is3dsAuthenticationRequired === true);
  }
  if (Object.keys(perTraveler).length) out.perTraveler = perTraveler;
  return out;
}

// ── response: ancillary catalogue (§2.3 `offers.baggageOptions`, §3.7) ───────────────────────────

/**
 * Locate wire segment ids in the raw offers of `ctx`: the owning offer (SDK‑scoped id), the itinerary
 * index when all ids sit in one, and the single segment when there is just one.
 */
function locateSegments(segmentIds, ctx) {
  const ids = uniq(segmentIds.map((id) => str(id)).filter((id) => id !== undefined));
  /** @type {{ segmentId?: string, sliceId?: string }} */
  const out = {};
  if (ids.length === 0) return out;
  for (const raw of objects(ctx.rawOffers)) {
    const found = rawSegments(raw).filter(({ segment }) => ids.includes(String(segment.id)));
    if (found.length !== ids.length) continue;
    const offerId = scopeId(ctx.sessionId, String(raw.id));
    const itineraries = uniq(found.map((f) => f.itinerary));
    if (itineraries.length === 1) out.sliceId = `${offerId}:${itineraries[0]}`;
    if (ids.length === 1) out.segmentId = `${offerId}:${ids[0]}`;
    return out;
  }
  if (ids.length === 1) out.segmentId = ids[0];
  return out;
}

/** `PaxType[]` eligible for a service, from its `travelerIds` through the traveler pricings of `ctx`. */
function eligibleTypes(travelerIds, ctx) {
  const types = travelerTypes(ctx.travelerPricings);
  const out = [];
  for (const id of Array.isArray(travelerIds) ? travelerIds : []) {
    const type = types.get(String(id));
    if (type && !out.includes(type)) out.push(type);
  }
  return out;
}

/** Human label of a baggage allowance: `"1 × 10 KG"`, `"15 KG"`, `"2 bags"`. */
function allowanceLabel(bag) {
  const quantity = num(bag.quantity);
  const weight = num(bag.weight);
  const unit = str(bag.weightUnit)?.toUpperCase();
  const weightText = weight !== undefined ? `${weight} ${unit ?? 'KG'}` : undefined;
  if (quantity !== undefined && quantity > 0 && weightText) return `${quantity} × ${weightText}`;
  if (weightText) return weightText;
  if (quantity !== undefined && quantity > 0) return `${quantity} ${quantity === 1 ? 'bag' : 'bags'}`;
  return undefined;
}

/** Shared `Service` skeleton of bags and other services. */
function serviceBase(key, entry, ctx) {
  const price = isObject(entry.price) ? entry.price : {};
  const money = toMoney(price.amount, price);
  if (!money) return undefined;
  const segmentIds = Array.isArray(entry.segmentIds) ? entry.segmentIds.map(String) : [];
  const travelerIds = Array.isArray(entry.travelerIds) ? entry.travelerIds.map(String) : [];
  const descriptions = Array.isArray(entry.descriptions)
    ? entry.descriptions.map((d) => str(d)).filter((d) => d !== undefined)
    : [];
  const { additionalCollection, ...amount } = money;
  /** @type {Record<string, unknown>} */
  const meta = { segmentIds, travelerIds };
  if (typeof entry.bookableByItinerary === 'boolean') meta.bookableByItinerary = entry.bookableByItinerary;
  if (typeof entry.bookableByTraveler === 'boolean') meta.bookableByTraveler = entry.bookableByTraveler;
  if (additionalCollection) meta.additionalCollection = true;
  if (descriptions.length) meta.descriptions = descriptions;
  return {
    id: String(key),
    price: amount,
    descriptions,
    location: locateSegments(segmentIds, ctx),
    eligible: eligibleTypes(travelerIds, ctx),
    meta,
  };
}

/** Assemble the `Service` out of a `serviceBase` and the type‑specific fields. */
function finishService(base, fields, raw) {
  /** @type {Service & { raw: Record<string, unknown> }} */
  const service = {
    id: base.id,
    type: fields.type,
    label: fields.label,
    price: base.price,
    scope: fields.scope,
    raw,
  };
  put(service, 'code', fields.code);
  if (base.descriptions.length > 1) service.description = base.descriptions.slice(1).join('. ');
  if (base.eligible.length) service.eligiblePassengerTypes = base.eligible;
  put(service, 'segmentId', base.location.segmentId);
  put(service, 'sliceId', base.location.sliceId);
  service.meta = { ...base.meta, ...fields.meta };
  return service;
}

/**
 * `included.bags` (map `id → Bags`) → `Service[]` (§2.3 `offers.baggageOptions`, §3.7): `id` = map key,
 * `type` `'baggage'` (`'cabin_baggage'` when the name says CABIN), `code` = `name` (`CHECKED_BAG`),
 * `label` = `descriptions[0]` else quantity × weight + unit, `price` = `{ amount, currencyCode }` with
 * a trailing `'A'` stripped (additional collection, flagged in `meta`), `scope` = `bookableByItinerary`
 * ? `'per_passenger_slice'` : `'per_passenger'`, `eligiblePassengerTypes` ← `travelerIds` resolved
 * through `ctx.travelerPricings`, `segmentId` / `sliceId` ← `segmentIds` located in `ctx.rawOffers`
 * (SDK‑scoped under `ctx.sessionId`; a single wire id passes through unscoped when no offer is known),
 * `meta` = `{ quantity, weightKg, weightUnit, segmentIds, travelerIds, bookableByItinerary }`, the wire
 * entry on `raw`. Entries without a price are skipped; a non‑map input gives `[]`.
 * @param {Record<string, Record<string, unknown>>|null|undefined} includedBags
 * @param {ConversionContext} [ctx]
 * @returns {(Service & { raw: Record<string, unknown> })[]}
 */
export function fromBags(includedBags, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  /** @type {(Service & { raw: Record<string, unknown> })[]} */
  const out = [];
  for (const [key, bag] of mapEntries(includedBags)) {
    const base = serviceBase(key, bag, c);
    if (!base) continue;
    const name = str(bag.name);
    const cabin = /CABIN/i.test(name ?? '');
    /** @type {Record<string, unknown>} */
    const meta = {};
    const quantity = num(bag.quantity);
    const weight = num(bag.weight);
    const unit = str(bag.weightUnit)?.toUpperCase();
    if (quantity !== undefined) meta.quantity = quantity;
    if (weight !== undefined) {
      meta.weight = weight;
      meta.weightUnit = unit ?? 'KG';
      meta.weightKg = unit === 'LB' ? Math.round(weight * 0.4536 * 10) / 10 : weight;
    }
    out.push(
      finishService(
        base,
        {
          type: cabin ? 'cabin_baggage' : 'baggage',
          code: name,
          label: base.descriptions[0] ?? allowanceLabel(bag) ?? titleize(name ?? 'CHECKED_BAG'),
          scope: bag.bookableByItinerary === true ? 'per_passenger_slice' : 'per_passenger',
          meta,
        },
        bag
      )
    );
  }
  return out;
}

/**
 * `included['other-services']` (map `id → OtherServices`) → `Service[]` (§3.7): `type` ←
 * `SERVICE_NAME` (`PRIORITY_BOARDING` → `priority_boarding`, `AIRPORT_CHECKIN` → `airport_checkin`,
 * `FAST_TRACK` → `fast_track`, others lower‑cased), `code` = `name`, `label` = `descriptions[0]` else the
 * titleised name, `price` as for bags, `scope` from `bookableByTraveler` × `bookableByItinerary`
 * (`per_passenger_slice` / `per_passenger` / `per_booking`), `eligiblePassengerTypes`, `segmentId` /
 * `sliceId` and `meta` as for bags, the wire entry on `raw`.
 * @param {Record<string, Record<string, unknown>>|null|undefined} map
 * @param {ConversionContext} [ctx]
 * @returns {(Service & { raw: Record<string, unknown> })[]}
 */
export function fromOtherServices(map, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  /** @type {(Service & { raw: Record<string, unknown> })[]} */
  const out = [];
  for (const [key, entry] of mapEntries(map)) {
    const base = serviceBase(key, entry, c);
    if (!base) continue;
    const name = str(entry.name);
    const perTraveler = entry.bookableByTraveler === true;
    const perItinerary = entry.bookableByItinerary === true;
    out.push(
      finishService(
        base,
        {
          type: fromWire(SERVICE_NAME, name) ?? 'other',
          code: name,
          label: base.descriptions[0] ?? titleize(name ?? 'service'),
          scope: perTraveler
            ? perItinerary
              ? 'per_passenger_slice'
              : 'per_passenger'
            : 'per_booking',
          meta: {},
        },
        entry
      )
    );
  }
  return out;
}

/**
 * `included['credit-card-fees']` (map `id → CreditCardFee`) → `CardFee[]` (§2.4 `itinerary.reprice`,
 * §3.5 items): `{ id: key, brand (wire `PaymentBrand`), amount: { amount, currency }, offerId:
 * flightOfferId, raw }`; entries without an amount are skipped; a non‑map input gives `[]`.
 * @param {Record<string, Record<string, unknown>>|null|undefined} map
 * @returns {CardFee[]}
 */
export function fromCreditCardFees(map) {
  /** @type {CardFee[]} */
  const out = [];
  for (const [key, fee] of mapEntries(map)) {
    const amount = toMoney(fee.amount, fee);
    if (!amount) continue;
    const { additionalCollection: _ignored, ...money } = amount;
    /** @type {CardFee} */
    const entry = { id: String(key), brand: str(fee.brand) ?? 'UNKNOWN', amount: money, raw: fee };
    put(entry, 'offerId', str(fee.flightOfferId));
    out.push(entry);
  }
  return out;
}

/**
 * `included['detailed-fare-rules']` → `FareRules.raw[]` texts (§2.3 `offers.fareRules`, §3.8). The spec
 * declares one `DetailedFareRules` object but describes a map keyed by fare basis: both are parsed (an
 * array too). Every `fareNotes.descriptions[]` entry becomes `{ title: "<name ?? fareBasis> — <Type>",
 * text, fareBasis, segmentId, category: descriptionType }`; exact duplicates across segments are
 * dropped. Non‑object input gives `[]`.
 * @param {Record<string, unknown>|Record<string, unknown>[]|null|undefined} included
 * @returns {FareRuleText[]}
 */
export function fromDetailedFareRules(included) {
  /** @type {FareRuleText[]} */
  const out = [];
  const seen = new Set();
  const entries =
    isObject(included) && (included.fareNotes || included.fareBasis)
      ? [['1', included]]
      : mapEntries(included);
  for (const [, rule] of entries) {
    const fareBasis = str(rule.fareBasis);
    const name = str(rule.name) ?? fareBasis ?? 'Fare rules';
    const segmentId = str(rule.segmentId);
    const notes = isObject(rule.fareNotes) ? rule.fareNotes : {};
    const descriptions = objects(notes.descriptions);
    for (const description of descriptions) {
      const text = str(description.text);
      if (!text) continue;
      const category = str(description.descriptionType);
      const key = `${fareBasis ?? ''}|${category ?? ''}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      /** @type {FareRuleText} */
      const entry = { title: category ? `${name} — ${titleize(category)}` : name, text };
      put(entry, 'fareBasis', fareBasis);
      put(entry, 'segmentId', segmentId);
      put(entry, 'category', category);
      out.push(entry);
    }
  }
  return out;
}

// ── response: fromPricingResponse (§2.3 `offers.reprice`, C‑21) ──────────────────────────────────

/** The pricing envelope out of a plain envelope, an unwrapped `HttpResponse` or a bare `data`. */
function unwrapEnvelope(envelope) {
  if (!isObject(envelope)) return {};
  const raw = envelope.raw;
  if (isObject(raw) && isObject(raw.data) && Array.isArray(raw.data.flightOffers)) return raw;
  if (isObject(envelope.data) && Array.isArray(envelope.data.flightOffers)) return envelope;
  if (Array.isArray(envelope.flightOffers)) return { data: envelope };
  return envelope;
}

/** Per‑traveler totals keyed by `travelerId` (position as fallback key). */
function travelerTotals(raw) {
  /** @type {Map<string, Money|undefined>} */
  const out = new Map();
  objects(raw.travelerPricings).forEach((tp, i) => {
    const price = isObject(tp.price) ? tp.price : {};
    out.set(str(tp.travelerId) ?? `#${i}`, toMoney(price.total, price));
  });
  return out;
}

/** `class` / `brandedFare` per traveler and segment position. */
function fareSignature(raw) {
  /** @type {Map<string, { cls: string|undefined, brand: string|undefined }[]>} */
  const out = new Map();
  objects(raw.travelerPricings).forEach((tp, i) => {
    out.set(
      str(tp.travelerId) ?? `#${i}`,
      fareDetails(tp).map((f) => ({ cls: str(f.class), brand: str(f.brandedFare) }))
    );
  });
  return out;
}

/** The C‑21 diff between previous and priced raw offers. */
function diffOffers(previous, current, warnings) {
  const reasons = new Set();
  const count = Math.min(previous.length, current.length);
  if (previous.length && previous.length !== current.length) reasons.add('grandTotal');
  for (let i = 0; i < count; i++) {
    const before = previous[i];
    const after = current[i];
    const totalBefore = grandTotalOf(before);
    const totalAfter = grandTotalOf(after);
    if (totalBefore?.currency !== totalAfter?.currency) reasons.add('currency');
    if (!sameMoney(totalBefore, totalAfter)) reasons.add('grandTotal');
    const travelersBefore = travelerTotals(before);
    for (const [id, total] of travelerTotals(after)) {
      if (!travelersBefore.has(id) || !sameMoney(travelersBefore.get(id), total)) {
        reasons.add('travelerTotal');
      }
    }
    const faresBefore = fareSignature(before);
    for (const [id, fares] of fareSignature(after)) {
      const other = faresBefore.get(id) ?? [];
      fares.forEach((fare, j) => {
        const prior = other[j];
        if (!prior) return;
        if (prior.cls !== fare.cls) reasons.add('class');
        if (prior.brand !== fare.brand) reasons.add('brandedFare');
      });
    }
  }
  if (warnings.some((w) => num(w.code) === 37200)) reasons.add('warning');
  const sumOf = (list) => {
    try {
      return sumMoney(list.map(grandTotalOf));
    } catch {
      return grandTotalOf(list[0]);
    }
  };
  return {
    changed: reasons.size > 0,
    from: previous.length ? sumOf(previous) : undefined,
    to: current.length ? sumOf(current) : undefined,
    reasons: [...reasons],
  };
}

/** Index of the offer a warning points at (`/data/flightOffers/<i>/…`), else `undefined`. */
function warningOfferIndex(warning) {
  const pointer = str(warning.source?.pointer);
  const m = pointer ? /^\/data\/flightOffers\/(\d+)(?:\/|$)/.exec(pointer) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * `Success_Pricing` envelope (`{ warnings, data: { flightOffers, bookingRequirements }, included,
 * dictionaries }` — also accepted: the unwrapped `HttpResponse` whose `raw` is the envelope, or a bare
 * `FlightOfferPricingOut`) → `PricingResult` (§2.3 `offers.reprice` / `offers.combine`, §2.4
 * `itinerary.create` / `reprice`, C‑21). `offers` come from `fromFlightOffer(fo, { ...ctx, dictionaries })`,
 * so the priced `FlightOffer` replaces `raw` (Create Orders needs it); warnings pointing at
 * `/data/flightOffers/<i>` are attached to that offer's `warnings`. `changed` / `from` / `to` are the
 * SDK's own diff against `previous` (the raw offers that were sent, or `Offer`s), offer by offer in
 * request order: `grandTotal` (value or currency), every per‑traveler `price.total`, every
 * `fareDetailsBySegment[].class` and `brandedFare` by position; a 37200 warning also counts. `from` /
 * `to` sum the grand totals (one currency). `requirements` ← `fromBookingRequirements`, `catalog` ←
 * `fromBags` + `fromOtherServices`, `cardFees`, `detailedFareRules`, `threeDsRequired`, the verbatim
 * `warnings`, and `combined` (`combineOffers`, named after the previous offers' ids) when several offers
 * were priced. The envelope stays on `raw`.
 * @param {Record<string, unknown>|null|undefined} envelope
 * @param {{ ctx?: ConversionContext, previous?: (Record<string, unknown>|Offer)[]|Record<string, unknown>|Offer, requirements?: { ageRules?: Partial<AgeRules>, nameRules?: Partial<TravelerRequirements['nameRules']>, gstAvailable?: boolean } }} [options]
 * @returns {PricingResult}
 */
export function fromPricingResponse(envelope, options = {}) {
  const o = isObject(options) ? options : {};
  const ctx = isObject(o.ctx) ? o.ctx : {};
  const env = unwrapEnvelope(envelope);
  const data = isObject(env.data) ? env.data : {};
  const rawOffers = objects(data.flightOffers);
  const dictionaries = isObject(env.dictionaries) ? env.dictionaries : ctx.dictionaries;
  const offerCtx = { ...ctx, dictionaries };
  const warnings = /** @type {Issue[]} */ (objects(env.warnings));

  const offers = rawOffers.map((fo, index) => {
    const offer = /** @type {Offer} */ (fromFlightOffer(fo, offerCtx));
    const mine = warnings.filter((w) => warningOfferIndex(w) === index);
    if (mine.length) offer.warnings = [...(Array.isArray(offer.warnings) ? offer.warnings : []), ...mine];
    return offer;
  });

  const previous = rawOffersOf(o.previous);
  const diff = diffOffers(previous, rawOffers, warnings);
  const travelerPricings = rawOffers.flatMap((fo) => objects(fo.travelerPricings));
  const requirements = fromBookingRequirements(data.bookingRequirements, travelerPricings, o.requirements);
  const included = isObject(env.included) ? env.included : {};
  const serviceCtx = { ...offerCtx, rawOffers, travelerPricings };
  const services = [
    ...fromBags(included.bags, serviceCtx),
    ...fromOtherServices(included['other-services'], serviceCtx),
  ];

  /** @type {PricingResult} */
  const result = {
    offers,
    changed: diff.changed,
    changeReasons: diff.reasons,
    requirements,
    catalog: { services, seatMapsAvailable: [], protections: [] },
    cardFees: fromCreditCardFees(included['credit-card-fees']),
    detailedFareRules: fromDetailedFareRules(included['detailed-fare-rules']),
    threeDsRequired: requirements.threeDsRequired === true,
    warnings,
    raw: env,
  };
  put(result, 'from', diff.from);
  put(result, 'to', diff.to);
  if (offers.length > 1) {
    const ids = previous.length === offers.length ? previous.map((p) => String(p.id)) : undefined;
    result.combined = combineOffers(offers, ids ? { ...offerCtx, ids } : offerCtx);
  }
  return result;
}

// ── request: toAdditionalServices (§2.4 `itinerary.reprice`) ─────────────────────────────────────

/**
 * Fold the selected ancillaries into a copy of `rawOffer` (§2.4 `itinerary.reprice`, §3.7): every
 * `travelerPricings[].fareDetailsBySegment[].additionalServices` is rebuilt from scratch so the next
 * pricing / order carries exactly the selection — `baggage` → `chargeableCheckedBags { id, quantity }`,
 * `cabin_baggage` → `chargeableCabinBags { id, quantity }`, `seat` → `chargeableSeat { id, number:
 * detail }`, `priority_boarding` / `airport_checkin` / `fast_track` (or any `SERVICE_NAME`) →
 * `otherServices[]`; kinds without an Amadeus field (meals, insurance, protections) are ignored. A
 * selection applies to the traveler named by `passengerId` (slot / traveler id, SDK‑scoped or not) or
 * to all, and to the segment of `segmentId`, the segments of the slice `sliceId` (`…:<itinerary index>`)
 * or all segments. `rawOffer` may be an `Offer` (its `raw` is used). Returns the new wire object; the
 * input is never mutated.
 * @param {SelectedAncillary[]|null|undefined} selectedAncillaries
 * @param {Record<string, unknown>|Offer} rawOffer
 * @returns {Record<string, unknown>}
 */
export function toAdditionalServices(selectedAncillaries, rawOffer) {
  const source = rawOf(rawOffer);
  const offer = /** @type {Record<string, any>} */ (isObject(source) ? clone(source) : {});
  const segments = rawSegments(offer);
  const allSegmentIds = segments.map(({ segment }) => String(segment.id));
  const pricings = objects(offer.travelerPricings);
  for (const tp of pricings) {
    for (const detail of fareDetails(tp)) delete detail.additionalServices;
  }
  for (const selection of objects(selectedAncillaries)) {
    const type = str(selection.type);
    if (!type) continue;
    const travelerId = tail(selection.passengerId);
    const targets = travelerId
      ? pricings.filter((tp) => String(tp.travelerId) === travelerId)
      : pricings;
    let segmentIds = allSegmentIds;
    const segmentId = tail(selection.segmentId);
    const sliceIndex = num(tail(selection.sliceId));
    if (segmentId !== undefined) segmentIds = [segmentId];
    else if (sliceIndex !== undefined) {
      segmentIds = segments.filter((s) => s.itinerary === sliceIndex).map((s) => String(s.segment.id));
    }
    const quantity = Math.max(1, Math.trunc(num(selection.quantity) ?? 1));
    const serviceId = tail(selection.serviceId);
    for (const tp of targets) {
      for (const detail of fareDetails(tp)) {
        if (!segmentIds.includes(String(detail.segmentId))) continue;
        const services = isObject(detail.additionalServices) ? detail.additionalServices : {};
        detail.additionalServices = services;
        if (type === 'baggage' || type === 'cabin_baggage') {
          const key = type === 'baggage' ? 'chargeableCheckedBags' : 'chargeableCabinBags';
          const existing = isObject(services[key]) ? services[key] : undefined;
          const bag = existing ?? {};
          put(bag, 'id', serviceId ?? bag.id);
          bag.quantity = (existing ? num(existing.quantity) ?? 0 : 0) + quantity;
          services[key] = bag;
        } else if (type === 'seat') {
          const seat = {};
          put(seat, 'id', serviceId);
          put(seat, 'number', str(selection.detail)?.toUpperCase());
          if (Object.keys(seat).length) services.chargeableSeat = seat;
        } else {
          const wire = toWire(SERVICE_NAME, type);
          if (wire && own(SERVICE_NAME.fromWire, wire) !== undefined) {
            const list = Array.isArray(services.otherServices) ? services.otherServices : [];
            if (!list.includes(wire)) list.push(wire);
            services.otherServices = list;
          }
        }
        if (Object.keys(services).length === 0) delete detail.additionalServices;
      }
    }
  }
  return offer;
}

// ── combineOffers (§2.3 `offers.combine`, C‑8) ──────────────────────────────────────────────────

/** Sum of a `PriceBreakdown` member across offers (`undefined` when no offer has it). */
function sumPart(offers, pick) {
  return sumMoney(offers.map((offer) => pick(offer)).filter((m) => isObject(m)));
}

/** Combined `PriceBreakdown` (one currency, checked by the caller). */
function combinePrice(offers) {
  const prices = offers.map((o) => (isObject(o.price) ? o.price : {}));
  const zero = (currency) => ({ amount: '0', currency });
  const currency = prices.find((p) => p.total)?.total.currency ?? '';
  /** @type {PriceBreakdown} */
  const out = {
    total: sumPart(prices, (p) => p.total) ?? zero(currency),
    base: sumPart(prices, (p) => p.base) ?? zero(currency),
    taxes: sumPart(prices, (p) => p.taxes) ?? zero(currency),
    fees: sumPart(prices, (p) => p.fees) ?? zero(currency),
    perPax: sumPart(prices, (p) => p.perPax) ?? zero(currency),
  };
  put(out, 'discounts', sumPart(prices, (p) => p.discounts));
  put(out, 'ancillaries', sumPart(prices, (p) => p.ancillaries));
  put(out, 'refundableTaxes', sumPart(prices, (p) => p.refundableTaxes));
  const items = prices.flatMap((p) => (Array.isArray(p.items) ? p.items : []));
  if (items.length) out.items = items;
  const margins = prices.flatMap((p) => (Array.isArray(p.margins) ? p.margins : []));
  if (margins.length) out.margins = margins;
  const billing = prices.map((p) => p.billing).filter(isObject);
  if (billing.length === prices.length) {
    try {
      put(out, 'billing', sumMoney(billing));
    } catch {
      /* mixed billing currencies: no combined billing figure */
    }
  }
  return out;
}

/** Passenger groups merged by type: counts kept, unit prices summed, traveler ids united. */
function combinePassengers(offers) {
  /** @type {Map<PaxType, PaxPrice>} */
  const groups = new Map();
  for (const offer of offers) {
    for (const pax of objects(offer.passengers)) {
      const type = /** @type {PaxType} */ (pax.type);
      const existing = groups.get(type);
      if (!existing) {
        groups.set(type, {
          ...pax,
          unit: combinePrice([{ price: pax.unit }]),
          travelerIds: Array.isArray(pax.travelerIds) ? [...pax.travelerIds] : undefined,
        });
        continue;
      }
      existing.count = Math.max(num(existing.count) ?? 0, num(pax.count) ?? 0);
      existing.unit = combinePrice([{ price: existing.unit }, { price: pax.unit }]);
      if (Array.isArray(pax.travelerIds)) {
        existing.travelerIds = uniq([...(existing.travelerIds ?? []), ...pax.travelerIds]);
      }
    }
  }
  return [...groups.values()].map((pax) => {
    if (pax.travelerIds === undefined) delete pax.travelerIds;
    return pax;
  });
}

/** The larger of two penalties in one currency (first one otherwise). */
function maxPenalty(a, b) {
  if (!a) return b;
  if (!b) return a;
  try {
    return compareMoney(a, b) >= 0 ? a : b;
  } catch {
    return a;
  }
}

/** Most restrictive `Conditions` across offers. */
function combineConditions(offers) {
  const all = offers.map((o) => (isObject(o.conditions) ? o.conditions : undefined)).filter(Boolean);
  if (all.length === 0) return { refundable: false, changeable: false };
  /** @type {Conditions} */
  const out = {
    refundable: all.some((c) => c.refundable === false)
      ? false
      : all.some((c) => c.refundable === 'partial')
        ? 'partial'
        : all.every((c) => c.refundable === true),
    changeable: all.every((c) => c.changeable === true),
  };
  let change;
  let cancel;
  for (const c of all) {
    change = maxPenalty(change, c.changePenalty);
    cancel = maxPenalty(cancel, c.cancelPenalty);
  }
  put(out, 'changePenalty', change);
  put(out, 'cancelPenalty', cancel);
  const holds = all.map((c) => c.holdAllowed).filter((h) => typeof h === 'boolean');
  if (holds.length) out.holdAllowed = holds.every(Boolean);
  const voids = all.map((c) => str(c.voidUntil)).filter((v) => v !== undefined);
  if (voids.length) out.voidUntil = voids.sort()[0];
  const notes = uniq(all.flatMap((c) => (Array.isArray(c.notes) ? c.notes : [])));
  if (notes.length) out.notes = notes;
  return out;
}

/** Segment ids of an `Offer` in slice order. */
function offerSegmentIds(offer) {
  return objects(offer.slices).flatMap((slice) =>
    objects(slice.segments)
      .map((seg) => str(seg.id))
      .filter((id) => id !== undefined)
  );
}

/** Earliest of the given date / date‑time strings. */
function earliest(values) {
  const list = values.map((v) => str(v)).filter((v) => v !== undefined);
  return list.length ? list.sort()[0] : undefined;
}

/** Smallest defined number. */
function smallest(values) {
  const list = values.map((v) => num(v)).filter((v) => v !== undefined);
  return list.length ? Math.min(...list) : undefined;
}

/**
 * Synthesise the combined `Offer` of split mode out of the per‑slice offers Amadeus priced side by side
 * (§2.3 `offers.combine`, §3.2 tickets, C‑8): `id` = `scopeId(ctx.sessionId, ids.join('+'))` with `ids`
 * = `ctx.ids` or each offer's wire id; `slices` concatenated in order; `price` = the sums of every
 * `PriceBreakdown` member (one currency); `passengers` merged by type (unit prices summed, traveler ids
 * united); `conditions` the most restrictive (refundable false < partial < true, penalties the larger,
 * `holdAllowed` only when all allow it, notes united); `tickets` one `TicketGroup` per offer (`{ id:
 * offer id, segmentIds, carrier: owner }`, an offer's own groups kept when it has them);
 * `lastTicketingDate` / `ticketingDeadline` / `expiresAt` the earliest; `seatsLeft` / `bookableSeats` the
 * smallest; `emissionsKg` summed; `validatingAirlines` united; `owner` / `source` from the first offer;
 * `oneWayCombinable: false`; `baggage.items` concatenated with `bySegment: true`; `warnings` concatenated;
 * `raw` = the array of raw `FlightOffer`s. A single offer is returned as it is; an empty list gives
 * `undefined`.
 * @param {Offer[]} pricedOffers
 * @param {ConversionContext} [ctx]
 * @returns {Offer|undefined}
 * @throws {ValidationError} when the offers are priced in different currencies (not combinable)
 */
export function combineOffers(pricedOffers, ctx = {}) {
  const c = isObject(ctx) ? ctx : {};
  const offers = objects(pricedOffers);
  if (offers.length === 0) return undefined;
  if (offers.length === 1) return /** @type {Offer} */ (offers[0]);

  const currencies = offers.map((o) => str(o.price?.total?.currency) ?? '');
  const expected = currencies[0];
  const mismatch = currencies.findIndex((cur) => cur !== expected);
  if (mismatch >= 0) {
    throw new ValidationError('Offers cannot be combined: they are priced in different currencies', {
      issues: [
        {
          path: `offers[${mismatch}].price.total.currency`,
          code: 'currency_mismatch',
          message: `expected ${expected || 'one currency'}, got ${currencies[mismatch] || 'none'}`,
          params: { expected, actual: currencies[mismatch] },
        },
      ],
    });
  }

  const ids = Array.isArray(c.ids) && c.ids.length === offers.length ? c.ids.map(String) : undefined;
  const wireIds = ids ?? offers.map((o) => str(rawOf(o)?.id) ?? unscopeId(o.id).id ?? String(o.id));
  const first = offers[0];

  /** @type {TicketGroup[]} */
  const tickets = offers.flatMap((offer) =>
    Array.isArray(offer.tickets) && offer.tickets.length
      ? offer.tickets
      : [{ id: String(offer.id), segmentIds: offerSegmentIds(offer), carrier: offer.owner }]
  );

  /** @type {Offer} */
  const combined = {
    id: scopeId(c.sessionId, wireIds.join('+')),
    owner: first.owner,
    slices: offers.flatMap((o) => objects(o.slices)),
    price: combinePrice(offers),
    passengers: combinePassengers(offers),
    baggage: {
      bySegment: true,
      items: offers.flatMap((o) => (isObject(o.baggage) ? objects(o.baggage.items) : [])),
    },
    conditions: combineConditions(offers),
    tags: [],
    expiresAt: earliest(offers.map((o) => o.expiresAt)) ?? first.expiresAt,
    tickets,
    selfTransfer: false,
    oneWayCombinable: false,
    raw: offers.map((o) => rawOf(o) ?? o.raw),
  };
  const validating = uniq(
    offers.flatMap((o) => (Array.isArray(o.validatingAirlines) ? o.validatingAirlines : []))
  );
  if (validating.length) combined.validatingAirlines = validating;
  const fareFamilies = offers.map((o) => o.fareFamily).filter(isObject);
  if (
    fareFamilies.length === offers.length &&
    fareFamilies.every((f) => f.code === fareFamilies[0].code)
  ) {
    combined.fareFamily = fareFamilies[0];
  }
  put(combined, 'seatsLeft', smallest(offers.map((o) => o.seatsLeft)));
  put(combined, 'bookableSeats', smallest(offers.map((o) => o.bookableSeats)));
  const emissions = offers.map((o) => num(o.emissionsKg)).filter((v) => v !== undefined);
  if (emissions.length) combined.emissionsKg = emissions.reduce((a, b) => a + b, 0);
  put(combined, 'source', str(first.source));
  put(combined, 'lastTicketingDate', earliest(offers.map((o) => o.lastTicketingDate)));
  const deadlines = offers.map((o) => o.ticketingDeadline).filter(isObject);
  if (deadlines.length) {
    const date = earliest(deadlines.map((d) => d.date));
    const deadline = deadlines.find((d) => d.date === date) ?? deadlines[0];
    combined.ticketingDeadline = { ...deadline };
  }
  const anyTrue = (key) => (offers.some((o) => o[key] === true) ? true : undefined);
  put(combined, 'instantTicketingRequired', anyTrue('instantTicketingRequired'));
  put(combined, 'paymentCardRequired', anyTrue('paymentCardRequired'));
  put(combined, 'multiplePnrs', anyTrue('multiplePnrs'));
  const warnings = offers.flatMap((o) => (Array.isArray(o.warnings) ? o.warnings : []));
  if (warnings.length) combined.warnings = warnings;
  return combined;
}
