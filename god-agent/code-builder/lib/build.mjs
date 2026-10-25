// build(plan, opts): resolves a plan and places it through the builder MCP server, or only describes it.
//
//   await build(plan, { label: 'castle', anchor: [0, 1, 0] });              // dry run (the default)
//   await build(plan, { label: 'castle', anchor: [0, 1, 0], live: true });  // places it
//
// Live: one sub-build per region (parallel, up to 4) for air + structure, then ONE sub-build for the
// attachments once all the structure stands (a torch needs its wall). Every sub-build is ended in `finally`.
// Over `confirmOver` blocks (5 000) a live build refuses unless `yes: true`. A begin refused because the 4
// server slots are busy (another /build) is retried every 15 s for up to `waitSlotsMs`.

import { resolve, stats } from './plan.mjs';

export const CONFIRM_OVER = 5000;
const MAX_PER_CALL = 128;
const SLOTS_BUSY = /tournent déjà/;

const fmtBox = b => (b ? `x ${b.min[0]}..${b.max[0]}, y ${b.min[1]}..${b.max[1]}, z ${b.min[2]}..${b.max[2]} (${b.size.join('×')})` : 'empty');

/** A printable summary: totals, the bounding box (relative to the anchor), counts per material. */
export function summary(plan, { label = 'build', anchor = [0, 0, 0] } = {}) {
    const s = stats(plan);
    const lines = [
        `${label}: ${s.total} positions (${s.solid} blocks + ${s.air} air), anchor offset ${anchor.join(',')} from the pivot`,
        `  bounding box (from the anchor): ${fmtBox(s.bbox)}`,
        ...Object.entries(s.byMaterial).sort((a, b) => b[1] - a[1]).map(([id, n]) => `  ${String(n).padStart(6)}  ${id}`),
    ];
    return { text: lines.join('\n'), stats: s };
}

/**
 * A top-down ASCII map of one horizontal slice (y, from the anchor) of a resolved plan: one character per block,
 * '.' empty, ' ' air (an opening); the legend lists the characters. For checking a plan without a server.
 */
export function sliceMap(plan, y) {
    const { layers } = resolve(plan);
    const cells = new Map(), legend = new Map();
    const CH = '#=+%@&*o:x~!?$ABCDEFGHIJKLMNOPQRSTUWXYZ';
    for (const l of layers) {
        const id = l.block.replace(/^minecraft:/, '');
        const name = id.replace(/\[.*$/, '');
        let ch = name === 'air' ? ' ' : /stairs$/.test(name) ? ({ north: '^', south: 'v', east: '>', west: '<' })[/facing=(\w+)/.exec(id)?.[1]] || 's' : null;
        if (!ch) { if (!legend.has(name)) legend.set(name, CH[legend.size % CH.length]); ch = legend.get(name); }
        for (const p of l.points) if (p[1] === y) cells.set(`${p[0]},${p[2]}`, ch);
    }
    const all = layers.flatMap(l => l.points);
    if (!all.length) return '(empty)';
    const xs = all.map(p => p[0]), zs = all.map(p => p[2]);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const rows = [`y=${y}  x ${x0}..${x1} (east ->), z ${z0}..${z1} (south down); stairs ^v<> = facing`];
    for (let z = z0; z <= z1; z++) {
        let r = '';
        for (let x = x0; x <= x1; x++) r += cells.get(`${x},${z}`) ?? '.';
        rows.push(r);
    }
    rows.push('  ' + [...legend].map(([n, c]) => `${c} ${n}`).join('  '));
    return rows.join('\n');
}

/** Splits structure layers into `n` regions along the longest horizontal axis, keeping each region's order. */
function regions(layers, n) {
    const pts = layers.flatMap(l => l.points);
    if (n <= 1 || pts.length < 2 * MAX_PER_CALL) return [layers];
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[2]);
    const axis = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs) ? 0 : 2;
    const sorted = pts.map(p => p[axis]).sort((a, b) => a - b);
    const cuts = Array.from({ length: n - 1 }, (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / n)]);
    const regionOf = v => cuts.filter(c => v >= c).length;
    return Array.from({ length: n }, (_, r) => layers
        .map(l => ({ ...l, points: l.points.filter(p => regionOf(p[axis]) === r) }))
        .filter(l => l.points.length));
}

async function beginWithRetry(client, label, anchor, { waitSlotsMs, retryMs, log }) {
    const deadline = Date.now() + waitSlotsMs;
    for (;;) {
        try {
            return await client.begin(label, anchor[0], anchor[1], anchor[2]);
        } catch (e) {
            if (!SLOTS_BUSY.test(String(e.message)) || Date.now() > deadline) throw e;
            log(`  ${label}: the 4 sub-build slots are busy (another build?), retrying in ${retryMs / 1000} s…`);
            await new Promise(r => setTimeout(r, retryMs));
        }
    }
}

