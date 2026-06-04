package com.paul.brawl;

import java.util.LinkedList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;

import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;

/**
 * Isolated single-purpose build worker.
 *
 * One BuildSubAgent owns:
 *  - its own pivot (origin (0,0,0) for textual placements)
 *  - its own {@link ChatMemory} (does NOT see the planner's history)
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

    private final ServerPlayerEntity player;
    private final BlockPos pivot;
    private final String initialUserMessage;
    private final String label;
    private final Queue<String> refinementQueue;
    private final ChatMemory memory;

    private int turnsTaken = 0;
    private int totalPlacements = 0;

    public BuildSubAgent(ServerPlayerEntity player,
                         BlockPos pivot,
                         String fullSystemPrompt,
                         String initialUserMessage,
                         String label,
                         List<String> refinements) {
        this.player = player;
        this.pivot = pivot;
        this.initialUserMessage = initialUserMessage;
        this.label = label;
        this.refinementQueue = new LinkedList<>(refinements);
        // Each sub-agent's memory is private; the system prompt is seeded once and
        // re-sent on every call (LangChain4j has no server-retained chain).
        this.memory = MessageWindowChatMemory.withMaxMessages(MAX_TURNS * 2 + 2);
        this.memory.add(SystemMessage.from(fullSystemPrompt));
    }

    public void start() {
        ChatPrinter.sendMessage(player, "[sub-build " + label + "] start @ "
            + pivot.getX() + "," + pivot.getY() + "," + pivot.getZ());
        sendTurn(initialUserMessage);
    }

    private void sendTurn(String userMessage) {
        if (++turnsTaken > MAX_TURNS) {
            LOGGER.warn("Sub-build '{}' hit MAX_TURNS={}, stopping.", label, MAX_TURNS);
            ChatPrinter.sendMessage(player, "[sub-build " + label + "] arrêt — limite de tours atteinte (" + totalPlacements + " blocs).");
            return;
        }

        memory.add(UserMessage.from(userMessage));

        ChatRequest req = ChatRequest.builder()
            .messages(memory.messages())
            .build();

        ChatModel model = LLMConfig.INSTANCE.sharedModel();
        CompletableFuture<ChatResponse> future = CompletableFuture.supplyAsync(
            () -> model.chat(req),
            LLMConfig.INSTANCE.sharedExecutor()
        );

        future.whenComplete((r, ex) -> {
            if (ex != null) {
                Throwable root = ex;
                while (root.getCause() != null && root.getCause() != root) root = root.getCause();
                LOGGER.error("Sub-build '{}' API call failed", label, root);
                return;
            }
            try {
                handleResponse(r);
            } catch (Exception e) {
                LOGGER.error("Sub-build '{}' handler threw", label, e);
            }
        });
    }

    private void handleResponse(ChatResponse r) {
        AiMessage aiMessage = r.aiMessage();
        if (aiMessage != null) memory.add(aiMessage);

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
            sendTurn(cont);
            return;
        }

        // No placements — the model thinks this pass is done.
        if (!refinementQueue.isEmpty()) {
            String next = refinementQueue.poll();
            sendTurn(next);
            return;
        }

        // Genuinely finished.
        ChatPrinter.sendMessage(player, "[sub-build " + label + "] terminé (" + totalPlacements + " blocs placés).");
    }
}
