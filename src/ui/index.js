/**
 * PLACEHOLDER — `@wayfarer/sdk/ui` entry (docs/api/10-ui.md, docs/README.md §3). The UI builders are
 * not built yet; this file only exists so the `ui` entry of package.json / vite.config.js resolves.
 * `createUI` throws `UnsupportedError{feature:'ui'}` until the real builders land. It touches no DOM
 * at import time, keeps no state and must not grow logic of its own: replace it, do not extend it.
 */

import { UnsupportedError } from '../errors/index.js';

/**
 * Create the UI builders bound to a client (docs/api/10-ui.md §1). Not available yet.
 * @param {import('../core/client.js').OtaClient} [_client]
 * @param {Record<string, unknown>} [_options]
 * @returns {never}
 * @throws {UnsupportedError} always (`feature: 'ui'`) — the UI package is not built yet
 */
export function createUI(_client, _options) {
  throw new UnsupportedError('ui not built yet', { feature: 'ui' });
}
