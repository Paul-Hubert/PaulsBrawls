import type { Bot } from 'mineflayer';
import { BotConnection } from '../bot-connection.js';
import { log } from '../logger.js';
import { describeEntity } from './actions.js';
import { validateAnchors } from './anchors.js';
import { benchmark } from './benchmark.js';
import { VillageContext } from './context.js';
import { ReflexEngine } from './reflex-engine.js';
import { RoutineRunner } from './routines.js';
import { STOCK_SKILLS } from './stock-skills.js';
import { RosterBot } from './types.js';
import { Villager } from './villager.js';

/**
 * Owns the N villager bodies: staggered logins, per-spawn event wiring
 * (re-attached automatically on reconnects via BotConnection.onSpawn), the
 * shared hostile/night scan loop, and the per-bot heartbeat timers.
 */

const LOGIN_STAGGER_MS = 4_000;
const SCAN_INTERVAL_MS = 2_500;
const HOSTILE_SCAN_RADIUS = 16;
const ATTACKER_SEARCH_RADIUS = 6;

export class BotHost {
  private readonly ctx: VillageContext;
  private readonly mcHost: string;
  private readonly mcPort: number;
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly wasNight = new Map<string, boolean>();
  private readonly initialized = new Set<string>();
  /** Bots we forced 'jump' on to swim out of water — so we know to release it. */
  private readonly floating = new Set<string>();
  private stopping = false;

  constructor(ctx: VillageContext, mcHost: string, mcPort: number) {
    this.ctx = ctx;
    this.mcHost = mcHost;
    this.mcPort = mcPort;
  }

  /** Build Villager objects for the roster (no connections yet). */
  createVillagers(roster: RosterBot[]): void {
    for (const entry of roster) {
      const connection = new BotConnection(
        {
          host: this.mcHost,
          port: this.mcPort,
          username: entry.name,
          // 'short', not 'tiny': findBlocks/blockAt only see loaded chunks, and
          // at 'tiny' a 32-block search radius is mostly unloaded terrain — the
          // bots then "see" missing chests/trees that actually exist.
          viewDistance: 'short',
          announceOnSpawn: false,
          reconnectOnDisconnect: true,
        },
        {
          onLog: (level, message) => log(level, `[village/${entry.name}] ${message}`),
          onChatMessage: (username, message) => this.handleChat(entry.name, username, message),
          onSpawn: (bot) => this.onSpawn(entry.name, bot),
        }
      );
      const villager = new Villager(
        entry,
        connection,
        this.ctx.persistence,
        this.ctx.settings,
        this.ctx.villagerNames,
        this.ctx.embeddings.forBot(entry.name)
      );
      villager.reflex = new ReflexEngine(villager, this.ctx);
      villager.routines = new RoutineRunner(villager, this.ctx);
      this.ctx.villagers.set(entry.name, villager);
    }
  }

  /** Connect everyone, staggered so the server doesn't see a login burst. */
  async start(): Promise<void> {
    for (const villager of this.ctx.villagers.values()) {
      if (this.stopping) return;
      log('info', `[village] connecting ${villager.name} (${villager.roster.role})...`);
      villager.connection.connect();
      await new Promise((resolve) => setTimeout(resolve, LOGIN_STAGGER_MS));
    }
    this.scanTimer = setInterval(() => this.scanTick(), SCAN_INTERVAL_MS);
    this.scanTimer.unref?.();
  }

