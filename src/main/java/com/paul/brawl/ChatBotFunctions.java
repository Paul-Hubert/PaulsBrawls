package com.paul.brawl;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ScheduledFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.response.ChatResponse;

import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.MathHelper;

public class ChatBotFunctions {

    private static final Logger LOGGER = LoggerFactory.getLogger("ChatBotFunctions");

    /**
     * Single Jackson mapper for parsing {@link ToolExecutionRequest#arguments()} JSON
     * into the tool POJOs. Lenient on unknowns so the model can include extra fields
     * without crashing the dispatch.
     */
    private static final ObjectMapper MAPPER = new ObjectMapper()
        .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    @JsonClassDescription("Gives a reward to the player in the form of an item.")
    static class Reward {
        @JsonPropertyDescription("The name of the item to give. Examples: minecraft:diamond, minecraft:enchanted_book[minecraft:enchantments={mending: 1, sharpness: 4, unbreaking: 3}]")
        public String itemName;
        @JsonPropertyDescription("The number of items to give.")
        public int amount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.giveItemFromString(player, itemName, amount);
        }
    }

    @JsonClassDescription("Offers a trade to the player.")
    static class Trade {
        @JsonPropertyDescription("The name of the item to give to the player in the trade. Example: minecraft:diamond")
        public String giveItemName;
        @JsonPropertyDescription("The number of items to give to the player in the trade.")
        public int giveAmount;

        @JsonPropertyDescription("The name of the item to take from the player in the trade. Example: minecraft:diamond")
        public String takeItemName;
        @JsonPropertyDescription("The number of items to take from the player in the trade.")
        public int takeAmount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.sendTradeOffer(player, giveItemName, giveAmount, takeItemName, takeAmount);
        }
    }

    @JsonClassDescription("Punishes the player by inflicting a number of punishments.")
    static class Punishment {
        @JsonPropertyDescription("The number of punishments to inflict to the player.")
        public int amount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.smite(player, amount);
        }
    }

    @JsonClassDescription("Changes the weather of the player's world.")
    static class ChangeWeather {
        @JsonPropertyDescription("Type of weather to set. Examples: clear, rain, thunder")
        public String weatherType;
        @JsonPropertyDescription("Weather duration in seconds. 0 for permanent.")
        public int durationSeconds;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.changeWeather(player, weatherType, durationSeconds);
        }
    }

    @JsonClassDescription("Manifest God's physical body in front of the praying player. Call this when you choose to appear before acting or speaking. Use sparingly — appearing is dramatic. Optional fields default to 3 blocks ahead at ground level, facing the player.")
    static class Appear {
        @OptionalField
        @JsonPropertyDescription("Blocks in front of the player to appear (default 3). Clamped server-side (typically 1..6).")
        public Double distance;
        @OptionalField
        @JsonPropertyDescription("Vertical offset above the player's feet (default 0 = same level; positive to float).")
        public Double height;
        @OptionalField
        @JsonPropertyDescription("Whether to turn and face the player after appearing (default true).")
        public Boolean lookAtPlayer;

        public String execute(ServerPlayerEntity player) {
            BridgeConfig cfg = BridgeConfig.INSTANCE;
            double d = (distance == null ? 3.0 : distance);
            double h = (height   == null ? 0.0 : height);
            boolean face = (lookAtPlayer == null || lookAtPlayer);
            d = MathHelper.clamp(d, cfg.appearMinDistance, cfg.appearMaxDistance);
            h = MathHelper.clamp(h, cfg.appearMinHeight,   cfg.appearMaxHeight);
            GodBody.appear(player, d, h, face);                         // bridge, off-thread
            GodActionQueue.submit(() -> ChatBotActions.buffAvatar(player));  // main thread
            GodSessionManager.markManifested();
            GodSessionManager.resetIdleTimer(player);
            return "God a pris forme physique devant le joueur.";
        }
    }

    @JsonClassDescription("Send God's physical body away. Call this to disappear deliberately when the encounter is over. Optional — if you stop calling tools the body vanishes automatically.")
    static class Vanish {
        public String execute(ServerPlayerEntity player) {
            GodActionQueue.submit(() -> ChatBotActions.restoreAvatar(player));
            GodBody.vanish();
            return "God a disparu.";
        }
    }

    @JsonClassDescription("Pause before you act again. You will only be called back after the given number of seconds — use this to linger, build suspense, or let an effect land before reacting. Clamped server-side (typically 1..30).")
    static class Wait {
        @JsonPropertyDescription("Seconds to wait before continuing.")
        public int seconds;

        public String execute(ServerPlayerEntity player) {
            BridgeConfig cfg = BridgeConfig.INSTANCE;
            int clamped = Math.max(cfg.waitMinSeconds, Math.min(seconds, cfg.waitMaxSeconds));
            return "Le temps passe… " + clamped + " seconde(s) se sont écoulées.";
        }
    }

    @JsonClassDescription("Spawns one or more creatures near the player. Use sparingly. Counts above the admin-configured cap are clamped silently.")
    static class SpawnCreature {
        @JsonPropertyDescription("Entity id, e.g. minecraft:zombie, minecraft:cow, minecraft:wolf")
        public String entityType;
        @JsonPropertyDescription("How many to spawn (clamped server-side).")
        public int count;
        @JsonPropertyDescription("Block offset from the player on the X axis (east+/west-).")
        public int x;
        @JsonPropertyDescription("Block offset from the player on the Y axis (up+/down-).")
        public int y;
        @JsonPropertyDescription("Block offset from the player on the Z axis (south+/north-).")
        public int z;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.spawnCreature(player, entityType, count, x, y, z);
        }
    }

    @JsonClassDescription("One isolated build job inside a BuildPlan. Each SubBuild becomes its own sub-agent with its own anchor pivot and its own chat history — it does NOT see the other SubBuilds, only its own description, style, size, and purpose. Coordinates are integer block offsets from the admin's /construction pivot.")
    public static class SubBuild {
        @JsonPropertyDescription("Offset on the X axis (east+, west-) from the admin's /construction pivot. The sub-agent treats this point as its local origin (0,0,0). Pick values that put sub-builds at least 8 blocks apart so they do not overlap.")
        public int anchorX;
        @JsonPropertyDescription("Offset on the Y axis (up+, down-) from the admin's /construction pivot. Usually 0 to keep sub-builds on the same ground level, positive for floating structures, negative for cellars.")
        public int anchorY;
        @JsonPropertyDescription("Offset on the Z axis (south+, north-) from the admin's /construction pivot.")
        public int anchorZ;
        @JsonPropertyDescription("Full natural-language description of what to build at this anchor. Be specific about footprint dimensions, materials, openings, defining features. The sub-agent sees ONLY this description (plus style, size, purpose) — no other context, so do not refer to the player or the rest of the plan here.")
        public String description;
        @JsonPropertyDescription("Architectural style for this sub-build. Examples: medieval-stone, japanese-pagoda, modern-glass-and-concrete, rustic-log-cabin, desert-adobe, nordic-longhouse, sandstone-temple, brutalist-bunker.")
        public String style;
        @JsonPropertyDescription("Rough footprint and height. Either a label (small / medium / large) or explicit dimensions like 8x8x12 (X by Z by Y in blocks). Stay under ~32 blocks per axis.")
        public String size;
        @JsonPropertyDescription("Functional purpose — what is this structure for? Used by the sub-agent to pick interior furniture and detailing. Examples: dwelling, watchtower, well, market stall, smithy, granary, shrine, statue, bridge, gatehouse, decorative ruin.")
        public String purpose;
    }

    @JsonClassDescription("Plans a multi-structure build by dispatching N independent sub-builds in parallel, each at its own anchor offset relative to the admin's /construction pivot. Use this whenever the player's request implies more than one structure (village, fortified compound, farm with outbuildings, town square, harbour, etc.). Each sub-build runs in its own isolated agent that sees only its own description, style, size, and purpose — they cannot coordinate, so make each one self-contained. After each sub-agent finishes its initial structure, it automatically gets follow-up refinement passes (gap-fix, interior, exterior, roof/walls-under-roof, final). Returns a confirmation string; the actual builds run asynchronously.")
    static class BuildPlan {
        @JsonPropertyDescription("The list of independent sub-builds. Each becomes a separate isolated sub-agent. Order does not matter — they all run in parallel.")
        public java.util.List<SubBuild> builds;

        public String execute(ServerPlayerEntity player) {
            net.minecraft.util.math.BlockPos basePivot = Raycaster.getLastPos(player.getUuid());
            if (basePivot == null) {
                return "Aucun point de référence : l'admin doit lancer /construction avant d'utiliser BuildPlan.";
            }
            if (builds == null || builds.isEmpty()) {
                return "BuildPlan reçu sans aucun sous-build — rien à faire.";
            }
            if (ChatBot.buildBot == null) {
                LOGGER.warn("BuildPlan invoked but ChatBot.buildBot is null — register() must run before BuildPlan can dispatch sub-agents.");
                return "Erreur interne : buildBot non initialisé. Impossible de lancer les sous-constructions.";
            }

            // Filter nulls upfront so labels (i/n) match what we actually spawn.
            java.util.List<SubBuild> live = new java.util.ArrayList<>(builds.size());
            for (SubBuild sb : builds) {
                if (sb != null) live.add(sb);
            }
            if (live.isEmpty()) {
                return "BuildPlan ne contenait que des sous-builds nuls — rien à faire.";
            }

            int n = live.size();
            for (int i = 0; i < n; i++) {
                SubBuild sb = live.get(i);

                net.minecraft.util.math.BlockPos subPivot =
                    basePivot.add(sb.anchorX, sb.anchorY, sb.anchorZ);

                String label = (i + 1) + "/" + n + " " + safe(sb.purpose, "structure");

                String systemPrompt = ChatBot.buildBot.hardcodedPrompt
                    + "\n" + ChatBot.buildBot.prompt
                    + "\n\n# Sub-build assignment\n"
                    + "You are one of " + n + " parallel sub-agents in a BuildPlan. You can NOT see the others. "
                    + "Build exactly one thing — described below — at integer offsets from your own pivot (0,0,0). "
                    + "You will get follow-up refinement messages after each pass that tell you to fix blind spots, "
                    + "do interior, exterior, roof and walls-under-roof, replace glass panes with full glass blocks, etc. "
                    + "Respond to each pass with PlaceBlock / PlaceLine / PlaceBlocks lines, then reply with zero call lines "
                    + "to signal that pass is finished and receive the next refinement.";

                String initialUser =
                    "Sub-build " + label + ".\n"
                    + "Purpose: " + safe(sb.purpose, "(unspecified)") + "\n"
                    + "Style: " + safe(sb.style, "(unspecified)") + "\n"
                    + "Size: " + safe(sb.size, "(unspecified)") + "\n\n"
                    + "Description:\n" + safe(sb.description, "(no description)") + "\n\n"
                    + "Pass 1 — primary structure. Build the floor, walls, and roof in that order. "
                    + "Emit PlaceBlock / PlaceLine / PlaceBlocks lines. When this pass is done, reply with no call lines "
                    + "and the next refinement pass will be sent automatically.";

                BuildSubAgent agent = new BuildSubAgent(
                    player,
                    subPivot,
                    systemPrompt,
                    initialUser,
                    label,
                    BuildSubAgent.DEFAULT_REFINEMENTS
                );
                agent.start();
            }

            return "Plan accepté : " + n + " sous-construction(s) lancée(s) en parallèle. "
                 + "Chaque sous-agent fera ~" + (1 + BuildSubAgent.DEFAULT_REFINEMENTS.size()) + " passes (initiale + refinements).";
        }

        private static String safe(String s, String fallback) {
            return (s == null || s.isBlank()) ? fallback : s;
        }
    }

    /**
     * Builds the set of {@link ToolSpecification}s the active ChatBot should attach
     * to its {@link dev.langchain4j.model.chat.request.ChatRequest}. Replaces the
     * old {@code registerGodTools} / {@code registerBuildPlanTool} pair that mutated
     * an OpenAI-SDK request builder. The {@code PlaceBlock} / {@code PlaceLine} /
     * {@code PlaceBlocks} text scanner is unchanged and is not registered as a tool —
     * it parses the model's textual output, not tool calls.
     *
     * <p>When {@code needsMcpTools} is true, the tools exposed by the local
     * {@code minecraft-mcp-server} subprocess (see {@link MCPGateway}) are appended
     * to the end of the list. Bring-up is lazy — the first call triggers the
     * subprocess spawn, later calls reuse the cached specs. If the gateway is
     * disabled or failed to start, this contributes nothing.</p>
     */
    public static List<ToolSpecification> buildToolSpecs(boolean needsGodTools, boolean needsBuildPlan, boolean needsMcpTools) {
        List<ToolSpecification> tools = new ArrayList<>();
        if (needsGodTools) {
            tools.add(JsonSchemaAdapter.toolSpec(Reward.class));
            tools.add(JsonSchemaAdapter.toolSpec(Trade.class));
            tools.add(JsonSchemaAdapter.toolSpec(Punishment.class));
            tools.add(JsonSchemaAdapter.toolSpec(ChangeWeather.class));
            tools.add(JsonSchemaAdapter.toolSpec(SpawnCreature.class));
            tools.add(JsonSchemaAdapter.toolSpec(Appear.class));
            tools.add(JsonSchemaAdapter.toolSpec(Vanish.class));
            tools.add(JsonSchemaAdapter.toolSpec(Wait.class));
        }
        if (needsBuildPlan) {
            tools.add(JsonSchemaAdapter.toolSpec(BuildPlan.class));
        }
        if (needsMcpTools) {
            tools.addAll(MCPGateway.INSTANCE.tools());
        }
        return tools;
    }

    /** Legacy 2-arg overload kept so external callers (and any reflective use) still
     *  compile after Mineflayer-MCP wiring landed. New code should pass the third arg. */
    public static List<ToolSpecification> buildToolSpecs(boolean needsGodTools, boolean needsBuildPlan) {
        return buildToolSpecs(needsGodTools, needsBuildPlan, false);
    }

    /** Pairs the original tool-call request with the JSON string we send back as its result. */
    public record FunctionResult(ToolExecutionRequest call, String result) {}

    public static boolean checkForFunctions(ChatResponse r, ServerPlayerEntity player, ChatBot chatBot) {
        AiMessage aiMessage = (r == null) ? null : r.aiMessage();
        if (aiMessage == null || !aiMessage.hasToolExecutionRequests()) return false;

        List<ToolExecutionRequest> requests = aiMessage.toolExecutionRequests();
        List<FunctionResult> results = new ArrayList<>();
        int waitSeconds = 0;
        for (ToolExecutionRequest req : requests) {
            String ret = executeFunction(req, player);
            results.add(new FunctionResult(req, ret));
            if ("Wait".equals(req.name())) {
                // Multiple Waits in one batch: take the longest (more dramatic
                // than summing, and we already executed every non-Wait now).
                int s = extractWaitSeconds(req);
                if (s > waitSeconds) waitSeconds = s;
            }
        }
        if (results.isEmpty()) return false;

        // Body choreography for the tools that just ran — best-effort, off-thread.
        fireGestures(requests, player, results);

        LOGGER.info("Submitting {} function call output(s) for player {} (waitSeconds={})",
            results.size(), player.getName().getString(), waitSeconds);

        if (waitSeconds > 0) {
            // Defer the next LLM call by N seconds; the body sits still until then.
            // GodScheduler runs the task on its own thread — sendFunctionOutputs
            // is safe to call there, it only mutates per-player ChatMemory and
            // submits another supplyAsync.
            final int finalWait = waitSeconds;
            ScheduledFuture<?> handle = null;
            try {
                handle = GodScheduler.schedule(() -> chatBot.sendFunctionOutputs(results, player), finalWait);
            } catch (Exception schedFail) {
                LOGGER.warn("Wait deferral failed ({}), running outputs now", schedFail.getMessage());
            }
            // Extend the idle watchdog so the deferred call doesn't trip it.
            GodSessionManager.resetIdleTimer(player);
            if (handle == null) {
                // Scheduler down — fall back to running it now.
                chatBot.sendFunctionOutputs(results, player);
            }
        } else {
            chatBot.sendFunctionOutputs(results, player);
        }
        return true;
    }

    private static int extractWaitSeconds(ToolExecutionRequest req) {
        try {
            Wait w = parseArgs(req, Wait.class);
            BridgeConfig cfg = BridgeConfig.INSTANCE;
            return Math.max(cfg.waitMinSeconds, Math.min(w.seconds, cfg.waitMaxSeconds));
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Dispatch a single tool call. World-mutating tools hop onto the main
     * thread via {@link GodActionQueue}; the {@code .join()} blocks the LLM
     * callback thread for ~one tick, which is the existing contract — never
     * call this on the main thread (deadlock).
     */
    private static String executeFunction(ToolExecutionRequest req, ServerPlayerEntity player) {
        return switch (req.name()) {
            case "Reward" -> runOnMain(() -> parseArgs(req, Reward.class).execute(player));
            case "Trade" -> runOnMain(() -> parseArgs(req, Trade.class).execute(player));
            case "Punishment" -> runOnMain(() -> parseArgs(req, Punishment.class).execute(player));
            case "ChangeWeather" -> runOnMain(() -> parseArgs(req, ChangeWeather.class).execute(player));
            case "SpawnCreature" -> runOnMain(() -> parseArgs(req, SpawnCreature.class).execute(player));
            // Appear, Vanish, Wait don't mutate world/entity state from
            // off-thread — Appear queues its own buffAvatar, Vanish queues
            // its own restoreAvatar, Wait is a pure scheduling token.
            case "Appear" -> parseArgs(req, Appear.class).execute(player);
            case "Vanish" -> parseArgs(req, Vanish.class).execute(player);
            case "Wait" -> parseArgs(req, Wait.class).execute(player);
            case "BuildPlan" -> parseArgs(req, BuildPlan.class).execute(player);
            default -> throw new IllegalArgumentException("Unknown function: " + req.name());
        };
    }

    /** Queue + join: returns the supplier's result run on the main server thread. */
    private static String runOnMain(java.util.function.Supplier<String> body) {
        try {
            return GodActionQueue.submit(body).get();
        } catch (Exception e) {
            LOGGER.warn("Main-thread queue join failed: {}", e.getMessage(), e);
            return "Erreur côté serveur lors de l'exécution de cette action.";
        }
    }

    /**
     * Best-effort body choreography. Each fire-and-forget gesture matches one
     * tool — Punishment swings + looks at the player, Reward nods,
     * ChangeWeather looks up, SpawnCreature does a summon pose. Plain bridge
     * calls so they never touch world state.
     */
    private static void fireGestures(List<ToolExecutionRequest> requests, ServerPlayerEntity player, List<FunctionResult> results) {
        if (!GodSessionManager.hasManifested()) return;
        for (ToolExecutionRequest req : requests) {
            switch (req.name()) {
                case "Punishment" -> {
                    GodBody.lookAt(player);
                    GodBody.gesture("swing");
                }
                case "Reward"        -> GodBody.gesture("nod");
                case "ChangeWeather" -> {
                    if (player != null) GodBody.lookAt(player); // brief glance up handled by `nod`/`summon` if desired
                    GodBody.gesture("summon");
                }
                case "SpawnCreature" -> GodBody.gesture("summon");
                case "Trade"         -> GodBody.gesture("nod");
                default -> { /* Appear/Vanish/Wait/BuildPlan handle their own presence */ }
            }
        }
    }

    private static <T> T parseArgs(ToolExecutionRequest req, Class<T> cls) {
        String args = req.arguments();
        if (args == null || args.isBlank()) args = "{}";
        try {
            return MAPPER.readValue(args, cls);
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse args for " + req.name() + ": " + args, e);
        }
    }

    // Tolerates arbitrary whitespace, negative ints, and four block-name styles:
    // "minecraft:stone", 'minecraft:stone', `minecraft:stone`, or bare minecraft:stone.
    private static final String INT = "-?\\d+";
    private static final String WS = "\\s*";
    private static final String BLOCK_ID = "[A-Za-z][A-Za-z0-9_]*:[A-Za-z][A-Za-z0-9_/]*(?:\\[[^\\]]*\\])?";
    private static final String BLOCK_NAME =
        "(?:\"(" + BLOCK_ID + ")\"|'(" + BLOCK_ID + ")'|`(" + BLOCK_ID + ")`|(" + BLOCK_ID + "))";
    private static final String INT_ARRAY = "\\[" + WS + "(" + INT + "(?:" + WS + "," + WS + INT + ")*)?" + WS + "\\]";

    private static final Pattern PLACE_BLOCK_PATTERN = Pattern.compile(
        "PlaceBlock" + WS + "\\(" + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + BLOCK_NAME + WS + "\\)");

    private static final Pattern PLACE_LINE_PATTERN = Pattern.compile(
        "PlaceLine" + WS + "\\(" + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + "(" + INT + ")" + WS + "," + WS
        + BLOCK_NAME + WS + "\\)");

    private static final Pattern PLACE_BLOCKS_PATTERN = Pattern.compile(
        "PlaceBlocks" + WS + "\\(" + WS
        + "(" + INT_ARRAY + ")" + WS + "," + WS
        + "(" + INT_ARRAY + ")" + WS + "," + WS
        + "(" + INT_ARRAY + ")" + WS + "," + WS
        + BLOCK_NAME + WS + "\\)");

    private static final Pattern INT_TOKEN_PATTERN = Pattern.compile(INT);

    private static String firstNonNull(String... strs) {
        for (String s : strs) {
            if (s != null) return s;
        }
        return null;
    }

    public static String stripTextualFunctionCalls(String text) {
        if (text == null) return "";
        text = PLACE_BLOCKS_PATTERN.matcher(text).replaceAll("");
        text = PLACE_LINE_PATTERN.matcher(text).replaceAll("");
        text = PLACE_BLOCK_PATTERN.matcher(text).replaceAll("");
        text = text.replaceAll("[ \\t]+(?=\\R)", "");
        text = text.replaceAll("(?:\\R){3,}", "\n\n");
        return text.trim();
    }

    public static int checkForTextualFunctions(ChatResponse r, ServerPlayerEntity player, ChatBot chatBot) {
        String text = extractResponseText(r);
        if (text.isEmpty()) return 0;
        return scanAndExecute(text, player, null);
    }

    public static int scanAndExecuteWithPivot(String text, ServerPlayerEntity player, net.minecraft.util.math.BlockPos pivot) {
        if (text == null || text.isEmpty()) return 0;
        return scanAndExecute(text, player, pivot);
    }

    public static String extractResponseText(ChatResponse r) {
        if (r == null) return "";
        AiMessage msg = r.aiMessage();
        if (msg == null) return "";
        String text = msg.text();
        return text == null ? "" : text;
    }

    private static int scanAndExecute(String text, ServerPlayerEntity player, net.minecraft.util.math.BlockPos pivot) {
        int total = 0;
        total += scanPlaceBlock(text, player, pivot);
        total += scanPlaceLine(text, player, pivot);
        total += scanPlaceBlocks(text, player, pivot);
        return total;
    }

    private static int scanPlaceBlock(String text, ServerPlayerEntity player, net.minecraft.util.math.BlockPos pivot) {
        Matcher m = PLACE_BLOCK_PATTERN.matcher(text);
        int count = 0;
        while (m.find()) {
            String match = m.group();
            try {
                int x = Integer.parseInt(m.group(1));
                int y = Integer.parseInt(m.group(2));
                int z = Integer.parseInt(m.group(3));
                String blockType = firstNonNull(m.group(4), m.group(5), m.group(6), m.group(7));
                if (pivot == null) {
                    ChatBotActions.placeBlock(player, x, y, z, blockType);
                } else {
                    ChatBotActions.placeBlockAt(player, pivot, x, y, z, blockType);
                }
                count++;
            } catch (Exception e) {
                LOGGER.warn("Failed to parse textual PlaceBlock call: {}", match, e);
            }
        }
        if (count > 0) LOGGER.info("Executed {} textual PlaceBlock call(s) for player {}", count, player.getName().getString());
        return count;
    }

    private static int scanPlaceLine(String text, ServerPlayerEntity player, net.minecraft.util.math.BlockPos pivot) {
        Matcher m = PLACE_LINE_PATTERN.matcher(text);
        int count = 0;
        while (m.find()) {
            String match = m.group();
            try {
                int x = Integer.parseInt(m.group(1));
                int y = Integer.parseInt(m.group(2));
                int z = Integer.parseInt(m.group(3));
                int x2 = Integer.parseInt(m.group(4));
                int y2 = Integer.parseInt(m.group(5));
                int z2 = Integer.parseInt(m.group(6));
                String blockType = firstNonNull(m.group(7), m.group(8), m.group(9), m.group(10));
                if (pivot == null) {
                    ChatBotActions.placeLine(player, x, y, z, x2, y2, z2, blockType);
                } else {
                    ChatBotActions.placeLineAt(player, pivot, x, y, z, x2, y2, z2, blockType);
                }
                count++;
            } catch (Exception e) {
                LOGGER.warn("Failed to parse textual PlaceLine call: {}", match, e);
            }
        }
        if (count > 0) LOGGER.info("Executed {} textual PlaceLine call(s) for player {}", count, player.getName().getString());
        return count;
    }

    private static int scanPlaceBlocks(String text, ServerPlayerEntity player, net.minecraft.util.math.BlockPos pivot) {
        Matcher m = PLACE_BLOCKS_PATTERN.matcher(text);
        int count = 0;
        while (m.find()) {
            String match = m.group();
            try {
                int[] xs = parseIntArray(m.group(1));
                int[] ys = parseIntArray(m.group(3));
                int[] zs = parseIntArray(m.group(5));
                String blockType = firstNonNull(m.group(7), m.group(8), m.group(9), m.group(10));
                if (pivot == null) {
                    ChatBotActions.placeBlocks(player, xs, ys, zs, blockType);
                } else {
                    ChatBotActions.placeBlocksAt(player, pivot, xs, ys, zs, blockType);
                }
                count++;
            } catch (Exception e) {
                LOGGER.warn("Failed to parse textual PlaceBlocks call: {}", match, e);
            }
        }
        if (count > 0) LOGGER.info("Executed {} textual PlaceBlocks call(s) for player {}", count, player.getName().getString());
        return count;
    }

    private static int[] parseIntArray(String arrayLiteral) {
        List<Integer> values = new ArrayList<>();
        Matcher m = INT_TOKEN_PATTERN.matcher(arrayLiteral);
        while (m.find()) {
            values.add(Integer.parseInt(m.group()));
        }
        int[] out = new int[values.size()];
        for (int i = 0; i < values.size(); i++) {
            out[i] = values.get(i);
        }
        return out;
    }

}
