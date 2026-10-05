---
id: eden.llm-and-scheduling
title: Eden LLM layer — client, providers, scheduler, budgets and embeddings
system: eden
summary: Exact behaviour of Eden's OpenAI-compatible LLM client, providers.json/api-keys.env, the lane scheduler (immunity, cooldown, rate cap, pause), BudgetTracker and embeddings.
tags: [eden, llm, openai, deepseek, lm-studio, providers, api-key, scheduler, lanes, rate-cap, cooldown, coalescing, budget, embeddings, transformers, debugPrompts, llm.call]
sources: [eden/src/llm/client.ts, eden/src/llm/scheduler.ts, eden/src/llm/embeddings.ts, eden/src/providers.ts, eden/providers.example.json, eden/api-keys.example.env, eden/src/config.ts, eden/src/main.ts, eden/src/villagers/brain.ts, eden/src/villagers/memory-summarizer.ts, eden/src/skills/describe.ts, eden/src/journal/kinds.ts, eden/eden.example.json, eden/.gitignore, eden/package.json, eden/tests/llm-client.test.ts, eden/tests/llm-scheduler.test.ts, eden/tests/llm-embeddings.test.ts, eden/tests/providers.test.ts, eden/tests/god-budget.test.ts]
verified_at: 4a8081f
---

# Eden LLM layer — client, providers, scheduler, embeddings

**TL;DR.** All Eden LLM traffic is OpenAI-compatible `POST {baseUrl}/chat/completions` through one `LlmClient` (two tiers: `strong`, `fast`), with a 180 s timeout that is never retried, up to 4 immediate retries on TCP resets only, and a metrics-only `llm.call` journal row per successful call. Providers come from `providers.json` (named presets) with keys read from the environment (`api-keys.env` loader, env wins, fail-loud if the declared var is unset). God desks and villager brains call through `LlmScheduler` (global `maxConcurrent`, 7 priority lanes, per-villager cooldown, same-kind coalescing, a 12/min rate cap) where the `god` lane and anything carrying a `rolloutId` bypass every suppression. Embeddings default to in-process `Xenova/paraphrase-multilingual-MiniLM-L12-v2` and degrade to a keyword floor after 3 consecutive failures.

## Files

| File | Layer | Role |
|---|---|---|
| `eden/src/llm/client.ts` | 2 | `LlmClient`, `ProviderRegistry`, request/response types, errors |
| `eden/src/llm/scheduler.ts` | 2 | `LlmScheduler`, `RateCappedError`, `BudgetTracker` |
| `eden/src/llm/embeddings.ts` | 2 | `EmbeddingsService`, `cosine`, `tokenize`, `keywordScore`, `providerBackend`, `localBackend` |
| `eden/src/providers.ts` | 1 | `loadProviders`, `resolveProvider`, `loadEnvFile` |
| `eden/providers.example.json` | — | template for `providers.json` (gitignored) |
| `eden/api-keys.example.env` | — | template for `api-keys.env` (gitignored) |
| `eden/src/main.ts:486-517` | root | wiring (`wireGod`) |

## Providers and keys

### Resolution at boot (`eden/src/main.ts:116-129`)
If `eden.json` has a top-level `"provider": "<name>"`:
1. `loadEnvFile(<dir of eden.json>/api-keys.env)` — loads `KEY=value` lines into `process.env`; **existing env vars win**; `#` comments and blank lines skipped; split on the first `=`; no-op if absent (`providers.ts:65-76`).
2. `loadProviders(<dir>/providers.json)` (JSONC + trailing commas tolerated) → `resolveProvider(presets, name)`; unknown name throws `providers: unknown provider "<name>" — available: a, b` (`providers.ts:82-89`).
3. `config.llm.providers = {strong, fast}` from the preset and `config.apiKeyEnv = preset.apiKeyEnv ?? undefined`.

Without `"provider"`, `llm.providers.{strong,fast}` from `eden.json` are used (defaults: empty `baseUrl`/`model`, budgets 48000/16000, `config.ts:113-114`); setting both warns that `llm.providers` is ignored (`config.ts:287-289`).

