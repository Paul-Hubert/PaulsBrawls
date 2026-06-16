// ContextPackBuilder (layer 3, villagers/) — assembles every villager deliberation deterministically:
// same inputs → same prompt (04 §The context pack). Eight sections in fixed order, each with a token
// ceiling + truncation rule; the situation section uses the ONE shared Snapshot renderer (render/),
// also used by God's critic, so the villager and the critic see the world the same way.
//
// D-11 (the density invariant) lives here:
//   • The FRAME (the 8 sections) and the current DENSITY PAYLOAD (current draft + latest RunReport +
//     latest critique, built fresh from persisted artifacts) are NEVER trimmed (R47).
//   • Only PRIOR revision turns trim — oldest-first, as WHOLE tool-call/result pairs (R20). A
//     RevisionTurn bundles an assistant(tool_calls) message with its tool result(s), so trimming
//     literally cannot split a pair.
//   • The per-tier inputTokenBudget is the ceiling; the reserve invariant (config) guarantees a
//     rollout tier always fits frame + max-draft + RunReport + critique + headroom, so the frame and
//     payload never need trimming in practice.
//
// Every build journals brain.wakeup with its section sizes (05/D-11) — prompt bloat is measurable.
//
// villagers/ may import skills/, llm/, render/, journal/, types/ (all downward); it never imports
// god/ or social/ (the dependency law). It reaches God only through the inbox (a types/ interface).

import type { InboxMessage, Refs, RunnerRef, RunReport, Snapshot } from '../types/index';
import type { JournalAppender } from '../journal/journal';
import type { LlmMessage, ModelTier } from '../llm/client';
import type { RankedSkill } from '../skills/retrieve';
import { renderSnapshot } from '../render/snapshot';
import { renderRunReport } from '../render/run-report';
import { estimateTokens } from '../render/tokens';

/** A prior revision turn — an assistant tool-call message and its tool result(s), kept whole (R20). */
export interface RevisionTurn {
  assistant: LlmMessage;
  results: LlmMessage[];
}

/** The current density payload — current draft + latest RunReport + latest critique (never trimmed). */
export interface DensityPayload {
  draft?: { name: string; version: number; code: string };
  runReport?: RunReport;
  critique?: string;
}

/** Everything one deliberation's context needs. The brain assembles this; the builder renders it. */
export interface ContextPackInput {
  villager: string;
  runner: RunnerRef;
  // §1 Identity
  persona: string;
  role: string;
  mood?: string;
  standingOrders?: string;
  // §2 Trigger
  triggers: string[];
  hint?: string;
  // §3 Situation
  snapshot: Snapshot;
  // §4 Current activity
  runningSkill?: string | null;
  directive?: { goal: string; reason: string } | null;
  openTask?: { goal: string } | null;
  // §5 Recent past (the brain passes ~15 newest; the ceiling is a backstop)
  recentEvents: string[];
  // §6 Retrieved past (memory — minimal stub in M3, full port M6)
  memories: string[];
  // §7 Capabilities
  retrievedSkills: RankedSkill[];
  /** P2: the always-available stock primitive palette (name — signature — summary), composable via
   *  ctx.skills.run. Authoring packs render it (deduped vs retrieved + exemplars) so the base building
   *  blocks are present even when goal-retrieval ranks none of them. Optional → omitted = no palette. */
  primitives?: Array<{ name: string; signature: string; summary: string }>;
  exemplars: Array<{ name: string; code: string }>;
  /** Exemplar FULL code only when the wake-up plausibly involves authoring (04 §7). */
  includeExemplarCode: boolean;
  toolNames: string[];
  // §8 Pending inbox
  inbox: InboxMessage[];
  // Rollout density payload + prior revision history
  density?: DensityPayload;
  history?: RevisionTurn[];
  // Budget
  tier: ModelTier;
  inputTokenBudget: number;
}

/** The assembled pack: the messages to send + its measured composition (journaled as brain.wakeup). */
export interface ContextPack {
  messages: LlmMessage[];
  sectionSizes: Record<string, number>;
  totalTokens: number;
  trimmedPairs: number;
}

