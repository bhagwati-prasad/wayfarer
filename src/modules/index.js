/**
 * Domain module registry of the Wayfarer SDK (docs/README.md §3, docs/CONTRIBUTING.md §2).
 * `MODULE_FACTORIES` maps a module name (`'search'`, `'offers'`, …) to its factory
 * (`(ctx: ModuleContext) => api`); `core/client.js` instantiates every entry (merged with the host's
 * `config.modules` overrides) and exposes each API as `client.<name>`. The domain scripts of later
 * work register themselves here through `registerModule(name, factory)` — this file invents none of
 * them and starts empty. It performs no I/O, touches no DOM or storage, keeps nothing but the
 * registry itself, never logs and never throws a plain `Error` (`ConfigError` for a bad name or
 * factory).
 */

import { ConfigError } from '../errors/index.js';

/** @typedef {import('../core/context.js').ModuleContext} ModuleContext */

/**
 * A domain module factory: receives the context, registers its slice and returns its public API
 * (usually `ctx.access.wrap(name, api)`), which must expose `destroy()`.
 * @typedef {(ctx: ModuleContext) => Record<string, any>} ModuleFactory
 */

/** Module name syntax: a plain identifier (`search`, `priceAlerts`). */
const NAME_RE = /^[A-Za-z_$][\w$]*$/;

/** Names that can never be modules (prototype‑pollution vectors). */
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Registry of domain module factories, name → factory. Empty until the domain scripts register
 * themselves; `createClient` instantiates every entry in insertion order.
 * @type {Record<string, ModuleFactory>}
 */
export const MODULE_FACTORIES = {};

/**
 * Register (or replace) a domain module factory under `name`. Returns a function that removes the
 * registration again (only when it is still the one made by this call), for tests and hot swaps.
 * Effects: none (registry write).
 * @param {string} name  Module name, a plain identifier such as `'search'`.
 * @param {ModuleFactory} factory  `(ctx) => api`.
 * @returns {() => void} unregister
 * @throws {ConfigError} when `name` is not an identifier or `factory` is not a function
 */
export function registerModule(name, factory) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || UNSAFE_NAMES.has(name)) {
    throw new ConfigError(
      `registerModule: name must be an identifier such as 'search' (received ${String(name)})`,
      { details: { path: 'name', received: name } }
    );
  }
  if (typeof factory !== 'function') {
    throw new ConfigError(`registerModule('${name}'): factory must be a function (ctx) => api`, {
      details: { path: 'factory', received: typeof factory },
    });
  }
  MODULE_FACTORIES[name] = factory;
  return () => {
    if (MODULE_FACTORIES[name] === factory) delete MODULE_FACTORIES[name];
  };
}
