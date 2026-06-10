# Prompt: Add Mineflayer plugins + verify against current docs

Paste the **task block** below into a fresh Claude Code session at the repo root. The session will auto-read `CLAUDE.md` and `minecraft-mcp-server/CLAUDE.md` for context — don't re-paste them.

---

## Task

Install and wire five Mineflayer plugins into the vendored MCP server at
[`minecraft-mcp-server/`](minecraft-mcp-server/), expose them as MCP tools where
appropriate, and **verify each wiring against the plugin's current published
documentation via WebSearch + WebFetch before declaring done**.

### The five plugins

| npm package | Role | Wiring outcome |
|---|---|---|
| `mineflayer-pvp` | Combat attack loop | New tools `attack-entity`, `stop-combat` |
| `mineflayer-auto-eat` | Eats from inventory when hungry | No tool — autonomous after configure |
| `mineflayer-armor-manager` | Auto-equips best armour | No tool — autonomous after load |
| `mineflayer-collectblock` | Find-and-harvest-N loop | New tool `collect-block` |
| `mineflayer-tool` | Auto-pick best tool for a block | Inline into existing `dig-block`; no new tool |

`mineflayer-cmd` is **intentionally excluded** — don't install it.

### Phase 1 — Research FIRST (before writing any code)

For each of the five plugins, in parallel:

1. WebFetch its npm page (`https://www.npmjs.com/package/<name>`) AND its GitHub README (linked from the npm page).
2. Extract and record in a table:
   - Latest published version.
   - `peerDependencies.mineflayer` range — must overlap `^4.35.0` (current pin in [`minecraft-mcp-server/package.json:33`](minecraft-mcp-server/package.json:33)).
   - Stated Minecraft-version support — must include `1.21.1` (see `SUPPORTED_MINECRAFT_VERSION` in [`bot-connection.ts:6`](minecraft-mcp-server/src/bot-connection.ts:6)).
   - **Exact import idiom** shown in the README (ESM vs CJS, named vs default export, loader name).
   - Property the plugin attaches to `bot` (e.g. `bot.pvp`, `bot.autoEat`).
   - Current public method signatures for the calls you'll make.

If a plugin's README explicitly does **not** support MC 1.21.1 or mineflayer `^4.35.0`, **stop and ask the user before proceeding** — do not install it.

Output the findings table before moving to Phase 2.

### Phase 2 — Implementation