### `providers.json` schema (`providers.ts:12-17, 24-55`)

```jsonc
{
  "<name>": {
    "strong": { "baseUrl": "https://…/v1", "model": "…", "inputTokenBudget": 48000 },
    "fast":   { "baseUrl": "https://…/v1", "model": "…", "inputTokenBudget": 16000 },
    "apiKeyEnv": "OPENAI_API_KEY"   // env-var NAME; non-string/absent → null (no auth)
  }
}
```
Missing tier fields default to `baseUrl:''`, `model:''`, `inputTokenBudget` 48000 (strong) / 16000 (fast). Root or entry not an object → throws naming the file/entry. File not found → throws (only when `provider` is set).

Shipped presets (`eden/providers.example.json`):

| Preset | strong | fast | `apiKeyEnv` |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` · `deepseek-reasoner` · 48000 | same URL · `deepseek-chat` · 16000 | `DEEPSEEK_API_KEY` |
| `openai` | `https://api.openai.com/v1` · `gpt-4o` · 48000 | same · `gpt-4o-mini` · 16000 | `OPENAI_API_KEY` |
| `local` | `http://127.0.0.1:1234/v1` · `your-model-name` · 32000 | same · 16000 | `null` |

`eden/api-keys.example.env` lists `DEEPSEEK_API_KEY=` and `OPENAI_API_KEY=`. Both `providers.json` and `api-keys.env` are in `eden/.gitignore`.

### Key handling (`main.ts:496-506`, `client.ts:135,224,272-275`)
- If `config.apiKeyEnv` is set and `process.env[apiKeyEnv]` is empty → **boot throws** `llm: provider "<name>" requires <VAR>, but it is not set — put it in eden/api-keys.env or export it. The host does NOT fall back to OPENAI_API_KEY (R56).`
- If `apiKeyEnv` is undefined (local preset, or no `provider` key), the client's own default `process.env.OPENAI_API_KEY` applies.
- The key is sent as `authorization: Bearer <key>` **only** to non-local hosts. Local = hostname `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`; an unparseable `baseUrl` counts as remote (`client.ts:177-185`).
- The key is never written to config or journal; debug transcripts dump the request body only. `system.boot` journals the config through `redactSecrets`, which masks every key matching `/key|secret|token|password/i` (`main.ts:1148-1158`) — this also masks `inputTokenBudget`, `dailyTokens` and `apiKeyEnv`.

## LlmClient (`eden/src/llm/client.ts`)

### Types
```ts
type ModelTier = 'strong' | 'fast';                                         // :23
interface ProviderEntry { baseUrl: string; model: string; inputTokenBudget: number } // :26
interface LlmToolDef { type: 'function'; function: { name; description; parameters: object } } // :41
interface LlmMessage { role: 'system'|'user'|'assistant'|'tool'; content: string|null;
  toolCalls?: LlmToolCall[]; toolCallId?: string; name?: string }          // :54
interface LlmRequest { messages; tools?; toolChoice?: string | {type:'function', function:{name}};
  tier: ModelTier; caller: string; refs?: Refs; timeoutMs?: number }      // :66
interface LlmResult { callId; content: string|null; toolCalls: {id,name,arguments:object}[];
  finishReason: string; usage: {promptTokens, completionTokens, totalTokens}; latencyMs; retries } // :85
```

### Options and defaults (`:115-136`, `:215-225`)
| Option | Default |
|---|---|
| `timeoutMs` | `180_000` |
| `maxRetries` (reset retries) | `4` |
| `debugPrompts` | `false` (wired from `journal.debugPrompts`, `main.ts:506`) |
| `dataDir` | `'.eden-data'` |
| `fetchImpl` / `now` | global `fetch` / `Date.now` |
| `apiKey` | `process.env.OPENAI_API_KEY` |

