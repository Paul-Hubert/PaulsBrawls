import { Rcon } from 'rcon-client';

/**
 * RCON wrapper: ALL world control (setup, triggers, teardown, authoritative
 * inventory asserts) goes through here — no op'd bot, no Java changes.
 *
 * The SNBT helpers are pure functions so the parsing logic is unit-testable
 * without a server.
 */

// ---------------------------------------------------------------------------
// Pure SNBT-ish parsing for `data get entity <name> Inventory`
// ---------------------------------------------------------------------------

/**
 * Splits the body of an SNBT list into its top-level entries, respecting
 * nested {}/[] and quoted strings (item components contain both).
 */
export function splitTopLevelEntries(listBody: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < listBody.length; i++) {
    const ch = listBody[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      entries.push(listBody.slice(start, i));
      start = i + 1;
    }
  }
  const tail = listBody.slice(start).trim();
  if (tail) entries.push(tail);
  return entries.map((e) => e.trim()).filter((e) => e.length > 0);
}

/**
 * Parses the RCON response of `data get entity <player> Inventory` into
 * item-id → total count. Ids keep their namespace except `minecraft:`, which
 * is stripped (so vanilla items read as 'carrot' but modded ones as
 * 'paulsbrawls:coin'). Handles both modern `count:` (1.20.5+) and legacy
 * `Count: Nb` keys.
 */
export function parseInventorySnbt(response: string): Record<string, number> {
  const totals: Record<string, number> = {};
  const open = response.indexOf('[');
  if (open === -1) return totals;
  // Find the matching close bracket of the top-level list.
  let depth = 0;
  let close = -1;
  let inString: '"' | "'" | null = null;
  for (let i = open; i < response.length; i++) {
    const ch = response[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return totals;

  for (const entry of splitTopLevelEntries(response.slice(open + 1, close))) {
    const idMatch = /\bid:\s*"([^"]+)"/.exec(entry);
    if (!idMatch) continue;
    const countMatch = /\b[cC]ount:\s*(\d+)/.exec(entry);
    const count = countMatch ? Number(countMatch[1]) : 1;
    const id = idMatch[1].replace(/^minecraft:/, '');
    totals[id] = (totals[id] ?? 0) + count;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RconClient {
  private constructor(
    private readonly rcon: Rcon,
    private readonly logLine: (line: string) => void
  ) {}

  static async connect(
    host: string,
    port: number,
    password: string,
    logLine: (line: string) => void = () => {}
  ): Promise<RconClient> {
    const rcon = await Rcon.connect({ host, port, password });
    return new RconClient(rcon, logLine);
  }

  async send(command: string): Promise<string> {
    const response = await this.rcon.send(command);
    this.logLine(`[rcon] ${command} -> ${response.replace(/\s+/g, ' ').slice(0, 200)}`);
    return response;
  }

  async end(): Promise<void> {
    await this.rcon.end();
  }

  // -- convenience wrappers ---------------------------------------------------

  tp(name: string, x: number, y: number, z: number): Promise<string> {
    return this.send(`tp ${name} ${x} ${y} ${z}`);
  }

  give(name: string, item: string, count: number): Promise<string> {
    return this.send(`give ${name} ${item} ${count}`);
  }

  clearInventory(name: string): Promise<string> {
    return this.send(`clear ${name}`);
  }

  /** slot: weapon.mainhand | armor.head | armor.chest | armor.legs | armor.feet */
  equip(name: string, slot: string, item: string): Promise<string> {
    return this.send(`item replace entity ${name} ${slot} with ${item} 1`);
  }

  timeSet(timeOfDay: number): Promise<string> {
    return this.send(`time set ${timeOfDay}`);
  }

  effect(name: string, effect: string, seconds: number, amplifier: number): Promise<string> {
    return this.send(`effect give ${name} ${effect} ${seconds} ${amplifier}`);
  }

  effectClear(name: string): Promise<string> {
    return this.send(`effect clear ${name}`);
  }

  damage(name: string, amount: number): Promise<string> {
    return this.send(`damage ${name} ${amount}`);
  }

  summonTagged(type: string, x: number, y: number, z: number, tags: string[], extraNbt = ''): Promise<string> {
    const tagList = tags.map((t) => `"${t}"`).join(',');
    const nbt = `{Tags:[${tagList}],PersistenceRequired:1b${extraNbt ? `,${extraNbt}` : ''}}`;
    return this.send(`summon ${type} ${x} ${y} ${z} ${nbt}`);
  }

  killTagged(tag: string): Promise<string> {
    return this.send(`kill @e[tag=${tag}]`);
  }

  killDroppedItems(): Promise<string> {
    return this.send(`kill @e[type=minecraft:item]`);
  }

  async anyEntityWithTag(tag: string): Promise<boolean> {
    const response = await this.send(`execute if entity @e[tag=${tag}]`);
    return !/Test failed/i.test(response);
  }

  /** deathCount-style scoreboard read; unset (never died) reads as 0. */
  async getScore(player: string, objective: string): Promise<number> {
    const response = await this.send(`scoreboard players get ${player} ${objective}`);
    const match = /has (-?\d+)/.exec(response);
    return match ? Number(match[1]) : 0;
  }

  /** Authoritative inventory snapshot via `data get` (item id → total count). */
  async inventory(name: string): Promise<Record<string, number>> {
    const response = await this.send(`data get entity ${name} Inventory`);
    return parseInventorySnbt(response);
  }
}
