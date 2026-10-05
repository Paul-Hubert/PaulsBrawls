---
id: aigod.images-and-client
title: AI God — screenshots (/prove, /build), ImagePayload, client entrypoint
system: aigod
summary: Client /prove and /build, framebuffer capture + resize, the screenshot:image C2S payload, ImageReceiver routing into ChatBot.sendImageChatRequest, ClientEntryPoint wiring.
tags: [aigod, client, screenshot, prove, build, imagepayload, imagereceiver, networking, customPayload, vision, clientEntryPoint, money]
sources: [src/client/java/com/paul/brawl/Screenshotter.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, src/main/java/com/paul/brawl/ImagePayload.java, src/main/java/com/paul/brawl/ImageReceiver.java, src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/GodSessionManager.java, src/main/resources/fabric.mod.json]
verified_at: 4a8081f
---

# AI God — screenshots, ImagePayload, client entrypoint

**TL;DR.** The client mod registers `/prove` and `/build`; after a 1 s delay it grabs the framebuffer, resizes it to
854×480, and sends `ImagePayload(bytes, "Prove : …" | "Build : …")` on channel `screenshot:image`. The server's
`ImageReceiver` routes `"Prove :"` to `godBot` (avatar claimed) and `"Build :"` to `buildBot`; both now attach the image,
labelled with its sniffed type (`image/png` for the client's bytes). Bug #9 is fixed: `/prove` runs (its `executes` sits
on the argument) and both commands take the rest of the line (`greedyString()`).

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
| `/prove <text>` | `registerCommands` | `StringArgumentType.greedyString()` (the rest of the line) | `"Prove : " + text` |
| `/build <text>` | `registerCommands` | `StringArgumentType.greedyString()` | `"Build : " + text` |

These are Fabric **client** commands (`ClientCommandRegistrationCallback`), executed locally — the server never sees
the command, only the resulting payload. No permission level applies.

### `/prove` was mis-wired (bug #9, fixed)

The `.executes(...)` used to hang off the `prove` literal instead of the `text` argument, so `/prove foo` was an
incomplete command and bare `/prove` threw on `getString(context, "text")`. Both commands now nest `.executes` inside
`argument("text", greedyString())`; a bare `/prove` or `/build` is an incomplete command (Brigadier's usual error).

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
   - `nativeImage.close()` and `img2.close()` in `finally` (img2 used to leak).

> ⚠ Unverified (no MC sources in checkout): `NativeImage.getBytes()` in MC 1.21.1 encodes **PNG** (via STB). The
> server no longer assumes: `ImageMime.sniff(bytes)` reads the magic number (PNG / JPEG / GIF / WebP, default
> `image/png`) and `ChatBot` labels the `ImageContent` with it (bug #9; `ImageMimeTest`).

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
- If `hasImage` (both `godBot` and, since bug #9, `buildBot`): `UserMessage.from(TextContent.from(input),
  ImageContent.from(base64(bytes), ImageMime.sniff(bytes)))`.
- Else: `UserMessage.from(input)` (no stock bot sets `hasImage=false` any more; `BuildSubAgent` is not a `ChatBot`).
- Then `doRequest` — identical to a `/pray` turn ([llm-pipeline.md](llm-pipeline.md)).

Images live in the player's token-window memory like any message and are resent on every later turn until evicted.

| Path | Bot | Image to model | Avatar claim | Tools |
|---|---|---|---|---|
| `/prove <text>` | `godBot` | yes | yes | God tools + MCP + ListTools |
| `/build <text>` | `buildBot` | yes | no | BuildPlan + ListTools + textual PlaceBlock* |

## Gotchas & known issues

- ~~`/prove` cannot run; `string()` args; `/build`'s screenshot thrown away; `img2` leaks~~ **Fixed (bug #9).** Only an
  in-game check proves the command tree and the upload (the MIME sniffing is unit-tested).
- `flag`/`text` statics are not `volatile` and a second capture within 1 s overwrites the first's text.
- The server accepts `ImagePayload` from any client with arbitrary text and no rate limit or size check; any modded
  client can trigger godBot turns (equivalent to `/pray`, which is perm 0 anyway).
- ~~Image MIME label vs PNG bytes~~ fixed (sniffed, see above).

## Related

- [llm-pipeline.md](llm-pipeline.md) · [overview.md](overview.md) · [building.md](building.md) · [god-body.md](god-body.md)
- [configuration-and-commands.md](configuration-and-commands.md)
- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md) · [../gibber/money-system.md](../gibber/money-system.md)
