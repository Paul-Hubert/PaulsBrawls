// GodBody (layer 3, god/) — typed sugar over the divine stock skills so non-LLM code paths (verdict
// delivery theatrics) don't hand-roll tool calls (03 §The body). God acts through skills like everyone
// else: appear-near / vanish / gesture are divine-tier library skills run on the avatar (Dieu), each a
// journaled skill.run. GodBody adds the semantic god.appearance event on top.
//
// "Theatrics with teeth, never a dependency." Every directive + critique already reaches its villager
// through the inbox (routeVerdict). When embodiedVerdicts is on, God ADDITIONALLY manifests to deliver
// notable verdicts in person. If the avatar is disconnected the divine run fails like any disconnected
// runner's and NOTHING functional degrades — deliverVerdict returns false, the loop still closes. So
// every method here is best-effort: it returns a boolean and never throws into the loop.

import type { RunnerRef, Verdict } from '../types/index';
import type { JournalAppender } from '../journal/journal';
import { SkillEngine } from '../skills/engine';

/** Construction deps. */
export interface GodBodyOptions {
  engine: SkillEngine;
  journal: JournalAppender;
  /** The avatar username (config god.name, default 'Dieu') — the only divine-tier runner. */
  avatarName: string;
  /** When false, deliverVerdict is a no-op (the inbox already delivered) — theatrics are optional. */
  embodiedVerdicts: boolean;
  now?: () => number;
}

/** Drives the avatar through the divine stock skills. Best-effort; the loop never depends on it. */
export class GodBody {
  private readonly engine: SkillEngine;
  private readonly journal: JournalAppender;
  private readonly embodiedVerdicts: boolean;
  private readonly runner: RunnerRef;

  constructor(opts: GodBodyOptions) {
    this.engine = opts.engine;
    this.journal = opts.journal;
    this.embodiedVerdicts = opts.embodiedVerdicts;
    this.runner = { name: opts.avatarName, role: 'god', tier: 'divine' };
  }

  /** Teleport the avatar next to a villager (divine skill `appear-near`). */
  appearNear(villager: string): Promise<boolean> {
    return this.runDivine('appear-near', { villager });
  }

  /** Send the avatar back to its parking spot (divine skill `vanish`). */
  vanish(): Promise<boolean> {
    return this.runDivine('vanish', {});
  }

  /** Play a body gesture (divine skill `gesture`): swing/jump/sneak/nod. */
  gesture(type: string): Promise<boolean> {
    return this.runDivine('gesture', { type });
  }

  /**
   * Deliver a verdict in person — gated on embodiedVerdicts (theatrics-never-a-dependency). Manifests
   * near the villager and gestures (nod on success, swing on failure). Journals one god.appearance with
   * ok:false when the avatar is down, so the miss is observable; never throws.
   */
  async deliverVerdict(opts: { villager: string; verdict: Verdict; rolloutId?: string }): Promise<boolean> {
    if (!this.embodiedVerdicts) return false; // the inbox path already delivered — nothing to do
    let ok = await this.appearNear(opts.villager);
    if (ok) ok = await this.gesture(opts.verdict.success ? 'nod' : 'swing');
    this.journal.append(
      'god:body',
      'god.appearance',
      { villager: opts.villager, action: 'verdict', ok },
      opts.rolloutId !== undefined ? { rolloutId: opts.rolloutId } : {},
    );
    return ok;
  }

  /** Run a divine skill on the avatar. Returns false (never throws) if the avatar is down or it fails. */
  private async runDivine(name: string, args: object): Promise<boolean> {
    try {
      const report = await this.engine.run(name, args, this.runner, {});
      return report.outcome.ok;
    } catch {
      // Avatar disconnected / not found / pre-execution error — theatrics fail softly (loop carries on).
      return false;
    }
  }
}
