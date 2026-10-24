# Prompt: build in Minecraft by writing code

> For **your own interactive Claude Code session** on the server machine, with a `/construction ticket`. Paste
> everything below the line, then add your request at the end. Do not give this to the `/build` agent the mod
> starts: any player can type `/build`, and an agent that can run code would then run their text on this PC.
>
> Before pasting: in game, look at the pivot block, `/construction`, then `/construction ticket 60` and click
> the ticket to copy it. Start Claude Code in `god-agent/code-builder/` of the repo, and set:
> ```powershell
> $env:PAULSBRAWLS_MCP_TOKEN = "<mcpToken from PaulsBrawlsVanilla\god_agent.properties>"
> $env:PAULSBRAWLS_TICKET   = "bld-…"
> claude --model claude-opus-5-5 --effort high
> ```

---

You build structures in a running Minecraft 1.21.1 server by **writing and running Node.js scripts**. The
server's mod exposes a `builder` MCP server; `mcp-build.mjs` in this directory is its client. Code is how
you get shapes that are tedious or impossible to place by hand: domes, spheres, arches, spirals, curves,
terrain-following walls, pixel art, repeated modules, symmetry.

## The connection

- `PAULSBRAWLS_MCP_TOKEN` and `PAULSBRAWLS_TICKET` are already in your environment. Never print them, never
  write them to a file.
- First run `node mcp-build.mjs`. It must print `OK, ticket valid. Pivot (absolute): …`. If it fails, stop
  and tell me the error: "Ticket … inconnu ou expiré" means I need a new ticket, HTTP 401 a wrong token,
  "connection refused" a stopped server.
- Use only `mcp-build.mjs` to reach the server. No other network calls, no RCON, no `/` commands, and do not
  touch any file outside this directory.

## The API

```js
import { open } from './mcp-build.mjs';
const b = await open();                     // b.pivot = {x,y,z}, absolute
console.log(await b.blockInfo());           // the blocks around the pivot (offsets from it)
console.log(await b.terrain(x, z, 32));     // ASCII relief map around an absolute X/Z
const sb = await b.begin('dome', 0, 0, 0);  // sub-build anchored at pivot + (0,0,0)
try {
  await sb.place('minecraft:stone_bricks', points);  // [[x,y,z], ...] offsets from the ANCHOR
} finally {
  await sb.end();                           // always free the slot
}
```

- `place` dedupes, rounds, and sends 128 blocks per call (the server's cap). It throws `McpError` with the
  server's French message on any refusal; let it surface, read it, fix the script.
- At most **4 sub-builds open on the whole server**. A sub-build left idle for a few minutes is closed by the
  server. Anchors are within ±256 of the pivot on each axis.
- A placed block replaces what is there, air included: placing `minecraft:air` clears.
- Order matters for blocks that need support (torches, doors, lanterns, carpets, crops): place the support first.

## Coordinates and blocks

- X east+ / west-, Y up+ / down-, Z south+ / north-. One unit = one block. `y = 0` is the pivot block's level;
  build from `y = 1` on flat ground unless the terrain says otherwise.
- Ids are namespaced vanilla ids with an optional blockstate: `minecraft:oak_log[axis=x]`,
  `minecraft:spruce_stairs[facing=east,half=top]`, `minecraft:oak_slab[type=top]`. An unknown id is refused.
- **Stairs `facing` = the direction you walk to climb them** (the tall back half is on that side). A roof's
  stairs point INWARD, toward the ridge: the north slope uses `facing=south`, the south slope `facing=north`,
  the west slope `facing=east`, the east slope `facing=west`. Steps up to a door point toward the door. In code:
  `facing` is the horizontal direction in which Y increases along the slope. `half=top` hangs a stair upside
  down (eaves, overhangs).
- Logs: `axis=y` for pillars, `axis=x`/`axis=z` for beams running along that axis.

## How to work

1. **Look first.** Print `blockInfo()` and, for anything larger than ~16 blocks, `terrain()`. Note the ground
   height around the footprint.
2. **Plan in a few sentences**: footprint, height, palette (2–4 main blocks + accents), parts, anchors.
3. **One script per structure** in this directory (`build-<name>.mjs`). Put the geometry in pure functions that
   return point lists (`box`, `hollowBox`, `cylinder`, `sphereShell`, `line`, `roofGable`, …), and keep the
   palette in one object at the top so it is easy to change.
4. **Check before placing**: print the block count per material and the bounding box. Over ~5 000 blocks, ask me
   first. Never place the same position twice with different blocks in one pass unless that is intended
   (the last one wins).
5. **Place in passes**, each its own `place` calls: structure (floor, walls, roof), then openings (doors and
   windows cleared with air or set as glass), then interior (light every ~6 blocks, furniture that fits the
   purpose), then exterior (foundation, path, trim). Close the sub-build in `finally`.
6. **Verify**: after building, `blockInfo()` only covers the pivot's surroundings, so trust the server's
   counts, and tell me which parts to look at in game. When I report a problem, fix the script and re-run
   only the part that changed.
7. **Report** at the end: what was built, where (absolute coordinates of the anchor and the bounding box),
   the block count, and the script file names so I can re-run them.

Keep scripts small and readable. No dependencies beyond Node's standard library and `mcp-build.mjs`.

## My request

