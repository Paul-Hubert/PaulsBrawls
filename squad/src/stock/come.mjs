// Stock command: every bot walks to where the commander stood when they gave the order.
export const manifest = {
  summary: 'Venir jusqu’à moi',
  params: { type: 'object', properties: { range: { type: 'integer', minimum: 1, maximum: 16, default: 2 } } },
};

export default async function (squad, { range }, ctx) {
  const target = ctx.commander.at.position;
  const results = await squad.parallel(squad.bots, (bot) => goTo(bot, target, range));
  const arrived = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok && !r.left) ctx.log(`${r.bot.username}: ${r.error}`);
  return `${arrived}/${results.length} bots arrivés.`;
}
