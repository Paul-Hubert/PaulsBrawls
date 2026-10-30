// Who calls a hot function: for each function name given, the self time of its samples grouped by their chain of
// callers (5 levels up), from a .cpuprofile. Complements profile-summary.ts (which only sees self time).
//
//   cd squad && npm run bench:callers -- <file.cpuprofile> fromStateId Version ExtendableError

import { readFileSync } from 'node:fs';

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

const [file, ...targets] = process.argv.slice(2);
if (!file || targets.length === 0) {
  process.stderr.write('usage: npm run bench:callers -- <file.cpuprofile> <functionName> …\n');
  process.exit(1);
}
const p = JSON.parse(readFileSync(file, 'utf8')) as { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map<number, number>();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i] as number, (self.get(p.samples[i] as number) ?? 0) + (p.timeDeltas[i + 1] ?? 0));

const label = (n: ProfileNode): string => {
  const where = n.callFrame.url.split(/[\\/]/).slice(-2).join('/');
  return `${n.callFrame.functionName || '(anonymous)'} ${where}:${n.callFrame.lineNumber + 1}`;
};

for (const t of targets) {
  const agg = new Map<string, number>();
  let total = 0;
  for (const [id, us] of self) {
    if (byId.get(id)?.callFrame.functionName !== t) continue;
    total += us;
    const chain: string[] = [];
    let cur = parent.get(id);
    for (let k = 0; k < 5 && cur !== undefined; k++) {
      chain.push(label(byId.get(cur) as ProfileNode));
      cur = parent.get(cur);
    }
    const key = chain.join(' ← ');
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  process.stdout.write(`\n## ${t}: ${Math.round(total / 1000)} ms of self time\n`);
  for (const [k, us] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) process.stdout.write(`${String(Math.round(us / 1000)).padStart(6)} ms  ${k}\n`);
}