/** Places layers in one sub-build, 128 per call; returns the server-confirmed count. */
async function placeLayers(sb, layers, log, tag) {
    let confirmed = 0;
    for (const l of layers) {
        for (let i = 0; i < l.points.length; i += MAX_PER_CALL) {
            const chunk = l.points.slice(i, i + MAX_PER_CALL);
            const text = await sb.placeRaw(l.block, chunk);
            const m = /^(\d+) bloc/.exec(text);
            confirmed += m ? Number(m[1]) : 0;
        }
        log(`  ${tag} ${l.points.length} × ${l.block}`);
    }
    return confirmed;
}

/**
 * Dry run unless live. Options: label, anchor [ax, ay, az] (offset from the pivot), live, yes, parallel (1..4),
 * client (an open() result; opened from the environment when missing), waitSlotsMs (default 10 min), retryMs, log.
 * Returns { summary, placed, confirmed } (placed/confirmed only when live).
 */
export async function build(plan, {
    label = 'build', anchor = [0, 0, 0], live = false, yes = false, parallel = 1, client = null,
    waitSlotsMs = 10 * 60_000, retryMs = 15_000, confirmOver = CONFIRM_OVER, log = console.log,
} = {}) {
    const sum = summary(plan, { label, anchor });
    log(sum.text);
    if (!live) { log('  (dry run: nothing placed; pass --build to place it)'); return { summary: sum }; }
    if (sum.stats.total > confirmOver && !yes) {
        throw new Error(`${label}: ${sum.stats.total} positions is over ${confirmOver}; ask first, then re-run with --yes`);
    }
    const n = Math.max(1, Math.min(4, parallel));
    const { layers } = resolve(plan);
    const structure = layers.filter(l => l.pass < 2), attachments = layers.filter(l => l.pass === 2);
    if (!client) client = await (await import('../mcp-build.mjs')).open();
    let confirmed = 0;
    // Phase 1: air and structure, one sub-build per region, in parallel.
    const parts = regions(structure, n);
    const results = await Promise.allSettled(parts.map(async (part, i) => {
        const tag = parts.length > 1 ? `${label}#${i + 1}` : label;
        const sb = await beginWithRetry(client, tag, anchor, { waitSlotsMs, retryMs, log });
        try {
            return await placeLayers(sb, part, log, tag);
        } finally {
            await sb.end().catch(e => log(`  ${tag}: end_sub_build failed: ${e.message}`));
        }
    }));
    for (const r of results) if (r.status === 'fulfilled') confirmed += r.value;
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    // Phase 2: attachments, now that what they hang on exists.
    if (attachments.length) {
        const tag = `${label}:details`;
        const sb = await beginWithRetry(client, tag, anchor, { waitSlotsMs, retryMs, log });
        try {
            confirmed += await placeLayers(sb, attachments, log, tag);
        } finally {
            await sb.end().catch(e => log(`  ${tag}: end_sub_build failed: ${e.message}`));
        }
    }
    const a = client.pivot ? [client.pivot.x + anchor[0], client.pivot.y + anchor[1], client.pivot.z + anchor[2]] : anchor;
    log(`${label}: placed ${sum.stats.total} positions, server confirmed ${confirmed}. Anchor (absolute): ${a.join(', ')}`);
    return { summary: sum, placed: sum.stats.total, confirmed, anchorAbs: a };
}

/**
 * Command-line options for a build script:
 *   --build             place it (default: dry run)     --yes          allow more than 5 000 blocks
 *   --anchor=x,y,z      offset from the pivot             --parallel=N   sub-builds for the structure (1..4)
 *   --palette=name      a preset                          --key=value    any other parameter (numbers parsed)
 */
export function cliOptions(argv = process.argv.slice(2)) {
    const opts = { live: false, yes: false, parallel: 1, anchor: null, params: {} };
    for (const a of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
        if (!m) throw new Error(`Unknown argument '${a}' (use --key=value)`);
        const [, k, v] = m;
        if (k === 'build') opts.live = true;
        else if (k === 'yes') opts.yes = true;
        else if (k === 'parallel') opts.parallel = Number(v);
        else if (k === 'anchor') opts.anchor = v.split(',').map(Number);
        else opts.params[k] = v === undefined ? true : v === 'true' ? true : v === 'false' ? false : (v !== '' && !isNaN(v) ? Number(v) : v);
    }
    if (opts.anchor && (opts.anchor.length !== 3 || opts.anchor.some(isNaN))) throw new Error('--anchor must be x,y,z');
    return opts;
}
