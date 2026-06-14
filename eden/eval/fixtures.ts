// eval/fixtures.ts — RCON-idempotent world fixtures (R42). A fixture describes a bot's pre-scenario world
// state DECLARATIVELY; `fixtureCommands` lowers it to a list of Minecraft commands that are RCON-idempotent
// — every command is an absolute SET (clear / give-exact / tp-absolute), so RE-APPLYING the fixture leaves
// the world in the same state. The fixture LOGIC + the idempotency check are unit-testable in CI; the
// actual RCON send is a thin smoke-time effector (eval/run.ts), so CI touches no Minecraft.

/** A declarative pre-scenario world state for one bot. All fields are absolute SETS (idempotent). */
export interface WorldFixture {
  /** The bot whose world this seeds (an EvalBot name — R12). */
  player: string;
  /** Clear the bot's inventory first (so `give` lands in a known state). */
  clearInventory?: boolean;
  /** Exact items to give (absolute counts — re-giving the same set is idempotent against a cleared inv). */
  give?: Array<{ item: string; count: number }>;
  /** Teleport to an ABSOLUTE position (never relative `~` — that would drift on re-apply). */
  tp?: [number, number, number];
  /** Absolute-time set (e.g. `set day`) — idempotent. */
  setTime?: 'day' | 'night' | 'noon' | 'midnight';
  /** Absolute weather set — idempotent. */
  setWeather?: 'clear' | 'rain' | 'thunder';
}

/** Lower a declarative fixture to ordered RCON commands. Order: clear → give → tp → time → weather. */
export function fixtureCommands(fx: WorldFixture): string[] {
  const cmds: string[] = [];
  if (fx.clearInventory) cmds.push(`clear ${fx.player}`);
  for (const g of fx.give ?? []) cmds.push(`give ${fx.player} ${g.item} ${g.count}`);
  if (fx.tp) cmds.push(`tp ${fx.player} ${fx.tp[0]} ${fx.tp[1]} ${fx.tp[2]}`);
  if (fx.setTime) cmds.push(`time set ${fx.setTime}`);
  if (fx.setWeather) cmds.push(`weather ${fx.setWeather}`);
  return cmds;
}

/**
 * Idempotency check (R42): a command set is idempotent iff none of its commands depend on RELATIVE state —
 * relative coordinates (`~`/`^`) or relative selectors that re-apply differently. An absolute `clear` /
 * `give exact-count` / `tp x y z` / `time set` / `weather` re-applies cleanly; a `summon ... ~ ~ ~` or a
 * relative `tp ~ ~ ~` would spawn/move again on every re-apply. This guards a fixture author against
 * accidentally writing a non-idempotent seed (the world drifts across re-runs otherwise).
 */
export function isIdempotentFixture(commands: string[]): boolean {
  for (const c of commands) {
    if (/[~^]/.test(c)) return false; // relative coords drift on re-apply
    if (/^\s*summon\b/.test(c)) return false; // summon is additive — re-applying spawns duplicates
    if (/^\s*setblock\b.*\bdestroy\b/.test(c)) return false; // destroy mode drops items each time
  }
  return true;
}
