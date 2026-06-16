# 21 — Replace Eden's embedding storage with sqlite-vec on the better-sqlite3 spine — agent kickoff prompt

> Hand this whole file to an agent. It replaces Eden's **re-embed-the-whole-pool-on-every-recall**
> retrieval with an **embed-at-write + persisted vectors** design backed by **`sqlite-vec`** (the
> loadable vector extension for SQLite) running on the **existing `better-sqlite3` `eden.db`** spine
> (D-03). The defect is in `VillagerMemory.retrieve()`; the same shape also cleans up `SkillRetriever`
> and the curriculum QA-cache. **Work ONLY under `eden/` and `docs/`.** Never touch
> `minecraft-mcp-server/` or the repo-root `src/` (Java). `cd eden ; npm run check` MUST stay green.

---

## 0. The defect (measured, not hypothetical)

`VillagerMemory.retrieve(query, k)` ([eden/src/villagers/memory.ts:191](../eden/src/villagers/memory.ts)) does this:

```ts
const pool = [...this.window, ...this.archiveStore];           // up to 200 + 2000 = 2200 entries
if (this.embeddings?.enabled()) {
  vectors = await this.embeddings.embed([query, ...pool.map((e) => e.text)]);   // ← RE-EMBEDS THE WHOLE POOL
}
```

