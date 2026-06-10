# Higher-level tools for natural NPC behaviour

A wishlist of tools to sit *above* the current 22 MCP primitives in
[minecraft-mcp-server/src/tools/](minecraft-mcp-server/src/tools/), the bridge
vocabulary in [bridge/actions.ts](minecraft-mcp-server/src/bridge/actions.ts),
and the Java god-side tools in
[ChatBotFunctions.java](src/main/java/com/paul/brawl/ChatBotFunctions.java).

The current toolkit is overwhelmingly **single-shot primitives**: place-one-block,
find-one-entity, walk-to-one-coord, send-one-message. That works for "do X now"
but it's the wrong altitude for **natural** NPC behaviour — natural NPCs
*persist intent, react to events, and embody social presence*.

Tools are grouped by behavioural capability. Each entry: name → what it
composes → why it matters for naturalness.

---

## 1. Perception subscriptions (the biggest gap)

The model is blind between turns. To react, it has to poll — which it almost
never will because every poll burns a tool round-trip. A natural NPC notices
things and reacts mid-action.

| Tool | Composes | Why |
|---|---|---|
| `subscribe-events` | Mineflayer's already-emitted events: `playerJoined`/`Left`, `chat`, `entityHurt`, `entitySpawn`, `playerCollect`, `blockUpdate`, `weatherChange`, `time`, `death`, `health` | Generalises the chat [`MessageStore`](minecraft-mcp-server/src/message-store.ts) pattern into named channels the model subscribes to and drains via `read-events <channel> <since-id>`. |
| `watch-player <name>` | bot events filtered to one player | "Tell me when this player takes damage / picks something up / changes held item / starts sneaking". Makes the god/NPC look perceptive without burning tokens. |
| `proximity-trigger <radius> <event>` | `entitySpawn` + distance filter | Reflex hook: "if a hostile mob enters 10 blocks, surface a `threat` event before the next turn". |

Plumbing exists — [`MessageStore`](minecraft-mcp-server/src/message-store.ts) is
the template. Bigger lift is **flushing pending events into the next prayer
turn's system message** (or auto-firing a "you just noticed X" turn) so the
model actually reads them.

## 2. Stateful behaviour modes (not one-shot moves)

Every walk is `move-to-position` → completes → returns → done. Natural NPCs
**maintain ongoing intent**. These should run as background behaviours with
priorities, so reactions can preempt them.

| Tool | Composes | Why |
|---|---|---|
| `follow-entity <name> <distance>` | pathfinder's `GoalFollow` (already in `mineflayer-pathfinder`) | The classic. Single call, persists until cancelled. Native pathfinder support — no loop logic needed. |
| `patrol <waypoints[]> <mode>` | repeated `GoalNear` cycling through points | "Walk this perimeter forever." Mode = loop / pingpong / once. |
| `guard-area <center> <radius>` | sleep + react-to-threat | Stand here, look around occasionally, attack hostiles that enter. |
| `wander <home> <radius>` | random `GoalNear` every N seconds with `lookAt` interludes | Villager-style ambient motion. Makes a bot feel "at home" instead of being a statue. |
| `stop-behavior` / `behavior-status` | drops the current goal | Required companion — the model has to be able to interrupt itself when its situation changes. |

`mineflayer-statemachine` already implements the behaviour-tree machinery and
is the standard plugin. Wrapping its `BehaviorFollowEntity` / `BehaviorIdle` /
`BehaviorMoveTo` / `BehaviorLookAtEntity` as MCP tools is a few hundred lines.

## 3. Speech with social context

`send-chat` puts a message in global chat. That's the *only* speech the bot has.

| Tool | Composes | Why |
|---|---|---|
| `say-to <player> <message>` | `bot.whisper(player, msg)` (`/msg` under the hood) | Whisper. Private conversation without spamming the server. |
| `say-nearby <message> <radius>` | iterate players within radius, whisper each | Proximity speech — feels like the NPC has a normal voice instead of a megaphone. Or: integrate Simple Voice Chat per the original upstream goal — see [minecraft-mcp-server/CLAUDE.md](minecraft-mcp-server/CLAUDE.md) §"Simple Voice Chat integration notes". |
| `narrate <action>` | emote-style chat with formatting like `* LLMBot waves *` | Single highest-bang-for-buck naturalness trick. Pure-text emotes carry presence. |
| `write-sign <pos> <lines[]>` / `write-book <title> <pages>` | open the block/item GUI | Asynchronous communication — leave notes, write a journal, mark territory. Fits the god persona ("commandments inscribed on stone"). |

