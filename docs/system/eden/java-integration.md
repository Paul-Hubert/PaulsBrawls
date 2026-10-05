---
id: eden.java-integration
title: Eden Java integration - settlement listener, /village, /villagers, op-on-join
system: eden
summary: The mod's server-authority duties for the village - the :8767 trade-settlement HTTP listener, VillageConfig, /village and /villagers commands, op-on-join, and how Eden's clients match (or do not match) them.
tags: [eden, village, settlement, trade, http, 8767, 8770, VillageHttpListener, VillageConfig, VillageCommand, VillagersCommand, op-on-join, scenario, coin]
sources: [src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/java/com/paul/brawl/TradeMath.java, eden/tests/fakes/fake-settlement.ts, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/VillageCommand.java, src/main/java/com/paul/brawl/VillagersCommand.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/BridgeConfig.java, eden/src/social/trade.ts, eden/src/types/social.ts, eden/src/main.ts, eden/src/config.ts, eden/src/admin/server.ts, eden/src/village-launch.ts, eden/eden.example.json, eden/tests/social-trade.test.ts]
verified_at: 4a8081f
---

# Eden Java integration - settlement listener, /village, /villagers, op-on-join

**TL;DR** — The Fabric mod gives the village four things: (1) a localhost HTTP listener
`POST 127.0.0.1:8767/trade/execute` that validates (per-item totals) and swaps the real item stacks between
two nearby online players on the main thread; (2) `/village` (config + listener toggle + legacy v1 status/pause/resume); (3) `/villagers
start|stop|restart` which drives Eden's admin API on `:8770`; (4) op-on-join for `LLMBot`, `Dieu` and the
current scenario's villagers. The Eden `SettlementClient` now sends the listener's own shape
`{botA,botB,aGives,bGives}` (it used to send `{from,to,give,want}` → 400 `missing botA`, bug #1, fixed),
and it is now **called**: villagers trade through `propose_trade`/`answer_trade`, and an accepted offer is
POSTed here (with `X-Village-Token` when `EDEN_SETTLEMENT_TOKEN` is set).

## Components at a glance

| Piece | Class | Port / file | Registered at |
|---|---|---|---|
| Settlement listener | `VillageHttpListener` | `127.0.0.1:8767` (`listenerPort`) | started in `SERVER_STARTED`, stopped in `SERVER_STOPPING` (`ServerEntryPoint.java:49`, `:55`) |
| Config | `VillageConfig` | `village_config.properties` in JVM cwd | singleton, loaded on first class use |
| `/village` | `VillageCommand` | talks to `nodeAdminUrl` (`:8766`, legacy v1) | `ServerEntryPoint.java:39` |
| `/villagers` | `VillagersCommand` | talks to `edenAdminUrl` (`:8770`, Eden) | `ServerEntryPoint.java:42` |
| Op-on-join | inline in `ServerEntryPoint` | — | `ServerEntryPoint.java:61-74` |

## `VillageConfig` (`VillageConfig.java`)

File: `Path.of("village_config.properties")` — relative to the JVM working directory (`run/` for
`./gradlew runServer`, the server root in production) (`:23`). Java `Properties` format, header comment
`AI village configuration`.

| Key | Field | Type | Default | Used by |
|---|---|---|---|---|
| `enabled` | `enabled` | boolean | `true` | `VillageHttpListener.start` gate |
| `listenerPort` | `listenerPort` | int | `8767` | listener bind port |
| `maxTradeDistance` | `maxTradeDistance` | double | `16.0` | max blocks between the two settlement parties (same dimension required); `<= 0` disables the distance check |
| `settlementToken` | `settlementToken` | string | `""` | if non-blank, every settlement must send it in the `X-Village-Token` header (else 401) |
| `nodeAdminUrl` | `nodeAdminUrl` | string | `http://127.0.0.1:8766` | `/village status|pause|resume` (v1 Node process) |
| `edenAvatarName` | `edenAvatarName` | string | `Dieu` | op-on-join |
| `edenAdminUrl` | `edenAdminUrl` | string | `http://127.0.0.1:8770` | `/villagers …` |

Lines `:28-53`. Lifecycle:

- `load()` runs once in the private constructor (`:55-57`, `:75-91`). Missing file → defaults, **no file
  is written**. Unparseable int/double → keeps default; booleans use `Boolean.parseBoolean` (anything but `true`
  → `false`); `settlementToken` is trimmed.
- `save()` (`:59-73`) writes all seven keys; it is only called by `/village on` and `/village off`.
- There is no reload command; edits to the file need a server restart (the class Javadoc's "tune without a
  restart" is not implemented).
- `describe()` returns `VillageConfig{enabled=…, listenerPort=…, maxTradeDistance=…, settlementToken=set|unset, nodeAdminUrl=…, edenAvatarName=…, edenAdminUrl=…}`
  — the token itself is never echoed (it is shown in chat by `/village`).

## Settlement listener — `VillageHttpListener`

### Lifecycle (`VillageHttpListener.java:93-129`)

| Method | Behaviour |
|---|---|
| `start(mc)` (`synchronized`) | No-op if already running. If `!enabled` logs `Village settlement listener disabled by config.` and returns. Binds `com.sun.net.httpserver.HttpServer` on `127.0.0.1:<listenerPort>` (backlog 0). On bind failure logs `Village settlement listener failed to bind 127.0.0.1:<port>: <msg>` (warn) and stays stopped — the server keeps running. Registers one context `/trade/execute`, a single-thread daemon executor named `village-settlement-http`, then logs `Village settlement listener on http://127.0.0.1:<port>/trade/execute` (plus `No settlementToken configured — any local process can settle village trades.` when the token is blank). |
| `stop()` (`synchronized`) | `server.stop(0)`, logs `Village settlement listener stopped.` |
| `isRunning()` | `server != null` |

Requests are handled **one at a time** (single executor thread), each blocking ~1 tick on the main thread.

### Route

`POST /trade/execute` — `HttpServer` contexts are prefix matches, so `/trade/execute/anything` reaches the
same handler; other paths get the JDK default 404. Bound to loopback only. Authentication is opt-in: when
`settlementToken` is set, the `X-Village-Token` header must match it (constant-time compare,
`tokenMatches`, `:203-210`); with the default blank token any local process may call it.

Request body (Gson → `TradeRequest`, `:76-81`):

```json
{
  "botA": "Jean",
  "botB": "Pierre",
  "aGives": [ { "item": "carrot", "count": 32 } ],
  "bGives": [ { "item": "coin",   "count": 5  } ]
}
```

`aGives` = items moved from `botA` to `botB`; `bGives` = items moved from `botB` to `botA`.

Response (always `Content-Type: application/json`, Gson omits nulls):

| Outcome | Status | Body |
|---|---|---|
| Swap done | 200 | `{"ok":true}` |
| Any validation / game failure | 400 | `{"ok":false,"error":"<reason>"}` |
| Non-POST method | 405 | `{"ok":false,"error":"POST only"}` |
| Token configured and header missing/wrong | 401 | `{"ok":false,"error":"bad or missing X-Village-Token"}` |

### Validation — HTTP thread (`handleTrade` + `validateShape`/`validateSpec`, `:133-200`)

| Check | Error string |
|---|---|
| Method ≠ POST (case-insensitive) | `POST only` (405) |
| Token set and `X-Village-Token` ≠ token | `bad or missing X-Village-Token` (401) |
| Body > 64 KiB (`MAX_BODY_BYTES = 65536`) | `body too large` |
| Malformed JSON / wrong types | `bad json: <gson message>` |
| Empty body (Gson returns null) | `empty request` |
| `botA` null/blank | `missing botA` |
| `botB` null/blank | `missing botB` |
| `botA.equalsIgnoreCase(botB)` | `botA and botB are the same` |
| `aGives` or `bGives` null | `missing aGives/bGives` |
| Both lists empty | `nothing to trade` |
| Either list > 6 lines (`MAX_OFFER_LINES`) | `too many item lines (max 6)` |
| Line null / `item` null/blank | `missing item name` |
| `count < 1` or `count > 512` (`MAX_STACK_COUNT`) | `bad count for <item>` |

One-sided trades (a gift) are allowed: one list may be empty. The 512 cap is per line; lines naming the same
item are summed on the main thread (below), so a side can owe at most 6 × 512 of one item.

### Execution — main thread (`executeTrade`, `:214-259`)

The handler calls `mc.submit(() -> executeTrade(mc, request)).join()` (`:164`). Any exception from the
main-thread task becomes `server error: <message>` (400) and a `Trade execution failed: …` warn log.
Validation and the swap run in this **one** main-thread task, so no tick can change either inventory in
between.

1. `getPlayerManager().getPlayer(botA/botB)` — both must be online: `<name> is not online`; the two lookups
   must be different players (`botA and botB are the same`).
2. **Proximity**: same `ServerWorld` (`<a> and <b> are not in the same dimension`) and, unless
   `maxTradeDistance <= 0`, within `maxTradeDistance` blocks
   (`<a> and <b> are too far apart (<d> > <max> blocks)`).
3. **Aggregate per item, then validate**: every line is resolved (`unknown item: <item>`) and summed into a
   per-side `Item → total` map (`aggregate` → `TradeMath.addLine`, `:262-269`). Each total must be covered by
   the giver's main inventory (`TradeMath.firstShortfall`): `<giver> does not have <total>x <namespace:id>`.
   With 15 coins, `aGives: [{coin,10},{coin,10}]` is now checked as 20 and rejected.
4. **Extract both sides, then deliver**: `extract` (`:297-317`) plans exactly `total` items per item across the
   36 main/hotbar slots in slot order (`TradeMath.planTakes`) and `split`s them out of the real stacks — the
   moved stacks keep their components (damage, enchantments, custom name, contents). Both givers are emptied
   **before** either receiver gets anything, so a party never re-gives what it just received. Each moved stack
   then goes to the receiver via vanilla `PlayerInventory.offerOrDrop`: it fills matching/empty slots and
   drops whatever doesn't fit at the receiver's feet.
5. `sendContentUpdates()` on both players' current screen handlers; return success and log
   `Village trade settled: <botA> <-> <botB>`.

Item resolution (`resolveItem`, `:271-282`): `trim().toLowerCase()`; if it contains `:` it is parsed with
`Identifier.tryParse`, else as `minecraft:<name>` (also `tryParse`); if that is `AIR` **and** the name had no
namespace, retry as `paulsbrawls:<name>`. So `"coin"` → `paulsbrawls:coin`, `"paulsbrawls:coin"` works directly,
`"minecraft:coin"` fails. An unparseable name (e.g. containing a space) is `unknown item: …`.

Inventory helpers:

| Helper | Slots | Behaviour |
|---|---|---|
| `countItems` (`:285-291`) | `inventory.main` only — 36 main + hotbar slots; **armour and offhand are excluded** | sums counts of stacks `isOf(item)` (components ignored for matching) |
| `extract` (`:297-317`) | same 36 slots, in slot order | `TradeMath.planTakes` then `ItemStack.split` — the real stacks move, components preserved |
| `TradeMath` (`TradeMath.java`) | — | Minecraft-free `addLine` / `firstShortfall` / `planTakes`; unit-tested in `src/test/java/com/paul/brawl/TradeMathTest.java` (`gradle test`) |

The coin is the village currency simply because `paulsbrawls:coin` resolves here; see
[../gibber/money-system.md](../gibber/money-system.md).

## Eden's side of the settlement — `SettlementClient` (`eden/src/social/trade.ts`)

| Aspect | Eden code |
|---|---|
| URL | `settlement.url`, default `http://127.0.0.1:8767/trade/execute` (`eden/src/config.ts:127`, `eden/eden.example.json:64`) |
| Method / headers | `POST`, `content-type: application/json`, plus `X-Village-Token` when a token is configured (`eden/src/social/trade.ts:102-107`) |
| Token | `process.env.EDEN_SETTLEMENT_TOKEN` (`eden/src/main.ts:556`) — a secret, so env-only like the LLM key; unset/empty → no header |
| **Body sent** | `{ botA, botB, aGives: TradeItem[], bGives: TradeItem[] }` built by `toSettlementRequest` with `coin` → `paulsbrawls:coin` (`eden/src/social/trade.ts:47-62`, `:332-334`) |
| Timeout | `AbortController`, 10 000 ms default (`eden/src/social/trade.ts:89`, `:100`) |
| Success | any 2xx → journal `trade.settled` (`eden/src/social/trade.ts:114-117`) |
| Failure | non-2xx → `trade.failed` with reason `settlement HTTP <status>: <first 160 chars>`; network/timeout → `settlement could not reach …` / `settlement timed out after …` (`eden/src/social/trade.ts:108-124`) |

### Contract mapping (bug #1, fixed Eden-side)

| Java field | Eden `TradeOffer` field | Meaning |
|---|---|---|
| `botA` | `from` | proposer |
| `botB` | `to` | partner |
| `aGives` | `give` | items moved `botA → botB` |
| `bGives` | `want` | items moved `botB → botA` |

Before the fix, Eden sent the right-hand names verbatim, so every settlement failed with
`settlement HTTP 400: {"ok":false,"error":"missing botA"}`, and CI missed it because the fake accepted any
body. Now `eden/tests/social-trade.test.ts` pins the exact body (`deepEqual` against the Java names), and
`FakeSettlement` ports `validateShape` (same checks and error strings), so a drifted body fails every
happy-path test. Java was not changed. Only the shape is covered by CI; a live `:8767` smoke run is still
the proof for resolution and the swap.

### Who calls it

`eden/src/main.ts:552-593` builds one `SettlementClient` and a `TradeBook` and injects the book into the
villager `ToolRegistry`. A villager's `propose_trade` only records an offer and wakes the partner; the
partner's `answer_trade {accept:true}` walks it to the proposer (R33, the `go-to` skill, aiming within 8
blocks) and then POSTs here. Eden only lets roster villagers be parties, which covers the "any two online
players, humans included" gap below from the Eden side (a different local caller is still only stopped by the
token). Details: [social-and-trade.md](social-and-trade.md).

