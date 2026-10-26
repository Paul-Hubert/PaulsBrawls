import { log, logDebug } from '../logger.js';
import { ageOf, dispatchTool, DeliberationState, toolsFor } from './agent-tools.js';
import { VillageContext } from './context.js';
import { ChatMessage } from './llm-client.js';
import { normalizeKeyword, tokenize } from './memory-index.js';
import { buildObservation } from './observation.js';
import { LLMTier, MemoryEntry, ThinkRequest } from './types.js';
import { API_DTS } from './villager-api.js';
import { Villager } from './villager.js';

/**
 * The deliberation loop (L2 of the cognition stack). Stateless per call: each
 * wake-up rebuilds its context from the observation + memory, runs a short
 * tool loop, and writes conclusions back to memory. Conversations carry the
 * continuity; everything else is cheap-to-rebuild world state.
 */

const MAX_TOOL_ROUNDS = 6;

/** A line that is nothing but a function call, e.g. `done();` or `leave_conversation("bye");`. */
const PSEUDO_CALL = /^[A-Za-z_][\w.]*\(.*\)\s*;?\s*$/;

/**
 * Small models sometimes write their tool calls as plain text lines inside the
 * content ("done();", "leave_conversation();") instead of real tool calls —
 * and bot.chat splits on newlines, so each leaks into game chat as its own
 * message. Strip those lines from the spoken text and surface an inline
 * leave_conversation so the caller can honor the intent.
 */
export function extractSpokenText(content: string): { text: string; wantsLeave: boolean } {
  const lines = content.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const pseudo = lines.filter((l) => PSEUDO_CALL.test(l));
  return {
    text: lines.filter((l) => !PSEUDO_CALL.test(l)).join(' ').trim(),
    wantsLeave: pseudo.some((l) => l.includes('leave_conversation')),
  };
}

/**
 * Split a summarization reply into the new life summary and the trailing
 * marker lines (keywords + M10's salience numbers and lessons). Malformed or
 * missing markers → the whole reply is the summary (the pre-enrichment
 * behavior), never a corrupted one.
 */
export function parseSummaryReply(raw: string): {
  summary: string;
  keywords: string[];
  /** 1-based indices into the numbered memory batch the model deemed durable. */
  salient: number[];
  /** Durable lessons to store as high-importance thoughts. */
  insights: string[];
} {
  const kwMatch = raw.match(/^\s*(?:MOTS[-\s]?CL[ÉE]S|KEYWORDS)\s*:\s*(.+?)\s*$/im);
  const salientMatch = raw.match(/^\s*(?:SAILLANT|SALIENT)S?\s*:\s*(.+?)\s*$/im);
  const insightMatches = Array.from(raw.matchAll(/^\s*(?:LE[ÇC]ON|LESSON|INSIGHT)\s*:\s*(.+?)\s*$/gim));

  const keywords = kwMatch
    ? kwMatch[1].split(/[,;]+/).map((k) => k.trim()).filter((k) => k.length > 0).slice(0, 10)
    : [];
  const salient = salientMatch
    ? salientMatch[1]
        .split(/[^0-9]+/)
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n >= 1)
        .slice(0, 3)
    : [];
  const insights = insightMatches.map((m) => m[1].trim()).filter((s) => s.length > 0).slice(0, 2);

  const markerStarts = [kwMatch?.index, salientMatch?.index, insightMatches[0]?.index].filter(
    (i): i is number => i !== undefined
  );
  const cut = markerStarts.length > 0 ? Math.min(...markerStarts) : raw.length;
  return { summary: raw.slice(0, cut).trim(), keywords, salient, insights };
}

const RECALL_BLOCK_LIMIT = 6;
const RECALL_LINE_CHARS = 160;
const RECALL_QUERY_KEYWORDS = 24;
/** Importance given to entries/lessons the summarization pass flags as durable. */
const SALIENT_IMPORTANCE = 8;
const INSIGHT_IMPORTANCE = 8;
/** How many situation-relevant skills get their full code into the prompt. */
const RELEVANT_SKILLS_FULL_CODE = 4;
const CURRICULUM_OUTCOMES = 3;