Pair with `listen-radius` + `subscribe-events chat` — only surface chat
messages spoken near the bot, not the whole server.

## 4. Gaze, posture, body language

[`gesture()`](minecraft-mcp-server/src/bridge/actions.ts:100) has 5 gestures
(`swing`/`jump`/`sneak`/`nod`/`summon`). That's the entire body-language
vocabulary.

| Tool | Composes | Why |
|---|---|---|
| `look-at-entity <name> [duration]` | `bot.lookAt(entity.position)` on a tick interval | Eye contact — the single most "alive" signal a model can emit. Should auto-track a moving target, not freeze on a coordinate. |
| `look-around` | randomised `lookAt` to nearby points of interest every few seconds | Idle gaze. Stops the bot looking frozen when not actively doing something. |
| `face <yaw, pitch>` or `face-direction <cardinal>` | absolute orientation | Stage direction — "stand at the altar facing north". |
| `point-at <pos>` / `wave` / `shrug` / `bow` / `crouch-and-mine-pretend` | sequenced control-state + lookAt combos | A real gesture library, not 5 gestures. Each one's a few setControlState calls. |
| `equip-cosmetic <slot> <item>` | `bot.equip` to head/chest/legs/feet/offhand without combat side effects | Costume changes carry meaning — robe for "god mode", torch in off-hand for "I see you in the dark". |