/** Per-section token ceilings (S7: hardcoded — nothing else reads them). Truncation is a backstop. */
const CEILINGS: Record<string, number> = {
  identity: 512,
  trigger: 1024,
  situation: 1024,
  activity: 512,
  recentPast: 1536,
  retrievedPast: 1536,
  capabilities: 16000,
  inbox: 2048,
};

const SECTION_ORDER = [
  'identity',
  'trigger',
  'situation',
  'activity',
  'recentPast',
  'retrievedPast',
  'capabilities',
  'inbox',
] as const;
type SectionKey = (typeof SECTION_ORDER)[number];

const HEADERS: Record<SectionKey, string> = {
  identity: 'IDENTITÉ',
  trigger: 'DÉCLENCHEUR',
  situation: 'SITUATION',
  activity: 'ACTIVITÉ',
  recentPast: 'MÉMOIRE RÉCENTE',
  retrievedPast: 'MÉMOIRE PERTINENTE',
  capabilities: 'CAPACITÉS',
  inbox: 'BOÎTE DE RÉCEPTION',
};

/** Construction deps. */
export interface ContextPackBuilderOptions {
  journal: JournalAppender;
}

/** Assembles + budgets a villager context pack, journaling its composition. */
export class ContextPackBuilder {
  constructor(private readonly opts: ContextPackBuilderOptions) {}

  /** Build the pack for one deliberation. `journalOpts.refs` ties the wake-up to its rollout. */
  build(input: ContextPackInput, journalOpts: { refs?: Refs } = {}): ContextPack {
    const raw = this.renderSections(input);
    const sectionSizes: Record<string, number> = {};
    const parts: string[] = [];
    for (const key of SECTION_ORDER) {
      const capped = cap(raw[key], CEILINGS[key]!);
      sectionSizes[key] = estimateTokens(capped);
      parts.push(`## ${HEADERS[key]}\n${capped}`);
    }
    const frame: LlmMessage = { role: 'system', content: parts.join('\n\n') };

    const densityMsg = renderDensity(input.density);

    // fitBudget: keep frame + density always; keep NEWEST whole revision turns that fit (R47/R20/D-11).
    const fixed = messageTokens(frame) + (densityMsg ? messageTokens(densityMsg) : 0);
    const turns = input.history ?? [];
    const kept: RevisionTurn[] = [];
    let used = fixed;
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = turnTokens(turns[i]!);
      if (used + cost <= input.inputTokenBudget) {
        kept.unshift(turns[i]!);
        used += cost;
      } else {
        break; // older turns precede this one — they drop too (oldest-first trim)
      }
    }
    const trimmedPairs = turns.length - kept.length;

    const messages: LlmMessage[] = [frame];
    for (const t of kept) {
      messages.push(t.assistant, ...t.results);
    }
    if (densityMsg) messages.push(densityMsg);

    const totalTokens = messages.reduce((s, m) => s + messageTokens(m), 0);

    this.opts.journal.append(
      `villager:${input.villager}`,
      'brain.wakeup',
      {
        villager: input.villager,
        triggers: input.triggers,
        sections: sectionSizes,
        totalTokens,
        trimmedPairs,
        tier: input.tier,
      },
      journalOpts.refs ?? {},
    );

