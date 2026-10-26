---
name: mc-build
description: Build a structure in the running Minecraft server (pauls-brawls) by writing and running Node scripts with the god-agent/code-builder component library, from a /construction ticket (bld-…) and a build request. Covers the whole job, from connecting and surveying the site through composing from the library, proving enclosures escape-proof, dry run and live build, to the report. Use it whenever the user gives a bld- ticket, asks to build, construct or place something in the Minecraft world "by code" or "with functions", pastes a build brief from prompts/, or asks to re-run, fix or extend a build script in god-agent/code-builder.
argument-hint: <bld-ticket> <what to build>
---

# Build in Minecraft by code

Arguments: `$ARGUMENTS`

The first word starting with `bld-` is the **ticket**. The rest is the **build request**. If no ticket was given, use
`PAULSBRAWLS_TICKET` from the environment, or ask for one before placing anything. Everything you can do without
the server (reading, planning, writing and dry-running the script, tests) needs no ticket.

You work in `god-agent/code-builder/` (paths below are relative to it, except `references/`, `assets/` and
`scripts/`, which are in this skill's directory, `.claude/skills/mc-build/` at the repo root, i.e.
`../../.claude/skills/mc-build/` from `god-agent/code-builder/`). `PROMPT.md` there is the library's API
reference: read it first, every time, because it is kept up to date with the code. This skill adds the workflow
around it and the lessons that live builds taught. `references/` has the details:

- `references/blocks.md`: blockstates, placement order, water, crops, light, job sites. Read it before you write blocks.
- `references/creatures.md`: spawning, 1.21.1 NBT, statues, villager work and panic, mob behaviour. Read it before you spawn anything.
- `references/proofs.md`: proving with `walk` that an enclosure holds. Read it when the build contains or keeps out a creature: a pen, a prison, a farm, a keep, a gate.
- `assets/build-template.mjs`: the skeleton of a build script. Copy it to `god-agent/code-builder/build-<name>.mjs`.
- `scripts/survey.mjs`: block info and terrain maps around the pivot in one call.
- `scripts/slice.mjs`: top views of one window of a build script's plan, at the levels you ask for.

## The rules that keep the server and the secrets safe

- **The ticket and the MCP token are secrets.** Pass them only as environment variables on each `node` command.
  Never print them, never write them to a file (scripts, logs, notes, commit messages).
