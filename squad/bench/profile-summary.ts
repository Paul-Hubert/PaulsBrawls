// Summarise V8 CPU profiles (.cpuprofile, from bench/load.ts --profile or `node --cpu-prof`): self time by package,
// by bucket (protocol, world, physics, pathfinder, plugins, squad, GC…) and the top functions.
//
//   cd squad && npm run bench:profiles -- bench/.runs/<run>/profiles/*.cpuprofile   (or a directory)

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

/**
 * By cause (inclusive): a sample goes to the first cause found on its stack, in this order. The pathfinder comes
 * first, so the block lookups A* makes count as pathfinding; packet handling covers decoding and what mineflayer
 * does with each packet (chunk loading, entity updates).
 */
const CAUSES: Array<[string, (pkg: string, n: ProfileNode) => boolean]> = [
  ['pathfinder: A* search', (pkg, n) => pkg === 'mineflayer-pathfinder' && /astar\.js|movements\.js/.test(n.callFrame.url)],
  ['pathfinder: look-ahead and path execution', (pkg) => pkg === 'mineflayer-pathfinder'],
  ['plugins (pvp, collectblock, tool, auto-eat, armor, hawkEye)', (pkg) => /^(mineflayer-pvp|mineflayer-collectblock|mineflayer-tool|mineflayer-auto-eat|mineflayer-armor-manager|minecrafthawkeye)$/.test(pkg)],
  // Before Squad: Squad's protocol hardening (bots/protocol.ts) wraps protodef's parser, so every packet handler runs
  // under one of its frames.
  ['packet handling (decode, inflate, mineflayer handlers)', (pkg, n) => /^(minecraft-protocol|protodef)$/.test(pkg) || /[\\/]bots[\\/]protocol\.ts$/.test(n.callFrame.url)],
  ['Squad (runtime, helpers, commands)', (pkg) => pkg.startsWith('squad ')],
  ['own physics (one simulation per bot per tick)', (pkg, n) => pkg === 'prismarine-physics' || (pkg === 'mineflayer' && /physics\.js/.test(n.callFrame.url))],
  ['bench instrumentation', (pkg) => pkg === 'bench'],
];

const BUCKETS: Array<[string, RegExp]> = [
  ['idle', /^\(idle\)$/],
  ['GC', /^\(garbage collector\)$/],
  ['protocol (decode, inflate, streams, socket)', /^(minecraft-protocol|protodef.*|node:zlib|node:streams|node:net|node:buffer|node:stream|readable-stream)$/],
  ['physics (prismarine-physics)', /^prismarine-physics$/],
  ['pathfinder', /^mineflayer-pathfinder$/],
  ['plugins (pvp, collectblock, tool, auto-eat, armor, hawkEye)', /^(mineflayer-pvp|mineflayer-collectblock|mineflayer-tool|mineflayer-auto-eat|mineflayer-armor-manager|minecrafthawkeye)$/],
  ['world & entities (mineflayer, prismarine-*)', /^(mineflayer|prismarine-.*|minecraft-data|vec3|node:events)$/],
  ['squad (runtime + commands)', /^squad /],
  ['bench instrumentation', /^bench$/],
];