    return { messages, sectionSizes, totalTokens, trimmedPairs };
  }

  private renderSections(input: ContextPackInput): Record<SectionKey, string> {
    return {
      identity: this.renderIdentity(input),
      trigger: this.renderTrigger(input),
      situation: renderSnapshot(input.snapshot),
      activity: this.renderActivity(input),
      recentPast: input.recentEvents.length > 0 ? input.recentEvents.join('\n') : '(rien de récent)',
      retrievedPast: input.memories.length > 0 ? input.memories.join('\n') : '(aucun souvenir pertinent)',
      capabilities: this.renderCapabilities(input),
      inbox: this.renderInbox(input),
    };
  }

  private renderIdentity(i: ContextPackInput): string {
    const lines = [i.persona, `Rôle: ${i.role}.`];
    if (i.mood) lines.push(`Humeur: ${i.mood}.`);
    if (i.standingOrders) lines.push(`Consignes permanentes de Dieu: ${i.standingOrders}`);
    return lines.join('\n');
  }

  private renderTrigger(i: ContextPackInput): string {
    const lines = i.triggers.length > 0 ? [...i.triggers] : ['(réveil sans déclencheur explicite)'];
    if (i.hint) lines.push(`Indice: ${i.hint}`);
    return lines.join('\n');
  }

  private renderActivity(i: ContextPackInput): string {
    const lines: string[] = [];
    lines.push(i.runningSkill ? `Skill en cours: ${i.runningSkill}` : 'Aucun skill en cours (au repos).');
    if (i.directive) lines.push(`Directive active: ${i.directive.goal} — parce que ${i.directive.reason}.`);
    if (i.openTask) lines.push(`Tâche ouverte: ${i.openTask.goal}`);
    return lines.join('\n');
  }

  private renderCapabilities(i: ContextPackInput): string {
    const lines: string[] = [];
    lines.push(`Outils: ${i.toolNames.join(', ')}`);
    // R60: steer away from search-looping — discovery is 1–2 calls, then act. (A hard cap backstops this.)
    lines.push(
      'Méthode : search_skills sert à DÉCOUVRIR (1–2 fois suffisent), pas à explorer en boucle. ' +
        'Ensuite AGIS — run_skill (ou write_skill puis run_skill pour une nouvelle compétence), puis done.',
    );
    if (i.retrievedSkills.length > 0) {
      lines.push('Compétences réutilisables — exécute-les avec run_skill, ou compose-les dans ton code avec ctx.skills.run :');
      for (const s of i.retrievedSkills) lines.push(`- ${s.name} — ${s.signature} — ${s.summary}`);
    }
    // P2 — the base primitive palette: the stock building blocks are ALWAYS available to compose, even when
    // task retrieval (top-k on the goal) ranks none of them. Authoring-only (you compose them in code via
    // ctx.skills.run); deduped against what is already shown (retrieved one-liners + exemplar full code) so a
    // skill is never listed twice. Without it, a villager whose goal didn't surface go-to/craft-item/… would
    // re-implement movement/crafting by hand — the same monolithic-skill failure mode P1 targets.
    if (i.includeExemplarCode && i.primitives && i.primitives.length > 0) {
      const shown = new Set([...i.retrievedSkills.map((s) => s.name), ...i.exemplars.map((e) => e.name)]);
      const palette = i.primitives.filter((p) => !shown.has(p.name));
      if (palette.length > 0) {
        lines.push('Briques de base toujours disponibles (compose-les avec ctx.skills.run) :');
        for (const p of palette) lines.push(`- ${p.name} — ${p.signature} — ${p.summary}`);
      }
    }
    // P1 — composition doctrine, only on an AUTHORING wake-up (the one that writes code). The composition
    // mechanism (ctx.skills.run) already exists and the exemplars use it, but nothing told the villager to
    // PREFER it — so drafts came out monolithic until they blew the maxSkillLines cap. State it up front
    // (docs/02 §power-ceiling specced exactly this — "compose go-to/craft-item, do not hand-roll"). The last
    // line is load-bearing: a callee must be ALREADY in the library (readRunnable = active/active-probation),
    // so composing a draft authored this same turn throws — telling the model avoids wasted tool turns.
    if (i.includeExemplarCode) {
      lines.push(
        'Composer plutôt que copier : avant d’écrire de la logique, regarde les compétences réutilisables ' +
          'ci-dessus et les exemples ci-dessous. Si l’une fait déjà une étape (se déplacer, miner, fabriquer, ' +
          'labourer, semer, utiliser un coffre…), APPELLE-la depuis ton code au lieu de la réécrire :',
      );
      lines.push('  await ctx.skills.run(\'go-to\', { x, y, z, range: 2 });');
      lines.push(
        'N’écris à la main que le comportement réellement nouveau. Garde chaque skill court et mono-tâche : ' +
          'un skill long qui enchaîne plusieurs étapes distinctes doit composer des sous-skills éprouvés. ' +
          'Tu ne composes qu’une compétence DÉJÀ dans la bibliothèque, jamais un brouillon écrit à l’instant.',
      );
      // D2 (finding from the live journal): drafts returned { ok: true } that the world contradicted —
      // a chest "deposit" that placed no chest, a "craft" that handed over pre-existing items. The critic
      // catches these by world-delta (D-12), but each false success burns a full author→run→judge→revise
      // cycle. State the doctrine at authoring time: confirm the world effect before claiming success.
      lines.push(
        'VÉRIFIE avant de réussir : ne renvoie { ok: true } qu’après avoir CONFIRMÉ dans le monde que l’effet ' +
          'visé a bien eu lieu — relis l’état réel (p. ex. bot.blockAt(pos) pour vérifier qu’un bloc/coffre posé ' +
          'existe et est du bon type ; compare un compte d’items AVANT vs APRÈS pour attribuer le gain à CETTE ' +
          'exécution). Ne réussis jamais depuis une précondition déjà vraie (déposer des items que tu possédais ' +
          'déjà) ni depuis un appel qui n’a fait que TENTER l’action. Si l’effet n’est pas confirmé, renvoie ' +
          '{ ok: false, error: "<cause nommée>" }.',
      );
    }
    if (i.includeExemplarCode && i.exemplars.length > 0) {
      lines.push('Exemples (code complet à imiter ; remarque les appels ctx.skills.run pour composer) :');
      for (const e of i.exemplars) lines.push(`// ${e.name}\n${e.code}`);
    }
    return lines.join('\n');
  }

  private renderInbox(i: ContextPackInput): string {
    if (i.inbox.length === 0) return '(vide)';
    return i.inbox
      .map((m) => `[${m.kind} de ${m.from}] ${JSON.stringify(m.payload)}`)
      .join('\n');
  }
}

