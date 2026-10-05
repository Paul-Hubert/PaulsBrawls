---
id: eden.java-integration
title: Eden Java integration - settlement listener, /village, /villagers, op-on-join
system: eden
summary: The mod's server-authority duties for the village - the :8767 trade-settlement HTTP listener, VillageConfig, /village and /villagers commands, op-on-join, and how Eden's clients match (or do not match) them.
tags: [eden, village, settlement, trade, http, 8767, 8770, VillageHttpListener, VillageConfig, VillageCommand, VillagersCommand, op-on-join, scenario, coin]
sources: [src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/VillageCommand.java, src/main/java/com/paul/brawl/VillagersCommand.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/BridgeConfig.java, eden/src/social/trade.ts, eden/src/types/social.ts, eden/src/main.ts, eden/src/config.ts, eden/src/admin/server.ts, eden/src/village-launch.ts, eden/eden.example.json, eden/tests/social-trade.test.ts]
verified_at: 4a8081f
---

# Eden Java integration - settlement listener, /village, /villagers, op-on-join

**TL;DR** — The Fabric mod gives the village four things: (1) a localhost HTTP listener
`POST 127.0.0.1:8767/trade/execute` that validates and swaps items between two online players on the main
thread; (2) `/village` (config + listener toggle + legacy v1 status/pause/resume); (3) `/villagers
start|stop|restart` which drives Eden's admin API on `:8770`; (4) op-on-join for `LLMBot`, `Dieu` and the
current scenario's villagers. **The Eden `SettlementClient` sends `{from,to,give,want}` but the listener
requires `{botA,botB,aGives,bGives}`, so every Eden settlement would be rejected with 400 `missing botA`**
— and in the current Eden build the client is constructed but never called.

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
| `nodeAdminUrl` | `nodeAdminUrl` | string | `http://127.0.0.1:8766` | `/village status|pause|resume` (v1 Node process) |
| `edenAvatarName` | `edenAvatarName` | string | `Dieu` | op-on-join |
| `edenAdminUrl` | `edenAdminUrl` | string | `http://127.0.0.1:8770` | `/villagers …` |

Lines `:28-40`. Lifecycle:

- `load()` runs once in the private constructor (`:42-44`, `:60-74`). Missing file → defaults, **no file
  is written**. Unparseable int → keeps default; booleans use `Boolean.parseBoolean` (anything but `true`
  → `false`).
