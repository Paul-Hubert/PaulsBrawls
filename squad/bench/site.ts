// A gather site, saved and put back (docs/37 §14): `gather` cuts the forest it runs in, so a second run on the same
// site measures what the first left (docs/37 §12.1). To compare two settings on one forest, save the site before the
// first run and put it back before the second: a vanilla /clone of the box around the centre to a store far away, and
// back, then the dropped items killed. The DEV server only (SERVER_PROPERTIES, default ../dev/server.properties).
//
//   npm run bench:site -- save 6096,-6064        # before the first run (the box is generated if it was not)
//   npm run bench:site -- restore 6096,-6064     # before each later run
//
// Options: --radius 64 (blocks around the centre, x and z), --y 50,110 (the box's floor and top), --store 20000 (the
// store's offset in x). It raises the dev world's commandModificationBlockLimit (one /clone moves the whole box) and
// force-loads the box and its store only while it copies.

import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Rcon } from '../live-tests/rcon';
import { readProps } from './lib/server';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [action, at] = argv;
if ((action !== 'save' && action !== 'restore') || !at) {
  console.error('usage: bench:site save|restore x,z [--radius 64] [--y 50,110] [--store 20000]');
  process.exit(2);
}
const [cx, cz] = at.split(',').map(Number) as [number, number];
const R = Number(opt('radius') ?? 64);
const [y0, y1] = (opt('y') ?? '50,110').split(',').map(Number) as [number, number];
const STORE = Number(opt('store') ?? 20_000);

const PROPS_FILE = process.env.SERVER_PROPERTIES ? resolve(process.env.SERVER_PROPERTIES) : resolve(here, '..', '..', 'dev', 'server.properties');
const props = readProps(PROPS_FILE);
if (basename(dirname(PROPS_FILE)) === 'server' || Number(props['server-port']) === 25565) throw new Error(`refusing ${PROPS_FILE}: the dev server only`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const rcon = new Rcon('127.0.0.1', Number(props['rcon.port'] ?? 25576), props['rcon.password'] ?? '');
await rcon.connect();
const say = async (cmd: string): Promise<string> => {
  const r = await rcon.command(cmd);
  console.log(`${cmd} → ${r}`);
  return r;
};

const site = { x0: cx - R, z0: cz - R, x1: cx + R - 1, z1: cz + R - 1 };
const store = { x0: site.x0 + STORE, z0: site.z0, x1: site.x1 + STORE, z1: site.z1 };
const box = (b: typeof site): string => `${b.x0} ${y0} ${b.z0} ${b.x1} ${y1} ${b.z1}`;
const [from, to] = action === 'save' ? [site, store] : [store, site];

await say(`gamerule commandModificationBlockLimit ${(2 * R) * (2 * R) * (y1 - y0 + 1) + 1}`);
await say(`forceload add ${site.x0} ${site.z0} ${site.x1} ${site.z1}`);
await say(`forceload add ${store.x0} ${store.z0} ${store.x1} ${store.z1}`);
try {
  // Force-loaded chunks load (and generate) over the next ticks: the clone is refused until they have.
  const end = Date.now() + 120_000;
  for (;;) {
    const r = await say(`clone ${box(from)} ${to.x0} ${y0} ${to.z0} replace force`);
    if (/Successfully cloned/i.test(r)) break;
    if (!/not loaded/i.test(r) || Date.now() > end) throw new Error(`clone failed: ${r}`);
    await sleep(2_000);
  }
  if (action === 'restore') await say(`kill @e[type=item,x=${site.x0},y=${y0},z=${site.z0},dx=${2 * R},dy=${y1 - y0},dz=${2 * R}]`);
} finally {
  await say(`forceload remove ${site.x0} ${site.z0} ${site.x1} ${site.z1}`);
  await say(`forceload remove ${store.x0} ${store.z0} ${store.x1} ${store.z1}`);
  rcon.close();
}
