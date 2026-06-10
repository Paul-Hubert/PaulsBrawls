// Programmatic replacement for §3–§5 of MCP_TOOLS_VERIFICATION.md.
// Spawns the MCP server over stdio, performs the MCP handshake, calls
// tools/list, and validates names + schemas against the canonical table.
//
// §6 (live tool call) is also attempted at the end — it will fail gracefully
// if no Minecraft server is reachable, which the verification doc anticipates.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, 'minecraft-mcp-server');

// --- Canonical expectations (mirrors §0 of the verification doc) -----------

// NOTE: 'dig-block' is TEMP DISABLED in src/tools/block-tools.ts (registration
// commented out). When restoring it, re-add 'dig-block' to this list (sorted)
// and bump the count from 25 back to 26 in the §3 checks below.
// NOTE: 'move-in-direction' was permanently removed — it predated pathfinder
// and was strictly worse for any real movement task.
const CANONICAL_TOOLS = [
  'attack-entity', 'can-craft', 'collect-block', 'craft-item', 'detect-gamemode',
  'equip-item', 'find-blocks', 'find-entity', 'find-item', 'fly-to',
  'follow-entity', 'get-block-info', 'get-position', 'get-recipe', 'jump',
  'list-inventory', 'list-recipes', 'look-at', 'move-to-position',
  'place-block', 'read-chat', 'send-chat', 'smelt-item', 'stop-combat',
  'stop-follow'
];

// §5 spot check — one tool from each of the 9 modules.
// Required / optional sourced from reading the Zod schemas at HEAD.
// NOTE: the verification doc's example for `place-block` mentions a `blockName`
// param that does NOT exist in the source — see the report. Truth is in the
// code, so the expected schemas here are derived from the .ts files.
const SPOT_CHECK = {
  'get-position':    { required: [],                                                optional: [] },
  'fly-to':          { required: ['x','y','z'],                                     optional: [] },
  'detect-gamemode': { required: [],                                                optional: [] },
  'find-entity':     { required: [],                                                optional: ['type','maxDistance'] },
  'list-inventory':  { required: [],                                                optional: [] },
  'send-chat':       { required: ['message'],                                       optional: [] },
  'place-block':     { required: ['x','y','z'],                                     optional: ['faceDirection'] },
  'smelt-item':      { required: ['x','y','z','inputItem','fuelItem'],              optional: ['inputCount','fuelCount','takeOutput','timeoutMs'] },
  'can-craft':       { required: ['itemName'],                                      optional: [] }
};

// --- Spawn the MCP server (from source via tsx, so no build needed) --------

// Invoke tsx's ESM CLI directly via node. This avoids two things:
//   1. Windows EINVAL when spawning .cmd shims under Node 24's CVE-2024-27980 mitigation.
//   2. The DEP0190 warning that fires when spawn(.., args, { shell: true }) concatenates args.
const tsxCli = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(
  process.execPath, // current node binary
  [tsxCli, 'src/main.ts', '--host', '127.0.0.1', '--port', '25565', '--username', 'VerifyBot'],
  { cwd: SERVER_DIR, stdio: ['pipe', 'pipe', 'pipe'] }
);

// Mineflayer logs go through src/stdio-filter.ts which silences console.error
// and only allows JSON-RPC + ISO-timestamped log lines on stdout. Anything
// non-JSON we still want to capture as diagnostic.
let stderrBuf = '';
child.stderr.on('data', d => { stderrBuf += d.toString(); });

// --- Tiny JSON-RPC client over stdio ---------------------------------------

let nextId = 1;
const pending = new Map(); // id -> resolver
let rxBuf = '';

child.stdout.on('data', chunk => {
  rxBuf += chunk.toString();
  let nl;
  while ((nl = rxBuf.indexOf('\n')) >= 0) {
    const line = rxBuf.slice(0, nl).trim();
    rxBuf = rxBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; } // skip log lines
    if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
      }
    }, 30000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// --- Main flow -------------------------------------------------------------

