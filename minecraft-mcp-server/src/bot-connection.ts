import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';

// Plugins loaded post-spawn. CJS-export shapes vary per the upstream packages
// — and this matters because two different ESM loaders run this code (tsx
// under `npm run unified` in production AND tsx under ava when tests load it).
//
// The three TS-compiled packages (pvp / collectblock / tool) ship CJS with
// `Object.defineProperty(exports, "__esModule", { value: true })` set and a
// named `exports.plugin` — no `exports.default`. Named imports work in both
// loaders; a default-then-destructure works in production but lands `undefined`
// under ava-tsx (which strictly honours the __esModule flag and refuses to
// synthesise a default). Lesson: prefer named imports for any package whose
// compiled output sets `__esModule: true` without a real `default` export.
//
// auto-eat is native ESM (`"type": "module"`) with a named `loader` export.
// armor-manager is plain CJS (`module.exports = inject`, no __esModule flag);
// the default-import shape works there via esModuleInterop's synthesis.
import { plugin as pvp } from 'mineflayer-pvp';
import { loader as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { plugin as tool } from 'mineflayer-tool';

const SUPPORTED_MINECRAFT_VERSION = '1.21.1';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  /** Mineflayer viewDistance ('far'|'normal'|'short'|'tiny' or a chunk radius).
   *  The village host passes 'tiny' — big memory saver across 10 bots. */
  viewDistance?: 'far' | 'normal' | 'short' | 'tiny' | number;
  /** Default true (legacy behaviour). The village host sets false so ten bots
   *  don't announce themselves in chat on every (re)spawn. */
  announceOnSpawn?: boolean;
  /** If true, automatically call attemptReconnect() when the bot disconnects.
   *  Used by the village BotHost; disabled (default) for the God's unified bot. */
  reconnectOnDisconnect?: boolean;
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
  /** Fired after every successful spawn (including reconnects), once plugins
   *  are loaded. The village host re-wires per-bot event listeners here. */
  onSpawn?: (bot: mineflayer.Bot) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;
  /** Consecutive reconnect attempts without a successful spawn — drives the
   *  exponential backoff so a down server isn't hammered every 2 s forever. */
  private reconnectAttempts = 0;
  private stopped = false;

  private static readonly RECONNECT_BACKOFF_MAX_MS = 60_000;

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      plugins: { pathfinder },
      // Client-side keepalive timeout (default 30s). Our dev server stalls its
      // main thread now and then ("Can't keep up!"), stopping keep_alives for
      // long stretches — with the default every bot in the process drops at
      // once ("client timed out after 30000 milliseconds" / keepAliveError).
      // FAQ-blessed mitigation: give it more rope and let reconnect handle
      // genuine outages.
      checkTimeoutInterval: 90_000,
      ...(this.config.viewDistance !== undefined ? { viewDistance: this.config.viewDistance } : {}),
    };

    this.bot = mineflayer.createBot(botOptions);
    this.state = 'connecting';
    this.isReconnecting = false;

    this.registerEventHandlers(this.bot);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    bot.once('spawn', async () => {
      this.state = 'connected';
      this.reconnectAttempts = 0; // healthy again — reset the backoff
      this.callbacks.onLog('info', 'Bot spawned in world');

      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      // ---- Land-only peasant movement tuning -------------------------------
      // The pathfinder's default Movements is built for a survival player who
      // happily swims, parkours and free-falls. Village peasants are dumb land
      // bots: they keep drowning, leaping off cliffs and getting stuck in
      // liquids. Every knob below pushes the A* cost model toward "stay on
      // solid ground, walk around hazards."
      //
      // Block ids resolve via mcData; some optional blocks are guarded with
      // `?.` because not every block name exists across versions (it does in
      // 1.21.1, but the guard keeps a version bump from crashing spawn).
      const idOf = (name: string): number | undefined => mcData.blocksByName[name]?.id;

      // 1) Water: mark it UNSAFE so the pathfinder refuses to step into it and
      //    routes around water bodies. In 1.21.1 source + flowing water share
      //    the single 'water' block id, so one add() covers both. lava is in
      //    blocksToAvoid by default; confirm + re-add defensively.
      const waterId = idOf('water');
      const lavaId = idOf('lava');
      if (waterId !== undefined) defaultMove.blocksToAvoid.add(waterId);
      if (lavaId !== undefined) defaultMove.blocksToAvoid.add(lavaId);

      // 2) Remove water from `replaceables` — otherwise the pathfinder treats a
      //    water column as a valid standing position it can "replace" / stand
      //    in, which is exactly how bots end up bobbing in the sea. (lava stays
      //    in replaceables as upstream ships it; blocksToAvoid already bars it.)
      if (waterId !== undefined) defaultMove.replaceables.delete(waterId);

      // 3) Extra hazards: cactus and magma_block hurt on contact. Add them when
      //    the id exists. (fire/cobweb/lava are already in the default set.)
      for (const hazard of ['cactus', 'magma_block', 'sweet_berry_bush', 'powder_snow']) {
        const id = idOf(hazard);
        if (id !== undefined) defaultMove.blocksToAvoid.add(id);
      }

      // 4) No parkour, no big drops — peasants should never leap a gap or jump
      //    off a cliff. maxDropDown 2 (default 4) caps how far the planner will
      //    let a bot fall in a single step.
      defaultMove.allowParkour = false;
      defaultMove.maxDropDown = 2;

      // 5) Keep sprinting (they need to cover ground at a reasonable pace).
      defaultMove.allowSprinting = true;

      // 6) Belt-and-suspenders: a huge liquidCost so that even if some
      //    liquid-adjacent move slips past blocksToAvoid, A* picks the dry
      //    detour every time.
      defaultMove.liquidCost = 100;

      bot.pathfinder.setMovements(defaultMove);

      // ---- Pathfinder compute bounds ---------------------------------------
      // Defaults are thinkTimeout=5000, tickTimeout=40, searchRadius=-1
      // (UNBOUNDED). With canDig on, an unreachable/unloaded goal makes A*
      // expand the entire loaded volume: each reset (block update, chunk load
      // next to the search, "stuck") grants a fresh 5 s budget, so one goto
      // burns 14-60 s before "Took to long to decide path to goal!". Bound the
      // search so hopeless goals fail in ~2 s, and shrink the per-tick compute
      // slice so N bots in one process don't starve the event loop.
      bot.pathfinder.thinkTimeout = 2_000;
      bot.pathfinder.tickTimeout = 10;
      bot.pathfinder.searchRadius = 64;

      // Load post-spawn plugins. Each one is best-effort: if any single plugin
      // throws on load we log and keep going rather than killing the spawn —
      // a missing pvp module shouldn't take the whole bot offline.
      try {
        bot.loadPlugin(pvp);
        bot.loadPlugin(armorManager);
        bot.loadPlugin(tool);
        bot.loadPlugin(collectBlock);
        bot.loadPlugin(autoEat);

        // auto-eat needs explicit activation; the loader only wires the class.
        // setOpts values are the README defaults restated here so the intent is
        // visible in code (so future readers don't wonder if we're depending on
        // an implicit default that might shift). The two that actually matter
        // for our god-avatar use case:
        //   - returnToLastItem: true  → after eating, swap the previously-held
        //     item back into the main hand so combat tools aren't lost.
        //   - bannedFood includes poisonous_potato/pufferfish/etc → don't poison
        //     the bot while trying to keep it alive.
        bot.autoEat.setOpts({
          priority: 'foodPoints',
          minHunger: 15,
          minHealth: 14,
          bannedFood: ['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye'],
          returnToLastItem: true,
          offhand: false,
          eatingTimeout: 3000,
        });
        bot.autoEat.enableAuto();

        this.callbacks.onLog('info', 'Loaded plugins: pvp, armor-manager, tool, collectblock, auto-eat');
      } catch (err) {
        this.callbacks.onLog('warn', `Plugin load partially failed: ${this.formatError(err)} — bot will continue with whatever loaded successfully`);
      }

      if (this.config.announceOnSpawn !== false) {
        bot.chat('LLM-powered bot ready to receive instructions!');
      }
      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);

      try {
        this.callbacks.onSpawn?.(bot);
      } catch (err) {
        this.callbacks.onLog('warn', `onSpawn callback threw: ${this.formatError(err)}`);
      }
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('kicked', (reason) => {
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.formatError(reason)}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.callbacks.onLog('error', `Bot error [${errorCode}]: ${errorMsg}`);

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      if (this.state === 'connected') {
        this.state = 'disconnected';
      }

      if (this.bot === bot) {
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch (err) {
          this.callbacks.onLog('warn', `Error cleaning up bot on end event: ${this.formatError(err)}`);
        }
      }

      if (this.config.reconnectOnDisconnect && !this.stopped) {
        this.attemptReconnect();
      }
    });
  }

  attemptReconnect(): void {
    if (this.isReconnecting || this.state === 'connecting') {
      return;
    }

    this.isReconnecting = true;
    this.state = 'connecting';
    // Exponential backoff (2s, 4s, 8s … capped at 60s): a server that is down
    // for a while gets probed gently instead of three bots hammering it (and
    // spamming ECONNREFUSED rejections) every 2 seconds forever.
    const delayMs = Math.min(
      this.reconnectDelayMs * 2 ** this.reconnectAttempts,
      BotConnection.RECONNECT_BACKOFF_MAX_MS
    );
    this.reconnectAttempts++;
    this.callbacks.onLog(
      'info',
      `Attempting to reconnect to Minecraft server in ${delayMs}ms (attempt ${this.reconnectAttempts})...`
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.bot) {
        try {
          this.bot.removeAllListeners();
          this.bot.quit('Reconnecting...');
          this.callbacks.onLog('info', 'Old bot instance cleaned up');
        } catch (err) {
          this.callbacks.onLog('warn', `Error while cleaning up old bot: ${this.formatError(err)}`);
        }
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, delayMs);
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    const currentState = this.state;

    if (currentState === 'disconnected') {
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is compatible (latest supported: ${SUPPORTED_MINECRAFT_VERSION})\n\n` +
        `For setup instructions, visit: https://github.com/yuniko-software/minecraft-mcp-server`;

      return { connected: false, message: errorMessage };
    }

    if (currentState === 'connecting') {
      return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    }

    return { connected: true };
  }

  cleanup(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.bot) {
      try {
        this.bot.quit('Server shutting down');
      } catch (err) {
        this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(err)}`);
      }
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
