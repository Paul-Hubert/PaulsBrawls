# 06 — Future extensions

None of this ships in Eden v0. Each section names the seam that already exists in
the v0 design and what gets built on it later. The discipline: **v0 pays for
interfaces, not features** (P7).

## The skill economy

(Owner: "exploring skill sharing and developing new skills and then sharing them
with other villagers, maybe paying for them or working for them in exchange…
interesting, but let's leave that as a future possibility. It would be great if the
architecture supported that transition easily.")

The economy reframes the library from "global commons" to "market of capabilities"
without touching the engine:

- **The seam is `GrantPolicy`** ([02 §Access control](02-skill-system.md#access-control-the-economy-seam)):
  every retrieval and every `skills.run` already consults `canRetrieve` /
  `canRun`. Swap `AllGranted` for `LedgerGrants` and skills become ownable.
- **Authorship is already tracked** (`SkillVersion.author`, admission provenance).
  A villager who authored an admitted skill is its natural first owner; God-
  and stock-authored skills stay commons.
- **Payment rails already exist**: Gibber `coin` + the atomic settlement listener.
  A skill sale is a trade where one side is a `SkillGrant` instead of items — the
  typed-offer schema grows one variant:

  ```ts
  type OfferSide = { items: Stack[] } | { grant: { skill: string; terms: 'perpetual' | 'uses:N' } }
  ```

  Settlement validates grants Node-side (the Java listener still only swaps items
  and coins; grants are Eden-internal state, journaled `trade.settled` with the
  grant in refs).
- **Work-for-skill** is a directive pattern, not a mechanism: a conversation
  concludes with a brokered deal ("harvest my field for three days, then I teach
  you `bake-bread`"), representable as a standing directive + a deferred grant.
  The orchestrator can broker; the journal arbitrates disputes.
- **Teaching as theater**: granting can require co-presence (the seller
  demonstrates the skill while the buyer watches — both bots run it, God's avatar
  optionally officiates). Pure flavor, pure journal/website gold.

Design caution recorded now: per-villager grants reintroduce exactly the silo
problem Eden was built to kill. The default posture should stay generous (commons
by default, premium skills the exception), and God's curriculum desk should be
allowed to "nationalize" (buy out) skills that village survival depends on.

## Per-villager proficiency

The same library skill can run differently per villager: success-rate and speed
modifiers derived from each villager's run history with that tag (the dossier
`competence` map already accumulates it). A farmer's `harvest-field` runs clean;
the guard's version fumbles (engine-injected delay/failure chance). Makes roles
*earned* rather than declared, and gives the economy its scarcity (you pay for the
skill AND the practice). Seam: `RunReport` already records villager × skill ×
outcome; the modifier is one function in the engine.

## Multi-village / multi-God

The library is keyed by God; the config already nests villagers under one god
entry. A second village = a second Eden process with its own god name, journal, and
library, sharing only the Minecraft server and the settlement listener.
Inter-village trade/war/diplomacy = conversations and trades between bots of
different processes — the in-world protocol (chat, proximity) needs nothing new.
Skill exchange *between* libraries would go through the economy mechanics (a grant
crossing god-boundaries is an export). No v0 cost beyond not hardcoding a single
global god identity, which D-06's `GodState` already avoids.

## The website

([05](05-observability.md) is the contract.) A separate front-end project consuming
the admin REST + WebSocket stream — views *and* controls; the website is **not
read-only**. Page sketch, to keep the API honest:

- **Village live** — map view from `vitals` (positions, current runs as labels),
  chat ticker, directive arrows (who was just ordered where).
- **Villager page** — dossier, memory highlights, subscriptions, inbox, run
  history, relations graph — and a **prompt box**: type a message, it lands as
  `POST /villagers/:name/prompt` → `inbox` event, the villager hears it like a
  tell and deliberates. Talking to a villager from the browser costs the
  architecture nothing; the event system already does all the work.
- **Skill page** — manifest, code with version diffs, stats sparkline, provenance
  ("admitted after rollout #…, critique trail"), call-graph (who composes me).
- **God page** — ledger frontier (completed/failed), open tickets, verdict feed
  with critiques, budget burn.
- **Rollout replay** — the `refs.rolloutId` query rendered as a timeline:
  task → draft → run → verdict → revision → admission. The single highest-value
  view, and it falls straight out of the journal design — no extra server work.
- **Controls** — every interactive element maps 1:1 to an admin POST verb
  (villager prompt, pause/resume, skill quarantine) and is journaled before it
  acts, so the dashboard's own pokes appear in its own ticker. A control idea
  that has no verb is an API gap to fix in [05](05-observability.md), never
  website-side cleverness.

When it goes beyond localhost: token auth flag on the admin server; the POST
verbs are what the token gates — unauthenticated sessions degrade to the
read-only views.

## Player-facing integration

- `/pray` and the Java God: once Eden is stable, the Java `ChatBot` God can be
  retired and `/pray` forwarded to Eden's God (orchestrator desk treats a prayer
  as a player-sourced ticket; the body answers in-world). One God, finally.
- `/village`-style command grows Eden subcommands (status, pause, quarantine) by
  proxying the admin API — Java stays a dumb forwarder.

## Voice

The vendored MCP server's original SVC (Simple Voice Chat) goal — villagers that
hear and speak proximity voice — would slot in as: STT transcript → normalized
`player-chat`-like event (`player-voice`), TTS on `say` when a player is in
earshot. The event system and context packs need zero changes; it is an emitter
and an effector. Noted so nobody designs against it.
