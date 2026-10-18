// Tests for src/types.js: the module must import as a value-free ESM module, carry a @typedef for every
// interface / type alias of docs/api/00-types.md (the normative spec) with the same fields, optionality
// and types, and compile through the project's `tsc -p tsconfig.types.json` into a valid types/types.d.ts.
// No network, no DOM, no fake timers needed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const typesSource = readFileSync(resolve(root, 'src/types.js'), 'utf8');
const docSource = readFileSync(resolve(root, 'docs/api/00-types.md'), 'utf8');
// Always the repo's compiler, started through node (works where .bin shims are .cmd files): `npx tsc`
// from a directory without node_modules would fetch the unrelated npm package called "tsc".
const tsc = `node ${JSON.stringify(resolve(root, 'node_modules/typescript/bin/tsc'))}`;

// ── helpers: a small reader for the doc's TypeScript block and the file's JSDoc typedefs ──────────

/** The normative TypeScript block of docs/api/00-types.md, line comments removed. */
function docTypeScript() {
  const block = /```ts\n([\s\S]*?)```/.exec(docSource);
  expect(block, 'docs/api/00-types.md has a ```ts block').not.toBeNull();
  return block[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Every `interface X` / `type X` declared in the normative doc, in document order. */
function documentedTypeNames() {
  const names = [...docTypeScript().matchAll(/^(?:interface|type)\s+([A-Za-z]\w*)/gm)];
  return [...new Set(names.map((m) => m[1]))];
}

/** Index of the `}` closing the `{` at `open`, honouring nesting; -1 when unbalanced. */
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Split `text` on `sep` at nesting depth 0 (`=>` arrows are not closers), trimmed, empties dropped. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let current = '';
  let previous = '';
  for (const ch of text) {
    if ('{[(<'.includes(ch)) depth++;
    else if ('}])'.includes(ch) || (ch === '>' && previous !== '=')) depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
    previous = ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Canonical spelling of a type expression: no whitespace, `,` member separators, no trailing one. */
function normalizeType(type) {
  return type
    .replace(/\s+/g, '')
    .replace(/;/g, ',')
    .replace(/,(?=[}\]>)])/g, '')
    .replace(/,$/, '');
}

/**
 * Parse an object body (`a: T; b?: U; m(x: X): R; [k: string]: V; bare`) into
 * `{ name, optional, type }` records; `type` is `null` for a bare member name (PaymentsPort).
 */
function parseMembers(body, separator) {
  return splitTop(body, separator).map((member) => {
    let m;
    if ((m = /^\[(\w+):\s*(\w+)\]:\s*([\s\S]+)$/.exec(member))) {
      return { name: `[${m[1]}: ${m[2]}]`, optional: false, type: normalizeType(m[3]) };
    }
    if ((m = /^(\w+)(\?)?\(([\s\S]*?)\):\s*([\s\S]+)$/.exec(member))) {
      return { name: m[1], optional: !!m[2], type: normalizeType(`(${m[3]}) => ${m[4]}`) };
    }
    if ((m = /^(\w+)(\?)?:\s*([\s\S]+)$/.exec(member))) {
      return { name: m[1], optional: !!m[2], type: normalizeType(m[3]) };
    }
    if ((m = /^(\w+)$/.exec(member))) return { name: m[1], optional: false, type: null };
    throw new Error(`unreadable member in docs/api/00-types.md: ${member}`);
  });
}

/**
 * The doc's declarations: name → `{ members, extends }` for object shapes (interfaces and `type X =
 * {…}` aliases) or `{ alias }` for every other alias, normalised like `normalizeType`.
 */