### Request shape (`chat`, `:228-257`)
- URL: `${provider.baseUrl}/chat/completions` (baseUrl must include `/v1`).
- Body: `{model, messages}`; messages rendered by `toWire` (`:351-363`) — assistant tool calls become `tool_calls:[{id, type:'function', function:{name, arguments: JSON.stringify(args)}}]`, tool results carry `tool_call_id` and `name`.
- If `tools` non-empty: `tools` verbatim and `tool_choice = req.toolChoice ?? 'auto'`. `tool_choice` is never sent without tools.
- DeepSeek (hostname `api.deepseek.com` or `*.deepseek.com`): adds top-level `thinking: {type:'disabled'}` (R71 — thinking mode rejects forced `tool_choice`) (`:193-201, 239-241`).
- No `temperature`, `max_tokens` or streaming parameters are sent.

### Response parsing (`attempt`, `:298-318`)
Reads `choices[0]`: `content` (default `null`), `tool_calls` → `{id: tc.id ?? 'call_<i>', name, arguments: JSON.parse(arguments) or {} on failure}`, `finish_reason` (default `'stop'`), `usage.*` (default 0). Malformed tool-call JSON silently becomes `{}`.

### Retries and timeouts (R21)
| Failure | Behaviour |
|---|---|
| Fetch aborted by the timer | `LlmTimeoutError` ("… exceeded Nms — a timeout is final, not a retry (R21)"), **not retried** |
| Non-2xx | `LlmHttpError` (status + first 200 chars of body), **not retried** |
| Error with `code` (or `cause.code`) in `ECONNRESET`, `UND_ERR_SOCKET`, `EPIPE` | retried immediately (no back-off) up to `maxRetries`=4, then rethrown |
| Any other error | rethrown |

The abort timer covers only the `fetch` call (headers); it is cleared in `finally` **before** `res.json()` reads the body, so a stalled body read is not bounded by `timeoutMs`. `latencyMs` is measured from before the first attempt (includes retries).

### Journaling (`:320-334`)
On success only, one `llm.call` event, actor = `req.caller`:
```ts
{ caller, model, tier, latencyMs, promptTokens, completionTokens, finishReason, retries }
refs: { ...req.refs, llmCallId: callId }   // callId is a ULID
```
Never prompt or completion bodies. Failed calls (timeout/HTTP/reset exhaustion) are **not** journaled by the client.

Callers seen in code: `god:critic`, `god:curriculum`, `god:orchestrator`, `villager:<name>` (brain, `brain.ts:121`; also the memory summarizer, `memory-summarizer.ts:50`), and `god:describe` (DescriptionPass default, `skills/describe.ts:37` — not wired in production).

### debugPrompts transcripts (`:336, 340-348`)
When enabled, writes `<dataDir>/llm/<callId>.json` = `{request: <wire body>, response: <raw JSON>}` (pretty-printed). Best-effort (errors swallowed); headers are never written. Served by admin `GET /llm/:callId` via `readLlmTranscript` (`main.ts:708-717`; id must match `/^[A-Za-z0-9_-]+$/`).

## LlmScheduler (`eden/src/llm/scheduler.ts`)

Wired as `new LlmScheduler({maxConcurrent: llm.maxConcurrent, perVillagerCooldownMs: llm.perVillagerCooldownSeconds*1000})` (`main.ts:507`).

| Config / option | Default | Source |
|---|---|---|
| `llm.maxConcurrent` (alias `maxConcurrency`) | `3` | `config.ts:116, 139` |
| `llm.perVillagerCooldownSeconds` (alias `perVillagerCooldownSec`) | `15` | `config.ts:117, 139` |
| `rateCapPerMinute` (hardcoded, not a config key) | `12` | `scheduler.ts:79` |

### Request (`WakeupRequest<T>`, `:20-29`)
`{villager: string /* or 'god:<desk>' */, lane: Lane, kind: string, rolloutId?: string, run: () => Promise<T>}`.

### Lanes (highest first, `:15-16`)
`god` → `player` → `combat` → `conversation` → `directive` → `job` → `idle`. Selection = highest lane, then FIFO by enqueue sequence (`outranks`, `:196-201`). There is no ordering between God desks inside `god`.

