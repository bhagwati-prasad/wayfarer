/**
 * PLACEHOLDER (minimal, real) — `@wayfarer/sdk/mock` entry (docs/CONTRIBUTING.md §6, docs/README.md
 * §3). `createMockServer()` wires the MSW handlers aggregated by `mock/handlers/index.js` into a
 * `setupServer`‑style object for Node (apps and tests); `test/setup.js` does the same for the test
 * run. It stays this small until the module handlers land: no fixtures or handlers of its own, no
 * logic beyond the delegation. `msw/node` is a dev dependency of the host and is never bundled
 * (external in vite.config.js), so this entry must never be imported by `src/index.js`.
 */

import { setupServer } from 'msw/node';
import { handlers } from './handlers/index.js';

/**
 * Create an MSW Node server preloaded with every SDK handler. `extra` handlers (host overrides) are
 * prepended, so they take precedence over the SDK's. Effects: none until `listen()` is called.
 * @param {import('msw').RequestHandler[]} [extra]
 * @returns {ReturnType<typeof setupServer>}  `{ listen, close, use, resetHandlers, … }`
 */
export function createMockServer(extra = []) {
  return setupServer(...(Array.isArray(extra) ? extra : []), ...handlers);
}
