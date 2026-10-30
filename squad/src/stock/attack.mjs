// Stock command: every bot attacks the entity the commander was looking at, else the nearest hostile mob. Bots with
// a bow and arrows shoot; the others fight in melee.
export const manifest = {
  summary: 'Attaquer ce que je regarde (sinon le monstre le plus proche)',
  params: { type: 'object', properties: { radius: { type: 'integer', minimum: 4, maximum: 64, default: 24 } } },
};

export default async function (squad, { radius }, ctx) {
  const look = ctx.commander.at.lookEntity;
  const pick = (bot) => {
    if (look) {
      const same = (e) => (look.username ? e.username === look.username : e.name === look.name) && e.position.distanceTo(look.position) < 8;
      const target = nearestEntity(bot, same, radius + 16);
      if (target) return target;
    }
    return nearestHostile(bot, radius);
  };
  const archer = (bot) => bot.inventory.items().some((i) => i.name === 'bow') && bot.inventory.items().some((i) => i.name.endsWith('arrow'));

  const results = await squad.parallel(squad.bots, async (bot) => {
    const target = pick(bot);
    if (!target) return false;
    if (!archer(bot)) return (await attack(bot, target)).killed;
    for (let i = 0; i < 12 && target.isValid; i++) await shoot(bot, target);
    return !target.isValid;
  });
  for (const r of results) if (!r.ok && !r.left) ctx.log(`${r.bot.username}: ${r.error}`);
  return results.some((r) => r.ok && r.value) ? 'Cible abattue.' : 'Pas de cible abattue.';
}
