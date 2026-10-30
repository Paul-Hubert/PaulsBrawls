// Stock command: mine `count` blocks of a kind with every bot, as a work queue (batches of 4). Bots never fight
// over a block (mineBlock claims its targets), and a reclaimed bot's batch is picked up by another bot.
export const manifest = {
  summary: 'Récolter des blocs (ex. : /bots order gather oak_log 32)',
  params: {
    type: 'object',
    properties: {
      block: { type: 'string', description: 'Minecraft block id, or "_log" for any log', default: '_log' },
      count: { type: 'integer', minimum: 1, maximum: 1024, default: 16 },
    },
  },
};

export default async function (squad, { block, count }, ctx) {
  const batches = [];
  for (let left = count; left > 0; left -= 4) batches.push(Math.min(4, left));
  // Once a batch finds nothing left to mine, the batches not started yet are skipped (running ones finish).
  let nothingLeft = null;
  const results = await squad.tasks(batches, async (bot, n) => {
    if (nothingLeft) return { mined: 0 };
    try {
      return await mineBlock(bot, block, n, { maxDistance: 48 });
    } catch (e) {
      if (/none found/.test(e.message)) nothingLeft = e.message;
      throw e;
    }
  });
  const mined = results.filter((r) => r.ok).reduce((sum, r) => sum + r.value.mined, 0);
  const errors = results.filter((r) => !r.ok).map((r) => r.error);
  if (errors.length) ctx.log(`failed batches: ${errors.join(' | ')}`);
  if (nothingLeft) ctx.log(`stopped early: ${nothingLeft}`);
  if (mined === 0) throw new Error(`nothing mined: ${errors[0] ?? nothingLeft ?? `no ${block} nearby`}`);
  return `${mined}/${count} ${block} récoltés.`;
}