## `/village` (`VillageCommand.java`)

Permission level 2 on the root literal (`:46`). HTTP client: JDK `HttpClient`, connect timeout 2 s,
request timeout 4 s; responses are delivered back to the main thread with `server.execute`.

| Syntax | Effect | Feedback (broadcast to ops?) |
|---|---|---|
| `/village` | Print `VillageConfig.describe() + " listener=" + RUNNING|stopped` | no |
| `/village status` | `GET <nodeAdminUrl>/village/status`, summarise `scheduler.{paused,inFlight,pending,completed}`, `conversations`, per-bot `name (role) state, job, talking` | no |
| `/village pause` | `POST <nodeAdminUrl>/village/pause` (empty body) → `Village LLM scheduling paused.` | yes |
| `/village resume` | `POST <nodeAdminUrl>/village/resume` → `Village LLM scheduling resumed.` | yes |
| `/village on` | `enabled=true`, `save()`, `VillageHttpListener.start(server)`; `Village settlement listener enabled (<describe>)` | yes |
| `/village off` | `enabled=false`, `save()`, `VillageHttpListener.stop()`; `Village settlement listener disabled.` | yes |

Failures: status → `Village process unreachable at <url> (<error>|HTTP <code>) — is \`npm run village\` running?`;
pause/resume → `Village process unreachable — is \`npm run village\` running?`. Unparseable status JSON →
`Village status (raw): <first 400 chars>`.