- `save()` (`:46-58`) writes all five keys; it is only called by `/village on` and `/village off`.
- There is no reload command; edits to the file need a server restart (the class Javadoc's "tune without a
  restart" is not implemented).
- `describe()` returns `VillageConfig{enabled=…, listenerPort=…, nodeAdminUrl=…, edenAvatarName=…, edenAdminUrl=…}`.

## Settlement listener — `VillageHttpListener`

### Lifecycle (`VillageHttpListener.java:80-113`)

| Method | Behaviour |
|---|---|
| `start(mc)` (`synchronized`) | No-op if already running. If `!enabled` logs `Village settlement listener disabled by config.` and returns. Binds `com.sun.net.httpserver.HttpServer` on `127.0.0.1:<listenerPort>` (backlog 0). On bind failure logs `Village settlement listener failed to bind 127.0.0.1:<port>: <msg>` (warn) and stays stopped — the server keeps running. Registers one context `/trade/execute`, a single-thread daemon executor named `village-settlement-http`, then logs `Village settlement listener on http://127.0.0.1:<port>/trade/execute`. |
| `stop()` (`synchronized`) | `server.stop(0)`, logs `Village settlement listener stopped.` |
| `isRunning()` | `server != null` |

Requests are handled **one at a time** (single executor thread), each blocking ~1 tick on the main thread.

### Route

`POST /trade/execute` — `HttpServer` contexts are prefix matches, so `/trade/execute/anything` reaches the
same handler; other paths get the JDK default 404. No authentication; bound to loopback only.

Request body (Gson → `TradeRequest`, `:63-68`):

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

### Validation — HTTP thread (`handleTrade` + `validateShape`/`validateSpec`, `:117-181`)

| Check | Error string |
|---|---|
| Method ≠ POST (case-insensitive) | `POST only` (405) |
| Body > 64 KiB (`MAX_BODY_BYTES = 65536`) | `body too large` |
| Malformed JSON / wrong types | `bad json: <gson message>` |
| Empty body (Gson returns null) | `empty request` |
| `botA` null/blank | `missing botA` |
| `botB` null/blank | `missing botB` |
| `botA.equals(botB)` (case-sensitive) | `botA and botB are the same` |
| `aGives` or `bGives` null | `missing aGives/bGives` |
| Both lists empty | `nothing to trade` |
| Either list > 6 lines (`MAX_OFFER_LINES`) | `too many item lines (max 6)` |
| Line null / `item` null/blank | `missing item name` |
| `count < 1` or `count > 512` (`MAX_STACK_COUNT`) | `bad count for <item>` |

One-sided trades (a gift) are allowed: one list may be empty.

### Execution — main thread (`executeTrade`, `:185-223`)

The handler calls `mc.submit(() -> executeTrade(mc, request)).join()` (`:144`). Any exception from the
main-thread task becomes `server error: <message>` (400) and a `Trade execution failed: …` warn log.

1. `getPlayerManager().getPlayer(botA/botB)` — both must be online: `<name> is not online`.
2. **Validate everything before mutating**: for each line resolve the item (`unknown item: <item>`) and
   check the giver holds at least `count` (`<giver> does not have <count>x <item>`).
3. Swap: for each `aGives` line `removeItems(a)` then `addItems(b)`; then each `bGives` line the other way.
4. `sendContentUpdates()` on both players' current screen handlers; return success and log
   `Village trade settled: <botA> <-> <botB>`.

Item resolution (`resolveItem`, `:225-234`): `trim().toLowerCase()`; if it contains `:` it is parsed with
`Identifier.tryParse`, else as `minecraft:<name>`; if that is `AIR` **and** the name had no namespace,
retry as `paulsbrawls:<name>`. So `"coin"` → `paulsbrawls:coin`, `"paulsbrawls:coin"` works directly,
`"minecraft:coin"` fails. An unparseable bare name (e.g. containing a space) makes `Identifier.of` throw →
`server error: …`.

Inventory helpers:

| Helper | Slots | Behaviour |
|---|---|---|
| `countItems` (`:236-244`) | all `inventory.size()` slots — main, **armor and offhand** | sums counts of stacks `isOf(item)` (components ignored) |
| `removeItems` (`:246-256`) | same, in slot order | `decrement` until `count` removed |
| `addItems` (`:258-269`) | — | creates **fresh default `ItemStack(item, n)`** in chunks of the item's max stack size; `insertStack`; if it returns false and the stack is non-empty, `dropItem(stack, false)` at the receiver's feet |

The coin is the village currency simply because `paulsbrawls:coin` resolves here; see
[../gibber/money-system.md](../gibber/money-system.md).

## Eden's side of the settlement — `SettlementClient` (`eden/src/social/trade.ts`)

| Aspect | Eden code |
|---|---|
| URL | `settlement.url`, default `http://127.0.0.1:8767/trade/execute` (`eden/src/config.ts:127`, `eden/eden.example.json:64`) |
| Method / headers | `POST`, `content-type: application/json` (`eden/src/social/trade.ts:83-88`) |
| **Body sent** | `{ from, to, give: TradeItem[], want: TradeItem[] }` with `coin` → `paulsbrawls:coin` (`eden/src/social/trade.ts:74-79`, `:173-176`) |
| Timeout | `AbortController`, 10 000 ms default (`eden/src/social/trade.ts:66`, `:80-81`) |
| Success | any 2xx → journal `trade.settled` (`eden/src/social/trade.ts:95-98`) |
| Failure | non-2xx → `trade.failed` with reason `settlement HTTP <status>: <first 160 chars>`; network/timeout → `settlement could not reach …` / `settlement timed out after …` (`eden/src/social/trade.ts:89-105`) |

### Contract mismatch (verified on both sides)

| Java expects | Eden sends | Effect |
|---|---|---|
| `botA` | `from` | Java: `missing botA` → HTTP 400 |
| `botB` | `to` | — |
| `aGives` | `give` | — |
| `bGives` | `want` | — |

Every settlement from the current Eden client would therefore fail with
`settlement HTTP 400: {"ok":false,"error":"missing botA"}`. Eden's unit tests use a `FakeSettlement`
and assert the Eden-side shape (`eden/tests/social-trade.test.ts:52-54`), so CI does not catch it. The fix
is a field rename on either side (`from→botA`, `to→botB`, `give→aGives`, `want→bGives`).

### The client is not wired

`eden/src/main.ts:577` does `void new SettlementClient({ url: config.settlement.url, journal });` — the
instance is discarded. `TradeService` is never constructed anywhere in `eden/src` (only in tests), so no
production code path reaches the listener today. See [social-and-trade.md](social-and-trade.md).

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
- Retry (`sendWithRetry`, `:210-231`): up to `MAX_RETRIES = 3` extra attempts, `RETRY_DELAY_MS = 750`,
  on any `IOException` root cause (includes `ConnectException` and `HttpTimeoutException`). After
  exhaustion: `ConnectException` → `[villagers] Eden n'est pas démarré (ou démarre encore) sur <url>.`;
  other → `[villagers] Eden redémarre — réessaie dans un instant.` (`:243-256`).

Eden's side (`eden/src/admin/server.ts:268-291`, `eden/src/village-launch.ts`):

| Route | Eden behaviour | Status / body |
|---|---|---|
| `POST /scenario/start` | journal `scenario.start`, `VillageLauncher.start` — **does not load a scenario file**; if Eden booted a named scenario, `name` must equal it (a direct-`villagers` boot accepts any name), otherwise `booted scenario is "<x>", not "<name>" — runtime scenario switching needs a reboot`; starts the boot pool; idempotent (`village already running`) | 200 / 404 `{ok,message,botNames?}`; 400 `{error:"name is required"}`; 503 if not wired |
| `POST /scenario/restart` | journal `scenario.restart`, stop village loop + pool, delete `<dataDir>/bots/<villager>.json` for each villager, start again with `/clear` | same |
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

- **Shape mismatch** with Eden's `SettlementClient` (above) — all Eden settlements 400; plus the client is unused.
- **Item duplication**: validation checks each line independently against the full inventory, so
  `aGives: [{coin,10},{coin,10}]` passes with only 15 coins; removal then takes 15 but `addItems` creates
  20. Duplicate item lines must be summed before validating.
- **Item data is destroyed/forged**: removal ignores components, and the receiver gets fresh default
  stacks — enchantments, custom names (e.g. CTF Flags), damage and contents are lost; a damaged tool arrives
  at full durability.
- **Armor and offhand count and are removed**: a bot can trade away the armour it is wearing.
- **No restrictions on who**: any two online players (including humans, any distance, any dimension) can be
  swapped by any local process; no auth.
- Overflow handling: the code only drops a stack when `insertStack` returns `false`.
  > ⚠ Unverified: if vanilla `insertStack` returns `true` on a *partial* insert, the remainder would be
  > neither inserted nor dropped (vanilla source not in repo).
- Eden aborts after 10 s; a swap that completes on the Java side after the abort is journaled by Eden as
  `trade.failed`.
- `botA.equals(botB)` is case-sensitive while player lookup may not be.
  > ⚠ Unverified: case sensitivity of `PlayerManager.getPlayer(String)` in 1.21.1.
- `/village status|pause|resume` only speak to the deprecated v1 process.
- `/villagers` retries on `HttpTimeoutException` too, so a slow `restart` (non-idempotent: wipes bot state)
  can be re-sent.
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
