/**
 * English (`en`) message bundle for the Wayfarer SDK — the base locale every other bundle falls back
 * to (docs/api/03-utils.md §9, docs/QUESTIONS.md #44). Strings use the ICU‑lite syntax understood by
 * `utils/i18n.js`: `{name}` interpolation, `{count, plural, =0{…} one{…} other{…}}` with `#` for the
 * count, and `{value, select, a{…} other{…}}`. The bundle is organised by namespace: `errors.*` holds
 * the user‑safe copy `errors.toUserMessage` looks up (`errors.<copyKey>.title|message`, e.g.
 * `errors.auth.expired.title`) plus one `errors.<CODE>.title|message` entry for every canonical
 * error code (`ERROR_CODES` and every class default in `src/errors/index.js`); `common.*` holds the
 * labels for domain enumerations (stops, cabins, passenger / fare types, time buckets, sort keys,
 * booking / payment statuses, trip phases, …); `ui.*` the generic interface strings; `validation.*`
 * the field‑level messages. This file is data only: it must not import anything but `deepFreeze`,
 * must never contain server‑supplied text and must never be mutated at runtime (it is frozen) —
 * hosts override through `createI18n({ messages })` / `i18n.addMessages`.
 */

import { deepFreeze } from '../object.js';

/**
 * Nested message tree: leaves are ICU‑lite strings (or numbers), branches group them by namespace.
 * @typedef {{ [key: string]: string | number | Messages }} Messages
 */

