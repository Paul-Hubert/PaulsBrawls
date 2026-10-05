// ToolRegistry (layer 3, villagers/) — the villager's action vocabulary as a REGISTRY (S1): adding a
// tool is a row, never a branch. The skill tools (search/read/write/run) are the ONLY way a villager
// touches the world — there are no direct micro-action tools (go_to/dig/…); movement and work happen
// through run_skill on library skills, so every world effect is a journaled, criticizable run (04, P2).
//
// The villager view is TIER-FILTERED (02 §Tiers): write_skill's schema exposes NO `tier` field, so a
// villager-authored skill is always mortal; search/read/run go through the runner's mortal tier, so
// divine skills are invisible and unrunnable. dispatch returns a structured outcome the brain reads
// (authored draft / RunReport / report-to-god / done) so the brain owns the conversation loop + R20.
//
// M6 wires remember/recall to the real VillagerMemory (the M3 stubs are gone): the brain can now persist
// and retrieve episodic memory (04 §Memory). M5 wired subscribe/unsubscribe/list_subscriptions to the
// real SubscriptionStore. The tools degrade gracefully (honest "(non câblé)" strings) when a store is not
// wired, so M3/M4 tests that don't wire reactivity/memory keep the registry constructible.
//
// Trade (04 §Brain, Social): propose_trade / answer_trade / list_trades reach social/'s TradeBook only
// through the types/ TradeDesk seam (layer-3 actors never import each other). Consent is the book's job:
// propose_trade only puts an offer on the table; items move when the PARTNER answers accept:true.

import type { IJournal } from '../journal/journal';
import type { LlmToolCall, LlmToolDef } from '../llm/client';
import type { ConversationDesk, EventType, Filter, JsonSchema, RunnerRef, RunReport, SubscriptionHandler, TradeDesk, TradeItem } from '../types/index';
import { SkillLibrary } from '../skills/library';
import { SkillEngine } from '../skills/engine';
import { SkillRetriever } from '../skills/retrieve';
import { compile } from '../skills/instrument';
import { SubscriptionStore } from './subscriptions';
import { VillagerMemory } from './memory';

/** Per-deliberation dispatch context — who is acting, and the rollout draft being trialed (if any). */
export interface ToolContext {
  villager: string;
  runner: RunnerRef;
  /** Set inside a rollout: the current draft trial bypasses coalescing etc. and tags runs (D-11). */
  rolloutId?: string;
  /** The skill+version under authoring in this rollout — run_skill of THIS name trials the draft (P2). */
  draft?: { name: string; version: number };
}

/** The structured result of one tool call. `content` is what the LLM sees; the rest the brain reads. */
export interface ToolOutcome {
  content: string;
  /** Did the tool CALL succeed (vs. a usage error: not-found/oversize/parse/unknown)? A run that
   *  executed but FAILED is still ok:true — the brain got a RunReport. Defaults to true when omitted. */
  ok?: boolean;
  /** write_skill created/updated a draft. */
  authored?: { name: string; version: number };
  /** run_skill executed and produced a RunReport (failures included — P3). */
  ran?: RunReport;
  /** report_to_god text (a plea/objection — lands in God's queues). */
  reportedToGod?: string;
  /** done(summary, mood?) ended the deliberation. */
  done?: { summary: string; mood?: string };
}

/** Construction deps. */
export interface ToolRegistryOptions {
  library: SkillLibrary;
  engine: SkillEngine;
  retriever: SkillRetriever;
  journal: IJournal;
  /** R47 hard size cap on write_skill (decompose-or-reject — never truncate). */
  maxSkillLines: number;
  /** M5: the reactivity store backing subscribe/unsubscribe/list_subscriptions. Optional so M3/M4 tests
   *  that don't wire reactivity keep the tools as honest "(reactivity not wired)" stubs. */
  subscriptions?: SubscriptionStore;
  /** M6: resolve the ACTING villager's memory backing remember/recall. The registry is SHARED across all
   *  villagers (deliberation state lives in `ctx`, not the registry), so memory MUST be resolved per
   *  `ctx.villager` — a single instance would hand one villager's memory to every other. Returns undefined
   *  for an unknown actor (e.g. the avatar) → the tools degrade to an honest "(mémoire non câblée)" stub.
   *  Optional so M3/M4 tests keep honest stubs. The resolved VillagerMemory is the SAME instance main.ts
   *  injects into social/ via the MemoryWriter seam, so a conversation's leave-headline and a `remember`
   *  tool call land in one store (one writer, S2). */
  memoryFor?: (villager: string) => VillagerMemory | undefined;
  /** The trade book behind propose_trade/answer_trade/list_trades (main.ts wires social/'s TradeBook).
   *  Optional so tests that don't wire trade keep honest "(échange non câblé)" stubs. */
  trade?: TradeDesk;
  /** D-18: the conversation book behind say/tell/start_conversation (main.ts wires social/'s ConversationBook).
   *  Optional so tests that don't wire it keep honest "(conversation non câblée)" stubs. */
  conversations?: ConversationDesk;
}

