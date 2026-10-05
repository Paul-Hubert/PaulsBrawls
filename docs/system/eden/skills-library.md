---
id: eden.skills.library
title: Eden skill library — storage, manifest, status machine, retrieval
system: eden
summary: Where Eden skills live on disk, the manifest/version shape, the D-12 status machine with exact thresholds, write_skill caps, retrieval scoring and the description pass.
tags: [eden, skills, library, versioning, probation, quarantine, retrieval, embeddings, write_skill, manifest]
sources: [eden/src/skills/library.ts, eden/src/skills/retrieve.ts, eden/src/skills/describe.ts, eden/src/skills/exemplars/index.ts, eden/src/skills/engine.ts, eden/src/types/skill.ts, eden/src/types/enums.ts, eden/src/llm/embeddings.ts, eden/src/villagers/tools.ts, eden/src/god/god.ts, eden/src/journal/kinds.ts, eden/src/journal/journal.ts, eden/src/views/index.ts, eden/src/config.ts, eden/src/main.ts, eden/tests/skills-library.test.ts, eden/tests/skills-retrieve.test.ts, eden/tests/skills-describe.test.ts, eden/tests/skills-engine.test.ts, docs/02-skill-system.md]
verified_at: 4a8081f
---

# Eden skill library — storage, manifest, status machine, retrieval

**TL;DR.** `SkillLibrary` (`eden/src/skills/library.ts`) is the single writer of skill state (S2). It is
**not** stored in SQLite: each skill is a directory `<dataDir>/library/<name>/` holding append-only
`v<k>.js` code files plus one `skill.json` index (all versions + per-version manifest). Status moves
`draft → active-probation → active`, with `quarantined` (self-heals back to `active-probation`) and
`archived`. The "live" version is the **highest-numbered** `active`/`active-probation` one. Retrieval is
tier- and grant-filtered, scored `max(embedding cosine, keyword overlap)`, top-8.

## Where things live

| Concern | File | Notes |
|---|---|---|
| Library (state, versions, status machine, signature render) | `eden/src/skills/library.ts` | `SkillLibrary`, `AllGranted`, `renderSignature` |
| Retrieval | `eden/src/skills/retrieve.ts` | `SkillRetriever.search` |
| Description-from-code pass | `eden/src/skills/describe.ts` | `DescriptionPass.derive` |
| Stock seed | `eden/src/skills/exemplars/index.ts` | `STOCK_SKILLS`, `seedStockSkills` — see [stock-skills.md](stock-skills.md) |
| Type shapes | `eden/src/types/skill.ts`, `eden/src/types/enums.ts` | `SkillManifest`, `SkillVersion`, `SKILL_STATUSES` |
| Villager-facing tools (`search_skills`/`read_skill`/`write_skill`/`run_skill`) | `eden/src/villagers/tools.ts:82-115, 194-268` | the only authoring/reading surface for villagers |
| Verdict → library action | `eden/src/god/god.ts:149-184` | `GodService.routeVerdict` |
| Wiring | `eden/src/main.ts:519-534, 550, 583-591` | library, seed, engine, retriever, tools, prompt exemplars |

## On-disk layout

`dataDir` defaults to `.eden-data` (`eden/src/main.ts:108`).

```
.eden-data/
  library/
    <skill-name>/            # join(dataDir, 'library', name)           library.ts:361-363
      v1.js                  # raw author code, written once, never rewritten  library.ts:365-371
      v2.js
      skill.json             # the whole SkillRecord, rewritten on every mutation  library.ts:373-378
```

- `skill.json` is `JSON.stringify(record, null, 2)` of `{ name, records: [{ version: SkillVersion, manifest: SkillManifest }, …] }` (`library.ts:61-69, 377`). The manifest is stored **per version** (it can evolve across versions).
- `codePath` inside each `SkillVersion` is the path string as joined at write time (relative to the process cwd when `dataDir` is relative).
- **Boot load** (`library.ts:380-393`): for every top-level directory under `library/`, read `skill.json`; a corrupt JSON is silently skipped (that skill vanishes from the library, its files remain). Directories without `skill.json` are ignored.
- Live state is persisted files, not event-sourced (S5); the journal is written alongside as history (`library.ts:10-11`).

### SQLite involvement

The library writes **no SQLite table of its own**. The only table in `eden.db` is `journal`
(`eden/src/journal/journal.ts:51-58`: `id, at, actor, kind, payload, refs`, with expression indexes on
`refs.$.runId`, `refs.$.rolloutId`, `refs.$.skill`). Library mutations append journal rows:

| Kind | Payload (`eden/src/journal/kinds.ts:99-106`) | Actor | Emitted by |
|---|---|---|---|
| `skill.draft` | `{name, version, author, tier, lines}` | `villager:<name>` / `god:authoring` / `engine` (stock) | `upsertDraft` (`library.ts:119-125`) — also every stock re-seed |
| `skill.admit` | `{name, version, provenance?}` | `god:critic` | `admit` (`library.ts:147-152`), `unquarantine` (no provenance, `library.ts:196-199`) |
| `skill.quarantine` | `{name, version, reason}` | always `engine` | `quarantine` (`library.ts:178-181`) |
| `skill.archive` | `{name, version}` | `god:critic` | `archive` (`library.ts:219`) |
| `skill.run` | full `RunReport` | `villager:<name>` or `god:body` | the engine — see [skills-engine.md](skills-engine.md) |
| `skill.log` | `{skill, message}` | same as run | `ctx.log` |

Refs carry `skill` + `skillVersion` (and `rolloutId`/`verdictId` for admit). Skill **stats**
(`runs/successes/failures/stalls/avgMs/lastError`) are never stored — `SkillStatsView` folds them from
`skill.run` (`eden/src/views/index.ts:36-60`); `read_skill` folds its own stats from the journal
(`eden/src/villagers/tools.ts:339`).

## Manifest and version shape

`SkillManifest` (`eden/src/types/skill.ts:19-30`), built by `buildManifest` (`library.ts:301-313`):

| Field | Type | Source / default |
|---|---|---|
| `name` | string | input name (also the directory name — not sanitized) |
| `summary` | string | author's one-liner; may be replaced by the description pass |
| `description` | string | `input.description ?? input.summary` |
| `params` | JSON Schema object | as given; `write_skill` default `{type:'object', properties:{}}` |
| `returns` | JSON Schema object | as given; same default |
| `signature` | string | **rendered** by `renderSignature(name, params, returns)` — never authored (D-04) |
| `tags` | string[] | `input.tags ?? []` (`write_skill` never sets tags) |
| `tier` | `'mortal' \| 'divine'` | `input.tier ?? 'mortal'` |
| `exemplar` | boolean | `input.exemplar ?? false` |

`SkillVersion` (`eden/src/types/skill.ts:33-44`): `name, version (1-based int), codePath, codeHash (sha256
hex of code, library.ts:80-82), status, probationRunsLeft?, author {kind:'god'|'villager'|'stock', name?},
provenance? {rolloutId, verdictId}, createdAt (ms epoch)`.

### `renderSignature` (`library.ts:396-425`)

`name({k: type, opt?: type, …}) → ret`. A property not in `params.required` gets a `?`. Types come
from `schema.type`: `array` renders as `<items-type>[]`, a type array joins with `|`, missing type →
`object` (or `any` for a non-object schema). If `returns` has `properties` it renders `{k: type, …}`,
else the bare return type. Example (stock `go-to`):

```
go-to({x: number, y: number, z: number, range?: number}) → {arrived: boolean}
```

## Status machine (D-12)

Statuses: `draft | active-probation | active | quarantined | archived` (`eden/src/types/enums.ts:12-19`).

```
                upsertDraft (write_skill / seedStock)
                          │
                          ▼
   ┌──────────────── draft ────────────────┐
   │ admit() (critic verdict libraryAction │ seedStock(...,'active')
   │ ='admit' on a draft)                  │ (stock: skips probation)
   ▼                                       ▼
active-probation ──recordProbationRun(ok)×probationRuns──► active
   ▲   (probationRunsLeft counts down; a failed run does NOT count and does NOT reset)
   │
   │ unquarantine() (verdict 'admit' on a quarantined version)   quarantine()
   └────────────────── quarantined ◄────────────────────────── any status
                                                             archive(): any → archived
```

