// Bench command: every bot walks to random points `min`–`max` blocks away (staying within `keep` of the centre),
// with the real goTo helper, until stopped. Each leg's outcome goes to the bench's counters (globalThis.__squadBench:
// the command runs in the runtime's own realm, O1). The follow phase's leader runs it with short legs.
export const manifest = {
  summary: 'bench: marcher vers des points au hasard',
  params: {
    type: 'object',
    properties: {
      cx: { type: 'number' },
      cz: { type: 'number' },
      min: { type: 'integer', default: 20 },
      max: { type: 'integer', default: 60 },
      keep: { type: 'integer', default: 70 },
      seed: { type: 'integer', default: 1 },
    },
  },
  duration: 'until-stopped',
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The feet height of a standable spot in column (x, z), searched around y0 (the chunk is loaded: within view).
function surfaceY(bot, x, z, y0) {
  for (let y = Math.floor(y0) + 24; y > y0 - 24; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b || b.boundingBox !== 'block' || /leaves|_log/.test(b.name)) continue;
    const a1 = bot.blockAt(new Vec3(x, y + 1, z));
    const a2 = bot.blockAt(new Vec3(x, y + 2, z));
    if (a1 && a2 && a1.boundingBox === 'empty' && a2.boundingBox === 'empty' && !/water|lava/.test(a1.name)) return y + 1;
  }
  return Math.floor(y0);
}

function kind(message) {
  if (/took to long/i.test(message)) return 'timeout';
  if (/no path/i.test(message)) return 'noPath';
  if (/no progress/i.test(message)) return 'stall';
  return 'other';
}

export default async function (squad, { cx, cz, min, max, keep, seed }) {
  const stats = globalThis.__squadBench;
  await squad.parallel(squad.bots, async (bot) => {
    const random = rng(seed * 7919 + [...bot.username].reduce((s, c) => s + c.charCodeAt(0), 0));
    while (!squad.stopped) {
      const p = bot.entity.position;
      let tx = cx;
      let tz = cz;
      for (let i = 0; i < 20; i++) {
        const a = random() * 2 * Math.PI;
        const d = min + random() * (max - min);
        tx = p.x + Math.cos(a) * d;
        tz = p.z + Math.sin(a) * d;
        if (Math.hypot(tx - cx, tz - cz) <= keep) break;
      }
      const target = new Vec3(Math.floor(tx) + 0.5, surfaceY(bot, Math.floor(tx), Math.floor(tz), p.y), Math.floor(tz) + 0.5);
      const t0 = Date.now();
      const dist = p.distanceTo(target);
      try {
        await goTo(bot, target, 2);
        stats?.leg('ok', Date.now() - t0, dist);
      } catch (e) {
        if (squad.stopped) break;
        stats?.leg(kind(String(e?.message ?? e)), Date.now() - t0, dist, String(e?.message ?? e));
        await sleep(500);
      }
    }
  });
  return 'bench-walk arrêté';
}
