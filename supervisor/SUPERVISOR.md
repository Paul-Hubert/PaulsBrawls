# Village Simulator — Supervisor Protocol

> [!WARNING]
> **LEGACY — this protocol describes the v1 village brain (`npm run village`), which is
> now deprecated.** The village brain is **Eden** (primary): entrypoint
> `tsx eden/src/main.ts eden/eden.json`, admin HTTP/WS on **8770** (`GET /status`,
> `/journal`, `/villagers`, `/skills`, `/tasks`; `POST /pause` `/resume`
> `/villagers/<name>/prompt`). See [`../docs/17-parity-signoff.md`](../docs/17-parity-signoff.md)
> and [`../eden/CLAUDE.md`](../eden/CLAUDE.md). v1 stays runnable until Eden passes the
> smoke gates + a soak (docs/17 §5); the two must never share bot usernames (Eden's
> avatar is **`Dieu`**, op'd on join). The endpoints/log paths below are v1-specific and
> kept as legacy reference.

The benchmark: **how much food does the village produce** over a long run, with
an AI supervisor (Claude Code) watching the logs, steering the villagers like a
god, fixing real bugs, and logging every problem + every skill the bots write.

## Topology (ground truth at run start)

| Thing | Where |
|---|---|
| Minecraft dev server | port **25599** (java, mod's trade listener on 8767) |
| Village process (PRIMARY — Eden) | `tsx eden/src/main.ts eden/eden.json` (cwd repo root); admin on **8770**. The village brain going forward. |
| Village process (LEGACY — v1) | `npm run village -- --host 127.0.0.1 --port 25599 --roster village3-farm.json --admin-port 8766` (cwd `minecraft-mcp-server/`) — deprecated; runnable until Eden parity (docs/17 §5) |
| Roster | `minecraft-mcp-server/village3-farm.json` — Jacques (gatherer), Jean (farmer), Pierre (crafter); dataDir `.village3-farm-data` |
| Village log | `minecraft-mcp-server/logs/village-<stamp>.log` (new file per restart) |
| Skill audit | `minecraft-mcp-server/logs/skills-<stamp>.jsonl` — every created/updated/re-enabled/seeded-stock/removed/strike/disabled/rejected-* event, with full code |
| Benchmark series | `minecraft-mcp-server/logs/benchmark-<stamp>.jsonl` — one sample/minute |
| Supervisor state | `supervisor/state.json` (log offsets, run clock, restart count) |
| Problem log | `supervisor/problems.jsonl` — the run's deliverable, see format below |
| Action log | `supervisor/actions.jsonl` — every god-message / restart / code change |

## Admin API (localhost:8766)

- `GET /village/status` — scheduler stats + per-bot state/job/skills count
- `GET /village/metrics` — food benchmark counters (village + per bot + perItem)
- `GET /village/skills` — every bot's skills **including code**
- `GET /village/bot/<name>` — observation, skills, memories, relations
- `GET /village/bot/<name>/memory?q=<keywords>` — ranked recall
- `POST /village/bot/<name>/tell` `{message, from?, wake?}` — divine voice: inbox
  + memory + player-priority deliberation. **Mention a skill by name to pull its
  code into the bot's prompt** (relevance gating) — that's how you tell a bot to
  use/fix a specific skill.
- `POST /village/broadcast` `{message}` — same to all bots
- `POST /village/pause` / `resume` — gate LLM scheduling (reflexes/routines keep running)

## Each wake (target cadence ~90–270 s, 4 h total)

1. Run `powershell -File supervisor/check.ps1` — emits new-since-last-wake
   digest: filtered log lines (errors/warns/skill events/benchmark lines),
   skill-audit tail, latest metrics, status, and updates the offsets.
2. Diagnose with the playbook: `act <label> FAILED after Nms` — 0 ms = perception
   check (absent vs unloaded chunk), ~30 s = pathfinder timeout, 45 s = act
   timeout. Repeated identical tool errors across deliberations = LLM retry
   loop burning money — fix the cause, don't re-prompt. Grep history before
   declaring something "never works".
3. Act (escalation ladder — prefer the cheapest rung):
   - **Observe** — most wobbles self-heal; don't micro-manage.
   - **Tell** — god-message the bot (French works best): unstick a confused
     bot, point at the right chest, suggest using/rewriting a named skill.
   - **Restart village** — only for process-level wedges (unhandled-rejection
     storms, all bots disconnected, admin API dead). Counters survive restarts.
   - **Fix code** — for REAL bugs (village source or roster), edit + restart.
     Run `npx tsc --noEmit` first. Never edit Java (needs MC restart — out of scope).
4. Log: append problems to `problems.jsonl`, actions to `actions.jsonl`.
5. Schedule the next wake. Cadence: 90–120 s while problems are active,
   ~270 s when the village hums.

## problems.jsonl format

One JSON object per line:
`{"t": ISO, "id": "P<n>", "severity": "critical|major|minor", "symptom": "...",
"evidence": "log lines / timings", "rootCause": "... or 'unknown'",
"action": "what the supervisor did", "fixed": bool, "recurrences": n}`

Re-sightings of a known problem: bump `recurrences` in a NEW line with the same
`id` (append-only file). The end-of-run report aggregates by id.

## End of run (4 h)

Final report: food-production curve (from benchmark.jsonl), per-bot totals,
skills written/disabled (from skills.jsonl), problem catalogue with root causes
and which were auto-fixed, and concrete improvement proposals for the next run.