| Transition | Method | Trigger in running code | Threshold / effect |
|---|---|---|---|
| (new) → `draft` | `upsertDraft` (`library.ts:102-127`) | `write_skill` tool (`tools.ts:235`) | new version = max existing + 1 (`library.ts:351-353`) |
| (new) → `active` | `seedStock` (`library.ts:130-137`) | `seedStockSkills` at every boot (`main.ts:524`) | author forced to `{kind:'stock'}` |
| `draft` → `active-probation` | `admit` (`library.ts:141-154`) | `routeVerdict` when `libraryAction==='admit'` and current status is `draft` (`god.ts:167-174`) | `probationRunsLeft = probationRuns`; stamps `provenance` |
| `active-probation` → `active` | `recordProbationRun(name, ok)` (`library.ts:157-169`) | engine, after every **root** run whose resolved version is `active-probation` (`engine.ts:421`) | only `ok=true` decrements; at `left <= 0` → `active`, `probationRunsLeft` deleted |
| any → `quarantined` | `quarantine(name, reason, version?)` (`library.ts:172-183`) | verdict `libraryAction==='quarantine'` (`god.ts:177-178`); admin route (`main.ts:391`); `verifyHashes` | default target = live version, else newest non-archived |
| `quarantined` → `active-probation` | `unquarantine` (`library.ts:186-201`) | verdict `'admit'` on a quarantined version (`god.ts:167-170`) | **never** straight to `active` (R37/R48); resets `probationRunsLeft` |
| any → `archived` | `archive` (`library.ts:214-220`) | verdict `libraryAction==='archive'` (`god.ts:179-180`) | invisible to retrieval and default read; file kept |

Constants (`eden/src/config.ts:119-126`, overridable under `skills` in `eden.json`):

| Key | Default | Used by |
|---|---|---|
| `skills.probationRuns` | `3` | `SkillLibrary` (`main.ts:519`) |
| `skills.autoQuarantineAfter` | `5` | engine `FailureTripwire` (`engine.ts:515-531`) |
| `skills.maxSkillLines` | `400` | `write_skill` (`tools.ts:225-231`) |
| `skills.maxCallDepth` | `8` | engine composition |
| `skills.runDefaultTimeoutMs` | `120000` | engine wall clock |
| `skills.stallSeconds` | `20` | engine stall detector |

### Which version runs / is read

| Read | Method | Resolves to |
|---|---|---|
| Live / runnable | `readRunnable` / `activeVersion` / `liveRecord` (`library.ts:224-244, 319-328`) | **highest version number** with status `active` or `active-probation`. Older `active` versions keep status `active` but are shadowed. |
| `read_skill` default | `read(name)` (`library.ts:234-238`) | newest **non-archived** version — may be a `draft` or `quarantined` one |
| Explicit version | `read(name, v)` / `getVersion` | any version, any status |
| Retrieval candidates | `liveSkills()` (`library.ts:257-264`) | the live version of every skill |
| Admin history | `history(name)` (`library.ts:276-284`) | every version newest-first; missing file → `code: ''` |

### Probation gates composition, not access

An `active-probation` live version is retrievable and directly runnable, but `ctx.skills.run` of it from
another skill throws `ProbationError` (`engine.ts:342`). Graduation is **run counting, not re-judging**:
the engine counts clean root runs; there is no critic re-review ticket (comment at `engine.ts:413-420`).

### The failure tripwire (`autoQuarantineAfter`)

`FailureTripwire.recordRun` (`engine.ts:515-531`) counts consecutive failed **root** runs per skill name;
on reaching the threshold it resets to 0 and returns `true`, which calls `onTripwire(skill, report)`.
It **does not quarantine anything itself**, and `main.ts` does not pass `onTripwire` (`main.ts:526-533`),
so in the running host the tripwire currently has no effect. A success resets the counter.

## Authoring: `write_skill` and friends (villager tools)

Defined at `eden/src/villagers/tools.ts:82-115`, handled at `:194-268`. Messages are French.

| Tool | Args | Behaviour |
|---|---|---|
| `search_skills` | `{query}` | `retriever.search(query, {tier: runner.tier, villager})`, k=8; renders `name — signature — summary` lines; empty → `Aucun skill pertinent trouvé.` |
| `read_skill` | `{name, version?}` | `library.read`; returns header `skill "<n>" v<k> [<status>]`, signature, `résumé`, `description`, journal-folded stats, last outcomes, full code |
| `write_skill` | `{name, summary?, params?, returns?, code}` | see caps below; on success `Brouillon "<n>" v<k> créé (statut: draft).` |
| `run_skill` | `{name, args?, timeoutMs?}` | engine run; inside a rollout, running the rollout's own draft name trials `ctx.draft.version` with `validateReturn: true` (`tools.ts:253-258`) |

`write_skill` checks, in order (`tools.ts:219-243`):

1. `name` non-empty after trim, `code` non-empty.
2. **Size cap (R47):** `code.split('\n').length > maxSkillLines` (400) → rejected with
   `Erreur: code de N lignes > maxSkillLines (400). Décompose ce skill en sous-skills composés (R47) — le code n'est jamais tronqué.` Code is never truncated.