  shutdown(): void {
    this.stopping = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const timer of this.heartbeatTimers.values()) clearTimeout(timer);
    this.heartbeatTimers.clear();
    for (const villager of this.ctx.villagers.values()) {
      villager.routines.stop();
      villager.connection.cleanup();
    }
  }

  // -- per-spawn wiring -------------------------------------------------------

  private onSpawn(name: string, bot: Bot): void {
    const villager = this.ctx.villagers.get(name);
    if (!villager) return;

    this.wireBotEvents(villager, bot);

    if (!this.initialized.has(name)) {
      this.initialized.add(name);
      this.seedStockSkills(villager);
      void villager.reflex.installAll();
      this.subscribeHostEvents(villager);
      this.scheduleHeartbeat(villager, true);
      log('info', `[village] ${name} is up (${villager.skills.list().length} skills)`);
      // One-shot anchor validation (home reachable? chest real?) — staggered a
      // few seconds past spawn so plugins are loaded and physics has settled.
      const timer = setTimeout(() => {
        if (this.stopping) return;
        void validateAnchors(villager);
      }, 5_000);
      timer.unref?.();
    }
  }

  /** Listeners on the (possibly new, after reconnect) bot instance. */
  private wireBotEvents(villager: Villager, bot: Bot): void {
    // Death forensics context: mineflayer's 'death' event carries nothing, so
    // we keep the last hurt around to log alongside the server's death cause.
    let lastHurt: { at: number; health: number; attacker?: string } | null = null;

    bot.on('entityHurt', (entity) => {
      if (!bot.entity || entity.id !== bot.entity.id) return;
      const attacker = this.guessAttacker(villager, bot);
      lastHurt = { at: Date.now(), health: bot.health ?? 0, ...(attacker ? { attacker: attacker.name } : {}) };
      const outcome = villager.bus.emit(
        { type: 'hurt', ...(attacker ? { attacker } : {}) },
        'hurt',
        2_000
      );
      if (outcome === 'no-subscribers') {
        // Degradation path: no reflex installed — wake the brain instead.
        this.ctx.scheduler.request(
          villager.name,
          'combat',
          `I took damage${attacker ? ` from ${attacker.name}` : ''} and have no reflex for it`
        );
      }
      if (outcome !== 'rate-limited') {
        villager.memory.append(
          'event',
          `j'ai été blessé${attacker ? ` par ${attacker.name}` : ''} (vie: ${bot.health?.toFixed(0)})`,
          attacker ? [attacker.name] : [],
          6
        );
      }
    });

    bot.on('death', () => {
      villager.memory.append('event', 'je suis mort !', undefined, 8);
      benchmark.onDeath(villager.name);
      villager.routines.stop();
      // Respawn happens within a tick or two; let the world settle, then tell the reflexes.
      setTimeout(() => villager.bus.emit({ type: 'died' }, 'died', 5_000), 2_500).unref?.();
    });

    // The authoritative death CAUSE only exists at the packet level: the
    // server's death_combat_event carries the death message ("X starved to
    // death", "X was slain by Zombie", …). bot.on('death') says nothing.
    const client = (bot as unknown as {
      _client?: { on(event: string, handler: (packet: { playerId?: number; message?: unknown }) => void): void };
    })._client;
    client?.on('death_combat_event', (packet) => {
      if (!bot.entity || packet.playerId !== bot.entity.id) return;
      let cause: string;
      try {
        cause = typeof packet.message === 'string' ? packet.message : JSON.stringify(packet.message ?? '');
      } catch {
        cause = '(unparseable death message)';
      }
      cause = cause.slice(0, 200);
      const pos = bot.entity.position;
      const hurtNote = lastHurt
        ? `lastHurt ${Math.round((Date.now() - lastHurt.at) / 1000)}s ago${lastHurt.attacker ? ` by ${lastHurt.attacker}` : ''} (hp ${lastHurt.health.toFixed(0)})`
        : 'no recent hurt event';
      log(
        'warn',
        `[village/${villager.name}] DEATH: ${cause} at (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}) ` +
          `food=${bot.food ?? '?'} ${hurtNote}`
      );
      villager.memory.append('event', `je suis mort: ${cause.slice(0, 120)}`, undefined, 8);
    });

    bot.on('playerCollect', (collector, collected) => {
      if (!bot.entity || collector.id !== bot.entity.id) return;
      const dropped = (collected as { getDroppedItem?: () => { name?: string; count?: number } | null }).getDroppedItem?.();
      const item = dropped?.name ?? 'item';
      villager.bus.emit(
        { type: 'item-received', item, count: dropped?.count ?? 1 },
        `item:${item}`,
        3_000
      );
    });
  }

  /** Adds missing stock skills, and REFRESHES stock skills whose shipped code
   *  changed — but never touches a skill the bot rewrote itself (a bot
   *  rewrite clears the `stock` flag in SkillLibrary.upsert). */
  private seedStockSkills(villager: Villager): void {
    for (const stock of STOCK_SKILLS) {
      const existing = villager.skills.get(stock.name);
      if (existing && (!existing.stock || existing.code === stock.code)) continue;
      villager.skills.upsert({
        name: stock.name,
        kind: stock.kind,
        description: stock.description,
        code: stock.code,
        stock: true,
      });
      if (existing) {
        log('info', `[village] ${villager.name} stock skill '${stock.name}' refreshed to shipped version`);
      }
    }
  }

  /** Host-level subscriptions (once per villager, live on the bus, survive reconnects). */
  private subscribeHostEvents(villager: Villager): void {
    villager.bus.subscribe('::host', 'job-done', (e) => {
      if (e.futile) {
        // The routine "succeeded" while achieving nothing, repeatedly — that
        // is an error in disguise. Route it through the error kind so the
        // failure memo + plan escalation apply, and demand a change of
        // approach instead of a restart of the same loop.
        this.ctx.scheduler.request(
          villager.name,
          'error',
          `job '${e.job}' keeps finishing with ZERO progress${e.outcome ? ` (${e.outcome})` : ''} — the current approach does not work HERE. Change something NOW: work somewhere else (go_to a new area first), target a different resource, or rewrite the skill (write_skill). Restarting the same job in the same spot is the one wrong answer.`
        );
        return;
      }
      this.ctx.scheduler.request(villager.name, 'job', `job '${e.job}' finished${e.outcome ? ` — ${e.outcome}` : ''} — decide what's next`);
    });
    // No job-failed subscription here ON PURPOSE: RoutineRunner owns the
    // failure wake-up ('error' for real failures, 'job' for benign
    // preemptions). Requesting again here used to double the LLM calls per
    // failure — same incident, two deliberations.
  }

  private guessAttacker(villager: Villager, bot: Bot): ReturnType<typeof describeEntity> | null {
    let best: ReturnType<typeof describeEntity> | null = null;
    let bestDistance = Infinity;
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity) continue;
      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > ATTACKER_SEARCH_RADIUS) continue;
      const info = describeEntity(bot, entity, this.ctx.villagerNames);
      if (info.kind !== 'hostile' && info.kind !== 'player' && info.kind !== 'villager') continue;
      // Prefer hostiles strongly; among equals, prefer the closest.
      const weighted = info.kind === 'hostile' ? distance : distance + 10;
      if (weighted < bestDistance) {
        bestDistance = weighted;
        best = { ...info, distance: Math.round(distance * 10) / 10 };
      }
    }
    return best;
  }

  // -- chat routing -------------------------------------------------------------

  private handleChat(villagerName: string, username: string, message: string): void {
    const villager = this.ctx.villagers.get(villagerName);
    if (!villager) return;
    // Critical echo guard: villager↔villager speech routes in-process; their
    // mirrored chat lines must never be re-ingested as new input.
    if (this.ctx.villagerNames.has(username)) return;

    const bot = villager.bot();
    if (!bot) return;
    const playerEntity = bot.players[username]?.entity;
    const mentionsMe = message.toLowerCase().includes(villagerName.toLowerCase());
    if (playerEntity) {
      if (bot.entity.position.distanceTo(playerEntity.position) > this.ctx.settings.earshotRadius) return;
    } else if (!mentionsMe) {
      // Player not visible and not talking about me — global chat noise.
      return;
    }

    const outcome = villager.bus.emit({ type: 'player-chat', from: username, text: message }, `chat:${username}`, 1_000);
    if (outcome !== 'rate-limited') {
      villager.memory.append('social', `${username} (joueur) a dit: ${message.slice(0, 200)}`, [username]);
    }
    if (mentionsMe) {
      this.ctx.scheduler.request(villager.name, 'player', `le joueur ${username} m'a parlé: "${message.slice(0, 200)}"`);
    }
  }

  // -- shared scan loop (hostiles, night transitions) -----------------------------

  private scanTick(): void {
    for (const villager of this.ctx.villagers.values()) {
      const bot = villager.bot();
      if (!bot?.entity) continue;

      // Food-production benchmark: inventory delta vs last tick (pure reads).
      benchmark.tick(villager.name, bot);

      // Hostiles entering awareness radius (per-entity cooldown via rate key).
      if (villager.bus.subscriberCount('entity-spotted') > 0) {
        for (const entity of Object.values(bot.entities)) {
          if (!entity || entity === bot.entity) continue;
          const distance = bot.entity.position.distanceTo(entity.position);
          if (distance > HOSTILE_SCAN_RADIUS) continue;
          const info = describeEntity(bot, entity, this.ctx.villagerNames);
          if (info.kind !== 'hostile') continue;
          villager.bus.emit(
            { type: 'entity-spotted', entity: { ...info, distance: Math.round(distance * 10) / 10 } },
            `spot:${info.id}`,
            30_000
          );
        }
      }

      // Day ↔ night transitions.
      const isNight = bot.time.timeOfDay >= 13_000 && bot.time.timeOfDay < 23_000;
      const was = this.wasNight.get(villager.name) ?? isNight;
      if (isNight && !was) {
        villager.bus.emit({ type: 'night-falls' }, 'night', 60_000);
      } else if (!isNight && was) {
        villager.bus.emit({ type: 'new-day' }, 'new-day', 60_000);
      }
      this.wasNight.set(villager.name, isNight);

      // Anti-drowning: surface when idle and in water (see floatTick).
      this.floatTick(villager, bot);

      // Daily rhythm: needs decay, dawn plan requests, slot execution (M11).
      this.ctx.rhythm.tick(villager);
    }
  }

  /**
   * Keep an IDLE bot from drowning. The pathfinder Movements tuning routes
   * around water, but a bot can still end up in it (knocked in, spawned over a
   * pond, an interrupted path). When the bot is in water and NOT busy with a
   * routine, deliberation-driven navigation, or a conversation, hold 'jump' so
   * mineflayer's physics swims it up to the surface; release it the moment it's
   * back on dry land so we don't leave it hopping in place.
   *
   * We deliberately skip this while a routine is running or the pathfinder has
   * an active goal: those own the bot's controls via the action chain, and
   * stomping 'jump' under them would fight their movement. A reflex/routine that
   * truly needs to cross water is its own (rare) business.
   */
  private floatTick(villager: Villager, bot: Bot): void {
    // `isInWater` is a runtime flag maintained by mineflayer's physics plugin;
    // it isn't in the typed Entity surface, hence the narrow cast.
    const inWater = (bot.entity as { isInWater?: boolean }).isInWater === true;
    const busy =
      !!villager.routines.status() ||
      !!bot.pathfinder?.goal ||
      !!this.ctx.conversations.get(villager.name);

    if (inWater && !busy) {
      if (!this.floating.has(villager.name)) {
        this.floating.add(villager.name);
        villager.memory.append('system', 'je suis tombé dans l\'eau — je remonte', undefined, 3);
      }
      try {
        bot.setControlState('jump', true);
      } catch { /* best-effort */ }
      return;
    }

    // Out of water (or now busy): drop the jump we were holding.
    if (this.floating.has(villager.name)) {
      this.floating.delete(villager.name);
      try {
        bot.setControlState('jump', false);
      } catch { /* best-effort */ }
    }
  }

  // -- heartbeats ---------------------------------------------------------------

  private scheduleHeartbeat(villager: Villager, first: boolean): void {
    if (this.stopping) return;
    const base = this.ctx.settings.heartbeatSeconds * 1_000;
    // First beat lands somewhere in the first interval (staggers the village);
    // later beats jitter ±25% so bots never sync up.
    const delay = first ? base * (0.3 + Math.random() * 0.7) : base * (0.75 + Math.random() * 0.5);
    const timer = setTimeout(() => {
      if (this.stopping) return;
      if (villager.bot() && !villager.routines.status() && !this.ctx.conversations.get(villager.name)) {
        this.ctx.scheduler.request(villager.name, 'heartbeat', 'periodic reflection: check surroundings, plan, work, socialize or trade');
      }
      this.scheduleHeartbeat(villager, false);
    }, delay);
    timer.unref?.();
    this.heartbeatTimers.set(villager.name, timer);
  }
}