/**
 * Older memories matching the current situation — semantic (when embeddings
 * are up) + keyword retrieval seeded from the wake-up reasons, inbox,
 * conversation partner and nearby names, ranked by relevance·recency·importance.
 * Excludes whatever RECENT MEMORIES already shows. Null when quiet.
 */
export async function buildRecallBlock(
  villager: Villager,
  req: ThinkRequest,
  inbox: Array<{ from: string; text: string }>,
  observation: Record<string, unknown>,
  recentEntries: MemoryEntry[]
): Promise<string | null> {
  const keywords = new Set<string>();
  const queryParts: string[] = [...req.reasons];
  for (const reason of req.reasons) for (const kw of tokenize(reason)) keywords.add(kw);
  for (const m of inbox) {
    keywords.add(normalizeKeyword(m.from));
    for (const kw of tokenize(m.text)) keywords.add(kw);
    queryParts.push(`${m.from}: ${m.text}`);
  }
  if (typeof observation.inConversationWith === 'string') {
    keywords.add(normalizeKeyword(observation.inConversationWith));
    queryParts.push(observation.inConversationWith);
  }
  const nearby = observation.nearby as
    | { villagers?: Array<{ name?: unknown }>; players?: Array<{ name?: unknown }> }
    | undefined;
  for (const bucket of [nearby?.villagers, nearby?.players]) {
    for (const entity of bucket ?? []) {
      if (typeof entity.name === 'string') {
        keywords.add(normalizeKeyword(entity.name));
        queryParts.push(entity.name);
      }
    }
  }
  if (keywords.size === 0) return null;

  const matches = await villager.memory.retrieve(queryParts.join('. ').slice(0, 500), {
    keywords: Array.from(keywords).slice(0, RECALL_QUERY_KEYWORDS),
    exclude: new Set<MemoryEntry>(recentEntries),
    limit: RECALL_BLOCK_LIMIT,
  });
  if (matches.length === 0) return null;

  const lines = matches.map((m) => `- [${m.kind}, ${ageOf(m.at)}] ${m.text}`.slice(0, RECALL_LINE_CHARS));
  return `RELEVANT OLDER MEMORIES (matched your situation):\n${lines.join('\n')}`;
}

export class AgentRuntime {
  private readonly ctx: VillageContext;

  constructor(ctx: VillageContext) {
    this.ctx = ctx;
  }

  /** Bound runner handed to the VillageScheduler. */
  readonly runner = (req: ThinkRequest): Promise<void> => this.deliberate(req);

