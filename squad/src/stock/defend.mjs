// Stock command: archers are pulled off whatever they were doing and shoot from range; melee bots are taken only
// if idle and fight up close. Between threats everyone stays near the commander. Friends are never targeted.
export const manifest = {
  summary: 'Me défendre : archers à distance, mêlée au contact',
  params: { type: 'object', properties: { radius: { type: 'integer', minimum: 4, maximum: 48, default: 16 } } },
  roles: {
    archers: { select: { hasItem: 'bow' }, take: 'reclaim' },
    melee: { select: { not: { hasItem: 'bow' } }, take: 'free' },
  },
  duration: 'until-stopped',
};

export default async function (squad, { radius }, ctx) {
  if (squad.bots.length === 0) throw new Error('no bot available (archers need a bow; melee bots must be idle)');
  const threat = (bot) =>
    nearestHostile(bot, radius) ?? nearestEntity(bot, (e) => e.type === 'player' && !isFriend(e), radius);

  // One loop per bot: fight the nearest threat, else stay `keep` blocks from the commander.
  const guard = (fight, keep) => async (bot) => {
    while (!squad.stopped) {
      const t = threat(bot);
      if (!t) {
        await follow(bot, ctx.commander.entity(bot), keep, { untilMs: 1000 });
        continue;
      }
      try {
        await fight(bot, t);
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        ctx.log(`${bot.username}: ${e.message}`);
        await squad.sleep(500);
      }
    }
  };

  await Promise.all([
    squad.parallel(squad.roles.archers, guard((bot, t) => shoot(bot, t), 6)),
    squad.parallel(squad.roles.melee, guard((bot, t) => attack(bot, t, { timeoutMs: 15000 }), 3)),
  ]);
  return 'Défense levée.';
}
