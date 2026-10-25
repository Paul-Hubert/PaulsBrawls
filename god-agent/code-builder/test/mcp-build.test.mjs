// mcp-build.mjs against a loopback stand-in for the builder server (no Minecraft): the request shape, the
// bearer token and ticket on every call, plain JSON and SSE answers, isError refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { open, McpError } from '../mcp-build.mjs';
import { build } from '../lib/build.mjs';
import { layer } from '../lib/plan.mjs';
import { box } from '../lib/geom.mjs';

function fakeServer() {
    const calls = [];
    let n = 0;
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            const msg = JSON.parse(body);
            const { name, arguments: args } = msg.params;
            calls.push({ auth: req.headers.authorization, name, args });
            const reply = (result, sse = false) => {
                const json = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
                res.setHeader('Content-Type', sse ? 'text/event-stream' : 'application/json');
                res.end(sse ? `event: message\ndata: ${json}\n\n` : json);
            };
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
    } finally {
        server.close();
    }
    await assert.rejects(open({ token: '', ticket: 'x' }), /PAULSBRAWLS_MCP_TOKEN/);
    await assert.rejects(open({ token: 'x', ticket: '' }), /PAULSBRAWLS_TICKET/);
});