const report = { steps: [], failures: [] };
function record(step, status, evidence) {
  report.steps.push({ step, status, evidence });
}

async function main() {
  // Initialize
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-mcp-tools', version: '1.0' }
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  record('§3a initialize', 'PASS', `server=${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  notify('notifications/initialized');

  // tools/list
  const listed = await send('tools/list', {});
  if (listed.error) throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
  const tools = listed.result.tools;
  const names = tools.map(t => t.name).sort();

  // §3 — count (25 = 27 baseline minus dig-block temp-disabled minus
  // move-in-direction permanently removed; +2 from follow-tools)
  if (tools.length === 25) {
    record('§3 tool count', 'PASS', `25 tools reported`);
  } else {
    record('§3 tool count', 'FAIL', `expected 25, got ${tools.length}`);
    report.failures.push(`Tool count ${tools.length} ≠ 25`);
  }

  // §4 — exact name set
  const missing = CANONICAL_TOOLS.filter(n => !names.includes(n));
  const extra = names.filter(n => !CANONICAL_TOOLS.includes(n));
  if (missing.length === 0 && extra.length === 0) {
    record('§4 name set', 'PASS', `All 25 canonical names present, no extras`);
  } else {
    record('§4 name set', 'FAIL', `missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
    if (missing.length) report.failures.push(`Missing tools: ${missing.join(', ')}`);
    if (extra.length) report.failures.push(`Unexpected tools: ${extra.join(', ')}`);
  }

  // §5 — schema spot check
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  const schemaFailures = [];
  for (const [name, expected] of Object.entries(SPOT_CHECK)) {
    const t = byName[name];
    if (!t) { schemaFailures.push(`${name}: not present`); continue; }
    if (!t.description || !t.description.trim()) {
      schemaFailures.push(`${name}: empty description`);
    }
    const schema = t.inputSchema || {};
    const props = Object.keys(schema.properties || {}).sort();
    const required = (schema.required || []).slice().sort();
    const expReq = expected.required.slice().sort();
    const expAll = [...expected.required, ...expected.optional].sort();

    const reqMatch = JSON.stringify(required) === JSON.stringify(expReq);
    const propsMatch = JSON.stringify(props) === JSON.stringify(expAll);

    if (!reqMatch || !propsMatch) {
      schemaFailures.push(`${name}: required=[${required.join(',')}] (want [${expReq.join(',')}]), props=[${props.join(',')}] (want [${expAll.join(',')}])`);
    }
  }
  if (schemaFailures.length === 0) {
    record('§5 schema spot check', 'PASS', `9/9 tools have correct descriptions, required, and property sets`);
  } else {
    record('§5 schema spot check', 'FAIL', schemaFailures.join(' | '));
    report.failures.push(...schemaFailures.map(s => `Schema: ${s}`));
  }

  // §6 — live call (best effort)
  try {
    const call = await Promise.race([
      send('tools/call', { name: 'get-position', arguments: {} }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout-7s')), 7000))
    ]);
    const text = call.result?.content?.[0]?.text || JSON.stringify(call);
    const isError = !!call.result?.isError;
    if (!isError && /-?\d+/.test(text)) {
      record('§6 live get-position', 'PASS', text);
    } else {
      record('§6 live get-position', 'SKIP (no MC server)', text.slice(0, 120));
    }
  } catch (e) {
    record('§6 live get-position', 'SKIP (no MC server)', e.message);
  }

  // Dump everything
  console.log('\n=== REPORT ===');
  console.log(JSON.stringify({ tools_listed: names, results: report }, null, 2));

  child.kill();
  process.exit(report.failures.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\n!!! FATAL !!!');
  console.error(err);
  console.error('--- stderr captured ---');
  console.error(stderrBuf || '(empty)');
  child.kill();
  process.exit(2);
});
