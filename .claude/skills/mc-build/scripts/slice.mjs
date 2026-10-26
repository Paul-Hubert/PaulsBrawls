// Top views of one window of a build script's plan: sliceMap of the plan cropped to x0..x1 × z0..z1, at each y asked.
// The full slice of a plan wider than ~100 blocks is unreadable; read a big build area by area with this instead.
//   node ../../.claude/skills/mc-build/scripts/slice.mjs build-babylon.mjs --win=60,-27,120,20 --y=1
//   node ../../.claude/skills/mc-build/scripts/slice.mjs build-babylon.mjs --win=7,64,116,120 --y=9,17
// Coordinates are the plan's (relative to the anchor). The script must `export const plan`, as the template does; it
// is imported as a dry run (no flags, its output muted), so it needs no ticket and places nothing.
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const [script, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map(a => /^--([^=]+)=(.*)$/.exec(a)?.slice(1) ?? [a, true]));
if (!script || !args.win || !args.y) {
    console.error('usage: slice.mjs <build-script.mjs> --win=x0,z0,x1,z1 --y=1[,9,…]');
    process.exit(1);
}
const { sliceMap } = await import(new URL('../../../../god-agent/code-builder/lib/index.mjs', import.meta.url));

process.argv = process.argv.slice(0, 2);  // the build script's cliOptions() must see no flags: a dry run
const log = console.log;
console.log = () => {};
let plan;
try {
    ({ plan } = await import(pathToFileURL(resolvePath(script)).href));
} catch (e) {
    console.log = log;
    console.error(`${script} failed while composing its plan: ${e.message}`);
    process.exit(1);
} finally {
    console.log = log;
}
if (!Array.isArray(plan)) { console.error(`${script} does not export a plan (export const plan = [])`); process.exit(1); }

const [x0, z0, x1, z1] = String(args.win).split(',').map(Number);
for (const y of String(args.y).split(',').map(Number)) {
    const crop = plan.map(l => ({ block: l.block, points: l.points.filter(([x, yy, z]) => yy === y && x >= x0 && x <= x1 && z >= z0 && z <= z1) }));
    crop.push({ block: 'minecraft:barrier', points: [[x0, y, z0], [x1, y, z1]] }); // pins the window's corners (shown as a barrier letter)
    console.log(sliceMap(crop, y));
}
