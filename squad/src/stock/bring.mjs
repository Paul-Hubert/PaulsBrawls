// Stock command: the bots walk to the commander and drop the items asked for at their feet.
export const manifest = {
  summary: 'M’apporter des objets (ex. : /bots order bring oak_log 32)',
  params: {
    type: 'object',
    properties: {
      item: { type: 'string', description: 'Minecraft item id' },
      count: { type: 'integer', minimum: 1, maximum: 2304, default: 64 },
    },
    required: ['item'],
  },
};

export default async function (squad, { item, count }, ctx) {
  const id = squad.bots[0]?.registry.itemsByName[item]?.id;
  if (id === undefined) throw new Error(`unknown item "${item}"`);
  let left = count; // shared by every bot: JavaScript is single-threaded, so no race
  const results = await squad.parallel(squad.bots, async (bot) => {
    const have = bot.inventory.items().filter((i) => i.name === item).reduce((s, i) => s + i.count, 0);
    if (have === 0 || left <= 0) return 0;
    const me = ctx.commander.entity(bot);
    await goTo(bot, me ? me.position : ctx.commander.at.position, 2);
    const n = Math.min(have, left);
    if (n <= 0) return 0;
    left -= n;
    await bot.toss(id, null, n);
    return n;
  });
  const given = results.filter((r) => r.ok).reduce((s, r) => s + r.value, 0);
  return given ? `${given} ${item} apportés.` : `Aucun bot n’a de ${item}.`;
}
