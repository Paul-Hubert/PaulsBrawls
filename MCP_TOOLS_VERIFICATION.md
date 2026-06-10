# Manual verification — minecraft-mcp-server MCP tools loaded

Goal: prove that every tool defined in `pauls-brawls/minecraft-mcp-server/src/tools/` is actually
exposed to the MCP client (Claude Desktop, Cursor, or whichever client is wired up). This is the
*upstream MCP entrypoint* (`src/main.ts`) — NOT the God-Body HTTP bridge (`src/bridge/main.ts`).
Run this whenever you bump dependencies, edit `main.ts`, add/remove a tool module, or change the
MCP client's `mcpServers` config.

> **Scope:** this verifies tool *visibility* (the client sees them and can describe them). It does
> NOT verify that every tool actually works against a live Minecraft server — that's a separate
> end-to-end test. The point here is "does the MCP transport carry the full toolkit, in one piece,
> without one of the `register*` calls silently failing."

## Ground truth — the 25 tools that must appear

> **TEMP:** `dig-block` is currently disabled at user request (registration commented out in
> [block-tools.ts](minecraft-mcp-server/src/tools/block-tools.ts) — the underlying mineflayer-tool
> plugin is still loaded so `collect-block` keeps its auto-equip behaviour). To restore: uncomment
> the registerTool block, then bump every count below from 25 back to 26, re-add `dig-block` to the
> block-tools.ts row and the §4 canonical sorted list, and re-add it to `CANONICAL_TOOLS` in
> [verify-mcp-tools.mjs](verify-mcp-tools.mjs).
>
> **Removed:** `move-in-direction` was permanently removed — it was a blind WASD pulse with no
> obstacle awareness, strictly worse than `move-to-position` for any non-trivial movement.

Source: `grep -rn "factory.registerTool" minecraft-mcp-server/src/tools/`. If you change a tool
name or add/remove one, update this list and re-run the count check in §1.

| File | Tools |
|---|---|
| `position-tools.ts`   | `get-position`, `move-to-position`, `look-at`, `jump` |
| `flight-tools.ts`     | `fly-to` |
| `gamestate-tools.ts`  | `detect-gamemode` |
| `entity-tools.ts`     | `find-entity` |
| `inventory-tools.ts`  | `list-inventory`, `find-item`, `equip-item` |
| `chat-tools.ts`       | `send-chat`, `read-chat` |
| `block-tools.ts`      | `place-block`, `get-block-info`, `find-blocks` *(`dig-block` temp-disabled)* |
| `furnace-tools.ts`    | `smelt-item` |
| `crafting-tools.ts`   | `list-recipes`, `craft-item`, `get-recipe`, `can-craft` |
| `combat-tools.ts`     | `attack-entity`, `stop-combat` |
| `collection-tools.ts` | `collect-block` |
| `follow-tools.ts`     | `follow-entity`, `stop-follow` |

**Expected count: 25** *(26 once `dig-block` is restored)*.

## 1. Static check — codebase still claims 25

Cheap, do this first. From the repo root:

```bash
grep -rn "factory.registerTool" minecraft-mcp-server/src/tools/ | wc -l
# expected: 25 (with dig-block temp-disabled, move-in-direction permanently removed)
```

```bash
# Print the list, sorted, so you can diff against the table above.
grep -rhA1 "factory.registerTool" minecraft-mcp-server/src/tools/ \
  | grep -oE '"[a-z-]+"' | tr -d '"' | sort -u
```

If the count differs from 25, or the list doesn't match the table above, the table is stale —
update it before proceeding. A drift between code and table is itself a failure to surface.

Also confirm `src/main.ts` actually calls every registrar — a tool module can exist without being
wired:

```bash
grep -E "register(Position|Inventory|Block|Entity|Chat|Flight|GameState|Crafting|Furnace|Combat|Collection|Follow)Tools" \
  minecraft-mcp-server/src/main.ts
```

Twelve register calls expected.

## 2. Start the MCP server (the way the client will)