3. **Compile up front:** `compile(code)` (parse + instrument + `new Function`); failure returns `Erreur de compilation du skill "<n>": <error>` for immediate retry.
4. `upsertDraft` with `summary ?? name`, default schemas, author `{kind:'villager', name}`. **No `tier`, `tags`, `description` or `exemplar` field is exposed** — villager skills are always `mortal`, tag-less.

There is no "manifest sanity" step (schema compile / name-collision check) despite docs/02 listing one.
A villager may write a draft under a **stock skill's name**; it becomes `vN+1` of that skill.

## Admission and the description pass

`GodService.routeVerdict` (`eden/src/god/god.ts:149-184`) applies the critic's `libraryAction`:
`admit` (draft → `admit()` + description pass; quarantined → `unquarantine()`; already live → no-op),
`quarantine`, `archive`, or none.

`DescriptionPass.derive(name, code)` (`eden/src/skills/describe.ts:26-52`):

- One `client.chat` call on tier **`fast`**, caller `god:describe` (default), system prompt asking for
  STRICT JSON `{"description": 3-6 sentences, "summary": one line, "tags": 1-4 lowercase tags}` derived
  only from the code.
- Reply parsing: takes a ```` ```json ```` fenced block if present, then the outermost `{…}`; JSON.parse.
  Empty/invalid description → fallback description. `summary`/`tags` are applied only if present and
  valid strings (tags filtered to strings).
- **Never throws.** Fallback = `Skill "<name>". <first non-empty code line>` sliced to 240 chars, leaving
  author summary/tags untouched.
- Result applied via `library.applyDescription` (`library.ts:204-211`), which mutates that version's
  manifest and persists.

> ⚠ In the running host `GodService` is built **without** a `describer` (`main.ts:555`:
> `new GodService({ journal, library, inboxes })`), so `runDescriptionPass` returns immediately
> (`god.ts:273-275`). Admitted skills keep `description === summary` (the author's own words).

## Retrieval (`SkillRetriever.search`)

`eden/src/skills/retrieve.ts:61-108`. Inputs: `query`, `{tier, villager?, k?}`.

1. **Candidates** = `library.liveSkills()` (only `active`/`active-probation`; drafts, quarantined and
   archived are never surfaced — P2).
2. **Tier filter:** keep `manifest.tier === 'mortal' || search.tier === 'divine'` — mortals never see
   divine skills; the divine runner sees both.
3. **Grant filter:** `grants.canRetrieve(villager ?? '*', name)` (v0 `AllGranted` → always true).
4. **Text per skill:** `"${summary} ${description} ${tags.join(' ')}"`.
5. **Embeddings:** one `embeddings.embed([query, ...misses])` call, where *misses* are skills whose cached
   vector is absent or whose text changed (R58 cache, key `name@version`, value `{text, vector}`, FIFO
   cap **4096**, `retrieve.ts:46-57, 109-116`). The query is embedded on every search.
6. **Score** = `keywordScore(query, text)`; if both a query vector and a skill vector exist,
   `max(cosine(q, s), keyword)` (`retrieve.ts:92-104`).
7. Sort by score desc, then name asc; return top `k` (default **8**, `retrieve.ts:39`).

Result rows: `{name, signature, summary, tags, tier, score}`.

Embedding stack (`eden/src/llm/embeddings.ts`): production backend is the in-process
`localBackend()` = `@xenova/transformers` `Xenova/paraphrase-multilingual-MiniLM-L12-v2`,
mean-pooled + normalized, lazily imported (`embeddings.ts:130-153`; wired at `main.ts:509-516`).
`embed` returns `null` when off or degraded; **3 consecutive failures** degrade to keyword-only for the
rest of the process (R38, `embeddings.ts:44-63`). `keywordScore` = |query∩text tokens| / sqrt(|q|·|d|),
tokens = lowercase Unicode letter/digit runs of length ≥ 2 (`embeddings.ts:84-100`).

### What a villager prompt carries (not retrieval, but adjacent)

- **Exemplars (full code, always):** `STOCK_SKILLS.filter(s => s.exemplar && s.tier !== 'divine')` —
  built statically from the bundled stock list, not from `library.exemplars()` (`main.ts:583`). Currently
  **7** skills: `go-to`, `mine-block`, `find-block`, `collect-blocks`, `craft-item`, `use-chest`, `deposit`.
  The test pins 5–7, each ≤ 60 lines, all mortal (`eden/tests/skills-exemplars.test.ts:41-48`).
- **Primitives palette:** every mortal, non-exemplar stock skill as `name — signature — summary`
  (`main.ts:589-591`).
- **Retrieved skills:** `search` results as above.
- `library.exemplars(tier)` (`library.ts:247-254`) exists but has no runtime caller.

## Access control: `GrantPolicy`

`interface GrantPolicy { canRetrieve(villager, skill); canRun(villager, skill) }` (`library.ts:21-26`).
v0 ships only `AllGranted` (both constant `true`, `library.ts:29-36`). Every retrieval and every engine
run/compose passes through it, so an economy policy can be swapped in without engine changes.

## Integrity: `verifyHashes`

`verifyHashes()` (`library.ts:287-298`) re-hashes every non-archived version whose file exists and
quarantines on mismatch with reason `code hash mismatch at boot — file tampered or corrupted`. Tested
(`eden/tests/skills-library.test.ts:133`) but **not called** anywhere in `eden/src/` (no boot call in
`main.ts`).

## How to extend

- **New stock skill:** add a `StockSkill` const in `eden/src/skills/exemplars/index.ts` and append it to
  `STOCK_SKILLS`; it is seeded `active` on next boot. Keep code a single function expression (see
  [skills-engine.md](skills-engine.md#compilation-pipeline)). Add a FakeBot test in
  `eden/tests/skills-exemplars.test.ts`.
- **New status / transition:** extend `SKILL_STATUSES` (`enums.ts`) and add a method in `library.ts`
  (the only writer, S2); update `liveRecord` if the status is runnable.
- **Real grants:** implement `GrantPolicy` and pass it to `SkillEngine` + `SkillRetriever` + `ToolRegistry`
  at `main.ts:525-534`.

## Gotchas & known issues

- **Stock skills are re-seeded on every boot.** `seedStockSkills` (`main.ts:524`) calls `seedStock` →
  `upsertDraft`, which always appends a new version. After N boots each stock skill has ≥ N versions on
  disk and N `skill.draft` journal rows (actor `engine`). The comment "a re-seed … is harmless" is only
  true for unchanged stock code; it also means a **villager's admitted override of a stock name is
  shadowed again at the next boot** (the fresh stock version is higher-numbered and `active`).
- **Overriding a stock name breaks composition until graduation.** If a villager's draft of e.g. `go-to`
  is admitted, it becomes the highest live version in `active-probation`; every `ctx.skills.run('go-to')`
  (used by `craft-item`, `use-chest`, `till-block`, …) then throws `ProbationError` until 3 clean root runs.
- **Probation never resets on failure** — a failing run neither decrements nor resets
  `probationRunsLeft` (`library.ts:160`); graduation is purely "3 clean root runs ever".
- **Tripwire is inert** in the host (no `onTripwire` passed). Nothing auto-quarantines on failure streaks.
- **Description pass is not wired** (no `describer`) — `description` stays equal to the author summary.
- **`verifyHashes` is never invoked** at boot despite docs saying it is.
- **Skill names are used unsanitized as directory names** (`join(dataDir,'library',name)`). A name
  containing `/` writes into a nested directory that `load()` (top-level only) will not find after a
  restart; `..` segments escape `library/`. `write_skill` only trims the name.
- **Missing code file** → `resolve()` throws `ENOENT` from `readFileSync` (`library.ts:315-317`) for
  `readRunnable`/`read`/`liveSkills`; only `history()` degrades to `''`. A single deleted `v*.js` of a live
  version therefore breaks `liveSkills()` and with it every `search_skills` call.
- `quarantine` always journals actor `engine`, even when God or an admin caused it.
- `seedStock(..., 'active-probation')` exists but is never used; stock always seeds `active`.

## Related

- [skills-engine.md](skills-engine.md) — how a version is compiled, supervised and reported
- [stock-skills.md](stock-skills.md) — every bundled skill
- [bots-and-hardening.md](bots-and-hardening.md) — the bot pool skills run on
- [god.md](god.md) — critic verdicts that drive admission
- [villager-runtime.md](villager-runtime.md) — the brain/tool loop that calls `write_skill`/`run_skill`
- [journal-and-views.md](journal-and-views.md) — `skill.*` journal kinds and the stats fold
- [llm-and-scheduling.md](llm-and-scheduling.md) — LLM client used by the description pass
