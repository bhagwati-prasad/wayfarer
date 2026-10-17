# Contributing / internal conventions

These rules let many scripts be written independently and still compose. They are binding for every file under `src/`.

## 1. Language, style, dependencies

- ESM only (`"type": "module"`), plain JavaScript with **JSDoc types** on every export (`@param`, `@returns`, `@typedef`); `.d.ts` is generated from JSDoc by `npm run types`. Shared typedefs live in `src/types.js` (mirrors `docs/api/00-types.md`) and are referenced as `import('../types.js').Offer`.
- Named exports only; no default exports. One responsibility per script, named as in `docs/README.md §3`.
- **Zero runtime dependencies** in `src/` (gateway adapters load their vendor script at runtime via `<script>`; nothing else).
- Core (`core`, `http`, `auth`, `state`, `events`, `errors`, `storage`, `utils`, `modules`, `adapters`, `payments`) must be **SSR‑safe**: never touch `window`, `document`, `localStorage`, `navigator` at import time; feature‑detect at call time. `ui/*` may assume a DOM.
- Prettier defaults with `singleQuote: true`, `printWidth: 100`; ESLint recommended. No `console.*` in `src/` (use `ctx.logger`). No `TODO`/`FIXME` left behind.
- Never throw a plain `Error`: use the classes in `src/errors/index.js`.
- Every file starts with a one‑paragraph header comment: what it does, what it must not do.

## 2. Module factory contract (`src/modules/*.js`, `src/payments/index.js`)

Each domain script exports exactly one factory and nothing else public:

```js
/** @param {import('../core/context.js').ModuleContext} ctx */
export function createSearchModule(ctx) {
  ctx.store.registerSlice('search', { initial: INITIAL, persist: { pick: ['history'] } });
  async function create(params, options = {}, opts = {}) { /* … */ }
  // …
  return ctx.access.wrap('search', { create, get, poll, stop, cancel, /* … */ history: { list, remove, clear } });
}
```

- No module‑level mutable state. State lives in the store slice; timers/pollers are tracked in a local `Set` and cleared by the module's `destroy()` (every module exposes `destroy()`, called by `client.destroy()`).
- `ctx.access.wrap(moduleName, api)` returns the same shape with every function guarded under key `moduleName.fnName` (nested objects become `moduleName.group.fnName`). Pure helpers are `'open'` by default policy, so wrapping is harmless.
- Cross‑module calls go through `ctx.modules.<name>` **lazily at call time**, never inside the factory body (modules are created in dependency‑free order).
- Network: `ctx.http.<method>(ctx.endpoints.get('search.create', params), body, { tag: 'search', ...opts })`. Endpoint keys are `module.function` and are listed in `src/core/endpoints.js`.
- Amadeus‑shaped endpoints: build requests / parse responses only through `src/adapters/amadeus/*.js` (pure functions). Keep the untouched payload on `raw`.
- Events: `ctx.events.emit('search:start', payload)` — names from `docs/README.md §6`; the emitter adds `type` and `at`.
- Every network function accepts a trailing `opts` (`RequestOpts`) and forwards it to `http`.
- Validation happens before any network call and throws `ValidationError` with `issues[]`.

### `ModuleContext` (built by `src/core/client.js`, typedef in `src/core/context.js`)

```
config      frozen ClientConfig            endpoints   createEndpoints()
http        createHttp()                   store       createStore()
events      createEmitter()                storage     createStorage()
auth        createAuth()                   access      createAccess()
i18n        createI18n()                   telemetry   createTelemetry()
logger      createLogger().child(name)     features    createFeatures()
payments    PaymentsPort | nullPaymentsPort
modules     lazy accessor to sibling module APIs (getter per module name)
now()       injectable clock (ms)          timers      { setTimeout, clearTimeout, setInterval, clearInterval } (injectable)
```

## 3. State

- One slice per module, registered in the factory with `initial` and optional `persist: { storage: 'local'|'session'|'memory', ttlMs, pick: string[] }`.
- Updates only via `ctx.store.set('search', (s) => ({ ...s, status: 'loading' }), { action: 'search/create' })`. Never mutate.
- Derived data (visible offers, facets) is computed in the module and stored, or exposed through selectors in the same file; UI never recomputes domain logic.
- PII (traveler documents, card data) is never persisted client‑side. Drafts persist only when `config.persist.drafts` is on and never include documents.

## 4. HTTP

- `http` is the only place `fetch` is called. Interceptors mutate; hooks observe.
- Retry policy: network errors, 408, 425, 429, 5xx — only for idempotent requests (GET/HEAD/OPTIONS or an `Idempotency-Key` present). Honour `Retry-After`.
- Problem documents (RFC 9457) are parsed by `problemInterceptor` into `SdkError` subclasses; modules never inspect raw status codes.

## 5. UI (`src/ui/*.js`)

- `build<X>(container, options) → Handle` as in `docs/api/10-ui.md`. `container` may be an element or a selector.
- Render through `ui/core.js` helpers (`h`, `html`, `render`, `bind`). Classes are `wf-<block>__<element>--<modifier>`; colours/spacing only via `--wf-*` variables.
- Every builder subscribes to the store with `bind`/`store.subscribe` and unsubscribes in `destroy()`. Keyboard operability and ARIA roles are required, not optional.
- Builders call public core APIs only — nothing from `src/modules/*` internals.

## 6. Tests and mocks

- Vitest. Tests mirror source paths: `src/modules/search.js` → `test/modules/search.test.js`. UI tests use `// @vitest-environment jsdom` at the top of the file.
- Network is mocked with MSW. Handlers live in `src/mock/handlers/<module>.js` and are aggregated by `src/mock/handlers/index.js`; `src/mock/server.js` exports `createMockServer()` for apps and `test/setup.js` starts it for tests with `onUnhandledRequest: 'error'`.
- Fixtures are JSON in `src/mock/fixtures/`. For Amadeus‑backed endpoints the fixture **must** validate against the matching definition in `amadeus/*.json` (helper: `test/helpers/swagger.js` → `validateAgainst(specFile, definitionName, payload)`).
- Each module test covers: happy path, validation error, backend problem+json mapped to the right `SdkError`, emitted events, state transitions, timers/pollers via fake timers, `destroy()` leaving no listeners or timers.
- `npm test`, `npm run lint`, `npm run types` must pass before a change is considered done.

## 7. Docs are the spec

`docs/api/*.md` is normative. If implementation needs to deviate, change the doc in the same commit. `npm run docs:check` fails when a documented function has no export, or an export has no doc entry.
