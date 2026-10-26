import { log, logDebug } from '../logger.js';
import { VillageContext } from './context.js';
import {
  CycleBudget,
  compileScript,
  isBenignPreemption,
  prepareScript,
  runWithTimeout,
  DEFAULT_INVOCATION_TIMEOUT_MS,
} from './sandbox.js';
import { typecheckScript } from './skill-typecheck.js';
import { API_DTS, buildScriptGlobals, ScriptApiOptions } from './villager-api.js';
import { Skill, VillageEvent, VillageEventType } from './types.js';
import type { Villager } from './villager.js';

/**
 * Installs and runs bot-authored reflexes (VILLAGE_PLAN §4 skill lifecycle):
 *
 *   draft → typecheck (tsc vs API_DTS) → AST guards → top-level run in
 *   'register' mode (bot.on captures handlers, world actions throw) → handlers
 *   subscribed → runtime errors strike the skill, three strikes disable it and
 *   queue feedback into the bot's next deliberation.
 *
 * The same mode-switch trick makes captured handlers work live: the options
 * object is shared between install and dispatch, and every API call checks
 * `mode` at call time — so after install flips it to 'live', the closed-over
 * API does real work.
 */

export interface InstallResult {
  ok: boolean;
  errors: string[];
}

export class ReflexEngine {
  private readonly villager: Villager;
  private readonly ctx: VillageContext;

  constructor(villager: Villager, ctx: VillageContext) {
    this.villager = villager;
    this.ctx = ctx;
  }

  /** Validate a script without running it (shared by reflex + routine paths). */
  validate(code: string): InstallResult {
    const typeErrors = typecheckScript(code, API_DTS);
    if (typeErrors.length > 0) return { ok: false, errors: typeErrors.slice(0, 10) };
    const prepared = prepareScript(code);
    if (!prepared.ok) return { ok: false, errors: prepared.errors };
    return { ok: true, errors: [] };
  }

  /** Install (or reinstall) one reflex skill: validate, run top level, subscribe. */
  async install(skill: Skill): Promise<InstallResult> {
    if (skill.kind !== 'reflex') return { ok: false, errors: [`${skill.name} is not a reflex`] };

    const typeErrors = typecheckScript(skill.code, API_DTS);
    if (typeErrors.length > 0) return { ok: false, errors: typeErrors.slice(0, 10) };
    const prepared = prepareScript(skill.code);
    if (!prepared.ok) return { ok: false, errors: prepared.errors };

    // Replacing an older version: drop its subscriptions first.
    this.uninstall(skill.name);

    const budget = new CycleBudget();
    const captured: Array<{ type: VillageEventType; handler: (e: VillageEvent) => void | Promise<void> }> = [];
    const opts: ScriptApiOptions = {
      mode: 'register',
      registrar: (type, handler) => captured.push({ type, handler }),
      budget,
    };
    const globals = buildScriptGlobals(this.villager, this.ctx, opts);

    try {
      const compiled = compileScript(prepared.instrumented);
      budget.reset();
      await runWithTimeout(() => compiled(globals, budget), 5_000, `install ${skill.name}`);
    } catch (err) {
      return { ok: false, errors: [`top-level run failed: ${err instanceof Error ? err.message : String(err)}`] };
    }

    if (captured.length === 0) {
      return { ok: false, errors: ['reflex registered no handlers — call bot.on(event, handler) at the top level'] };
    }

    // From here on the closed-over API does real work.
    opts.mode = 'live';

    const owner = `skill:${skill.name}`;
    for (const { type, handler } of captured) {
      this.villager.bus.subscribe(owner, type, (event) => this.runHandler(skill.name, budget, handler, event));
    }
    log('info', `[village] ${this.villager.name} installed reflex '${skill.name}' v${skill.version} (${captured.length} handler(s))`);
    logDebug(this.villager.name, `reflex '${skill.name}' v${skill.version} listens on: ${captured.map((c) => c.type).join(', ')}`);
    return { ok: true, errors: [] };
  }

  uninstall(skillName: string): void {
    this.villager.bus.unsubscribeOwner(`skill:${skillName}`);
  }

  /** (Re)install every active reflex in the library — used at boot. */
  async installAll(): Promise<void> {
    for (const skill of this.villager.skills.active('reflex')) {
      const result = await this.install(skill);
      if (!result.ok) {
        log('warn', `[village] ${this.villager.name} reflex '${skill.name}' failed to install: ${result.errors.join('; ')}`);
        this.villager.skills.recordError(skill.name, `install: ${result.errors[0] ?? 'unknown'}`);
      }
    }
  }

  private async runHandler(
    skillName: string,
    budget: CycleBudget,
    handler: (e: VillageEvent) => void | Promise<void>,
    event: VillageEvent
  ): Promise<void> {
    budget.reset();
    const startedAt = Date.now();
    logDebug(this.villager.name, `reflex '${skillName}' on ${event.type} start`);
    try {
      await runWithTimeout(
        () => Promise.resolve(handler(event)),
        DEFAULT_INVOCATION_TIMEOUT_MS,
        `reflex ${skillName}`
      );
      logDebug(this.villager.name, `reflex '${skillName}' on ${event.type} ok in ${Date.now() - startedAt}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isBenignPreemption(message)) {
        // Interrupted on purpose (e.g. self-defense stopped my walk) — no strike.
        logDebug(this.villager.name, `reflex '${skillName}' on ${event.type} interrupted (benign) after ${Date.now() - startedAt}ms: ${message}`);
        this.villager.memory.append('system', `my reflex '${skillName}' was interrupted on ${event.type}: ${message}`);
        return;
      }
      logDebug(this.villager.name, `reflex '${skillName}' on ${event.type} FAILED after ${Date.now() - startedAt}ms: ${message} (strike)`);
      this.villager.memory.append('system', `my reflex '${skillName}' failed on ${event.type}: ${message}`);
      const tripped = this.villager.skills.recordError(skillName, message);
      // Queue immediate error deliberation on first failure
      this.ctx.scheduler.request(
        this.villager.name,
        'error',
        `my reflex '${skillName}' failed on ${event.type}: ${message}. Try to fix it with write_skill or switch strategies.`
      );
      if (tripped) {
        this.uninstall(skillName);
        // Queue disabled notification after 3 strikes
        this.ctx.scheduler.request(
          this.villager.name,
          'job',
          `my reflex '${skillName}' is DISABLED after repeated failures. Remove it or rewrite it.`
        );
      }
    }
  }
}