Who uses which lane:
| Caller | Lane | kind |
|---|---|---|
| Critic | `god` | `critic` |
| Curriculum | `god` | `curriculum` / `qa` / `decompose` |
| Orchestrator | `god` | `orchestrator` |
| Brain, rollout deliberation | `directive` (default when `rolloutId` set) | `deliberate` |
| Brain, reactive wake-up | the subscription's lane (`main.ts:666`) | `reactive` |
| Brain, other | `idle` (default) | `deliberate` |

### `enqueue` algorithm (`:110-137`)
1. `bypass = lane === 'god' || rolloutId !== undefined`.
2. Non-bypass only: **rate cap** — per-`villager` counter in a fixed wall-clock minute window (`floor(now/60000)`); the 13th request in the same minute rejects immediately with `RateCappedError` (`rate cap: <v> exceeded the per-minute wake-up budget — throttled this minute (R36)`). The counter is incremented on every non-bypass enqueue, including ones that then coalesce.
3. Non-bypass only: **coalescing** — if a queued (not yet started), non-bypass entry has the same `(villager, kind)`, the caller is attached as an extra waiter and gets the same result/error; its own `run` is discarded.
4. Otherwise push and `scheduleDrain()` via `queueMicrotask`, so a synchronous burst lands before lane selection.

