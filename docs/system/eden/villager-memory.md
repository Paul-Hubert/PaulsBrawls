---
id: eden.villagers.memory
title: Eden villager memory — window, archive, summarization, retrieval, R32 quarantine
system: eden
summary: VillagerMemory and MemorySummarizer — window/archive sizes, eviction-triggered fast-LLM summary + enrichment, the 0.5/0.25/0.25 retrieval blend, embeddings fallback, bots/<name>.json shape, R32 quarantine.
tags: [eden, villagers, memory, summarizer, retrieval, embeddings, keyword, recency, importance, relations, R32, R37, R38, persistence]
sources: [eden/src/villagers/memory.ts, eden/src/villagers/memory-summarizer.ts, eden/src/villagers/tools.ts, eden/src/llm/embeddings.ts, eden/src/types/memory.ts, eden/src/types/social.ts, eden/src/social/conversation.ts, eden/src/bots/anchors.ts, eden/src/bots/pool.ts, eden/src/village-launch.ts, eden/src/villagers/conversation-turn.ts, eden/src/views/index.ts, eden/src/main.ts, eden/src/admin/server.ts, eden/src/journal/kinds.ts, eden/tests/villagers-memory.test.ts, eden/tests/villagers-tools.test.ts, docs/04-villager-runtime.md]
verified_at: 98cb908
---

# Eden villager memory — window, archive, summarization, retrieval, R32 quarantine

