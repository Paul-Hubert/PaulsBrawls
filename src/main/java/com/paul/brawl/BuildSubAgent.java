package com.paul.brawl;

import java.util.LinkedList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.openai.client.OpenAIClientAsync;
import com.openai.models.ChatModel;
import com.openai.models.responses.EasyInputMessage;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;

/**
 * Isolated single-purpose build worker.
 *
 * One BuildSubAgent owns:
 *  - its own pivot (origin (0,0,0) for textual placements)
 *  - its own previousResponseId chain (does NOT see the planner's history)
 *  - a queue of refinement prompts that fire after the model signals "done"
 *
 * Loop per sub-agent:
 *  1. start(): send the build prompt + sub-prompt + plan description.
 *  2. on each Response:
 *     - scan & execute textual placements vs OUR pivot
 *     - if placements > 0: send a continuation message (still building inside the current pass)
 *     - else if refinements remaining: pop next refinement and send it (start next pass)
 *     - else: stop.
 *
 * Guarded by MAX_TURNS to prevent runaway loops.
 */
public class BuildSubAgent {

    private static final Logger LOGGER = LoggerFactory.getLogger("BuildSubAgent");

    public static final int MAX_TURNS = 60;

    /** Refinement prompts fired between build passes, in order. Each fires once the model emits zero placements. */
    public static final List<String> DEFAULT_REFINEMENTS = List.of(
        "Pass 2 — gap fix. Walk over what you just built and close every hole: missing wall blocks, gaps where the roof meets the walls, the strip of wall *under* the roof eaves, unfinished corners, missing door/window frames. Do NOT use minecraft:glass_pane — use full minecraft:glass blocks for windows. Emit PlaceBlock / PlaceLine / PlaceBlocks lines. Stop with no calls only when there are no gaps left.",
        "Pass 3 — interior. Finish the inside: a proper floor surface, a closed ceiling (or visible roof underside), interior partitions if the function calls for it, lighting (minecraft:torch / minecraft:lantern), and at least one piece of functional furniture appropriate to the build's purpose (bed, crafting table, furnace, chest, anvil, barrel, etc.). Keep within the existing footprint.",
        "Pass 4 — exterior. Finish the outside: foundation course around the base if missing, a path or stairs up to the entrance, decorative trim along the eaves or windowsills, and any chimney / sign / lantern accents that suit the style. Do not change the primary silhouette.",
        "Pass 5 — roof and walls-under-roof. Check the roof one more time: every tile, ridge, hip, and gable end is placed; no daylight gaps; the strip of wall directly under the eaves is solid all the way around. Replace any leftover minecraft:glass_pane with minecraft:glass. Close anything that's still open.",
        "Final pass. Look over the whole build once more. Anywhere you see a missing block, asymmetry, or place where weather could get in, place blocks to close it. When the build is truly finished, reply with ONE short French sentence and zero call lines."
    );

    private final OpenAIClientAsync client;
    private final ServerPlayerEntity player;
    private final BlockPos pivot;
    private final String fullSystemPrompt;
    private final String initialUserMessage;
    private final String label;
    private final Queue<String> refinementQueue;

    private String previousResponseId = ChatBot.NULL_ID;
    private int turnsTaken = 0;
    private int totalPlacements = 0;

    public BuildSubAgent(ServerPlayerEntity player,
                         BlockPos pivot,
                         String fullSystemPrompt,
                         String initialUserMessage,
                         String label,
                         List<String> refinements) {
        this.client = LLMConfig.INSTANCE.sharedClient();
        this.player = player;
        this.pivot = pivot;
        this.fullSystemPrompt = fullSystemPrompt;
        this.initialUserMessage = initialUserMessage;
        this.label = label;
        this.refinementQueue = new LinkedList<>(refinements);
    }

    public void start() {
        ChatPrinter.sendMessage(player, "[sub-build " + label + "] start @ "
            + pivot.getX() + "," + pivot.getY() + "," + pivot.getZ());
        sendTurn(initialUserMessage, true);
    }

    private void sendTurn(String userMessage, boolean includeSystemPrompt) {
        if (++turnsTaken > MAX_TURNS) {
            LOGGER.warn("Sub-build '{}' hit MAX_TURNS={}, stopping.", label, MAX_TURNS);
            ChatPrinter.sendMessage(player, "[sub-build " + label + "] arrêt — limite de tours atteinte (" + totalPlacements + " blocs).");
            return;
        }

        var builder = ResponseCreateParams.builder()
            .model(ChatModel.of(LLMConfig.INSTANCE.model()));

        if (!previousResponseId.equals(ChatBot.NULL_ID)) {
            builder = builder.previousResponseId(previousResponseId);
        }

        // System prompt only on the first turn — the chain retains it for follow-ups (just like ChatBot.getPromptList).
        var inputs = new java.util.ArrayList<ResponseInputItem>();
        if (includeSystemPrompt) {
            inputs.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content(fullSystemPrompt)
                .build()));
        }
        inputs.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
            .role(EasyInputMessage.Role.USER)
            .content(userMessage)
            .build()));

        builder = builder.inputOfResponse(inputs);

        CompletableFuture<Response> future = client.responses().create(builder.build());
        future.whenComplete((r, ex) -> {
            if (ex != null) {
                LOGGER.error("Sub-build '{}' API call failed: {}", label, ex.toString());
                return;
            }
            try {
                handleResponse(r);
            } catch (Exception e) {
                LOGGER.error("Sub-build '{}' handler threw", label, e);
            }
        });
    }

    private void handleResponse(Response r) {
        previousResponseId = r.id();

        String text = ChatBotFunctions.extractResponseText(r);
        int placed = ChatBotFunctions.scanAndExecuteWithPivot(text, player, pivot);
        totalPlacements += placed;

        String prose = ChatBotFunctions.stripTextualFunctionCalls(text);
        if (!prose.isEmpty()) {
            ChatPrinter.sendMessage(player, "[" + label + "] " + prose);
        }

        LOGGER.info("Sub-build '{}' turn {} placed {} (total {}), refinements left {}",
            label, turnsTaken, placed, totalPlacements, refinementQueue.size());

        if (placed > 0) {
            String cont = "[system] Executed " + placed + " textual placement call(s) from your previous reply. "
                + "If this pass is now complete, reply with one short French sentence and no call lines. "
                + "Otherwise emit more PlaceBlock / PlaceLine / PlaceBlocks lines and the system will call you again.";
            sendTurn(cont, false);
            return;
        }

        // No placements — the model thinks this pass is done.
        if (!refinementQueue.isEmpty()) {
            String next = refinementQueue.poll();
            sendTurn(next, false);
            return;
        }

        // Genuinely finished.
        ChatPrinter.sendMessage(player, "[sub-build " + label + "] terminé (" + totalPlacements + " blocs placés).");
    }
}
