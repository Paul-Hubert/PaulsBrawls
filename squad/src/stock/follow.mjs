// Stock command: the bots follow the commander until /bots stop.
export const manifest = {
  summary: 'Me suivre',
  params: { type: 'object', properties: { range: { type: 'integer', minimum: 1, maximum: 16, default: 3 } } },
  duration: 'until-stopped',
};

export default async function (squad, { range }, ctx) {
  // Each bot looks for the commander again every second: they may teleport, die, or log off and back.
  await squad.parallel(squad.bots, async (bot) => {
    while (!squad.stopped) {
      await follow(bot, ctx.commander.entity(bot), range, { untilMs: 1000 });
    }
  });
  return 'Je ne te suis plus.';
}
