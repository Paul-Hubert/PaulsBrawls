// EdenHost — the ONLY composition root (08). It imports everything and wires it with
// plain constructor arguments (no singletons, no DI container). M0 brings up the spine:
// config -> journal -> lag monitor -> admin, and journals system.boot. Bots (M1), the
// skill engine (M2), and God (M3+) are wired in here as their milestones land.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, type EdenConfig } from './config';
import { logger } from './logger';
import { Journal, type JournalAppender } from './journal/journal';
import { createLagMonitor, type LagMonitor } from './journal/lag-monitor';
import { BotPool } from './bots/pool';
import { AdminServer } from './admin/server';
import { SkillLibrary, AllGranted } from './skills/library';
import { SkillEngine } from './skills/engine';
import { SkillRetriever } from './skills/retrieve';
import { STOCK_SKILLS, seedStockSkills } from './skills/exemplars/index';
import { LlmClient, ProviderRegistry } from './llm/client';
import { LlmScheduler, BudgetTracker } from './llm/scheduler';
import { EmbeddingsService, localBackend, providerBackend } from './llm/embeddings';
import { ToolRegistry } from './villagers/tools';
import { ContextPackBuilder, type ContextPackInput } from './villagers/context-pack';
import { Brain } from './villagers/brain';
import { VillagerInbox } from './villagers/inbox';
import { GodService } from './god/god';
import { Curriculum, type CurriculumTrigger } from './god/curriculum';
import { Orchestrator, type DispatchTrigger } from './god/orchestrator';
import { CriticDesk } from './god/critic';
import { GodBody } from './god/body';
import { VillagerMemory } from './villagers/memory';
import { MemorySummarizer } from './villagers/memory-summarizer';
import { SettlementClient } from './social/trade';
import {
  SkillStatsView,
  CompetenceView,
  RelationsView,
  TradeLedgerView,
} from './views/index';
import type { Bot, Inbox, InboxMessage, RunReport, Snapshot, Task } from './types/index';

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
  const config = loadConfig(configPath, (w) => warnings.push(w));

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
  };
  journal.subscribe((e) => {
    views.skillStats.fold(e);
    views.competence.fold(e);
    views.relations.fold(e);
    views.tradeLedger.fold(e);
  });

  // The bot pool (M1) — built only when asked; the actual spawn is kicked AFTER the host is up.
  const pool = opts.spawnBots
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
      })
    : undefined;

  // God's desks + the refinement loop (M4-3). Wired only for a real run (needs a live world + provider).
  const enableGod = opts.enableGod ?? opts.spawnBots ?? false;
  const wiring = enableGod ? wireGod({ config, journal, dataDir, pool }) : undefined;

  // 7. D-09 rollout recovery (boot-abandon). GodService.recoverRollouts(): every open task whose
  //    currentRolloutId is still set has its rollout journaled god.rollout-abandoned + re-enqueued with
  //    fresh maxRetries (orphan drafts stay harmless `draft`s). The re-enqueue now flows through the real
  //    ledger writer (Curriculum, S2) → the coordinator re-assigns it (M4-3). No-op when God is off.
  if (wiring) {
    const recovered = wiring.god.recoverRollouts();
    if (recovered > 0) logger.info('god', `boot recovery: re-enqueued ${recovered} abandoned rollout(s) (D-09)`);
  }

  // 8. Admin server (the COMPLETE consumer surface, 05): read API + WS stream + the mutating POST verbs.
  //    All data accessors read derived views / live God state / the library (admin holds no concrete
  //    subsystem — narrow accessor functions only). When God is off (CI/host-readiness) the GET routes
  //    return derived-from-journal or empty, and the control verbs report 503 (unwired) — the spine still
  //    boots and answers. Every mutating verb journals actor:'admin'|player:<name> BEFORE acting (05).
  const startedAt = Date.now();
  const admin = new AdminServer({
    port: config.admin.port,
    journal,
    startedAt,
    getStatus: () => ({
      bots: pool?.connectedCount() ?? 0,
      runs: 0,
      queues: { llm: wiring?.scheduler.pending() ?? 0, paused: wiring?.scheduler.isPaused() ?? false },
    }),
    villagers: () => config.villagers.map((v) => villagerSummary(v.name, v.role, wiring)),
    villager: (name) =>
      config.villagers.some((v) => v.name === name)
        ? villagerSummary(name, config.villagers.find((v) => v.name === name)!.role, wiring)
        : undefined,
    skills: () =>
      (wiring?.library.liveSkills() ?? []).map((s) => ({
        name: s.manifest.name,
        version: s.version.version,
        status: s.version.status,
        tier: s.manifest.tier,
        tags: s.manifest.tags,
        stats: views.skillStats.value()[s.manifest.name] ?? null,
      })),
    skill: (name, o) => {
      const resolved = wiring?.library.read(name, o.version);
      if (!resolved) return undefined;
      const base: Record<string, unknown> = {
        name: resolved.manifest.name,
        version: resolved.version.version,
        status: resolved.version.status,
        signature: resolved.manifest.signature,
        description: resolved.manifest.description,
        tags: resolved.manifest.tags,
        stats: views.skillStats.value()[name] ?? null,
      };
      if (o.version !== undefined) base['requestedVersion'] = o.version;
      if (o.code) base['code'] = resolved.code;
      return base;
    },
    tasks: () => wiring?.god.state.ledger ?? { open: [], completed: [], failed: [] },
    verdicts: () => journal.query({ kinds: ['god.verdict'], limit: 200 }),
    directives: () => wiring?.god.state.directivesOpen ?? [],
    onPause: wiring ? () => wiring.scheduler.pause() : undefined,
    onResume: wiring ? () => wiring.scheduler.resume() : undefined,
    onQuarantine: wiring
      ? (name, reason) => wiring.library.quarantine(name, `admin: ${reason}`) !== undefined
      : undefined,
    onPrompt: wiring
      ? (name, msg) => {
          const inbox = wiring.inboxes.get(name);
          if (!inbox) return false;
          // The inbox journals inbox.delivered on deliver(); the admin ALSO journaled it actor:player/admin
          // BEFORE this (05). Deliver the tell — the villager hears it like any other and deliberates.
          inbox.deliver({ from: 'villager', kind: 'tell', payload: { text: msg.text, from: msg.from }, at: Date.now() });
          return true;
        }
      : undefined,
  });
  const { port } = await admin.start();

  journal.append('engine', 'system.boot', { config: redactSecrets(config) as object });
  logger.info('engine', `Eden host up — admin on http://127.0.0.1:${port}`);

  // Kick the staggered login (R13/I1) without blocking host readiness — it takes ~40 s for 11 bots.
  if (pool) void pool.start();

  return {
    adminPort: port,
    config,
    journal,
    coordinator: wiring?.coordinator,
    god: wiring?.god,
    async stop() {
      removeProcessGuards?.();
      pool?.stop();
      lag.stop();
      await admin.stop();
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
}

/**
 * Construct God's desks (critic/curriculum/orchestrator), the villager brain, and the refinement-loop
 * coordinator — the M4-3 wiring. Lives at the composition root so god/ and villagers/ stay decoupled.
 * The strong/fast tier split (D-13): curriculum proposal + critic run STRONG (novelty); orchestrator
 * dispatch + QA-cache run FAST. Per-desk budget caps default null (R49 — throughput is the limiter).
 */
function wireGod(args: { config: EdenConfig; journal: Journal; dataDir: string; pool: BotPool | undefined }): GodWiring {
  const { config, journal, dataDir } = args;
  const providers = new ProviderRegistry({
    strong: { baseUrl: config.llm.providers.strong.baseUrl, model: config.llm.providers.strong.model, inputTokenBudget: config.llm.providers.strong.inputTokenBudget },
    fast: { baseUrl: config.llm.providers.fast.baseUrl, model: config.llm.providers.fast.model, inputTokenBudget: config.llm.providers.fast.inputTokenBudget },
  });
  const client = new LlmClient({ providers, journal, dataDir, debugPrompts: config.journal.debugPrompts });
  const scheduler = new LlmScheduler({ maxConcurrent: config.llm.maxConcurrent, perVillagerCooldownMs: config.llm.perVillagerCooldownSeconds * 1000 });
  const budget = new BudgetTracker(config.god.budget.perDesk);
  const embeddings = new EmbeddingsService({
    backend: config.llm.providers.fast.baseUrl ? providerBackend(config.llm.providers.fast.baseUrl, config.llm.providers.fast.model) : localBackend(),
    onWarn: (m) => logger.warn('embeddings', m),
  });

  const library = new SkillLibrary({ dataDir, journal, probationRuns: config.skills.probationRuns });
  // P2a: seed the stock skills (Voyager primitives — go-to/mine-block/collect-blocks/…) into the library
  // at `active` (curated review IS their probation, D-12). Without this the library boots EMPTY:
  // search_skills returns nothing and a villager has nothing to compose. seedStock appends a version, so
  // a re-seed on a populated library is harmless (the active version is just re-asserted).
  seedStockSkills(library);
  const grants = new AllGranted();
  const engine = new SkillEngine({
    library, journal, grants,
    resolveBot: (name: string): Bot | undefined => args.pool?.bot(name),
    runDefaultTimeoutMs: config.skills.runDefaultTimeoutMs,
    stallSeconds: config.skills.stallSeconds,
    maxCallDepth: config.skills.maxCallDepth,
    autoQuarantineAfter: config.skills.autoQuarantineAfter,
  });
  const retriever = new SkillRetriever({ library, embeddings, grants });
  const tools = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: config.skills.maxSkillLines });
  const builder = new ContextPackBuilder({ journal });
  const brain = new Brain({ builder, tools, scheduler, client, journal });

  const inboxes = new Map<string, Inbox>(config.villagers.map((v) => [v.name, new VillagerInbox(v.name, journal)]));
  const god = new GodService({ journal, library, inboxes });
  // Curriculum is the SOLE WRITER of the ledger (S2). Strong tier for proposals (novelty), fast for QA.
  const curriculum = new Curriculum({ state: god.state, journal, client, scheduler, embeddings, tier: config.god.desks.curriculum.model, fastTier: 'fast', budget, degradeOnBreach: config.god.budget.degradeOnBreach });
  // Re-wire God to delegate ledger writes to Curriculum (S2). The option is private; assign it once here.
  (god as unknown as { ledger: Curriculum }).ledger = curriculum;
  const orchestrator = new Orchestrator({ state: god.state, journal, client, scheduler, inboxes, tier: config.god.desks.orchestrator.model, budget, degradeOnBreach: config.god.budget.degradeOnBreach });
  const critic = new CriticDesk({ client, scheduler, journal, tier: config.god.desks.critic.model, budget, degradeOnBreach: config.god.budget.degradeOnBreach, batchMax: 3 });

  // The body (theatrics, never a dependency) — built so divine stage-setting has a runner (M3-5).
  void new GodBody({ engine, journal, avatarName: config.god.name, embodiedVerdicts: config.god.embodiedVerdicts });

  // ── Society (M6): one VillagerMemory per villager (the SOLE WRITER of that villager's memory, S2),
  //    a fast-tier MemorySummarizer (run on eviction, off the hot path), and a SettlementClient for trade
  //    (POSTs typed offers to settlement.url; coin→paulsbrawls:coin). Conversation/trade SERVICES are
  //    constructed per-interaction with bot-backed sinks (Conversant/ReachStrategy) at run time — those
  //    need a live bot, so they're created lazily in the (real-boot) flow, not here. The memories +
  //    settlement client are stable singletons the admin + future loop read. ──
  const worldId = `${config.minecraft.host}:${config.minecraft.port}`;
  const summarizer = new MemorySummarizer(client); // always fast-tier internally (D-13)
  const memories = new Map<string, VillagerMemory>(
    config.villagers.map((v) => [
      v.name,
      new VillagerMemory({ villager: v.name, dataDir, journal, worldId, embeddings, summarizer }),
    ]),
  );
  // The settlement client is wired from config (R29: needs :8767, free of the dev server). Held for the
  // trade tools the real loop composes; constructed here so a boot fails fast if the url is malformed.
  void new SettlementClient({ url: config.settlement.url, journal });

  const roster = new Map<string, RosterEntry>(config.villagers.map((v) => [v.name, { name: v.name, role: v.role, persona: `Tu es ${v.name}, ${v.role} du village. Tu parles français.` }]));
  // P2b: the always-in-prompt teaching set — the exemplar mortal stock skills' working NAMED-function
  // code, so the model sees the dialect every authoring turn. Villagers are mortal: NEVER leak divine
  // skill code (tier-filtered out of every villager prompt, 02 §Tiers).
  const exemplars = STOCK_SKILLS.filter((s) => s.exemplar && s.tier !== 'divine').map((s) => ({ name: s.name, code: s.code }));
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
  const coordinator = new RolloutCoordinator({ god, curriculum, orchestrator, critic, brain, library, inboxes, roster, exemplars, ...(snapshotFor ? { snapshotFor } : {}) });
  return { god, curriculum, orchestrator, coordinator, library, scheduler, inboxes, memories };
}

