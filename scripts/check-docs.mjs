#!/usr/bin/env node
/* eslint-disable no-console -- a CLI report; the no-console rule targets library code */
/**
 * `npm run docs:check` (docs/CONTRIBUTING.md §7): the docs are the spec, so every function the
 * normative docs name must exist in the script the doc section points at. The script reads
 * docs/api/01-core.md, 02-state-events-errors.md and 03-utils.md, derives `(script, name)` pairs from
 * the `## N. \`path.js\`` / `### N.N \`path.js\`` section headings and the signatures beneath them
 * (`#### \`…\`` headings, the first column of signature tables and, in 03-utils.md, the inline
 * signature lists), and checks each name against the script with a plain regex scan: a single
 * identifier (`createHttp`) must be a named export, a dotted one (`http.abort`, `store.persist.flush`)
 * must be an export or a property / method of the object the factory returns. Missing names are
 * printed as a table and make the process exit 1. It also lists exports no doc entry mentions
 * (warning only; `--strict` turns that into a failure too). docs/api/04…10 (domain modules, UI) are
 * skipped until those scripts exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['01-core.md', '02-state-events-errors.md', '03-utils.md'];
const SKIPPED = [
  '04-reference-data.md',
  '05-search.md',
  '06-itinerary.md',
  '07-booking.md',
  '08-trips.md',
  '09-account.md',
  '10-ui.md',
];
const STRICT = process.argv.includes('--strict');

const IDENT = '[A-Za-z_$][\\w$]*';
/** A dotted identifier chain, optionally ending in `a/b/c` alternatives (`logger.debug/info/warn`). */
const CHAIN_RE = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)((?:/${IDENT})*)`);
const SECTION_RE = /^##\s+\d+\.\s+`([^`]+\.js)`/;
const SUBSECTION_RE = /^###\s+[\d.]+\s+`([^`]+\.js)`/;
const HEADING_RE = /^####\s+(.*)$/;
const SPAN_RE = /`([^`]+)`/g;

/** @typedef {{ doc: string, line: number, section: string, script: string, chain: string, name: string, kind: 'export'|'member' }} Entry */

/**
 * Parse the leading signature of one code span into `(chain, names)`; `null` when the span is not a
 * signature. `mode` decides how strict the shape must be: headings accept bare members
 * (`client.once`, `client.version: string`), table cells accept bare identifiers, prose needs `(`.
 * @param {string} span
 * @param {'heading'|'table'|'prose'} mode
 * @returns {{ chain: string, names: string[] }|null}
 */
function parseSignature(span, mode) {
  const text = span.replace(/\\\|/g, '|').trim();
  const m = CHAIN_RE.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const hasParen = rest.startsWith('(');
  const bare = rest === '';
  const typed = /^\s*(?::|→|=)/.test(rest);
  if (mode === 'prose' && !hasParen) return null;
  // A bare identifier in a signature cell is a paren‑less member (`formatDateTime`); a capitalised
  // one is a type (`→ \`Money\``) and not a name to check.
  if (mode === 'table' && !(hasParen || (bare && /^[a-z]/.test(text)))) return null;
  if (mode === 'heading' && !(hasParen || bare || typed)) return null;
  const segments = m[1].split('.');
  const last = segments.pop();
  const alternatives = [last, ...m[2].split('/').filter(Boolean)];
  const prefix = segments.length ? `${segments.join('.')}.` : '';
  return { chain: `${prefix}${last}${m[2]}`, names: alternatives.map((n) => `${prefix}${n}`) };
}

/**
 * Collect the `(script, name)` pairs of one doc.
 * @param {string} doc  file name under docs/api
 * @returns {{ entries: Entry[], scripts: Set<string>, text: Map<string, string[]> }}
 */
