# DEPRECATED — the v1 AI-Village brain is legacy

**The Node "village" brain in [`src/village/`](src/village/) (`npm run village`) is legacy.**
The from-scratch rewrite, **Eden**, is the village brain now:

- Code: [`../eden/`](../eden/) — one Node process for the ten villagers + God's desks.
- Spec / parity sign-off: [`../docs/17-parity-signoff.md`](../docs/17-parity-signoff.md).
- Agent orientation: [`../eden/CLAUDE.md`](../eden/CLAUDE.md).
- v1 design + decision log (kept for reference): [`../VILLAGE_PLAN.md`](../VILLAGE_PLAN.md).

This is a **non-destructive** deprecation (per docs/17 §5). Nothing is deleted. The
v1 brain stays runnable and in-tree until Eden passes the smoke gates **and** a soak
period; only then is traffic cut, and code removal (if ever) comes much later.

## What is deprecated

- `src/village/` — the v1 villager cognition (perception, memory, jobs, reflexes,
  bot↔bot conversation, barter).
- `npm run village` — the v1 village process (admin API on **8766**).
- The v1 supervisor protocol in [`../supervisor/SUPERVISOR.md`](../supervisor/SUPERVISOR.md)
  (now banner-marked legacy).

## What is NOT deprecated (stays as-is)

- **The Java mod** (`../src/`) — server-authority duties that Eden depends on and does
  NOT replace: the `:8767` trade-settlement listener, Gibber coins, op-on-join,
  Flag/CTF, and the AI-God prayer features. Eden is a *village-brain* rewrite, not a
  mod rewrite (docs/17 §5).
- **This repo's God-body + MCP toolkit** (`src/unified/`, `npm run unified`) — that
  drives the **Java AI-God's avatar** and exposes Mineflayer tools to that God. It is
  a *different* surface from the v1 village brain; its future is out of scope for this
  deprecation. (It still must never share a `--username` with Eden's villagers or
  avatar — docs/17 §2.)

## Coexistence rule (docs/17 §2 — R12)

v1 stays runnable (`npm run village`) until Eden reaches parity; the two must **never
share bot usernames**. Eden's production avatar is **`Dieu`** (never v1's `LLMBot` /
`GodBot`); Eden villagers use the French roster names in `eden.json`.

## op-on-join → `Dieu` (doc-level note)

At cut-over, the Java mod should op only Eden's avatar **`Dieu`** on join (the mod keys
op-on-join on a single configured username — `BridgeConfig.botUsername`). This is a
**configuration/doc-level** note: no Java behavior is changed here.