It re-embeds **every memory entry, every recall**, through the in-process ONNX model
(`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, `localBackend()` in
[eden/src/llm/embeddings.ts:130](../eden/src/llm/embeddings.ts)). There is no vector cache.

**Re-measured on this machine** (Node 24, win32, the quantized ONNX model cached in `node_modules`):

| Workload | Result |
|---|---|
| Single-text inference | **median 3.79 ms** (p90 4.12 ms) |
| Sequential embed, window = 200 | **727 ms** per recall |
| Sequential embed, window 200 + archive 2000 | **7.33 s** per recall |
| Brute-force cosine over **2200** normalized 384-dim vectors, pure JS | **0.4 ms** |
| Brute-force cosine over **25 000** vectors, pure JS | **~9 ms** |

So today a single recall on a full pool spends **~7.3 s** doing 2200 inferences whose results are
thrown away. With the avatar pool + 10 villagers all sharing one event loop, that path is now called
**on every rollout revision turn** ([main.ts:925-926](../eden/src/main.ts)) **and every reactive
wake-up** ([main.ts:644](../eden/src/main.ts)) — both added recently. The `system.loop-lag` canary
(`max ≥ 1000 ms`, [docs/05](05-observability.md) §D-07) will trip whenever the backend runs
single-threaded.

> **Honesty note on "event-loop stall."** With the **native** `onnxruntime-node` backend the
> per-inference JS-loop block measured ~0 ms (inference runs on ORT's own thread pool), so the cost
> shows up primarily as **7.3 s of wall-clock latency per recall** (the villager's deliberation
> blocks on the awaited promise) plus CPU/thread saturation that *induces* loop lag under multi-bot
> load. If the install ever falls back to the **wasm** backend (single-threaded), it blocks the loop
> outright. **Either way the fix is the same**: stop doing O(pool) inferences per recall. Reproduce
> the baseline yourself before you start (a ~60-line script: load `localBackend()`, time
> `embed([…2200 texts])`, and `monitorEventLoopDelay` around it) so you can prove the regression is
> gone at the end.

**The target:** a recall does **one** query embed (~3.8 ms) + a sub-millisecond KNN over
pre-computed vectors. Roughly **7.3 s → ~4 ms**.

---

## 1. The decision (already made by the owner — implement it, don't relitigate)

**Embed-at-write, persist vectors in `eden.db` via `sqlite-vec`, embed only the query at read time.**

- Each memory entry's vector is computed **once** (at `remember()` / on eviction / via a one-time
  backfill) and stored in a `sqlite-vec` `vec0` virtual table in the existing `eden.db`.
- `retrieve()` embeds **only the query** (1 inference), runs a KNN against the villager's stored
  vectors (distance math in C, returns `(key, distance)` pairs — not 384-float blobs marshalled into
  JS), then applies the **unchanged** recency/importance re-rank in JS.
- The **keyword floor (R38) stays exactly as is** — relevance is still `max(cosine, keywordScore)`,
  computed in JS over the in-RAM pool; if embeddings OR sqlite-vec are unavailable, retrieval still
  works on keywords alone and **never throws**.

### Why this is the right shape here (the reasoning, so you don't second-guess it)

- **The text is immutable.** A `MemoryEntry`'s `text` never changes after `remember()` (only
  `importance`/`tags` mutate, and *those are not embedded*). So a stored vector is **never stale** —
  no invalidation logic needed. This is exactly why the **curriculum QA-cache already does
  embed-at-write** ([god/curriculum.ts:259](../eden/src/god/curriculum.ts) stores `vector` with each
  immutable QA entry and embeds only the query in `findCached()` at
  [:490](../eden/src/god/curriculum.ts)). You are generalizing a pattern the repo already proved
  correct — not inventing one. (Contrast `SkillRetriever`, whose text *does* mutate via
  describe-from-code; see Phase 2.)
- **It fits the spine (D-03), not a sidecar.** `eden.db` is meant to hold "journal + library index +
  stats + ledger + directives + subscriptions in one DB." Vectors belong there too. **Do NOT inline
  vectors in the bot JSON** (`.eden-data/bots/<name>.json`): 2200 × 384 floats as JSON text is
  ~5 KB/entry → ~11 MB *per villager* of text that `persist()` rewrites **synchronously on every
  `remember()`** ([memory.ts:340](../eden/src/villagers/memory.ts)). As a compact `float[384]` BLOB in
  sqlite-vec it is ~1.5 KB/vector → ~3.4 MB/villager, ~34 MB total for 10 villagers, written
  incrementally.
- **Crash-only (kill -9 loses at most in-flight work).** Vectors persist to `eden.db` (WAL) as they
  are computed. A crash mid-embed loses one vector; the entry is still in the JSON window, and the
  boot-time backfill recomputes it. No new durability story.
- **One process (D-01).** No service, no second runtime. sqlite-vec is an in-process loadable
  extension on the connection Eden already has.

### Why sqlite-vec specifically (and the no-native-dep fallback you must keep ready)

At ≤2200 vectors/villager, brute-force cosine in pure JS is **sub-millisecond** (measured 0.4 ms),
so an ANN index is *not* needed for speed — and current `sqlite-vec` does brute-force KNN anyway
(no HNSW/IVF). sqlite-vec earns its place by (a) doing the distance math in C without copying every
vector into JS, (b) keeping vectors in the spine with the journal's WAL durability, (c) one storage
story shared by memory / skills / QA, and (d) a clean path to `int8`/quantized vectors later if the
village ever grows. **But it is a native, pre-1.0 dependency.** If the Step-0 spike shows it does not
install/load cleanly on this Windows + Node setup, fall back to **Plan B: a plain SQLite table of
`Float32` BLOBs + brute-force cosine in JS** (same embed-at-write design, same API surface, no
extension) — the measured 0.4 ms makes it perfectly adequate, and the worst case below (keyword
floor) still protects you. Decide between sqlite-vec and Plan B **after** Step 0, and record which in
the new D-record (§9).

---

## 2. Hard rules — BAKE THESE IN

- **`cd eden ; npm run check` stays GREEN** (lint + `tsc --noEmit` + dependency-cruiser 0 violations +
  the full `node:test` suite). The existing memory/embeddings tests run on **fakes only**
  ([tests/villagers-memory.test.ts](../eden/tests/villagers-memory.test.ts),
  [tests/llm-embeddings.test.ts](../eden/tests/llm-embeddings.test.ts)) — never the real model. Keep
  it that way: the new VectorStore must be **injectable/omittable** so CI never loads sqlite-vec or
  the ONNX model. A boot without a store, or with a store whose extension failed to load, degrades to
  the keyword floor (R38) — and there must be a test proving that.
- **The keyword floor never dies (R38).** `relevance = max(cosine, keywordScore)` stays. If
  `embeddings.enabled()` is false **or** the store is absent/disabled, `retrieve()` returns the
  *exact* same ranking it does today on keywords alone. Adding sqlite-vec must not change the
  keyword-only code path.
- **Multilingual quality must not regress.** Same model, same `normalize: true` unit vectors, same
  `max(cosine, keyword)` blend, same 0.5/0.25/0.25 weights, same 2 h half-life. You are changing
  *where the cosine comes from*, not the math. A French↔French and a French↔English ranking test
  (real or stubbed deterministic vectors) must show identical top-k to the pre-change ranking on the
  same inputs.
- **Dependency law (CI-enforced, [.dependency-cruiser.cjs](../eden/.dependency-cruiser.cjs)).** Imports
  go strictly downward. The VectorStore is **pure storage** (better-sqlite3 + types only) → it is a
  **layer-1 substrate** module, like `journal/`. Its consumers — `villagers/memory.ts` (L3),
  `skills/retrieve.ts` (L2), `god/curriculum.ts` (L3) — all import **downward** into it, which is
  legal. See §4 for the exact home + cruiser rule.
- **S2 — one writer per state.** The journal owns the `journal` table; the VectorStore owns its
  `vec0`/vector tables. They may share one DB **file** (and even one connection) without violating S2.
- **S5 — banned machinery.** No ORM, no event-sourcing of *live* state, no message queue between
  modules, no DI container. sqlite-vec is "just SQL on the existing DB," so it is fine — but a *new
  native dependency* must be justified in the D-record (§9), per S7/S8.
- **S8 — behavior + docs in the same commit.** New pitfall → next R-number in
  [docs/07](07-hard-won-lessons.md). New settled choice → a D-record (this doc + wherever the storage
  decision is normative). New config key → [eden.example.json](../eden/eden.example.json) +
  [config.ts](../eden/src/config.ts) + a comment.
- **S10 — errors carry evidence.** `vectorStore.knn(...)` failing must log/journal the namespace +
  query length + the sqlite error, then degrade — never throw into `retrieve()`.

---

## 3. Step 0 — RESEARCH, THEN DE-RISK (before you touch any Eden source)

This step has two halves: **(0a)** spawn research subagents to gather authoritative, *current* facts
about `sqlite-vec` + `better-sqlite3` (the package landscape moves fast and `sqlite-vec` is pre-1.0,
so do **not** implement from memory), then **(0b)** run a local throwaway spike to confirm those facts
on *this* Windows + Node install. Reconcile the two; on any conflict, **trust the local spike** and
note it. Do not edit Eden code until 0b passes.

### Step 0a — research the dependency with parallel subagents

Spawn the lanes below **in parallel** — one message, multiple `Agent` calls (`subagent_type:
general-purpose`, or `Explore`, with web access), or run the `deep-research` skill with the combined
question. Give each lane the tight scope below and require it to return a **compact structured note**:
each claim as a one-liner with its **source URL** and a confidence flag, and an explicit **"unverified
on Windows / Node 24"** marker on anything it could not confirm. Prefer the official GitHub repos, the
maintainer's docs site, and npm over blog posts. Synthesize all lanes into a short **"sqlite-vec
facts"** block you keep in the PR description (and feed into the R-record, §9). Do this research even
if a prior report is lying around — versions drift; re-verify.

- **Lane A — sqlite-vec capabilities & exact API (current version).** npm package name + **latest
  version and release status** (still pre-1.0?); does it ship **prebuilt platform binaries** incl.
  `sqlite-vec-windows-x64` (so no MSVC build-from-source)?; how to load on a `better-sqlite3` handle
  (`sqliteVec.load(db)`); the **exact `CREATE VIRTUAL TABLE … USING vec0(…)` DDL** for that version —
  a TEXT primary key, a `float[384]` column, `distance_metric=cosine`, a **partition key** column, and
  metadata/auxiliary (`+col`) columns; the **KNN query syntax** (`embedding MATCH ?`, `k = ?`, and
  combining it with `WHERE` filters); **how the query vector is passed** (JSON string vs
  `Float32Array` Buffer — and what helper sqlite-vec exports for it); confirm **`DELETE`** and
  insert-or-replace both work. Source: `github.com/asg017/sqlite-vec` (+ its docs site), npm.
- **Lane B — better-sqlite3 v12 on Windows + Node 22/24.** Is `db.loadExtension(...)` available and is
  **extension loading enabled in the prebuilt binary** (or does it need a flag / custom build)? Any
  win32-specific gotcha loading a `.dll` extension. WAL **multi-connection** behavior in one process +
  `PRAGMA busy_timeout` (relevant to the "second connection" option in §4). Source:
  `github.com/WiseLibs/better-sqlite3` docs + issues.
- **Lane C — quantization & storage.** `float32` vs `int8` vs `bit` for 384-dim multilingual MiniLM
  vectors: how to declare/produce each in sqlite-vec, the **recall tradeoff** at int8 (does it
  threaten the "no multilingual regression" rule?), and the storage-size math. Source: sqlite-vec
  docs/blog (Alex Garcia), the MiniLM model card.
- **Lane D — Plan B & fallback intel (lighter lane).** Confirm that for **< 25k vectors** a plain
  `Float32` BLOB column + brute-force cosine in JS is a sound, commonly recommended pattern (it is the
  no-native-dep fallback, §1). Glance at `hnswlib-node` / `usearch` Windows + Node-24 prebuilt status
  only as backup intel — not the plan.
- **Lane E — risk & maintenance.** Open `sqlite-vec` issues touching Windows / better-sqlite3 / Node
  24, last release date, maintenance signals. Also note the transformers.js story
  (`@xenova/transformers` v2 vs `@huggingface/transformers` v3) for whether ONNX feature-extraction
  can be moved off the main thread later — context for a future optimization, not this PR.

### Step 0b — confirm on THIS machine with a throwaway spike

Now prove it locally, in a throwaway script (delete it after). Do **not** edit any Eden source until
all five pass. If any fails and can't be fixed quickly, switch to **Plan B** (§1) and note it.

1. **Install.** `cd eden ; npm install sqlite-vec` — confirm the platform binary actually lands
   (the npm package pulls a prebuilt `sqlite-vec-windows-x64` optional dep; verify the `.dll` exists
   under `node_modules`). Note the installed **version** (it is pre-1.0 — pin it exactly in
   `package.json`, not a caret range).
2. **Load on better-sqlite3.** Open a throwaway DB with `better-sqlite3` (v12 is already a dep) and
   `sqliteVec.load(db)`. Confirm `better-sqlite3` permits extension loading on this build (it ships
   with `loadExtension` enabled by default; if a security build disabled it you'll learn now).
3. **Round-trip.** Create a `vec0` table with a `float[384]` column, INSERT a few unit vectors, run a
   KNN (`embedding MATCH ? AND k = ?`), read back `distance`, and **DELETE** one row. Confirm the
   distance metric and how to pass the query vector (JSON string vs `Float32Array` Buffer — sqlite-vec
   ships helpers; pick one and standardize).
4. **Partition/scoping.** Confirm how to scope KNN to one villager: either a **partition key** column
   (`villager text partition key`, recent vec0 feature — verify it exists in your version) **or** a
   plain metadata column you filter with `WHERE villager = ?` alongside the `MATCH`. Whichever your
   version supports cleanly, use it; record the DDL.
5. **Coexistence.** Load sqlite-vec on a connection to a DB that **also** has the `journal` table
   (mimic `eden.db`), and confirm journal reads/writes are unaffected. Decide **shared connection vs
   second connection** (see §4).

> **Reconcile 0a ↔ 0b.** Where the research (0a) and the local spike (0b) disagree — a version's exact
> DDL, whether the Windows binary actually loads, what query-vector format the build accepts — **the
> spike wins.** Record the delta in the "sqlite-vec facts" block and the R-record (§9): pre-1.0 drift
> between the docs and the installed binary is exactly the trap the next agent will fall into.

---

## 4. The new module: a layer-1 `VectorStore`

Create **`eden/src/vectors/store.ts`** (new layer-1 dir, mirroring the `render/` and `views/`
precedent — both are small layer-1 modules with their own cruiser rule). Add a dependency-cruiser
rule next to `render-only-types` / `views-only-journal-types`:

```js
{
  name: 'vectors-only-types',
  severity: 'error',
  comment: 'vectors/ is layer-1 storage (sqlite-vec on eden.db). Imports better-sqlite3 + types only.',
  from: { path: '^src/vectors/' },
  to: { path: '^src/', pathNot: '^src/(vectors/|types/)' },
}
```

### Shared connection vs second connection

`Journal` is currently the **only** module that touches better-sqlite3
([journal/journal.ts:46-49](../eden/src/journal/journal.ts)) and it keeps its `Database` handle
private. Two acceptable options — pick in Step 0:

- **(Preferred) One shared connection.** In [main.ts:144](../eden/src/main.ts) open the `Database`
  once, pass it to both `new Journal(db)` (teach its constructor to accept a `Database | string`) and
  `new VectorStore(db)`. Truest "one spine, one connection"; sqlite-vec is loaded on that connection.
  Small change to the journal constructor + its tests.
- **(Lower-touch) Second connection to the same file.** `VectorStore` opens its own
  `new Database(join(dataDir,'eden.db'))`, loads sqlite-vec on it, sets `PRAGMA busy_timeout`. Safe
  because better-sqlite3 is **synchronous and single-threaded** (writes never truly overlap) and WAL
  permits multiple in-process connections. Zero change to `Journal`.

Either honors S2 (distinct tables) and D-03 (one DB file).

### Generic API (namespaced so memory / skills / QA can all share it)

```ts
export interface IVectorStore {
  /** False when the extension failed to load (or Plan B disabled) → callers fall to the keyword floor. */
  enabled(): boolean;
  /** Insert-or-replace one vector. ns = partition (e.g. a villager name, or 'skills', or 'qa'). */
  upsert(ns: string, key: string, vector: Float32Array | number[]): void;
  /** KNN within one namespace. Returns cosine SIMILARITY (1 - cosine_distance), sorted desc. */
  knn(ns: string, query: Float32Array | number[], k: number): Array<{ key: string; score: number }>;
  /** Cosine similarity for a SPECIFIC set of keys (so retrieve() can score the exact RAM pool). */
  scoreFor?(ns: string, query: Float32Array | number[], keys: string[]): Map<string, number>;
  delete(ns: string, key: string): void;
  /** Drop a whole namespace (R32 wipe; a superseded skill version sweep). */
  clear(ns: string): void;
  /** Which keys already have a stored vector (drives the boot-time backfill). */
  keys(ns: string): Set<string>;
}
```

- `enabled()` is `false` if `sqliteVec.load` threw (extension missing on this platform) — caught in
  the constructor, logged via `logger`, never rethrown. This is **R38 extended to the store**: an
  unavailable vector backend is *exactly* like embeddings being off → keyword floor. This is the
  safety net that makes the native dep low-risk: the worst case is "keyword-only retrieval," never a
  crash.
- Store **unit-normalized `float[384]`** (the model already normalizes). Set the vec0 column's
  distance metric to **cosine** and convert `score = 1 - distance` so it matches the existing
  `cosine()` semantics ([embeddings.ts:67](../eden/src/llm/embeddings.ts)) exactly. Clamp negatives to
  0 to match `Math.max(0, cosine(...))` in retrieve today.
- `scoreFor` is the clean composition primitive (see §6) — if your sqlite-vec version can't filter a
  KNN to an explicit key list efficiently, implement it as `knn(ns, query, <poolSize>)` then index the
  result by key. At ≤2200 it's brute-force regardless.

---

## 5. Phase 1 — migrate `VillagerMemory` (the actual defect; do this first, prove it, stop)

Treat Phase 1 like an M3-style gate: get **one** villager's recall fast and correct through the full
write→persist→recall path, with `npm run check` green, **before** touching skills or curriculum.

### 5a. Give entries a stable id

`MemoryEntry` (defined in `types/` — grep `interface MemoryEntry`; it is `{ kind, text, tags,
importance, at }`) has **no id**, so a stored vector can't be re-associated after eviction (indices
shift). Add `id: string` (a `ulid()`), assigned in `remember()`
([memory.ts:129](../eden/src/villagers/memory.ts)) and on the summarizer's lesson seeds
([memory.ts:290](../eden/src/villagers/memory.ts)). Back-compat in `load()`
([memory.ts:311](../eden/src/villagers/memory.ts)): entries persisted without an `id` get one assigned
on load (then re-persisted). `id` is also the `vec0` key.

### 5b. Embed at write, off the hot path (keep `remember()` synchronous)

`remember()` returns `MemoryEntry` synchronously and is called from the `remember` tool
([villagers/tools.ts](../eden/src/villagers/tools.ts)) and the social `MemoryWriter` seam — do **not**
make it async (that ripples through `types/MemoryWriter` and social/). Instead, mirror the existing
**`pendingSummary`** best-effort pattern ([memory.ts:111,269](../eden/src/villagers/memory.ts)):

- `remember()` pushes the entry, then **schedules** a background embed+upsert on a `pendingVectors`
  promise chain: `this.embeddings.embed([entry.text])` → `this.vectors.upsert(this.villager,
  entry.id, vec)`. Fire-and-forget, `.catch()` swallows (best-effort, like the summarizer). Until the
  vector lands (one macrotask), that entry simply scores on the keyword floor — acceptable.
- Add `async flushVectors()` (awaits `pendingVectors`) for tests + graceful shutdown, exactly like
  `flushSummary()` ([memory.ts:248](../eden/src/villagers/memory.ts)).

### 5c. Delete vectors only on archive trim

Eviction window→archive keeps the vector valid (text unchanged) — **do nothing**. The only delete is
in `trimArchive()` ([memory.ts:263](../eden/src/villagers/memory.ts)): when an entry is FIFO-dropped
past `archiveMax`, `this.vectors.delete(this.villager, dropped.id)` for each removed entry.

### 5d. Boot-time backfill (cold start + migrating existing memories)

Existing `.eden-data/bots/*.json` have entries with no stored vectors (and, pre-5a, no ids). On
construction, after `load()`, schedule a **one-time background backfill**: for every pool entry whose
`id` is not in `this.vectors.keys(this.villager)`, embed in batches and upsert. Off the hot path,
idempotent, crash-resumable (vectors persist as computed; a re-boot resumes where it stopped). This is
the *only* time you re-embed in bulk — once per process per missing set, not per recall.

### 5e. The new `retrieve()` — same algorithm, cosine sourced from the store

```ts
async retrieve(query: string, k: number): Promise<RankedMemory[]> {
  const pool = [...this.window, ...this.archiveStore];
  if (pool.length === 0) return [];

  // ONE inference: the query only (was: [query, ...entire pool]).
  let queryVec: number[] | undefined;
  if (this.embeddings?.enabled() && this.vectors?.enabled()) {
    const v = await this.embeddings.embed([query]);
    queryVec = v?.[0];
  }
  // Cosine for the EXACT RAM pool, computed in C by sqlite-vec (or 0 when no vector yet / disabled).
  const cosByid = queryVec
    ? this.vectors!.scoreFor(this.villager, queryVec, pool.map((e) => e.id))
    : new Map<string, number>();

  const tNow = this.now();
  const ranked = pool.map((entry) => {
    const kw = keywordScore(query, entry.text);
    const cos = Math.max(0, cosByid.get(entry.id) ?? 0);
    const relevance = Math.max(cos, kw);                       // R38 floor, unchanged
    const recency = Math.pow(0.5, (tNow - entry.at) / RECENCY_HALF_LIFE_MS);
    const importance = clamp(entry.importance, 0, 10) / 10;
    const score = W_RELEVANCE * relevance + W_RECENCY * recency + W_IMPORTANCE * importance;
    return { ...entry, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, k);
}
```

This is **byte-for-byte the same ranking math** as today; only the cosine source changed. No entry is
ever dropped before the blend (recency/importance can't be lost) — that is the whole reason to use
`scoreFor`/full-pool KNN rather than a top-k-by-cosine prefilter. See §6.

### 5f. R32 quarantine interaction

`resolveQuarantine('wipe')` ([memory.ts:232](../eden/src/villagers/memory.ts)) must also
`this.vectors.clear(this.villager)` (dead-world vectors go). `'migrate'` keeps the entries (same ids)
→ the backfill (5d) re-embeds any whose vectors are absent. Don't store a world stamp in the vector
table; tie vectors to live entry ids and let wipe/backfill keep them honest.

---

## 6. How KNN composes with the recency/importance re-rank (read this — it's the subtle part)

The final score is `0.5·relevance + 0.25·recency + 0.25·importance`. Relevance is only **half** the
score. An entry with mediocre cosine but high recency+importance (up to 0.5 combined) can outrank a
high-cosine entry. Therefore **a pure "top-k by cosine from the index, then re-rank those k" is an
approximation that can drop entries that belong in the final top-k.**

At Eden's scale you don't pay for ANN, so **preserve exact semantics**: get a cosine for the **entire
candidate pool** (that's what `scoreFor`/`knn(k = poolSize)` does — sqlite-vec brute-forces it in
sub-ms), then blend in JS over the full pool, then slice top-k. Do **not** introduce an ANN cutoff.

If a future, much larger pool ever makes full-pool scoring costly, the correct cutoff is **"top-N by
cosine UNION the most-recent M entries," then re-rank the union** (so the recency mass can't be
silently lost) — but that is an explicit future optimization, not v0. If you add any cap, `log()` what
it drops (no silent truncation).

---

## 7. Phase 2 & 3 — the other two embedding stores (the "systems", plural)

Do these **only after Phase 1 is green and proven**, and only if scope allows — each is independently
shippable. They are the 2nd and 3rd consumers, so the shared `VectorStore` abstraction is *earned*
(S3 satisfied), not speculative.

- **Phase 2 — `SkillRetriever`** ([skills/retrieve.ts](../eden/src/skills/retrieve.ts)). It already
  fixed its own O(N) stall with an **in-RAM FIFO `Map<name@version, {text, vector}>`** (the "R58"
  cache, [:56](../eden/src/skills/retrieve.ts)). Migrating it to the VectorStore buys **persistence**
  (no cold re-embed of the whole library on every restart) and one storage story. **Caveat that
  memory doesn't have:** skill text **mutates** — the description is generated *from code after*
  admission, so the same `name@version` can change text. Keep the retriever's staleness check: store a
  cheap `textHash` (alongside the vector, or in a RAM `Map<key,hash>`) and re-`upsert` when the hash
  differs; `name@version` is the key, `'skills'` (or per-tier) the namespace. INSERT-OR-REPLACE
  handles the overwrite. Net: move the *vector* into the store, keep the *staleness logic* in the
  retriever.
- **Phase 3 — curriculum QA-cache** ([god/curriculum.ts:259,490](../eden/src/god/curriculum.ts)).
  Already embed-at-write, but vectors live in a RAM array (`this.qa`) and die on restart. Move them to
  the store (`'qa'` namespace, key = a hash of the question, immutable like memory). Smallest of the
  three; lowest priority.

A single generic `VectorStore` serving `mem:<villager>` / `skills` / `qa` namespaces is literally
"replace the embedding storage **systems**." But sequence it: Phase 1 is the defect and the proof;
2 and 3 are clean follow-ons.

> **Out of scope: SQLite FTS5 for the keyword floor.** The floor is a cheap in-JS set-overlap
> (`keywordScore`, [embeddings.ts:93](../eden/src/llm/embeddings.ts)) over a ≤2200 pool — fast and
> already R38-correct. Introducing FTS5/BM25 would be a *second* mechanism for the same job (S3/S5
> smell). Don't.

---

## 8. Tests to add (all on fakes / deterministic vectors — never the real model in CI)

- **The headline assertion — "retrieve embeds only the query, not the pool, on a warm store."** Wire
  a `VillagerMemory` with a **counting fake `EmbeddingsService`** (counts texts passed to `embed`) and
  an in-memory fake `VectorStore`. `remember()` N entries, `await flushVectors()`, reset the counter,
  call `retrieve(query, k)`, and assert the embed backend saw **exactly 1 text** (the query) — not
  `N+1`. This is the regression that must never come back.
- **Ranking parity.** With deterministic stub vectors, assert the new `retrieve()` returns the
  **identical top-k ordering** as the old full-re-embed path for the same inputs (FR↔FR and FR↔EN
  cases). Lock the 0.5/0.25/0.25 blend + 2 h half-life behavior.
- **R38 floor still live (two ways).** (a) `embeddings.enabled() === false` → ranking equals the
  pure-keyword ranking. (b) `vectors.enabled() === false` (extension "failed to load") → same. Neither
  throws.
- **Eviction/trim vector lifecycle.** Overflow the window → vectors survive eviction (text unchanged);
  trim past `archiveMax` → `delete()` called for exactly the dropped ids; `keys()` count tracks the
  live pool.
- **Backfill.** Construct a memory over a JSON fixture with entries but no stored vectors → after the
  backfill settles (`flushVectors()`), every pool id has a vector; it is **idempotent** on a second
  boot (no re-embed of already-stored ids — assert via the counting fake).
- **R32.** `wipe` clears the villager's namespace; `migrate` keeps entries and the backfill re-embeds.
- **Loop / throughput proof (real model, NOT in `npm run check`).** A standalone script (like the §0
  baseline, kept under a non-CI path or `live-tests/`): build a 2200-entry pool, then time 20 recalls
  and `monitorEventLoopDelay` across them — assert median recall < ~50 ms and **no** `system.loop-lag`
  (`max < 1000 ms`). This is the before/after proof for the PR description.
- **sqlite-vec round-trip** (only if sqlite-vec, not Plan B): a small test gated to run only when the
  extension is present (skip in CI), proving upsert→knn→delete on `eden.db`.

---

## 9. Config, docs, and the owner decisions to record

- **Config (S7).** Add at most one key — e.g. `journal.vectorStore: "sqlite-vec" | "blob" | "off"`
  (default `"sqlite-vec"`, `"off"` = keyword floor for everyone, used by CI/no-model boots). Schema +
  default + validation in [config.ts](../eden/src/config.ts); key + comment in
  [eden.example.json](../eden/eden.example.json); exactly one consumer (main.ts wiring). If you don't
  need the knob, don't add it (a key nothing reads is deleted, S7).
- **Wiring.** Construct the `VectorStore` in [main.ts](../eden/src/main.ts) near the journal
  ([:144](../eden/src/main.ts)) and thread it into `VillagerMemory` ([:545](../eden/src/main.ts)),
  and (Phases 2/3) `SkillRetriever` ([:534](../eden/src/main.ts)) and `Curriculum`
  ([:563](../eden/src/main.ts)). The two `retrieve()` callers
  ([:644](../eden/src/main.ts) reactive wake-up, [:925-926](../eden/src/main.ts) rollout) need **no
  change** — they already `await retrieve(...)`.
- **Docs (S8).** Update [docs/04 §Memory](04-villager-runtime.md) ("embeddings lazily batched off the
  hot path" → "embedded once at write, stored in `eden.db` via sqlite-vec; recall embeds only the
  query") and the [docs/05](05-observability.md) §"Derived state" / D-03 spine description (vectors now
  live in `eden.db`). Append a dated section to [docs/PROGRESS.md](PROGRESS.md).
- **New D-record (owner decision).** "Vectors live in the spine via sqlite-vec (embed-at-write)" is a
  settled architectural choice and a **new native dependency** — write it up (this doc is the kickoff;
  the normative D-record names the chosen backend (sqlite-vec vs Plan B per Step 0), the schema, and
  the connection model). It supersedes the implicit "embeddings lazily batched at read" line in
  docs/04.
- **New R-record.** File the load-bearing pitfall you confirm in Step 0 as the next R-number in
  [docs/07](07-hard-won-lessons.md) — almost certainly **"sqlite-vec is a pre-1.0 native extension;
  pin the exact version, verify the Windows prebuilt binary loads via `better-sqlite3.loadExtension`,
  and degrade to the keyword floor (R38) if it doesn't — never crash the host on a missing vector
  backend."**

---

## 10. Open questions for the owner (flag, don't silently assume)

1. **sqlite-vec vs Plan B (plain Float32 BLOB + JS brute-force).** Step 0 decides. Given measured
   sub-ms brute force at this scale, Plan B is fully viable and avoids a native dep; sqlite-vec wins on
   spine-fit + the int8/ANN future. The owner should confirm they want the native dep before it's
   pinned. *(Recommend: sqlite-vec if Step 0 is clean on Windows; else Plan B, no loss.)*
2. **Shared connection vs second connection** to `eden.db` (§4). Recommend shared; confirm the small
   `Journal` constructor change is acceptable.
3. **Scope of this change.** Phase 1 (memory) only, or all three stores (memory + skills + QA) in one
   go? Recommend land Phase 1 first (it's the defect + the proof), then 2/3 as follow-ups.
4. **int8 quantization** (4× smaller: ~8.6 MB total vs ~34 MB) — defer to a future lever unless the DB
   size matters now; it carries a small recall cost the "no multilingual regression" rule wants
   measured first. *(Recommend: float32 for v0.)*
5. **`MemoryEntry.id`** is a real (small) schema addition with a back-compat load path — confirm it's
   wanted (it's hard to avoid: a persisted vector needs a stable key).
```
