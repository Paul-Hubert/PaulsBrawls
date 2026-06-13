#!/usr/bin/env node
// Renders the diagram-bearing Eden docs to standalone HTML pages viewable in any
// browser without GitHub (mermaid + marked come from the jsdelivr CDN at view time).
// Re-run after editing a doc:
//   node docs/render-docs.mjs                       # renders the default set below
//   node docs/render-docs.mjs 11-class-model.md …   # or specific files
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT = ['11-class-model.md', '12-architecture-views.md', '15-m0-as-built.md'];
const targets = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

for (const target of targets) {
  const name = basename(target, '.md');
  const md = readFileSync(join(here, name + '.md'), 'utf8');
  if (md.toLowerCase().includes('</scr' + 'ipt')) {
    throw new Error(name + '.md must not contain a closing script tag');
  }
  const m = md.match(/^#\s+(.+)$/m);
  const title = escapeHtml(m ? m[1] : name);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; margin: 0; background: #fff; }
  main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem 6rem; }
  h1, h2 { border-bottom: 1px solid #d1d9e0; padding-bottom: .3em; }
  .diagram { overflow-x: auto; border: 1px solid #d1d9e0; border-radius: 8px; padding: 12px; margin: 1rem 0; background: #fff; }
  table { border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #d1d9e0; padding: 6px 12px; text-align: left; vertical-align: top; }
  code { background: #f0f1f3; padding: .1em .3em; border-radius: 4px; font-size: 85%; }
  pre code { display: block; padding: 12px; overflow-x: auto; }
  .error { color: #b91c1c; white-space: pre-wrap; font-family: monospace; }
</style>
</head>
<body>
<main id="content"><p>Rendering… (this page needs internet access for the mermaid + marked CDN)</p></main>
<script type="text/plain" id="src">
${md}
</script>
<script type="module">
import { marked } from 'https://cdn.jsdelivr.net/npm/marked/+esm';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

const src = document.getElementById('src').textContent;
const content = document.getElementById('content');
content.innerHTML = marked.parse(src);

mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose', maxTextSize: 200000, maxEdges: 2000 });

let n = 0;
for (const code of [...content.querySelectorAll('code.language-mermaid')]) {
  const holder = document.createElement('div');
  holder.className = 'diagram';
  code.closest('pre').replaceWith(holder);
  try {
    const { svg } = await mermaid.render('diagram-' + (n++), code.textContent);
    holder.innerHTML = svg;
    const el = holder.querySelector('svg');
    if (el) el.style.maxWidth = '100%';
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = 'Mermaid error: ' + (err && err.message ? err.message : err) + '\\n\\n--- source ---\\n' + code.textContent;
    holder.replaceChildren(p);
  }
}
</script>
</body>
</html>`;

  writeFileSync(join(here, name + '.html'), html);
  console.log('wrote docs/' + name + '.html');
}