function documentedTypes() {
  const ts = docTypeScript();
  const heads = [
    ...ts.matchAll(
      /^(interface)\s+(\w+)(?:<\w+>)?(?:\s+extends\s+(\w+))?\s*\{|^(type)\s+(\w+)\s*=/gm
    ),
  ];
  const types = new Map();
  heads.forEach((head, i) => {
    const next = heads[i + 1]?.index ?? ts.length;
    if (head[1]) {
      const open = head.index + head[0].length - 1;
      const close = closingBrace(ts, open);
      expect(close, `interface ${head[2]} is balanced`).toBeGreaterThan(open);
      types.set(head[2], {
        extends: head[3] || null,
        members: parseMembers(ts.slice(open + 1, close), ';'),
      });
    } else {
      const body = ts.slice(head.index + head[0].length, next).trim();
      if (/^\{[\s\S]*\}$/.test(body)) {
        types.set(head[5], { extends: null, members: parseMembers(body.slice(1, -1), ';') });
      } else {
        types.set(head[5], { alias: normalizeType(body) });
      }
    }
  });
  return types;
}

/**
 * Every `@typedef {T} Name` of src/types.js in file order: name → `{ type, members }` where `type` is
 * the normalised type expression and `members` the `@property` records (empty for non-object typedefs).
 */
function declaredTypedefs() {
  const typedefs = [];
  for (const block of typesSource.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const text = block[1].replace(/^\s*\* ?/gm, '');
    const tag = text.indexOf('@typedef');
    if (tag === -1) continue;
    const open = text.indexOf('{', tag);
    const close = closingBrace(text, open);
    expect(close, `@typedef braces are balanced in:\n${text}`).toBeGreaterThan(open);
    const name = /^\s*([A-Za-z]\w*)\s*$/m.exec(text.slice(close + 1));
    expect(name, `@typedef has a name in:\n${text}`).not.toBeNull();
    const members = [];
    for (const prop of text.matchAll(/@property\s*\{/g)) {
      const pOpen = prop.index + prop[0].length - 1;
      const pClose = closingBrace(text, pOpen);
      const rest = /^\s*(?:\[(\w+)\]|(\w+))/.exec(text.slice(pClose + 1));
      expect(rest, `@property has a name in:\n${text}`).not.toBeNull();
      members.push({
        name: rest[1] || rest[2],
        optional: !!rest[1],
        type: normalizeType(text.slice(pOpen + 1, pClose)),
      });
    }
    typedefs.push({ name: name[1], type: normalizeType(text.slice(open + 1, close)), members });
  }
  return typedefs;
}

/** Run a shell command, never throwing: `{ ok, output }` with stdout + stderr merged. */
function run(command, cwd) {
  try {
    return { ok: true, output: execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

// ── source-level contract ────────────────────────────────────────────────────────────────────────

describe('src/types.js', () => {
  it('imports as an ESM module with no runtime exports', async () => {
    const mod = await import('../src/types.js');
    expect(typeof mod).toBe('object');
    expect(Object.keys(mod)).toEqual([]);
  });

  it('is a module whose only statement is the empty export (SSR-safe, no runtime code)', () => {
    expect(typesSource).not.toMatch(/\b(TODO|FIXME)\b/);
    expect(typesSource).not.toMatch(/\bconsole\./);
    const code = typesSource
      .replace(/\/\*[\s\S]*?\*\//g, '') // block / JSDoc comments
      .replace(/^\s*\/\/.*$/gm, '') // line comments
      .trim();
    expect(code).toBe('export {};');
  });

  it('declares exactly one @typedef for every type in docs/api/00-types.md', () => {
    const names = documentedTypeNames();
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain('Offer');
    expect(names).toContain('ClientConfig');
    const declared = declaredTypedefs().map((t) => t.name);
    const duplicates = declared.filter((name, i) => declared.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
    expect(names.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it('declares the documented types in document order and the helper shapes after them', () => {
    const names = documentedTypeNames();
    const declared = declaredTypedefs().map((t) => t.name);
    expect(declared.filter((name) => names.includes(name))).toEqual(names);
    // Helper shapes referenced by the doc (01-core §3, 02 §3-4, 03 §10, 07 §2) live in the final section.
    const helpers = declared.filter((name) => !names.includes(name));
    expect(helpers).toEqual([
      'PaymentCreditsInput',
      'PaymentQuoteParams',
      'CreateIntentParams',
      'ConfirmParams',
      'PaymentUiOptions',
      'PaymentResult',
      'SdkError',
      'OtaClient',
      'RequestSpec',
      'HttpResponse',
      'HttpContext',
      'RequestInterceptor',
      'ResponseInterceptor',
      'ErrorInterceptor',
      'Interceptor',
      'HookFn',
      'StorageAdapter',
      'TelemetryAdapter',
    ]);
  });

  it('mirrors every documented field: same names, optionality, types and order', () => {
    const doc = documentedTypes();
    const typedefs = new Map(declaredTypedefs().map((t) => [t.name, t]));
    expect(doc.size).toBe(documentedTypeNames().length);
    const problems = [];
    for (const [name, spec] of doc) {
      const typedef = typedefs.get(name);
      if (!typedef) {
        problems.push(`${name}: no @typedef`);
        continue;
      }
      if (spec.alias !== undefined) {
        if (typedef.type !== spec.alias) {
          problems.push(`${name}: doc ${spec.alias}, typedef ${typedef.type}`);
        }
        continue;
      }
      let members;
      if (spec.extends) {
        const extended = new RegExp(`^${spec.extends}&\\{([\\s\\S]*)\\}$`).exec(typedef.type);
        if (!extended) {
          problems.push(`${name}: doc extends ${spec.extends}, typedef ${typedef.type}`);
          continue;
        }
        members = parseMembers(extended[1], ',');
      } else if (typedef.type === 'Object') {
        members = typedef.members;
      } else if (typedef.type.startsWith('{')) {
        members = parseMembers(typedef.type.slice(1, -1), ',');
      } else {
        problems.push(`${name}: doc is an object shape, typedef ${typedef.type}`);
        continue;
      }
      // Bare member lists (PaymentsPort) name the members the doc insists on; the typedef may add the
      // ones its referenced section (07-booking.md §2) specifies.
      const bare = spec.members.every((m) => m.type === null);
      for (const member of spec.members) {
        const actual = members.find((m) => m.name === member.name);
        if (!actual) {
          problems.push(`${name}.${member.name}: missing`);
          continue;
        }
        if (member.type === null) continue;
        if (actual.optional !== member.optional) {
          problems.push(
            `${name}.${member.name}: doc ${member.optional ? 'optional' : 'required'}, typedef ${actual.optional ? 'optional' : 'required'}`
          );
        }
        if (actual.type !== member.type) {
          problems.push(`${name}.${member.name}: doc ${member.type}, typedef ${actual.type}`);
        }
      }
      const documented = spec.members.map((m) => m.name);
      if (!bare) {
        for (const member of members) {
          if (!documented.includes(member.name))
            problems.push(`${name}.${member.name}: not in doc`);
        }
      }
      const order = members.map((m) => m.name).filter((n) => documented.includes(n));
      if (order.join() !== documented.join()) {
        problems.push(`${name}: doc order [${documented}], typedef order [${order}]`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the split (per_slice) result mode as the documented default', () => {
    expect(typesSource).toMatch(/\[resultMode\] default `per_slice` \(split/);
  });

  it('carries the 07-booking.md §2 payments members the 00-types list leaves implicit', () => {
    const port = declaredTypedefs().find((t) => t.name === 'PaymentsPort');
    const member = (name) => port.members.find((m) => m.name === name);
    expect(member('quoteState')).toEqual({
      name: 'quoteState',
      optional: false,
      type: '()=>PaymentQuote|null',
    });
    expect(member('validateCard')?.optional).toBe(true);
    expect(member('cardBrand')?.optional).toBe(true);
    const confirm = declaredTypedefs().find((t) => t.name === 'ConfirmParams');
    expect(confirm.members.find((m) => m.name === 'gatewayPayload')).toEqual({
      name: 'gatewayPayload',
      optional: true,
      type: 'object',
    });
  });
});

// ── declaration emit ─────────────────────────────────────────────────────────────────────────────

describe('npm run types (tsc -p tsconfig.types.json)', () => {
  /** Per-run output directory, so parallel runs never share or clobber each other's emit. */
  let outDir;
  let dtsPath;
  /** @type {{ ok: boolean, output: string }} */
  let emit;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'wf-types-'));
    dtsPath = resolve(outDir, 'types.d.ts');
    emit = run(`${tsc} -p tsconfig.types.json --outDir ${JSON.stringify(outDir)}`, root);
  }, 120_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

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
    // Shapes that are easy to get wrong in JSDoc: generics, intersections, index signatures, aliases.
    expect(dts).toMatch(/^export type Page<T> = \{/m);
    expect(dts).toMatch(/^export type HttpResponse<T> = \{/m);
    expect(dts).toMatch(/^export type SliceOffer = Offer & \{/m);
    expect(dts).toMatch(/^export type Trip = Booking & \{/m);
    expect(dts).toMatch(/^export type Money = \{/m);
    expect(dts).toMatch(/^export type DateStr = string;/m);
    expect(dts).toMatch(/\[ext: string\]: unknown;/);
    expect(dts).toMatch(/types: TravelDocument\['type'\]\[\];/);
    expect(dts).toMatch(/quoteState: \(\) => PaymentQuote \| null;/);
    expect(dts).toMatch(/gatewayPayload\?: object;/);
    // The two aliases into sibling scripts point at members those scripts export.
    expect(dts).toMatch(
      /^export type SdkError = import\(['"]\.\/errors\/index\.js['"]\)\.SdkError;/m
    );
    expect(dts).toMatch(
      /^export type OtaClient = ReturnType<typeof import\(['"]\.\/core\/client\.js['"]\)\.createClient>;/m
    );
    expect(readFileSync(resolve(outDir, 'errors/index.d.ts'), 'utf8')).toMatch(
      /^export (declare )?class SdkError\b/m
    );
    expect(readFileSync(resolve(outDir, 'core/client.d.ts'), 'utf8')).toMatch(
      /^export (declare )?function createClient\b/m
    );
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
    // Only diagnostics reported against types.d.ts itself count: sibling declarations are checked by
    // their own tests. Nothing is tolerated here — a misspelt `import('./errors/index.js').X` alias
    // or an unknown name inside a typedef is exactly the defect this test exists to catch.
    const own = check.output
      .split('\n')
      .filter((line) => /^types\.d\.ts\(\d+,\d+\): error TS\d+/.test(line));
    expect(own).toEqual([]);
  });
});
