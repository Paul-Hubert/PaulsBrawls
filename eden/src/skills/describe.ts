// DescriptionPass (layer 2) — Voyager's generate_skill_description, kept because self-written
// summaries drift aspirational (02 §Description-from-code). On every admission a FAST-tier LLM pass
// reads the FINAL code and writes `description` (and proposes `summary` + `tags`); the author's own
// summary is used for the draft and replaced by the derived one at admission. Cheap, not novelty —
// hence the fast tier (D-13). It must never throw into the admission flow: a bad reply degrades to a
// code-derived fallback that keeps the author's summary.

import type { LlmClient } from '../llm/client';

/** The manifest fields the pass derives from code. `summary`/`tags` are proposals (may be absent). */
export interface ManifestPatch {
  description: string;
  summary?: string;
  tags?: string[];
}

const SYSTEM_PROMPT = [
  'You are documenting a Minecraft (mineflayer) bot skill for a shared, reused skill library.',
  'Read the JavaScript code and describe what it does, derived strictly FROM the code — do not',
  'speculate about behavior the code does not contain (Voyager generate_skill_description).',
  'Reply with STRICT JSON only: {"description": string (3-6 sentences), "summary": string (one',
  'short line), "tags": string[] (1-4 lowercase topic tags)}. No prose outside the JSON.',
].join(' ');

/** Runs the description pass against a configured LLM client (fast tier). */
export class DescriptionPass {
  constructor(
    private readonly client: LlmClient,
    private readonly opts: { caller?: string } = {},
  ) {}

  /** Derive a manifest patch from the final code. Never throws — a bad reply yields a safe fallback. */
  async derive(name: string, code: string): Promise<ManifestPatch> {
    try {
      const result = await this.client.chat({
        tier: 'fast',
        caller: this.opts.caller ?? 'god:describe',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Skill name: ${name}\n\nCode:\n${code}\n\nReturn only the JSON object.`,
          },
        ],
      });
      return parsePatch(result.content, name, code);
    } catch {
      return fallback(name, code);
    }
  }
}

function parsePatch(content: string | null, name: string, code: string): ManifestPatch {
  if (!content) return fallback(name, code);
  const json = extractJson(content);
  if (!json) return fallback(name, code);
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const description = typeof obj['description'] === 'string' && obj['description'].trim().length > 0
      ? (obj['description'] as string)
      : fallback(name, code).description;
    const patch: ManifestPatch = { description };
    if (typeof obj['summary'] === 'string' && obj['summary'].trim().length > 0) patch.summary = obj['summary'] as string;
    if (Array.isArray(obj['tags'])) patch.tags = (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string');
    return patch;
  } catch {
    return fallback(name, code);
  }
}

/** Pull a JSON object out of a possibly-fenced reply (```json … ``` or bare). */
function extractJson(content: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const body = fenced ? fenced[1]! : content;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return body.slice(start, end + 1);
}

/** A safe, code-derived description; leaves `summary`/`tags` unset so the author's own are kept. */
function fallback(name: string, code: string): ManifestPatch {
  const firstLine = code.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return { description: `Skill "${name}". ${firstLine}`.slice(0, 240) };
}