`status`, `pause`, `resume` target the **legacy v1** Node admin API (port 8766, paths `/village/*`). Eden's
admin server exposes `POST /pause` and `/resume` on 8770 instead (`eden/src/admin/server.ts:231-232`), so
these subcommands cannot control Eden. `on`/`off` control the listener, which both v1 and Eden use.

## `/villagers` (`VillagersCommand.java`) — Eden scenario control

Permission level 2 (`:79`). HTTP client pinned to **HTTP/1.1** with a 3 s connect timeout (`:54-57`):
the JDK default (HTTP/2 cleartext) sends `Upgrade: h2c`, and Eden's admin server destroys any upgrade
request not aimed at `/journal/stream` (`eden/src/admin/server.ts:104-109`). Request timeout 10 s.

| Syntax | Must be run by | HTTP call to `edenAdminUrl` | Body |
|---|---|---|---|
| `/villagers start <name>` | a player (else `[villagers] /villagers start must be run by a player — it scatters bots around your position.`, returns 0) | `POST /scenario/start` | `{"name":"<name>","x":<int player x>,"z":<int player z>}` |
| `/villagers restart <name>` | a player (analogous message) | `POST /scenario/restart` | same |
| `/villagers stop` | anyone with perm 2 | `POST /scenario/stop` | empty |

