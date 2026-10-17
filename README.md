# wayfarer

Framework‑agnostic JavaScript SDK for building an online travel agency's **flights** frontend
against the OTA backend (`https://api.ota.com/v1`).

Status: **design phase** — the API reference is written, implementation follows once the
open questions are settled.

- `docs/README.md` — architecture, request lifecycle, state shape, event catalogue, flow
- `docs/api/*.md` — per‑script reference: signature · task · side effects for every function
- `docs/RESEARCH.md` — OTA / flight‑API feature matrix mapped to SDK modules
- `docs/QUESTIONS.md` — open decisions with proposed defaults

Planned package layout: `src/core`, `src/http`, `src/auth`, `src/state`, `src/events`,
`src/errors`, `src/storage`, `src/utils`, `src/modules/*` (one script per domain) and a
separate `src/ui/*` layer for building the search form, result lists, filters, forms, etc.
