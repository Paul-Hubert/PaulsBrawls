# god-agent — the external God and Builder (opencode or Claude Code)

This directory is the configuration for the **external agent** that does the thinking for the Java AI God when the
mod runs with `godAgent=external` (see [docs/27](../docs/27-god-builder-mcp-design.md) and
[docs/system/aigod/external-agent.md](../docs/system/aigod/external-agent.md)). The mod hosts two MCP servers
(`/mcp/god`, `/mcp/builder` on `127.0.0.1:8771`). Two agent runtimes can use them, chosen by `agentKind` in
`god_agent.properties`:

- **opencode** (`agentKind=opencode`, the default): `opencode.json` + `prompts/`, a long-running `opencode serve`.
- **Claude Code** (`agentKind=claude-code`): `claude-code/`, one headless `claude -p` per turn started by the mod.
  See [Claude Code](#claude-code) below.

Both run the same three agents with the same prompts (`prompts/*.md` is also the body of
`claude-code/.claude/agents/*.md`; a test fails if they drift).

## opencode

opencode connects to the servers and runs three agents:

| Agent | Prompt | May use |
|---|---|---|
| `god` (primary) | `prompts/god.md` (the persona from `prompt.txt`) | `god_*` tools only |
| `builder` (primary) | `prompts/builder.md` | `builder_*` and `task` → `sub-builder` |
| `sub-builder` (subagent) | `prompts/sub-builder.md` (the old refinement passes) | `builder_*` only |

Every other opencode tool (bash, edit, read, webfetch…) is denied (`"permission": {"*": "deny"}`). The mod does
not rely on this: every rule (tickets, clamps, the 4-sub-build and 128-block caps) is enforced server-side.

### Run it (opencode)

1. Install opencode (checked with 1.18.34): `npm i -g opencode-ai`.
2. Pick the model in `opencode.json` (`"model": "openai/gpt-5"` by default) and export its key, for example
   `OPENAI_API_KEY`. Anthropic (`anthropic/…`, `ANTHROPIC_API_KEY`) works the same way. For LM Studio or Ollama, add
   an `@ai-sdk/openai-compatible` provider with a `baseURL`; mark the model `"attachment": true` if it reads
   images, or `/build` and `/prove` screenshots are dropped.
3. Pick two secrets and export them in **both** the Minecraft server's environment and opencode's:
   - `PAULSBRAWLS_MCP_TOKEN` (or leave it unset, start the server once in external mode, and copy the generated
     `mcpToken` from `god_agent.properties`).
   - `OPENCODE_SERVER_PASSWORD` (the mod reads it as `agentPassword`).
4. Start opencode from this directory:

   ```sh
   cd god-agent
   OPENCODE_CONFIG="$PWD/opencode.json" opencode serve --hostname 127.0.0.1 --port 4096
   ```

5. In the server's working directory, set `godAgent=external` in `god_agent.properties` and restart the server.
   The log shows `MCP servers on http://127.0.0.1:8771 (/mcp/god, /mcp/builder)`.
6. Check the connection: `curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/mcp` should show
   `{"god":{"status":"connected"},"builder":{"status":"connected"}}`.

To go back to the in-mod ChatBot, set `godAgent=builtin` and restart.

## Claude Code

`claude-code/` holds everything Claude Code needs; the mod runs it, so no extra process is started by hand.

| File | What |
|---|---|
| `.mcp.json` | The two HTTP servers. The URL is `${PAULSBRAWLS_MCP_URL:-http://127.0.0.1:8771}/mcp/…` and the header `Authorization: Bearer ${PAULSBRAWLS_MCP_TOKEN}`; the mod sets both variables. |
| `settings.json` | Permissions (passed with `--settings`): `dontAsk` mode, allow `mcp__god`, `mcp__builder` and `Agent(sub-builder)`, deny Bash, Edit, Write, Read, Glob, Grep, NotebookEdit, WebFetch, WebSearch. |
| `.claude/agents/god.md` | `tools: mcp__god__*` — the persona of `prompts/god.md` |
| `.claude/agents/builder.md` | `tools: Agent(sub-builder), mcp__builder__*` — `prompts/builder.md` |
| `.claude/agents/sub-builder.md` | `tools: mcp__builder__*` — `prompts/sub-builder.md` |

Claude Code names the MCP tools `mcp__<server>__<tool>` (`mcp__god__say`). As with opencode, nothing here is
trusted by the mod: tickets, clamps and caps are enforced server-side.

1. Install Claude Code (checked with 2.1.309) for the user that runs the Minecraft server, and authenticate it:
   either log in once (`claude`, then `/login`) or export `ANTHROPIC_API_KEY` in the server's environment.
2. Copy `god-agent/claude-code/` into the server's working directory as `god-agent/claude-code/` (or set
   `claudeDir` to where it is).
3. In `god_agent.properties`:

   ```properties
   godAgent=external
   agentKind=claude-code
   # optional: claudeBin=/path/to/claude, claudeDir=god-agent/claude-code, claudeModel=sonnet
   ```

4. Restart the server. Each `/pray`, `/prove` or `/build` then runs:

   ```sh
   claude -p --input-format stream-json --output-format stream-json --verbose --agent god \
     --mcp-config god-agent/claude-code/.mcp.json --strict-mcp-config \
     --settings god-agent/claude-code/settings.json --setting-sources project --permission-mode dontAsk \
     --session-id <uuid>      # --resume <uuid> for the player's next prayer
   ```

   The prayer (and the screenshot, as an image) goes in on stdin; the last `result` is the answer.

5. To check the connection by hand, in any scratch directory:

   ```sh
   claude mcp add --transport http god http://127.0.0.1:8771/mcp/god --header "Authorization: Bearer $PAULSBRAWLS_MCP_TOKEN"
   claude mcp add --transport http builder http://127.0.0.1:8771/mcp/builder --header "Authorization: Bearer $PAULSBRAWLS_MCP_TOKEN"
   claude mcp list   # god … ✔ Connected, builder … ✔ Connected
   ```

   To **build from your own interactive Claude Code session** (you are the builder, no `/build` turn):
   1. In game, as an op: `/construction` while looking at the site's pivot block, then `/construction ticket 60`.
      Click the gold ticket (`bld-…`) to copy it. It is bound to you and your pivot.
   2. In your session, give it the ticket, for example: "Ticket de construction : bld-… . Utilise les outils
      mcp__builder__* : get_build_origin, puis begin_sub_build / place_* / end_sub_build pour construire une tour".
      A useful allowlist is `"permissions": {"allow": ["mcp__builder__*"]}` in your project's `.claude/settings.json`.
   3. `/construction ticket revoke` when done (or let it expire). A `/build` of yours replaces it.

   The servers listen on 127.0.0.1 only. From another machine use `ssh -L 8771:127.0.0.1:8771 <server>`; never widen
   the bind. In PowerShell, put the token in the header as `"Authorization: Bearer $env:PAULSBRAWLS_MCP_TOKEN"`.

   "Dynamic Client Registration rejected (HTTP 404)" means the `Authorization` header is missing (Claude Code then
   tries OAuth, which these servers do not offer); "HTTP 401" means the token is wrong.