/** @type {Readonly<Messages>} */
export const en = deepFreeze({
  // ── errors: copy keys used by errors.toUserMessage (errors.<copyKey>.title|message) ──────────
  errors: {
    network: {
      title: 'Connection problem',
      message: "We couldn't reach the server. Check your connection and try again.",
    },
    timeout: {
      title: 'Request timed out',
      message: 'The server took too long to respond. Please try again.',
    },
    abort: { title: 'Request cancelled', message: 'The request was cancelled.' },
    validation: {
      title: 'Check your details',
      message: 'Some of the information provided is invalid. Please review and try again.',
    },
    config: {
      title: 'Configuration error',
      message: 'The application is not configured correctly. Please contact support.',
    },
    storage: {
      title: 'Storage unavailable',
      message: "We couldn't save your data on this device. You can continue without it.",
    },
    unsupported: {
      title: 'Not supported',
      message: "This feature isn't available on this device or browser.",
    },
    auth: {
      unauthenticated: { title: 'Sign in required', message: 'Please sign in to continue.' },
      expired: {
        title: 'Session expired',
        message: 'Your session has expired. Please sign in again.',
      },
      forbidden: { title: 'Access denied', message: "You don't have permission to do that." },
      invalid_credentials: {
        title: 'Sign-in failed',
        message: 'The email or password you entered is incorrect.',
      },
      mfa_required: {
        title: 'Verification required',
        message: 'Enter the verification code to continue.',
      },
      otp_invalid: {
        title: 'Invalid code',
        message: 'The code you entered is incorrect. Please try again.',
      },
      otp_expired: {
        title: 'Code expired',
        message: 'The code has expired. Please request a new one.',
      },
      locked: {
        title: 'Account locked',
        message: 'Your account has been locked after too many attempts. Please contact support.',
      },
    },
    rate_limit: {
      title: 'Too many requests',
      message: 'Please wait a moment and try again.',
      seconds: {
        title: 'Too many requests',
        message: 'Please wait {seconds, plural, one{# second} other{# seconds}} and try again.',
      },
    },
    not_found: { title: 'Not found', message: "We couldn't find what you were looking for." },
    conflict: {
      title: 'Something changed',
      message:
        "This action couldn't be completed because the information has changed. Please refresh and try again.",
    },
    search_expired: {
      title: 'Search expired',
      message: 'Fares change frequently, so your search results have expired. Please search again.',
    },
    offer_expired: {
      title: 'Fare expired',
      message: 'This fare is no longer available. Please search again for current fares.',
    },
    offer_unavailable: {
      sold_out: {
        title: 'Sold out',
        message: 'This flight has sold out. Please choose another option.',
      },
      withdrawn: {
        title: 'Fare no longer available',
        message: 'This fare has been withdrawn by the airline. Please choose another option.',
      },
      schedule_changed: {
        title: 'Schedule changed',
        message:
          'The schedule for this flight has changed. Please search again for current options.',
      },
    },
    price_changed: {
      title: 'Price changed',
      message:
        'The price of your itinerary has changed. Please review the new price before continuing.',
      amounts: {
        title: 'Price changed',
        message:
          'The price of your itinerary has changed from {from} to {to}. Please review before continuing.',
      },
    },
    itinerary_expired: {
      title: 'Itinerary expired',
      message: 'Your itinerary has expired. Please start again from search.',
    },
    booking: {
      retry_payment: {
        title: 'Booking not completed',
        message: "We couldn't complete your booking. Please try the payment again.",
      },
      search_again: {
        title: 'Booking not completed',
        message: "We couldn't complete your booking. Please search again for available fares.",
      },
      wait: {
        title: 'Booking in progress',
        message: 'Your booking is still being processed. Please wait a moment and check again.',
      },
      contact_support: {
        title: 'Booking failed',
        message: "We couldn't complete your booking. Please contact support for help.",
      },
    },
    payment: {
      declined: {
        title: 'Payment declined',
        message: 'Your payment was declined. Please try another payment method.',
      },
      insufficient_funds: {
        title: 'Insufficient funds',
        message: 'There are not enough funds available. Please try another payment method.',
      },
      authentication_failed: {
        title: 'Authentication failed',
        message: "We couldn't verify your payment. Please try again.",
      },
      expired: {
        title: 'Payment expired',
        message: 'The payment session expired. Please try again.',
      },
      cancelled: {
        title: 'Payment cancelled',
        message: 'The payment was cancelled. You can try again when ready.',
      },
      gateway: {
        title: 'Payment unavailable',
        message:
          "We couldn't process your payment right now. Please try again or use another method.",
      },
      fraud: {
        title: 'Payment not accepted',
        message: "This payment couldn't be accepted. Please contact support.",
      },
      method_unavailable: {
        title: 'Payment method unavailable',
        message: "This payment method isn't available right now. Please choose another.",
      },
      requires_action: {
        title: 'Verification required',
        message: 'Your bank requires additional verification to complete this payment.',
      },
    },
    servicing: {
      title: 'Not available online',
      message: "This change isn't available online for your booking. Please contact support.",
    },
    unprocessable: {
      title: 'Check your details',
      message:
        "Some of the information provided couldn't be accepted. Please review and try again.",
    },
    api: {
      retryable: {
        title: 'Something went wrong',
        message: "We're having trouble right now. Please try again in a moment.",
      },
      failed: {
        title: 'Something went wrong',
        message:
          "We couldn't complete your request. Please try again or contact support if it persists.",
      },
    },
    unknown: {
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Please try again.',
    },

    // ── errors: canonical codes (errors.<CODE>.title|message) — offers / search / itinerary ──────
    OFFER_EXPIRED: {
      title: 'Fare expired',
      message: 'This fare is no longer available. Please search again for current fares.',
    },
    OFFER_UNAVAILABLE: {
      title: 'Fare unavailable',
      message: 'This fare is no longer available. Please choose another option.',
    },
    SOLD_OUT: {
      title: 'Sold out',
      message: 'This flight has sold out. Please choose another option.',
    },
    OFFER_WITHDRAWN: {
      title: 'Fare no longer available',
      message: 'This fare has been withdrawn by the airline. Please choose another option.',
    },
    SCHEDULE_CHANGED: {
      title: 'Schedule changed',
      message: 'The schedule for this flight has changed. Please search again for current options.',
    },
    PRICE_CHANGED: {
      title: 'Price changed',
      message:
        'The price of your itinerary has changed. Please review the new price before continuing.',
    },
    SEARCH_EXPIRED: {
      title: 'Search expired',
      message: 'Fares change frequently, so your search results have expired. Please search again.',
    },
    ITINERARY_EXPIRED: {
      title: 'Itinerary expired',
      message: 'Your itinerary has expired. Please start again from search.',
    },
    SEAT_TAKEN: {
      title: 'Seat no longer available',
      message: 'The seat you chose has just been taken. Please pick another seat.',
    },
    SERVICE_UNAVAILABLE: {
      title: 'Extra unavailable',
      message: 'This extra is no longer available for your flight. Please choose another option.',
    },
    // travellers / promo / credits
    NAME_MISMATCH: {
      title: 'Name mismatch',
      message:
        'The name entered does not match the travel document. Please check it and try again.',
    },
    DOCUMENT_INVALID: {
      title: 'Invalid travel document',
      message: 'The travel document details are invalid or expired. Please check and try again.',
    },
    DUPLICATE_TRAVELER: {
      title: 'Duplicate traveller',
      message:
        'The same traveller has been added more than once. Please review the passenger details.',
    },
    PROMO_INVALID: {
      title: 'Invalid promo code',
      message: 'This promo code is not valid. Please check the code and try again.',
    },
    PROMO_NOT_ELIGIBLE: {
      title: 'Promo code not applicable',
      message: 'This promo code cannot be used with this booking.',
    },
    PROMO_EXPIRED: { title: 'Promo code expired', message: 'This promo code has expired.' },
    GIFT_CARD_INVALID: {
      title: 'Invalid gift card',
      message: 'This gift card is not valid. Please check the number and try again.',
    },
    INSUFFICIENT_BALANCE: {
      title: 'Insufficient balance',
      message:
        'Your balance is not enough to cover this amount. Please add another payment method.',
    },
    VOUCHER_NOT_APPLICABLE: {
      title: 'Voucher not applicable',
      message: 'This voucher cannot be used for this booking.',
    },
    // booking / payment / servicing
    BOOKING_FAILED: {
      title: 'Booking failed',
      message: "We couldn't complete your booking. Please try again or contact support.",
    },
    HOLD_NOT_ALLOWED: {
      title: 'Hold not available',
      message: 'This fare cannot be held. Please pay now to confirm your booking.',
    },
    PAYMENT_DECLINED: {
      title: 'Payment declined',
      message: 'Your payment was declined. Please try another payment method.',
    },
    PAYMENT_REQUIRES_ACTION: {
      title: 'Verification required',
      message: 'Your bank requires additional verification to complete this payment.',
    },
    PAYMENT_INSUFFICIENT_FUNDS: {
      title: 'Insufficient funds',
      message: 'There are not enough funds available. Please try another payment method.',
    },
    PAYMENT_AUTHENTICATION_FAILED: {
      title: 'Authentication failed',
      message: "We couldn't verify your payment. Please try again.",
    },
    PAYMENT_EXPIRED: {
      title: 'Payment expired',
      message: 'The payment session expired. Please try again.',
    },
    PAYMENT_CANCELLED: {
      title: 'Payment cancelled',
      message: 'The payment was cancelled. You can try again when ready.',
    },
    PAYMENT_GATEWAY_ERROR: {
      title: 'Payment unavailable',
      message:
        "We couldn't process your payment right now. Please try again or use another method.",
    },
    PAYMENT_FRAUD: {
      title: 'Payment not accepted',
      message: "This payment couldn't be accepted. Please contact support.",
    },
    PAYMENT_METHOD_UNAVAILABLE: {
      title: 'Payment method unavailable',
      message: "This payment method isn't available right now. Please choose another.",
    },
    PAYMENT_FAILED: {
      title: 'Payment failed',
      message: "Your payment couldn't be completed. Please try again or use another method.",
    },
    CHANGE_NOT_ALLOWED: {
      title: 'Change not available',
      message: 'This booking cannot be changed online. Please contact support.',
    },
    CANCEL_NOT_ALLOWED: {
      title: 'Cancellation not available',
      message: 'This booking cannot be cancelled online. Please contact support.',
    },
    SERVICING_NOT_ALLOWED: {
      title: 'Not available online',
      message: "This change isn't available online for your booking. Please contact support.",
    },
    // auth
    SESSION_EXPIRED: {
      title: 'Session expired',
      message: 'Your session has expired. Please sign in again.',
    },
    UNAUTHENTICATED: { title: 'Sign in required', message: 'Please sign in to continue.' },
    FORBIDDEN: { title: 'Access denied', message: "You don't have permission to do that." },
    INVALID_CREDENTIALS: {
      title: 'Sign-in failed',
      message: 'The email or password you entered is incorrect.',
    },
    MFA_REQUIRED: {
      title: 'Verification required',
      message: 'Enter the verification code to continue.',
    },
    OTP_INVALID: {
      title: 'Invalid code',
      message: 'The code you entered is incorrect. Please try again.',
    },
    OTP_EXPIRED: {
      title: 'Code expired',
      message: 'The code has expired. Please request a new one.',
    },
    ACCOUNT_LOCKED: {
      title: 'Account locked',
      message: 'Your account has been locked after too many attempts. Please contact support.',
    },
    // generic http
    RATE_LIMITED: {
      title: 'Too many requests',
      message: 'Please wait a moment and try again.',
    },
    NOT_FOUND: { title: 'Not found', message: "We couldn't find what you were looking for." },
    CONFLICT: {
      title: 'Something changed',
      message:
        "This action couldn't be completed because the information has changed. Please refresh and try again.",
    },
    VALIDATION_FAILED: {
      title: 'Check your details',
      message: 'Some of the information provided is invalid. Please review and try again.',
    },
    UNPROCESSABLE: {
      title: 'Check your details',
      message:
        "Some of the information provided couldn't be accepted. Please review and try again.",
    },
    BAD_REQUEST: {
      title: 'Invalid request',
      message: "We couldn't process this request. Please check your details and try again.",
    },
    PAYMENT_REQUIRED: {
      title: 'Payment required',
      message: 'This booking needs to be paid before you can continue.',
    },
    REQUEST_TIMEOUT: {
      title: 'Request timed out',
      message: 'The server took too long to respond. Please try again.',
    },
    TOO_EARLY: {
      title: 'Please wait',
      message: 'The server is not ready yet. Please try again in a moment.',
    },
    INTERNAL_ERROR: {
      title: 'Something went wrong',
      message: "We're having trouble right now. Please try again in a moment.",
    },
    BAD_GATEWAY: {
      title: 'Service unavailable',
      message: 'One of our services is not responding. Please try again in a moment.',
    },
    SERVER_UNAVAILABLE: {
      title: 'Service unavailable',
      message: 'The service is temporarily unavailable. Please try again in a moment.',
    },
    GATEWAY_TIMEOUT: {
      title: 'Service timed out',
      message: 'One of our services took too long to respond. Please try again.',
    },
    API_ERROR: {
      title: 'Something went wrong',
      message:
        "We couldn't complete your request. Please try again or contact support if it persists.",
    },
    // sdk‑local
    SDK_ERROR: {
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Please try again.',
    },
    CONFIG_ERROR: {
      title: 'Configuration error',
      message: 'The application is not configured correctly. Please contact support.',
    },
    NETWORK_ERROR: {
      title: 'Connection problem',
      message: "We couldn't reach the server. Check your connection and try again.",
    },
    TIMEOUT: {
      title: 'Request timed out',
      message: 'The server took too long to respond. Please try again.',
    },
    ABORTED: { title: 'Request cancelled', message: 'The request was cancelled.' },
    STORAGE_ERROR: {
      title: 'Storage unavailable',
      message: "We couldn't save your data on this device. You can continue without it.",
    },
    UNSUPPORTED: {
      title: 'Not supported',
      message: "This feature isn't available on this device or browser.",
    },
    UNKNOWN_ERROR: {
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Please try again.',
    },
  },

  // ── common: labels for domain enumerations ───────────────────────────────────────────────────
  common: {
    stops: {
      label: 'Stops',
      count: '{count, plural, =0{Non-stop} one{# stop} other{# stops}}',
      nonstop: 'Non-stop',
      direct: 'Direct',
      any: 'Any number of stops',
      upTo: '{count, plural, =0{Non-stop only} one{Up to # stop} other{Up to # stops}}',
      via: 'via {airport}',
    },
    cabins: {
      label: 'Cabin',
      economy: 'Economy',
      premium_economy: 'Premium economy',
      business: 'Business',
      first: 'First',
      mixed: 'Mixed cabins',
    },
    paxTypes: {
      label: 'Passenger type',
      ADT: 'Adult',
      CHD: 'Child',
      INF: 'Infant (on lap)',
      INS: 'Infant (with seat)',
      YTH: 'Youth',
      SRC: 'Senior',
      STU: 'Student',
    },
    paxCount: {
      ADT: '{count, plural, one{# adult} other{# adults}}',
      CHD: '{count, plural, one{# child} other{# children}}',
      INF: '{count, plural, one{# infant} other{# infants}}',
      INS: '{count, plural, one{# infant with seat} other{# infants with seats}}',
      YTH: '{count, plural, one{# youth} other{# youths}}',
      SRC: '{count, plural, one{# senior} other{# seniors}}',
      STU: '{count, plural, one{# student} other{# students}}',
    },
    paxAgeHints: {
      ADT: '12+ years',
      CHD: '2–11 years',
      INF: 'Under 2 years',
      INS: 'Under 2 years',
      YTH: '12–25 years',
      SRC: '60+ years',
      STU: 'With valid student ID',
    },
    passengers: '{count, plural, one{# passenger} other{# passengers}}',
    travellers: '{count, plural, one{# traveller} other{# travellers}}',
    fareTypes: {
      label: 'Fare type',
      regular: 'Regular',
      student: 'Student',
      senior: 'Senior citizen',
      armed_forces: 'Armed forces',
      doctor: 'Doctors and nurses',
      corporate: 'Corporate',
      youth: 'Youth',
    },
    tripTypes: {
      label: 'Trip type',
      one_way: 'One way',
      round_trip: 'Round trip',
      multi_city: 'Multi-city',
    },
    resultModes: {
      label: 'Show results as',
      per_slice: 'Separate flights (choose outbound and return)',
      combined: 'Combined round trips',
    },
    timeBuckets: {
      label: 'Time of day',
      early_morning: 'Early morning',
      morning: 'Morning',
      afternoon: 'Afternoon',
      evening: 'Evening',
      night: 'Night',
    },
    timeBucketRanges: {
      early_morning: 'Before 6:00',
      morning: '6:00 – 12:00',
      afternoon: '12:00 – 18:00',
      evening: '18:00 – 24:00',
      night: 'Before 6:00',
    },
    sortKeys: {
      label: 'Sort by',
      best: 'Best',
      price: 'Price',
      duration: 'Duration',
      departure: 'Departure time',
      arrival: 'Arrival time',
      emissions: 'Emissions',
    },
    sortDir: { asc: 'Low to high', desc: 'High to low' },
    offerTags: {
      cheapest: 'Cheapest',
      fastest: 'Fastest',
      best: 'Best value',
      earliest: 'Earliest',
      recommended: 'Recommended',
    },
    searchStatuses: {
      pending: 'Starting search',
      streaming: 'Finding flights',
      complete: 'Search complete',
      expired: 'Search expired',
      error: 'Search failed',
      cancelled: 'Search cancelled',
    },
    itineraryStatuses: {
      active: 'Active',
      expired: 'Expired',
      booked: 'Booked',
      abandoned: 'Abandoned',
    },
    bookingStatuses: {
      label: 'Booking status',
      draft: 'Draft',
      pending_payment: 'Awaiting payment',
      on_hold: 'On hold',
      processing: 'Processing',
      confirmed: 'Confirmed',
      ticketed: 'Ticketed',
      partially_ticketed: 'Partially ticketed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
      expired: 'Expired',
    },
    paymentStatuses: {
      label: 'Payment status',
      requires_method: 'Choose a payment method',
      requires_confirmation: 'Awaiting confirmation',
      requires_action: 'Verification required',
      processing: 'Processing',
      succeeded: 'Paid',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    paymentMethods: {
      label: 'Payment method',
      card: 'Credit or debit card',
      upi: 'UPI',
      netbanking: 'Net banking',
      wallet: 'Wallet',
      apple_pay: 'Apple Pay',
      google_pay: 'Google Pay',
      paypal: 'PayPal',
      bnpl: 'Buy now, pay later',
      emi: 'EMI',
      bank_transfer: 'Bank transfer',
      pay_later: 'Pay later',
      loyalty_points: 'Loyalty points',
      gift_card: 'Gift card',
      ota_wallet: 'Travel wallet',
      voucher: 'Voucher',
    },
    refundStatuses: {
      requested: 'Refund requested',
      processing: 'Refund in progress',
      completed: 'Refunded',
      failed: 'Refund failed',
    },
    tripPhases: {
      label: 'Trips',
      upcoming: 'Upcoming',
      past: 'Past',
      cancelled: 'Cancelled',
    },
    tripActions: {
      change: 'Change flight',
      cancel: 'Cancel booking',
      cancel_partial: 'Cancel part of the booking',
      add_seats: 'Add seats',
      add_bags: 'Add baggage',
      add_meals: 'Add meals',
      check_in: 'Check in',
      name_correction: 'Correct a name',
      special_assistance: 'Request special assistance',
      update_contact: 'Update contact details',
      update_documents: 'Update travel documents',
      split_pnr: 'Split booking',
      download_eticket: 'Download e-ticket',
      invoice: 'Download invoice',
      gst_invoice: 'Download GST invoice',
      resend: 'Resend confirmation',
      pay_now: 'Pay now',
      void: 'Void ticket',
      rebook: 'Book again',
      support: 'Contact support',
    },
    flightStatuses: {
      scheduled: 'Scheduled',
      on_time: 'On time',
      delayed: 'Delayed',
      departed: 'Departed',
      landed: 'Landed',
      cancelled: 'Cancelled',
      diverted: 'Diverted',
    },
    checkInStatuses: {
      not_open: 'Check-in not open yet',
      open: 'Check-in open',
      closed: 'Check-in closed',
      done: 'Checked in',
    },
    ancillaryTypes: {
      seat: 'Seat',
      baggage: 'Baggage',
      meal: 'Meal',
      insurance: 'Travel insurance',
      protection: 'Protection',
      priority_boarding: 'Priority boarding',
      lounge: 'Lounge access',
      fast_track: 'Fast track',
      wifi: 'Wi-Fi',
      carbon_offset: 'Carbon offset',
      bundle: 'Bundle',
    },
    protections: {
      price_drop: 'Price drop protection',
      cfar: 'Cancel for any reason',
      flexible_ticket: 'Flexible ticket',
      zero_cancellation: 'Zero cancellation fee',
      disruption_guarantee: 'Disruption guarantee',
      baggage_protection: 'Baggage protection',
      price_lock: 'Price lock',
    },
    documents: {
      eticket: 'E-ticket',
      invoice: 'Invoice',
      gst_invoice: 'GST invoice',
      receipt: 'Receipt',
      insurance_policy: 'Insurance policy',
      visa_letter: 'Visa letter',
    },
    priceLevels: { low: 'Low', typical: 'Typical', high: 'High' },
    priceTrends: {
      rising: 'Prices are rising',
      falling: 'Prices are falling',
      flat: 'Prices are steady',
    },
    priceAdvice: { buy: 'Good time to book', wait: 'Prices may drop' },
    refundable: {
      yes: 'Refundable',
      partial: 'Partially refundable',
      no: 'Non-refundable',
    },
    changeable: { yes: 'Changes allowed', no: 'No changes allowed' },
    baggage: {
      cabin: 'Cabin bag',
      checked: 'Checked bag',
      included: 'Included',
      notIncluded: 'Not included',
      pieces: '{count, plural, one{# piece} other{# pieces}}',
      weight: '{kg} kg',
    },
    dayChange: '{count, plural, =0{} one{+# day} other{+# days}}',
    overnight: 'Overnight',
    selfTransfer: 'Self-transfer',
    airportChange: 'Airport change',
    layover: '{duration} in {airport}',
    operatedBy: 'Operated by {airline}',
    seatsLeft: '{count, plural, one{Only # seat left} other{# seats left}}',
    outbound: 'Outbound',
    inbound: 'Return',
    leg: 'Flight {index}',
    perPax: 'per passenger',
    total: 'total',
    taxesAndFees: 'Taxes and fees',
    baseFare: 'Base fare',
    discount: 'Discount',
    extras: 'Extras',
    free: 'Free',
    included: 'Included',
    notAvailable: 'Not available',
  },

  // ── ui: generic interface strings ────────────────────────────────────────────────────────────
  ui: {
    continue: 'Continue',
    back: 'Back',
    next: 'Next',
    done: 'Done',
    retry: 'Retry',
    tryAgain: 'Try again',
    apply: 'Apply',
    reset: 'Reset',
    clear: 'Clear',
    clearAll: 'Clear all',
    close: 'Close',
    cancel: 'Cancel',
    confirm: 'Confirm',
    save: 'Save',
    edit: 'Edit',
    remove: 'Remove',
    add: 'Add',
    select: 'Select',
    selected: 'Selected',
    change: 'Change',
    search: 'Search',
    searchFlights: 'Search flights',
    searching: 'Searching for flights…',
    loading: 'Loading…',
    loadMore: 'Load more',
    showMore: 'Show more',
    showLess: 'Show less',
    viewDetails: 'View details',
    hideDetails: 'Hide details',
    selectFlight: 'Select flight',
    selectFare: 'Select fare',
    pricePerPax: 'Price per passenger',
    priceTotal: 'Total price',
    pricePer: { pax: 'Per passenger', total: 'Total' },
    total: 'Total',
    subtotal: 'Subtotal',
    includesTaxes: 'Includes taxes and fees',
    from: 'From',
    to: 'To',
    depart: 'Depart',
    return: 'Return',
    dates: 'Dates',
    passengers: 'Passengers',
    cabin: 'Cabin',
    filters: 'Filters',
    sort: 'Sort',
    sortBy: 'Sort by',
    results: '{count, plural, =0{No flights found} one{# flight found} other{# flights found}}',
    noResults: 'No flights match your search',
    noResultsHint: 'Try different dates, nearby airports or fewer filters.',
    newResults: 'New results available',
    expiresIn: 'Expires in {time}',
    expired: 'Expired',
    refresh: 'Refresh',
    bookNow: 'Book now',
    payNow: 'Pay now',
    hold: 'Hold fare',
    holdFor: 'Hold for {duration}',
    proceedToPayment: 'Proceed to payment',
    review: 'Review',
    travellers: 'Travellers',
    extras: 'Extras',
    payment: 'Payment',
    confirmation: 'Confirmation',
    step: 'Step {current} of {total}',
    signIn: 'Sign in',
    signOut: 'Sign out',
    register: 'Create account',
    continueAsGuest: 'Continue as guest',
    email: 'Email',
    password: 'Password',
    phone: 'Phone number',
    optional: 'Optional',
    required: 'Required',
    yes: 'Yes',
    no: 'No',
    ok: 'OK',
    more: 'More',
    less: 'Less',
    today: 'Today',
    tomorrow: 'Tomorrow',
    error: 'Error',
    success: 'Success',
    warning: 'Warning',
    info: 'Information',
    dismiss: 'Dismiss',
    copy: 'Copy',
    copied: 'Copied',
    download: 'Download',
    share: 'Share',
    print: 'Print',
    help: 'Help',
    support: 'Support',
    contactSupport: 'Contact support',
    goHome: 'Go to home page',
    bookingReference: 'Booking reference',
    pnr: 'Airline PNR',
    bookingConfirmed: 'Your booking is confirmed',
    bookingProcessing: 'We are confirming your booking…',
    bookingFailed: "We couldn't complete your booking",
    paymentProcessing: 'Processing your payment…',
    redirecting: 'Redirecting to your bank…',
    swap: 'Swap origin and destination',
    nearbyAirports: 'Include nearby airports',
    directOnly: 'Non-stop flights only',
    flexibleDates: 'Flexible dates (±{days})',
    compare: 'Compare',
    compareTray:
      '{count, plural, =0{No flights to compare} one{# flight to compare} other{# flights to compare}}',
    a11y: {
      closeDialog: 'Close dialog',
      loading: 'Loading, please wait',
      menu: 'Menu',
      previousMonth: 'Previous month',
      nextMonth: 'Next month',
      selectedFlight: 'Selected flight',
      sortedBy: 'Sorted by {key}',
      filtersActive:
        '{count, plural, =0{No filters active} one{# filter active} other{# filters active}}',
    },
  },

  // ── validation: field‑level messages (params come from ValidationIssue.params) ──────────────
  validation: {
    required: 'This field is required',
    invalid: 'Please enter a valid value',
    type: 'Please enter a valid value',
    pattern: 'Please enter a valid value',
    enum: 'Please choose one of the available options',
    min: 'Must be at least {min}',
    max: 'Must be at most {max}',
    minLength: 'Must be at least {min, plural, one{# character} other{# characters}}',
    maxLength: 'Must be at most {max, plural, one{# character} other{# characters}}',
    email: 'Please enter a valid email address',
    phone: 'Please enter a valid phone number',
    date: 'Please enter a valid date',
    past: 'Date must be in the past',
    future: 'Date must be in the future',
    iata: 'Please enter a valid airport or city code',
    sameAirport: 'Origin and destination must be different',
    dateOrder: 'Return date must be after the departure date',
    postalCode: 'Please enter a valid postal code',
    passport: 'Please enter a valid passport number',
    gstin: 'Please enter a valid GSTIN',
    pan: 'Please enter a valid PAN',
    vpa: 'Please enter a valid UPI ID',
    card: 'Please enter a valid card number',
    cardExpiry: 'Please enter a valid expiry date',
    cvv: 'Please enter a valid security code',
    name: 'Please enter the name exactly as on the travel document',
    nameLength: 'The combined name is too long for the airline ticket',
    documentExpiry:
      'The document must be valid for at least {months, plural, one{# month} other{# months}} after travel',
    ageForType: 'Age on the travel date does not match the passenger type',
    infantsPerAdult: 'Each infant must travel with an adult',
    maxPassengers:
      'You can book up to {max, plural, one{# passenger} other{# passengers}} at a time',
    childAges: 'Please enter the age of every child',
    passwordPolicy: 'Password does not meet the requirements',
    passwordMatch: 'Passwords do not match',
    consent: 'Please accept the terms to continue',
    promo: 'Please enter a valid promo code',
  },
});
