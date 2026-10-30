// Stock command: every bot empties its inventory (or one item) into the chest the commander was looking at.
export const manifest = {
  summary: 'Vider les inventaires dans le coffre que je regarde',
  params: {
    type: 'object',
    properties: { item: { type: 'string', description: 'only this item id (default: everything but tools, weapons and armor)', default: '' } },
  },
};

const KEEP = /(_sword|_axe|_pickaxe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^bow$|^crossbow$|^shield$|arrow$)/;

export default async function (squad, { item }, ctx) {
  const chest = ctx.commander.at.lookBlock;
  if (!chest || !/chest|barrel/.test(chest.name)) throw new Error('the commander was not looking at a chest or a barrel');
  const results = await squad.parallel(squad.bots, async (bot) => {
    const names = [...new Set(bot.inventory.items().map((i) => i.name))].filter((n) => (item ? n === item : !KEEP.test(n)));
    if (names.length === 0) return 0;
    const r = await depositItemIntoChest(bot, chest, names);
    return Object.values(r.deposited).reduce((a, b) => a + b, 0);
  });
  const total = results.filter((r) => r.ok).reduce((s, r) => s + r.value, 0);
  for (const r of results) if (!r.ok && !r.left) ctx.log(`${r.bot.username}: ${r.error}`);
  return `${total} objets déposés.`;
}
