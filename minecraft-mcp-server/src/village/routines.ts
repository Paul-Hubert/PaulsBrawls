import { log, logDebug } from '../logger.js';
import { abortActiveTasks, inventorySummary } from './actions.js';
import { VillageContext } from './context.js';
import { CycleBudget, compileScript, isBenignPreemption, prepareScript } from './sandbox.js';
import { buildScriptGlobals } from './villager-api.js';
import type { Villager } from './villager.js';

/**
 * Runs 'routine' skills — long-lived job scripts (farm loop, woodcutting,
 * craft batches). One routine per villager at a time; stopping sets the
 * cancellation token that every API action and sleep() probes.
 *
 * Routines go through the exact same sandbox pipeline as reflexes (the stock
 * routines in stock-skills.ts are dogfood for it); the differences are mode
 * ('live' from the start, bot.on() forbidden) and lifetime (minutes-hours,
 * wall-clock capped, budget refunded on every sleep()).
 */

const ROUTINE_MAX_MS = 2 * 60 * 60 * 1000;

/** Declarative job goal (M13 self-verification) — data, never bot-authored code. */
export interface SuccessCheck {
  /** Inventory item id (exact or substring, e.g. 'iron_pickaxe'). */
  item: string;
  count: number;
}

interface RunningRoutine {
  name: string;
  startedAt: number;
  cancel: { cancelled: boolean };
  watchdog: ReturnType<typeof setTimeout>;
  successCheck?: SuccessCheck;
}

/** Verdict line for a declarative goal against the live inventory; null without a check. */
export function evaluateSuccessCheck(bot: Parameters<typeof inventorySummary>[0] | null, check?: SuccessCheck): string | null {
  if (!check) return null;
  if (!bot) return `objectif invérifiable (déconnecté): ${check.count}x ${check.item}`;
  const have = inventorySummary(bot)
    .filter((s) => s.item === check.item || s.item.includes(check.item))
    .reduce((sum, s) => sum + s.count, 0);
  return have >= check.count
    ? `OBJECTIF ATTEINT: ${have}x ${check.item} (voulu ${check.count})`
    : `OBJECTIF MANQUÉ: voulu ${check.count}x ${check.item}, j'en ai ${have}`;
}

/** Action labels that count as PROGRESS when they succeed (a numeric result
 *  must be > 0: `collect(...) → 0` is not progress). Movement, perception and
 *  equipment shuffles are deliberately excluded. */
const PROGRESS_PREFIXES = ['dig(', 'place(', 'till(', 'collect(', 'craft(', 'deposit(', 'withdraw(', 'give('];
/** Consecutive futile completions of the same skill before escalating. */
const FUTILE_ESCALATE_AFTER = 2;

export class RoutineRunner {
  private readonly villager: Villager;
  private readonly ctx: VillageContext;
  private current: RunningRoutine | null = null;
  /** Consecutive zero-progress completions per skill (reset on any progress). */
  private readonly futileRuns = new Map<string, number>();

  constructor(villager: Villager, ctx: VillageContext) {
    this.villager = villager;
    this.ctx = ctx;
  }

  status(): { name: string; runningForMs: number } | null {
    if (!this.current) return null;
    return { name: this.current.name, runningForMs: Date.now() - this.current.startedAt };
  }