/** Build the admin's villager summary (identity + vitals + subscriptions + inbox depth + current run +
 *  dossier summary) from the live wiring (05). When God is off, the static identity is still returned. */
function villagerSummary(name: string, role: string, wiring: GodWiring | undefined): Record<string, unknown> {
  const inbox = wiring?.inboxes.get(name);
  const memory = wiring?.memories.get(name);
  const dossier = wiring?.god.state.dossiers.get(name);
  return {
    name,
    role,
    vitals: null, // live vitals fold from the `vitals` journal stream when the pool runs (smoke-time)
    inboxDepth: inbox && 'depth' in inbox ? (inbox as { depth(): number }).depth() : 0,
    subscriptions: 0, // the SubscriptionStore is per-villager; surfaced when reactivity is wired (smoke)
    currentRun: null,
    relations: memory?.relations() ?? [],
    dossier: dossier ? { competence: dossier.competence, notes: dossier.notes } : null,
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
  /** Resolve the villager's current world snapshot (the BotPool provides it live; tests stub it). */
  snapshotFor?: (villager: string) => Snapshot;
  now?: () => number;
}

/** The result of running one task to convergence (or exhausting its retries). */
export interface RolloutResult {
  converged: boolean;
  taskId: string;
  rolloutId: string;
  revisions: number;
}

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

  /** Propose one task (curriculum), then assign + run it to convergence. Returns undefined if no task. */
  async runOnce(opts: { trigger: CurriculumTrigger; villager?: string }): Promise<RolloutResult | undefined> {
    const task = await this.o.curriculum.proposeTask(opts);
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
        recentEvents: [], memories: [], retrievedSkills: [], exemplars: this.o.exemplars ?? [], includeExemplarCode: true,
        toolNames, inbox,
        density: draftVersion !== undefined && draftName !== undefined
          ? { draft: { name: draftName, version: draftVersion, code: draftCode! }, runReport: lastRunReport, critique: lastCritique }
          : undefined,
        history: [],
        tier: 'strong', inputTokenBudget: 48000,
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
      if (route.rolloutClosed) {
        this.o.orchestrator.closeDirectivesForTask(task.id, 'completed');
        this.o.orchestrator.clearDivineAssist(task.id);
        return { converged: true, taskId: task.id, rolloutId: rollout.id, revisions };
      }

      lastCritique = verdict.critique;
      lastRunReport = delib.lastRunReport;
      draftName = delib.draft.name;
      draftVersion = delib.draft.version;
      draftCode = this.o.library.read(delib.draft.name, delib.draft.version)?.code;
    }
    return { converged: false, taskId: task.id, rolloutId: rollout.id, revisions };
  }

  private toolNamesFromInbox(): string[] {
    // The brain's tool registry owns the canonical list; the coordinator only needs the names for the
    // capabilities section. Re-deriving them from the registry keeps one source of truth.
    return this.o.brain.toolNames();
  }
}

/** Mask anything secret-shaped before the config snapshot enters the journal. */
function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /key|secret|token|password/i.test(k) ? '***' : redactSecrets(v);
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

// Run directly: `tsx src/main.ts [path/to/eden.json]`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const configPath = process.argv[2] ?? 'eden.json';
  // A real boot connects the bots AND installs the host crash guards (Blocker Z); CI/tests call
  // start() directly with both defaults false, so no global process handler leaks into the runner.
  start(configPath, { spawnBots: true, installProcessGuards: true }).catch((err: unknown) => {
    logger.error('engine', `boot FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
