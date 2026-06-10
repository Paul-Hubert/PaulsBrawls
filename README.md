# Pauls Brawls

Collection of Minecraft mods for Fabric 1.21.1.

## Gibber

Simple commands for giving money to everyone equally, even those offline, with support for a customizable periodic salary.

## Capture the flag

Simple changes that make capture the flag more fun:
* When taking damage, you automatically drop a banner with "Flag" in its name
* Elytra is disabled when holding a Flag in inventory
* Flag holders glow

## AI God

An LLM-driven `Dieu` (LangChain4j; supports OpenAI, LM Studio, Ollama via `/llm provider …`). You pray to it, it answers in French — sometimes with gifts, sometimes with lightning.

Player commands:

| Command | What it does |
|---|---|
| `/pray <text>` | Send a message to God. They may give items (`Reward`), offer a trade (`Trade`), strike you with lightning (`Punishment`), change the weather, or spawn creatures. |
| `/pray stop` | End your active prayer session immediately. |
| `/accept` | Accept the pending trade. |
| `/prove <text>` | Send a screenshot as proof of completing a quest. |
| `/build <text>` | Send a screenshot of a site and ask God to design something there. Triggers `BuildPlan` — multiple isolated sub-agents place blocks in parallel. |

Admin commands (`/llm`, `/godbody`, `/prompt`, `/construction`, `/block`) are documented in [CLAUDE.md](CLAUDE.md).

### Optional: give God a body

The mod can drive a Mineflayer bot as God's physical avatar — it teleports in front of you when God chooses to `Appear`, speaks in public chat, swings its arm when it punishes you, and warps away when the encounter ends.

Setup:

1. Run a **dedicated** Fabric 1.21.1 server (not Open-to-LAN; the bot needs to be opped on join).
2. Install Node 20+, then start the bridge inside this repo:
   ```
   cd minecraft-mcp-server
   npm install
   npm run bridge -- --host <mc-host> --port <mc-port> --username LLMBot --bridge-port 8765
   ```
3. The bot joins, gets opped automatically (`ServerEntryPoint` watches for `BridgeConfig.botUsername` on join), and waits in a parking spot until God calls `Appear`. Toggle / clamp behaviour with `/llm bridge …`; kill-switch with `/godbody off`.

The full architecture lives in [GOD_BOT_INTEGRATION_PLAN.md](GOD_BOT_INTEGRATION_PLAN.md). End-to-end verification checklist: [VERIFICATION.md](VERIFICATION.md).
