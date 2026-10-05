// EdenHost — the ONLY composition root (08). It imports everything and wires it with
// plain constructor arguments (no singletons, no DI container). M0 brings up the spine:
// config -> journal -> lag monitor -> admin, and journals system.boot. Bots (M1), the
// skill engine (M2), and God (M3+) are wired in here as their milestones land.

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { loadConfig, assertIdentity, type EdenConfig } from './config';
import { loadEnvFile, loadProviders, resolveProvider } from './providers';
import { loadScenario, applyScenario } from './scenario-loader';
import { logger } from './logger';
import { Journal, type JournalAppender } from './journal/journal';
import { JOURNAL_KINDS } from './journal/kinds';
import { createLagMonitor, type LagMonitor } from './journal/lag-monitor';
import { BotPool } from './bots/pool';
import { AnchorService, type Anchors } from './bots/anchors';
import { AdminServer } from './admin/server';
import { VillageLauncher } from './village-launch';
import { SkillLibrary, AllGranted, renderSignature } from './skills/library';
import { SkillEngine } from './skills/engine';
import { SkillRetriever } from './skills/retrieve';
import { STOCK_SKILLS, seedStockSkills } from './skills/exemplars/index';
import { DescriptionPass } from './skills/describe';
import { LlmClient, ProviderRegistry } from './llm/client';
import { LlmScheduler, BudgetTracker } from './llm/scheduler';
import { EmbeddingsService, localBackend } from './llm/embeddings';
import { ToolRegistry } from './villagers/tools';
import { ContextPackBuilder, type ContextPackInput } from './villagers/context-pack';
import { Brain } from './villagers/brain';
import { VillagerInbox } from './villagers/inbox';
import { SubscriptionStore, type FilterContext } from './villagers/subscriptions';
import { loadRoles, resetRoleDefaults, seedRoleDefaults, upgradeRoleDefaults } from './villagers/role-defaults';
import { VillagerReactivity } from './villagers/reactivity';
import { DriveTracker, type DriveKind, type DriveSnapshot } from './villagers/drives';
import type { WakeupRequest } from './villagers/events';
import { GodService, serializeGodState, hydrateGodState, type GodStateSnapshot } from './god/god';
import { Curriculum, loadCurriculumPrompt, type CurriculumTrigger } from './god/curriculum';
import { Orchestrator, loadOrchestratorPrompt, type DispatchTrigger } from './god/orchestrator';
import { CriticDesk, loadCriticPrompt } from './god/critic';
import { GodBody } from './god/body';
import { VillagerMemory } from './villagers/memory';
import { MemorySummarizer } from './villagers/memory-summarizer';
import { SettlementClient, TradeBook, type ReachStrategy, type TradeOffer } from './social/trade';
import { ConversationBook, chatSafe } from './social/conversation';
import { ConversationTurner } from './villagers/conversation-turn';
import {
  SkillStatsView,
  CompetenceView,
  RelationsView,
  TradeLedgerView,
  RolloutsView,
} from './views/index';
import type { Bot, Conversant, Inbox, InboxMessage, JournalEvent, MemoryWriter, RunReport, Snapshot, SkillStats, Task, TaskLedger, Vec3Like, Verdict } from './types/index';

/** Options for {@link start}. */
export interface EdenHostOptions {
  /** Where the SQLite journal + per-bot state live. Default '.eden-data'. */
  dataDir?: string;
  /**
   * Connect the bot pool to Minecraft (M1). Default FALSE — CI/tests never touch a server. A real
   * boot (the direct-run entrypoint) sets this true; the spawn is fired without blocking host startup.
   */
  spawnBots?: boolean;
  /**
   * Connect the bots AT BOOT instead of waiting for the in-game `/villagers start` (R53, option C).
   * Default FALSE — a real interactive boot DEFERS the spawn so the avatar never auto-logs-in and can't
   * collide with itself; the in-game command triggers the staggered login. Programmatic drivers that
   * boot-then-act (the live-test harness) set this true so the roster connects without an admin POST.
   * No-op when there's no pool (bare boot / `spawnBots` false).
   */
  autoSpawn?: boolean;
  /**
   * Wire God's desks + the refinement loop (M4-3) and run boot rollout-recovery (step 7). Default =
   * `spawnBots` (God needs a live world + a real LLM provider to act; CI/tests drive the coordinator
   * directly with fakes, so the M0 spine stays a no-op there).
   */
  enableGod?: boolean;
  /**
   * Blocker Z: install process-level `uncaughtException`/`unhandledRejection` guards that JOURNAL and
   * SURVIVE instead of letting the host die. Default FALSE — a real boot sets it true; CI/tests must
   * NEVER install it (a global handler would swallow test-runner failures). See {@link installProcessGuards}.
   */
  installProcessGuards?: boolean;
  /**
   * Serve the static dashboard ([eden/website](../website)) from the admin server, same-origin with the
   * API (owner #9: the host serves the dashboard, no CORS). Default = `spawnBots` (a real boot serves it;
   * unit tests that call `start()` keep the plain 404-on-unknown-route behavior). A smoke can set it true
   * with bots off to inspect the UI without a Minecraft server.
   */
  serveWeb?: boolean;
}

/** The handle to a running host: the bound admin port, the loaded config, the journal, and `stop`. */
export interface EdenHost {
  readonly adminPort: number;
  readonly config: EdenConfig;
  readonly journal: Journal;
  /** The refinement-loop coordinator (M4-3) — present only when God is wired (a real run). */
  readonly coordinator?: RolloutCoordinator;
  /** The God service — present only when God is wired. Exposed so a direct-boot driver (e.g. a smoke
   *  harness) can inject a task via `god.addTask(...)` before handing it to the coordinator. */
  readonly god?: GodService;
  /** The villager tool registry — present only when God is wired. Exposed so a driver (and the wiring
   *  tests, R69) can dispatch a tool exactly as a deliberation would, through the composition root. */
  readonly tools?: ToolRegistry;
  stop(): Promise<void>;
}

/**
 * Boot the M0 spine from a config file: load+validate config, open the journal, replay each
 * config warning as a log line and a `system.config-warning` event, arm the lag canary, start
 * the admin server, then journal `system.boot` (last — its presence means a complete boot).
 */