Gaze should be **a persistent background behaviour** ("keep looking at Paul
while you do other stuff"), not a one-shot tool call.

## 5. Semantic navigation (not just A* to coords)

Natural NPCs navigate human-built spaces, not coordinate grids.

| Tool | Composes | Why |
|---|---|---|
| `go-to-player <name> [distance]` | nearest-entity lookup + `GoalFollow` once | Compresses find-then-move into one intention. Model writes "go to Paul" instead of "find-entity player paul, parse coords, move-to-position". |
| `go-to-block <name> [maxDistance]` | `find-blocks` + `move-to-position` | Same compression for "go to the nearest crafting table / bed / altar". |
| `enter-structure <tag>` / `leave-structure` | find door blocks, path through them | Doors and trapdoors are pathfinder hazards today. A goal that explicitly opens doors makes indoor movement work. |
| `flee-from <entity> <distance>` | inverted `GoalFollow` / `GoalInvert` | Reaction primitive — couples with the threat events from §1. |
| `sit-on <block>` / `lean-against <block>` | small offset positioning + posture | Body in repose. Villagers do this for beds. |

## 6. Routines and schedules

Villagers have schedules; that's why they feel like inhabitants. For the AI god
you'd want it to *do something* between prayers instead of vanishing — wander a
shrine, smite a goat at sunset, etc.

| Tool | Composes | Why |
|---|---|---|
| `set-routine <events[]>` | server-tick scheduler keyed off `bot.time.timeOfDay` | "Wake at dawn, work the field 6000–11000, return to the shrine 11000–13000, idle until prayer." |
| `at-time <ticks> <behavior>` / `every-n-ticks <n> <behavior>` | cron-ish primitive | Composable scheduling. The existing [`GodScheduler`](src/main/java/com/paul/brawl/GodScheduler.java) on the Java side is the same idea — could be exposed as a bot-side primitive too. |
| `set-mood <mood>` | a tag the system prompt reads each turn | Behaviour modulator — angry god walks faster, idle god wanders more. |

## 7. Identity & memory (Java-side, not MCP)

The 40-message chat window in
[`ChatBot.memories`](src/main/java/com/paul/brawl/ChatBot.java) is too short
for "this NPC remembers you owe him 3 emeralds from yesterday". Add tools the
model itself calls to write durable facts:

| Tool | Composes | Why |
|---|---|---|
| `remember <key> <value>` / `recall <key>` / `forget <key>` | a per-player NBT store in [`PlayerPersistentState`](src/main/java/com/paul/brawl/PlayerPersistentState.java) | Lets the god jot facts ("Paul is a heretic", "Léa offered 2 gold yesterday") that survive across `/pray stop` and server restarts. Persistence layer already exists — just need the model-facing tool. |
| `relationship <player> <delta>` | bounded -100..+100 scalar per player | Cheap proxy for "how does the god feel about you". Drives system-prompt context. |
| `note-location <name> <pos>` | named bookmarks | "the altar", "Paul's house" — semantic place names, not coordinates the model has to memorise. |

## 8. Self-preservation primitives (ecosystem plugins)

These already exist as Mineflayer plugins and just need to be loaded into
[bot-connection.ts](minecraft-mcp-server/src/bot-connection.ts) and
exposed:

- **`mineflayer-auto-eat`** ✅ done — eat from inventory when hunger drops. Loaded post-spawn with default options (see [bot-connection.ts](minecraft-mcp-server/src/bot-connection.ts)); no MCP tool, runs autonomously.
- **`mineflayer-pvp`** ✅ done — `attack(entity)`, `stop()`. Exposed as `attack-entity` and `stop-combat` in [combat-tools.ts](minecraft-mcp-server/src/tools/combat-tools.ts).
- **`mineflayer-armor-manager`** ✅ done — auto-equip best armour. Loaded post-spawn; no MCP tool, listens to `playerCollect` events autonomously.
- **`mineflayer-collectblock`** ✅ done — `collectBlock(type, count)`. Exposed as `collect-block` in [collection-tools.ts](minecraft-mcp-server/src/tools/collection-tools.ts).
- **`mineflayer-tool`** ✅ done — auto-pick best tool for the block being dug. No new tool; inlined into the existing `dig-block` handler in [block-tools.ts](minecraft-mcp-server/src/tools/block-tools.ts) before `bot.dig`.
- **`mineflayer-cmd`** — structured slash-command parsing on incoming chat. Cleaner than the regex scan currently in [`ChatBotFunctions`](src/main/java/com/paul/brawl/ChatBotFunctions.java).

Each is ~one tool registration and removes a category of token-burning busywork.

---

## Structural pieces (plumbing, not tools)

Everything above depends on these:

1. **Push events into the next turn's context.** A subscription is useless if the model never reads it. Add a "pending notifications" block to [`ChatBot.buildMessageList`](src/main/java/com/paul/brawl/ChatBot.java) the same way the world snapshot is prepended, and consider auto-firing an inference turn when high-priority events arrive (threat, prayer, named player joined).
2. **Behaviour priority stack** — a follow-player goal should yield to a flee-from-zombie goal, then resume. `mineflayer-statemachine` gives you this for free.
3. **Cancellable, interruptible tools** — `move-to-position` already supports timeout ([position-tools.ts:36](minecraft-mcp-server/src/tools/position-tools.ts:36)) but no other tool does. A standard `cancel-current-action` is required for reactivity.
4. **Concurrent tool execution** — the LLM dispatch in [`ChatBot.checkForFunctions`](src/main/java/com/paul/brawl/ChatBot.java) appears to serialise. Walking AND looking-at-speaker AND chatting in parallel is what makes a body feel embodied; serialising them produces stilted "first I walked, then I looked, then I spoke" choreography.

---

## Top 5 by bang-for-buck

In order of "feels like a person, not a tool-caller":

1. **`subscribe-events` + push-into-next-turn** — without perception, nothing else matters.
2. **`follow-entity` / `look-at-entity` as persistent background behaviours** — eye contact + tracking is the cheapest naturalness win in the entire list.
3. **`narrate`** — emote-style speech (`* the god raises his hand *`). One tool, huge presence dividend.
4. **`mineflayer-statemachine` integration** — gives you behaviour priorities, cancellation, and the right vocabulary in one package.
5. **`remember` / `recall`** on top of [`PlayerPersistentState`](src/main/java/com/paul/brawl/PlayerPersistentState.java) — durable per-player memory beyond the 40-message window.