function pkgOf(n: ProfileNode): string {
  const { url, functionName } = n.callFrame;
  if (!url) return /^\(.*\)$/.test(functionName) ? functionName : '(native)';
  const u = url.replace(/\\/g, '/');
  if (u.startsWith('squad:')) return 'squad (commands)';
  const nm = u.lastIndexOf('/node_modules/');
  if (nm >= 0) {
    const rest = u.slice(nm + '/node_modules/'.length).split('/');
    return rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : (rest[0] ?? '?');
  }
  if (u.startsWith('node:')) {
    const parts = u.slice(5).split('/');
    if (parts[0] === 'internal') return `node:${parts[1] === 'streams' ? 'streams' : (parts[1] ?? 'internal').replace(/\.js$/, '')}`;
    return `node:${parts[0]}`;
  }
  if (/\/squad\/src\//.test(u)) return 'squad (src)';
  if (/\/squad\/bench\//.test(u)) return 'bench';
  return 'other';
}

export interface Summary {
  file: string;
  totalMs: number;
  busyMs: number;
  packages: Array<{ pkg: string; ms: number; pctBusy: number }>;
  buckets: Array<{ bucket: string; ms: number; pctBusy: number }>;
  top: Array<{ fn: string; pkg: string; ms: number; pctBusy: number }>;
  causes: Array<{ cause: string; ms: number; pctBusy: number }>;
}

export function summarise(file: string): Summary {
  const p = JSON.parse(readFileSync(file, 'utf8')) as Profile;
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map<number, number>();
  const avg = (p.endTime - p.startTime) / Math.max(1, p.samples.length);
  for (let i = 0; i < p.samples.length; i++) {
    const dt = p.timeDeltas[i + 1] ?? avg;
    self.set(p.samples[i] as number, (self.get(p.samples[i] as number) ?? 0) + dt);
  }
  const totalUs = [...self.values()].reduce((a, b) => a + b, 0);
  const pkgs = new Map<string, number>();
  const fns = new Map<string, { pkg: string; us: number }>();
  for (const [id, us] of self) {
    const n = byId.get(id) as ProfileNode;
    const pkg = pkgOf(n);
    pkgs.set(pkg, (pkgs.get(pkg) ?? 0) + us);
    const where = n.callFrame.url ? `${basename(n.callFrame.url.replace(/\\/g, '/'))}:${n.callFrame.lineNumber + 1}` : '';
    const key = `${n.callFrame.functionName || '(anonymous)'} ${where}`.trim();
    const f = fns.get(key) ?? { pkg, us: 0 };
    f.us += us;
    fns.set(key, f);
  }
  const idleUs = pkgs.get('(idle)') ?? 0;
  const busyUs = totalUs - idleUs;
  const ms = (us: number): number => Math.round(us / 100) / 10;
  const pct = (us: number): number => Math.round((us / Math.max(1, busyUs)) * 1000) / 10;
  const packages = [...pkgs.entries()].filter(([k]) => k !== '(idle)').sort((a, b) => b[1] - a[1]).map(([pkg, us]) => ({ pkg, ms: ms(us), pctBusy: pct(us) }));
  const bucketUs = new Map<string, number>();
  for (const [pkg, us] of pkgs) {
    if (pkg === '(idle)') continue;
    const b = BUCKETS.find(([, re]) => re.test(pkg))?.[0] ?? (pkg === '(program)' ? '(program): V8/native outside JS' : 'other node internals');
    bucketUs.set(b, (bucketUs.get(b) ?? 0) + us);
  }
  const buckets = [...bucketUs.entries()].sort((a, b) => b[1] - a[1]).map(([bucket, us]) => ({ bucket, ms: ms(us), pctBusy: pct(us) }));
  // By cause: walk each sampled node's stack once (memoized per node).
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const causeOf = new Map<number, string>();
  const classify = (id: number): string => {
    const known = causeOf.get(id);
    if (known) return known;
    const n = byId.get(id) as ProfileNode;
    const own = pkgOf(n);
    let cause: string;
    if (own === '(idle)' || own === '(garbage collector)' || own === '(program)') cause = own;
    else {
      const stack: ProfileNode[] = [];
      for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) stack.push(byId.get(cur) as ProfileNode);
      cause = CAUSES.find(([, test]) => stack.some((f) => test(pkgOf(f), f)))?.[0] ?? 'other (mineflayer timers, keepalive, node internals)';
    }
    causeOf.set(id, cause);
    return cause;
  };
  const causeUs = new Map<string, number>();
  for (const [id, us] of self) {
    const c = classify(id);
    if (c === '(idle)') continue;
    causeUs.set(c, (causeUs.get(c) ?? 0) + us);
  }
  const causes = [...causeUs.entries()].sort((a, b) => b[1] - a[1]).map(([cause, us]) => ({ cause, ms: ms(us), pctBusy: pct(us) }));
  const top = [...fns.entries()]
    .filter(([, f]) => f.pkg !== '(idle)')
    .sort((a, b) => b[1].us - a[1].us)
    .slice(0, 25)
    .map(([fn, f]) => ({ fn, pkg: f.pkg, ms: ms(f.us), pctBusy: pct(f.us) }));
  return { file, totalMs: ms(totalUs), busyMs: ms(busyUs), packages, buckets, top, causes };
}

export function render(s: Summary): string {
  const lines = [
    `### ${basename(s.file)}`,
    '',
    `Profiled ${Math.round(s.totalMs / 100) / 10} s, main thread busy ${Math.round(s.busyMs / 100) / 10} s (${Math.round((s.busyMs / Math.max(1, s.totalMs)) * 1000) / 10} %).`,
    '',
    '| by cause (inclusive: what is on the stack) | ms | % of busy |',
    '|---|---|---|',
    ...s.causes.map((c) => `| ${c.cause} | ${c.ms} | ${c.pctBusy} |`),
    '',
    '| by package bucket (self time) | ms | % of busy |',
    '|---|---|---|',
    ...s.buckets.map((b) => `| ${b.bucket} | ${b.ms} | ${b.pctBusy} |`),
    '',
    '| package | ms | % of busy |',
    '|---|---|---|',
    ...s.packages.slice(0, 15).map((p) => `| ${p.pkg} | ${p.ms} | ${p.pctBusy} |`),
    '',
    '| top self-time function | package | ms | % of busy |',
    '|---|---|---|---|',
    ...s.top.map((t) => `| \`${t.fn.replace(/\|/g, '\\|')}\` | ${t.pkg} | ${t.ms} | ${t.pctBusy} |`),
    '',
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && /[\\/]profile-summary\.ts$/.test(process.argv[1]);
if (isMain) {
  const files = process.argv
    .slice(2)
    .flatMap((a) => (statSync(a).isDirectory() ? readdirSync(a).filter((f) => f.endsWith('.cpuprofile')).map((f) => join(a, f)) : [a]));
  if (files.length === 0) {
    process.stderr.write('usage: npm run bench:profiles -- <file.cpuprofile | dir> …\n');
    process.exit(1);
  }
  const md = files.map((f) => render(summarise(f))).join('\n');
  process.stdout.write(md);
  const outFile = join(files[0]!.replace(/[\\/][^\\/]+$/, ''), 'profiles.md');
  writeFileSync(outFile, md);
  process.stdout.write(`\n→ ${outFile}\n`);
}
