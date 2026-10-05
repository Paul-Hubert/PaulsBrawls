// VillagerReactivity (layer 3, villagers/) — the per-villager assembly that turns a connected bot into a
// reacting villager (04 §The event system). For each villager it owns: the per-bot signal adapter
// (bots/signals.ts), an EventRouter attached to that adapter's bus (normalizing raw signals →
// EdenEvents), and a SubscriptionRouter that routes each EdenEvent to a ZERO-TOKEN skill run or ONE
// coalesced brain wake-up (R36). This is the piece that was built + unit-tested in M5 but never
// assembled in the live host — main.ts constructs ONE of these (gated on a live bot pool) and feeds it
// bot-spawn events.
//
// Reconnect-safe: {@link attach} is called once per spawn AND again on every reconnect (the pool's
// onBotSpawn hook fires both times); it drops the stale router bound to the old bot instance before
// binding a fresh one, so a reconnect never leaks listeners or routes through a dead body.
//
// villagers/ may import skills/llm/render/journal/config/types AND bots/ (all downward); never god/ or
// social/ (the dependency law). The wake-up itself is INJECTED (a WakeupFn) so this module needn't know
// how to build a context pack — main.ts owns that (it's the only layer that may touch the Brain + roster).

import type { Bot } from '../types/bot';
import type { IJournal } from '../journal/journal';
import type { RunnerRef } from '../types/index';
import { logger } from '../logger';
import { attachReactivitySignals } from '../bots/signals';
import { SkillEngine } from '../skills/engine';
import { EventRouter, SubscriptionRouter, type WakeupFn } from './events';
import type { FilterContext, SubscriptionStore } from './subscriptions';

/** Construction deps. The store is SHARED across villagers (the sole writer of subscription state, S2). */
export interface VillagerReactivityOptions {
  villagers: ReadonlyArray<{ name: string; role: string }>;
  store: SubscriptionStore;
  engine: SkillEngine;
  journal: IJournal;
  /** Escalate ONE coalesced deliberate wake-up (R36). Built by main.ts (context pack → Brain.deliberate). */
  wakeup: WakeupFn;
  /** Live world facts the FilterEvaluator reads (vitals + running skills + time), per villager. */
  vitalsFor: (villager: string) => FilterContext;
  /** Below this health an edge fires `health-low` (defaults to the EventRouter's S7 default of 6). */
  healthLowThreshold?: number;
}

interface PerBot {
  router: EventRouter;
  detachSignals: () => void;
  /** Emit a host-side signal (e.g. `inbox`) on this villager's bus. */
  emit: (raw: string, ...args: unknown[]) => void;
}

/** Owns every villager's EventRouter + SubscriptionRouter; main.ts wires one per host. */
export class VillagerReactivity {
  private readonly o: VillagerReactivityOptions;
  private readonly roles: Map<string, string>;
  private readonly attached = new Map<string, PerBot>();

  constructor(opts: VillagerReactivityOptions) {
    this.o = opts;
    this.roles = new Map(opts.villagers.map((v) => [v.name, v.role]));
  }

  /**
   * Attach (or RE-attach after a reconnect) one villager's reactivity to its live bot. A name the host
   * doesn't know as a villager (e.g. the divine avatar) is ignored — only mortals carry reflexes.
   */
  attach(villager: string, bot: Bot): void {
    if (!this.roles.has(villager)) return;
    this.detachOne(villager); // reconnect-safe — drop the stale router bound to the previous bot instance
    const adapter = attachReactivitySignals(bot, { isVillager: (name) => this.roles.has(name) });
    const runner: RunnerRef = { name: villager, role: this.roles.get(villager) as string, tier: 'mortal' };
    const subRouter = new SubscriptionRouter({
      villager,
      runner,
      store: this.o.store,
      engine: this.o.engine,
      journal: this.o.journal,
      wakeup: this.o.wakeup,
      vitals: () => this.o.vitalsFor(villager),
    });
    const router = new EventRouter({
      villager,
      bot,
      signals: adapter.signals,
      // Routing is fire-and-forget at the emit site (a reflex runs async). route() is self-contained —
      // skill failures file a RunReport, the wake-up swallows its own LLM errors — so a rejection here is
      // unexpected; log it (R23: via logger) rather than escalate a reactive hiccup to a host system.error.
      sink: (env) => {
        void subRouter.route(env).catch((e: unknown) => {
          logger.warn(`villager:${villager}`, `reactivity route failed on ${env.event.type}: ${e instanceof Error ? e.message : String(e)}`);
        });
      },
      ...(this.o.healthLowThreshold !== undefined ? { healthLowThreshold: this.o.healthLowThreshold } : {}),
    });
    router.attach();
    this.attached.set(villager, { router, detachSignals: adapter.detach, emit: adapter.emit });
  }

  /**
   * Raise a host-side signal for one villager — today `inbox` (main.ts calls it when a `tell` lands, D-17). A
   * villager whose bot is not attached (offline) gets nothing: the message waits in its inbox for the next drain.
   */
  signal(villager: string, raw: string, ...args: unknown[]): void {
    this.attached.get(villager)?.emit(raw, ...args);
  }

  /** Pump the 30 s coarse clock across every attached router (the host arms a 30 s timer that calls this). */
  tick(): void {
    for (const pb of this.attached.values()) pb.router.tick();
  }

  /** How many subscriptions a villager holds — the admin /villagers surface (was hardcoded 0). */
  subscriptionCount(villager: string): number {
    return this.o.store.list(villager).length;
  }

  /** Detach every router + signal adapter (host stop). */
  detach(): void {
    for (const villager of [...this.attached.keys()]) this.detachOne(villager);
  }

  private detachOne(villager: string): void {
    const pb = this.attached.get(villager);
    if (!pb) return;
    pb.router.detach();
    pb.detachSignals();
    this.attached.delete(villager);
  }
}
