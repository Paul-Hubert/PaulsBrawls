// Where a function's time goes: for each function name given, its total time (itself + callees, a recursive call
// counted once) split by its direct callees, from a .cpuprofile. The counterpart of callers.ts: `doPhysics` → which
// physicsTick listeners, `emitPacket` → which packet handlers (EventEmitter's `emit` is see-through).
//
//   cd squad && npm run bench:callees -- <file.cpuprofile> doPhysics emitPacket

import { readFileSync } from 'node:fs';

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

const [file, ...targets] = process.argv.slice(2);
if (!file || targets.length === 0) {
  process.stderr.write('usage: npm run bench:callees -- <file.cpuprofile> <functionName> …\n');
  process.exit(1);
}
const p = JSON.parse(readFileSync(file, 'utf8')) as { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map<number, number>();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i] as number, (self.get(p.samples[i] as number) ?? 0) + (p.timeDeltas[i + 1] ?? 0));
const busy = [...self.entries()].filter(([id]) => byId.get(id)?.callFrame.functionName !== '(idle)').reduce((a, [, us]) => a + us, 0);

// Subtree time per node, iteratively (deep profiles overflow a recursive walk).
const subtree = new Map<number, number>();
for (const root of p.nodes.filter((n) => !parent.has(n.id))) {
  const stack: Array<[number, boolean]> = [[root.id, false]];
  while (stack.length) {
    const [id, done] = stack.pop() as [number, boolean];
    const kids = byId.get(id)?.children ?? [];
    if (done) {
      subtree.set(id, (self.get(id) ?? 0) + kids.reduce((a, c) => a + (subtree.get(c) ?? 0), 0));
      continue;
    }
    stack.push([id, true]);
    for (const c of kids) stack.push([c, false]);
  }
}

const label = (n: ProfileNode): string => {
  const where = n.callFrame.url.split(/[\\/]/).slice(-2).join('/');
  return `${n.callFrame.functionName || '(anonymous)'} ${where}:${n.callFrame.lineNumber + 1}`;
};
const pct = (us: number): string => `${((us / Math.max(1, busy)) * 100).toFixed(1)} %`;

for (const t of targets) {
  // The outermost nodes of the function (a node with the same function above it is already inside one).
  const outer = p.nodes.filter((n) => {
    if (n.callFrame.functionName !== t) return false;
    for (let cur = parent.get(n.id); cur !== undefined; cur = parent.get(cur)) if (byId.get(cur)?.callFrame.functionName === t) return false;
    return true;
  });
  let total = 0;
  let own = 0;
  const kids = new Map<string, number>();
  for (const n of outer) {
    total += subtree.get(n.id) ?? 0;
    own += self.get(n.id) ?? 0;
    // EventEmitter frames are see-through: `emit` → its listeners (physicsTick listeners, packet handlers).
    const visit = (c: number): void => {
      const cn = byId.get(c) as ProfileNode;
      if (cn.callFrame.url === 'node:events') {
        const through = (cn.children ?? []).reduce((a, g) => a + (subtree.get(g) ?? 0), 0);
        const left = (subtree.get(c) ?? 0) - through;
        if (left > 0) kids.set('(emit itself)', (kids.get('(emit itself)') ?? 0) + left);
        for (const g of cn.children ?? []) visit(g);
        return;
      }
      const k = label(cn);
      kids.set(k, (kids.get(k) ?? 0) + (subtree.get(c) ?? 0));
    };
    for (const c of n.children ?? []) visit(c);
  }
  process.stdout.write(`\n## ${t}: ${Math.round(total / 1000)} ms total (${pct(total)} of busy), ${Math.round(own / 1000)} ms self\n`);
  for (const [k, us] of [...kids.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    process.stdout.write(`${String(Math.round(us / 1000)).padStart(7)} ms  ${pct(us).padStart(7)}  ${k}\n`);
  }
}