/** Render the never-trimmed density payload as a final user message (the "act on this now" block). */
function renderDensity(d?: DensityPayload): LlmMessage | undefined {
  if (!d || (!d.draft && !d.runReport && d.critique === undefined)) return undefined;
  const parts: string[] = ['## TRAVAIL EN COURS (à réviser maintenant)'];
  if (d.draft) parts.push(`Brouillon actuel — skill "${d.draft.name}" v${d.draft.version}:\n${d.draft.code}`);
  if (d.runReport) parts.push(`Dernier RunReport:\n${renderRunReport(d.runReport)}`);
  if (d.critique !== undefined) parts.push(`Dernière critique de Dieu:\n${d.critique}`);
  return { role: 'user', content: parts.join('\n\n') };
}

/** Truncate text to a token ceiling, keeping the head and appending a marker (the truncation rule). */
function cap(text: string, ceilingTokens: number): string {
  if (estimateTokens(text) <= ceilingTokens) return text;
  const maxChars = Math.max(0, ceilingTokens * 4 - 16);
  return `${text.slice(0, maxChars)}\n…(tronqué)`;
}

/** Approximate token cost of one message (content + tool calls + ids + a small per-message overhead). */
function messageTokens(m: LlmMessage): number {
  let n = estimateTokens(m.content ?? '');
  if (m.toolCalls && m.toolCalls.length > 0) n += estimateTokens(JSON.stringify(m.toolCalls));
  if (m.name) n += estimateTokens(m.name);
  if (m.toolCallId) n += estimateTokens(m.toolCallId);
  return n + 4;
}

/** Token cost of a whole revision turn (assistant + all its tool results). */
function turnTokens(t: RevisionTurn): number {
  return messageTokens(t.assistant) + t.results.reduce((s, r) => s + messageTokens(r), 0);
}
