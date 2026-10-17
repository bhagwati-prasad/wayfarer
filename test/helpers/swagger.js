// Validate a JSON payload against a named definition of one of the Amadeus swagger specs in amadeus/.
// Usage: const { valid, errors } = validateAgainst('FlightOffersSearch_v2_Version_1.0_swagger_specification.json', 'FlightOffer', payload)
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, '../../amadeus');
const cache = new Map();

/** Resolve a spec file by exact name or by prefix (e.g. 'FlightOffersSearch'). */
export function specPath(name) {
  if (name.endsWith('.json')) return resolve(specDir, name);
  const match = readdirSync(specDir).find((f) => f.startsWith(name) && f.endsWith('.json'));
  if (!match) throw new Error(`No Amadeus spec starting with ${name}`);
  return resolve(specDir, match);
}

export function loadSpec(name) {
  const path = specPath(name);
  if (!cache.has(path)) cache.set(path, JSON.parse(readFileSync(path, 'utf8')));
  return cache.get(path);
}

/** Collect every local $ref target name used anywhere in the spec. */
function collectRefs(node, out) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.add(v.split('/').pop());
      else collectRefs(v, out);
    }
  }
  return out;
}

/** Names referenced by $ref but missing from the spec (Amadeus files have a few, e.g. commissionValue). */
export function danglingRefs(specName) {
  const spec = loadSpec(specName);
  const defs = spec.definitions || (spec.components && spec.components.schemas) || {};
  return [...collectRefs(spec, new Set())].filter((n) => !defs[n]);
}

function compile(spec, definitionName) {
  const defs = { ...(spec.definitions || (spec.components && spec.components.schemas) || {}) };
  if (!defs[definitionName]) throw new Error(`Definition ${definitionName} not found`);
  // Amadeus specs reference a few definitions they never declare; treat those as "anything".
  for (const name of collectRefs(spec, new Set())) if (!defs[name]) defs[name] = {};
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  // Swagger 2.0 refs point at #/definitions/X; register the whole spec as the root document.
  const root = { $id: 'spec', definitions: defs, components: spec.components && { schemas: defs } };
  ajv.addSchema(root);
  const refBase = spec.definitions ? 'spec#/definitions/' : 'spec#/components/schemas/';
  return ajv.compile({ $ref: `${refBase}${definitionName}` });
}

/** @returns {{ valid: boolean, errors: object[] }} */
export function validateAgainst(specName, definitionName, payload) {
  const validate = compile(loadSpec(specName), definitionName);
  const valid = validate(payload);
  return { valid, errors: validate.errors || [] };
}

/** Vitest helper: throws with readable ajv errors when invalid. */
export function expectValid(specName, definitionName, payload) {
  const { valid, errors } = validateAgainst(specName, definitionName, payload);
  if (!valid) {
    const lines = errors.map((e) => `${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`);
    throw new Error(`Payload does not match ${specName}#${definitionName}:\n${lines.join('\n')}`);
  }
}