  async deliberate(req: ThinkRequest): Promise<void> {
    const villager = this.ctx.villagers.get(req.botName);
    if (!villager) return;
    if (!villager.bot()) {
      villager.memory.append('system', `slept through a wake-up (${req.reasons[0] ?? '?'}) — not connected`);
      return;
    }

    const conversationMode = req.kind === 'conversation';
    const conv = this.ctx.conversations.get(villager.name);
    if (conversationMode && (!conv || conv.turnOf !== villager.name)) {
      return; // stale turn request (conversation ended or already moved)
    }

    const state: DeliberationState = {
      conversationMode,
      done: false,
      doneSummary: '',
      conversationMoved: false,
    };

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(villager, req) },
      { role: 'user', content: await this.userPrompt(villager, req) },
    ];

    // Latency tiering (M14): player-facing wake-ups ride the fast model;
    // planning, curriculum and skill authoring stay on the main one.
    const tier: LLMTier = req.kind === 'conversation' || req.kind === 'player' ? 'fast' : 'main';
    const tag = `${villager.name}/${req.kind}`;
    const startedAt = Date.now();
    let roundsRun = 0;
    logDebug(villager.name, `deliberation start kind=${req.kind} tier=${tier} reasons=${JSON.stringify(req.reasons)}`);

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS && !state.done; round++) {
        roundsRun = round + 1;
        const result = await this.ctx.llm.chat(messages, toolsFor(villager, this.ctx), { tier, tag });

        if (result.toolCalls.length === 0) {
          const { text, wantsLeave } = extractSpokenText(result.content);
          logDebug(villager.name, `deliberation round ${round + 1}: content-only reply "${text.slice(0, 150)}"${wantsLeave ? ' (wants leave)' : ''}`);
          if (conversationMode && text && !state.conversationMoved) {
            // Models often answer in plain content — treat it as the line.
            const error = this.ctx.conversations.say(villager.name, text.slice(0, 300));
            if (!error) state.conversationMoved = true;
          } else if (text) {
            villager.memory.append('thought', text.slice(0, 250));
          }
          if (conversationMode && wantsLeave) {
            const error = this.ctx.conversations.leave(villager.name, undefined);
            if (!error) state.conversationMoved = true;
          }
          break;
        }

        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const call of result.toolCalls) {
          // leave_conversation stays allowed after the turn passed: "say my
          // line, then leave" is the natural exit, and rejecting it kept
          // degenerate conversations alive for extra turns (seen live).
          const output =
            conversationMode && state.conversationMoved && call.name !== 'done' && call.name !== 'leave_conversation'
              ? 'your conversation turn already passed — wrap up with done'
              : await dispatchTool(villager, this.ctx, state, call.name, call.arguments);
          logDebug(villager.name, `tool ${call.name}(${call.arguments.slice(0, 200)}) → ${output.slice(0, 200)}`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: output.slice(0, 1_500) });
        }

        // A spoken line ends a conversation turn; give the model one wrap-up
        // round to call done, then cut.
        if (conversationMode && state.conversationMoved) {
          state.done = true;
        }
      }

      if (state.doneSummary) {
        villager.memory.append('thought', state.doneSummary.slice(0, 250));
      }
      logDebug(
        villager.name,
        `deliberation end kind=${req.kind} in ${Date.now() - startedAt}ms (${roundsRun} round(s))${state.doneSummary ? ` done="${state.doneSummary.slice(0, 120)}"` : ''}`
      );
    } catch (err) {
      // LLM down / timeout: degrade — reflexes and routines keep the village alive.
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `[village] ${villager.name} deliberation failed: ${message}`);
      logDebug(villager.name, `deliberation FAILED kind=${req.kind} after ${Date.now() - startedAt}ms (round ${roundsRun}): ${message}`);
      villager.memory.append('system', `my thoughts failed me (${message.slice(0, 120)})`);
    } finally {
      if (conversationMode && !state.conversationMoved) {
        this.ctx.conversations.forfeitTurn(villager.name);
      }
    }

    await this.maybeSummarize(villager);
  }

  // -- prompt assembly --------------------------------------------------------

  private systemPrompt(villager: Villager, req: ThinkRequest): string {
    const others = Array.from(this.ctx.villagers.values())
      .filter((v) => v.name !== villager.name)
      .map((v) => `${v.name} (${v.roster.role})`)
      .join(', ');

    // Voyager-style retrieval (M13): full code only for skills relevant to
    // this wake-up (+ all disabled ones); the rest stay one-line entries.
    const relevant = villager.skills.relevantSkills(req.reasons.join(' '), RELEVANT_SKILLS_FULL_CODE);

    const relations = villager.memory.topRelations(5)
      .map((r) => `${r.name}: ${r.score}${r.notes ? ` (${r.notes})` : ''}`)
      .join('; ') || '(no strong opinions yet)';
    const mood = villager.memory.mood();

    return [
      `You are ${villager.name}, the ${villager.roster.role} of a small Minecraft village.`,
      `Personality: ${villager.roster.personality}`,
      ...(mood ? [`Your current mood: ${mood} (update it via done's mood field when it shifts).`] : []),
      `The other villagers: ${others}.`,
      `Your opinions of people: ${relations}.`,
      '',
      'RULES:',
      '- Speak French in chat (say/tell), 1-2 short sentences, always in character.',
      '- Use tools to act. End every thinking session with the done tool.',
      "- Never attack villagers or players. Trade instead of stealing; coins ('coin' item) are the village currency.",
      '- Conversations are short and purposeful. Say your piece (1-2 lines), do the trade, then leave_conversation. Leave early if you have a job running or nothing new to add. Do not wait for the hard turn cap.',
      '- Promises are not actions. If you agree to give/trade/do something, CALL THE TOOL in the same session (give, propose_trade, start_job) — never answer with only words. In a conversation, act BEFORE you speak: your spoken line ends your turn.',
      '',
      'YOUR SKILL LIBRARY — three layers:',
      '',
      'Built-in (always active — you cannot change these; never reimplement them):',
      '- auto-eat: eats when food < 15 or health < 14, then restores whatever you were holding. Never write a hunger reflex.',
      '- auto-armor: equips your best armor whenever you pick armor up.',
      '- pathfinder: obstacle-aware navigation behind goTo() and flee().',
      '',
      'Your reflexes (event handlers — they fire automatically, without waking you; code shown only for the ones relevant right now):',
      villager.skills.promptBlock('reflex', relevant),
      '',
      'Your routines (job scripts — one at a time, run via start_job, cancel via stop_job):',
      villager.skills.promptBlock('routine', relevant),
      '',
      'SKILL-WRITING RULES (plain JavaScript against the API below; type-checked before it runs):',
      '- Reflexes: ONLY bot.on(event, handler) registrations at top level — no await, no sleep(), no bare actions outside a handler.',
      '- Routines: never use bot.on(). Use await freely and sleep() between passes (clamped to 5 min); try/catch around actions that can fail.',
      '- Prefer cheap reactions: a reflex that handles a recurring situation beats waking you up. Wake-ups are expensive.',
      '- One concern per skill. If a script does two unrelated things, split it.',
      "- COMPOSE instead of duplicating: inside a routine, `await bot.invokeSkill('other-routine')` runs one of your existing routines inline (depth cap 2). Never copy another skill's code into a new one.",
      '- Replace a skill (write_skill, same name) when you spot a bug or an edge case it misses — the code shown above is exactly what runs.',
      '- Delete a skill that is broken beyond repair, redundant with another, or no longer fits your role.',
      '- Keep descriptions honest about what the code actually does.',
      '- Three runtime errors DISABLE a skill. If one of yours is DISABLED, fix it with write_skill (same name) or remove it.',
      '```typescript',
      API_DTS,
      '```',
    ].join('\n');
  }

  private async userPrompt(villager: Villager, req: ThinkRequest): Promise<string> {
    const observation = buildObservation(villager, this.ctx);
    const inbox = villager.takeInbox();
    const recentEntries = villager.memory.recent(12);
    const recent = recentEntries.map((m) => `[${m.kind}] ${m.text}`).join('\n');
    const summary = villager.memory.summary();
    const recallBlock = await buildRecallBlock(villager, req, inbox, observation, recentEntries);

    const parts = [
      `WHY YOU ARE AWAKE (${req.kind}):`,
      ...req.reasons.map((r) => `- ${r}`),
      '',
      `OBSERVATION: ${JSON.stringify(observation)}`,
    ];
    if (inbox.length > 0) {
      parts.push('', 'UNREAD MESSAGES:', ...inbox.map((m) => `- ${m.from}: ${m.text}`));
    }
    if (summary) parts.push('', `YOUR LIFE SO FAR: ${summary}`);
    if (recallBlock) parts.push('', recallBlock);
    if (recent) parts.push('', 'RECENT MEMORIES:', recent);

    if (req.kind === 'heartbeat') {
      const outcomes = villager.memory
        .recall('objectif', { limit: CURRICULUM_OUTCOMES })
        .map((m) => `- ${m.text}`.slice(0, 140));
      parts.push('', [
        'PROGRESSION (curriculum):',
        outcomes.length > 0 ? `Tes derniers objectifs:\n${outcomes.join('\n')}` : "Tu n'as encore déclaré aucun objectif vérifiable.",
        "Choisis UNE prochaine étape qui te fait progresser, à ta portée mais pas triviale:",
        '- un job avec un objectif vérifiable (start_job + goalItem/goalCount) — le verdict revient tout seul;',
        '- ou une nouvelle compétence (write_skill) pour ce que tu rates souvent — compose avec invokeSkill;',
        "- ou répare/améliore une compétence existante. Un objectif manqué = la prochaine étape la plus instructive.",
      ].join('\n'));
    }

    if (req.kind === 'error') {
      parts.push('', [
        'TRAITE CETTE ERREUR MAINTENANT — un accusé de réception ne suffit pas. Choisis et EXÉCUTE une réponse dans cette session:',
        "- réessaie AUTREMENT tout de suite: autre ressource, autre endroit (go_to puis retente), autre outil;",
        '- ou adapte la compétence fautive avec write_skill — le code montré plus haut est exactement ce qui tourne; corrige la cause, pas le symptôme;',
        "- ou change d'objectif (start_job différent, set_day_plan) si cette voie est vraiment bouchée.",
        'Termine par une action concrète déjà lancée, pas une promesse. Si la même erreur revient malgré tout, ta prochaine session sera une révision de plan.',
      ].join('\n'));
    }

    if (req.kind === 'plan') {
      const routines = villager.skills.list()
        .filter((s) => s.kind === 'routine' && s.status === 'active')
        .map((s) => `job:${s.name}`);
      const needs = villager.memory.needs();
      parts.push('', [
        'PLANNING DU JOUR — appelle set_day_plan UNE fois, puis done:',
        `- Activités valides: ${[...routines, 'visit:<villageois>', 'home', 'idle'].join(', ')}.`,
        '- 3 à 5 créneaux couvrant la journée; la nuit (13000-23500) reste home sauf très bonne raison.',
        `- Tes besoins: repos ${needs.rest.toFixed(2)}, social ${needs.social.toFixed(2)} (0 = épuisé/isolé). Repos bas → allège le travail; social bas → prévois un visit:.`,
        '- Le planning s\'exécute tout seul — ne lance PAS de job toi-même ici.',
      ].join('\n'));
    }

    const convContext = this.ctx.conversations.contextFor(villager.name);
    if (convContext) parts.push('', convContext);

    return parts.join('\n');
  }

  // -- memory summarization -----------------------------------------------------

  private async maybeSummarize(villager: Villager): Promise<void> {
    if (!villager.memory.needsSummarization()) return;
    const batch = villager.memory.takeSummarizationBatch();
    const old = villager.memory.summary();
    logDebug(villager.name, `memory summarization start: folding ${batch.length} old entries (summary ${old.length} chars)`);
    const reply = await this.ctx.llm.complete(
      [
        `You compress a Minecraft villager's old memories into their running life summary. Keep names, debts, grudges, trades, discoveries. Max 150 words. Reply with the new summary, then these marker lines:`,
        `"SAILLANT: 3, 7" — numbers of up to 3 memories from the numbered list that matter long-term (omit if none do).`,
        `"LEÇON: <one short lesson>" — up to 2 durable lessons learned, one per line (omit if none).`,
        `Then ONE final line "MOTS-CLÉS: kw1, kw2, ..." listing up to 10 salient keywords (names, items, places) from the old memories.`,
      ].join('\n'),
      `CURRENT SUMMARY:\n${old || '(empty)'}\n\nOLD MEMORIES TO FOLD IN:\n${batch.map((m, i) => `${i + 1}. ${m.text}`).join('\n')}`,
      { tier: 'fast', tag: `${villager.name}/summarize` }
    );
    if (reply.trim()) {
      const { summary, keywords, salient, insights } = parseSummaryReply(reply);
      logDebug(
        villager.name,
        `memory summarization done: summary ${summary.length} chars, ${keywords.length} keyword(s), ${salient.length} salient, ${insights.length} lesson(s)`
      );
      villager.memory.setSummary(summary || reply.trim());
      // Batch-level enrichment: the refs are live archive objects, so the
      // extra tags land on persisted entries and reindex them.
      if (keywords.length > 0) villager.memory.enrichTags(batch, keywords);
      // Reflection rides the same call (M10): salient old entries get a
      // retrieval boost, lessons become durable high-importance thoughts.
      for (const idx of salient) {
        const entry = batch[idx - 1];
        if (entry) villager.memory.bumpImportance(entry, SALIENT_IMPORTANCE);
      }
      for (const insight of insights) {
        villager.memory.append('thought', `leçon: ${insight.slice(0, 200)}`, undefined, INSIGHT_IMPORTANCE);
      }
    } else if (old) {
      // LLM unavailable — keep the old summary; the batch stays searchable in the archive.
      logDebug(villager.name, `memory summarization: LLM unavailable — kept old summary (+${batch.length} faded)`);
      villager.memory.setSummary(`${old} (+${batch.length} older memories faded)`);
    }
  }
}
