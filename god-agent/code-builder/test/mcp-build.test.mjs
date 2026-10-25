// mcp-build.mjs against a loopback stand-in for the builder server (no Minecraft): the request shape, the
// bearer token and ticket on every call, plain JSON and SSE answers, isError refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { open, McpError } from '../mcp-build.mjs';
import { build } from '../lib/build.mjs';
import { layer, spawns, placeSpawns } from '../lib/plan.mjs';
import { box } from '../lib/geom.mjs';

function fakeServer() {
    const calls = [];
    let n = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            const msg = JSON.parse(body);
            const reply = (result, sse = false) => {
                const json = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
                res.setHeader('Content-Type', sse ? 'text/event-stream' : 'application/json');
                res.end(sse ? `event: message\ndata: ${json}\n\n` : json);
            };
            if (msg.method === 'tools/list') return reply({ tools: ['get_build_origin', 'spawn_mobs'].map(name => ({ name })) });
            const { name, arguments: args } = msg.params;
            calls.push({ auth: req.headers.authorization, name, args });
            if (name === 'spawn_mobs') {
                if (args.xs.length > 16) return reply({ content: [{ type: 'text', text: 'Appel refusé' }], isError: true });
                return reply({ content: [{ type: 'text', text: `${args.xs.length} créature(s) ${args.entity} apparue(s).` }] });
            }
            if (name === 'get_build_origin') return reply({ content: [{ type: 'text', text: 'pivot' }], structuredContent: { x: 10, y: 64, z: -5 } });
            if (name === 'begin_sub_build') return reply({ content: [{ type: 'text', text: 'ok' }], structuredContent: { sub_build: `sb-${++n}`, anchor_x: 10 + args.anchor_x, anchor_y: 64 + args.anchor_y, anchor_z: -5 + args.anchor_z } }, true);
            if (name === 'place_blocks') {
                if (args.block === 'minecraft:nope') return reply({ content: [{ type: 'text', text: "Bloc inconnu ou mal formé : 'minecraft:nope'." }], isError: true });
                return reply({ content: [{ type: 'text', text: `${args.xs.length} bloc(s) ${args.block} placé(s).` }] });
            }
            if (name === 'end_sub_build') return reply({ content: [{ type: 'text', text: 'fini' }] });
            reply({ content: [{ type: 'text', text: 'outil inconnu' }], isError: true });
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('open + begin + place + end, then build() through the real client', async () => {
    const { server, calls, url } = await fakeServer();
    try {
        const b = await open({ url, token: 'tok', ticket: 'bld-x' });
        assert.deepEqual(b.pivot, { x: 10, y: 64, z: -5 });
        const sb = await b.begin('t', 1, 2, 3);
        assert.deepEqual(sb.anchor, { x: 11, y: 66, z: -2 });
        assert.equal(await sb.place('minecraft:stone', [...box([0, 0, 0], [9, 0, 19]), [0, 0, 0]]), 200, 'deduped');
        await assert.rejects(sb.place('minecraft:nope', [[0, 0, 0]]), e => e instanceof McpError && /Bloc inconnu/.test(e.message));
        await sb.end();
        assert.ok(calls.every(c => c.auth === 'Bearer tok' && c.args.ticket === 'bld-x'), 'token and ticket on every call');
        assert.deepEqual(calls.filter(c => c.name === 'place_blocks').map(c => c.args.xs.length), [128, 72, 1]);

        const r = await build(layer('minecraft:stone', box([0, 0, 0], [4, 4, 4])), { live: true, anchor: [0, 1, 0], client: b, log: () => {} });
        assert.equal(r.confirmed, 125);
        assert.deepEqual(r.anchorAbs, [10, 65, -5]);

        assert.deepEqual(await b.tools(), ['get_build_origin', 'spawn_mobs']);
        const sb2 = await b.begin('m', 0, 0, 0);
        assert.equal(await sb2.spawn('minecraft:villager', box([0, 1, 0], [5, 1, 2]), { nbt: '{NoAI:1b}' }), 18);
        const sp = calls.filter(c => c.name === 'spawn_mobs');
        assert.deepEqual(sp.map(c => c.args.xs.length), [16, 2], '16 per call');
        assert.ok(sp.every(c => c.args.nbt === '{NoAI:1b}' && !('persistent' in c.args)), 'nbt passed, persistence left to the server default');
        await sb2.end();
    } finally {
        server.close();
    }
});

test('build() spawns creatures last, 128 per sub-build, and asks before many', async () => {
    const { server, calls, url } = await fakeServer();
    try {
        const b = await open({ url, token: 'tok', ticket: 'bld-x' });
        const mobs = [...spawns('minecraft:villager', box([0, 1, 0], [9, 1, 12]), { persistent: false }),
            ...placeSpawns(spawns('minecraft:iron_golem', [[1, 1, 0]]), { at: [5, 0, 5], turns: 1 })];
        const plan = layer('minecraft:stone', box([0, 0, 0], [3, 0, 3]));
        await assert.rejects(build(plan, { live: true, client: b, spawns: mobs, log: () => {} }), /131 creatures is over 32/);
        const lines = [];
        const r = await build(plan, { live: true, yes: true, client: b, spawns: mobs, log: l => lines.push(l) });
        assert.equal(r.spawned, 131);
        const names = calls.map(c => c.name);
        assert.ok(names.lastIndexOf('place_blocks') < names.indexOf('spawn_mobs'), 'blocks first');
        assert.equal(calls.filter(c => c.name === 'begin_sub_build').length, 3, 'structure, then two creature sub-builds');
        const golem = calls.find(c => c.args?.entity === 'minecraft:iron_golem');
        assert.deepEqual([golem.args.xs[0], golem.args.ys[0], golem.args.zs[0]], [5, 1, 6], 'placeSpawns turned and moved it');
        assert.equal(calls.find(c => c.name === 'spawn_mobs').args.persistent, false);
        assert.match(lines.join('\n'), /creatures, spawned last: 131/);
    } finally {
        server.close();
    }
});

test('open() refuses to start without a token or a ticket', async () => {
    await assert.rejects(open({ token: '', ticket: 'x' }), /PAULSBRAWLS_MCP_TOKEN/);
    await assert.rejects(open({ token: 'x', ticket: '' }), /PAULSBRAWLS_TICKET/);
});