function parseDoc(doc) {
  const lines = readFileSync(resolve(ROOT, 'docs/api', doc), 'utf8').split('\n');
  const prose = doc === '03-utils.md';
  /** @type {Entry[]} */
  const entries = [];
  const scripts = new Set();
  /** Every doc line (code blocks included) under each script's sections, for the reverse check. */
  /** @type {Map<string, string[]>} */
  const text = new Map();
  let script = '';
  let section = '';
  let fenced = false;
  const note = (s, line) => {
    if (!text.has(s)) text.set(s, []);
    text.get(s).push(line);
  };

  const add = (chain, line) => {
    if (!script) return;
    chain.names.forEach((full) => {
      const parts = full.split('.');
      entries.push({
        doc,
        line,
        section,
        script,
        chain: full,
        name: parts[parts.length - 1],
        kind: parts.length === 1 ? 'export' : 'member',
      });
    });
  };
  const spansOf = (text) => [...text.matchAll(SPAN_RE)].map((m) => m[1]);

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (script) note(script, line);
    if (line.startsWith('```')) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    let m = SECTION_RE.exec(line) || SUBSECTION_RE.exec(line);
    if (m) {
      script = `src/${m[1]}`;
      scripts.add(script);
      section = line.replace(/^#+\s+/, '');
      return;
    }
    if (line.startsWith('#')) {
      m = HEADING_RE.exec(line);
      if (!m) return;
      let heading = m[1];
      // `#### \`core/endpoints.js\` — \`createEndpoints(...)\``: switches the script for this heading and
      // the paragraph under it, until the next `## N.` / `### N.N` section heading.
      const override = /^`([^`]+\.js)`\s+—\s+(.*)$/.exec(heading);
      if (override) {
        script = `src/${override[1]}`;
        scripts.add(script);
        heading = override[2];
        note(script, line);
      }
      for (const part of heading.split(' · ')) {
        const span = spansOf(part)[0];
        const sig = span ? parseSignature(span, 'heading') : null;
        if (sig) add(sig, i + 1);
      }
      return;
    }
    if (line.startsWith('|')) {
      const cells = line.split(/(?<!\\)\|/).slice(1);
      const first = (cells[0] || '').trim();
      if (!first || /^-+$/.test(first) || /^(signature|factory)$/i.test(first)) return;
      for (const span of spansOf(first)) {
        const sig = parseSignature(span, 'table');
        if (sig) add(sig, i + 1);
      }
      return;
    }
    if (prose && line.trim()) {
      for (const span of spansOf(line)) {
        const sig = parseSignature(span, 'prose');
        if (sig) add(sig, i + 1);
      }
    }
  });
  return { entries, scripts, text };
}

/** @type {Map<string, { source: string, exports: Set<string> }>} */
const sources = new Map();

/**
 * Source text and named exports of a script (cached).
 * @param {string} script
 */
function load(script) {
  if (sources.has(script)) return sources.get(script);
  const file = resolve(ROOT, script);
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const exports = new Set();
  for (const m of source.matchAll(
    new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+(${IDENT})`, 'gm')
  )) {
    exports.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const item of m[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      const name = (parts[1] || parts[0]).trim();
      if (name) exports.add(name);
    }
  }
  const info = { source, exports };
  sources.set(script, info);
  return info;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `name` appears as a property / method definition in `source`: `name,` / `name:` /
 * `name(` / `name =` in an object or class body, or `get name(` / `function name(`.
 * @param {string} source
 * @param {string} name
 */
function hasMember(source, name) {
  const n = escape(name);
  return (
    new RegExp(`(?:^|[^\\w$.])${n}\\s*(?::|\\(|,|\\}|=[^=>])`, 'm').test(source) ||
    new RegExp(`\\b(?:get|set|async|function)\\s+${n}\\s*\\(`).test(source)
  );
}

/** @param {Entry} e */
function check(e) {
  const { source, exports } = load(e.script);
  if (!source) return 'script missing';
  if (exports.has(e.name)) return null;
  if (e.kind === 'member' && hasMember(source, e.name)) return null;
  return e.kind === 'export' ? 'no such export' : 'no export or property';
}

/** @param {string[][]} rows */
function printTable(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const [i, row] of rows.entries()) {
    console.log(row.map((cell, c) => String(cell).padEnd(widths[c])).join('  '));
    if (i === 0) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  }
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

/** @type {Entry[]} */
const all = [];
const scripts = new Set();
/** @type {Map<string, string>} */
const sectionText = new Map();
for (const doc of DOCS) {
  const parsed = parseDoc(doc);
  all.push(...parsed.entries);
  parsed.scripts.forEach((s) => scripts.add(s));
  for (const [s, lines] of parsed.text) {
    sectionText.set(s, `${sectionText.get(s) || ''}\n${lines.join('\n')}`);
  }
}

const missing = [];
const seen = new Set();
for (const e of all) {
  const key = `${e.script}#${e.chain}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const why = check(e);
  if (why) missing.push({ ...e, why });
}

// Reverse direction (CONTRIBUTING §7: "an export has no doc entry"): an export counts as documented
// when a signature names it, when it heads a documented chain (`schemas.card` documents `schemas`)
// or when its sections mention it as a word (the error class tree is a code block, not headings).
const documented = new Map();
for (const e of all) {
  if (!documented.has(e.script)) documented.set(e.script, new Set());
  documented.get(e.script).add(e.name);
  documented.get(e.script).add(e.chain.split('.')[0]);
}
const undocumented = [];
for (const script of scripts) {
  const { exports } = load(script);
  const names = documented.get(script) || new Set();
  const mentions = sectionText.get(script) || '';
  for (const name of exports) {
    if (names.has(name)) continue;
    if (new RegExp(`(?:^|[^\\w$.])${escape(name)}(?![\\w$])`).test(mentions)) continue;
    undocumented.push({ script, name });
  }
}

console.log(
  `docs:check — ${seen.size} documented names across ${scripts.size} scripts (${DOCS.join(', ')})`
);
console.log(`skipped (domain modules / UI not built yet): ${SKIPPED.join(', ')}`);
if (missing.length) {
  console.log(`\n${missing.length} documented name(s) with no export / property:\n`);
  printTable([
    ['doc', 'line', 'script', 'documented as', 'expected', 'problem'],
    ...missing.map((m) => [m.doc, m.line, m.script, m.chain, m.kind, m.why]),
  ]);
} else {
  console.log('\nevery documented name has an export or a factory property.');
}
if (undocumented.length) {
  console.log(
    `\n${undocumented.length} export(s) with no doc entry (${STRICT ? 'failing: --strict' : 'warning; pass --strict to fail'}):\n`
  );
  printTable([['script', 'export'], ...undocumented.map((u) => [u.script, u.name])]);
}
process.exit(missing.length || (STRICT && undocumented.length) ? 1 : 0);