The MCP server is invoked via stdio. The path depends on the client config — check what's actually
configured in `claude_desktop_config.json` (or your client's equivalent):

```jsonc
// Typical Claude Desktop config
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": ["-y", "github:yuniko-software/minecraft-mcp-server",
               "--host", "localhost", "--port", "25565", "--username", "ClaudeBot"]
    }
  }
}
```

If you want to verify the *local* copy at `pauls-brawls/minecraft-mcp-server/` instead of the
published one, point the config at it:

```jsonc
{
  "mcpServers": {
    "minecraft-local": {
      "command": "node",
      "args": ["C:/Users/Paul/Desktop/pauls-brawls/minecraft-mcp-server/dist/main.js",
               "--host", "localhost", "--port", "25565", "--username", "ClaudeBot"]
    }
  }
}
```

(Run `npm run build` inside `minecraft-mcp-server/` first so `dist/main.js` exists.)

> **Don't run the bridge entrypoint here.** `npm run bridge` doesn't speak MCP, so an MCP client
> sees nothing. The bridge has its own verification path in [VERIFICATION.md](VERIFICATION.md) §2.

After editing the config, **fully quit** the MCP client (Cmd-Q / right-click tray → Quit; closing
the window isn't enough — Claude Desktop in particular keeps a tray process alive that holds the
old server config). Relaunch.

## 3. Confirm the client sees the server

Use the right tool for the surface:

- **Claude Desktop (native app):** screenshot it (computer-use `screenshot`). The MCP indicator
  appears at the bottom of the input box — usually a hammer/tool icon or `🔌` glyph with a count.
  Click it to expand the list of connected servers and the tools each exposes.
- **Cursor / VS Code with an MCP extension:** open the MCP panel in the sidebar; tool lists appear
  there.
- **claude.ai web app + Chrome MCP:** not applicable — the web app doesn't connect to local MCP
  stdio servers.

In Claude Desktop specifically, the expanded view lists each server with the tool count. Confirm:

- The server `minecraft` (or `minecraft-local`) is **connected** (no red dot, no "failed to start"
  banner under the server name).
- The reported tool count is **25**.

If the count is <25, one or more `register*` calls threw during startup — check the server's
stderr log. Claude Desktop captures it under (on Windows) `%APPDATA%\Claude\logs\mcp*.log` or
similar; the file path is shown next to "View logs" in the MCP settings UI.

## 4. Enumerate every tool by name

Don't trust the count alone — a typo could rename a tool to something close enough to confuse a
human eye-scan. Have the model list them. Open a fresh chat in the MCP client and prompt:

```
Without calling any tools, list every tool you currently see from the "minecraft" MCP server, one
per line, alphabetically. Then print the total count.
```

Compare the output against this canonical sorted list (25 names — `dig-block` temp-disabled, `move-in-direction` permanently removed):

```
attack-entity
can-craft
collect-block
craft-item
detect-gamemode
equip-item
find-blocks
find-entity
find-item
fly-to
follow-entity
get-block-info
get-position
get-recipe
jump
list-inventory
list-recipes
look-at
move-to-position
place-block
read-chat
send-chat
smelt-item
stop-combat
stop-follow
```

Every line above must appear in the model's reply, exactly once, with no extras (extras would mean
either a leftover tool registration from a previous version, or a different MCP server's tools
leaking in — both worth investigating).

## 5. Confirm each tool's schema landed (spot check, not exhaustive)

A registered tool can still be malformed — a broken Zod schema crashes only when the model tries
to use it, not at registration time. Spot-check at least one tool from each of the twelve modules
by asking the model to describe its parameters:

```
For each of these MCP tools, print the tool name, its description (one line), and its required
parameters in the format `name: type`:

  get-position, fly-to, detect-gamemode, find-entity, list-inventory, send-chat, place-block,
  smelt-item, can-craft
```

Pass criteria for each:

- The description prints (non-empty, non-default-placeholder).
- The parameter list matches the Zod schema in the source file (e.g. `place-block` should require
  `x, y, z` with optional `faceDirection` — there is no `blockName`; the tool places whatever the
  bot is currently holding, which you set separately via `equip-item`). If a parameter is missing
  or has the wrong type, the schema was lost in transport.

## 6. Lightweight call check (optional, gates if no Minecraft server is running)

If a Minecraft server is reachable on the configured `--host:--port`, ask the model to call:

```
Call `get-position` and report what came back.
```

Pass: the tool runs and returns JSON containing `x`, `y`, `z`. Fail: an error like "connection
check failed" means the bot can't reach Minecraft (not an MCP problem — check
`bot-connection.ts`'s reconnect logs) or "unknown tool" means the tool isn't actually registered
despite appearing in the list (a `ToolFactory` registration bug — rare, but worth catching).

If no Minecraft server is running, skip this — every tool will fail the same way (the connection
check fires before the handler), so it tests nothing about MCP wiring.

## 7. Final report

Produce a markdown table:

| Step | Check | Status (PASS / FAIL / SKIP-with-reason) | Evidence (screenshot path, log line, tool output snippet) |

Then a short prose section:
- Every FAIL, root cause if known, smallest fix.
- Tools listed by the client but NOT in the §0 canonical table → potential leftover or
  cross-server bleed.
- Tools in the §0 canonical table but NOT listed by the client → a `register*` call silently
  failed; check the MCP server's stderr log.

If §1–§5 all pass, the MCP tool surface is intact and faithfully transported. If §6 also passes,
the bot is also reachable and at least one round-trip works end-to-end.
