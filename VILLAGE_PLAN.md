# VILLAGE_PLAN.md — Ten LLM Villagers

> **STATUS (June 2026): implemented through M8, plus the M10–M14 "paper ×
> Voyager" wave (see the roadmap table).** Node side lives in
> [minecraft-mcp-server/src/village/](minecraft-mcp-server/src/village/)
> (`npm run village`); Java side is `VillageHttpListener` + `VillageConfig` +
> `/village` command. Verified: `tsc --noEmit`, eslint, 240 ava tests (stock
> skills + the M13 composition path go through the real typecheck+sandbox
> pipeline), eval scenarios S1–S14 (mock LLM; needs the live server).
> Deliberate deviations from the plan below: JSON-file persistence instead of
> better-sqlite3 (no native deps on Windows; same interface, swappable), a
> fresh `village/actions.ts` instead of refactoring the God-critical MCP tool
> handlers, and the skill dry-run step folded into typecheck + register-mode
> top-level run (runtime strikes cover the rest). M10–M14 deviations:
> multilingual MiniLM (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`) instead
> of the paper's English-only all-MiniLM-L6-v2 (French villagers: measured
> 0.77-vs-0.01 topic separation against 0.42-vs-0.39); skill retrieval is
> token-overlap, not embedding-based (≤24 skills/bot — an index buys nothing);
> plan-time-shifting simplified to slot re-assertion. M9 (live hardening: a
> real 10-bot overnight run, pathfinder tuning, chat-spam-kick check at M3
> scale, live S1–S14 pass) remains operational work that needs a running
> server.

A plan for a village of ~10 LM-powered bots: each with its own perception, tools,
memory and personality; talking to each other in turns; working (farming, mining,
crafting); trading via negotiated barter; and **reactive without burning an LLM
call per event** — because the bots write their own reflex code.

Companion docs: [GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md) (the
single-avatar precedent this builds on), [CLAUDE.md](CLAUDE.md) (current
architecture ground truth).

Difficulty scale used throughout: **Easy / Medium / Hard / Very Hard**.

---

## 0. TL;DR of the architecture

```
┌─────────────────────────  Node "village" process (new, src/village/) ─────────────────────────┐
│                                                                                               │
│  BotHost ──── 10 × BotConnection (mineflayer)  ←──── Minecraft protocol ────→  Fabric server  │
│     │                                                                          (pauls-brawls │
│  per bot:                                                                       mod, Java)    │
│   ├─ ObservationBuilder   (self-relative world snapshot, free)                     ▲          │
│   ├─ ReflexEngine         (bot-AUTHORED code, runs on events, NO LLM)              │          │
│   ├─ RoutineRunner        (job loops: farm/mine/craft, NO LLM)                     │ HTTP     │
│   ├─ AgentRuntime         (the LLM brain — called only when it matters)            │ localhost│
│   └─ Memory               (episodic log + relationships + skill library, SQLite)   │          │
│                                                                                    │          │
│  VillageScheduler  (global LLM budget: priority queue, concurrency cap)            │          │
│  ConversationManager (turn-taking between bots, mirrors to in-game chat)           │          │
│  TradeManager      (negotiation state machine) ── POST /trade/execute ─────────────┘          │
│  EventBus          (coalesced mineflayer events → reflex subscriptions)                       │
└───────────────────────────────────────────────────────────────────────────────────────────────┘

Java mod additions: a tiny localhost HTTP listener for ATOMIC trade settlement
(server-authoritative inventory swap, Gibber coins included), a /village admin
command, and (only if needed) a spam-kick exemption mixin for bot accounts.

The God stack (ChatBot.java, MCPGateway, unified entrypoint) is NOT touched.
Villagers are a parallel system; God can join the village later as an NPC-deity.
```

The three-layer cognition stack is the heart of the plan and the direct answer
to "entityHurt would trigger ten LLMs at once":

| Layer | Runs | Cost | Examples |
|---|---|---|---|
| **L0 Reflexes** | bot-authored code, fired by events | 0 LLM calls, <1 ms | fight back, flee, run to guards, wave at a friend |
| **L1 Routines** | bot-authored (or stock) job loops | 0 LLM calls | farm loop, woodcutting loop, smelting batch |
| **L2 Deliberation** | the LLM | 1 call | conversations, trade negotiation, planning the day, reacting to anything a reflex escalates via `think()` |

Events flow into L0. L0 handles the common case in code and calls `think(reason)`
only when it's out of its depth. L2 writes and rewrites the L0/L1 code. That's
the "bots write their own code" idea, formalized — it's essentially the Voyager
pattern (LLM-authored executable skills) plus a subsumption-style reflex layer.

---

## 1. What we already have, and what it buys us

| Asset | Reused for the village? |
|---|---|
| `BotConnection` (connect/reconnect/plugins) | **Yes, heavily** — becomes the per-villager body. Already handles spawn, reconnect, pathfinder, pvp, collectblock, auto-eat, armor-manager. |
| The 25 MCP tools' underlying logic (`src/tools/*`) | **Yes, after a refactor** — the *handlers* contain the real mineflayer recipes (move, craft, collect, attack…). Extract them into plain async functions (`src/actions/*.ts`) callable both by MCP registration AND by the villager action API. |
| `MessageStore` | Yes — per-bot chat ring buffer. |
| Gibber coin item + `RevenueManager` | **Yes** — the village currency already exists. Trades can be item↔item or item↔coins. |
| `GodActionQueue` (main-thread hop in Java) | Yes — the trade-settlement endpoint enqueues through it (or a sibling queue). |
| LangChain4j Java pipeline (`ChatBot.java`) | **No** (see Decision D1). It stays as-is for the God. |
| MCP-over-SSE | **No** for villagers — brains live in the same process as the bodies, so tools are direct function calls. MCP remains the God's channel. |
| `BridgeConfig`/`BotBridgeClient` pattern | Yes, as a *template* — a `VillageBridgeClient` in Java for admin commands, and the Java HTTP-listener idea inverts it for settlement. |

---

## 2. The load-bearing decisions

### D1. Where do the villager brains live — Java or Node? → **Node**

| | A: scale the God (brains in Java) | B: village brain in Node (recommended) |
|---|---|---|
| LLM plumbing | Reuse LangChain4j, LLMConfig, providers | New, but small: all three providers (OpenAI, LM Studio, Ollama) speak the same `/v1/chat/completions` — one fetch wrapper covers them |
| Perception | Every observation crosses HTTP/MCP (10 SSE sessions, serialization, latency) | Direct mineflayer reads, free and instant |
| Tool dispatch | MCP tools need a `botId` param threaded through everything; `ToolFactory`/`MCPGateway` reworked | Direct function calls, no protocol |
| The reflex sandbox | Must live Node-side anyway (it drives mineflayer) → **split brain**: reflexes in Node, deliberation in Java, skill code shipped across the wire | Same process as the bodies — natural |
| Conversations between bots | Java↔Java via shared state, but each utterance still round-trips to Node for the body | In-process inboxes, mirror to game chat |
| Risk to existing God | High — touches ChatBot/MCPGateway/unified | ~Zero — God untouched |

The sandbox argument is decisive: the user's centerpiece feature (bots writing
their own reactive code) has to execute next to mineflayer. Putting deliberation
in Java would split every bot's mind across two processes. **Choose B.** Cost:
a second LLM stack (TypeScript) to maintain — acceptable because it's one
provider-agnostic fetch wrapper, not a framework.

**Difficulty of the Node LLM loop itself: Medium** (tool-calling loop, retries,
timeouts — well-trodden ground).

### D2. Process topology → **one new Node process for all 10 villagers, separate from the God's unified process**

- One process, 10 `BotConnection`s: mineflayer bots are ~80–150 MB RSS each and
  mostly idle CPU; 10 in one Node process is fine if we (a) set
  `viewDistance: 'tiny'` per bot (big memory saver), (b) cap concurrent
  pathfinder computations (2–3 at a time — A* spikes are the real CPU hog).
- **Separate from `src/unified/main.ts`**: the God process is load-bearing and
  stable; the village is experimental and heavy. A village crash must not kill
  the God's avatar. New entrypoint `src/village/main.ts` (`npm run village`),
  own port (e.g. 8766), distinct usernames → no login-kick conflicts.
- Sharding to N processes later is trivial (BotHost is already a map).

**Difficulty: Medium.** The refactor is mechanical (the unified entrypoint shows
exactly the single-bot assumptions to lift: one `connection`, one `getBot`, one
`MessageStore`). The perf tuning (pathfinder caps, stagger) is the real work.

### D3. The cognition stack → three layers, LLM only at the top (described in §0)

The decision matrix for "an event happened near bot X":

1. Is there a **plugin-level automatism**? (auto-eat, armor-manager) → handled, 0 cost.
2. Does X have a **reflex subscribed** to this event? → run it (sandboxed, budgeted). The reflex may act via the bot API, message another bot, or call `think()`.
3. Did the reflex call `think(reason, urgency)`? → enqueue a **deliberation request** on the VillageScheduler. Coalescing: multiple `think`s from the same bot within a window merge into one call with all reasons listed.
4. No reflex, event marked "notable"? → append to episodic memory only (the bot will see it at its next scheduled thought; no immediate call).

Plus a **heartbeat**: each bot gets a low-priority deliberation slot every few
minutes (round-robin, budget-gated) to plan, start jobs, decide to socialize.
If the LLM is down or budget exhausted, bots degrade gracefully to L0+L1 —
they keep farming and fleeing, they just stop having new ideas. That
degradation property falls out of the architecture for free and is worth
preserving deliberately.

**Difficulty: Medium for the plumbing, Hard to tune well** (coalescing windows,
urgency levels, starvation-prevention).

### D4. The script language & sandbox → **JavaScript with a typed API, not Python**

Options considered for the bot-authored code:

| Option | Isolation | Infinite-loop safety | LLM fluency | Weight | Verdict |
|---|---|---|---|---|---|
| Python via Pyodide | good (wasm) | yes | good | ~10 MB wasm per isolate, slow startup, awkward async bridge to mineflayer | Too heavy ×10 bots |
| Mini-Python interpreter (Skulpt etc.) | n/a | partial | poor (dialect gaps) | light | Dead ecosystems, subtle dialect bugs |
| Lua (wasmoon) | good | yes (cycle budget) | decent | tiny | Solid runner-up; coroutines are lovely for game scripts |
| **JS, in-process with AST loop-guards** | none (it's our own LLM's code, private server) | yes via injected loop counters | **excellent** | zero | **v1 choice** |
| **JS in QuickJS (quickjs-emscripten)** | real (wasm) | yes (interrupt handler) | excellent | small, pure-wasm npm install (no node-gyp pain on Windows) | **v2 upgrade path** |
| isolated-vm | real (v8 isolates) | yes | excellent | native build — node-gyp on Windows, friction | avoid |
| Custom DSL / behavior-tree JSON | total | yes | poor (LLMs write real languages better than your invented one) | light | only as a fallback |

Why JS over the suggested Python: the *author* of this code is the LLM, not
Paul — so optimize for LLM fluency, sandbox cost, and proximity to mineflayer
(whose entire API is JS). Voyager validated exactly this: LLM-written JS skills
driving mineflayer. The "types" the user wants come from a **published `.d.ts`
API contract**: the villager API surface is defined once as TypeScript types,
included in the system prompt, and — the killer feature — every LLM-drafted
script is **type-checked with `tsc` before it ever runs**. Compile errors go
straight back to the bot as feedback, no world side effects.

Threat model honesty: in-process v1 has no security boundary. That's acceptable
because the code author is our own model on a private server — the realistic
risk is *bugs*, not malice. The two bugs that matter:
- **Infinite loops** would freeze all ten bots (one event loop) → mitigated by
  an AST transform (acorn) injecting cycle-budget checks into every loop body,
  plus wall-clock timeouts on every `await` of the bot API.
- **Resource leaks** (subscriptions, dangling pathfinder goals) → the API hands
  out handles owned by the ReflexEngine; reloading a bot's reflexes disposes
  everything it registered.

If/when that's not enough, swap the executor for QuickJS — the API surface
doesn't change, only the host. (This is why the API must be a narrow, explicit
surface from day one: it's the portability seam.)

**Difficulty: Hard.** Not the sandbox itself — the *lifecycle* (below, §4) and
making LLM-authored code reliable enough to trust with the bot's safety.

### D5. Trade settlement → **server-authoritative atomic swap in the Java mod**

Physically tossing items between bots (mineflayer `toss` + pickup) is flaky:
despawns, third-party pickup (a player! a hopper! lag), partial exchanges.
The Fabric mod has god-mode power over inventories — use it:

1. Negotiation happens entirely Node-side (LLM conversation, §6).
2. On mutual accept, TradeManager pre-validates both inventories from
   mineflayer's view, then POSTs `{ botA, botB, give: [...], get: [...] }` to a
   new **localhost HTTP listener in the Java mod** (`com.sun.net.httpserver`,
   ~100 lines, mirrors the bridge's localhost-only/no-auth posture in reverse).
3. The handler hops to the main thread (via `GodActionQueue` or a sibling),
   **re-validates authoritatively**, swaps the stacks atomically (coins are just
   another item — Gibber integration is free), responds ok/fail.
4. Failure (inventory changed mid-handshake) → bots are told the deal fell
   through. That's not a bug, it's emergent village drama.

Why a Java HTTP listener and not the existing direction (Java→Node)? Because
settlement is Node→Java, and the alternatives are worse: polling (ugly), or
making an opped bot type a `/village_trade` chat command (string-escaping RPC
over chat — no).

**Difficulty: Easy–Medium for settlement** (the mod owns the world; the only
care is main-thread discipline, a solved problem here). **Medium for the
negotiation protocol** (§6).

### D6. Models & budget → cheap model by default, tiered, hard concurrency cap

- All three existing providers work unchanged (OpenAI / LM Studio / Ollama —
  one OpenAI-compatible endpoint). Config mirrors `llm_config.properties`
  philosophy: `village_config.json` with provider/model/key/concurrency.
- **Order-of-magnitude cost check** (≈2.5k tokens in / 300 out per deliberation):
  10 bots × 1 heartbeat per 2 min = 300 calls/h ≈ 750k in + 90k out per hour.
  On a mini/haiku-class API model that's roughly **$0.2–$1.2/hour** — fine.
  On a *local* model at ~50 tok/s, 300 calls/h ≈ more GPU-seconds than an hour
  has → heartbeats must stretch to 5–10 min, conversations become the budget.
  **The scheduler is not optional; for local models it is the feature.**
- Tiering option (later): cheap model for heartbeats/banter, stronger model for
  trade negotiation and code-writing (code quality matters most there).
- Hard cap: 2–4 LLM calls in flight globally. Priority order:
  **player-directed > combat escalation > active conversation turn > job event > idle heartbeat.**

**Difficulty: Easy to build, ongoing to tune.**

### D7. Conversations → in-process turn engine, mirrored to game chat

Minecraft chat is global; ten bots chatting raw would be spam (and vanilla
*will* kick for chat spam). So:

- Bot↔bot utterances route **in-process** (inboxes), instant and free.
- Each utterance is **mirrored** to in-game chat via `bot.chat` (prefixless,
  it's the bot's own mouth) **rate-limited** (~1 line/s/bot) and only when a
  player is within earshot (~32 blocks) — players see the haggling, the server
  isn't flooded. If kicks still occur, a small mod-side mixin exempts village
  accounts from the spam counter (**that mixin: Medium**, only if needed).
- **Earshot is real**: bots within radius of a conversation get the transcript
  appended to their episodic memory for free — gossip propagates with zero LLM
  calls. An eavesdropper *may* get a low-priority `think` if its reflexes flag
  the content (e.g. its own name).

ConversationManager invariants: a bot is in ≤1 conversation; turns alternate
with a per-turn deadline; max ~8 turns then auto-wrap-up; either side can
`leave()`; the scheduler treats "it's my turn" as one deliberation request.
Runaway bot↔bot loops are structurally impossible (turn cap + budget), which is
the classic failure of naive multi-agent chat.

**Difficulty: Medium** — the engine is simple; making conversations *end*
naturally and read believably is prompt work.

### D8. Perception → self-relative ObservationBuilder, built Node-side

Per deliberation, a compact JSON snapshot from mineflayer state (all free):
position/health/hunger/inventory summary; nearby entities tagged with village
metadata (name, role, relationship score); nearby notable blocks (workstation
proximity); time of day/weather; active job + progress; inbox (unread messages);
last N episodic memory lines; current reflex/skill roster (names + one-liners).
This is the villager-equivalent of `PlayerDataCollector` — but with no Java
round-trip and no main-thread hop. **Difficulty: Easy–Medium** (the work is
deciding what to *omit* to keep prompts ~2–3k tokens).

### D9. Memory & persistence → SQLite (better-sqlite3), summarize don't grow

- `bots` (name, role, personality, home, workstation), `skills` (code, version,
  status, error count), `memories` (episodic, with periodic LLM summarization
  into a rolling "life summary" so context stays bounded), `relations`
  (bot↔bot/player score + notes — feeds trading prices and who-helps-whom),
  `ledger` (every trade — the village economy becomes inspectable).
- Working memory per bot = same token-window discipline as `ChatBot.memories`
  (that lesson is already learned in this repo).
- **Difficulty: Easy–Medium.** Summarization cadence costs a few LLM calls/hour.
- **June 2026 addendum (implemented):** evicted window entries now land in a
  persisted per-bot **archive** (cap 2 000) instead of being dropped after
  summarization, and every entry carries normalized keyword tags
  (writer-supplied names/items + a French-aware tokenizer; the summarization
  call also returns a `MOTS-CLÉS:` line that enriches the archived batch).
  Lookup surfaces: a `recall` deliberation tool (memories + trade ledger), an
  auto-injected `RELEVANT OLDER MEMORIES` prompt block, and
  `GET /village/bot/<name>/memory?q=…` on the admin port. The
  unsummarized-batch counter is persisted — a crash before summarization no
  longer loses the batch. See `src/village/memory-index.ts` / `memory.ts`;
  pinned by `tests/village-memory.test.ts`.

### D10. World & accounts → pre-built village, offline-mode accounts, no op

- **Pre-build the village** (or commandeer a generated one): plots, farm,
  mine entrance, crafting hall, market stall, guard post. Bot-built housing is
  a Hard problem this plan deliberately defers (the BuildPlan/sub-agent stack
  exists for the God; don't block the village on it).
- A `village.json` roster maps each bot → name, role, personality blurb, home
  coords, workstation coords, starting inventory. Suggested cast: farmer ×2,
  lumberjack, miner, blacksmith/crafter, shopkeeper, guard ×2, fisher, mayor.
- Server must be offline-mode (it already runs `LLMBot` this way). Villager
  usernames must NOT match `BridgeConfig.botUsername` — op-on-join is the
  God's privilege; villagers need no op (no `/tp`, no commands).
- Chunk loading: bots hold player-type chunk tickets just by existing — the
  village stays loaded for free. Death: respawn at the village (bed/spawnpoint),
  write "I died: <cause>" to episodic memory; keepInventory is a server-rule
  decision (recommend ON initially — losing a trader's whole stock to one creeper
  makes the economy boring fast).

**Difficulty: Easy (config/worldbuilding), plus Medium one-time worldbuild labor.**

---

## 3. Component inventory (what gets built, where)

### Node side — new `src/village/` (in the vendored sub-project)

| Component | Job | Difficulty |
|---|---|---|
| `village/main.ts` | Entrypoint: load roster, start BotHost + HTTP admin | Easy |
| `BotHost` | N × BotConnection, lifecycle, per-bot stores, staggered logins | Medium |
| `actions/*.ts` refactor | Extract mineflayer logic from `tools/*` handlers into shared plain functions (MCP keeps working for God) | Medium (mechanical but wide) |
| `ObservationBuilder` | §D8 | Easy–Medium |
| `EventBus` | Subscribe/coalesce/rate-limit mineflayer events per bot (`entityHurt` storms → one `combat-started`) | Medium |
| `ReflexEngine` + sandbox | Run bot-authored handlers w/ loop-guards, timeouts, handle ownership | Hard |
| `SkillLibrary` | Store/version/typecheck/dry-run bot-authored code; error feedback loop | Hard |
| `RoutineRunner` | Long-running job loops (stock routines first, bot-authored later) | Medium |
| `AgentRuntime` | LLM loop: prompt assembly, tool-calling, retries, provider adapter | Medium |
| `VillageScheduler` | Global budget, priority queue, coalescing, fairness | Medium build / Hard tune |
| `ConversationManager` | §D7 | Medium |
| `TradeManager` | Negotiation state machine + settlement client | Medium |
| Persistence (SQLite) | §D9 | Easy–Medium |
| Admin HTTP (`/village/*`) | status, pause/resume, budget, per-bot inspect | Easy |

### Java side — pauls-brawls mod

| Component | Job | Difficulty |
|---|---|---|
| `VillageHttpListener` | localhost listener; `/trade/execute` → main-thread atomic swap (+ Gibber coins) | Easy–Medium |
| `/village` command | admin: status/pause/resume via `VillageBridgeClient` (clone of `BotBridgeClient`) | Easy |
| Spam-kick exemption mixin | only if mirrored chat trips vanilla's spam kick | Medium (only if needed) |

### Stock tool surface for the villager LLM (direct calls, not MCP)

`goTo, follow, flee, dig, place, collect, craft, smelt, equip, attack, stopCombat,
depositToChest, withdrawFromChest, say, tell(bot, msg), startConversation(bot),
proposeTrade / acceptTrade / counterTrade / rejectTrade, startJob/stopJob,
writeReflex / writeRoutine / listSkills / removeSkill, remember(note), think-done.`
Most map 1:1 onto extracted `actions/*` functions; the skill/trade/conversation
ones are new.

---

## 4. The self-written-code system (the centerpiece)

### The API contract (sketch — this exact `.d.ts` goes in the system prompt)

```ts
interface VillagerAPI {
  // perception — synchronous snapshots, free
  self(): SelfState;                                  // pos, health, hunger, inventory
  nearbyEntities(radius?: number): EntityInfo[];      // tagged with role/relationship
  nearbyBlocks(match: string, radius?: number): Vec3[];

  // actions — async, serialized per bot, each with a wall-clock timeout
  goTo(pos: Vec3, range?: number): Promise<void>;
  flee(from: Vec3, distance: number): Promise<void>;
  attack(entityId: number): Promise<void>;
  dig(pos: Vec3): Promise<void>;  place(item: string, pos: Vec3): Promise<void>;
  craft(item: string, count: number): Promise<void>;
  equip(item: string): Promise<void>;

  // social — free, no LLM
  say(message: string): void;                         // local mirrored chat
  tell(botName: string, message: string): void;       // direct inbox delivery

  // cognition
  think(reason: string, urgency?: 'low' | 'high'): void;  // escalate to my LLM
  remember(note: string): void;                            // episodic memory append

  // reactivity
  on(event: VillageEvent, handler: (e: EventPayload) => void | Promise<void>): void;
}
// VillageEvent: 'hurt' | 'entity-spotted' | 'message' | 'job-done' | 'job-failed'
//             | 'item-received' | 'night-falls' | 'player-nearby' | ...
```

### The user's exact scenario, as a farmer-authored reflex

```js
bot.on('hurt', async (e) => {
  if (e.attacker?.kind !== 'hostile') { bot.think('a player or villager hit me?!', 'high'); return; }
  const guards = bot.nearbyEntities(64).filter(x => x.role === 'guard');
  if (guards.length === 0 && bot.self().health > 12) {
    await bot.attack(e.attacker.id);                       // fight back
  } else if (guards.length > 0) {
    await bot.flee(e.attacker.pos, 16);                    // run away…
    await bot.goTo(guards[0].pos, 3);                      // …to the guards
    bot.tell(guards[0].name, `Au secours ! ${e.attacker.type} près de la ferme !`);
  } else {
    bot.think('attacked, low health, no guards in range', 'high');  // out of my depth
  }
});
```

The guard's own reflex on `'message'` pattern-matches a help call and engages
via the pvp plugin — **the entire combat path, including the social hop through
the guard, costs zero LLM calls**. Each bot's LLM only wakes when its code says
"I don't know what to do here."

### Skill lifecycle (what makes this reliable instead of chaos)

1. **Draft** — during deliberation the bot calls `writeReflex(name, description, code)`.
2. **Typecheck** — `tsc` against the API `.d.ts`. Errors → returned as the tool
   result; the bot fixes its own code in the same conversation. No world contact yet.
3. **Static guards** — AST pass: inject loop cycle-budgets, reject banned
   identifiers (`require`, `process`, `fetch`, …).
4. **Dry-run** — execute once against a mock event with a frozen-world API stub;
   uncaught throw → rejected with the stack trace as feedback.
5. **Register** — versioned in SkillLibrary, handlers subscribed via EventBus.
6. **Runtime error feedback** — a reflex that throws in production gets its
   error + event payload queued into the bot's next deliberation ("your reflex
   `defend-farm` threw: …"). Three strikes → auto-disabled until the bot
   rewrites it. **Self-healing code, with a circuit breaker.**

Seed each role with 2–3 **stock reflexes/routines** at spawn (flee-when-low-HP,
the farm loop, answer-when-greeted) so the village functions on day one and the
bots' own code displaces the stock gradually. This de-risks the hardest
component: the village never *depends* on the LLM writing good code, it just
gets richer when it does.

**Difficulty: Hard overall.** Sub-parts: sandbox+guards Medium, typecheck
pipeline Easy–Medium, async API bridging Medium, dry-run hard-to-fake parts
Medium, making the *feedback loop* converge (bots actually fixing their code
rather than thrashing) **Hard — this is the research-flavored bit**.

---

## 5. Trading, end to end

1. **Motive** (free): the heartbeat or a routine notices "carrots overflowing,
   no planks" → deliberation decides to trade; or the shopkeeper's reflex greets
   anyone entering the market stall.
2. **Negotiation** (LLM, bounded): ConversationManager opens a trade-flavored
   conversation. Mid-conversation tools: `say`, `proposeTrade({give, want})`,
   `counterTrade`, `acceptTrade`, `rejectTrade`, `leave`. Offers are **typed
   objects**, not prose — the prose is flavor, the offer object is the contract.
   Relationship scores and the ledger feed the prompt ("he lowballed you last
   time"), which is where village personality compounds.
3. **Settlement** (authoritative, §D5): mutual accept → Node pre-check → POST
   to the Java listener → main-thread re-validate + atomic swap → ledger entry
   + episodic memories on both sides ("traded 32 carrots for 8 planks with Bob").
4. Coins are items — shopkeeper naturally becomes the coin sink/source,
   plugging straight into the existing Gibber economy.

**Difficulty: Medium** (negotiation prompt + state machine) **+ Easy–Medium**
(settlement). The typed-offer design is what keeps LLM vagueness out of the
economy.

---

## 6. Roadmap — milestones, exit criteria, difficulty

| # | Milestone | Exit criterion | Difficulty |
|---|---|---|---|
| M0 | **Multi-bot host** — `src/village/main.ts`, BotHost, roster file, staggered logins, admin `/village status` | 3 bots idle in the village, stable for an hour, RAM/CPU acceptable | Medium |
| M1 | **One brain** — actions/* extraction, ObservationBuilder, AgentRuntime, heartbeat for ONE bot | One villager wanders, comments on surroundings, picks up items, on a heartbeat | Medium |
| M2 | **Scheduler + ten brains** — budget, priorities, coalescing; all 10 on heartbeats | 10 bots, LLM concurrency ≤3, no starvation, cost within target | Medium build / Hard tune |
| M3 | **Conversations** — inboxes, turn engine, chat mirroring, earshot gossip | Two bots have a believable 6-turn chat a player can watch; a third overhears and remembers | Medium |
| M4 | **Work** — RoutineRunner + stock routines: farm loop, woodcutting, craft batch; workstation assignment | Farmer farms all day unattended; lumberjack restocks the crafter | Medium (farming) / Medium–Hard (mining later) |
| M5 | **Trading** — protocol tools, TradeManager, Java settlement listener, ledger | Two bots negotiate and the items actually swap, atomically, coins included | Medium |
| M6 | **Self-written code** — sandbox, typecheck, lifecycle, stock-reflex seeds, error feedback | A bot writes a working reflex that fires correctly on a real event; a broken one gets auto-disabled and rewritten | **Hard** |
| M7 | **Reactivity at scale** — the guard scenario, event storms, degradation modes (LLM down → village keeps working) | Zombie attack on the farm resolves through reflexes + guard with ≤1 LLM call | Hard |
| M8 | **Texture** — personalities, relationships feeding trades, summarized life memories, persistence across restarts | Restart the server; bots remember who they like and what they own | Medium |
| M9 | **Hardening** — chaos (kill the LLM, kill a bot, lag the server), perf, cost tuning | An overnight run with nothing on fire | ongoing |
| M10 | **Memory (paper)** — write-time importance, local-embedding semantic retrieval (relevance·recency·importance triple), reflection (salience + lessons) riding the summarization call. `embeddings.ts`, vector sidecars, `BotMemory.retrieve` | **DONE** — buried high-importance memory surfaces in the deliberation prompt over 60 noise entries (S9); zero new LLM call sites | Medium |
| M11 | **Daily rhythm (paper)** — dawn `plan` deliberations (`set_day_plan`), zero-LLM slot executor, rest/social drives with `tired`/`lonely` events, lightweight mood via `done`. `day-planner.ts` | **DONE** — scripted plan starts farm-loop in the work slot and walks the farmer home at dusk (S10); needs reflex fires with zero LLM (S11); +1 call/bot/MC-day | Medium |
| M12 | **Social depth (paper)** — `leave_conversation{opinion,note,headline}` moves relations + diffuses headlines to both parties, NOUVELLES À PARTAGER block, free proximity greet gate (social/relation/visit gated, pair-cooldown) | **DONE** — scripted chat moves the relation ≥ +5, both hold the headline, an in-earshot third villager overhears (S12) | Medium |
| M13 | **Voyager stack** — relevance-gated skill code in prompts, `invokeSkill` composition (depth cap 2, real sandbox), declarative `start_job` goals verified at job end, heartbeat PROGRESSION curriculum | **DONE** — seeded skill reaches the prompt with code and runs (S13); missed goal verdict lands in the job-done wake AND the next heartbeat's curriculum (S14) | Medium–Hard |
| M14 | **Latency tiering** — `fastModel` in LLM settings; conversation + player wake-ups and summarization ride the fast tier, planning/authoring stay on the main model | **DONE** — tier-routing pinned by unit tests; same call count, lower player-facing latency | Easy |

Sequencing notes: M0→M2 are strictly ordered. M3/M4 can interleave after M2.
M5 needs M3. M6 can start anytime after M1 (it only needs one brain + the
EventBus) and is the long pole — start it early in parallel. M7 needs M6.
M10 underpins M12 (gossip retrieval) and M13 (outcome recall); M11's needs
feed M12's greet gate. The M10–M14 wave is the intersection with the
NPC-village paper (Generative-Agents lineage) and Voyager — what it
deliberately does NOT port: per-event LLM sensory filtering, 7D emotions +
Big Five evolution (→ one mood string), Voyager's standalone curriculum
agent, and group conversations (still 1v1).

---

## 7. Risks & honest unknowns

- **LLM-written code quality** is the big bet. Mitigated by: typecheck-first,
  dry-runs, stock-reflex fallbacks, circuit breakers — but whether bots
  *converge* on good reflex libraries vs. thrash is genuinely empirical. (M6)
- **Local-model throughput**: 10 bots on one local GPU means heartbeats in
  minutes, not seconds. The design tolerates it (reflexes carry the moment-to-
  moment), but "lively village" on pure-local needs expectation-setting or an
  API-model budget.
- **Pathfinder CPU** with 10 bots in close quarters (doorways! they will jam in
  doorways) — cap concurrency, keep paths short, accept some comedy.
- **Chat spam kicks** — mitigations stack (rate limit → earshot-only → mixin),
  but vanilla's counter is crude; test early at M3.
- **Server-side performance**: 10 fake players ticking, ~10 chunks-radius each
  even at tiny view distance. Watch MSPT at M0, not M8.
- **Prompt-injection-by-villager**: bots read each other's chat; a bot can in
  principle talk another bot into something dumb. For a private sandbox that's
  a feature (social engineering between villagers!), but keep `say`-content out
  of any privileged path (it already is: settlement validates inventories, not
  promises).

## 8. Open questions (defaults chosen, flag to change)

1. **Provider/model** — default: cheapest API-tier model for everything;
   tiering later. Change if this should run pure-local from day one (affects M2 tuning targets).
2. **Village site** — default: Paul pre-builds/picks a site and fills `village.json`.
3. **Players in the loop** — default: villagers respond to player chat in
   earshot and will trade with players via the same protocol (settlement
   validates the player's real inventory too). It's the most fun feature and
   nearly free once M5 lands.
4. **Death rules** — default: keepInventory ON for villagers initially.
5. **God × village** — default: out of scope until M8+; then the God becomes
   the village's deity (it already has the tools to smite and reward, and
   prayers from villagers are one `tell()` away).
