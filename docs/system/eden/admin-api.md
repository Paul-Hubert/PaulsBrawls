---
id: eden.admin-api
title: Eden — admin HTTP API, WebSocket journal stream and dashboard
system: eden
summary: Every Eden admin route (method, path, params, response, status codes, journaling), the /journal/stream WebSocket protocol, 127.0.0.1:8770 binding, no auth, and the static website it serves.
tags: [eden, admin, http, api, websocket, journal-stream, dashboard, website, scenario, villagers-command, port-8770]
sources: [eden/src/admin/server.ts, eden/src/main.ts, eden/src/journal/kinds.ts, eden/src/types/journal.ts, eden/website/api.js, eden/website/app.js, eden/website/index.html, src/main/java/com/paul/brawl/VillagersCommand.java, src/main/java/com/paul/brawl/VillageConfig.java, eden/tests/admin-routes.test.ts, eden/tests/main-full-wiring.test.ts, docs/05-observability.md]
verified_at: 4a8081f
---

# Eden — admin HTTP API, WebSocket journal stream and dashboard

**TL;DR.** `AdminServer` (`eden/src/admin/server.ts`) is a plain `node:http` server on `127.0.0.1:<admin.port>`
(default 8770), no authentication, JSON in/out. GET routes read derived views, live God state and the journal;
POST routes pause/resume LLM scheduling, quarantine a skill, prompt a villager, and start/stop/restart the village
(the Java `/villagers` command calls these). Every mutating verb journals before acting. A WebSocket at
`/journal/stream` pushes every appended journal event. Any unmatched GET is served from `eden/website/` when the
host runs with `serveWeb` (default on a real boot).

## Binding, auth, transport

| Property | Value | Source |
|---|---|---|
| Host | `127.0.0.1` (hardcoded) | `eden/src/admin/server.ts:131` |
| Port | `config.admin.port` (default 8770); `0` → ephemeral, actual port returned by `start()` | `eden/src/admin/server.ts:129-135`, `eden/src/main.ts:284`, `eden/src/main.ts:422` |
| Auth | None. No token, no CORS headers. Anyone on the machine can call the POST verbs. | whole file |
| Responses | `content-type: application/json`, body `JSON.stringify(x)`; handler exceptions → `500 {"error": "<message>"}` | `eden/src/admin/server.ts:151-160`, `eden/src/admin/server.ts:304-307` |
| Methods | `POST` → POST router; **every other method** (GET, PUT, DELETE, …) → GET router | `eden/src/admin/server.ts:155-156` |
| Request bodies | Read fully; empty or invalid JSON or non-object → `{}` (never a 400) | `eden/src/admin/server.ts:309-320` |
| Path params | `/<prefix>/<name>` with no further `/`; URL-decoded | `eden/src/admin/server.ts:329-339` |

## GET routes

| Path | Query | 200 response | Other statuses | Backed by (`eden/src/main.ts` lines) |
|---|---|---|---|---|
| `/status` | — | `{ uptimeMs, uptime (s), botsConnected, totalBots (= villagers + 1), currentRuns: 0, queueDepth, paused, budgetSpend: 0, budgetCap: 0, budgetHistory: [] }` | — | `getStatus` 288-300 (`queueDepth`/`paused` from `LlmScheduler`; 0/false when God off) |
| `/kinds` | — | `{ kinds: [{ kind, doc }] }` (all 42 registered kinds) | — | `describeKinds()` |
| `/journal` | `kinds` (comma list, exact match), `actor`, `id`, `ref`, `since`, `until` (epoch ms), `limit`, `order=asc｜desc` | `{ events: JournalEvent[] }` | — | `journal.query` (see [journal-and-views.md](journal-and-views.md)) |
| `/villagers` | — | `{ villagers: VillagerSummary[] }` | — | `villagerSummary` 719-766 |
| `/villagers/:name` | — | `VillagerSummary` | `404 {error:"no villager <n>"}` (not in `config.villagers`) | same |
| `/skills` | — | `{ skills: SkillListItem[] }` (live, non-archived library skills; `[]` when God off) | — | 306-319 |
| `/skills/:name` | `version=<n>`, `code=1｜true` | `SkillDetail` | `404 {error:"no skill <n>"}` | 320-353 |
| `/tasks` | — | `{ open: Card[], completed: Card[], failed: Card[] }` | — | `mapLedgerForDashboard` 771-788 |
| `/verdicts` | — | `{ verdicts: VerdictRow[] }` — last 200 `god.verdict` events, newest first | — | 357-371 |
| `/directives` | — | `{ directives: DirectiveRow[] }` (open directives) | — | 372-381 |
| `/rollouts` | — | `{ rollouts: RolloutEntry[] }` (RolloutsView, live since process start) | — | 384 |
| `/llm/:callId` | — | The transcript JSON `{ request, response }` from `.eden-data/llm/<callId>.json` | `404 {error:"no transcript <id>"}` (debugPrompts off, unknown, unreadable, or id not matching `^[A-Za-z0-9_-]+$`) | `readLlmTranscript` 708-717 |
| anything else | — | Static file from the web root (if wired) | `404 {error:"no route <path>"}` when no web root | `eden/src/admin/server.ts:208-210` |

