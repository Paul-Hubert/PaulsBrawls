// Survey for a build: the blocks around the pivot, then terrain maps at radius 16, 32 and 64 around it and radius 64
// at ±64 offsets (the server caps one map at radius 64). Prints each map's header line (biome, Y range, slope) and
// the map itself, or "(flat)" when it is blank.
//   node .claude/skills/mc-build/scripts/survey.mjs                  # around the pivot
//   node .claude/skills/mc-build/scripts/survey.mjs --at=-200,640 --radius=48   # one map at an absolute x,z
// Needs PAULSBRAWLS_MCP_TOKEN and PAULSBRAWLS_TICKET, like mcp-build.mjs.
const { open } = await import(new URL('../../../../mcp-build.mjs', import.meta.url));

const args = Object.fromEntries(process.argv.slice(2).map(a => /^--([^=]+)=(.*)$/.exec(a)?.slice(1) ?? [a, true]));
const b = await open().catch(e => { console.error(String(e.message || e)); process.exit(1); });
const { x: px, z: pz } = b.pivot;
console.log(`Pivot (absolute): x=${px} y=${b.pivot.y} z=${pz}`);

async function map(cx, cz, r) {
    const lines = (await b.terrain(cx, cz, r)).split('\n');
    const body = lines.slice(3);
    console.log(`=== radius ${r} at x=${cx} z=${cz} | ${lines[1] ?? ''}`);
    console.log(body.some(l => /\S/.test(l)) ? body.join('\n') : '(flat: one height everywhere)');
}

if (args.at) {
    const [x, z] = String(args.at).split(',').map(Number);
    await map(x, z, Number(args.radius ?? 64));
} else {
    console.log(await b.blockInfo());
    for (const r of [16, 32, 64]) await map(px, pz, r);
    for (const [dx, dz] of [[64, 0], [-64, 0], [0, 64], [0, -64]]) await map(px + dx, pz + dz, 64);
}