### Drain (`:160-212`)
- Nothing starts while paused.
- While `running < maxConcurrent`, pick the best eligible entry; non-bypass entries whose villager's `lastRunAt + cooldownMs > now` are skipped. If everything left is cooling down, an **unref'd** `setTimeout` re-drains at the earliest ready time (`:188-192`).
- `lastRunAt[villager]` is stamped at start and again at settle for every non-`god` lane (so cooldown is measured from completion). Rollout-immune requests also stamp it (affecting that villager's later non-immune requests) but ignore it themselves.
- A run occupies its slot until its promise settles. A whole multi-turn brain deliberation (including every `run_skill` executed inside it) is **one** slot (`brain.ts:96-107`).

### Pause (`:88-107`)
`pause()` holds all queued and future work, including `god` and rollout-immune calls; `resume()` re-drains. Wired to admin `POST /pause` / `POST /resume` (`main.ts:388-389`). `pending()` = queued count (admin `queueDepth`). Rate-cap counting still happens while paused.

### Not routed through the scheduler
`MemorySummarizer` (`villagers/memory-summarizer.ts:48`) and `DescriptionPass` (`skills/describe.ts:35`) call `client.chat` directly — outside `maxConcurrent` and pause.

## BudgetTracker (`scheduler.ts:227-258`)
- Constructed from `config.god.budget.perDesk` (`main.ts:508`): `{critic|curriculum|orchestrator: {dailyTokens: number|null}}`, default all `null`.
- `spend(desk, tokens)` — desks call it with `result.usage.totalTokens` after every call (critic, curriculum incl. QA, orchestrator). Villager brain spend is **not** tracked.
- `degraded(desk)` → `spent > cap` (strict); `null`/missing cap never degrades. `remaining(desk)` → `max(0, cap-spent)` or `null`.
- `resetDay()` clears all spend — **never called in production**, so caps are per process lifetime.
- Degrade behaviour per desk: see [god.md](god.md#budget-degrade-summary-d-13).

## Model tiers in practice

| Call site | Tier |
|---|---|
| Critic `judge` | `god.desks.critic.model` (default strong) |
| Curriculum `proposeTask` / `decompose` | `god.desks.curriculum.model` (default strong) |
| Curriculum QA `howTo` | `fast` (hardwired, `main.ts:563`) |
| Orchestrator `dispatch` | `god.desks.orchestrator.model` (default fast) |
| Villager rollout authoring/revision | `strong` (hardcoded, `main.ts:958`), budget `strong.inputTokenBudget` |
| Villager reactive wake-up | `fast`, budget `fast.inputTokenBudget` (`main.ts:663-664`) |
| Memory summarizer | fast (internal) |

`inputTokenBudget` is consumed only by the villager `ContextPackBuilder`; the client itself does not enforce it.

## Embeddings (`eden/src/llm/embeddings.ts`)

### Service
- `EmbeddingsService({backend?, maxFailures=3, onWarn?})`. `embed(texts)` returns `number[][]` or **`null`** (off or degraded) and never throws.
- R38: each backend error increments `consecutiveFailures`; a success resets it; at `>= 3` the service sets `degraded=true` for the rest of the process and calls `onWarn("embeddings: N consecutive failures — degrading to the keyword floor for this run (R38): <msg>")` (wired to `logger.warn('embeddings', …)`, `main.ts:516`). No re-enable path.
- No result caching inside the service; callers keep their own vectors (e.g. the curriculum QA cache stores the question vector in memory).

### Backends
| Backend | Behaviour |
|---|---|
| `localBackend(modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2')` (production default, `main.ts:515`) | lazily `import('@xenova/transformers')` (dependency `^2.17.2`) on first use; `pipeline('feature-extraction', modelId)` cached as a promise; embeds texts one at a time with `{pooling:'mean', normalize:true}`. A failed load leaves a rejected cached promise, so every later call fails until R38 degrades. |
| `providerBackend(baseUrl, model, apiKey?, fetchImpl?)` | `POST {baseUrl}/embeddings` `{model, input: texts}`, optional Bearer; non-2xx throws `embeddings: HTTP <status>`; count mismatch throws. Not wired by default (R59: never derive it from the chat provider). |
| none (`backend` omitted) | permanently `off` → always `null` |

### Similarity helpers
- `cosine(a,b)` over `min(len)`; 0 if either norm is 0.
- `tokenize(text)`: lowercase, split on non-`\p{L}\p{N}`, keep tokens of length ≥ 2 (accents kept).
- `keywordScore(q, d) = |overlap| / sqrt(|Q|·|D|)` in [0,1] — the floor used when `embed` returns null.

Consumers: `SkillRetriever`, `VillagerMemory` (relevance = `max(cosine, keywordScore)` per their docs), and the curriculum QA cache (threshold 0.92).

## Gotchas & known issues

- Cooldown re-drain uses an **unref'd** timer (`scheduler.ts:190-191`). If nothing else keeps the Node event loop alive, a cooled-down request never runs. In this checkout under Node 22.22 the tests `per-villager cooldown spaces out a villager’s runs` and the three following tests in `tests/llm-scheduler.test.ts` are **cancelled** ("Promise resolution is still pending but the event loop has already resolved"); the host is unaffected because the admin server keeps the loop alive.
- The rate-cap counter counts coalesced and paused requests too; a burst of coalesced wake-ups can still trip the cap.
- `LlmClient` timeout does not cover the response body read; reset retries have no back-off; failed calls leave no `llm.call` row.
- Malformed tool-call arguments become `{}` silently — desks then fall back (critic → keep-draft verdict; curriculum → no task).
- When `apiKeyEnv` is undefined (local preset or inline `llm.providers`), `OPENAI_API_KEY` from the environment is sent to any non-local `baseUrl`.
- `redactSecrets` over-masks: `inputTokenBudget`, `dailyTokens`, `apiKeyEnv` show as `***` in `system.boot`.
- `BudgetTracker.resetDay` is never called; villager-brain tokens are never budgeted.
- `MemorySummarizer` and `DescriptionPass` bypass the scheduler (not counted against `maxConcurrent`, not paused).
- A rollout deliberation holds a scheduler slot for its whole duration including skill runs (up to `runDefaultTimeoutMs` 120 s each, 16 tool turns), so 3 concurrent rollouts saturate `maxConcurrent:3`; `god` lane calls then wait despite their priority (priority only orders the queue, it does not preempt running work).

## Related

- [god.md](god.md) — desks that call the client, budget degrade behaviour
- [villager-runtime.md](villager-runtime.md) — brain, context pack, reactive wake-ups
- [villager-memory.md](villager-memory.md) — embeddings in memory retrieval, summarizer
- [skills-library.md](skills-library.md) — retriever, description pass
- [process-config-and-boot.md](process-config-and-boot.md) — `eden.json`, `providers.json`, `api-keys.env`
- [admin-api.md](admin-api.md) — `/pause`, `/resume`, `/llm/:callId`, queue depth
- [journal-and-views.md](journal-and-views.md) — `llm.call`