### Response shapes

**VillagerSummary** (`eden/src/main.ts:753-765`):
`{ name, role, persona: "Tu es <name>, <role> du village. Tu parles français.", vitals: { hp, hpMax: 20, food,
foodMax: 20, pos: [x,y,z], held }, inbox: <depth>, inboxDepth: <depth>, subscriptions: [{ when, then, fired: 0,
state: 'armed'｜'cooldown'｜'suppressed' }], activityKind, currentRun, relations: [{ name, score }], dossier: {
competence: { <tag>: successRate0to1 }, note } }`.
`vitals` come from the latest `vitals` event with actor `bot:<name>`; with none yet, a nominal baseline
(`hp 20, food 20, pos [0,0,0], held '—'`). `activityKind` = kind of the latest event by `villager:<name>`, else
the vitals kind, else `'vitals'`. `when` is `<on>` or `<on> (filtered)`; `then` is the skill name or
`deliberate: <hint>`. `relations` come from `VillagerMemory.relations()`, not RelationsView.

**SkillListItem** (`eden/src/main.ts:307-319`): `{ name, version, status, tier, tags, signature, description, stats: { runs,
successes, failures, stalls, avg_ms }, history: [], versionsCount, usedBy: [villager] }`.

**SkillDetail** (`eden/src/main.ts:332-352`): `{ name, version, status, tier, signature, description, tags, stats, history: [],
usedBy, versions: [{ version, status, note (manifest summary), runs: 0, score: '—', admittedBy (provenance
rolloutId｜null), code? }], quarantine?: { reason, at, by }, requestedVersion?, code? }`. `quarantine` is filled from
the newest `skill.quarantine` event referencing the name when the resolved version is `quarantined`.

**Card** (`eden/src/main.ts:772-781`): `{ id, title (= goal), to (assignee｜'any'), reason (successCriteria｜context｜''),
priority: 'med', expiry: '—', rolloutId｜null, result?: 'completed'｜'failed' }`.

**VerdictRow**: `{ id (event id), skill (refs.skill｜'?'), version (refs.skillVersion｜''), success, score (0 if absent),
action (libraryAction｜'none'), critique, at, rolloutId｜null }`.

**DirectiveRow**: `{ id, to (joined with ', ' if array), goal, reason, priority, expiry ('HH:MM' UTC｜'—'),
standing }`.

When God is not wired (`enableGod` false, e.g. CI): `/skills`, `/verdicts` (journal-backed, still works),
`/directives`, `/tasks` return empty collections; `/villagers` still returns the static roster.

## POST routes

| Path | Body | Journals first (actor · kind · payload) | Success | Failure statuses |
|---|---|---|---|---|
| `/pause` | — | admin · `system.config-warning` · `{message:"admin: pause LLM scheduling"}` | `200 {paused:true}` | `503 {error:"pause control not wired"}` |
| `/resume` | — | admin · `system.config-warning` · `{message:"admin: resume LLM scheduling"}` | `200 {paused:false}` | `503 {error:"resume control not wired"}` |
| `/skills/:name/quarantine` | `{ reason?: string }` (default `"admin kill switch"`) | admin · `skill.quarantine` · `{name, version, reason:"admin: <reason>"}`, refs `{skill, skillVersion}` — ONE row, written by the library before it mutates (the admin passes its actor) | `200 {quarantined:<name>}` | `503` not wired; `404 {error:"no skill <n>"}` (no row) |
| `/villagers/:name/prompt` | `{ text?: string, from?: string }` | `player:<from>` or `admin` · `inbox.delivered` · `{to, from: from｜'admin', kind:'tell'}` | `200 {delivered:<name>}` | `503` not wired; `404` if villager unknown (checked BEFORE journaling) |
| `/scenario/start` | `{ name: string, x?: number, z?: number }` (x/z default 0) | admin · `scenario.start` · `{name, cx, cz}` | `200 {ok:true, message, botNames}` | `400 {error:"name is required"}` (not journaled); `404 {ok:false, message}` on launcher refusal; `503` not wired |
| `/scenario/restart` | same | admin · `scenario.restart` · `{name, cx, cz}` | `200 {ok:true, message, botNames}` | same as start |
| `/scenario/stop` | ignored | admin · `scenario.stop` · `{}` | `200 {ok:true, message}` | `500` if `ok:false`; `503` not wired |
| other POST | — | — | — | `404 {error:"no route <path>"}` |

Handler semantics (wired in `main.ts`):

- **pause/resume** → `wiring.scheduler.pause()/resume()` — gates LLM scheduling; skill runs and zero-token
  subscriptions keep running. Wired only when God is wired.
- **quarantine** → `library.quarantine(name, "admin: <reason>")`; `false` if no live version.
- **prompt** → `inbox.deliver({ from:'villager', kind:'tell', payload:{ text, from }, at })`. The text is NOT in
  the journal payload. The villager reacts via its `inbox` subscription (roles.json `everyone`, deliberate) and the
  coordinator drains inboxes during rollouts.
