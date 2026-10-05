// ConversationTurner (layer 3, villagers/) — generates ONE villager's turn in a bot↔bot conversation (D-18). The
// conversation engine (social/conversation.ts) owns turn-taking, deadlines, the game-chat mirror and the
// leave_conversation effects; it asks each side for a turn through the types/ SpeakFn seam, and this module is
// the production SpeakFn: one FAST-tier LLM call (D-13 — chatter is not novelty) on the `conversation` lane,
// with the villager's persona, the topic, the relevant memories and the transcript so far.
//
// The reply is strict JSON — {"say": "..."} to speak, or {"leave": {opinion, note, headline}} to end the
// conversation (leave_conversation is this structured output, not a tool). A reply that is not JSON but is plain
// text is taken as the line said (models drift); an empty or unusable reply ends the conversation politely.
//
// Imports llm/ + types/ (downward) and the sibling memory module; never social/ or god/.

import type { LlmClient } from '../llm/client';
import type { LlmScheduler } from '../llm/scheduler';
import type { LeaveDecision, SpeakFn, SpeakResult, TranscriptLine } from '../types/index';
import type { VillagerMemory } from './memory';

/** Who is speaking, to whom, about what — the per-side facts the turn prompt needs. */
export interface TurnContext {
  self: string;
  partner: string;
  topic: string;
  /** The villager's persona line (French). */
  persona: string;
}

const SYSTEM_PROMPT = [
  'Tu es un villageois de Minecraft (un bot) qui parle français, en conversation avec un autre villageois.',
  'Reste dans ton personnage, sois bref (une ou deux phrases), concret et utile au village.',
  'À chaque tour, réponds en JSON STRICT uniquement, sans prose autour, avec UNE des deux formes :',
  '{"say": "ta réplique"} pour parler, ou',
  '{"leave": {"opinion": <entier de -10 à 10, ce que tu penses maintenant de ton interlocuteur>,',
  '"note": "une courte note sur votre relation", "headline": "une phrase qui résume la conversation"}}',
  'pour la terminer. Termine dès que le sujet est épuisé ; ne tourne pas en rond.',
].join(' ');

const MAX_SAY = 250; // under mineflayer's 256-char chat chunk (social/conversation.ts chatSafe)

/** Builds production SpeakFns — one fast-tier LLM call per turn, scheduled on the conversation lane. */
export class ConversationTurner {
  constructor(
    private readonly deps: {
      client: LlmClient;
      scheduler: LlmScheduler;
      /** The villager's memory, for a few relevant recollections (optional). */
      memoryFor?: (villager: string) => VillagerMemory | undefined;
    },
  ) {}

  /** The SpeakFn for one side of one conversation. Each call is one scheduled LLM turn. */
  speakFn(ctx: TurnContext, conversationKey: string): SpeakFn {
    let turn = 0;
    return async (transcript: readonly TranscriptLine[]): Promise<SpeakResult> => {
      turn++;
      const memories = (await this.deps.memoryFor?.(ctx.self)?.retrieve(`${ctx.partner} ${ctx.topic}`, 4)) ?? [];
      const content = await this.deps.scheduler.enqueue({
        villager: ctx.self,
        lane: 'conversation',
        // Unique per turn: two turns of one villager must never coalesce into one reply.
        kind: `conversation:${conversationKey}:${turn}`,
        run: async () =>
          (
            await this.deps.client.chat({
              tier: 'fast',
              caller: `villager:${ctx.self}`,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: renderTurn(ctx, transcript, memories.map((m) => `(${m.kind}) ${m.text}`)) },
              ],
            })
          ).content,
      });
      return parseTurn(content);
    };
  }
}

/** The user message for one turn: who/what, recollections, and the transcript so far. */
export function renderTurn(ctx: TurnContext, transcript: readonly TranscriptLine[], memories: string[]): string {
  const said = transcript.length > 0 ? transcript.map((l) => `${l.from}: ${l.text}`).join('\n') : '(personne n’a encore parlé — tu ouvres la conversation)';
  return [
    `Tu es ${ctx.self}. ${ctx.persona}`,
    `Tu parles avec ${ctx.partner}. Sujet : ${ctx.topic}`,
    `Souvenirs utiles :\n${memories.length > 0 ? memories.join('\n') : '(aucun)'}`,
    `Conversation jusqu’ici :\n${said}`,
    'Ton tour. Renvoie uniquement l’objet JSON.',
  ].join('\n\n');
}

/** Parse a turn reply: {"say"} / {"leave"} JSON (fenced or not), plain text as a line, else a polite leave. */
export function parseTurn(content: string | null | undefined): SpeakResult {
  const text = String(content ?? '').trim();
  if (!text) return politeLeave();
  const json = extractJson(text);
  if (json && typeof json === 'object') {
    const o = json as { say?: unknown; leave?: unknown };
    if (typeof o.say === 'string' && o.say.trim()) return { say: o.say.trim().slice(0, MAX_SAY) };
    if (o.leave && typeof o.leave === 'object') return { leave: normalizeLeave(o.leave as Partial<LeaveDecision>) };
    return politeLeave();
  }
  return { say: text.replace(/\s+/g, ' ').slice(0, MAX_SAY) };
}

function normalizeLeave(l: Partial<LeaveDecision>): LeaveDecision {
  const op = typeof l.opinion === 'number' && Number.isFinite(l.opinion) ? Math.max(-10, Math.min(10, Math.round(l.opinion))) : 0;
  return {
    opinion: op,
    note: typeof l.note === 'string' && l.note.trim() ? l.note.trim().slice(0, 120) : 'conversation terminée',
    headline: typeof l.headline === 'string' && l.headline.trim() ? l.headline.trim().slice(0, 200) : 'Une conversation a eu lieu.',
  };
}

function politeLeave(): SpeakResult {
  return { leave: { opinion: 0, note: 'conversation terminée', headline: 'Une conversation a eu lieu.' } };
}

/** The first JSON object in a reply (tolerates ``` fences and surrounding prose), or undefined. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