export async function start(configPath: string, opts: EdenHostOptions = {}): Promise<EdenHost> {
  const dataDir = opts.dataDir ?? '.eden-data';

  // 1. Load + validate config; collect warnings (config.ts can't print — the law).
  const warnings: string[] = [];
  let config = loadConfig(configPath, (w) => warnings.push(w));

  // 1a. Resolve the named provider → patch llm.providers + apiKeyEnv (new-style config).
  //     Falls back to the default empty-string providers when "provider" is absent (eval/test mode).
  if (config.provider) {
    // Load eden/api-keys.env into process.env BEFORE any key is read (existing env wins). Without this
    // the production host never read the file the live-test harness does, so a configured provider whose
    // key var was unset silently fell back to OPENAI_API_KEY (R56).
    loadEnvFile(resolve(configPath, '..', 'api-keys.env'));
    const providersPath = resolve(configPath, '..', 'providers.json');
    const presets = loadProviders(providersPath);
    const preset = resolveProvider(presets, config.provider);
    config = {
      ...config,
      llm: { ...config.llm, providers: { strong: preset.strong, fast: preset.fast } },
      apiKeyEnv: preset.apiKeyEnv ?? undefined,
    };
  }

  // 1b. Resolve the named scenario → populate villagers + god overrides (new-style config).
  //     Falls back to the villagers array parsed directly from eden.json (legacy/test mode).
  if (config.scenario) {
    const scenarioPath = resolve(configPath, '..', 'scenarios', `${config.scenario}.json`);
    config = applyScenario(config, loadScenario(scenarioPath));
    // R12: the scenario just replaced the roster parseConfig validated (it saw the empty pre-scenario
    // array). Re-check identity so a scenario villager named "Dieu" / a duplicate refuses to boot here,
    // rather than silently colliding and being kicked at login.
    assertIdentity(config.villagers, config.god.name);
  }

  // 2. Open the journal (sole writer). Replay nothing — current state lives in its tables.
  mkdirSync(dataDir, { recursive: true });
  const journal = new Journal(join(dataDir, 'eden.db'));
  for (const w of warnings) {
    logger.warn('config', w);
    journal.append('engine', 'system.config-warning', { message: w });
  }

  // The event-loop lag monitor is the backpressure canary (D-07).
  const lag: LagMonitor = createLagMonitor(journal);
  lag.start();

  // Blocker Z: a rogue skill can throw ASYNCHRONOUSLY from mineflayer's physics timer (e.g. a bad
  // pathfinder goal → `stateGoal.isValid is not a function`), which escapes the per-run try/catch and
  // would otherwise crash the whole host. Install last-resort process guards that journal + survive.
  // Opt-in (a real boot sets it) so CI/tests — which call start() — never install a global handler.
  let removeProcessGuards: (() => void) | undefined;
  if (opts.installProcessGuards) removeProcessGuards = installProcessGuards(journal);

  // Derived views (views/, LAYER 1) — fold the journal LIVE off its subscribe stream (P4/S2: derived
  // state, never primary). The admin + website read these; `eden rebuild-stats` rebuilds them by replay
  // and MUST equal this live fold. Subscribing them here means the host renders the same facts it acted
  // on. (A view fold never throws into the writer — the journal's fan() swallows consumer errors.)
  const views = {
    skillStats: new SkillStatsView(),
    competence: new CompetenceView(),
    relations: new RelationsView(),
    tradeLedger: new TradeLedgerView(),
    rollouts: new RolloutsView(),
  };
  // B3.9 (bug #15): replay the history first, so a restart does not forget every stat (the result must equal the
  // live fold — `npm run rebuild-stats` is the same replay), THEN fold new events live.
  // ONE scan, and without `vitals` (the bulk of a long journal: a row per bot every 10 s, folded by no view and
  // never tagged with a rolloutId).
  replayViews(journal, Object.values(views));
  journal.subscribe((e) => {
    views.skillStats.fold(e);
    views.competence.fold(e);
    views.relations.fold(e);
    views.tradeLedger.fold(e);
    views.rollouts.fold(e);
  });

  // M5 reactivity attaches per-villager when each bot spawns (and re-attaches on reconnect). It's built
  // by wireGod (it needs the engine + brain), so the pool's spawn hook — created BEFORE wireGod runs —
  // reads it through this late-bound ref, set before pool.start() is ever kicked (the staggered login is
  // the LAST thing start() does, well after the ref is populated).
  const reactivityRef: { current?: VillagerReactivity } = {};
  // Late-bound so the pool's spawn hook (built below) can reach the launcher (built after the pool).
  const launcherRef: { current?: VillageLauncher } = {};

  // B3.6 (R18): each villager's home/chest anchors are DISCOVERED in the live world — healed a few seconds after
  // spawn (once the launcher's /spreadplayers has placed the body), persisted in bots/<name>.json and reused on
  // later boots. The go-home reflex reads `$home.*` from them. A disconnected bot is skipped.
  const anchorService = new AnchorService(dataDir);
  const anchors = new Map<string, Anchors>();
  const villagerSet = new Set(config.villagers.map((v) => v.name));
  const healAnchors = (name: string, bot: Bot): void => {
    if (!villagerSet.has(name)) return;
    const t = setTimeout(() => {
      try {
        if (pool?.bot(name) !== bot) return; // reconnected or gone since — the next spawn heals again
        anchors.set(name, anchorService.heal(name, bot, {}));
      } catch (e) {
        logger.warn('anchors', `${name}: anchor heal failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }, ANCHOR_SETTLE_MS);
    t.unref();
  };

  // The bot pool (M1) — the SINGLE pool (villagers + avatar) God is wired to. Built only when there's a
  // roster to embody: a bare boot (no scenario, no villagers) builds NO pool, so the avatar never
  // auto-logs-in (R12/R53 — option C). The spawn itself is DEFERRED to the in-game `/villagers start`
  // (the launcher), never kicked at boot.
  const pool = opts.spawnBots && config.villagers.length > 0
    ? new BotPool({
        journal,
        host: config.minecraft.host,
        port: config.minecraft.port,
        version: config.minecraft.version,
        villagers: config.villagers.map((v) => ({ name: v.name, role: v.role })),
        avatarName: config.god.name,
        dataDir,
        worldId: `${config.minecraft.host}:${config.minecraft.port}`,
        vitalsIntervalMs: config.journal.vitalsIntervalSeconds * 1000,
        // Per (re)spawn: re-attach reactivity (reconnect-safe) AND fire the launcher's positioning/loadout
        // (once per start). The avatar attaches reactivity too; the launcher filters it out of setup.
        onBotSpawn: (name, bot) => {
          reactivityRef.current?.attach(name, bot);
          launcherRef.current?.onSpawn(name, bot);
          healAnchors(name, bot);
        },
      })
    : undefined;

  // God's desks + the refinement loop (M4-3). Wired only for a real run (needs a live world + provider).
  const enableGod = opts.enableGod ?? opts.spawnBots ?? false;
  const wiring = enableGod ? wireGod({ config, journal, dataDir, pool, homeOf: (name) => anchors.get(name)?.home }) : undefined;
  const reactivity = wiring?.reactivity;
  reactivityRef.current = reactivity; // hand the live reactivity to the (already-built) pool spawn hook

  // M5: pump the coarse 30 s clock (tick-30s) across every attached router. Unref'd so it never holds the
  // loop open; a no-op when reactivity is unwired (CI / no live bots). The emitter-side hysteresis clocks
  // (health-low/night) are signal-driven; only the polling tick-30s subscriptions need this pump.
  const reactivityTick = reactivity
    ? setInterval(() => {
        reactivity.tick();
        wiring?.drives?.tick(); // B3.7: the drives decay on the same coarse clock
      }, 30_000)
    : undefined;
  reactivityTick?.unref();

  // 7. D-09 rollout recovery (boot-abandon). GodService.recoverRollouts(): every open task whose
  //    currentRolloutId is still set has its rollout journaled god.rollout-abandoned + re-enqueued with
  //    fresh maxRetries (orphan drafts stay harmless `draft`s). The re-enqueue now flows through the real
  //    ledger writer (Curriculum, S2) → the coordinator re-assigns it (M4-3). No-op when God is off.
  // B3.9 (bug #15): God's working state (ledger, dossiers, rollouts, directives, QA cache) used to live in RAM
  // only. Restore the last snapshot BEFORE D-09 recovery — that is what gives recovery something to recover —
  // and keep saving it after every god.* journal event.
  const persister = wiring ? persistGodState({ journal, wiring, worldId: `${config.minecraft.host}:${config.minecraft.port}` }) : undefined;
  if (wiring) {
    const recovered = wiring.god.recoverRollouts();
    if (recovered > 0) logger.info('god', `boot recovery: re-enqueued ${recovered} abandoned rollout(s) (D-09)`);
  }

  // VillageLauncher — the in-game /villagers start|stop|restart control (POST /scenario/*). It drives the
  // SAME boot pool God is wired to (option C: scenario loaded at boot), so there is no second pool and no
  // duplicate avatar (R53). Lives at the src/ root (pure consumer). Journal-before-act is the admin route's
  // responsibility (05). Handed to the pool's spawn hook via launcherRef (built above).
  const launcher = new VillageLauncher({
    pool,
    villagers: config.villagers,
    avatarName: config.god.name,
    scenarioName: config.scenario,
    dataDir,
    journal,
    ...(wiring
      ? {
          resetVillager: (name: string) => {
            wiring.memories.get(name)?.reset();
            wiring.store.removeSelfAuthored(name);
            // A fresh life gets every current role default back, including any it had unsubscribed (review fix).
            const role = config.villagers.find((v) => v.name === name)?.role ?? 'villager';
            resetRoleDefaults(wiring.store, name, role, loadRoles());
          },
        }
      : {}),
  });
  launcherRef.current = launcher;

  // The autonomous refinement-loop driver (the production PUMP). wireGod builds the RolloutCoordinator but
  // nothing in the interactive boot path ever called it — the live-test harness + the M3 GATE test were the
  // only drivers, so a real `/villagers start` connected the bots and then sat idle (no curriculum task →
  // no directive → no deliberation → zero LLM calls). VillageLoop runs one loop per villager that proposes +
  // runs tasks at the curriculum's own pace, bounded downstream by the LLM scheduler (maxConcurrent) and
  // per-bot serialization in the engine (D-05). It is tied to the launcher lifecycle below — NOT to
  // `autoSpawn` (the live-test harness drives the coordinator itself, so it must stay un-pumped there).
  const villageLoop = wiring && pool
    ? new VillageLoop({
        coordinator: wiring.coordinator,
        villagers: config.villagers.map((v) => v.name),
        isConnected: (name) => pool.bot(name) !== undefined,
      })
    : undefined;

  // 8. Admin server (the COMPLETE consumer surface, 05): read API + WS stream + the mutating POST verbs.
  //    All data accessors read derived views / live God state / the library (admin holds no concrete
  //    subsystem — narrow accessor functions only). When God is off (CI/host-readiness) the GET routes
  //    return derived-from-journal or empty, and the control verbs report 503 (unwired) — the spine still
  //    boots and answers. Every mutating verb journals actor:'admin'|player:<name> BEFORE acting (05).
  const startedAt = Date.now();
  // Same-origin static dashboard (owner #9). Default = real boot; a smoke can force it on with bots off.
  const serveWeb = opts.serveWeb ?? opts.spawnBots ?? false;
  const webRoot = serveWeb ? fileURLToPath(new URL('../website/', import.meta.url)) : undefined;

  // Normalize a folded SkillStats into the dashboard's stat shape (it reads `avg_ms`, never the inner mean).
  const dashStats = (s: SkillStats | undefined): Record<string, number> =>
    s
      ? { runs: s.runs, successes: s.successes, failures: s.failures, stalls: s.stalls, avg_ms: Math.round(s.avgMs) }
      : { runs: 0, successes: 0, failures: 0, stalls: 0, avg_ms: 0 };
  // Villagers who have a recorded run of a skill (CompetenceView fold) — the dashboard's `usedBy`.
  const usedBy = (skill: string): string[] =>
    Object.entries(views.competence.value())
      .filter(([, m]) => (m[skill]?.runs ?? 0) > 0)
      .map(([villager]) => villager);

  const admin = new AdminServer({
    port: config.admin.port,
    journal,
    startedAt,
    webRoot,
    getStatus: () => ({
      // The dashboard's mission-control shape. Budget is token-only internally (no dollar ledger), so the
      // spend panel reads zero until a real cost view exists — an honest API gap, not a fabricated number.
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      botsConnected: pool?.connectedCount() ?? 0,
      totalBots: config.villagers.length + 1, // villagers + the avatar (Dieu) — what connectedCount reaches
      currentRuns: 0,
      queueDepth: wiring?.scheduler.pending() ?? 0,
      paused: wiring?.scheduler.isPaused() ?? false,
      budgetSpend: 0,
      budgetCap: 0,
      budgetHistory: [],
    }),
    villagers: () => config.villagers.map((v) => villagerSummary(v.name, v.role, wiring, journal)),
    villager: (name) =>
      config.villagers.some((v) => v.name === name)
        ? villagerSummary(name, config.villagers.find((v) => v.name === name)!.role, wiring, journal)
        : undefined,
    skills: () =>
      (wiring?.library.liveSkills() ?? []).map((s) => ({
        name: s.manifest.name,
        version: s.version.version,
        status: s.version.status,
        tier: s.manifest.tier,
        tags: s.manifest.tags,
        signature: s.manifest.signature,
        description: s.manifest.description,
        stats: dashStats(views.skillStats.value()[s.manifest.name]),
        history: [], // success-rate sparkline is synthetic in the mock; honestly empty here
        versionsCount: wiring?.library.versionCount(s.manifest.name) ?? 1,
        usedBy: usedBy(s.manifest.name),
      })),
    skill: (name, o) => {
      const resolved = wiring?.library.read(name, o.version);
      if (!resolved) return undefined;
      const versions = (wiring?.library.history(name) ?? []).map((h) => ({
        version: h.version.version,
        status: h.version.status,
        note: h.manifest.summary,
        runs: 0, // per-version run counts are not folded; stats below are the skill-wide rollup
        score: '—',
        admittedBy: h.version.provenance?.rolloutId ?? null,
        ...(o.code ? { code: h.code } : {}),
      }));
      const base: Record<string, unknown> = {
        name: resolved.manifest.name,
        version: resolved.version.version,
        status: resolved.version.status,
        tier: resolved.manifest.tier,
        signature: resolved.manifest.signature,
        description: resolved.manifest.description,
        tags: resolved.manifest.tags,
        stats: dashStats(views.skillStats.value()[name]),
        history: [],
        usedBy: usedBy(name),
        versions,
      };
      // Quarantine details from the latest skill.quarantine record (reason/at/by) — when this version is held.
      if (resolved.version.status === 'quarantined') {
        const qev = journal.query({ kinds: ['skill.quarantine'], ref: name, limit: 1, order: 'desc' })[0];
        if (qev) base['quarantine'] = { reason: (qev.payload as { reason?: string }).reason ?? '', at: qev.at, by: qev.actor };
      }
      if (o.version !== undefined) base['requestedVersion'] = o.version;
      if (o.code) base['code'] = resolved.code;
      return base;
    },
    tasks: () => mapLedgerForDashboard(wiring?.god.state.ledger),
    // Flatten god.verdict events (payload = ticket judgment; refs carry skill/version/rollout) into the
    // verdict-row shape the dashboard renders. Newest-first for the live verdict stream.
    verdicts: () =>
      journal.query({ kinds: ['god.verdict'], limit: 200, order: 'desc' }).map((e) => {
        const p = e.payload as { success?: boolean; score?: number; libraryAction?: string; critique?: string };
        return {
          id: e.id,
          skill: e.refs.skill ?? '?',
          version: e.refs.skillVersion ?? '',
          success: !!p.success,
          score: typeof p.score === 'number' ? p.score : 0,
          action: p.libraryAction ?? 'none',
          critique: p.critique ?? '',
          at: e.at,
          rolloutId: e.refs.rolloutId ?? null,
        };
      }),
    directives: () =>
      (wiring?.god.state.directivesOpen ?? []).map((d) => ({
        id: d.id,
        to: Array.isArray(d.to) ? d.to.join(', ') : d.to,
        goal: d.goal,
        reason: d.reason,
        priority: d.priority,
        expiry: d.expiresAt ? new Date(d.expiresAt).toISOString().slice(11, 16) : '—',
        standing: !!d.standing,
      })),
    // The rollout index is a derived view (folds the journal), so it works whether or not God is wired —
    // empty until a rollout's events land. The replay itself stays GET /journal?ref=<rolloutId> (05).
    rollouts: () => views.rollouts.value(),
    // GET /llm/:callId — the full transcript an llm.call dumped to disk (debugPrompts only). Filesystem
    // knowledge lives HERE, not in the admin (S5); the guard rejects anything but a plain id (no traversal).
    llmTranscript: (callId) => readLlmTranscript(dataDir, callId),
    onPause: wiring ? () => wiring.scheduler.pause() : undefined,
    onResume: wiring ? () => wiring.scheduler.resume() : undefined,
    onQuarantine: wiring
      ? (name, reason, actor) => wiring.library.quarantine(name, `admin: ${reason}`, undefined, actor) !== undefined
      : undefined,
    onPrompt: wiring
      ? (name, msg, actor) => {
          const inbox = wiring.inboxes.get(name);
          if (!inbox) return false;
          // The inbox journals inbox.delivered ONCE, as the admin's actor, before delivery (05). The villager
          // hears the tell like any other and deliberates.
          inbox.deliver({ from: 'villager', kind: 'tell', payload: { text: msg.text, from: msg.from }, at: Date.now() }, actor);
          return true;
        }
      : undefined,
    // Start the village, THEN pump the loop (only on a successful connect). Stop pumps DOWN first so no
    // fresh proposal races the disconnect; restart cycles both. The loop's per-villager connect-poll waits
    // out the staggered login, so starting it the instant launcher.start() returns is safe.
    onScenarioStart: async (name, cx, cz) => {
      const r = await launcher.start(name, cx, cz);
      if (r.ok) villageLoop?.start();
      return r;
    },
    onScenarioStop: async () => {
      villageLoop?.stop();
      return launcher.stop();
    },
    scenarioRefusal: (name) => launcher.refusal(name),
    onScenarioRestart: async (name, cx, cz) => {
      villageLoop?.stop();
      const r = await launcher.restart(name, cx, cz);
      if (r.ok) villageLoop?.start();
      return r;
    },
  });
  const { port } = await admin.start();

  journal.append('engine', 'system.boot', { config: redactSecrets(config) as object });
  logger.info('engine', `Eden host up — admin on http://127.0.0.1:${port}`);

  // DEFERRED SPAWN (option C, R53): by default bots are NOT connected at boot. The avatar + villagers log
  // in only on the in-game `/villagers start <scenario>` (→ launcher.start), so the avatar never
  // auto-connects and can never collide with itself. A bare boot has no pool at all. `autoSpawn` opts back
  // into a boot-time staggered login (R13/I1) for programmatic drivers (the live-test harness) that boot
  // then act without an admin POST. It starts the pool BARE (the launcher stays unarmed → onSpawn no-ops),
  // so the driver owns all positioning/loadout via its own RCON arena — no stray /spreadplayers + /give.
  if (pool && opts.autoSpawn) void pool.start();

  return {
    adminPort: port,
    config,
    journal,
    coordinator: wiring?.coordinator,
    god: wiring?.god,
    tools: wiring?.tools,
    async stop() {
      removeProcessGuards?.();
      villageLoop?.stop();
      if (reactivityTick) clearInterval(reactivityTick);
      reactivity?.detach();
      await launcher.stop();
      pool?.stop();
      lag.stop();
      await admin.stop();
      persister?.flush(); // B3.9: the last God snapshot before the database closes
      persister?.stop();
      journal.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// M4-3 — the real refinement loop. Coordinates curriculum → orchestrator → inbox → brain → rollout →
// critic → routeVerdict → revise/close. This touches BOTH god/ and villagers/, so it MUST live at the
// composition root (main.ts) — a layer-3 actor may never import a peer (the dependency law). It replaces
// the M3 GATE's synchronous injection driver with the real assignment path.
// ─────────────────────────────────────────────────────────────────────────────

/** What {@link wireGod} returns: the God service + the refinement-loop coordinator + the live subsystems
 *  the admin reads (library/scheduler/inboxes/memories) — admin holds only narrow accessors over these. */
interface GodWiring {
  god: GodService;
  curriculum: Curriculum;
  orchestrator: Orchestrator;
  coordinator: RolloutCoordinator;
  library: SkillLibrary;
  scheduler: LlmScheduler;
  inboxes: Map<string, Inbox>;
  /** One VillagerMemory per villager (the society layer; admin reads relations/inbox depth from it). */
  memories: Map<string, VillagerMemory>;
  /** The SHARED reactivity store (sole writer of subscription state, S2) — admin reads sub counts from it. */
  store: SubscriptionStore;
  /** The shared villager tool registry (every deliberation dispatches through it). */
  tools: ToolRegistry;
  /** Per-villager reactivity (EventRouter + SubscriptionRouter). Present only with a live bot pool (M5). */
  reactivity?: VillagerReactivity;
  /** B3.7: the optional rest/social drives (behavior.drives, live pool only) — ticked on the 30 s host clock. */
  drives?: Drives;
}

/**
 * Construct God's desks (critic/curriculum/orchestrator), the villager brain, and the refinement-loop
 * coordinator — the M4-3 wiring. Lives at the composition root so god/ and villagers/ stay decoupled.
 * The strong/fast tier split (D-13): curriculum proposal + critic run STRONG (novelty); orchestrator
 * dispatch + QA-cache run FAST. Per-desk budget caps default null (R49 — throughput is the limiter).
 */
function wireGod(args: {
  config: EdenConfig;
  journal: Journal;
  dataDir: string;
  pool: BotPool | undefined;
  /** B3.6: a villager's healed home anchor, if any (the go-home reflex templates `$home.*` from it). */
  homeOf?: (villager: string) => [number, number, number] | undefined;
}): GodWiring {
  const { config, journal, dataDir } = args;
  const providers = new ProviderRegistry({
    strong: { baseUrl: config.llm.providers.strong.baseUrl, model: config.llm.providers.strong.model, inputTokenBudget: config.llm.providers.strong.inputTokenBudget },
    fast: { baseUrl: config.llm.providers.fast.baseUrl, model: config.llm.providers.fast.model, inputTokenBudget: config.llm.providers.fast.inputTokenBudget },
  });
  // Fail loud, not silent (R56): when a provider declares its key var, that var MUST hold a key. The
  // client's `?? process.env.OPENAI_API_KEY` default exists for OpenAI/live-tests, but letting it catch a
  // missing DEEPSEEK_API_KEY here would send the wrong provider's key and 401 on a key the user never
  // configured. A null apiKeyEnv (local providers) needs no key — the client sends no auth header.
  let apiKey: string | undefined;
  if (config.apiKeyEnv) {
    apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `llm: provider "${config.provider ?? '(unnamed)'}" requires ${config.apiKeyEnv}, but it is not set — ` +
          `put it in eden/api-keys.env or export it. The host does NOT fall back to OPENAI_API_KEY (R56).`,
      );
    }
  }
  const client = new LlmClient({ providers, journal, dataDir, debugPrompts: config.journal.debugPrompts, apiKey });
  const scheduler = new LlmScheduler({ maxConcurrent: config.llm.maxConcurrent, perVillagerCooldownMs: config.llm.perVillagerCooldownSeconds * 1000 });
  const budget = new BudgetTracker(config.god.budget.perDesk);
  const embeddings = new EmbeddingsService({
    // Local in-process multilingual MiniLM — the documented default (R38/R58). No key, no HTTP, so no 401.
    // R59: do NOT derive the embeddings backend from a CHAT provider. The previous wiring POSTed the fast
    // *chat* model (e.g. gpt-5.4-mini) to `${fast.baseUrl}/embeddings` with NO Authorization header, which
    // 401'd every run and silently degraded retrieval to the keyword floor. A provider embeddings endpoint
    // is a separate, explicit config (its own embedding model + key) — never the chat provider by default.
    backend: localBackend(),
    onWarn: (m) => logger.warn('embeddings', m),
  });

  const library = new SkillLibrary({ dataDir, journal, probationRuns: config.skills.probationRuns });
  // P2a: seed the stock skills (Voyager primitives — go-to/mine-block/collect-blocks/…) into the library
  // at `active` (curated review IS their probation, D-12). Without this the library boots EMPTY:
  // search_skills returns nothing and a villager has nothing to compose. Bug #12: only CHANGED stock gets a new
  // version, and never over a villager's admitted override of a stock name.
  // B3.6: the boot integrity check — a code file whose hash drifted from its record (tampered or corrupted on
  // disk) is quarantined before anything can run it. Before the seed, so a re-seeded stock version is fresh.
  library.verifyHashes();
  const seed = seedStockSkills(library);
  if (seed.seeded.length > 0) logger.info('skills', `stock: seeded ${seed.seeded.length} new/changed skill version(s) (${seed.unchanged} unchanged)`);
  if (seed.overridden.length > 0) {
    logger.warn('skills', `stock: kept the admitted override of ${seed.overridden.join(', ')} — the newer stock code was NOT seeded over it`);
  }
  const grants = new AllGranted();
  // B3.3: the FailureTripwire files a critic ticket — late-bound because the critic is built after the engine.
  const tripwireRef: { current?: (skill: string, report: RunReport) => void } = {};
  const engine = new SkillEngine({
    library, journal, grants,
    onTripwire: (skill, report) => tripwireRef.current?.(skill, report),
    resolveBot: (name: string): Bot | undefined => args.pool?.bot(name),
    runDefaultTimeoutMs: config.skills.runDefaultTimeoutMs,
    stallSeconds: config.skills.stallSeconds,
    maxCallDepth: config.skills.maxCallDepth,
    autoQuarantineAfter: config.skills.autoQuarantineAfter,
  });
  const retriever = new SkillRetriever({ library, embeddings, grants });

  // ── Society (M6): one VillagerMemory per villager (the SOLE WRITER of that villager's memory, S2) + a
  //    fast-tier MemorySummarizer (run on eviction, off the hot path). Built BEFORE the ToolRegistry so the
  //    shared registry can resolve the acting villager's memory per `ctx.villager` (the recall/remember
  //    tools) — a single instance would serve one villager's memory to all. ──
  const worldId = `${config.minecraft.host}:${config.minecraft.port}`;
  const summarizer = new MemorySummarizer(client); // always fast-tier internally (D-13)
  const memories = new Map<string, VillagerMemory>(
    config.villagers.map((v) => [
      v.name,
      new VillagerMemory({ villager: v.name, dataDir, journal, worldId, embeddings, summarizer }),
    ]),
  );
  const memoryFor = (name: string): VillagerMemory | undefined => memories.get(name);

  // D-17: a `tell` (an admin/website prompt, a player message relayed by God) raises the reactive `inbox` event so the
  // villager answers now — it used to wait for the next rollout revision to drain it. Directives and critiques do
  // NOT: the rollout that sent them drains them on its next turn. Trade notices carry their own wake-up.
  let signalInbox: ((villager: string) => void) | undefined;
  const inboxes = new Map<string, Inbox>(config.villagers.map((v) => [
    v.name,
    new VillagerInbox(v.name, journal, (m) => {
      if (m.kind === 'tell' && (m.payload as { source?: string }).source !== 'trade') signalInbox?.(v.name);
    }),
  ]));

  // ── Trade (04 §Trade) — the SettlementClient POSTs typed offers to the mod's :8767 listener
  //    (coin→paulsbrawls:coin; R29: needs :8767 free of the dev server). The token, if the mod has one, is a
  //    secret, so it comes from the env, never eden.json. TradeBook adds consent on top: propose_trade only
  //    puts an offer on the table; the partner's answer_trade(accept) settles it. Only roster villagers trade. ──
  const settlement = new SettlementClient({ url: config.settlement.url, journal, token: process.env.EDEN_SETTLEMENT_TOKEN });
  const villagerNames = new Set(config.villagers.map((v) => v.name));
  const roleOf = (name: string): string => config.villagers.find((v) => v.name === name)?.role ?? 'villager';
  // Set once the reactive wake-up exists (live pool only); until then an offer still lands in the inbox.
  let wakeForTrade: ((villager: string, line: string) => void) | undefined;
  // R33 walk-then-talk: on accept, the partner walks to the proposer with the go-to library skill. The mod
  // refuses parties farther apart than its maxTradeDistance, so aim inside it: settlement.reach (default 8) is
  // validated < settlement.maxTradeDistance (the mod's value, default 16) by the config loader (B4).
  const TRADE_REACH = config.settlement.reach;
  const reachFor = args.pool
    ? (offer: TradeOffer): ReachStrategy => {
        const pos = (name: string) => args.pool!.bot(name)?.entity?.position;
        return {
          inRange: () => {
            const a = pos(offer.from);
            const b = pos(offer.to);
            return !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= TRADE_REACH;
          },
          walkTo: async () => {
            const target = pos(offer.from);
            if (!target) throw new Error(`${offer.from} n'est pas connecté`);
            await engine.run('go-to', { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z), range: 3 }, { name: offer.to, role: roleOf(offer.to), tier: 'mortal' });
          },
        };
      }
    : undefined;
  const tradeBook = new TradeBook({
    journal,
    settlement,
    isVillager: (name) => villagerNames.has(name),
    ...(reachFor ? { reachFor } : {}),
    notify: (to, line, kind) => {
      inboxes.get(to)?.deliver({ from: 'villager', kind: 'tell', payload: { text: line, source: 'trade' }, at: Date.now() });
      if (kind === 'offer') wakeForTrade?.(to, line);
      else memories.get(to)?.remember({ kind: 'trade', text: line, tags: ['échange'] });
    },
  });
  // B4: offers are RAM-only; close the ones a previous host left open so the trade ledger never shows them pending.
  const orphanTrades = tradeBook.closeOrphans();
  if (orphanTrades > 0) logger.info('trade', `boot: closed ${orphanTrades} offer(s) left open by the previous host`);

  // ── Conversations (D-18) — say / tell / start_conversation. Bodies come from the live pool (offline = refused),
  //    memories from the per-villager VillagerMemory (the conversation's MemoryWriter), turns from a fast-tier
  //    ConversationTurner on the conversation lane. A tell lands in the partner's inbox and wakes it (D-17). ──
  const EARSHOT = 16;
  const posOf = (name: string): Vec3Like | undefined => args.pool?.bot(name)?.entity?.position;
  const near = (a: Vec3Like | undefined, b: Vec3Like | undefined): boolean =>
    !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= EARSHOT;
  const turner = new ConversationTurner({ client, scheduler, memoryFor });
  const conversationBook = new ConversationBook({
    journal,
    isVillager: (name) => villagerNames.has(name),
    conversantFor: (name): Conversant | undefined => {
      const bot = args.pool?.bot(name);
      const memory = memories.get(name);
      if (!bot || !memory) return undefined;
      return {
        name,
        memory,
        // Villagers are op'd: never let a line reach the chat as a `/` command (ConversationBook also strips it).
        sayInGame: (line) => bot.chat(chatSafe(line)),
        playerInEarshot: () => {
          const players = (bot as unknown as { players?: Record<string, { entity?: { position?: Vec3Like } }> }).players ?? {};
          return Object.entries(players).some(
            ([p, info]) => p !== name && p !== config.god.name && !villagerNames.has(p) && near(bot.entity?.position, info?.entity?.position),
          );
        },
      };
    },
    speakerFor: (self, partner, topic) =>
      turner.speakFn({ self, partner, topic, persona: `Tu es ${roleOf(self)} du village.` }, `${self}>${partner}@${Date.now()}`),
    inEarshot: (a, b) => near(posOf(a), posOf(b)),
    deliverTell: (to, from, text) =>
      inboxes.get(to)?.deliver({ from: 'villager', kind: 'tell', payload: { text, from }, at: Date.now() }, `villager:${from}`),
    eavesdroppersFor: (a, b): MemoryWriter[] =>
      config.villagers
        .map((v) => v.name)
        .filter((n) => n !== a && n !== b && near(posOf(n), posOf(a)))
        .flatMap((n) => (memories.get(n) ? [memories.get(n)!] : [])),
  });

  // The SHARED reactivity store (sole writer of subscription state, S2). Built BEFORE the ToolRegistry so the
  // villager tools subscribe/unsubscribe/list_subscriptions write the same store the routers read — it used
  // to be built after the registry, which left those three tools as "(réactivité non câblée)" stubs.
  const store = new SubscriptionStore({ dataDir, journal });

  const tools = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: config.skills.maxSkillLines, memoryFor, trade: tradeBook, subscriptions: store, conversations: conversationBook });
  const builder = new ContextPackBuilder({ journal });
  const brain = new Brain({ builder, tools, scheduler, client, journal });

  // B3.4: on admission a fast-tier DescriptionPass rewrites the manifest description from the FINAL code (02
  // §Description-from-code); it never throws (a bad reply falls back to a code-derived line).
  const god = new GodService({ journal, library, inboxes, describer: new DescriptionPass(client) });
  // When a scenario supplies a godPrompt, append it to every desk's base system prompt so God knows the
  // mission, what to teach, and any standing constraints — without touching the .md files (S6).
  const gp = config.god.godPrompt;
  const curriculumPrompt = gp ? `${loadCurriculumPrompt()}\n\n## Scenario instructions\n${gp}` : undefined;
  const orchestratorPrompt = gp ? `${loadOrchestratorPrompt()}\n\n## Scenario instructions\n${gp}` : undefined;
  const criticPrompt = gp ? `${loadCriticPrompt()}\n\n## Scenario instructions\n${gp}` : undefined;
  // Curriculum is the SOLE WRITER of the ledger (S2). Strong tier for proposals (novelty), fast for QA.
  const curriculum = new Curriculum({ state: god.state, journal, client, scheduler, embeddings, library, hasMissionDirective: gp !== undefined, tier: config.god.desks.curriculum.model, fastTier: 'fast', budget, degradeOnBreach: config.god.budget.degradeOnBreach, ...(curriculumPrompt ? { systemPrompt: curriculumPrompt } : {}) });
  // Re-wire God to delegate ledger writes to Curriculum (S2). The option is private; assign it once here.
  (god as unknown as { ledger: Curriculum }).ledger = curriculum;
  // The body (theatrics with teeth, never a dependency, 03 §The body). B3.5: it is KEPT — the orchestrator's
  // `intervene` tool stages the world through it, and the coordinator delivers notable verdicts in person when
  // `embodiedVerdicts` is on. A disconnected avatar just makes those best-effort calls return false.
  const body = new GodBody({ engine, journal, avatarName: config.god.name, embodiedVerdicts: config.god.embodiedVerdicts });
  const orchestrator = new Orchestrator({ state: god.state, journal, client, scheduler, inboxes, body, tier: config.god.desks.orchestrator.model, budget, degradeOnBreach: config.god.budget.degradeOnBreach, ...(orchestratorPrompt ? { systemPrompt: orchestratorPrompt } : {}) });
  const critic = new CriticDesk({ client, scheduler, journal, tier: config.god.desks.critic.model, budget, degradeOnBreach: config.god.budget.degradeOnBreach, batchMax: 3, ...(criticPrompt ? { systemPrompt: criticPrompt } : {}) });
  tripwireRef.current = makeTripwireHandler({ god, critic, library, threshold: config.skills.autoQuarantineAfter });


  const roster = new Map<string, RosterEntry>(config.villagers.map((v) => [v.name, { name: v.name, role: v.role, persona: `Tu es ${v.name}, ${v.role} du village. Tu parles français.` }]));
  // P2b: the always-in-prompt teaching set — the exemplar mortal stock skills' working NAMED-function
  // code, so the model sees the dialect every authoring turn. Villagers are mortal: NEVER leak divine
  // skill code (tier-filtered out of every villager prompt, 02 §Tiers).
  const exemplars = STOCK_SKILLS.filter((s) => s.exemplar && s.tier !== 'divine').map((s) => ({ name: s.name, code: s.code }));
  // P2: the always-available primitive palette — every MORTAL stock building block as a name—signature—summary
  // one-liner, composable via ctx.skills.run. NON-exemplar (exemplars already ride as full code) and never
  // divine (tier-filtered out of villager prompts, 02 §Tiers). Signatures are rendered from the schemas (D-04,
  // can't lie). The builder renders this on AUTHORING packs only, deduped vs retrieved + exemplars, so the base
  // vocabulary is present even when goal-retrieval surfaces none of it (R61's blind spot).
  const primitives = STOCK_SKILLS
    .filter((s) => s.tier === 'mortal' && !s.exemplar)
    .map((s) => ({ name: s.name, signature: renderSignature(s.name, s.params, s.returns), summary: s.summary }));
  // P2c: a best-effort live snapshot from the bot seam (D-14). The narrowed Bot exposes position/health/
  // food/inventory SYNCHRONOUSLY; biome/time/nearbyBlocks/etc. are NOT on the seam, so they stay
  // DEFAULT-ish. This only feeds the §SITUATION prompt section — the run-time `bot.findBlock`/`blockAt`
  // inside a skill sees the REAL world regardless, so an approximate situation block can't break a run.
  const pool = args.pool;
  const snapshotFor = pool
    ? (villager: string): Snapshot => {
        const bot = pool.bot(villager);
        if (!bot) return DEFAULT_SNAPSHOT;
        const pos = bot.entity?.position;
        return {
          ...DEFAULT_SNAPSHOT,
          position: pos ? [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)] : DEFAULT_SNAPSHOT.position,
          health: bot.health ?? DEFAULT_SNAPSHOT.health,
          hunger: bot.food ?? DEFAULT_SNAPSHOT.hunger,
          inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
        };
      }
    : undefined;
  const coordinator = new RolloutCoordinator({ god, curriculum, orchestrator, critic, brain, library, inboxes, roster, body, exemplars, primitives, retriever, memoryFor, strongInputTokenBudget: config.llm.providers.strong.inputTokenBudget, ...(snapshotFor ? { snapshotFor } : {}) });

  // ── M5 reactivity — assemble per-villager EventRouter + SubscriptionRouter so a SEEDED reflex (e.g. a
  //    guard's hurt→defend-self) fires within a tick of the signal, ZERO tokens, BEFORE the LLM could
  //    author a combat skill. The store is the SHARED sole writer of subscription state (S2); role
  //    defaults seed each villager at FIRST boot (idempotent). Only with a live pool — a CI/no-bots boot
  //    has nothing to attach to, so the store stays empty and no router is built. ──
  let reactivity: VillagerReactivity | undefined;
  let drives: Drives | undefined;
  if (pool) {
    const roles = loadRoles();
    let seeded = 0;
    let upgraded = 0;
    for (const v of config.villagers) {
      seeded += seedRoleDefaults(store, v.name, v.role, roles);
      upgraded += upgradeRoleDefaults(store, v.name, v.role, roles); // an edited roles.json reaches old data dirs
    }
    if (seeded > 0) {
      logger.info('villagers', `M5: seeded ${seeded} role-default reflex(es) across ${config.villagers.length} villager(s) (first boot)`);
    }
    if (upgraded > 0) logger.info('villagers', `refreshed ${upgraded} role-default reflex(es) from roles.json`);

    // A reactive deliberate wake-up: build a context pack from the coalesced request (R36) and run the
    // brain on its lane. Self-contained — it SWALLOWS its own LLM errors (logger, never a host
    // system.error): a best-effort reaction failing must not fail a run (the zero-token skill reflexes are
    // the load-bearing path). Reactive wake-ups ride the FAST tier (D-13: the strong tier's budget is for
    // novelty, not reflexes). It does NOT drain the inbox (the rollout coordinator owns directive draining).
    // The request's `event` is unused here, so trade offers can wake a villager without inventing one.
    const inboxShown = new WeakSet<InboxMessage>(); // messages an inbox wake-up already showed (unseenInbox)
    const wakeup = async (req: Omit<WakeupRequest, 'event'> & { event?: WakeupRequest['event'] }): Promise<void> => {
      const entry = roster.get(req.villager);
      try {
        // R61: pre-load the top-k relevant existing skills. This path is FAST-tier with
        // includeExemplarCode:false, so the retrieved `name — signature — summary` one-liners are its MAIN
        // skill signal (no exemplar code is injected here → no dedup needed). Query = the trigger(s) + hint(s)
        // that woke the villager. search() never throws (embeddings degrade to the keyword floor, R38).
        const query = `${req.triggers.join(' ')} ${req.hints.join(' ')}`.trim();
        const retrievedSkills = await retriever.search(query, { tier: 'mortal', villager: req.villager, k: 8 });
        // Proactive recall (04 §Memory): surface the top-k past entries relevant to what woke the villager,
        // so a reflex deliberation reasons from memory too. retrieve() never throws (embeddings degrade, R38).
        const recalled = (await memories.get(req.villager)?.retrieve(query, 5)) ?? [];
        const input: ContextPackInput = {
          villager: req.villager,
          runner: { name: req.villager, role: entry?.role ?? 'villager', tier: 'mortal' },
          persona: entry?.persona ?? `Tu es ${req.villager}.`,
          role: entry?.role ?? 'villager',
          triggers: req.triggers,
          hint: req.hints.join(' / '),
          snapshot: snapshotFor ? snapshotFor(req.villager) : DEFAULT_SNAPSHOT,
          runningSkill: engine.runningSkills(req.villager)[0] ?? null,
          directive: null,
          openTask: null,
          recentEvents: [],
          memories: recalled.map((h) => `(${h.kind}) ${h.text}`),
          retrievedSkills,
          exemplars: [],
          includeExemplarCode: false,
          toolNames: brain.toolNames(),
          // D-17: an `inbox` wake-up shows the messages not shown before (peek — the rollout coordinator still drains;
          // an idle villager's inbox is not drained, so re-showing it all on every wake grew each prompt).
          inbox: req.event?.type === 'inbox' ? unseenInbox(inboxes.get(req.villager), inboxShown) : [],
          tier: 'fast',
          inputTokenBudget: config.llm.providers.fast.inputTokenBudget,
        };
        await brain.deliberate(input, { lane: req.lane, kind: 'reactive' });
      } catch (e) {
        logger.warn('villagers', `reactive wake-up for ${req.villager} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // A trade offer wakes its partner on the conversation lane so it can answer_trade before expiry.
    wakeForTrade = (villager, line) => {
      void wakeup({ villager, triggers: [line], hints: ["réponds à l'offre d'échange avec answer_trade"], lane: 'conversation' });
    };

    // Live world facts the FilterEvaluator reads (P5: data in). Read off the live bot (not the
    // approximate §SITUATION snapshot) so within/health/food/timeOfDay/notWhileRunning clauses are exact.
    const vitalsFor = (villager: string): FilterContext => {
      const bot = pool.bot(villager);
      const pos = bot?.entity?.position;
      return {
        selfPos: pos ? [pos.x, pos.y, pos.z] : [0, 64, 0],
        timeOfDay: bot?.time?.timeOfDay ?? 1200,
        health: bot?.health ?? 20,
        food: bot?.food ?? 20,
        runningSkills: engine.runningSkills(villager),
      };
    };

    reactivity = new VillagerReactivity({
      villagers: config.villagers.map((v) => ({ name: v.name, role: v.role })),
      store,
      engine,
      journal,
      wakeup,
      vitalsFor,
      scopeFor: (villager) => {
        const home = args.homeOf?.(villager);
        return { home: home ? { x: home[0], y: home[1], z: home[2] } : undefined };
      },
      silentSpeakers: [config.god.name],
    });
    const live = reactivity;
    signalInbox = (villager) => live.signal(villager, 'inbox');

    // B3.7: the optional drives. A depleted drive wakes the villager once (hysteresis in the tracker) on the idle
    // lane with a French hint; a conversation line heard restores `social`, a successful go-home restores `rest`.
    if (config.behavior.drives) {
      drives = wireDrives({
        villagers: config.villagers.map((v) => v.name),
        journal,
        isConnected: (villager) => pool.bot(villager) !== undefined,
        wakeup: (kind, villager) => {
          void wakeup({ villager, triggers: [`besoin: ${kind === 'tired' ? 'fatigue' : 'solitude'}`], hints: [DRIVE_HINT[kind]], lane: 'idle' });
        },
      });
    }
  }

  return { god, curriculum, orchestrator, coordinator, library, scheduler, inboxes, memories, store, tools, ...(reactivity ? { reactivity } : {}), ...(drives ? { drives } : {}) };
}

/**
 * B3.3 — what the engine's FailureTripwire does (`autoQuarantineAfter` consecutive failures of one skill): file a
 * `tripwire` critic ticket, have the critic judge the last failing run against a synthetic "is this skill broken?"
 * task, and let God apply a quarantine verdict (GodService.routeTripwireVerdict — nothing else). Fire-and-forget:
 * a failing judge is logged, never thrown into the engine.
 */
export function makeTripwireHandler(deps: {
  god: GodService;
  critic: CriticDesk;
  library: SkillLibrary;
  threshold: number;
}): (skill: string, report: RunReport) => void {
  return (skill, report) => {
    void (async () => {
      const ticket = deps.god.fileTicket({ rolloutId: report.rolloutId ?? `tripwire:${report.runId}`, report, source: 'tripwire' });
      const task: Task = {
        id: `tripwire:${skill}`,
        goal: `Le skill « ${skill} » v${report.version} vient d'échouer ${deps.threshold} fois de suite. Juge s'il est cassé : mets-le en quarantaine (libraryAction "quarantine") si son code est en cause, sinon "none".`,
        successCriteria: 'le skill réussit ses exécutions',
        context: 'ticket du tripwire (échecs consécutifs hors rollout)',
        maxRetries: 0,
      };
      const verdict = await deps.critic.judge({
        ticket,
        task,
        report,
        code: deps.library.read(skill, report.version)?.code ?? '',
        dossier: deps.god.dossierFor(report.villager),
      });
      const r = deps.god.routeTripwireVerdict(verdict, { skill, version: report.version });
      logger.info('god', `tripwire on ${skill} v${report.version}: ${verdict.libraryAction}${r.quarantined ? ' (quarantined)' : ''}`);
    })().catch((e: unknown) => {
      logger.warn('god', `tripwire ticket for ${skill} could not be judged: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
}

/** B3.9 — the snapshot row God's working state lives in (journal.ts `snapshots`). */
const GOD_SNAPSHOT_KEY = 'god';
/** B3.9 — save at most this long after the last god.* event (the crash window). */
const GOD_SNAPSHOT_DEBOUNCE_MS = 250;

interface GodSnapshotRow {
  worldId: string;
  god: GodStateSnapshot;
  curriculum: ReturnType<Curriculum['exportState']>;
}

/**
 * B3.9 (bug #15) — restore God's last snapshot into the freshly wired desks, then keep it current: every God
 * mutation journals a `god.*` event, and each one schedules a debounced save (unref'd). A snapshot from another
 * world (R32) is not restored — the ledger of a dead world would send villagers after things that are gone.
 */
export function persistGodState(deps: {
  journal: Journal;
  wiring: Pick<GodWiring, 'god' | 'curriculum'>;
  worldId: string;
}): { flush(): void; stop(): void } {
  const { journal, wiring, worldId } = deps;
  const saved = journal.getSnapshot<GodSnapshotRow>(GOD_SNAPSHOT_KEY);
  if (saved && saved.value.worldId !== worldId) {
    logger.warn('god', `God snapshot is from world ${saved.value.worldId}, not ${worldId} — starting fresh (R32)`);
  } else if (saved && saved.value.god?.version === 1) {
    hydrateGodState(wiring.god.state, saved.value.god);
    wiring.curriculum.importState(saved.value.curriculum ?? {});
    logger.info('god', `restored God state: ${wiring.god.state.ledger.open.length} open task(s), ${wiring.god.state.dossiers.size} dossier(s)`);
  }
  const save = (): void => {
    journal.putSnapshot(GOD_SNAPSHOT_KEY, {
      worldId,
      god: serializeGodState(wiring.god.state),
      curriculum: wiring.curriculum.exportState(),
    } satisfies GodSnapshotRow);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = journal.subscribe((e) => {
    // Every God mutation journals a god.* event — except openRollout; any event tagged with a rolloutId (the first
    // deliberation or trial run) covers it, so a crash mid-trial still leaves the rollout for D-09 (review fix).
    if (timer || !(e.kind.startsWith('god.') || e.refs?.rolloutId !== undefined)) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        save();
      } catch (err) {
        logger.warn('god', `God snapshot save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, GOD_SNAPSHOT_DEBOUNCE_MS);
    timer.unref();
  });
  return {
    flush: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      save();
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      unsubscribe();
    },
  };
}

/** B3.7 — the French hint a depleted drive's wake-up carries. */
const DRIVE_HINT: Record<DriveKind, string> = {
  tired: 'tu es fatigué — rentre te reposer (go-home) avant de reprendre le travail',
  lonely: 'tu te sens seul — va parler à un autre villageois (start_conversation ou tell)',
};

/** The live drives: one tracker per villager, the 30 s tick, and the admin snapshot. */
export interface Drives {
  tick(): void;
  snapshot(villager: string): DriveSnapshot | undefined;
}

/**
 * B3.7 — build one enabled DriveTracker per villager and restore them from journal facts (S2: the tracker is the
 * only writer of its levels; it just listens): a `chat.heard` by a villager restores its `social`, a successful
 * `skill.run` of `go-home` restores its `rest`. The caller ticks; a crossing fires `wakeup` once.
 */
export function wireDrives(deps: {
  villagers: string[];
  journal: { subscribe(fn: (e: { kind: string; actor: string; payload: unknown }) => void): unknown };
  wakeup: (kind: DriveKind, villager: string) => void;
  /** Only a connected villager's drives decay (review fix: offline villagers used to tire and wake). Default: all. */
  isConnected?: (villager: string) => boolean;
}): Drives {
  const trackers = new Map(deps.villagers.map((v) => [v, new DriveTracker({ villager: v, enabled: true, wakeup: deps.wakeup })]));
  deps.journal.subscribe((e) => {
    if (e.kind === 'chat.heard') {
      trackers.get((e.payload as { hearer?: string }).hearer ?? '')?.socialize();
    } else if (e.kind === 'skill.run') {
      const p = e.payload as { skill?: string; villager?: string; outcome?: { ok?: boolean; value?: { home?: boolean } } };
      if (p.skill === 'go-home' && p.outcome?.ok && p.outcome.value?.home === true) trackers.get(p.villager ?? '')?.rest();
    }
  });
  return {
    tick: () => {
      for (const [v, t] of trackers) if (deps.isConnected?.(v) ?? true) t.tick();
    },
    snapshot: (villager) => trackers.get(villager)?.snapshot(),
  };
}

/**
 * B3.9: fold the journal (minus `vitals`) into the derived views at boot. A function of its own so the parsed history
 * is garbage once it returns — held in start()'s scope, every closure start() creates kept the whole journal alive
 * for the life of the process (review fix).
 */
function replayViews(journal: Journal, views: Array<{ rebuildByReplay(src: { query: () => JournalEvent[] }): void }>): void {
  const history = journal.query({ kinds: JOURNAL_KINDS.filter((k) => k !== 'vitals') });
  for (const v of views) v.rebuildByReplay({ query: () => history });
}

/** The pending messages of a villager inbox not shown to it before (VillagerInbox.peek, without draining), marking
 *  them shown. Exported for tests. */
export function unseenInbox(inbox: Inbox | undefined, shown: WeakSet<InboxMessage>): InboxMessage[] {
  const all = inbox && 'peek' in inbox ? (inbox as { peek(): InboxMessage[] }).peek() : [];
  const fresh = all.filter((m) => !shown.has(m));
  for (const m of fresh) shown.add(m);
  return fresh;
}

/** Build the admin's villager summary (identity + persona + vitals + subscriptions + inbox depth + current
 *  run + dossier) from the live wiring + journal folds (05) — the rich shape the dashboard renders. When
 *  God is off / no bots, vitals/subscriptions/relations are empty but the static identity still returns. */
/**
 * Read one LLM call transcript dumped by the client (`<dataDir>/llm/<callId>.json`, debugPrompts only).
 * The callId comes from the URL, so the charset guard (ULID/rid-ish: alnum + `_-`) is the traversal
 * defence — never interpolate a raw path segment. `undefined` for an off/unknown/unreadable transcript;
 * the admin maps that to a 404.
 */
function readLlmTranscript(dataDir: string, callId: string): unknown | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(callId)) return undefined;
  const file = join(dataDir, 'llm', `${callId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined; // a corrupt/half-written dump is a 404, never a host crash
  }
}

function villagerSummary(name: string, role: string, wiring: GodWiring | undefined, journal: Journal): Record<string, unknown> {
  const inbox = wiring?.inboxes.get(name);
  const memory = wiring?.memories.get(name);
  const dossier = wiring?.god.state.dossiers.get(name);
  const depth = inbox && 'depth' in inbox ? (inbox as { depth(): number }).depth() : 0;

  // Latest vitals snapshot (actor `bot:<name>`, kind `vitals`): pos/hp/food/held/currentRun. The pool emits
  // these only while a bot is connected, so they are null before any login (e.g. a smoke with bots off).
  const vEv = journal.query({ actor: `bot:${name}`, kinds: ['vitals'], limit: 1, order: 'desc' })[0];
  const vp = vEv?.payload as
    | { health?: number; food?: number; position?: [number, number, number]; held?: string | null; currentRun?: string | null }
    | undefined;
  // The dashboard renders vitals bars unconditionally, so ALWAYS return a non-null object: the real values
  // from the latest snapshot, else a nominal baseline (no snapshot yet — e.g. before a bot has connected).
  const vitals = vp
    ? { hp: vp.health ?? 0, hpMax: 20, food: vp.food ?? 0, foodMax: 20, pos: vp.position ?? [0, 0, 0], held: vp.held ?? '—' }
    : { hp: 20, hpMax: 20, food: 20, foodMax: 20, pos: [0, 0, 0] as [number, number, number], held: '—' };

  // Current activity = the latest journalled event BY this villager; the running skill comes from vitals.
  const lastEv = journal.query({ actor: `villager:${name}`, limit: 1, order: 'desc' })[0];
  const activityKind = lastEv?.kind ?? vEv?.kind ?? 'vitals';

  // Subscriptions as the dashboard renders them: "when X → do Y" + firing state (P5: filters as data).
  const subs = (wiring?.store.list(name) ?? []).map((s) => ({
    when: s.filter ? `${s.on} (filtered)` : s.on,
    then: s.handler.kind === 'skill' ? s.handler.name : `deliberate: ${s.handler.hint}`,
    fired: 0, // per-subscription firing counts are not folded; `state` carries armed/cooldown/suppressed
    state: !s.enabled ? 'suppressed' : wiring?.store.inCooldown(s.id) ? 'cooldown' : 'armed',
  }));

  // Per-tag competence → success rate (0..1) the dashboard's bars expect (Dossier stores {runs,successes}).
  const competence: Record<string, number> = {};
  if (dossier) for (const [tag, c] of Object.entries(dossier.competence)) competence[tag] = c.runs ? c.successes / c.runs : 0;

  return {
    name,
    role,
    persona: `Tu es ${name}, ${role} du village. Tu parles français.`,
    vitals,
    inbox: depth, // the dashboard reads `inbox` (a number)…
    inboxDepth: depth, // …and the admin contract reads `inboxDepth`
    subscriptions: subs,
    activityKind,
    currentRun: vp?.currentRun ?? null,
    relations: (memory?.relations() ?? []).map((r) => ({ name: r.other, score: r.score })),
    // B3.7: the rest/social drive levels when behavior.drives is on (else absent).
    ...(wiring?.drives?.snapshot(name) ? { drives: wiring.drives.snapshot(name) } : {}),
    dossier: { competence, note: dossier ? dossier.notes.join(' · ') : '' },
  };
}

/** Map the curriculum's {@link TaskLedger} into the dashboard's task-card columns. The website reads
 *  title/to/reason/priority/expiry/rolloutId; a {@link Task} has no priority/expiry, so those degrade to
 *  sensible defaults (the curriculum is the sole ledger writer — these are presentational only). */
function mapLedgerForDashboard(ledger: TaskLedger | undefined): { open: unknown[]; completed: unknown[]; failed: unknown[] } {
  const card = (t: Task, result?: string): Record<string, unknown> => ({
    id: t.id,
    title: t.goal,
    to: t.assignee ?? 'any',
    reason: t.successCriteria || t.context || '',
    priority: 'med',
    expiry: '—',
    rolloutId: t.currentRolloutId ?? null,
    ...(result ? { result } : {}),
  });
  if (!ledger) return { open: [], completed: [], failed: [] };
  return {
    open: ledger.open.map((t) => card(t)),
    completed: ledger.completed.map((r) => card(r.task, 'completed')),
    failed: ledger.failed.map((r) => card(r.task, 'failed')),
  };
}

/** A villager's roster entry the coordinator needs to assemble its context pack. */
export interface RosterEntry {
  name: string;
  role: string;
  persona: string;
}

/** Construction deps for the coordinator (wired here in main.ts). */
export interface RolloutCoordinatorOptions {
  god: GodService;
  curriculum: Curriculum;
  orchestrator: Orchestrator;
  critic: CriticDesk;
  brain: Brain;
  library: SkillLibrary;
  inboxes: Map<string, Inbox>;
  roster: Map<string, RosterEntry>;
  /** P2b: the exemplar stock skills' `{name, code}` — working NAMED-function code injected into every
   *  authoring deliberation so the model learns the dialect by example. Mortal exemplars only (no divine
   *  code in a villager prompt). Defaults to none (M3/M4 tests that don't need exemplars). */
  exemplars?: Array<{ name: string; code: string }>;
  /** P2: the always-available stock primitive palette (name — signature — summary), composable via
   *  ctx.skills.run. Rendered on authoring packs (deduped vs exemplars + retrieved) so the base building
   *  blocks are present even when goal-retrieval ranks none of them. Defaults to none (M3/M4 tests). */
  primitives?: Array<{ name: string; signature: string; summary: string }>;
  /** R61: the live skill retriever. Pre-loads the top-k relevant EXISTING skills into the deliberation's
   *  §CAPACITÉS as `name — signature — summary` one-liners (Voyager, owner #8/#10), so the villager acts on
   *  the library instead of discovering it by spamming the read-only `search_skills` tool (the R60 incident).
   *  OPTIONAL — M3/M4/gate/loop tests construct the coordinator without one and simply get `[]` (no change). */
  retriever?: SkillRetriever;
  /** Resolve the villager's current world snapshot (the BotPool provides it live; tests stub it). */
  snapshotFor?: (villager: string) => Snapshot;
  /** Resolve the acting villager's memory so the rollout can pre-load §6 MÉMOIRE PERTINENTE — the top-k
   *  relevant past entries for the task goal (proactive recall, 04 §Memory). OPTIONAL — tests without a
   *  memory simply get `[]` (no §6 injection, same as before). */
  memoryFor?: (villager: string) => VillagerMemory | undefined;
  /** B3.5: delivers notable verdicts in person (GodBody; a no-op when embodiedVerdicts is off). Optional. */
  body?: { deliverVerdict(opts: { villager: string; verdict: Verdict; rolloutId?: string }): Promise<boolean> };
  /** The STRONG tier's inputTokenBudget, resolved from providers.json via config. The authoring/revision
   *  rollout runs on the strong tier (D-13); its context-pack ceiling MUST match the configured strong
   *  model, not a hardcoded constant — a small-context preset (e.g. the `local` 32k) would otherwise
   *  overflow the reserve invariant that config.ts validates. Defaults to 48000 for tests. */
  strongInputTokenBudget?: number;
  now?: () => number;
}

/** The result of running one task to convergence (or exhausting its retries). */
export interface RolloutResult {
  converged: boolean;
  taskId: string;
  rolloutId: string;
  revisions: number;
  /** R72 — the rollout stopped because the task is blocked on a missing input resource (not converged,
   *  not exhausted): the critic flagged `blocked`, so the task was closed and a follow-up acquire-task
   *  enqueued instead of grinding revisions on a correct skill. */
  blocked?: boolean;
}

/** B3.6: how long after a spawn the anchors are healed — after the launcher's /spreadplayers (fires at +1.5 s). */
const ANCHOR_SETTLE_MS = 10_000;

const DEFAULT_SNAPSHOT: Snapshot = {
  biome: 'plains', time: 1200, position: [0, 64, 0], health: 20, hunger: 20,
  equipment: [], inventory: [], nearbyEntities: [], nearbyBlocks: [], knownChests: [],
};

/** Maps a curriculum trigger to the orchestrator's dispatch trigger vocabulary. */
function dispatchTriggerFor(t: CurriculumTrigger): DispatchTrigger {
  switch (t) {
    case 'idle': return 'idle-sweep';
    case 'verdict-close': return 'closed-task';
    case 'critic-follow-up': return 'verdict-follow-up';
    case 'dawn': return 'new-task';
    default: return 'admin';
  }
}

/**
 * The real refinement loop (M4-3). `runOnce` proposes a task (curriculum) then assigns + runs it;
 * `assignAndRun` dispatches a directive (orchestrator → inbox) and drives the rollout to convergence.
 */
export class RolloutCoordinator {
  private readonly o: RolloutCoordinatorOptions;
  private readonly now: () => number;

  constructor(opts: RolloutCoordinatorOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Propose one task (curriculum), then assign + run it to convergence. Returns undefined if no task.
   *  The requesting villager's live snapshot is threaded into the proposal so the curriculum sees what is
   *  already in hand (it must NOT propose acquiring an item the villager already holds). */
  async runOnce(opts: { trigger: CurriculumTrigger; villager?: string }): Promise<RolloutResult | undefined> {
    // R70: drain the backlog before proposing. If this villager already has an OPEN, non-running task,
    // RE-RUN that same id rather than proposing yet another near-duplicate that shadows it forever. This is
    // what makes the R65 convergence breaker work in the autonomous loop: a task is re-attempted under its
    // own id, so `noteExhausted` accrues its second exhausted rollout and an unconvergeable task is given
    // up (closed `failed`) instead of the open list filling with duplicate unconvergeable goals.
    if (opts.villager) {
      const resumable = this.o.curriculum.nextOpenTaskFor(opts.villager);
      if (resumable) {
        if (resumable.assignee === undefined) resumable.assignee = opts.villager; // claim it (race-free vs other villagers' loops)
        return this.assignAndRun(resumable, { trigger: opts.trigger });
      }
    }
    const snapshot = opts.villager && this.o.snapshotFor ? this.o.snapshotFor(opts.villager) : undefined;
    const task = await this.o.curriculum.proposeTask(snapshot ? { ...opts, snapshot } : opts);
    if (!task) return undefined;
    return this.assignAndRun(task, { trigger: opts.trigger });
  }

  /**
   * Assign a task via the REAL path — the orchestrator opens a directive (delivered to the villager's
   * inbox), then the rollout loop runs: brain deliberates with the directive in its context, the run is
   * judged by the critic (divineAssisted read from the orchestrator), routeVerdict revises or closes.
   * On close, the directive is closed too (anti-thrash bookkeeping). D-09 re-enqueued tasks flow here.
   */
  async assignAndRun(task: Task, opts: { trigger: CurriculumTrigger }): Promise<RolloutResult> {
    // Orchestrator: turn the task into a directive delivered to the assignee's inbox (sole writer).
    await this.o.orchestrator.dispatch({ task, trigger: dispatchTriggerFor(opts.trigger) });

    const villager = task.assignee ?? '(unassigned)';
    const entry = this.o.roster.get(villager) ?? { name: villager, role: 'villager', persona: `Tu es ${villager}.` };
    const rollout = this.o.god.openRollout(task.id);
    const toolNames = this.toolNamesFromInbox();

    // R61: retrieve the top-k relevant EXISTING skills ONCE per task, BEFORE the revision loop. The directive
    // the orchestrator just dispatched carries the task's goal, so `task.goal` IS the concrete actionable
    // query (directiveMsg?.goal ?? task.goal). Retrieve once: the library barely changes within a rollout and
    // a freshly-authored draft is `draft` status → not retrievable anyway; re-querying per revision would
    // also bloat the never-trimmed density payload (the density invariant forbids it). Exemplars ride as full
    // code already (includeExemplarCode:true below) — filter them out so they aren't duplicated as one-liners.
    const exemplarNames = new Set((this.o.exemplars ?? []).map((e) => e.name));
    const retrieved = this.o.retriever
      ? (await this.o.retriever.search(task.goal, { tier: 'mortal', villager, k: 10 })).filter(
          (s) => !exemplarNames.has(s.name),
        )
      : [];

    // Proactive recall (04 §Memory): pre-load §6 MÉMOIRE PERTINENTE with the top-k past entries relevant to
    // the task goal, ONCE per task (same rationale as the skills above — the goal is the query; §6 rides in
    // the capped frame, never the never-trimmed density payload). Empty (no memory wired / nothing relevant)
    // → §6 renders "(aucun souvenir pertinent)" as before. retrieve() never throws (embeddings degrade, R38).
    const memory = this.o.memoryFor?.(villager);
    const memories = memory ? (await memory.retrieve(task.goal, 6)).map((h) => `(${h.kind}) ${h.text}`) : [];

    let lastCritique: string | undefined;
    let lastRunReport: RunReport | undefined;
    let draftName: string | undefined;
    let draftCode: string | undefined;
    let draftVersion: number | undefined;
    let revisions = 0;

    for (let i = 0; i < task.maxRetries; i++) {
      revisions++;
      const inbox: InboxMessage[] = this.o.inboxes.get(villager)?.drain() ?? [];
      const directiveMsg = inbox.find((m) => m.kind === 'directive')?.payload as { goal?: string; reason?: string } | undefined;
      const snapshot = (this.o.snapshotFor ?? (() => DEFAULT_SNAPSHOT))(villager);

      const input: ContextPackInput = {
        villager, runner: { name: villager, role: entry.role, tier: 'mortal' },
        persona: entry.persona, role: entry.role,
        triggers: [`directive de Dieu: ${task.goal}`], hint: 'authoring',
        snapshot, runningSkill: null,
        directive: { goal: directiveMsg?.goal ?? task.goal, reason: directiveMsg?.reason ?? task.successCriteria },
        openTask: { goal: task.goal },
        recentEvents: [], memories, retrievedSkills: retrieved, primitives: this.o.primitives ?? [], exemplars: this.o.exemplars ?? [], includeExemplarCode: true,
        toolNames, inbox,
        density: draftVersion !== undefined && draftName !== undefined
          ? { draft: { name: draftName, version: draftVersion, code: draftCode! }, runReport: lastRunReport, critique: lastCritique }
          : undefined,
        history: [],
        tier: 'strong', inputTokenBudget: this.o.strongInputTokenBudget ?? 48000,
      };

      const delib = await this.o.brain.deliberate(input, { rolloutId: rollout.id });
      if (!delib.draft || !delib.lastRunReport) {
        // The villager produced no trial this turn — keep the rollout open for another revision.
        continue;
      }

      const ticket = this.o.god.fileTicket({ rolloutId: rollout.id, report: delib.lastRunReport, source: 'rollout' });
      const verdict = await this.o.critic.judge({
        ticket,
        task,
        report: delib.lastRunReport,
        code: this.o.library.read(delib.draft.name, delib.draft.version)?.code ?? '',
        dossier: this.o.god.dossierFor(villager),
        lastCritique,
        divineAssisted: this.o.orchestrator.wasDivinelyAssisted(task.id),
      });
      const route = await this.o.god.routeVerdict(verdict, { rolloutId: rollout.id, draft: delib.draft, task });
      // B3.5: a NOTABLE verdict (an admission, or a quarantine) is also delivered in person — fire-and-forget;
      // the inbox already carried it, so the loop never waits on the avatar (theatrics, never a dependency).
      if (this.o.body && (route.admitted || verdict.libraryAction === 'quarantine')) {
        void this.o.body.deliverVerdict({ villager, verdict, rolloutId: rollout.id }).catch(() => false);
      }
      if (route.rolloutClosed) {
        this.o.orchestrator.closeDirectivesForTask(task.id, 'completed');
        this.o.orchestrator.clearDivineAssist(task.id);
        return { converged: true, taskId: task.id, rolloutId: rollout.id, revisions };
      }

      // R72: the critic flagged the task BLOCKED on a missing input resource. The skill is correct — no
      // code revision can conjure the resource — so stop the rollout NOW (don't grind the remaining
      // retries), close the task, and enqueue the critic's follow-up acquire-task so the curriculum pivots
      // to obtaining the resource instead of re-attempting the wall. (The D3/seed-depletion grind.)
      if (verdict.blocked) {
        this.o.orchestrator.closeDirectivesForTask(task.id, 'expired');
        this.o.orchestrator.clearDivineAssist(task.id);
        rollout.open = false;
        this.o.curriculum.closeTask(task, route.verdictId, false, `blocked-on-resource: ${verdict.critique.slice(0, 200)}`);
        const fu = verdict.followUp;
        if (fu && !('to' in fu)) this.o.curriculum.addFollowUp(fu, task.assignee);
        return { converged: false, blocked: true, taskId: task.id, rolloutId: rollout.id, revisions };
      }

      lastCritique = verdict.critique;
      lastRunReport = delib.lastRunReport;
      draftName = delib.draft.name;
      draftVersion = delib.draft.version;
      draftCode = this.o.library.read(delib.draft.name, delib.draft.version)?.code;
    }
    // R65 convergence breaker: this rollout exhausted its maxRetries without converging. Tell the
    // curriculum (the sole ledger writer — S2): it counts exhausted rollouts and, after K of them, closes
    // the task `failed` (a blocked-task signal) so the SAME unconvergeable task isn't re-proposed forever
    // (the D3 incident). Below K the task stays open and the next runOnce retries it as before.
    this.o.orchestrator.closeDirectivesForTask(task.id, 'expired');
    this.o.orchestrator.clearDivineAssist(task.id);
    rollout.open = false; // the rollout is over (exhausted); routeVerdict does the same on the success path
    // R70: carry the last critique so the failed-frontier remembers the obstacle. If the breaker does NOT
    // give up yet (below K), the task stays open — clear its rollout pointer so the next runOnce RESUMES
    // this same id (and the breaker reaches its second exhausted rollout and fires). If it DID give up,
    // noteExhausted→closeTask already removed the task and cleared the pointer.
    const gaveUp = this.o.curriculum.noteExhausted(task, lastCritique);
    if (!gaveUp) delete task.currentRolloutId;
    return { converged: false, taskId: task.id, rolloutId: rollout.id, revisions };
  }

  private toolNamesFromInbox(): string[] {
    // The brain's tool registry owns the canonical list; the coordinator only needs the names for the
    // capabilities section. Re-deriving them from the registry keeps one source of truth.
    return this.o.brain.toolNames();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The autonomous driver — the production PUMP for the refinement loop. RolloutCoordinator knows how to run
// ONE task to convergence; before this, nothing in the interactive boot path called it (the live-test
// harness and the M3 GATE test were the only drivers), so a real `/villagers start` connected the bots and
// then sat idle. VillageLoop runs one independent loop per villager — wait for the body to connect, settle,
// then propose+run a task forever at the curriculum's own pace. It lives at the composition root next to
// RolloutCoordinator because it consumes it (a layer-3 actor may never import a peer — the dependency law).
// ─────────────────────────────────────────────────────────────────────────────

/** Construction deps for {@link VillageLoop} (wired in main.ts). */
export interface VillageLoopOptions {
  coordinator: RolloutCoordinator;
  /** Villager names to drive. The avatar (Dieu) is NOT driven by curriculum tasks — it is the divine runner. */
  villagers: string[];
  /** True iff the villager's body is currently connected (`pool.bot(name) !== undefined`). */
  isConnected: (name: string) => boolean;
  /** Poll interval while waiting for a villager to connect. Default 2000 ms (tests pass a few ms). */
  connectPollMs?: number;
  /** Settle delay after a villager first connects, before its first proposal (chunk + inventory sync). Default 3000 ms. */
  settleMs?: number;
  /** Gap after a normal (task-producing) turn before proposing the next. Default 1000 ms. ALSO the guaranteed
   *  macrotask yield each turn — never set to 0 with a synchronous coordinator (event-loop starvation, W). */
  turnDelayMs?: number;
  /** Back-off after a no-proposal turn or a driver error, so a dead provider can't hot-spin. Default 5000 ms. */
  idleBackoffMs?: number;
}

/**
 * One refinement loop per villager. Concurrency across villagers is bounded DOWNSTREAM — the LLM scheduler
 * caps `maxConcurrent` and the skill engine serializes one skill tree per bot (D-05) — so N parallel loops
 * never overrun the throughput ceiling (D-13/R49). Lifecycle is tied to the launcher: `start()` on
 * `/villagers start|restart`, `stop()` on `/villagers stop` and host shutdown. NOT started on `autoSpawn`
 * (the live-test harness drives the coordinator itself).
 */
export class VillageLoop {
  private readonly o: VillageLoopOptions;
  private readonly connectPollMs: number;
  private readonly settleMs: number;
  private readonly turnDelayMs: number;
  private readonly idleBackoffMs: number;
  private running = false;
  /** Bumped on every start/stop. A per-villager loop runs only while its captured epoch is still current, so
   *  a loop awaiting a multi-minute rollout when stop() lands exits at its next boundary (no double-drive). */
  private epoch = 0;

  constructor(opts: VillageLoopOptions) {
    this.o = opts;
    this.connectPollMs = opts.connectPollMs ?? 2000;
    this.settleMs = opts.settleMs ?? 3000;
    this.turnDelayMs = opts.turnDelayMs ?? 1000;
    this.idleBackoffMs = opts.idleBackoffMs ?? 5000;
  }

  /** Idempotent: a second start while running is a no-op. Spawns one detached loop per villager. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    logger.info('village-loop', `autonomous refinement loop started for ${this.o.villagers.length} villager(s)`);
    for (const name of this.o.villagers) void this.drive(name, epoch);
  }

  /** Stop every loop. Does NOT await in-flight rollouts — the admin/stop response must return promptly, and
   *  the pool disconnect that follows makes any in-flight skill run fail fast. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epoch++; // a loop still awaiting a rollout sees the epoch move and exits at its next boundary
    logger.info('village-loop', 'autonomous refinement loop stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private alive(epoch: number): boolean {
    return this.running && epoch === this.epoch;
  }

  /** Drive one villager: wait for its body, settle once, then propose+run on repeat. Self-contained — a
   *  thrown proposal/rollout is logged and backed off, never allowed to kill the loop (the village runs on). */
  private async drive(name: string, epoch: number): Promise<void> {
    let settled = false;
    while (this.alive(epoch)) {
      if (!this.o.isConnected(name)) {
        settled = false; // a disconnect re-arms the post-connect settle
        await sleep(this.connectPollMs);
        continue;
      }
      if (!settled) {
        await sleep(this.settleMs); // let chunks + inventory sync before the first proposal (mirrors the harness)
        settled = true;
        continue; // re-check liveness + connectedness at the top before spending a strong-tier proposal
      }
      // Every turn ends with an AWAITED macrotask sleep — normal pacing on success, a longer back-off on a
      // no-proposal turn or a thrown rollout. This is load-bearing: if runOnce ever resolves WITHOUT awaiting
      // a real macrotask (a fully-degraded zero-LLM curriculum/orchestrator path), an unconditional sleep
      // here is the only thing that keeps the loop from microtask-spinning and starving every timer (W).
      let backoff = this.turnDelayMs;
      try {
        const result = await this.o.coordinator.runOnce({ trigger: 'idle', villager: name });
        if (!result) backoff = this.idleBackoffMs; // curriculum proposed nothing
      } catch (e) {
        logger.warn('village-loop', `driver for ${name} errored — ${e instanceof Error ? e.message : String(e)}`);
        backoff = this.idleBackoffMs;
      }
      await sleep(backoff);
    }
  }
}

/** Unref'd sleep — never holds the event loop open, so host.stop() can let the process exit with a pending
 *  back-off timer outstanding. While the host is up the admin server + lag monitor keep the loop alive, so
 *  unref'd timers still fire on schedule. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** A key that names a secret VALUE: `*secret*`/`*password*`, or one ending in `key`/`token` (`apiKey`,
 *  `settlementToken`). Bug #17: the old substring test also masked `inputTokenBudget`, `dailyTokens` and
 *  `apiKeyEnv` (an env var NAME), so the boot snapshot hid the budgets an operator needs to read. */
const SECRET_KEY = /secret|passw(or)?d/i;
const SECRET_SUFFIX = /(key|token)$/i;

/** Mask anything secret-shaped before the config snapshot enters the journal. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) || SECRET_SUFFIX.test(k) ? '***' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Blocker Z: last-resort process guards. An async throw from mineflayer's physics tick (a rogue skill
 * handing pathfinder a bad goal, etc.) escapes every per-run try/catch and lands on the PROCESS. Left
 * unhandled, Node prints the trace and EXITS — one bad skill kills the whole village. These handlers
 * journal a `system.error` (S10: name the subject + the message) and DO NOT call process.exit, so the
 * host survives. Install ONLY on a real boot (the direct-run entrypoint / `installProcessGuards:true`):
 * a global handler installed under `npm test` would swallow the test runner's own failures. Returns a
 * detacher so `stop()` removes exactly these listeners (no cross-test leakage).
 */
export function installProcessGuards(journal: JournalAppender): () => void {
  const onUncaught = (err: unknown): void => {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error('engine', `host: uncaughtException survived — ${e.message}`);
    journal.append('engine', 'system.error', { message: `host: uncaughtException survived — ${e.message}`, ...(e.stack ? { stack: e.stack } : {}) });
  };
  const onRejection = (reason: unknown): void => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('engine', `host: unhandledRejection survived — ${e.message}`);
    journal.append('engine', 'system.error', { message: `host: unhandledRejection survived — ${e.message}`, ...(e.stack ? { stack: e.stack } : {}) });
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return (): void => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  };
}

/** The slice of `process` the shutdown handlers use — injectable so a test never signals the real runner. */
export interface SignalTarget {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/**
 * Bug #17: a real boot had no SIGINT/SIGTERM handler, so Ctrl-C (or pm2/systemd stop) killed the host with the
 * bots still logged in, the journal unclosed and the admin port held until the OS reaped it. The first signal
 * runs `stop()` (village loop → launcher → pool → admin → journal) once; a second signal while that is still
 * running forces `exit(1)`, so a wedged stop can always be interrupted. Returns a detacher.
 */
export function installShutdownHandlers(
  stop: () => Promise<void>,
  target: SignalTarget = process,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) {
      logger.warn('engine', 'second shutdown signal while stopping — forcing exit');
      exit(1);
      return;
    }
    stopping = true;
    logger.info('engine', 'shutdown signal — stopping the host (signal again to force)');
    stop().then(
      () => exit(0),
      (e: unknown) => {
        logger.error('engine', `shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
        exit(1);
      },
    );
  };
  target.on('SIGINT', onSignal);
  target.on('SIGTERM', onSignal);
  return (): void => {
    target.removeListener('SIGINT', onSignal);
    target.removeListener('SIGTERM', onSignal);
  };
}

// Run directly: `tsx src/main.ts [path/to/eden.json]`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const configPath = process.argv[2] ?? 'eden.json';
  // A real boot connects the bots AND installs the host crash guards (Blocker Z); CI/tests call
  // start() directly with both defaults false, so no global process handler leaks into the runner.
  start(configPath, { spawnBots: true, installProcessGuards: true }).then((host) => {
    installShutdownHandlers(() => host.stop());
  }).catch((err: unknown) => {
    logger.error('engine', `boot FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