  /** Start a routine skill by name. Returns an error string, or null on success. */
  start(skillName: string, successCheck?: SuccessCheck): string | null {
    const skill = this.villager.skills.get(skillName);
    if (!skill) return `no skill named '${skillName}'`;
    if (skill.kind !== 'routine') return `'${skillName}' is a ${skill.kind}, not a routine`;
    if (skill.status !== 'active') return `'${skillName}' is disabled (${skill.lastError ?? 'errors'}) — rewrite it first`;
    if (this.current) return `already running '${this.current.name}' — stop_job first`;

    const prepared = prepareScript(skill.code);
    if (!prepared.ok) return `routine failed validation: ${prepared.errors.join('; ')}`;

    const cancel = { cancelled: false };
    const budget = new CycleBudget();
    // Futility tally: a routine that swallows every action error in try/catch
    // completes "successfully" — without this, doing-nothing-forever is
    // indistinguishable from working (seen live: wood-loop next to a
    // logged-out forest, 60ms of failed finds + sleep, on repeat for minutes).
    const tally = { progress: 0, failures: 0 };
    const globals = buildScriptGlobals(this.villager, this.ctx, {
      mode: 'live',
      cancelled: () => cancel.cancelled,
      budget,
      onAction: (label, ok, result) => {
        if (!ok) {
          tally.failures += 1;
          return;
        }
        if (PROGRESS_PREFIXES.some((p) => label.startsWith(p)) && (typeof result !== 'number' || result > 0)) {
          tally.progress += 1;
        }
      },
    });

    const watchdog = setTimeout(() => {
      log('warn', `[village] ${this.villager.name} routine '${skillName}' hit the ${ROUTINE_MAX_MS / 60000}min cap — cancelling`);
      cancel.cancelled = true;
    }, ROUTINE_MAX_MS);
    watchdog.unref?.();

    const startedAt = Date.now();
    this.current = { name: skillName, startedAt, cancel, watchdog, successCheck };
    log('info', `[village] ${this.villager.name} started routine '${skillName}'`);
    logDebug(this.villager.name, `routine '${skillName}' start${successCheck ? ` goal=${successCheck.count}x ${successCheck.item}` : ''}`);

    const compiled = compileScript(prepared.instrumented);
    void compiled(globals, budget)
      .then(() => {
        if (!cancel.cancelled) {
          // Futility check: zero productive actions AND at least one swallowed
          // action error = the script tried and the world said no. (Zero
          // progress with zero failures is a legitimately quiet pass — a
          // patrol, a field still growing — and stays a plain completion.)
          const futilePass = tally.progress === 0 && tally.failures > 0;
          let futile = false;
          if (futilePass) {
            const n = (this.futileRuns.get(skillName) ?? 0) + 1;
            this.futileRuns.set(skillName, n);
            futile = n >= FUTILE_ESCALATE_AFTER;
          } else if (tally.progress > 0) {
            this.futileRuns.delete(skillName);
            // Release valve for the scheduler's failure memo: real progress
            // means stale "identical failure" suppressions must not gag
            // whatever happens next.
            this.ctx.scheduler.clearFailures(this.villager.name);
          }
          const verdict = this.evaluateCheck(successCheck);
          const outcome = [
            verdict,
            futilePass ? `PASSAGE À VIDE: ${tally.failures} action(s) ratée(s), rien obtenu` : null,
          ].filter((s): s is string => Boolean(s)).join(' — ') || undefined;
          logDebug(
            this.villager.name,
            `routine '${skillName}' finished in ${Date.now() - startedAt}ms (progress ${tally.progress}, failures ${tally.failures})${outcome ? ` — ${outcome}` : ''}`
          );
          this.villager.memory.append(
            'event',
            `finished job '${skillName}'${outcome ? ` — ${outcome}` : ''}`,
            [skillName, ...(verdict ? ['objectif'] : [])],
            verdict ? 7 : undefined
          );
          this.villager.bus.emit({ type: 'job-done', job: skillName, ...(outcome ? { outcome } : {}), ...(futile ? { futile: true } : {}) });
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (cancel.cancelled || message === 'routine cancelled') {
          logDebug(this.villager.name, `routine '${skillName}' stopped after ${Date.now() - startedAt}ms`);
          this.villager.memory.append('event', `job '${skillName}' was stopped`, [skillName]);
          return;
        }
        if (isBenignPreemption(message)) {
          // A reflex freed the action chain mid-walk — the job loses its slot
          // but earns no strike; one 'job' wake-up lets the brain restart it.
          // (The host no longer also requests on job-failed — one incident,
          // one deliberation.)
          logDebug(this.villager.name, `routine '${skillName}' interrupted (benign) after ${Date.now() - startedAt}ms: ${message}`);
          this.villager.memory.append('event', `job '${skillName}' was interrupted (${message})`, [skillName]);
          this.villager.bus.emit({ type: 'job-failed', job: skillName, error: message });
          this.ctx.scheduler.request(
            this.villager.name,
            'job',
            `my job '${skillName}' was interrupted (${message}) — restart it or pick something else`
          );
          return;
        }
        logDebug(this.villager.name, `routine '${skillName}' FAILED after ${Date.now() - startedAt}ms: ${message}`);
        this.villager.memory.append('system', `job '${skillName}' failed: ${message}`, [skillName]);
        const tripped = this.villager.skills.recordError(skillName, message);
        const outcome = this.evaluateCheck(successCheck);
        if (outcome) {
          this.villager.memory.append('event', `job '${skillName}' a échoué — ${outcome}`, [skillName, 'objectif'], 7);
        }
        this.villager.bus.emit({ type: 'job-failed', job: skillName, error: message, ...(outcome ? { outcome } : {}) });
        // Queue immediate error deliberation on first failure — framed so the
        // model ACTS on it (try differently / adapt the skill), not just
        // acknowledges and goes back to the same loop.
        this.ctx.scheduler.request(
          this.villager.name,
          'error',
          `my routine '${skillName}' failed: ${message}. Address it NOW — retry a different way (other place, other resource, other tool), fix the skill with write_skill, or switch jobs. Do not just acknowledge.`
        );
        // Queue disabled notification only after 3 strikes
        if (tripped) {
          this.ctx.scheduler.request(
            this.villager.name,
            'job',
            `my routine '${skillName}' is DISABLED after repeated failures. Remove it or completely rewrite it.`
          );
        }
      })
      .finally(() => {
        clearTimeout(watchdog);
        if (this.current?.name === skillName) this.current = null;
      });

    return null;
  }

  private evaluateCheck(check?: SuccessCheck): string | null {
    return evaluateSuccessCheck(this.villager.bot(), check);
  }

  /** Stop the running routine (if any). Returns true if one was stopped. */
  stop(): boolean {
    if (!this.current) return false;
    this.current.cancel.cancelled = true;
    clearTimeout(this.current.watchdog);
    const bot = this.villager.bot();
    if (bot) {
      // Full abort, not a bare pathfinder.stop(): stop() alone leaves a latent
      // stopPathing flag on an idle pathfinder that self-cancels the NEXT
      // setGoal, and a cancelled collect can leak queued targets.
      void abortActiveTasks(bot);
    }
    log('info', `[village] ${this.villager.name} stopping routine '${this.current.name}'`);
    return true;
  }
}
