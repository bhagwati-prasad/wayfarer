// Tests for src/types.js: the module must import as a value-free ESM module, carry a @typedef for every
// interface / type alias of docs/api/00-types.md (the normative spec), and compile through the project's
// `tsc -p tsconfig.types.json` into a valid types/types.d.ts. No network, no DOM, no fake timers needed.
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// /tmp/wf-types on Linux; kept out of the repo so the committed types/ folder is never touched.
const outDir = resolve(tmpdir(), 'wf-types');
const dtsPath = resolve(outDir, 'types.d.ts');
const typesSource = readFileSync(resolve(root, 'src/types.js'), 'utf8');
// Always the repo's compiler, started through node (works where .bin shims are .cmd files): `npx tsc`
// from a directory without node_modules would fetch the unrelated npm package called "tsc".
const tsc = `node ${JSON.stringify(resolve(root, 'node_modules/typescript/bin/tsc'))}`;

/** Every `interface X` / `type X` declared in the normative doc, in   it('is a module whose only statement is the empty export (SSR-safe, no runtime code)', () => {
    expect(typesSource).not.toMatch(/\b(TODO|FIXME)\b/);
    const code = typesSource
      .replace(/\/\*[\s\S]*?\*\//g, '') // block / JSDoc comments
      .replace(/^\s*\/\/.*$/gm, '') // line comments
      .trim();
    expect(code).toBe('export {};');
  }); order. */
function documentedTypeNames() {
  const doc = readFileSync(resolve(root, 'docs/api/00-types.md'), 'utf8');
  return [...new Set([...doc.matchAll(/^(?:interface|type)\s+([A-Za-z]\w*)/gm)].map((m) => m[1]))];
}

/** Run a shell command, never throwing: `{ ok, output }` with stdout + stderr merged. */
function run(command, cwd) {
  try {
    return { ok: true, output: execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

describe('src/types.js', () => {
  it('imports as an ESM module with no runtime exports', async () => {
    const mod = await import('../src/types.js');
    expect(typeof mod).toBe('object');
    expect(Object.keys(mod)).toEqual([]);
  });

  it('declares a @typedef for every type in docs/api/00-types.md', () => {
    const names = documentedTypeNames();
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain('Offer');
    expect(names).toContain('ClientConfig');
    // Every typedef ends its type expression with `} <Name>` at the end of a line.
    const missing = names.filter((name) => !new RegExp(`\\} ${name}$`, 'm').test(typesSource));
    expect(missing).toEqual([]);
  });

  it('is a module whose only statement is the empty export (SSR-safe, no runtime code)', () => {
    expect(typesSource).not.toMatch(/\b(TODO|FIXME)\b/);
    const code = typesSource
      .replace(/\/\*[\s\S]*?\*\//g, '') // block / JSDoc comments
      .replace(/^\s*\/\/.*$/gm, '') // line comments
      .trim();
    expect(code).toBe('export {};');
  });

  it('keeps the split (per_slice) result mode as the documented default', () => {
    expect(typesSource).toMatch(/\[resultMode\] default `per_slice` \(split/);
  });
});

describe('npm run types (tsc -p tsconfig.types.json)', () => {
  /** @type {{ ok: boolean, output: string }} */
  let emit;

  beforeAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    emit = run(`npx tsc -p tsconfig.types.json --outDir ${JSON.stringify(outDir)}`, root);
  }, 120_000);

  it('succeeds without diagnostics', () => {
    expect(emit.ok, emit.output).toBe(true);
    expect(emit.output.trim()).toBe('');
  });

  it('emits types/types.d.ts with an exported type for every documented name', () => {
    expect(existsSync(dtsPath)).toBe(true);
    const dts = readFileSync(dtsPath, 'utf8');
    const missing = documentedTypeNames().filter(
      (name) => !new RegExp(`^export type ${name}\\b`, 'm').test(dts)
    );
    expect(missing).toEqual([]);
    // Shapes that are easy to get wrong in JSDoc: generics, intersections, index signatures.
    expect(dts).toMatch(/^export type Page<T> = \{/m);
    expect(dts).toMatch(/^export type SliceOffer = Offer & \{/m);
    expect(dts).toMatch(/^export type Trip = Booking & \{/m);
    expect(dts).toMatch(/\[ext: string\]: unknown;/);
    expect(dts).toMatch(/types: TravelDocument\['type'\]\[\];/);
    // Field comments from the doc survive declaration emit.
    expect(dts).toMatch(
      /\* untouched wire payload \(e\.g\. Amadeus FlightOffer\)\s*\*\/\s*raw\?: unknown;/
    );
  });

  it('produces a .d.ts that type-checks under --strict', () => {
    expect(existsSync(dtsPath)).toBe(true);
    const check = run(
      [
        tsc,
        '--noEmit --strict --skipDefaultLibCheck',
        '--module esnext --moduleResolution bundler --target es2022 --lib es2022,dom,dom.iterable',
        'types.d.ts',
      ].join(' '),
      outDir
    );
    // Sibling scripts (errors, core/client) are written by other agents and may not exist yet; a missing
    // module / member for one of those import() aliases is not a defect of types.js. Anything else is.
    const tolerated = new Set(['TS2307', 'TS2305', 'TS2339', 'TS2694']);
    const own = check.output
      .split('\n')
      .filter((line) => /^types\.d\.ts\(\d+,\d+\): error TS\d+/.test(line))
      .filter((line) => !tolerated.has(/error (TS\d+)/.exec(line)[1]));
    expect(own).toEqual([]);
  });
});