**TL;DR.** One `VillagerMemory` per villager (`eden/src/villagers/memory.ts:91`) is the sole writer (S2) of that
villager's episodic window (200), archive (2000), relations and rolling life summary, persisted under the `memory` key
of `.eden-data/bots/<name>.json`. Overflowing the window evicts a batch (≥20) into the archive and asks a **fast-tier**
`MemorySummarizer` for a new summary + tag/importance enrichment + ≤2 `lesson` memories. Retrieval ranks
window+archive by `0.5·relevance + 0.25·recency(2 h half-life) + 0.25·importance/10`, relevance =
`max(embedding cosine, keyword overlap)`. A store stamped with a different world id is **quarantined** (R32) until
`resolveQuarantine('wipe'|'migrate')` — which **no admin route calls**; the in-game `/villagers restart` drops it as a
side effect (`reset()`, bug #16).

## Data model

`MemoryEntry` (`eden/src/types/memory.ts:2-9`):

| Field | Type | Notes |
|---|---|---|
| `kind` | `'event'\|'social'\|'trade'\|'thought'\|'system'\|'lesson'` | `lesson` = summarizer insight |
| `text` | string | |
| `tags` | string[] | caller's tags, else `deriveTags(text)` |
| `importance` | number 0–10 | caller's, else by kind; clamped |
| `at` | epoch ms | writer-assigned |

`Relation { other, score, note, at }` (`eden/src/types/memory.ts:16-24`). `MemorySeed { kind, text, tags?, importance? }` and the
`MemoryWriter` seam (`villager`, `remember(seed)`, `moveRelation(other, delta, note)`) are in
`eden/src/types/social.ts:20-40`; `VillagerMemory implements MemoryWriter` so `social/` can write without importing
`villagers/`.

### Default importance by kind (`eden/src/villagers/memory.ts:33-40`)

| kind | importance |
|---|---|
| `lesson` | 9 |
| `trade` | 6 |
| `social` | 5 |
| `event` | 4 |
| `thought` | 3 |
| `system` | 2 |

### Heuristic tags (`deriveTags`, `eden/src/villagers/memory.ts:389-397`)

Lowercase, split on non-letter/digit (Unicode), keep tokens of length ≥ 4 not in the stop set
`{les, des, une, avec, pour, dans, sur, and, the, for, with}`, dedupe, first **4** only.

## Constants

| Constant | Value | Code | Constructor override |
|---|---|---|---|
| `DEFAULT_WINDOW_MAX` | 200 | `eden/src/villagers/memory.ts:50` | `windowMax` |
| `DEFAULT_EVICT_BATCH` | 20 | `eden/src/villagers/memory.ts:51` | `evictBatch` |
| `DEFAULT_ARCHIVE_MAX` | 2000 | `eden/src/villagers/memory.ts:52` | `archiveMax` |
| `RELATION_SCORE_BAND` | ±100 (score clamp) | `eden/src/villagers/memory.ts:53` | — |
| `RECENCY_HALF_LIFE_MS` | 2 h (7 200 000 ms) | `eden/src/villagers/memory.ts:43` | — |
| `W_RELEVANCE / W_RECENCY / W_IMPORTANCE` | 0.5 / 0.25 / 0.25 | `eden/src/villagers/memory.ts:46-48` | — |

The host never overrides them (`eden/src/main.ts:622`: `new VillagerMemory({ villager, dataDir, journal, worldId, embeddings,
summarizer })`).

## API

| Method | Behaviour |
|---|---|
| `remember(seed)` (`:131`) | push entry to window (defaults: tags, importance, `at = now()`), `maybeEvict()`, `persist()`; returns the entry |
| `moveRelation(other, delta, note)` (`:146`) | `score = clamp(prev + delta, -100, 100)`, note replaced, persist |
| `recent(n)` (`:161`) | newest-first rendered lines `(<kind>) <text> [tags]` — **no caller in the host** |
| `all()` / `archive()` / `relations()` / `lifeSummary()` | copies of state (`lifeSummary` has no host caller) |
| `retrieve(query, k)` (`:193`) | ranked hits (see Retrieval), returns `RankedMemory = MemoryEntry & {score}` |
| `isQuarantined()` / `quarantinedCount()` / `resolveQuarantine(d)` | R32 (see below) |
| `reset()` (`:253-260`) | bug #16: clears window/archive/relations/summary **and any quarantine**, bumps a `generation` so an in-flight summary is discarded; does not write. Called by `/villagers restart` (`eden/src/main.ts:290-293`) after the launcher deletes `bots/<name>.json` (`eden/src/village-launch.ts:103-105`) |
| `flushSummary()` (`:264`) | await pending summarization (tests/shutdown) |

### Writers in the host

| Writer | Kind written | Code |
|---|---|---|
| `remember` tool (villager LLM) | `thought` (+ optional tags) | `eden/src/villagers/tools.ts:324-333` |
| social conversation (`ConversationBook` → `Conversation`, D-18) | `social` entries (heard and overheard lines at `OVERHEARD_IMPORTANCE = 3`; leave headline to both parties at `HEADLINE_IMPORTANCE = 8`); `moveRelation(other, opinion, note)` by the leaver | `eden/src/social/conversation.ts:63-66`, `:181-199` |
| trade notices (accept/refuse/settle, not the offer itself) | `trade`, tag `échange` | `eden/src/main.ts:673-677` |
| summarizer | `lesson` (≤2 per eviction) | `eden/src/villagers/memory.ts:306-315` |

The `ConversationBook` is built in `wireGod` and receives each villager's `VillagerMemory` as its `MemoryWriter`
(`eden/src/main.ts:683-721`), so live conversations write memories and relations.

Readers: `recall` tool (`retrieve(query, 5)`), reactive wake-up §6 (`retrieve(query, 5)`, `eden/src/main.ts:820`), rollout §6
(`retrieve(task.goal, 6)` once per task, `eden/src/main.ts:1280-1281`), a conversation turn (`retrieve("<partner> <topic>", 4)`,
`eden/src/villagers/conversation-turn.ts:55`), admin villager summary (`relations()` → `{name, score}`, `eden/src/main.ts:1107`).

## Eviction and summarization

### Trigger (`maybeEvict`, `eden/src/villagers/memory.ts:268-277`)

Runs on every `remember`. If `window.length > windowMax` (i.e. on the 201st entry):
`take = max(overflow, evictBatch)` → the **oldest** `take` entries (20 in practice) are spliced out, appended to the
archive, the archive is trimmed oldest-first to `archiveMax`, and `scheduleSummary(evicted)` is queued.

### Summarization (`scheduleSummary` + `MemorySummarizer`)

- Chained on a single `pendingSummary` promise (serialized per villager, off the hot path); any error is swallowed.
- Skipped entirely if no summarizer is wired (eviction still archives). The host always wires one
  (`new MemorySummarizer(client)`, `eden/src/main.ts:618`).
- `MemorySummarizer.summarize(villager, prevSummary, evicted)` (`eden/src/villagers/memory-summarizer.ts:44-63`): empty batch → `null`
  without an LLM call; otherwise one `client.chat({ tier: 'fast', caller: 'villager:<name>', messages })`.
  System prompt (French, `eden/src/villagers/memory-summarizer.ts:24-31`) demands strict JSON
  `{"summary": string, "tags": {"entry-0": string[], …}, "importanceBumps": {"entry-0": number, …}, "lessons": string[]}`.
  The user message lists `entry-<i> (<kind>, imp <importance>): <text>`.
- Parsing (`parseResult`/`extractJson`, `:66-92`): accepts a ```` ```json ```` fence or bare text, slices first `{` to
  last `}`; **no non-empty `summary` → null** (never a partial); `tags` kept only if every value is an array,
  `importanceBumps` only if every value is a number; `lessons` filtered to strings.

### Applying the result (`eden/src/villagers/memory.ts:289-317`)

| Field | Effect |
|---|---|
| `summary` | replaces the rolling summary (`result.summary \|\| prev`) |
| `importanceBumps["entry-i"]` | **sets** (not adds) `evicted[i].importance = clamp(v, 0, 10)` — mutates the archived objects |
| `tags["entry-i"]` | union-merged into `evicted[i].tags` |
| `lessons` | first 2 pushed into the **live window** as `{kind:'lesson', importance: 9, tags: deriveTags}` |

Then `persist()`. A null result degrades silently, and so does a result that lands after `reset()` (generation
check, `eden/src/villagers/memory.ts:293`).

## Retrieval (`retrieve`, `eden/src/villagers/memory.ts:193-216`)

Pool = **window + archive** (up to 2200 entries). For each entry:

```
kw        = keywordScore(query, text)              // set-cosine token overlap, tokens ≥ 2 chars (llm/embeddings.ts:93-100)
cos       = max(0, cosine(qVec, entryVec))         // 0 when embeddings off/degraded
relevance = max(cos, kw)
recency   = 0.5 ^ ((now - at) / 7_200_000)         // 1.0 now, 0.5 at 2 h, 0.25 at 4 h
importance= clamp(importance, 0, 10) / 10
score     = 0.5*relevance + 0.25*recency + 0.25*importance
```

Sorted descending, top `k` returned. Verified by `eden/tests/villagers-memory.test.ts:126`, `:146`, `:160`.

### Embeddings and keyword fallback (R38)

- The `EmbeddingsService` is shared host-wide with skill retrieval and the curriculum (`eden/src/main.ts:576-584`). Backend is
  `localBackend()` = in-process `@xenova/transformers` `Xenova/paraphrase-multilingual-MiniLM-L12-v2`,
  mean-pooled + normalized (`eden/src/llm/embeddings.ts:130-153`); dynamic import, so a missing package counts as a failure.
- `retrieve` calls `embed([query, ...poolTexts])` only when `embeddings.enabled()`; `null` → keyword floor.
- After **3 consecutive** `embed` failures (`maxFailures` default 3) the service sets `degraded = true` for the rest of
  the process and warns once via `logger.warn('embeddings', …)` (`eden/src/llm/embeddings.ts:44-63`). A success resets the streak.
- There is no embedding cache: every `retrieve` re-embeds the whole pool, one text at a time.

## Persistence (`.eden-data/bots/<name>.json`)

`file() = <dataDir>/bots/<villager>.json` (`eden/src/villagers/memory.ts:324-326`). The file is shared with `AnchorService`, which owns
the `anchors` key (`eden/src/bots/anchors.ts:160-187`). Both do read-modify-write of the whole JSON, each touching only
its own key.

```jsonc
{
  "anchors": { "home": {…}, "chest": {…} | null },   // bots/anchors.ts — not memory's
  "memory": {                                          // PersistedMemory, memory.ts:62-68
    "worldId": "<host>:<port>",                        // R32 stamp (main.ts:617)
    "window":  [ { "kind": "thought", "text": "…", "tags": ["…"], "importance": 3, "at": 1730000000000 } ],
    "archive": [ /* MemoryEntry, oldest-first, ≤ 2000 */ ],
    "relations": [ { "other": "Hervé", "score": 3, "note": "…", "at": 1730000000000 } ],
    "lifeSummary": "…"
  }
}
```

- `persist()` runs after every `remember`, `moveRelation`, applied summary and `resolveQuarantine`; it is a no-op
  while quarantined (`eden/src/villagers/memory.ts:358-379`). Writes are synchronous, pretty-printed (2-space).
- `load()` (`:329-355`): missing file / no `memory` key → empty; corrupt JSON → empty (re-persisted on next write).

## R32 world-stamp quarantine

`worldId` = `${config.minecraft.host}:${config.minecraft.port}` (`eden/src/main.ts:617`). On load, if
`persisted.worldId` is set and differs:

1. The persisted block is held in `this.quarantine`; live state starts **empty** (no reasoning from a dead world).
2. Journals `system.config-warning` (actor `villager:<name>`) with message
   `memory: "<name>" persisted world "<old>" != current "<new>" — <N> memories QUARANTINED behind an admin decision (wipe|migrate) (R32)`
   (`eden/src/villagers/memory.ts:340-349`).
3. `persist()` is suppressed so the old data on disk is not overwritten.

`resolveQuarantine(decision)` (`eden/src/villagers/memory.ts:234-246`):

| Decision | Effect |
|---|---|
| `wipe` | discard quarantined data; keep the current (empty-or-new) live state |
| `migrate` | **replace** live window/archive/relations/summary with the quarantined ones, trim archive |
| either | clear quarantine, `persist()` → re-stamped with the current world id |

Separately, `BotPool.start` stamps `<dataDir>/world.json {worldId, stampedAt}` and logs a mismatch warning
(`eden/src/bots/pool.ts:153-160`, `:362-373`); that file is independent of the per-bot memory stamp.

## Deliberate omissions

- **No `refuteBlockedBeliefs`** (R37) — the critic owns belief retirement; pinned by
  `eden/tests/villagers-memory.test.ts:247`.
- **No drives** here — rest/social live in `villagers/drives.ts` (optional, `behavior.drives`; see villager-runtime).

## Gotchas & known issues

- **No route resolves the quarantine.** `resolveQuarantine`, `isQuarantined` and `quarantinedCount` have no caller
  outside `memory.ts`/tests (the admin's `quarantine` route is for *skills*). A world change leaves every villager
  with empty memory and no persistence until `/villagers restart` (which deletes the file and `reset()`s, i.e. a wipe)
  or code calls `resolveQuarantine`. A restart also deletes the `anchors` key in the same file.
- **Quarantine silently loses new memories**: while quarantined, `remember` updates the in-memory window but nothing
  persists; `migrate` then *overwrites* those new entries with the old world's.
- `importanceBumps` **replace** importance rather than bump it (name is misleading).
- Lessons are pushed into the window without re-running `maybeEvict`, so the window can briefly exceed 200.
- `retrieve` embeds up to 2 200 texts per call with no cache, sequentially in-process — a latency/CPU cost on every
  reactive wake-up, `recall`, and rollout start; and one memory-path failure streak also degrades skill retrieval
  (shared `EmbeddingsService`).
- `recent()` and `lifeSummary()` are never used by the host, so the rolling summary and recent window never reach a
  prompt (§5 is always empty).
- `docs/04` says relations are "journal-derived views … rather than separate stores"; in code the live relations are
  stored in this file (a separate `RelationsView` fold over `conversation.ended` exists in `eden/src/views/index.ts:114`).
- `docs/04`'s entry-kind list omits `lesson`.

## Related

- [villager-runtime.md](villager-runtime.md) — where §6 retrieval and the `remember`/`recall` tools plug in
- [types-and-contracts.md](types-and-contracts.md) — `MemoryEntry`, `Relation`, `MemoryWriter`
- [social-and-trade.md](social-and-trade.md) — conversation memory writes and relation moves
- [llm-and-scheduling.md](llm-and-scheduling.md) — fast tier, EmbeddingsService
- [bots-and-hardening.md](bots-and-hardening.md) — anchors in the same bot file, `world.json` stamp
- [process-config-and-boot.md](process-config-and-boot.md) — `.eden-data/` layout, `minecraft.host/port`
- [admin-api.md](admin-api.md) — villager summary (relations), missing memory-quarantine route
