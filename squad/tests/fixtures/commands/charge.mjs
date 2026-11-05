// A non-stock example command (docs/43 C4), written only with the formation helpers, to show they are enough: a line
// whose melee bots charge what the commander points at, then re-form. The line is its own (lineUp + approach in a
// squad.crew); the charge is the stock `attack` run as a subroutine on the melee role alone (ctx.run with one of the
// squad's live arrays): the melee bots are lent to it while it runs (the line's loops let them go), the archers keep
// their line and shoot, and when the attack ends the melee bots come back ('joined') and walk to their slots again.
export const manifest = {
  summary: 'Charge : une ligne dont les fantassins chargent ce que je vise, puis reprennent leur place',
  params: {
    type: 'object',
    properties: {
      back: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'les archers à tant de blocs derrière les fantassins' },
      seconds: { type: 'integer', minimum: 5, maximum: 120, default: 30, description: 'durée maximale d’une charge' },
    },
  },
  roles: {
    archers: { select: { hasItem: 'bow' }, take: 'reclaim' },
    melee: { select: { not: { hasItem: 'bow' } }, take: 'reclaim' },
  },
  duration: 'until-stopped',
};

export default async function (squad, args, ctx) {
  const back = Number(args.back ?? 4);
  const seconds = Number(args.seconds) || 30;
  let slots = new Map();
  let yaw = 0;
  let charges = 0;
  let charging = false;

  /** The melee bots on the point, the archers `back` blocks behind them, each on its exact place. */
  const form = (at) => {
    const point = pointOf(squad.bots, at);
    const fwd = lookDir(at.yaw);
    yaw = at.yaw;
    const archers = lineUp(squad.roles.archers ?? [], point.offset(-fwd.x * back, 0, -fwd.z * back), at.yaw, { spacing: 2, ground: squad.bots });
    slots = new Map([...lineUp(squad.roles.melee ?? [], point, at.yaw, { spacing: 1.5, ground: squad.bots }), ...archers]);
  };

  /** The charge: `attack` on the melee bots alone (they are lent to it); they come back to the line when it ends. */
  const charge = async () => {
    charging = true;
    charges++;
    try {
      const r = await ctx.run('attack', { seconds }, { bots: squad.roles.melee ?? [] });
      ctx.log(`charge ${charges}: ${r}`);
    } finally {
      charging = false;
    }
  };

  // A click on a creature: the melee charge it; elsewhere: the line re-forms there.
  ctx.commander.on('trigger', (at) => {
    if (pointedTarget(squad.bots, at, { near: 4 }).entity) {
      if (!charging) void charge();
    } else form(at);
  });

  // A bot that comes back from the charge keeps its slot; a newcomer re-forms the line.
  squad.on('joined', (bot) => {
    if (!slots.has(bot.username)) form(ctx.commander.at);
  });
  form(ctx.commander.at);

  // One loop per bot: an archer shoots what comes within 48 blocks; everyone walks to its exact place and holds it.
  squad.crew(async (bot, role) => {
    const slot = slots.get(bot.username);
    if (!slot) return squad.sleep(200);
    const foe = role === 'archers' ? nearestFoe(bot, 48) : null;
    if (foe) {
      try {
        await shoot(bot, foe);
      } catch (e) {
        if (e instanceof BotLeftError || e instanceof OrderStoppedError) throw e;
        await squad.sleep(250);
      }
      return;
    }
    if (Math.hypot(bot.entity.position.x - slot.x, bot.entity.position.z - slot.z) > 0.15) {
      await approach(bot, slot, { until: () => slots.get(bot.username) !== slot || (role === 'archers' && !!nearestFoe(bot, 48)) });
      return;
    }
    await faceYaw(bot, yaw);
    await squad.sleep(200);
  });
  await squad.untilStopped();
  return `Charge terminée (${charges} charge${charges === 1 ? '' : 's'}).`;
}
