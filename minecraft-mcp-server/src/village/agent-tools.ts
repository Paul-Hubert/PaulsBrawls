import { Vec3 } from 'vec3';
import * as actions from './actions.js';
import { VillageContext } from './context.js';
import { ToolDefinition } from './llm-client.js';
import { tokenize } from './memory-index.js';
import { auditSkill } from './skill-audit.js';
import { surveyTerrain } from './terrain.js';
import { MemoryEntry, SkillKind } from './types.js';
import { Villager } from './villager.js';

/**
 * Deliberation tools: definitions (OpenAI function-call schema) + dispatcher.
 * Conversation-sensitive tools change meaning/availability with context:
 * `say` inside a conversation is a turn move; trade tools only exist inside a
 * conversation; `start_conversation` only outside one.
 */

export interface DeliberationState {
  conversationMode: boolean;
  done: boolean;
  doneSummary: string;
  /** Set once the bot spoke/left in a conversation — its turn is spent. */
  conversationMoved: boolean;
}

const ACTION_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function def(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

const NUM = (description: string): Record<string, unknown> => ({ type: 'number', description });
const STR = (description: string): Record<string, unknown> => ({ type: 'string', description });
const STACKS = (description: string): Record<string, unknown> => ({
  type: 'array',
  description,
  items: {
    type: 'object',
    properties: { item: { type: 'string' }, count: { type: 'number' } },
    required: ['item', 'count'],
  },
});

export function toolsFor(villager: Villager, ctx: VillageContext): ToolDefinition[] {
  const inConversation = Boolean(ctx.conversations.get(villager.name));
  const tools: ToolDefinition[] = [
    def('go_to', 'Walk near a position.', { x: NUM('x'), y: NUM('y'), z: NUM('z'), range: NUM('how close (default 1)') }, ['x', 'y', 'z']),
    def('collect_blocks', 'Find, mine and pick up blocks of a type within 32 blocks.', { blockType: STR("e.g. 'oak_log'"), count: NUM('default 1') }, ['blockType']),
    def('craft', 'Craft an item (uses a nearby crafting table when needed). Returns how many items were actually made.', { item: STR("e.g. 'oak_planks'"), count: NUM('how many ITEMS you want, default 1') }, ['item']),
    def('equip', 'Equip a named inventory item in hand.', { item: STR('item name (substring ok)') }, ['item']),
    def('dig', 'Mine the block at a position.', { x: NUM('x'), y: NUM('y'), z: NUM('z') }, ['x', 'y', 'z']),
    def('place', 'Place an inventory item as a block.', { item: STR('item name'), x: NUM('x'), y: NUM('y'), z: NUM('z') }, ['item', 'x', 'y', 'z']),
    def('attack', 'Attack a hostile mob by name or id. Villagers and players are off-limits.', { target: STR("entity name like 'zombie', or an entity id from the observation") }, ['target']),
    def('stop_combat', 'Break off any fight.', {}),
    def('deposit', 'Put items into your chest (falls back to any chest near it or near you; a found chest is remembered).', { item: STR('item'), count: NUM('count') }, ['item', 'count']),
    def('withdraw', 'Take items from your chest (falls back to any chest near it or near you; a found chest is remembered).', { item: STR('item'), count: NUM('count') }, ['item', 'count']),
    def('give', 'Hand items directly to another villager — no chest needed. Atomic when the settlement service is up; otherwise walks over and tosses them. Returns how many were delivered.', { to: STR('villager name'), item: STR('item'), count: NUM('count') }, ['to', 'item', 'count']),
    def('set_chest', 'Point your chest anchor at a real chest (walks there to verify). Use after placing a new chest or when deposit/withdraw says the configured chest is gone.', { x: NUM('x'), y: NUM('y'), z: NUM('z') }, ['x', 'y', 'z']),
    def('set_home', 'Move your home anchor to a position you can stand at (walks there to verify). Use when your configured home is unreachable.', { x: NUM('x'), y: NUM('y'), z: NUM('z') }, ['x', 'y', 'z']),
    def('say', inConversation
      ? 'Speak your line in the active conversation (this passes the turn).'
      : 'Say something out loud to anyone nearby.', { message: STR('what to say (short, in character, in French)') }, ['message']),
    def('tell', "Send a private message to another villager's inbox.", { to: STR('villager name'), message: STR('the message') }, ['to', 'message']),
    def('remember', 'Write a note into your long-term memory.', { note: STR('the note') }, ['note']),
    def('recall', 'Search your long-term memory and trade history by keywords. Use it when you need details older than your recent memories (people, items, places, past deals).', {
      keywords: STR("space-separated keywords, e.g. 'Firmin carottes'"),
      kind: { type: 'string', enum: ['event', 'social', 'trade', 'thought', 'system'], description: 'optional: only this kind of memory' },
    }, ['keywords']),
    def('survey_terrain', 'Get an ASCII relief map of the terrain around you (elevation, water ~, trees T, cliffs ^, you @). Use it before building, choosing where to walk/dig, or describing the land — much cheaper than scouting block by block.', {
      radius: NUM('half-width to sample in blocks (clamped 8..48, default 24)'),
    }),
    def('start_job', 'Start one of your routine skills (farm-loop, wood-loop, …). Optionally declare a verifiable goal — when the job ends you learn whether it was met.', {
      skill: STR('routine skill name'),
      goalItem: STR("optional goal: inventory item to end up with, e.g. 'iron_pickaxe'"),
      goalCount: NUM('optional goal: how many (default 1 when goalItem is set)'),
    }, ['skill']),
    def('stop_job', 'Stop the currently running routine.', {}),
    def('set_day_plan', "Set today's schedule (replaces the previous one; empty slots clear it). It executes by itself — slots start/stop your routines and walk you home/to visits without waking you. Ticks: 0 dawn, 6000 midday, 12000 dusk, 13000 night, 24000 next dawn.", {
      slots: {
        type: 'array',
        description: "3-5 slots, non-overlapping, [from,to) in ticks 0..24000. activity: 'job:<routine>' | 'visit:<villager>' | 'home' | 'idle'",
        items: {
          type: 'object',
          properties: { from: { type: 'number' }, to: { type: 'number' }, activity: { type: 'string' } },
          required: ['from', 'to', 'activity'],
        },
      },
    }, ['slots']),
    def('write_skill', 'Write or rewrite one of your skills (reflex = event handlers, routine = long job script). Code is type-checked against the VillagerAPI before it can run; errors come back here.', {
      name: STR('skill name (letters/digits/_/-)'),
      kind: { type: 'string', enum: ['reflex', 'routine'], description: 'reflex or routine' },
      description: STR('one line: what it does'),
      code: STR('the JavaScript code (VillagerAPI dialect — see your system prompt)'),
    }, ['name', 'kind', 'description', 'code']),
    def('remove_skill', 'Delete one of your skills.', { name: STR('skill name') }, ['name']),
    def('done', 'End this thinking session.', {
      summary: STR('one line: what you decided/did'),
      mood: STR('optional: your mood now, 2-4 French words — only when it changed'),
    }),
  ];

  if (inConversation) {
    tools.push(
      def('leave_conversation', 'End the conversation politely, rate it, and pass on the takeaway.', {
        farewell: STR('optional last line'),
        opinion: NUM('optional, -10..10: how this conversation changed your view of them (0/omit = unchanged)'),
        note: STR("optional, 3-8 words on why (kept with your opinion of them, e.g. 'm'a aidé sans rien demander')"),
        headline: STR('optional: the ONE memory-worthy takeaway, if any (a fact, a deal, news worth repeating)'),
      }),
      def('propose_trade', 'Put a barter offer on the table (also used to counter-offer).', {
        give: STACKS('items YOU hand over'),
        want: STACKS('items you want back'),
      }, ['give', 'want']),
      def('accept_trade', "Accept the other party's standing offer — items swap instantly and atomically.", {}),
      def('reject_trade', 'Reject the standing offer (you can still counter with propose_trade).', {}),
    );
  } else {
    tools.push(
      def('start_conversation', 'Walk-up conversation opener with a nearby villager (must be within 16 blocks).', {
        with: STR('villager name'),
        opening: STR('your opening line (short, in French)'),
      }, ['with', 'opening']),
    );
  }
  return tools;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Free (non-conversation) speech: mirror + nearby villagers overhear. */
function freeSay(villager: Villager, ctx: VillageContext, text: string): void {
  villager.mirrorChat(text);
  villager.memory.append('social', `j'ai dit: ${text}`);
  for (const other of villager.villagersInEarshot(ctx.villagers.values())) {
    other.memory.append('social', `${villager.name} a dit: ${text}`, [villager.name]);
  }
}

/** Compact relative age for recall output lines. */
export function ageOf(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const RECALL_LINE_CHARS = 160;
const MEMORY_KINDS: ReadonlySet<string> = new Set(['event', 'social', 'trade', 'thought', 'system']);

function formatStacksShort(stacks: { item: string; count: number }[]): string {
  return stacks.map((s) => `${s.count}x ${s.item}`).join(', ') || 'nothing';
}

export async function dispatchTool(
  villager: Villager,
  ctx: VillageContext,
  state: DeliberationState,
  name: string,
  rawArgs: string
): Promise<string> {
  const args = parseArgs(rawArgs);
  const act = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
    villager.runExclusive(async () => {
      try {
        return await withTimeout(fn(), ACTION_TIMEOUT_MS, label);
      } catch (err) {
        // A timeout abandons the promise but pvp/collectblock keep driving the
        // bot — leave the controls inert so the next action doesn't fight them.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('timed out after')) {
          const bot = villager.bot();
          if (bot) await actions.abortActiveTasks(bot);
        }
        throw err;
      }
    });

  try {
    switch (name) {
      case 'go_to': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const range = typeof args.range === 'number' ? args.range : 1;
        await act('go_to', () => actions.goTo(villager.requireBot(), Math.floor(x), Math.floor(y), Math.floor(z), range));
        return `arrived near (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)})`;
      }
      case 'collect_blocks': {
        const count = typeof args.count === 'number' ? args.count : 1;
        const got = await act('collect_blocks', () =>
          actions.collectBlocks(villager.requireBot(), String(args.blockType), count));
        return `collected ${got} ${String(args.blockType)}`;
      }
      case 'craft': {
        const count = typeof args.count === 'number' ? args.count : 1;
        const crafted = await act('craft', () => actions.craftItem(villager.requireBot(), String(args.item), count));
        // A success contradicts any stored "can't craft X" belief — retire it.
        villager.memory.refuteBlockedBeliefs(
          `craft ${String(args.item)}`,
          `vérifié: j'ai fabriqué ${crafted}x ${String(args.item)} — mes anciennes conclusions disant que c'était impossible étaient fausses`
        );
        return `crafted ${String(args.item)} x${crafted}`;
      }
      case 'equip': {
        const equipped = await act('equip', () => actions.equipItem(villager.requireBot(), String(args.item)));
        return `equipped ${equipped}`;
      }
      case 'dig': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const dug = await act('dig', () => actions.digBlock(villager.requireBot(), Math.floor(x), Math.floor(y), Math.floor(z)));
        return `dug ${dug}`;
      }
      case 'place': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        await act('place', () => actions.placeBlock(villager.requireBot(), String(args.item), Math.floor(x), Math.floor(y), Math.floor(z)));
        return `placed ${String(args.item)}`;
      }
      case 'attack': {
        const bot = villager.requireBot();
        const targetRaw = String(args.target);
        const asId = Number(targetRaw);
        const info = Number.isInteger(asId) && bot.entities[asId]
          ? actions.describeEntity(bot, bot.entities[asId], ctx.villagerNames)
          : actions.findEntity(bot, targetRaw, 24, ctx.villagerNames);
        if (!info) return `ERROR: no entity matching '${targetRaw}' nearby`;
        if (info.kind === 'villager' || info.kind === 'player') {
          return `ERROR: ${info.name} is a ${info.kind} — villagers do not attack people. Talk it out instead.`;
        }
        actions.attackEntity(bot, info.id);
        return `engaging ${info.name} (combat runs by itself; stop_combat to break off)`;
      }
      case 'stop_combat':
        await act('stop_combat', () => actions.stopCombat(villager.requireBot()));
        return 'combat stopped';
      case 'deposit': {
        let relocationNote = '';
        const moved = await act('deposit', () =>
          actions.depositToChest(villager.requireBot(), villager.chestAnchor(), String(args.item), Number(args.count), (pos) => {
            relocationNote = ` — note: your chest is actually at (${pos.x},${pos.y},${pos.z}); anchor updated`;
            villager.setChestAnchor(pos, "trouvé en déposant — l'ancien emplacement n'avait pas de coffre");
          }));
        return `deposited ${moved} ${String(args.item)}${relocationNote}`;
      }
      case 'withdraw': {
        let relocationNote = '';
        const moved = await act('withdraw', () =>
          actions.withdrawFromChest(villager.requireBot(), villager.chestAnchor(), String(args.item), Number(args.count), (pos) => {
            relocationNote = ` — note: your chest is actually at (${pos.x},${pos.y},${pos.z}); anchor updated`;
            villager.setChestAnchor(pos, "trouvé en retirant — l'ancien emplacement n'avait pas de coffre");
          }));
        return `withdrew ${moved} ${String(args.item)}${relocationNote}`;
      }
      case 'give': {
        const delivered = await act('give', () =>
          ctx.trades.give(villager.name, String(args.to), String(args.item), Number(args.count)));
        return `gave ${delivered}x ${String(args.item)} to ${String(args.to)}`;
      }
      case 'set_chest': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const pos = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        const result = await act('set_chest', async () => {
          const bot = villager.requireBot();
          if (bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4) {
            await actions.goTo(bot, pos.x, pos.y, pos.z, 3);
          }
          const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
          if (!block || !(block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'barrel')) {
            const near = actions.findChestNear(bot, pos, 8);
            if (near) {
              return { ok: true as const, pos: { x: near.position.x, y: near.position.y, z: near.position.z }, adjusted: true };
            }
            return { ok: false as const, found: block?.name ?? 'nothing (unloaded?)' };
          }
          return { ok: true as const, pos, adjusted: false };
        });
        if (!result.ok) return `ERROR: no chest at (${pos.x},${pos.y},${pos.z}) — found ${result.found}. Place a chest first, then set_chest.`;
        villager.setChestAnchor(result.pos, 'set_chest');
        return `chest anchor set to (${result.pos.x},${result.pos.y},${result.pos.z})${result.adjusted ? ' (nearest chest to the position you gave)' : ''}`;
      }
      case 'set_home': {
        const { x, y, z } = args as { x: number; y: number; z: number };
        const pos = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        const result = await act('set_home', async () => {
          const bot = villager.requireBot();
          await actions.goTo(bot, pos.x, pos.y, pos.z, 2);
          const standY = actions.standableYNear(bot, pos, 4);
          return standY === null ? pos : { ...pos, y: standY };
        });
        villager.setHomeAnchor(result, 'set_home');
        return `home anchor set to (${result.x},${result.y},${result.z})`;
      }

      case 'say': {
        const message = String(args.message ?? '').slice(0, 300);
        if (!message) return 'ERROR: empty message';
        const conv = ctx.conversations.get(villager.name);
        if (conv) {
          if (state.conversationMoved) return 'ERROR: you already spoke — your turn is over';
          const error = ctx.conversations.say(villager.name, message);
          if (error) return `ERROR: ${error}`;
          state.conversationMoved = true;
          return 'said (turn passed)';
        }
        freeSay(villager, ctx, message);
        return 'said out loud';
      }
      case 'tell': {
        const target = ctx.villagers.get(String(args.to));
        if (!target) return `ERROR: no villager named '${String(args.to)}'`;
        const message = String(args.message ?? '').slice(0, 300);
        target.pushInbox(villager.name, message);
        villager.memory.append('social', `j'ai écrit à ${target.name}: ${message}`, [target.name]);
        return `message delivered to ${target.name}`;
      }
      case 'start_conversation': {
        const targetName = String(args.with);
        const opening = String(args.opening ?? 'Salut !');
        let error = ctx.conversations.start(villager.name, targetName, opening);
        if (error && error.includes('too far away')) {
          // Walk-then-talk: models burn deliberations retrying this error while
          // the target keeps moving — close the distance for them and retry once.
          const targetBot = ctx.villagers.get(targetName)?.bot();
          if (targetBot?.entity) {
            try {
              await act(`walk to ${targetName}`, async () => {
                const bot = villager.requireBot();
                const p = targetBot.entity.position;
                await actions.goTo(bot, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 3, 45_000);
              });
            } catch (err) {
              return `ERROR: tried to walk to ${targetName} but failed: ${err instanceof Error ? err.message : String(err)} — try again later or tell() them instead`;
            }
            error = ctx.conversations.start(villager.name, targetName, opening);
          }
        }
        return error ? `ERROR: ${error}` : `conversation started with ${targetName} — they will reply soon`;
      }
      case 'leave_conversation': {
        const error = ctx.conversations.leave(villager.name, args.farewell ? String(args.farewell) : undefined, {
          opinion: typeof args.opinion === 'number' ? args.opinion : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
          headline: typeof args.headline === 'string' ? args.headline : undefined,
        });
        if (error) return `ERROR: ${error}`;
        state.conversationMoved = true;
        return 'left the conversation';
      }

      case 'propose_trade': {
        const conv = ctx.conversations.get(villager.name);
        if (!conv) return 'ERROR: trade offers happen inside a conversation — start_conversation first';
        return ctx.trades.propose(conv, villager.name, args.give, args.want);
      }
      case 'accept_trade': {
        const conv = ctx.conversations.get(villager.name);
        if (!conv) return 'ERROR: you are not in a conversation';
        return await ctx.trades.accept(conv, villager.name);
      }
      case 'reject_trade': {
        const conv = ctx.conversations.get(villager.name);
        if (!conv) return 'ERROR: you are not in a conversation';
        return ctx.trades.reject(conv, villager.name);
      }

      case 'start_job': {
        const goalItem = typeof args.goalItem === 'string' && args.goalItem.trim() ? args.goalItem.trim() : undefined;
        const check = goalItem
          ? { item: goalItem, count: typeof args.goalCount === 'number' && args.goalCount > 0 ? Math.floor(args.goalCount) : 1 }
          : undefined;
        const error = villager.routines.start(String(args.skill), check);
        if (error) return `ERROR: ${error}`;
        return `job '${String(args.skill)}' started${check ? ` (goal: ${check.count}x ${check.item} — verified when it ends)` : ''} — it runs by itself, you can stop thinking now`;
      }
      case 'stop_job':
        return villager.routines.stop() ? 'job stopped' : 'no job was running';

      case 'survey_terrain': {
        const bot = villager.bot();
        if (!bot) return 'ERROR: you are not in the world right now';
        const radius = typeof args.radius === 'number' ? args.radius : undefined;
        return surveyTerrain(bot, { radius });
      }

      case 'set_day_plan':
        return ctx.rhythm.setPlanFromModel(villager, args.slots);

      case 'write_skill': {
        const kind = String(args.kind) as SkillKind;
        if (kind !== 'reflex' && kind !== 'routine') return "ERROR: kind must be 'reflex' or 'routine'";
        const code = String(args.code ?? '');
        if (!code.trim()) return 'ERROR: empty code';
        const validation = villager.reflex.validate(code);
        if (!validation.ok) {
          auditSkill({
            bot: villager.name,
            event: 'rejected-validation',
            name: String(args.name),
            kind,
            error: validation.errors.join('; ').slice(0, 500),
            code,
          });
          return `TYPE/VALIDATION ERRORS — fix and retry:\n${validation.errors.join('\n')}`;
        }
        const existed = villager.skills.get(String(args.name));
        const skill = villager.skills.upsert({
          name: String(args.name),
          kind,
          description: String(args.description ?? ''),
          code,
        });
        if (kind === 'reflex') {
          const install = await villager.reflex.install(skill);
          if (!install.ok) {
            if (!existed) villager.skills.remove(skill.name);
            auditSkill({
              bot: villager.name,
              event: 'rejected-install',
              name: skill.name,
              kind,
              version: skill.version,
              error: install.errors.join('; ').slice(0, 500),
              code,
            });
            return `INSTALL FAILED — fix and retry:\n${install.errors.join('\n')}`;
          }
        }
        villager.memory.append('thought', `wrote skill '${skill.name}' v${skill.version} (${kind})`, [skill.name]);
        return `skill '${skill.name}' v${skill.version} ${kind === 'reflex' ? 'installed and live' : 'saved — use start_job to run it'}`;
      }
      case 'remove_skill': {
        const skillName = String(args.name);
        villager.reflex.uninstall(skillName);
        return villager.skills.remove(skillName) ? `skill '${skillName}' removed` : `ERROR: no skill named '${skillName}'`;
      }

      case 'remember':
        villager.memory.append('thought', String(args.note ?? ''));
        return 'noted';

      case 'recall': {
        const keywords = String(args.keywords ?? '').slice(0, 200);
        if (!keywords.trim()) return 'ERROR: give at least one keyword';
        const kind = typeof args.kind === 'string' && MEMORY_KINDS.has(args.kind)
          ? (args.kind as MemoryEntry['kind'])
          : undefined;
        const lines: string[] = [];
        for (const m of villager.memory.recall(keywords, { kind, limit: 8 })) {
          lines.push(`[${m.kind}, ${ageOf(m.at)}] ${m.text}`.slice(0, RECALL_LINE_CHARS));
        }
        for (const t of ctx.persistence.searchLedger(villager.name, tokenize(keywords), 3)) {
          const gave = t.a === villager.name ? t.aGave : t.bGave;
          const got = t.a === villager.name ? t.bGave : t.aGave;
          const other = t.a === villager.name ? t.b : t.a;
          lines.push(`[trade ledger, ${ageOf(t.at)}] gave ${formatStacksShort(gave)} to ${other} for ${formatStacksShort(got)}`.slice(0, RECALL_LINE_CHARS));
        }
        return lines.length > 0 ? lines.join('\n') : `nothing in memory matches '${keywords}'`;
      }

      case 'done': {
        state.done = true;
        state.doneSummary = String(args.summary ?? '');
        const mood = typeof args.mood === 'string' ? args.mood.trim() : '';
        if (mood) villager.memory.setMood(mood);
        return 'ok';
      }

      default:
        return `ERROR: unknown tool '${name}'`;
    }
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}
