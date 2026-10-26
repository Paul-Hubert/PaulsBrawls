import type { Bot } from 'mineflayer';
import { BotConnection } from '../bot-connection.js';
import { log } from '../logger.js';
import type { MemoryVectors } from './embeddings.js';
import { BotMemory } from './memory.js';
import { Persistence } from './persistence.js';
import { SkillLibrary } from './skill-library.js';
import { VillagerEventBus } from './event-bus.js';
import { RosterBot, Vec3Like, VillageSettings } from './types.js';
import type { ReflexEngine } from './reflex-engine.js';
import type { RoutineRunner } from './routines.js';

/**
 * One villager: body (BotConnection), memory, skills, inbox, event bus, and
 * the per-bot action serialization chain. The reflex engine and routine
 * runner are attached by bot-host after construction (type-only imports keep
 * the module graph acyclic).
 */

export interface InboxMessage {
  from: string;
  text: string;
  at: number;
}

const MIRROR_MIN_INTERVAL_MS = 1_200;
const MIRROR_MAX_QUEUE = 4;
const MIRROR_MAX_LEN = 220;

export class Villager {
  readonly roster: RosterBot;
  readonly connection: BotConnection;
  readonly memory: BotMemory;
  readonly skills: SkillLibrary;
  readonly bus: VillagerEventBus;
  /** Unread tell()s, drained into the next deliberation's observation. */
  readonly inbox: InboxMessage[] = [];

  // Attached by bot-host right after construction.
  reflex!: ReflexEngine;
  routines!: RoutineRunner;

  /** Serializes world-touching actions for this bot. */
  private actionChain: Promise<unknown> = Promise.resolve();
  private mirrorQueue: string[] = [];
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMirrorAt = 0;

  private readonly settings: VillageSettings;
  private readonly villagerNames: ReadonlySet<string>;
  private readonly persistence: Persistence;

  constructor(
    roster: RosterBot,
    connection: BotConnection,
    persistence: Persistence,
    settings: VillageSettings,
    villagerNames: ReadonlySet<string>,
    vectors?: MemoryVectors
  ) {
    this.roster = roster;
    this.connection = connection;
    this.persistence = persistence;
    this.settings = settings;
    this.villagerNames = villagerNames;
    this.bus = new VillagerEventBus(roster.name);
    this.memory = new BotMemory(roster.name, persistence, vectors);
    this.skills = new SkillLibrary(roster.name, persistence);
  }

  get name(): string {
    return this.roster.name;
  }

  // -- world anchors ----------------------------------------------------------
  //
  // The roster's coordinates are assertions about a world that may have been
  // regenerated since the file was written. Discovered corrections (boot
  // validation, chest relocation during deposit/withdraw, set_home/set_chest)
  // are persisted per bot and win over the roster.

  homeAnchor(): Vec3Like | null {
    return this.persistence.botState(this.name).anchors.home ?? this.roster.home ?? null;
  }

  chestAnchor(): Vec3Like | null {
    return this.persistence.botState(this.name).anchors.chest ?? this.roster.chest ?? null;
  }

  setHomeAnchor(pos: Vec3Like, why: string): void {
    this.persistence.botState(this.name).anchors.home = { x: pos.x, y: pos.y, z: pos.z };
    this.persistence.markDirty(this.name);
    log('info', `[village] ${this.name} home re-anchored to (${pos.x},${pos.y},${pos.z}): ${why}`);
    this.memory.append('system', `ma maison est maintenant en (${pos.x},${pos.y},${pos.z}) — ${why}`, ['maison'], 6);
  }

  setChestAnchor(pos: Vec3Like, why: string): void {
    this.persistence.botState(this.name).anchors.chest = { x: pos.x, y: pos.y, z: pos.z };
    this.persistence.markDirty(this.name);
    log('info', `[village] ${this.name} chest re-anchored to (${pos.x},${pos.y},${pos.z}): ${why}`);
    this.memory.append('system', `mon coffre est maintenant en (${pos.x},${pos.y},${pos.z}) — ${why}`, ['coffre'], 6);
  }

  bot(): Bot | null {
    return this.connection.isConnected() ? this.connection.getBot() : null;
  }

  requireBot(): Bot {
    const bot = this.bot();
    if (!bot) throw new Error(`${this.name} is not connected to the server`);
    return bot;
  }

  /**
   * Serialize an action against this bot. Reflex handlers, routines, and
   * deliberation tools all funnel through here so pathfinder/dig/craft calls
   * never interleave for one body.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.actionChain.then(fn, fn);
    this.actionChain = next.catch(() => { /* keep the chain alive */ });
    return next;
  }

  // -- social ---------------------------------------------------------------

  pushInbox(from: string, text: string): void {
    this.inbox.push({ from, text: text.slice(0, 300), at: Date.now() });
    if (this.inbox.length > 12) this.inbox.shift();
    this.bus.emit({ type: 'message', from, text });
  }

  takeInbox(): InboxMessage[] {
    return this.inbox.splice(0, this.inbox.length);
  }

  /**
   * Speak into in-game chat — rate-limited, and only when a real player is in
   * earshot (bot↔bot routing is in-process; the mirror exists for spectators,
   * VILLAGE_PLAN §D7).
   */
  mirrorChat(text: string): void {
    const bot = this.bot();
    if (!bot) return;
    if (!this.playerInEarshot(bot)) return;
    if (this.mirrorQueue.length >= MIRROR_MAX_QUEUE) return;
    this.mirrorQueue.push(text.slice(0, MIRROR_MAX_LEN));
    this.drainMirrorQueue();
  }

  private drainMirrorQueue(): void {
    if (this.mirrorTimer) return;
    const now = Date.now();
    const wait = Math.max(0, this.lastMirrorAt + MIRROR_MIN_INTERVAL_MS - now);
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      const line = this.mirrorQueue.shift();
      if (line !== undefined) {
        const bot = this.bot();
        if (bot) {
          try {
            // Leading-slash strip mirrors the bridge's /chat rule: speech must
            // never become a server command.
            bot.chat(line.replace(/^\/+/, ''));
            this.lastMirrorAt = Date.now();
          } catch (err) {
            log('warn', `${this.name} mirror chat failed: ${String(err)}`);
          }
        }
      }
      if (this.mirrorQueue.length > 0) this.drainMirrorQueue();
    }, wait);
    this.mirrorTimer.unref?.();
  }

  private playerInEarshot(bot: Bot): boolean {
    const radius = this.settings.earshotRadius;
    for (const player of Object.values(bot.players)) {
      if (!player?.entity || !player.username) continue;
      if (this.villagerNames.has(player.username)) continue;
      if (player.username === bot.username) continue;
      if (bot.entity.position.distanceTo(player.entity.position) <= radius) return true;
    }
    return false;
  }

  /** Other villagers within earshot of this one (free gossip propagation). */
  villagersInEarshot(all: Iterable<Villager>): Villager[] {
    const bot = this.bot();
    if (!bot) return [];
    const result: Villager[] = [];
    for (const other of all) {
      if (other.name === this.name) continue;
      const otherBot = other.bot();
      if (!otherBot) continue;
      if (bot.entity.position.distanceTo(otherBot.entity.position) <= this.settings.earshotRadius) {
        result.push(other);
      }
    }
    return result;
  }
}
