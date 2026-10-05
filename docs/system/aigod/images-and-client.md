---
id: aigod.images-and-client
title: AI God — screenshots (/prove, /build), ImagePayload, client entrypoint
system: aigod
summary: Client-side /prove and /build commands, framebuffer capture and resize, the screenshot:image C2S payload codec, server ImageReceiver routing into ChatBot.sendImageChatRequest, and ClientEntryPoint wiring.
tags: [aigod, client, screenshot, prove, build, imagepayload, imagereceiver, networking, customPayload, vision, clientEntryPoint, money]
sources: [src/client/java/com/paul/brawl/Screenshotter.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, src/main/java/com/paul/brawl/ImagePayload.java, src/main/java/com/paul/brawl/ImageReceiver.java, src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/GodSessionManager.java, src/main/resources/fabric.mod.json]
verified_at: 4a8081f
---

# AI God — screenshots, ImagePayload, client entrypoint

**TL;DR.** The client mod registers `/prove` and `/build`; after a 1 s delay it grabs the framebuffer, resizes it to
854×480, and sends `ImagePayload(bytes, "Prove : …" | "Build : …")` on channel `screenshot:image`. The server's
`ImageReceiver` routes `"Prove :"` to `godBot` (image attached, avatar claimed) and `"Build :"` to `buildBot` (image
**dropped** — `buildBot.hasImage=false`). As written, `/prove` is broken (its `executes` hangs off the wrong node) and
`/build` takes a single word or a quoted string.

## Client entrypoint

`ClientEntryPoint` (`src/client/java/com/paul/brawl/ClientEntryPoint.java`, `ClientModInitializer`, declared in
`fabric.mod.json` `entrypoints.client`):

| Call | Line | Why |
|---|---|---|
| `Screenshotter.register()` | `:9` | Commands, tick hook, executor, C2S payload type registration. |
| `Money.register()` | `:11` | Registers item `paulsbrawls:coin` (`Money.java:19-23`, `maxCount(99)`) on the client so the item id exists in the client registry (the server registers it in `ServerEntryPoint`). |

The client never calls `ChatBot.register()`; the AI God runs only on a dedicated server (see [overview.md](overview.md)).

## Client commands (`Screenshotter.java`)

| Command | Lines | Arg type | Text prefix sent |
|---|---|---|---|
| `/prove <text>` | `:46-56` | `StringArgumentType.string()` (one word, or `"quoted string"`) | `"Prove : " + text` (`:75-77`) |
| `/build <text>` | `:58-68` | `StringArgumentType.string()` | `"Build : " + text` (`:71-73`) |

These are Fabric **client** commands (`ClientCommandRegistrationCallback`), executed locally — the server never sees
the command, only the resulting payload. No permission level applies.

### `/prove` is mis-wired

```java
ClientCommandManager.literal("prove")
    .then(ClientCommandManager.argument("text", string()))   // argument node has NO executes
    .executes(context -> { var s = getString(context, "text"); ... })   // attached to the literal
```

(`Screenshotter.java:48-55`). Consequences: `/prove foo` is an incomplete command (the argument node is not
executable); bare `/prove` runs the lambda, where `getString(context, "text")` throws because the argument is absent.
Either way no screenshot is sent. `/build` (`:60-66`) nests `.executes` inside the argument correctly.

### Capture sequence

1. `sendScreenshot(text)` (`:79-93`): adds chat line `Capture d'écran dans 1 seconde`, stores `text` in a static field,
   submits a task to a single-thread executor that sleeps 1000 ms then sets static `flag = true`.
   (The delay lets the chat screen close so it is not in the capture.)
2. `START_CLIENT_TICK` hook (`:37-41`): when `flag` is set, clears it and calls `sendScreenshotAfterDelay()`.
3. `sendScreenshotAfterDelay()` (`:95-114`):
   - chat line `Capture d'écran prise, envoi à Dieu...`
   - `NativeImage nativeImage = ScreenshotRecorder.takeScreenshot(MinecraftClient.getInstance().getFramebuffer())`
   - `img2 = new NativeImage(854, 480, true)`; `nativeImage.resizeSubRectTo(0, 0, w, h, img2)` (whole frame,
     stretched to 854×480 regardless of aspect ratio)
   - `ClientPlayNetworking.send(new ImagePayload(img2.getBytes(), text))`
   - `nativeImage.close()` in `finally`; `img2` is never closed.

> ⚠ Unverified (no MC sources in checkout): `NativeImage.getBytes()` in MC 1.21.1 encodes **PNG** (via STB). The
> server nevertheless labels the data `image/jpeg` (`ChatBot.java:241`). Most vision endpoints sniff the bytes, but a
> strict provider could reject the mismatch. CLAUDE.md's "attaches the JPEG" describes the label, not the encoding.

