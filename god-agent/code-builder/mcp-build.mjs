// Build by code: a tiny client for the mod's `builder` MCP server (docs/27), for an interactive Claude Code session
// holding a /construction ticket. A script computes block positions; this file sends them, 128 per call (the
// server's cap). Every rule (ticket, pivot, 4 sub-builds, 128 blocks a call) is still enforced by the server.
//
//   PAULSBRAWLS_MCP_TOKEN  the server's mcpToken (god_agent.properties)        required
//   PAULSBRAWLS_TICKET     the bld-… ticket from /construction ticket            required
//   PAULSBRAWLS_MCP_URL    default http://127.0.0.1:8771
//
//   import { open } from './mcp-build.mjs';
//   const b = await open();                       // checks the ticket, returns { pivot, ... }
//   const sb = await b.begin('tour', 0, 0, 0);    // a sub-build anchored at pivot + (0,0,0)
//   await sb.place('minecraft:stone', points);    // points: [[x,y,z], ...] offsets from the anchor
//   await sb.end();
//
// Run `node mcp-build.mjs` alone to check the connection and print the pivot.

const MAX_PER_CALL = 128;

export class McpError extends Error {}

export async function open({
    url = process.env.PAULSBRAWLS_MCP_URL || 'http://127.0.0.1:8771',
    token = process.env.PAULSBRAWLS_MCP_TOKEN,
    ticket = process.env.PAULSBRAWLS_TICKET,
} = {}) {
    if (!token) throw new McpError('PAULSBRAWLS_MCP_TOKEN is not set (the mcpToken in god_agent.properties)');
    if (!ticket) throw new McpError('PAULSBRAWLS_TICKET is not set (the bld-… ticket from /construction ticket)');
    let id = 0;

    async function call(name, args = {}) {
        const res = await fetch(`${url}/mcp/builder`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                params: { name, arguments: { ticket, ...args } } }),
        });
        const body = await res.text();
        if (!res.ok) throw new McpError(`${name}: HTTP ${res.status} ${body.slice(0, 200)}`);
        // Plain JSON, or one SSE event ("data: {...}").
        const json = JSON.parse(body.trimStart().startsWith('data:')
            ? body.split('\n').find(l => l.startsWith('data:')).slice(5) : body);
        if (json.error) throw new McpError(`${name}: ${json.error.message}`);
        const text = (json.result.content || []).map(c => c.text).join('\n');
        if (json.result.isError) throw new McpError(`${name}: ${text}`);
        return { text, data: json.result.structuredContent };
    }

    const pivot = (await call('get_build_origin')).data; // {x,y,z}, absolute

    return {
        pivot,
        call,
        /** The blocks around the pivot (offsets from it), as the server's text. */
        blockInfo: async () => (await call('get_block_info')).text,
        /** ASCII relief map around an absolute X/Z (default: the player), radius 8..64. */
        terrain: async (center_x, center_z, radius) =>
            (await call('query_terrain', { center_x, center_z, radius })).text,
        /** Opens a sub-build at pivot + (ax, ay, az). At most 4 open server-wide. */
        async begin(label, ax, ay, az) {
            const { data } = await call('begin_sub_build', { label, anchor_x: ax, anchor_y: ay, anchor_z: az });
            const sub = data.sub_build;
            let placed = 0;
            return {
                id: sub,
                anchor: { x: data.anchor_x, y: data.anchor_y, z: data.anchor_z },
                get placed() { return placed; },
                /** Places `block` at every [x,y,z] (offsets from the anchor); dedupes, then 128 per call. */
                async place(block, points) {
                    const seen = new Set(), xs = [], ys = [], zs = [];
                    for (const [x, y, z] of points) {
                        const k = `${x},${y},${z}`;
                        if (seen.has(k)) continue;
                        seen.add(k);
                        xs.push(Math.round(x)); ys.push(Math.round(y)); zs.push(Math.round(z));
                    }
                    for (let i = 0; i < xs.length; i += MAX_PER_CALL) {
                        await call('place_blocks', { sub_build: sub, block,
                            xs: xs.slice(i, i + MAX_PER_CALL), ys: ys.slice(i, i + MAX_PER_CALL),
                            zs: zs.slice(i, i + MAX_PER_CALL) });
                    }
                    placed += xs.length;
                    return xs.length;
                },
                /** Frees the slot. Call it in a finally. */
                end: () => call('end_sub_build', { sub_build: sub }),
            };
        },
    };
}

if (process.argv[1]?.endsWith('mcp-build.mjs')) {
    try {
        const b = await open();
        console.log(`OK, ticket valid. Pivot (absolute): x=${b.pivot.x} y=${b.pivot.y} z=${b.pivot.z}`);
    } catch (e) {
        console.error(String(e.message || e));
        process.exit(1);
    }
}
