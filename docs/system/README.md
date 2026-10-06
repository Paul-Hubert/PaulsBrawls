---
id: readme
title: docs/system — verified reference corpus (index)
system: meta
summary: Index of the verified, agent-oriented documentation for the whole mod and Eden — reading paths, document conventions, and how the corpus is meant to be served over MCP.
tags: [index, readme, mcp, conventions, reading-order, manifest]
sources: [docs/system/build-index.mjs]
verified_at: 98cb908
---

# docs/system — verified reference corpus

**TL;DR** — This folder documents every system in the repository: Gibber money, Capture the Flag, the AI God with its
building agent, and Eden. Every claim was checked against the source, not copied from older docs: the whole corpus at commit `4a8081f`, and
each doc again at the commit in its own `verified_at` (`98cb908` for the re-verified ones).
Each file is self-contained, carries machine-readable frontmatter, and is listed in [index.json](index.json), so the
corpus can be served to AI agents through an MCP server (one document = one resource). Where the code contradicts
`CLAUDE.md`, `README.md` or the Eden design spec in `docs/*.md`, the code won and the difference is logged in
[VERIFICATION-NOTES.md](VERIFICATION-NOTES.md).

> The sibling `docs/NN-*.md` files are Eden's **design spec**: intent and rationale, which is partly unimplemented.
> This folder describes **what the code does**. If the two disagree, trust this folder (and re-check the code).

## Documents

### Start here
| id | File | What you learn |
|---|---|---|
| `overview` | [00-overview.md](00-overview.md) | The four systems, the three runtimes, and what is wired vs only designed |
| `reference.commands` | [reference/commands.md](reference/commands.md) | Every command: syntax, permission, source line |
| `reference.ports-files-config` | [reference/ports-files-config.md](reference/ports-files-config.md) | Every port, config file and key, env var, login name |
| `verification-notes` | [VERIFICATION-NOTES.md](VERIFICATION-NOTES.md) | Where older docs are wrong, plus known bugs found while verifying |

### Platform (the Fabric mod shell)
| File | Topic |
|---|---|
| [platform/build-and-runtime.md](platform/build-and-runtime.md) | Gradle build, dependencies and jar-in-jar, assets, mixins, CI reality, `run/`, the submodule, `supervisor/` |
| [platform/entrypoints-and-wiring.md](platform/entrypoints-and-wiring.md) | Server and client entrypoints, every registration and event hook, subsystem→class map |

### Gibber — money
| File | Topic |
|---|---|
| [gibber/money-system.md](gibber/money-system.md) | Coin item, revenue model, salary scheduler, persistence (NBT), commands, edge cases |

### Capture the Flag
| File | Topic |
|---|---|
| [ctf/capture-the-flag.md](ctf/capture-the-flag.md) | Flag detection, drop-on-damage, elytra lock, glowing, edge cases |

### AI God (Java `/pray` chatbot) and building
| File | Topic |
|---|---|
| [aigod/overview.md](aigod/overview.md) | End-to-end prayer flow, component map, the two Gods |
| [aigod/llm-pipeline.md](aigod/llm-pipeline.md) | Memory, message assembly, tool loop, threading, providers |
| [aigod/tools-catalogue.md](aigod/tools-catalogue.md) | Every LLM tool: name, parameters, behaviour, gating |
| [aigod/actions-and-trades.md](aigod/actions-and-trades.md) | World actions (reward, punish, weather, spawn), trades and `/accept` |
| [aigod/images-and-client.md](aigod/images-and-client.md) | Client `/build` and `/prove`, screenshot payload, image requests |
| [aigod/configuration-and-commands.md](aigod/configuration-and-commands.md) | `LLMConfig`, `/llm`, `/pray`, `/prompt`, prompt files |
| [aigod/building.md](aigod/building.md) | `/construction` pivot, build agent, `PlaceBlock`/`PlaceLine`/`PlaceBlocks` grammar |
| [aigod/god-body.md](aigod/god-body.md) | Avatar bridge, appear math, session lock and watchdog, action queue, termination |
| [aigod/mcp-gateway.md](aigod/mcp-gateway.md) | How the God reaches the Node bot's MCP tools |
| [aigod/external-agent.md](aigod/external-agent.md) | `godAgent = external`: opencode agents, the `/pray`/`/build` trigger path, failures, setup |
| [aigod/mcp-servers.md](aigod/mcp-servers.md) | The `god`/`builder` MCP servers the mod hosts for an external agent (`:8771`, tickets, caps) |