- **scenario start/restart** → `launcher.start|restart(name, x, z)`, then `villageLoop.start()` if `ok`
  (`eden/src/main.ts:406-420`). Restart stops the loop first. **stop** → `villageLoop.stop()` then `launcher.stop()`.
  Messages are listed in [process-config-and-boot.md](process-config-and-boot.md) (VillageLauncher).
  These are always wired (the launcher exists even with no pool and refuses with `ok:false`).

### Caller: the Java `/villagers` command

`VillagersCommand.postScenario` POSTs `{"name":<word>,"x":<int>,"z":<int>}` (the player's position) to
`<edenAdminUrl>/scenario/<start|restart>`; `stopScenario` POSTs an empty body to `/scenario/stop`; 10 s timeout,
retried (`src/main/java/com/paul/brawl/VillagersCommand.java:118-192`). It reads `ok`, `message`, `botNames` from the
reply and shows `[villagers] <message>` in chat. `edenAdminUrl` defaults to `http://127.0.0.1:8770`
(`VillageConfig.java:40`). Command syntax/permissions: [java-integration.md](java-integration.md).

## WebSocket: `/journal/stream`

| Aspect | Behavior (`eden/src/admin/server.ts:103-125`) |
|---|---|
| URL | `ws://127.0.0.1:8770/journal/stream[?kinds=a,b,c]` (`noServer` WebSocketServer on the same HTTP server). Upgrades to any other path are destroyed. |
| Server → client | One text frame per appended journal event: `JSON.stringify(JournalEvent)` = `{ id, at, actor, kind, payload, refs }`. |
| Filter | Optional `kinds` query: exact kind names; events whose kind is not listed are skipped. |
| Client → server | Ignored (no commands, no backfill, no replay). Use `GET /journal` for history. |
| Lifecycle | Subscription is removed on `close`; `error` closes the socket; send errors are swallowed. `AdminServer.stop()` terminates all clients. |
| Ordering | Events are pushed synchronously from `Journal.append`, in append order. |

## Static dashboard (`eden/website/`)

- Served when `webRoot` is set: `main.ts` passes `../website/` resolved from `main.ts`'s URL when
  `serveWeb ?? spawnBots` is true (`eden/src/main.ts:269-270`).
- `GET /` → `index.html`; other paths are URL-decoded, resolved under the root, and rejected with `403
  {error:"forbidden"}` if they escape it, `400 {error:"bad path"}` if undecodable, `404 {error:"no file <p>"}` if
  missing. Header `cache-control: no-cache`. MIME map: html, js, css, json, svg, png, ico, woff2; else
  `application/octet-stream` (`eden/src/admin/server.ts:213-228`, `eden/src/admin/server.ts:362-374`). API routes always win over files.
- Content: plain-JS IIFEs, no build step — `index.html` loads `api.js`, `ui.js`, `screens1.js`, `screens2.js`,
  `screens3.js`, `app.js`, `styles.css`. `api.js` exposes `window.EdenAPI` over the routes above (same-origin,
  relative URLs) and opens one unfiltered WebSocket to `/journal/stream` with exponential reconnect (500 ms →
  8 s), filtering client-side by domain. Hash routes (`app.js`): `#/overview`, `#/villagers`, `#/skills`,
  `#/curriculum`, `#/verdicts`, `#/rollouts` (+ `#/rollout/<id>`), `#/journal`.
- Linted by ESLint with browser globals (`eden/eslint.config.js`), not type-checked.

## Gotchas & known issues

- No authentication and no rate limits; the security boundary is the loopback bind only.
- Non-POST methods are treated as GET (e.g. `DELETE /status` returns status).
- `GET /journal` without `limit` returns the whole table.
- `/status` `currentRuns`, `budgetSpend`, `budgetCap`, `budgetHistory` are hardcoded zeros/empty; `totalBots` counts
  the avatar.
- ~~`POST /skills/:name/quarantine` journals before knowing whether the skill exists, and the library journals a
  second `skill.quarantine`~~ **Fixed (bug #17):** `onQuarantine(name, reason, actor)` → `library.quarantine(…, actor)`
  journals one row as `admin`, before the status change; an unknown skill writes nothing.
- `POST /villagers/:name/prompt` double-journals `inbox.delivered`; the website always sends `from:'admin'`
  (`api.js` `prompt`), so dashboard prompts are journaled as actor `player:admin`, not `admin`.
- `POST /scenario/start` journals `scenario.start` even when the launcher then refuses (e.g. wrong scenario name),
  and reports refusals as HTTP 404.
- Subscriptions' `fired` count is always 0; skill `history` and per-version `runs` are always empty/0.
- There is no admin route for the R32 memory-quarantine `wipe|migrate` decision that memory warnings refer to.

## Related

- [journal-and-views.md](journal-and-views.md) · [process-config-and-boot.md](process-config-and-boot.md) · [overview.md](overview.md)
- [java-integration.md](java-integration.md) · [god.md](god.md) · [skills-library.md](skills-library.md) · [villager-runtime.md](villager-runtime.md) · [llm-and-scheduling.md](llm-and-scheduling.md)
- [testing-eval-live.md](testing-eval-live.md) · [../reference/commands.md](../reference/commands.md)