const SCHEMA_OBJECT = { type: 'object' } as const;

/** The villager toolset. `definitions()` are the OpenAI function-calling schemas; `dispatch` runs one. */
export class ToolRegistry {
  constructor(private readonly opts: ToolRegistryOptions) {}

  /** The tier-filtered villager tool schemas (no divine field — 02 §Tiers). */
  definitions(): LlmToolDef[] {
    return [
      def('search_skills', 'Cherche dans la bibliothèque de skills; renvoie des lignes classées « nom — signature — résumé ».', {
        type: 'object',
        properties: { query: { type: 'string', description: 'ce que tu cherches (mots-clés)' } },
        required: ['query'],
      }),
      def('read_skill', 'Lis le code complet + le manifeste + les stats + les 3 derniers résultats d’un skill.', {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'number', description: 'optionnel; par défaut la version la plus récente non archivée' },
        },
        required: ['name'],
      }),
      // Tier-filtered: NO `tier` field — a villager always authors mortal skills (02 §Tiers).
      def('write_skill', 'Crée ou met à jour (upsert) un brouillon de skill. Renvoie les erreurs de parse en clair pour réessai immédiat.', {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string', description: 'une ligne décrivant ce que fait le skill' },
          params: { ...SCHEMA_OBJECT, description: 'JSON Schema des arguments' },
          returns: { ...SCHEMA_OBJECT, description: 'JSON Schema de la valeur de retour' },
          code: { type: 'string', description: 'async function nom(bot, args, ctx) { … } — nomme la fonction; seuls bot/args/ctx sont en portée. VÉRIFIE l’effet dans le monde avant de renvoyer { ok: true } (relis l’état, attribue tout gain d’items à CETTE exécution); sinon renvoie { ok: false, error: "<cause>" }.' },
        },
        required: ['name', 'summary', 'params', 'returns', 'code'],
      }),
      def('run_skill', 'Exécute un skill sur ton bot maintenant; renvoie la valeur résolue ou l’erreur en clair.', {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { ...SCHEMA_OBJECT, description: 'les arguments du skill' },
          timeoutMs: { type: 'number', description: 'optionnel; délai mur' },
        },
        required: ['name', 'args'],
      }),
      def('report_to_god', 'Rapporte à Dieu: progrès, objection, ou supplique.', {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      }),
      def('done', 'Termine cette délibération.', {
        type: 'object',
        properties: { summary: { type: 'string' }, mood: { type: 'string', description: 'optionnel; ton humeur' } },
        required: ['summary'],
      }),
      def('remember', 'Note un souvenir épisodique (texte + mots-clés optionnels).', {
        type: 'object',
        properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['text'],
      }),
      def('recall', 'Rappelle tes souvenirs les plus pertinents pour une requête (classés pertinence/récence/importance).', {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      def('subscribe', 'Crée un abonnement réflexe « quand X (filtré), fais Y » — Y est soit un skill (gratuit, zéro token) soit une délibération.', {
        type: 'object',
        properties: {
          on: { type: 'string', description: "le type d'évènement (hurt, player-chat, night-falls, tick-30s, …)" },
          handler: {
            ...SCHEMA_OBJECT,
            description: "{ kind:'skill', name, args } pour un réflexe gratuit, ou { kind:'deliberate', hint, priority? } pour réveiller ta réflexion",
          },
          filter: { ...SCHEMA_OBJECT, description: 'filtre déclaratif optionnel (within/entityKind/nameMatches/timeOfDay/healthBelow/foodBelow/notWhileRunning)' },
          cooldownMs: { type: 'number', description: 'période réfractaire optionnelle entre deux déclenchements' },
        },
        required: ['on', 'handler'],
      }),
      def('unsubscribe', 'Supprime un de tes abonnements par son id.', {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      }),
      def('list_subscriptions', 'Liste tes abonnements (id, évènement, action, filtre).', { type: 'object', properties: {} }),
      def('propose_trade', "Propose un échange à un autre villageois : tu donnes `give`, tu demandes `want`. Rien ne bouge tant qu'il n'accepte pas (answer_trade). L'offre expire après quelques minutes. « coin » = la pièce du village.", {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'le nom du villageois partenaire' },
          give: { type: 'array', items: TRADE_ITEM, description: 'ce que tu donnes (peut être vide)' },
          want: { type: 'array', items: TRADE_ITEM, description: 'ce que tu demandes en retour (peut être vide)' },
        },
        required: ['to', 'give', 'want'],
      }),
      def('answer_trade', "Réponds à une offre d'échange qu'on t'a faite : accept true l'exécute (vous devez être proches; tu marches vers l'autre si besoin), false la refuse. Le proposeur peut aussi retirer sa propre offre avec accept false.", {
        type: 'object',
        properties: { id: { type: 'string', description: "l'id de l'offre" }, accept: { type: 'boolean' } },
        required: ['id', 'accept'],
      }),
      def('list_trades', "Liste les offres d'échange en attente que tu as faites ou reçues.", { type: 'object', properties: {} }),
      // D-18 — speech. leave_conversation is not a tool: a conversation turn ends it with a structured reply.
      def('say', 'Dis une phrase à voix haute dans le chat du jeu (en français) ; les joueurs et villageois proches l’entendent.', {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      }),
      def('tell', 'Envoie un message privé à un autre villageois (il le reçoit dans sa boîte et peut te répondre).', {
        type: 'object',
        properties: { to: { type: 'string', description: 'le nom du villageois' }, text: { type: 'string' } },
        required: ['to', 'text'],
      }),
      def('start_conversation', 'Engage une vraie conversation (à tour de rôle) avec un villageois proche sur un sujet ; elle se déroule ensuite d’elle-même et chacun s’en souviendra.', {
        type: 'object',
        properties: { with: { type: 'string', description: 'le nom du villageois (à moins de 16 blocs)' }, topic: { type: 'string' } },
        required: ['with', 'topic'],
      }),
    ];
  }

  /** Execute one tool call. Never throws — every failure becomes a tool-result string for the LLM. */
  async dispatch(callMsg: LlmToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const a = (callMsg.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (callMsg.name) {
        case 'search_skills':
          return await this.searchSkills(String(a['query'] ?? ''), ctx);
        case 'read_skill':
          return this.readSkill(String(a['name'] ?? ''), typeof a['version'] === 'number' ? a['version'] : undefined);
        case 'write_skill':
          return this.writeSkill(a, ctx);
        case 'run_skill':
          return await this.runSkill(a, ctx);
        case 'report_to_god':
          return { content: 'Transmis à Dieu.', reportedToGod: String(a['text'] ?? '') };
        case 'done':
          return { content: 'Délibération terminée.', done: { summary: String(a['summary'] ?? ''), mood: typeof a['mood'] === 'string' ? a['mood'] : undefined } };
        case 'remember':
          return this.remember(a, ctx);
        case 'recall':
          return await this.recall(a, ctx);
        case 'subscribe':
          return this.subscribe(a, ctx);
        case 'unsubscribe':
          return this.unsubscribe(a, ctx);
        case 'list_subscriptions':
          return this.listSubscriptions(ctx);
        case 'propose_trade':
          return this.proposeTrade(a, ctx);
        case 'answer_trade':
          return await this.answerTrade(a, ctx);
        case 'list_trades':
          return this.listTrades(ctx);
        case 'say':
          return this.say(a, ctx);
        case 'tell':
          return this.tell(a, ctx);
        case 'start_conversation':
          return this.startConversation(a, ctx);
        default:
          return { content: `Erreur: outil inconnu "${callMsg.name}" (unknown tool).`, ok: false };
      }
    } catch (e) {
      // Defense in depth: the handlers already catch, but a tool result must never throw into the brain.
      return { content: `Erreur outil "${callMsg.name}": ${e instanceof Error ? e.message : String(e)}`, ok: false };
    }
  }

  private async searchSkills(query: string, ctx: ToolContext): Promise<ToolOutcome> {
    const ranked = await this.opts.retriever.search(query, { tier: ctx.runner.tier, villager: ctx.villager });
    if (ranked.length === 0) return { content: 'Aucun skill pertinent trouvé.' };
    const lines = ranked.map((s) => `${s.name} — ${s.signature} — ${s.summary}`);
    return { content: lines.join('\n') };
  }

  private readSkill(name: string, version?: number): ToolOutcome {
    const resolved = this.opts.library.read(name, version);
    if (!resolved) return { content: `Skill "${name}" introuvable (not found).`, ok: false };
    const m = resolved.manifest;
    const stats = this.foldStats(name);
    const last = stats.lastOutcomes.length > 0 ? stats.lastOutcomes.join(' | ') : '(aucun)';
    const content = [
      `skill "${m.name}" v${resolved.version.version} [${resolved.version.status}]`,
      `signature: ${m.signature}`,
      `résumé: ${m.summary}`,
      `description: ${m.description}`,
      `stats: runs=${stats.runs} successes=${stats.successes} failures=${stats.failures}`,
      `derniers résultats: ${last}`,
      `code:\n${resolved.code}`,
    ].join('\n');
    return { content };
  }

  private writeSkill(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const name = String(a['name'] ?? '').trim();
    const code = String(a['code'] ?? '');
    if (!name) return { content: 'Erreur: write_skill requiert un "name".', ok: false };
    if (!code) return { content: 'Erreur: write_skill requiert du "code".', ok: false };
    // R47: hard size cap — decompose-or-reject, NEVER truncate code (which blinds the critic).
    const lines = code.split('\n').length;
    if (lines > this.opts.maxSkillLines) {
      return {
        content: `Erreur: code de ${lines} lignes > maxSkillLines (${this.opts.maxSkillLines}). Décompose ce skill en sous-skills composés (R47) — le code n'est jamais tronqué.`,
        ok: false,
      };
    }
    // Parse + instrument up front so syntax/instrumentation errors come back inline for immediate retry.
    const compiled = compile(code);
    if (!compiled.ok) return { content: `Erreur de compilation du skill "${name}": ${compiled.error}`, ok: false };
    const sv = this.opts.library.upsertDraft({
      name,
      summary: String(a['summary'] ?? name),
      params: (a['params'] as JsonSchema) ?? { type: 'object', properties: {} },
      returns: (a['returns'] as JsonSchema) ?? { type: 'object', properties: {} },
      code,
      author: { kind: 'villager', name: ctx.villager },
    });
    return { content: `Brouillon "${name}" v${sv.version} créé (statut: draft).`, authored: { name, version: sv.version } };
  }

  private async runSkill(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const name = String(a['name'] ?? '').trim();
    const args = (a['args'] as object) ?? {};
    const timeoutMs = typeof a['timeoutMs'] === 'number' ? a['timeoutMs'] : undefined;
    if (!name) return { content: 'Erreur: run_skill requiert un "name".', ok: false };
    // Inside a rollout, running THIS rollout's draft trials the draft version (P2: drafts run only in
    // their own trial), with return validation; otherwise run the live (active/active-probation) version.
    const isDraftTrial = ctx.draft !== undefined && ctx.draft.name === name;
    try {
      const report = await this.opts.engine.run(name, args, ctx.runner, {
        rolloutId: ctx.rolloutId,
        ...(isDraftTrial ? { version: ctx.draft!.version, validateReturn: true } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      const content = report.outcome.ok
        ? `Succès. Valeur: ${JSON.stringify(report.outcome.value)}`
        : `Échec (${report.outcome.errorKind ?? 'Error'}): ${report.outcome.error}`;
      return { content, ran: report };
    } catch (e) {
      // Pre-execution problems (not found / tier / grant / args) throw — surface them verbatim (P2).
      return { content: `Erreur run_skill "${name}": ${e instanceof Error ? e.message : String(e)}`, ok: false };
    }
  }

  // ── M6 memory: remember / recall (04 §Memory) ─────────────────────────────────────────────────────
  private remember(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const mem = this.opts.memoryFor?.(ctx.villager);
    if (!mem) return { content: '(mémoire non câblée — souvenir ignoré)', ok: false };
    const text = String(a['text'] ?? '').trim();
    if (!text) return { content: 'Erreur: remember requiert un "text".', ok: false };
    const tags = Array.isArray(a['tags']) ? (a['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    // A villager-authored memory is a `thought` (its own reflection), not an observed event.
    mem.remember({ kind: 'thought', text, ...(tags && tags.length > 0 ? { tags } : {}) });
    return { content: 'Souvenir noté.' };
  }

  private async recall(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const mem = this.opts.memoryFor?.(ctx.villager);
    if (!mem) return { content: '(mémoire non câblée — aucun souvenir)' };
    const query = String(a['query'] ?? '').trim();
    if (!query) return { content: 'Erreur: recall requiert un "query".', ok: false };
    const hits = await mem.retrieve(query, 5);
    if (hits.length === 0) return { content: 'Aucun souvenir pertinent.' };
    return { content: hits.map((h) => `(${h.kind}) ${h.text}`).join('\n') };
  }

  // ── M5 reactivity: subscribe / unsubscribe / list_subscriptions (policy as data, P5) ──────────────
  private subscribe(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const store = this.opts.subscriptions;
    if (!store) return { content: '(réactivité non câblée — abonnement ignoré)', ok: false };
    const on = String(a['on'] ?? '').trim();
    const handler = a['handler'] as SubscriptionHandler | undefined;
    if (!on) return { content: 'Erreur: subscribe requiert "on" (le type d’évènement).', ok: false };
    if (!handler || (handler.kind !== 'skill' && handler.kind !== 'deliberate')) {
      return { content: "Erreur: subscribe requiert un handler { kind:'skill', name, args } ou { kind:'deliberate', hint }.", ok: false };
    }
    const sub = store.add({
      villager: ctx.villager,
      on: on as EventType,
      handler,
      ...(a['filter'] !== undefined ? { filter: a['filter'] as Filter } : {}),
      ...(typeof a['cooldownMs'] === 'number' ? { cooldownMs: a['cooldownMs'] } : {}),
      source: 'self',
    });
    return { content: `Abonnement créé (id ${sub.id}): quand "${on}", ${describeHandler(handler)}.` };
  }

  private unsubscribe(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const store = this.opts.subscriptions;
    if (!store) return { content: '(réactivité non câblée)', ok: false };
    const id = String(a['id'] ?? '').trim();
    if (!id) return { content: 'Erreur: unsubscribe requiert un "id".', ok: false };
    const sub = store.get(id);
    // A villager may only remove its OWN subscriptions (the brain acts on behalf of one villager).
    if (!sub || sub.villager !== ctx.villager) return { content: `Aucun abonnement "${id}" t’appartenant.`, ok: false };
    store.remove(id);
    return { content: `Abonnement "${id}" supprimé.` };
  }

  private listSubscriptions(ctx: ToolContext): ToolOutcome {
    const store = this.opts.subscriptions;
    if (!store) return { content: '(réactivité non câblée — aucun abonnement)' };
    const subs = store.list(ctx.villager);
    if (subs.length === 0) return { content: 'Aucun abonnement.' };
    const lines = subs.map((s) => {
      const filter = s.filter && Object.keys(s.filter).length > 0 ? ` [filtre: ${JSON.stringify(s.filter)}]` : '';
      const off = s.enabled ? '' : ' (désactivé)';
      return `${s.id} — quand "${s.on}"${filter} → ${describeHandler(s.handler)}${off}`;
    });
    return { content: lines.join('\n') };
  }

  // ── Speech: say / tell / start_conversation (D-18) ─────────────────────────────────────────────────
  private say(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const desk = this.opts.conversations;
    if (!desk) return { content: '(conversation non câblée — rien n’a été dit)', ok: false };
    const r = desk.say(ctx.villager, String(a['text'] ?? ''));
    return r.ok ? { content: 'Dit.' } : { content: `Non dit : ${r.reason}.`, ok: false };
  }

  private tell(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const desk = this.opts.conversations;
    if (!desk) return { content: '(conversation non câblée — message non envoyé)', ok: false };
    const to = String(a['to'] ?? '').trim();
    if (!to) return { content: 'Erreur: tell requiert "to" (le destinataire).', ok: false };
    const r = desk.tell(ctx.villager, to, String(a['text'] ?? ''));
    return r.ok ? { content: `Message envoyé à ${to}.` } : { content: `Message non envoyé : ${r.reason}.`, ok: false };
  }

  private startConversation(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const desk = this.opts.conversations;
    if (!desk) return { content: '(conversation non câblée — aucune conversation ouverte)', ok: false };
    const partner = String(a['with'] ?? '').trim();
    if (!partner) return { content: 'Erreur: start_conversation requiert "with" (le villageois).', ok: false };
    const r = desk.start(ctx.villager, partner, String(a['topic'] ?? ''));
    return r.ok
      ? { content: `Conversation engagée avec ${partner} (id ${r.id}) ; elle se poursuit d’elle-même.` }
      : { content: `Conversation impossible : ${r.reason}.`, ok: false };
  }

  // ── Trade: propose_trade / answer_trade / list_trades (04 §Brain, Social) ─────────────────────────
  private proposeTrade(a: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const desk = this.opts.trade;
    if (!desk) return { content: '(échange non câblé — offre ignorée)', ok: false };
    const to = String(a['to'] ?? '').trim();
    if (!to) return { content: 'Erreur: propose_trade requiert "to".', ok: false };
    const give = toTradeItems(a['give']);
    const want = toTradeItems(a['want']);
    if (!give || !want) return { content: 'Erreur: give et want doivent être des listes de { item, count }.', ok: false };
    const r = desk.propose({ from: ctx.villager, to, give, want });
    if (!r.ok) return { content: `Offre refusée: ${r.reason}`, ok: false };
    return { content: `Offre ${r.trade.id} envoyée à ${to}. Rien ne bouge tant qu'il n'a pas accepté.` };
  }

  private async answerTrade(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const desk = this.opts.trade;
    if (!desk) return { content: '(échange non câblé)', ok: false };
    const id = String(a['id'] ?? '').trim();
    if (!id) return { content: 'Erreur: answer_trade requiert "id".', ok: false };
    if (typeof a['accept'] !== 'boolean') return { content: 'Erreur: answer_trade requiert "accept" (true ou false).', ok: false };
    const accept = a['accept'];
    const r = await desk.answer(id, ctx.villager, accept);
    if (!accept) return r.ok ? { content: `Offre ${id} refusée.` } : { content: `Erreur: ${r.reason}`, ok: false };
    // An accepted trade that failed to settle is still a well-formed call: report the cause (nothing moved).
    return { content: r.ok ? `Échange ${id} conclu : les inventaires ont été échangés.` : `Échange ${id} non réglé (rien n'a bougé): ${r.reason}` };
  }

  private listTrades(ctx: ToolContext): ToolOutcome {
    const desk = this.opts.trade;
    if (!desk) return { content: '(échange non câblé — aucune offre)' };
    const trades = desk.pendingFor(ctx.villager);
    if (trades.length === 0) return { content: "Aucune offre d'échange en attente." };
    const fmt = (items: TradeItem[]): string => (items.length === 0 ? 'rien' : items.map((i) => `${i.count} ${i.item}`).join(', '));
    const lines = trades.map(({ id, offer, expiresAt }) => {
      const until = new Date(expiresAt).toISOString().slice(11, 16);
      return offer.from === ctx.villager
        ? `${id} — envoyée à ${offer.to}: tu donnes ${fmt(offer.give)} contre ${fmt(offer.want)} (expire ${until} UTC)`
        : `${id} — reçue de ${offer.from}: il donne ${fmt(offer.give)} contre ${fmt(offer.want)} (expire ${until} UTC)`;
    });
    return { content: lines.join('\n') };
  }

  /** Minimal stats fold from skill.run events (the views/ module formalizes this in M7). */
  private foldStats(name: string): { runs: number; successes: number; failures: number; lastOutcomes: string[] } {
    const events = this.opts.journal.query({ kinds: ['skill.run'], ref: name }).filter((e) => e.refs.skill === name);
    let successes = 0;
    let failures = 0;
    for (const e of events) {
      if ((e.payload as RunReport).outcome.ok) successes++;
      else failures++;
    }
    const lastOutcomes = events.slice(-3).map((e) => {
      const r = e.payload as RunReport;
      return r.outcome.ok ? 'OK' : `FAIL: ${r.outcome.error}`;
    });
    return { runs: events.length, successes, failures, lastOutcomes };
  }
}

const TRADE_ITEM = {
  type: 'object',
  properties: { item: { type: 'string', description: "nom d'item Minecraft (ex. bread, oak_log) ou « coin »" }, count: { type: 'integer', minimum: 1 } },
  required: ['item', 'count'],
} as const;

/** Coerce a tool arg into TradeItem[] (shape only — the book validates names/counts). undefined if not a list. */
function toTradeItems(v: unknown): TradeItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { item: String(o['item'] ?? '').trim(), count: typeof o['count'] === 'number' ? o['count'] : Number.NaN };
  });
}

function def(name: string, description: string, parameters: object): LlmToolDef {
  return { type: 'function', function: { name, description, parameters } };
}

/** A one-line human description of a subscription handler (for tool results — legible reflexes, P5). */
function describeHandler(h: SubscriptionHandler): string {
  return h.kind === 'skill' ? `exécute le skill "${h.name}"` : `réfléchis (« ${h.hint} »)`;
}