**Architectural rules** (don't deviate without checking with the user):

- Plugin loading goes inside the existing `bot.once('spawn', async () => { ... })` handler in [`bot-connection.ts`](minecraft-mcp-server/src/bot-connection.ts) — **not** in `botOptions.plugins`. That construction-time slot is reserved for plugins that must be wired pre-spawn; only pathfinder needs that.
- ESM default-import gotcha: this project is `"type": "module"`. Many mineflayer plugins are CJS. The template is the existing pathfinder import at [`bot-connection.ts:2-3`](minecraft-mcp-server/src/bot-connection.ts:2):
  ```ts
  import pkg from 'mineflayer-foo';
  const { plugin: foo } = pkg;
  ```
  Use whatever shape the README documents — your Phase 1 research is the source of truth, not this snippet.
- Type augmentation goes in [`types.d.ts`](minecraft-mcp-server/src/types.d.ts). Follow the existing `declare module 'mineflayer-pathfinder'` block as the template. Augment `interface Bot` with the new property each plugin attaches. If a plugin ships its own types (newer auto-eat does), skip the `declare module` and only do the `Bot` augmentation.
- New tool modules go in [`src/tools/`](minecraft-mcp-server/src/tools/). Always use `factory.registerTool(...)` — never `server.tool()` directly. Receive `getBot: () => Bot` and call it inside each handler (never capture the bot at registration; reconnects swap the bot reference). Template: [`position-tools.ts`](minecraft-mcp-server/src/tools/position-tools.ts).
- Every new module must be registered in **both** [`main.ts`](minecraft-mcp-server/src/main.ts) AND [`unified/main.ts`](minecraft-mcp-server/src/unified/main.ts). Skipping `unified/main.ts` means production silently doesn't see the new tools — `pauls-brawls` uses `npm run unified` exclusively.

**Specific wirings:**

- **mineflayer-pvp** → load post-spawn. New module `src/tools/combat-tools.ts` with:
  - `attack-entity` — params `{ type: string, maxDistance?: number (default 16) }`. Nearest-entity matching `name.includes(type.toLowerCase())` OR `entity.type === type`. Bail with a "no X found within Y blocks" response if nothing matches or distance exceeds maxDistance. Otherwise call `bot.pvp.attack(target)` (fire-and-forget, pvp runs its own loop) and respond with target name + distance.
  - `stop-combat` — no params. `await bot.pvp.stop()`.
- **mineflayer-auto-eat** → load post-spawn. Configure `bot.autoEat.options` using values from the README — do not invent. No tool. Record the option values you chose in the final summary.
- **mineflayer-armor-manager** → load post-spawn. No tool. (It listens to inventory events on its own.)
- **mineflayer-collectblock** → load post-spawn. New module `src/tools/collection-tools.ts` with:
  - `collect-block` — params `{ blockType: string, count?: number (default 1) }`. Look up the block id from `bot.registry.blocksByName`; bail on unknown. Use `bot.findBlocks({ matching, maxDistance: 32, count })`. Bail if zero hits. Map positions to blocks, then `await bot.collectBlock.collect(targets)`. Respond with the count actually collected.
- **mineflayer-tool** → load post-spawn. **No new tool.** Inline into [`block-tools.ts`](minecraft-mcp-server/src/tools/block-tools.ts) by inserting `await bot.tool.equipForBlock(block, {});` immediately before `await bot.dig(block);` at [block-tools.ts:113](minecraft-mcp-server/src/tools/block-tools.ts:113).

**Bookkeeping** — update all four in the same commit:

- `CANONICAL_TOOLS` array in [`verify-mcp-tools.mjs:17`](verify-mcp-tools.mjs:17) — add the two new tool names (`attack-entity`, `stop-combat`, `collect-block`), keep sorted, bump expected count from 22 to 25.
- The table in [`MCP_TOOLS_VERIFICATION.md`](MCP_TOOLS_VERIFICATION.md) §0 — add rows for `combat-tools.ts` and `collection-tools.ts`. Update "Expected count: 22" → 25 in §0 and §1.
- §8 of [`HIGHER_LEVEL_TOOLS.md`](HIGHER_LEVEL_TOOLS.md) — mark the five installed plugins (strike through, or add a "✅ done" note inline).
- Root [`CLAUDE.md`](CLAUDE.md) Gotchas section — add one line that `dig-block` now auto-equips the best tool. Invisible side effects in pre-existing tools are exactly the kind of thing painful to rediscover later.

### Phase 3 — Verification

Run in this order. Don't proceed past a failure.

1. `cd minecraft-mcp-server; npx tsc --noEmit` — must pass clean. Type errors here mean either missing `types.d.ts` augmentation or your Phase 1 API shape was wrong; fix at source, **don't add `as unknown as` casts to bypass the type checker** (there's some precedent in [`crafting-tools.ts:272`](minecraft-mcp-server/src/tools/crafting-tools.ts:272) but treat that as a last resort).
2. `cd minecraft-mcp-server; npm run lint` — must pass clean.
3. `cd minecraft-mcp-server; npm run build` — must pass clean.
4. From the repo root: `node verify-mcp-tools.mjs` — §3 (count = 25) and §4 (name set matches `CANONICAL_TOOLS`) must PASS, §5 (schema spot-check) must PASS for the existing 9 spot-checked tools. §6 will SKIP unless a Minecraft server is running at `127.0.0.1:25565` — that's fine; do not start a server to satisfy it.
5. **Re-fetch each plugin's npm page one more time** and cross-check: the loader/import names, `bot.X` property, and method signatures in your code match what the README currently shows. Any drift = bug. Fix and re-run from step 1.

### Failure modes to surface, not paper over

- A plugin's README documents a different loader name, import shape, or method signature than what you wrote → fix the code to match. Don't bypass with type casts.
- A plugin's `peerDependencies.mineflayer` doesn't include `^4.35.0` → stop and ask the user before installing.
- A plugin has a `postinstall`/`prepare` script that fails on Windows → stop and ask.
- `verify-mcp-tools.mjs` count mismatch after the change → canonical list in [`verify-mcp-tools.mjs`](verify-mcp-tools.mjs) and [`MCP_TOOLS_VERIFICATION.md`](MCP_TOOLS_VERIFICATION.md) are out of sync. Fix both.
- `MCPGateway.ensureStarted` runs on the main server thread — if `bot.loadPlugin(...)` throws at spawn (wrong MC version, missing peer dep), the next `/pray` blocks for 30 s. Run `npm run unified -- --host 127.0.0.1 --port 25565 --username LLMBot --bridge-port 8765` once in a terminal and watch stderr for stack traces before declaring done. (You don't need a live MC server — a spawn-time throw will fire before any connection attempt.)

### Done means

- All of `npx tsc --noEmit`, `npm run lint`, `npm run build` pass clean.
- `node verify-mcp-tools.mjs` reports PASS for §3, §4, §5. §6 SKIP is acceptable.
- Phase 1's research table is in the final summary, including the installed version + mineflayer peer-dep range for each plugin.
- The four bookkeeping files are all updated and consistent.
- Final summary covers: what was installed (versions), what new tools were registered (names + signatures), the auto-eat option values chosen and why, and any drift you found in Phase 3 step 5 vs Phase 1 (with how you fixed it).

### Out of scope — do NOT do

- Don't change `SUPPORTED_MINECRAFT_VERSION` in [`bot-connection.ts:6`](minecraft-mcp-server/src/bot-connection.ts:6).
- Don't change `--username LLMBot` defaults anywhere.
- Don't rebuild the Java mod (`./gradlew build`) — the new MCP tools are picked up automatically by `MCPGateway` on the next `/pray`.
- Don't install `mineflayer-cmd`.
- Don't add or run a `bridge`-only `npm run bridge` — the unified entrypoint is the only one `pauls-brawls` consumes.
- Don't commit or push unless the user asks.
