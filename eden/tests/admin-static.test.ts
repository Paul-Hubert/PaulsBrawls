// The admin server's optional static web root (the same-origin dashboard host, owner #9). When `webRoot`
// is set, GETs that match no API route serve files from that dir — `/` → index.html — with correct
// content-types and a path-traversal guard; API routes and the JSON 404 still take priority.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdminServer } from '../src/admin/server';
import { MemoryJournal } from './fakes/memory-journal';

/** A throwaway web root with an index, a js asset, a file named like an API route, and a sibling secret. */
function tmpWeb(t: { after(fn: () => void): void }): string {
  const base = mkdtempSync(join(tmpdir(), 'eden-web-'));
  const root = join(base, 'root');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Eden</title>');
  writeFileSync(join(root, 'app.js'), 'window.x = 1;');
  writeFileSync(join(root, 'status'), 'I AM A FILE NAMED STATUS'); // must NOT shadow GET /status
  writeFileSync(join(base, 'secret.txt'), 'TOP SECRET'); // sibling of root — must be unreachable
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return root;
}

async function serve(t: any): Promise<number> {
  const admin = new AdminServer({ port: 0, journal: new MemoryJournal(), webRoot: tmpWeb(t) });
  const { port } = await admin.start();
  t.after(() => admin.stop());
  return port;
}

test('webRoot serves index.html at / with a text/html content-type', async (t) => {
  const port = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /Eden/);
});

test('webRoot serves a js asset with a text/javascript content-type', async (t) => {
  const port = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/javascript/);
  assert.match(await res.text(), /window\.x/);
});

test('an unknown static file 404s', async (t) => {
  const port = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/missing.js`);
  assert.equal(res.status, 404);
});

test('a path traversal outside the web root is blocked (no file content leaks)', async (t) => {
  const port = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/..%2fsecret.txt`);
  assert.ok(res.status === 403 || res.status === 404, `traversal blocked (got ${res.status})`);
  assert.doesNotMatch(await res.text(), /TOP SECRET/);
});

test('an API route still wins over a same-named static file', async (t) => {
  const port = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { uptimeMs?: number };
  assert.equal(typeof body.uptimeMs, 'number', 'the /status route answered, not the file');
});

test('without a webRoot, an unknown GET 404s as JSON (no static fallback)', async (t) => {
  const admin = new AdminServer({ port: 0, journal: new MemoryJournal() });
  const { port } = await admin.start();
  t.after(() => admin.stop());

  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: string };
  assert.match(String(body.error), /no route/);
});