## `ImagePayload` codec (`src/main/java/com/paul/brawl/ImagePayload.java`)

| Item | Value | Line |
|---|---|---|
| Type | `record ImagePayload(byte[] image, String text) implements CustomPayload` | `:9` |
| Channel id | `Identifier.of("screenshot", "image")` → `screenshot:image` | `:11` |
| `ID` | `new CustomPayload.Id<>(identifier)` | `:13` |
| `CODEC` | `PacketCodec.tuple(PacketCodecs.BYTE_ARRAY, image, PacketCodecs.STRING, text, ImagePayload::new)` | `:14-17` |
| Direction | C2S only — `PayloadTypeRegistry.playC2S().register(ID, CODEC)` in `ImageReceiver.commonRegister()` (`ImageReceiver.java:14-16`) | |

`commonRegister()` is invoked on the client by `Screenshotter.register()` (`Screenshotter.java:32`) and on the server
by `ChatBot.register()` (`ChatBot.java:159`). The codec sets no explicit byte-array size limit.

> ⚠ Unverified: the effective maximum payload size is whatever vanilla/Fabric API 0.116.7+1.21.1 allows for C2S custom
> payloads; a large 854×480 PNG may approach it. Not checkable here (no MC/Fabric sources).

## Server side — `ImageReceiver` (`src/main/java/com/paul/brawl/ImageReceiver.java`)

- `register()` (`:18-26`): `ServerPlayNetworking.registerGlobalReceiver(ImagePayload.ID, (data, context) -> checkProof(data.image(), context.player(), data.text()))`.
- `checkProof(bytes, player, text)` (`:28-37`):
  1. `bot = ChatBot.getCorrectChatBot(text)` (`ChatBot.java:644-651`): text contains `"Prove :"` → `godBot`;
     contains `"Build :"` → `buildBot`; otherwise → `godBot`.
  2. If `bot.needsGodTools` (godBot) and `!GodSessionManager.claim(player)` → private
     `"Dieu : (occupé ailleurs — je regarde ta preuve, mais sans forme.)"` (reply continues bodiless).
  3. `bot.sendImageChatRequest(text, bytes, player)`.
- `saveImage(bytes)` (`:39-45`) writes `proof_screen.png` in the cwd; its call is commented out (`:22`).
- Unlike `/pray`, the receiver does **not** echo the player's text back to them.

> ⚠ Unverified: Fabric API (1.21.x) invokes play-payload handlers on the server thread; the code assumes so (it calls
> `GodSessionManager.claim` and `ChatBot` entry points directly).

## Into the LLM pipeline

`ChatBot.sendImageChatRequest(input, bytes, player)` (`ChatBot.java:225-250`):

- Same bookkeeping as `/pray`: flush any pending Wait deferral, reset depth, set `sessionBound` (godBot).
- If `hasImage` (godBot): `UserMessage.from(TextContent.from(input), ImageContent.from(base64(bytes), "image/jpeg"))`.
- Else (buildBot): `UserMessage.from(input)` — **the screenshot is discarded**; `/build` is effectively a text request
  `"Build : <text>"` relative to the admin's `/construction` pivot.
- Then `doRequest` — identical to a `/pray` turn ([llm-pipeline.md](llm-pipeline.md)).

Images live in the player's token-window memory like any message and are resent on every later turn until evicted.

| Path | Bot | Image to model | Avatar claim | Tools |
|---|---|---|---|---|
| `/prove` (if fixed) | `godBot` | yes | yes | God tools + MCP + ListTools |
| `/build "<text>"` | `buildBot` | no | no | BuildPlan + ListTools + textual PlaceBlock* |

## Gotchas & known issues

- `/prove` cannot succeed as written (see above) — the quest-proof flow described in `prompt.txt` ("preuves … en
  image") is unreachable from the stock client.
- `/build` and `/prove` use `string()`, not `greedyString()`: unquoted multi-word input fails to parse.
- `/build`'s screenshot is captured, uploaded and thrown away server-side (README.md claims it sends "a screenshot of a
  site").
- `img2` (`NativeImage`, off-heap) leaks on every capture; `flag`/`text` statics are not `volatile` and a second
  capture within 1 s overwrites the first's text.
- The server accepts `ImagePayload` from any client with arbitrary text and no rate limit or size check; any modded
  client can trigger godBot turns (equivalent to `/pray`, which is perm 0 anyway).
- Image MIME label vs PNG bytes (see above).

## Related

- [llm-pipeline.md](llm-pipeline.md) · [overview.md](overview.md) · [building.md](building.md) · [god-body.md](god-body.md)
- [configuration-and-commands.md](configuration-and-commands.md)
- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md) · [../gibber/money-system.md](../gibber/money-system.md)
