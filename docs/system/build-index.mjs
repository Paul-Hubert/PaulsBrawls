#!/usr/bin/env node
// Builds docs/system/index.json — the machine-readable manifest an MCP server (or any agent)
// uses to list, search and fetch this corpus — and validates the corpus while doing it.
//
//   node docs/system/build-index.mjs           # validate + (re)write index.json
//   node docs/system/build-index.mjs --check   # validate only; exit 1 if index.json is stale or invalid
//
// Validation: required frontmatter keys, unique ids, every `sources:` path exists in the repo,
// every relative markdown link resolves. Dependency-free (Node >= 18).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const check = process.argv.includes('--check');
const REQUIRED = ['id', 'title', 'system', 'summary', 'tags', 'sources', 'verified_at'];
const SYSTEMS = new Set(['platform', 'gibber', 'ctf', 'aigod', 'eden', 'meta']);

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
});

function parseFrontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${file}: missing YAML frontmatter`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*?)\s*(#.*)?$/);
    if (!kv) continue;
    let v = kv[2];
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

const errors = [];
const docs = [];
const ids = new Map();

for (const file of walk(here).sort()) {
  const rel = relative(here, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  let parsed;
  try { parsed = parseFrontmatter(text, rel); } catch (e) { errors.push(e.message); continue; }
  const { meta, body } = parsed;
  for (const k of REQUIRED) if (meta[k] === undefined || meta[k] === '') errors.push(`${rel}: frontmatter key '${k}' missing`);
  if (meta.system && !SYSTEMS.has(meta.system)) errors.push(`${rel}: unknown system '${meta.system}'`);
  if (ids.has(meta.id)) errors.push(`${rel}: duplicate id '${meta.id}' (also ${ids.get(meta.id)})`);
  ids.set(meta.id, rel);
  for (const src of Array.isArray(meta.sources) ? meta.sources : []) {
    if (!existsSync(join(repo, src))) errors.push(`${rel}: source '${src}' does not exist`);
  }
  // relative links (skip http(s), mailto, pure anchors); strip #anchor and :line suffixes
  for (const [, target] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0].replace(/:\d+(-\d+)?$/, '');
    if (path && !existsSync(resolve(dirname(file), path))) errors.push(`${rel}: broken link '${target}'`);
  }
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((h) => h[1].trim());
  docs.push({
    id: meta.id, title: meta.title, system: meta.system, summary: meta.summary,
    tags: meta.tags, sources: meta.sources, verified_at: meta.verified_at,
    path: `docs/system/${rel}`, headings, bytes: Buffer.byteLength(text),
  });
}

const index = {
  name: 'paulsbrawls-system-docs',
  description: "Verified reference for the Paul's Brawls Fabric mod (Gibber money, Capture the Flag, AI God + building, Eden AI village). One entry per document; each document is one MCP resource.",
  generated_by: 'docs/system/build-index.mjs',
  uri_scheme: 'paulsbrawls-docs://<id>',
  count: docs.length,
  documents: docs,
};
const out = JSON.stringify(index, null, 2) + '\n';
const indexPath = join(here, 'index.json');

if (check && (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== out)) {
  errors.push('index.json is stale — run: node docs/system/build-index.mjs');
}
if (errors.length) {
  for (const e of errors) process.stderr.write(`✗ ${e}\n`);
  process.exit(1);
}
if (!check) writeFileSync(indexPath, out);
process.stdout.write(`✓ ${docs.length} documents ${check ? 'valid, index.json up to date' : 'indexed → docs/system/index.json'}\n`);