`<name>` is `StringArgumentType.word()`. Coordinates are the caller's position cast to `int`.

Response handling (`postScenario`, `:118-163`; `stopScenario`, `:165-193`):

- start/restart: parse JSON; `ok` = `root.ok`; message = `root.message` or the raw body. If `ok` and
  `botNames` is an array → `activeScenarioBots` is **cleared and replaced** with those names. Feedback
  `[villagers] <message>`; unparseable → `[villagers] Eden error (HTTP <code>)`.
- stop: `activeScenarioBots.clear()` first (even on failure), feedback `[villagers] <message>`, or `[villagers] stopped` / `stopped (HTTP <code>)` when the body has no `message` / is unparseable.
- Retry (`sendWithRetry`): up to `MAX_RETRIES = 3` extra attempts, `RETRY_DELAY_MS = 750`, when
  `EdenRetry.shouldRetry(idempotent, rootCause)` allows it (bug #16, `EdenRetryTest`): `start` and `stop` retry any
  `IOException` root cause (incl. `ConnectException`, `HttpTimeoutException`); `restart` — not idempotent, it wipes bot
  state — retries only a `ConnectException` (the request never arrived). After
  exhaustion: `ConnectException` → `[villagers] Eden n'est pas démarré (ou démarre encore) sur <url>.`;
  other → `[villagers] Eden redémarre — réessaie dans un instant.` (`:243-256`).

Eden's side (`eden/src/admin/server.ts:268-291`, `eden/src/village-launch.ts`):

| Route | Eden behaviour | Status / body |
|---|---|---|
| `POST /scenario/start` | journal `scenario.start`, `VillageLauncher.start` — **does not load a scenario file**; if Eden booted a named scenario, `name` must equal it (a direct-`villagers` boot accepts any name), otherwise `booted scenario is "<x>", not "<name>" — runtime scenario switching needs a reboot`; starts the boot pool; idempotent (`village already running`) | 200 / 404 `{ok,message,botNames?}`; 400 `{error:"name is required"}`; 503 if not wired |
| `POST /scenario/restart` | journal `scenario.restart`, stop village loop + pool, delete `<dataDir>/bots/<villager>.json` and reset the live memory + self-authored subscriptions for each villager, start again with `/clear` | same |
| `POST /scenario/stop` | stop village loop + pool | 200 / 500 `{ok,message}` |

After a (re)start, each villager bot, ~1500 ms after spawning, **itself** chats
`/spreadplayers <x> <z> 2 10 false <name>`, then `/clear <name>` (restart only), then
`/give <name> <id> <count>` per configured item (`eden/src/village-launch.ts:115-132`). Those commands need
operator rights — which is why op-on-join includes `activeScenarioBots`.

## Op-on-join (`ServerEntryPoint.java:58-74`)

On `JOIN` (after the Gibber backlog payout), a player is op'd if its name equals
`BridgeConfig.INSTANCE.botUsername` (default `LLMBot`), `VillageConfig.INSTANCE.edenAvatarName`
(default `Dieu`) or is in `VillagersCommand.activeScenarioBots`. Already-op'd profiles are skipped;
otherwise `addToOperators(profile)` and log `Opped bot '<name>' on join.` Matching is exact and
case-sensitive. Ops persist in `ops.json` and are never revoked by the mod. Op-on-join only works on a
dedicated server (the entrypoint does not run on an integrated server).

## Ports involved

| Port | Owner | Used here by |
|---|---|---|
| 8767 | this mod (`VillageHttpListener`) | Eden `SettlementClient` (and v1) |
| 8766 | legacy v1 Node village admin | `/village status|pause|resume` |
| 8770 | Eden admin HTTP/WS | `/villagers …` |

## Gotchas & known issues

- ~~**Shape mismatch** with Eden's `SettlementClient`~~ — fixed Eden-side (see above). The client is wired (villager trade tools).
- **Fixed — item duplication** (VERIFICATION-NOTES bug #2): lines are now summed per item before validation,
  and validation, removal and delivery share one main-thread task and the same per-item totals.
- **Fixed — item data**: the real stacks are split out and moved, so enchantments, custom names (e.g. CTF
  Flags), damage and contents survive. Matching still ignores components: asked for 1 `diamond_sword`, the
  giver hands over whichever sword comes first in slot order (possibly an enchanted one).
- **Fixed — armour/offhand**: only the 36 main/hotbar slots are counted or taken.
- **Fixed — overflow loss**: the old `addItems` dropped only when `insertStack` returned `false`, but vanilla
  `insertStack` returns `true` on a *partial* insert (checked against the 1.21.1 yarn jar), so remainders were
  silently deleted. Delivery now uses `offerOrDrop`, which drops every leftover.
- **Who can trade**: the parties must share a dimension and stand within `maxTradeDistance` (16 blocks by
  default). They can still be *any* two online players, humans included — the listener cannot tell a bot
  from a human. Setting `settlementToken` limits callers to processes that know the secret; Eden sends it
  from `EDEN_SETTLEMENT_TOKEN`, so set both to the same value (a mismatch makes every Eden trade a 401).
- Eden aborts after 10 s; a swap that completes on the Java side after the abort is journaled by Eden as
  `trade.failed`.
- `botA`/`botB` naming the same player is rejected both case-insensitively and by comparing the resolved
  player entities, whatever `PlayerManager.getPlayer(String)`'s case sensitivity.
- `/village status|pause|resume` only speak to the deprecated v1 process.
- ~~`/villagers` retries a timed-out `restart`~~ **Fixed (bug #16):** a `restart` is re-sent only after a refused
  connection.
- Race: `activeScenarioBots` is filled from the HTTP response, while Eden starts the pool asynchronously
  before replying; a bot that joins before the response is processed is not op'd and its
  `/spreadplayers`/`/give` fail.
- `activeScenarioBots` is in-memory only (empty after a server restart), but the ops it caused are permanent.
- Villagers **are** op'd, contradicting the spec claim that only the avatar is.
- `VillageConfig` is never written until `/village on|off`; `/village on` while running does not rebind to
  a changed port.
- The `VillagersCommand` Javadoc says start "load[s] eden/scenarios/<name>.json"; Eden actually only accepts
  the scenario it booted with.

## Related

- [social-and-trade.md](social-and-trade.md)
- [admin-api.md](admin-api.md)
- [process-config-and-boot.md](process-config-and-boot.md)
- [overview.md](overview.md)
- [../gibber/money-system.md](../gibber/money-system.md)
- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md)
- [../reference/ports-files-config.md](../reference/ports-files-config.md)
- [../reference/commands.md](../reference/commands.md)
