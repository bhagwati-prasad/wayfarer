# wayfarer

Framework‑agnostic JavaScript SDK for building an online travel agency's **flights** frontend
against the OTA backend (`https://api.ota.com`, which exposes the Amadeus flight APIs in
`amadeus/` plus OTA‑specific endpoints).

Status: **design complete, implementation in progress.**

- `docs/README.md` — architecture, request lifecycle, state shape, event catalogue, flow
- `docs/api/*.md` — per‑script reference: signature · task · side effects for every function
- `docs/BACKEND-MAPPING.md` — Amadeus spec → SDK mapping, conflicts, gaps the backend must fill
- `docs/CONTRIBUTING.md` — module contract and conventions for contributors
- `docs/RESEARCH.md` — OTA / flight‑API feature matrix mapped to SDK modules
- `docs/QUESTIONS.md` — decision log and remaining open items
- `amadeus/` — backend contract (Amadeus swagger specifications)

Package layout: `src/core`, `src/http`, `src/auth` (standalone), `src/state`, `src/events`,
`src/errors`, `src/storage`, `src/utils`, `src/adapters/amadeus`, `src/modules/*` (one script
per domain), `src/payments` (isolated, with Stripe / PayPal / Razorpay adapters) and a separate
`src/ui/*` layer for building the search form, result lists, filters, forms, etc.