### Eden — the AI village (`eden/`)
| File | Topic |
|---|---|
| [eden/overview.md](eden/overview.md) | What Eden is, module map, dependency law, a village day |
| [eden/process-config-and-boot.md](eden/process-config-and-boot.md) | `main.ts` composition root, every `eden.json` key, scenarios, data dir |
| [eden/types-and-contracts.md](eden/types-and-contracts.md) | Shared types, inbox/social seams, the dependency-cruiser layers |
| [eden/skills-library.md](eden/skills-library.md) | Library on disk, versions, status machine, retrieval |
| [eden/skills-engine.md](eden/skills-engine.md) | Running a skill: loop budget, canary, stall detector, abort, `ctx`, tiers |
| [eden/stock-skills.md](eden/stock-skills.md) | The 37 seeded stock skills (28 mortal, 9 divine) |
| [eden/bots-and-hardening.md](eden/bots-and-hardening.md) | Bot pool, plugins, signals, anchors, hardening, renderer |
| [eden/god.md](eden/god.md) | Critic, curriculum and orchestrator desks, the body, the refinement loop |
| [eden/llm-and-scheduling.md](eden/llm-and-scheduling.md) | LLM client, provider presets, scheduler lanes, budgets, embeddings |
| [eden/villager-runtime.md](eden/villager-runtime.md) | Events, subscriptions, roles, the brain and its 17 tools, context pack |
| [eden/villager-memory.md](eden/villager-memory.md) | Memory window and archive, retrieval scoring, world-stamp quarantine |
| [eden/social-and-trade.md](eden/social-and-trade.md) | Conversations, typed trade, the settlement client |
| [eden/journal-and-views.md](eden/journal-and-views.md) | SQLite journal, every journal kind, lag monitor, derived views |
| [eden/admin-api.md](eden/admin-api.md) | Admin REST routes and the WebSocket stream on :8770 |
| [eden/testing-eval-live.md](eden/testing-eval-live.md) | npm scripts, tests and fakes, eval dry run, live-test harness |
| [eden/java-integration.md](eden/java-integration.md) | The mod side: `:8767` settlement, `/village`, `/villagers`, op-on-join |

## Reading paths

- **"I need to change X"**: [00-overview.md](00-overview.md) → the system's doc → its *Gotchas & known issues* section → the cited source lines.
- **Operating a server**: [reference/commands.md](reference/commands.md) → [reference/ports-files-config.md](reference/ports-files-config.md) → [platform/build-and-runtime.md](platform/build-and-runtime.md).
- **Working on Eden**: [eden/overview.md](eden/overview.md) → [eden/types-and-contracts.md](eden/types-and-contracts.md) (dependency law) → the subsystem doc. Run `npm run check` in `eden/`; it passes on a clean checkout (the live-test catalogue test reads the committed `providers.example.json`), and only `npm run live-test` needs `eden/providers.json`.
- **Adding a tool for the Java God**: [aigod/tools-catalogue.md](aigod/tools-catalogue.md) (Java POJO tools) or [aigod/mcp-gateway.md](aigod/mcp-gateway.md) (Node MCP tools, which need no Java change).

## Document conventions

Every file starts with this frontmatter:

```yaml
---
id: eden.skills.engine          # stable, unique, dotted; used as the resource id
title: …
system: platform | gibber | ctf | aigod | eden | meta
summary: one sentence (≤ 200 chars)
tags: [keywords]
sources: [repo-relative files the doc was verified against]
verified_at: 98cb908             # commit the claims were checked at
---
```

The body follows the same layout in every file: `# Title` → **TL;DR** → topical `##` sections (tables for contracts,
constants and commands) → `## Gotchas & known issues` → `## Related`.

- **Citations** are written as `` `path:line` `` or `` `path:a-b` `` at `verified_at`. Paths are repo-relative, or a bare
  Java file name when it is unique in the repo.
- **`> ⚠ Unverified`** marks a claim that could not be checked against code in this checkout. That covers the Node
  bridge/MCP server (`minecraft-mcp-server/` is an empty submodule) and behaviour inside Minecraft, Fabric or library
  internals.
- French in-game strings are quoted verbatim.

## Keeping it valid

```bash
node docs/system/build-index.mjs           # validate + regenerate index.json
node docs/system/build-index.mjs --check   # validate only; non-zero exit if invalid or index.json is stale
```

The validator checks:
- required frontmatter keys and unique ids;
- that every `sources:` path exists;
- that every relative link resolves;
- that every `path:line` citation points at an existing file and a line inside it.

It **cannot** tell whether a cited line still *says* what the doc claims. After changing code, re-read the citations of
the docs that list that file in `sources:` (`grep -l <file> docs/system -r`), update them, and bump `verified_at`.

## Serving over MCP (intended design)

[index.json](index.json) is the manifest an MCP server reads. Each entry has `id`, `title`, `system`, `summary`,
`tags`, `sources`, `verified_at`, `path`, `headings` and `bytes`. A minimal server would expose:

| MCP primitive | Shape |
|---|---|
| **Resources** | one per document: URI `paulsbrawls-docs://<id>`, `mimeType: text/markdown`, name = `title`, description = `summary` |
| Tool `list_docs({system?, tag?})` | filter the manifest; return `id`, `title`, `summary` |
| Tool `search_docs({query, system?})` | keyword search over `title`, `summary`, `tags`, `headings` and the body; return ids with snippets |
| Tool `get_doc({id, section?})` | return the full markdown, or a single `##` section by heading |
| Tool `docs_for_source({path})` | reverse lookup over `sources`: "which docs describe this file?", for agents editing code |

Each file is small (roughly 150–600 lines) and has a TL;DR, so an agent can usually stop after the summary, or fetch a
single section, without loading the whole corpus.

## Related
- [00-overview.md](00-overview.md)
- [VERIFICATION-NOTES.md](VERIFICATION-NOTES.md)