- **Token:** use `PAULSBRAWLS_MCP_TOKEN` if it is set. Otherwise read `mcpToken` from `god_agent.properties` in the
  running server's directory, inline in the command, so the value is never shown. Production is
  `C:\Users\Paul\Desktop\PaulsBrawlsVanilla\`; the dev server (`./gradlew runServer`) is the repo's `run/`. Reading
  that file is the one exception to "touch nothing outside `god-agent/code-builder/`".
- **Reach the server only through `mcp-build.mjs` / `lib/build.mjs`.** No other network calls, no RCON, no `/` commands.
- The server enforces its own limits: 128 blocks per call; at most 4 sub-builds open on the whole server; anchors
  within ±256 of the pivot; a sub-build idle for 2 minutes is closed. Creatures: 16 per call, 128 per sub-build,
  mobs only (no armor stands or item frames), never the Wither or the Ender Dragon. A refusal comes back as a French
  `McpError`: read it and fix the script.
- **A placed block replaces whatever is there, air and other people's builds included.** That is why the survey
  comes before any placement.

Every server command runs from `god-agent/code-builder/` and has this shape (bash; `TICKET` is the bld- value,
and the last part is the script and its options):

```bash
PAULSBRAWLS_MCP_TOKEN="${PAULSBRAWLS_MCP_TOKEN:-$(grep '^mcpToken=' /c/Users/Paul/Desktop/PaulsBrawlsVanilla/god_agent.properties | cut -d= -f2- | tr -d '\r')}" PAULSBRAWLS_TICKET=TICKET node mcp-build.mjs
```

## Workflow

### 1. Connect

Run `node mcp-build.mjs`. It must print `OK, ticket valid. Pivot (absolute): …` and `spawn_mobs: available.` If not:

| Output | Meaning | Do |
|---|---|---|
| `Ticket … inconnu ou expiré` | expired or replaced | Stop and ask for a new ticket (see below) |
| `HTTP 401` | wrong token | Check which server is running; read its `god_agent.properties` |
| `connection refused` / `fetch failed` | server stopped, or not in external mode | Tell the user |
| `spawn_mobs: MISSING` | the mod predates spawning | Build the structure anyway (creatures come last); tell the user to rebuild the mod with the server stopped |

**Tickets expire** (`/construction ticket <minutes>`: 60 by default in the current mod, 480 at most; a running mod
may be older). Minting a new ticket revokes the old one. When you ask for a new ticket, tell the user to run
`/construction ticket <minutes>` *without* running `/construction` again: `/construction` moves the pivot to the
block they are looking at, and every anchor in your script is relative to the pivot. For a big build, suggest a
long ticket (e.g. `/construction ticket 240`). Always compare the new pivot with the one you planned for.

### 2. Read the request and what exists

- `PROMPT.md` (the API), then the source of every component you will use in `lib/components.mjs`: options and local
  frames are documented in each doc comment, and some details (which side a door is on, where a ladder goes) only
  show there.
- A brief in `prompts/` that matches the request: its rules win over this skill's defaults.
- The existing build scripts (`build-*.mjs`) as worked examples of composition, transforms, proofs and spawns.

### 3. Survey the site

Run `node ../../.claude/skills/mc-build/scripts/survey.mjs` (block info, terrain at radius 16, 32 and 64, and radius 64 at
±64 offsets). Add `--radius=R --at=x,z` (absolute coordinates) for a specific spot. From the maps, note:

- **The ground height over the footprint.** `y = 0` in a plan is the ground course: the anchor's Y is
  `groundY - pivotY` (0 on flat ground at the pivot's level).
- **Everything already built nearby, and its extent.** A heightmap bump or a `?` (unloaded chunk) is something to
  keep clear of or to load (a player must be near).
- **Depth:** the production world is superflat (grass at y = -61, bedrock at -64), so anything dug below the
  ground course (moat, pit, cellar) is at most 3 deep there. Check before you plan a basement.

Known builds in the production world (October 2026; the survey is the truth, this list only tells you what to look for):

| Build | Absolute extent |
|---|---|
| Bronze Age town (moat included) | x 182..352, z 656..852 |
| Labor prison (moat included) | x -238..-92, z 549..701 |
| Palace | around x 151, z 384 |
| Ziggurat and Ishtar gate | around x 9, z 264 |
| Cottage | around x 44, z 147 |
| Unidentified builds | x 11..122, z 589..860 |
| Babylon (moat included; built 2026-10-26 by `build-babylon.mjs`, anchor -195, -61, 924; 41 villagers, so re-run its blocks with `--mobs=none`) | x -214..4, z 897..1123 |

### 4. Plan

Decide the footprint, height, zones, palette, the components with their main parameters, the anchors, and the
creature counts. Size it to the request and the free space. A short request ("make babylon, walled out, village,
ziggurat, hanging gardens, fort and palace with great gate") is a brief to design in full: choose the parts, their
layout and the details yourself, generously, and bring them all in one plan.

Then write the script and dry-run it **before** asking for the go: nothing is placed, and the user can approve the
plan, the size and the creature count in one round trip instead of three, while the ticket is still running.
Present a few sentences of plan, the dry-run totals, the bounding box in absolute coordinates, the creature counts
per type and the proof results. Then wait for an explicit go. Ask *before* writing code only when the request
leaves a major choice open (where, how big, which style) that would change most of the script.

### 5. Compose the script from the library

Copy `../../.claude/skills/mc-build/assets/build-template.mjs` to `build-<name>.mjs` and fill it in:

- **Components first.** Most structures are library components with parameters, placed with
  `placeAt(plan, { at, turns, mirror })`. Transforms fix every blockstate (stair facing, log axis, door hinge, bed
  facing), so build a part in its documented local frame and turn it into place; never re-derive blockstates by hand
  for a turned part.
- **Keep everything a later step needs as data** while you compose: zone bounds and starts (proofs), spawn points
  (creatures), statue positions (panic check). Compute them through the same transform as the part they belong to:
  a helper that applies `{ at, turns }` to a point keeps them in step with the blocks.
- **Later layers win** where they overlap. Air layers cut openings, so they come after the wall they cut.
- **New geometry only when no component fits.** If it is reusable (you could build it again with other
  parameters), add it to `lib/geom.mjs` or `lib/components.mjs` with defaults and a doc comment, a test in `test/`,
  and a line in PROMPT.md's library list. Run `node --test` in this directory: it must pass. One-off details stay in
  the script.
- Parameters at the top or from `--key=value` (`cliOptions()` parses numbers and booleans); the header comment
  says what the structure is, its local frame, how to run it, and which parameters give a variant.
- **Decorations over a component can block it.** A course, band or ring you draw around a gatehouse also runs
  across its passage (it did on Babylon's gates): leave the passage cells out.
- **Big plans** (Babylon was ~205 000 positions): never spread a whole point list into `Math.min(...)`,
  `Math.max(...)` or `push(...)`. Past ~120 000 arguments it overflows the call stack. Loop, or use `bbox()`
  (`walk`, `sliceMap` and `build` do).
- No Python on this PC: for edits at several spots, use Edit, or `node -` with a heredoc that throws when a search
  string is missing (so a missed replace fails loudly), keeping CRLF in the files that use it (`.gitignore`).

### 6. Prove, dry-run, inspect

- `node build-<name>.mjs` prints the totals per material, the bounding box (relative to the anchor) and the
  creatures per type. Check the totals against your intent: a wrong count is the cheapest bug to catch.
- `--slice=N` prints the top view at y = N. Look at the ground floor (y = 1), a door or window level (y = 2), each
  walkway or floor level, and the roofs. Check doors, openings, stairs (`^v<>` show the facing) and that parts touch
  where they should and nowhere else. The legend's letters repeat past ~40 materials, so read it alongside the counts.
  Look at the y = 1 slice of every gate and doorway. Past ~100 blocks wide the full slice is unreadable: run
  `node ../../.claude/skills/mc-build/scripts/slice.mjs build-<name>.mjs --win=x0,z0,x1,z1 --y=1,9` for one window
  (plan coordinates) at each level, area by area.
- **Enclosures:** the containment proof runs inside the script on every dry run and throws if it fails
  (`references/proofs.md`). Never build an enclosure whose proof fails.
- `node --test` again if you touched `lib/`.

### 7. Build

1. Get the go. Over 5 000 positions or 32 creatures, `build()` refuses without `--yes`: the go you got in step 4
   covers it only if it named those numbers.
2. Re-check the ticket with `node mcp-build.mjs` right before, and check that the pivot is the one you planned for.
   (One build failed because the ticket expired in the minute between approval and launch.)
3. Run `node build-<name>.mjs --build --yes --parallel=4` (use `--parallel=2..4` for anything big) in the
   background, with its output going to a log file in your scratchpad, and wait for it to finish.
4. Read the end of the log: `placed N positions, server confirmed N; C of C creatures spawned. Anchor (absolute): …`.
   Placed must equal confirmed, and every creature must have spawned.

When something fails:

- **The slots are busy** (`tournent déjà`): another build holds the 4 sub-build slots. `build()` retries every 15 s
  for 10 minutes. Let it wait.
- **A refusal** (a French `McpError`): fix the script, dry-run, and re-run. Placing again is harmless (a block
  replaces itself), but **spawning again duplicates every creature**. If the blocks went in and only the creatures
  failed, re-run with `--mobs=only`; if creatures already spawned and you must redo blocks, use `--mobs=none`.
- **The ticket expired mid-build:** stop and ask for a new one (step 1). Sub-builds end in `finally`, so the slots
  free themselves.

### 8. Report

- What was built, in a sentence per zone or part.
- The absolute anchor and the absolute bounding box (pivot + anchor + the relative box).
- Positions planned vs server-confirmed; creatures planned vs spawned, per type.
- The proof results, one line per zone (when there are any).
- The script name and the parameters to change for a variant.
- What the user should check in game: the things the code cannot prove. For example, door and button wiring,
  creatures doing their jobs, lighting at night, and anything the proofs do not model (spiders, endermen, digging).
- Anything you changed in `lib/`, with its test.

Leave committing to the user: say what changed and where.
