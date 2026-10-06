# god-agent — the external God and Builder (opencode)

This directory is the configuration for the **external agent** that does the thinking for the Java AI God when the
mod runs with `godAgent=external` (see [docs/27](../docs/27-god-builder-mcp-design.md) and
[docs/system/aigod/external-agent.md](../docs/system/aigod/external-agent.md)). The mod hosts two MCP servers
(`/mcp/god`, `/mcp/builder` on `127.0.0.1:8771`). opencode connects to them and runs three agents:

| Agent | Prompt | May use |
|---|---|---|
| `god` (primary) | `prompts/god.md` (the persona from `prompt.txt`) | `god_*` tools only |
| `builder` (primary) | `prompts/builder.md` | `builder_*` and `task` → `sub-builder` |
| `sub-builder` (subagent) | `prompts/sub-builder.md` (the old refinement passes) | `builder_*` only |

Every other opencode tool (bash, edit, read, webfetch…) is denied (`"permission": {"*": "deny"}`). The mod does
not rely on this: every rule (tickets, clamps, the 4-sub-build and 128-block caps) is enforced server-side.

## Run it

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
