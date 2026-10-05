package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ImageContent;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.TextContent;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.memory.chat.TokenWindowChatMemory;
import dev.langchain4j.model.TokenCountEstimator;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiTokenCountEstimator;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBot {

    public static ChatBot godBot, buildBot;

    public static final int MAX_FUNCTION_CALL_DEPTH = 100;
    public ConcurrentHashMap<UUID, Integer> functionCallDepth = new ConcurrentHashMap<>();

    /**
     * Per-player conversation memory. Holds every user/assistant/tool message in the
     * encounter (the {@link SystemMessage}s carrying the persona + dynamic context are
     * rebuilt fresh each turn and prepended at send time, not stored here). Replaces
     * the OpenAI Responses API's server-side {@code previousResponseId} chain.
     *
     * <p><b>Capacity</b>: 16 000 tokens via {@link TokenWindowChatMemory}, sized
     * by {@link #TOKEN_ESTIMATOR}. The earlier message-count cap was the wrong
     * dimension — one image content block can weigh more than 50 chat lines,
     * and a single MCP tool result can be 1 KB+ of JSON. Token-budgeting
     * matches what the model actually consumes and leaves a safety margin
     * inside a typical 128k context for the per-turn system + dynamic-context
     * preamble that {@link #buildMessageList} prepends fresh each call.
     *
     * <p>LC4j's TokenWindowChatMemory keeps a {@code tool_call} assistant and
     * its following {@code tool_result} messages together when evicting, so the
     * old "400 on tool_call without tool_result" failure mode after window
     * crossover is gone too.
     *
     * <p><b>Concurrency</b>: {@link TokenWindowChatMemory} is not thread-safe
     * (LinkedList-backed). Every {@code add} / {@code messages()} call in this
     * file is wrapped in {@code synchronized(memory)} so concurrent prayer
     * chains (double-{@code /pray}, {@code Wait} callback landing while the
     * user re-prays) can't corrupt the list.
     */
    public static final int MAX_MEMORY_TOKENS = 16_000;

    /**
     * Shared {@link TokenCountEstimator} used to budget the per-player window.
     * The "gpt-4o" tokenizer uses o200k_base, which is the encoding the current
     * GPT-5 / o-series reasoning models use too. For LM Studio / Ollama the
     * estimator is approximate (different vocab), but being off by 10–15 % is
     * fine for a 16 000-token cap — we're budgeting, not accounting.
     *
     * <p>OpenAiTokenCountEstimator is stateless and thread-safe, so one
     * instance serves every player.
     */
    private static final TokenCountEstimator TOKEN_ESTIMATOR =
        new OpenAiTokenCountEstimator("gpt-4o");

    public ConcurrentHashMap<UUID, ChatMemory> memories = new ConcurrentHashMap<>();

    /**
     * Per-player flag: did the current conversation start while owning the
     * avatar session? Set at each user entry point ({@link #sendChatRequest} /
     * {@link #sendImageChatRequest}). Distinguishes "session ended mid-flight —
     * drop the response" from "never had a session — bodiless prayer, answer
     * normally". Without it, a player praying while the avatar is busy
     * elsewhere (or a {@code /prove} outside a session) matched the drop
     * predicate and never received any reply.
     */
    public ConcurrentHashMap<UUID, Boolean> sessionBound = new ConcurrentHashMap<>();

    /** A scheduled Wait continuation plus the tool results it will submit. */
    private record PendingDeferral(ScheduledFuture<?> handle, List<ChatBotFunctions.FunctionResult> results) {}

    /**
     * Pending Wait deferral per player. While one exists, the assistant turn
     * holding the tool_calls is already in memory but its tool results are
     * withheld for up to {@code waitMaxSeconds} — a new user message landing in
     * that window would malform the next request (tool_call without
     * tool_result). The entry points cancel + flush via
     * {@link #flushPendingDeferral} before adding the new {@link UserMessage}.
     */
    private final ConcurrentHashMap<UUID, PendingDeferral> pendingDeferrals = new ConcurrentHashMap<>();

    public static String PROMPT_STATE_KEY = "prompt_state_key";

    private static final Logger LOGGER = LoggerFactory.getLogger("ChatCommand");

    public String promptPath = "prompt.txt";

    public String hardcodedPrompt = "";
    public String prompt = "";

    public boolean hasImage = true;
    public boolean needsInfo = true;
    public boolean needsBuildTools = true;
    public boolean needsGodTools = true;
    public boolean needsBuildPlan = false;
    /** Append MCPGateway tools (Mineflayer-driven) to the per-turn tool list.
     *  Only meaningful for the God bot — build sub-agents emit their own
     *  PlaceBlock/PlaceLine/PlaceBlocks text and don't need Mineflayer. */
    public boolean needsMcpTools = false;


    public static void register() {
        godBot = new ChatBot("prompt.txt");
        buildBot = new ChatBot("build_prompt.txt");

        godBot.hasImage = true;
        // Bug #9: /build ships a screenshot of the site to buildBot; with hasImage=false the
        // server dropped it. BuildSubAgent is not a ChatBot, so this costs the sub-agents nothing.
        buildBot.hasImage = true;

        godBot.needsInfo = true;
        buildBot.needsInfo = false;

        godBot.needsBuildTools = false;
        buildBot.needsBuildTools = true;

        godBot.needsGodTools = true;
        buildBot.needsGodTools = false;

        godBot.needsBuildPlan = false;
        buildBot.needsBuildPlan = true;

        godBot.needsMcpTools = true;
        buildBot.needsMcpTools = false;

        ChatMessageHistory.register();

		ChatCommand.register();

        ChatBotActions.register();

		ImageReceiver.commonRegister();

		ImageReceiver.register();

		TradeOffers.register();

		LLMCommand.register();

		MCPCommand.register();

    }

    /**
     * Drops the cached {@link ChatModel} and wipes every player's memory so the next
     * request rebuilds against current settings. Used by /llm when provider /
     * host / port / api key change.
     */
    public static void reloadClients() {
        LLMConfig.INSTANCE.invalidateClient();
        if (godBot != null) {
            godBot.cancelAllDeferrals();
            godBot.memories.clear();
            godBot.functionCallDepth.clear();
            godBot.sessionBound.clear();
        }
        if (buildBot != null) {
            buildBot.cancelAllDeferrals();
            buildBot.memories.clear();
            buildBot.functionCallDepth.clear();
            buildBot.sessionBound.clear();
        }
    }


    public ChatBot(String promptPath) {
        this.promptPath = promptPath;
        readPrompt();
    }

    /** Clears the player's conversation memory, depth guard, session flag, and
     *  any pending Wait deferral (its memory is being wiped — a continuation
     *  would submit orphaned tool results into a fresh conversation). */
    public void clearMemory(ServerPlayerEntity player) {
        PendingDeferral pd = pendingDeferrals.remove(player.getUuid());
        if (pd != null) pd.handle().cancel(false);
        memories.remove(player.getUuid());
        functionCallDepth.remove(player.getUuid());
        sessionBound.remove(player.getUuid());
    }

    private void cancelAllDeferrals() {
        pendingDeferrals.values().forEach(pd -> pd.handle().cancel(false));
        pendingDeferrals.clear();
    }

    /** Returns the player's {@link ChatMemory}, creating a fresh token window if needed. */
    public ChatMemory memoryFor(ServerPlayerEntity player) {
        return memories.computeIfAbsent(player.getUuid(),
            k -> TokenWindowChatMemory.withMaxTokens(MAX_MEMORY_TOKENS, TOKEN_ESTIMATOR));
    }


    public CompletableFuture<ChatResponse> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player) {
        return sendImageChatRequest(input, bytes, player, null);
    }

    public CompletableFuture<ChatResponse> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player, BiConsumer<? super ChatResponse, String> callback) {

        flushPendingDeferral(player);
        functionCallDepth.put(player.getUuid(), 0);
        if (needsGodTools) sessionBound.put(player.getUuid(), GodSessionManager.isActive(player));

        ChatMemory memory = memoryFor(player);

        // hasImage gates whether the screenshot rides along. Both bots historically
        // accepted images at the API layer; the flag exists so build_prompt sub-agents
        // that don't need vision can save tokens.
        synchronized (memory) {
            if (hasImage) {
                String base64 = Base64.getEncoder().encodeToString(bytes);
                UserMessage userMsg = UserMessage.from(
                    TextContent.from(input),
                    ImageContent.from(base64, ImageMime.sniff(bytes))
                );
                memory.add(userMsg);
            } else {
                memory.add(UserMessage.from(input));
            }
        }

        return doRequest(player, callback);
    }

    public CompletableFuture<ChatResponse> sendChatRequest(String input, ServerPlayerEntity player) {
        return sendChatRequest(input, player, null);
    }

    public CompletableFuture<ChatResponse> sendChatRequest(String input, ServerPlayerEntity player, BiConsumer<? super ChatResponse, String> callback) {
        flushPendingDeferral(player);
        functionCallDepth.put(player.getUuid(), 0);
        if (needsGodTools) sessionBound.put(player.getUuid(), GodSessionManager.isActive(player));

        ChatMemory memory = memoryFor(player);
        synchronized (memory) {
            memory.add(UserMessage.from(input));
        }

        return doRequest(player, callback);
    }


    public CompletableFuture<ChatResponse> sendFunctionOutputs(List<ChatBotFunctions.FunctionResult> results, ServerPlayerEntity player) {

        // A deferred Wait continuation can land after its session ended
        // (/pray stop, idle watchdog, /godbody off). The response callback
        // would drop it anyway — skip the LLM call entirely. Memory is wiped
        // for the same reason the drop path wipes it: the assistant turn's
        // tool_calls would otherwise sit unanswered at the tail. Bodiless
        // conversations (sessionBound == false) pass through untouched.
        if (this.needsGodTools
                && sessionBound.getOrDefault(player.getUuid(), false)
                && !GodSessionManager.isActive(player)) {
            LOGGER.info("Skipping function outputs for player {} — session ended while waiting.",
                player.getName().getString());
            clearMemory(player);
            return CompletableFuture.completedFuture(null);
        }

        int depth = functionCallDepth.merge(player.getUuid(), 1, Integer::sum);
        if (depth > MAX_FUNCTION_CALL_DEPTH) {
            LOGGER.warn("Reached max function call depth ({}) for player {}, stopping chain and resetting it.",
                MAX_FUNCTION_CALL_DEPTH, player.getName().getString());
            // The most recent assistant turn carries tool_calls we are choosing not to
            // answer. Leaving them in memory unmatched would corrupt the next request
            // (assistant tool_call must be followed by its tool_result), so wipe the
            // memory — the next user message starts a fresh conversation.
            clearMemory(player);
            ChatPrinter.sendMessage(player, "Dieu : (chaîne d'appels coupée — relance ta requête.)");
            // Same exit hygiene as the natural terminal: vanish + release lock.
            if (this.needsGodTools && GodSessionManager.isActive(player)) {
                endPrayerSession(player);
            }
            return CompletableFuture.completedFuture(null);
        }

        ChatMemory memory = memoryFor(player);
        synchronized (memory) {
            for (ChatBotFunctions.FunctionResult r : results) {
                memory.add(ToolExecutionResultMessage.from(r.call(), r.result()));
            }
        }

        return doRequest(player, null);
    }

    /**
     * Schedule {@link #sendFunctionOutputs} after a {@code Wait}, remembering
     * the handle so a new user message can cancel + flush it (see
     * {@link #flushPendingDeferral}). Falls back to running the outputs
     * immediately if the scheduler is down.
     */
    public void deferFunctionOutputs(List<ChatBotFunctions.FunctionResult> results, ServerPlayerEntity player, int seconds) {
        final UUID id = player.getUuid();
        ScheduledFuture<?> handle = null;
        try {
            handle = GodScheduler.schedule(() -> {
                pendingDeferrals.remove(id);
                sendFunctionOutputs(results, player);
            }, seconds);
        } catch (Exception schedFail) {
            LOGGER.warn("Wait deferral failed ({}), running outputs now", schedFail.getMessage());
        }
        if (handle == null) {
            sendFunctionOutputs(results, player);
            return;
        }
        pendingDeferrals.put(id, new PendingDeferral(handle, results));
    }

    /**
     * If a Wait deferral is pending for this player, cancel it and write its
     * tool results into memory WITHOUT firing the LLM continuation. Called
     * from the user entry points before the new {@link UserMessage} is added:
     * the assistant turn holding the tool_calls is already in memory, and
     * leaving it unanswered ahead of a new user message malforms the next
     * request (tool_call without tool_result). If {@code cancel()} loses the
     * race the task is already mid-flight — the exposure shrinks back to the
     * milliseconds it was before Wait existed.
     */
    private void flushPendingDeferral(ServerPlayerEntity player) {
        PendingDeferral pd = pendingDeferrals.remove(player.getUuid());
        if (pd == null) return;
        if (!pd.handle().cancel(false)) return;
        ChatMemory memory = memoryFor(player);
        synchronized (memory) {
            for (ChatBotFunctions.FunctionResult r : pd.results()) {
                memory.add(ToolExecutionResultMessage.from(r.call(), r.result()));
            }
        }
        LOGGER.info("Flushed {} deferred tool result(s) for player {} — new message interrupted a Wait.",
            pd.results().size(), player.getName().getString());
    }

    public CompletableFuture<ChatResponse> sendTextualContinuation(int placedCount, ServerPlayerEntity player) {

        int depth = functionCallDepth.merge(player.getUuid(), 1, Integer::sum);
        if (depth > MAX_FUNCTION_CALL_DEPTH) {
            LOGGER.warn("Reached max function call depth ({}) for player {}, stopping textual chain and resetting it.",
                MAX_FUNCTION_CALL_DEPTH, player.getName().getString());
            clearMemory(player);
            ChatPrinter.sendMessage(player, "Dieu : (construction interrompue — limite de tours atteinte.)");
            return CompletableFuture.completedFuture(null);
        }

        String msg = "[system] Executed " + placedCount + " textual placement call(s) from your previous reply. "
            + "If the build is now complete, reply with one short French sentence and no call lines. "
            + "Otherwise emit more PlaceBlock / PlaceLine / PlaceBlocks lines and the system will call you again.";

        ChatMemory memory = memoryFor(player);
        synchronized (memory) {
            memory.add(UserMessage.from(msg));
        }

        return doRequest(player, null);
    }

    /**
     * Builds the full per-turn message list (system + dynamic context + memory),
     * attaches the tool specs, and submits the request on the shared blocking-LLM
     * worker pool. Returns a {@link CompletableFuture} so callers retain the old
     * async / callback style ({@code thenAccept}, {@code whenComplete}).
     *
     * <p><b>Why the assembly happens inside {@code supplyAsync}:</b> {@code buildToolSpecs}
     * touches {@link MCPGateway#tools()} which lazily handshakes with the unified
     * node process on first call — a synchronous {@code listTools()} round-trip
     * bounded by {@code MCPConfig.timeoutSeconds}. If we built the request on the
     * caller's thread (the main server thread when {@code /pray} fires), a
     * down/wrong-port node process would freeze the tick loop for the timeout
     * window and trip every connected client's keepalive. Doing the assembly on
     * the worker keeps the main thread free; the worker just stalls for itself.
     */
    private CompletableFuture<ChatResponse> doRequest(ServerPlayerEntity player, BiConsumer<? super ChatResponse, String> callback) {
        ChatModel model = LLMConfig.INSTANCE.sharedModel();
        // Review fix (bug #8): the watchdog must not fire while the owner's request is in flight.
        if (needsGodTools) GodSessionManager.pauseIdleTimer(player);
        CompletableFuture<ChatResponse> response = CompletableFuture.supplyAsync(
            () -> {
                List<ChatMessage> messages = buildMessageList(player);
                List<ToolSpecification> tools = ChatBotFunctions.buildToolSpecs(needsGodTools, needsBuildPlan, needsMcpTools);

                ChatRequest.Builder rb = ChatRequest.builder().messages(messages);
                if (!tools.isEmpty()) {
                    rb = rb.toolSpecifications(tools);
                }
                return model.chat(rb.build());
            },
            LLMConfig.INSTANCE.sharedExecutor()
        );

        response.whenComplete((r, ex) -> {
            if (ex != null) logApiError(ex, player);
            else if (needsGodTools) GodSessionManager.resetIdleTimer(player); // the idle clock restarts on the answer
        });

        setupCustomCallback(response, callback);

        setupGeneralCallback(response, player);

        return response;
    }

    private void logApiError(Throwable ex, ServerPlayerEntity player) {
        Throwable root = ex;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();

        // LangChain4j surfaces HTTP errors as RuntimeExceptions with a message
        // containing the status/body; we don't try to reflectively unwrap an SDK
        // type anymore. Logging the root preserves the original stack trace.
        LOGGER.error("LLM API call failed for player {}", player.getName().getString(), root);
        // Don't leave the avatar hanging if the call failed mid-encounter.
        if (this.needsGodTools && GodSessionManager.isActive(player)) {
            endPrayerSession(player);
        }
    }


    /**
     * The per-turn message list: persona system prompt, optional dynamic context
     * (player JSON / chat log / nearby blocks), then the player's memory. Today
     * the OpenAI server retained the persona via the response-id chain; LangChain4j
     * requires the full list every call, so we always send it.
     */
    public List<ChatMessage> buildMessageList(ServerPlayerEntity player) {
        List<ChatMessage> messages = new ArrayList<>();

        messages.add(SystemMessage.from(hardcodedPrompt + "\n" + prompt));

        if (needsInfo) {
            String[] ctx = collectDynamicContext(player);

            messages.add(SystemMessage.from(
                "The player you are interacting with has their information in JSON format here: \n"
                + ctx[0]));

            messages.add(SystemMessage.from(
                "The history of chat, commands, and game messages is shown here: \n"
                + ctx[1]));

            messages.add(SystemMessage.from(
                "Here is the information about the blocks near the player's cursor: \n"
                + ctx[2]));
        }

        // Snapshot the memory under its lock so a concurrent add (from a
        // parallel chain's setupGeneralCallback / Wait-deferral landing) can't
        // produce a half-mutated list during iteration. ArrayList copy keeps
        // the snapshot independent of any LC4j-internal aliasing.
        ChatMemory memory = memoryFor(player);
        List<ChatMessage> snapshot;
        synchronized (memory) {
            snapshot = new ArrayList<>(memory.messages());
        }
        messages.addAll(snapshot);

        return messages;
    }

    /**
     * Gathers the per-turn dynamic context (player JSON, chat log, nearby
     * blocks) on the main server thread. {@link #buildMessageList} runs on an
     * llm-worker thread (request assembly lives inside {@code supplyAsync} —
     * see {@link #doRequest}), but {@link PlayerDataCollector} iterates live
     * entity state (inventory, status effects) and
     * {@link ChatBotActions#getBlockInfo} reads block states — both racy
     * off-thread; iterating status effects while the main thread mutates them
     * is a ConcurrentModificationException. One bounded queue hop (~1 tick)
     * keeps the reads on the owning thread, same contract as
     * {@code ChatBotFunctions.runOnMain}. On timeout/failure the turn degrades
     * to empty context instead of failing.
     */
    private static String[] collectDynamicContext(ServerPlayerEntity player) {
        final String[] ctx = { "", "", "" };
        Supplier<String> body = () -> {
            ctx[0] = PlayerDataCollector.collect(player).toString();
            ctx[1] = ChatMessageHistory.getHistory();
            ctx[2] = ChatBotActions.getBlockInfo(player);
            return "ok";
        };
        var server = player.getServer();
        if (server != null && server.isOnThread()) {
            // Defensive: never queue-and-join from the main thread (deadlock
            // against the END_SERVER_TICK drain). Collect directly.
            body.get();
            return ctx;
        }
        try {
            GodActionQueue.submit(body).get(5, TimeUnit.SECONDS);
            return ctx;
        } catch (Exception e) {
            LOGGER.warn("Dynamic-context collection on main thread failed ({}); sending turn without context.",
                e.toString());
            // Fresh array: on timeout the queued action may still write ctx later.
            return new String[] { "", "", "" };
        }
    }

    public void setupGeneralCallback(CompletableFuture<ChatResponse> response, ServerPlayerEntity player) {
        response.thenAccept(r -> {
            try {
                if (r == null) return;
                logResponseShape(r, player);

                // Session-ended-mid-flight check: the idle watchdog, /pray stop,
                // or /godbody off may have released this player's lock while the
                // LLM call was in flight (especially after a long Wait + a slow
                // chat() return). Only applies to conversations that STARTED
                // with the session (sessionBound) — a deliberately bodiless
                // prayer (avatar busy elsewhere, or /prove without a session)
                // never owned the lock and must be answered normally. For ended
                // sessions: don't execute tools on a phantom session, and DON'T
                // commit the assistant turn to memory — that would leave
                // orphaned tool_call(s) and the next /pray would 400 on
                // "tool_call without tool_result". Wipe and bail.
                if (this.needsGodTools
                        && sessionBound.getOrDefault(player.getUuid(), false)
                        && !GodSessionManager.isActive(player)) {
                    LOGGER.info("Dropping LLM response for player {} — session no longer active (idle watchdog / kill switch).",
                        player.getName().getString());
                    clearMemory(player);
                    return;
                }

                addAssistantToHistory(r, player);
                printOutputs(r, player);

                // Did this turn keep the conversation alive? Compute once,
                // then vanish only if nothing continues AND this prayer owns
                // an active session. This branch sits OUTSIDE needsBuildTools
                // so it fires for godBot (needsBuildTools == false).
                boolean hadFunctionCalls = ChatBotFunctions.checkForFunctions(r, player, this);
                boolean willContinue = hadFunctionCalls;
                if (this.needsBuildTools && !hadFunctionCalls) {
                    int placed = ChatBotFunctions.checkForTextualFunctions(r, player, this);
                    if (placed > 0) {
                        this.sendTextualContinuation(placed, player);
                        willContinue = true;
                    }
                }

                if (!willContinue && this.needsGodTools && GodSessionManager.isActive(player)) {
                    endPrayerSession(player);
                }

            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    /**
     * Tear down a prayer session: send the body home, clear invuln, release the
     * busy lock. Idempotent — safe to call from depth-cap, error exits, the
     * kill switch, and the natural zero-tool-call terminal.
     */
    public static void endPrayerSession(ServerPlayerEntity player) {
        if (player == null) return;
        if (GodSessionManager.hasManifested()) {
            GodActionQueue.submit(() -> ChatBotActions.restoreAvatar(player));
            GodBody.vanish();
        }
        GodSessionManager.endSession(player);
    }

    private void logResponseShape(ChatResponse r, ServerPlayerEntity player) {
        AiMessage msg = r.aiMessage();
        boolean hasText = msg != null && msg.text() != null && !msg.text().isEmpty();
        int calls = (msg != null && msg.hasToolExecutionRequests()) ? msg.toolExecutionRequests().size() : 0;
        LOGGER.info("Response for player {}: text={}, function_call(s)={}, finishReason={}",
            player.getName().getString(), hasText ? 1 : 0, calls,
            r.finishReason() == null ? "?" : r.finishReason().toString());
    }

    public void setupCustomCallback(CompletableFuture<ChatResponse> response, BiConsumer<? super ChatResponse, String> callback) {
        if (callback == null) return;
        // thenAccept skips the exceptional branch by design — errors are already
        // logged centrally in doRequest's whenComplete.
        response.thenAccept(r -> callback.accept(r, ChatBotFunctions.extractResponseText(r)));
    }

    /**
     * Appends the assistant turn to the player's memory so it sits between their
     * preceding {@link UserMessage} and the {@link ToolExecutionResultMessage}s that
     * {@link #sendFunctionOutputs} will add. Ordering matters here: client-side
     * memory must keep each {@code assistant tool_call} immediately followed by its
     * matching tool result, or the next request is malformed.
     */
    private void addAssistantToHistory(ChatResponse response, ServerPlayerEntity player) {
        AiMessage aiMessage = response.aiMessage();
        if (aiMessage == null) return;
        ChatMemory memory = memoryFor(player);
        synchronized (memory) {
            memory.add(aiMessage);
        }
    }

    private void printOutputs(ChatResponse response, ServerPlayerEntity player) {
        var text = ChatBotFunctions.extractResponseText(response);
        if(needsBuildTools) {
            text = ChatBotFunctions.stripTextualFunctionCalls(text);
        }
        if(text.isEmpty()) return;
        ChatPrinter.sendMessage(player, "Dieu : " + text);
        // Once God has a body, speak the line aloud too so nearby players see
        // the avatar talk. Bodiless (no Appear yet) prayers stay text-only.
        if (needsGodTools && GodSessionManager.isActive(player) && GodSessionManager.hasManifested()) {
            GodBody.say(text);
        }
    }


    public void readPrompt() {
        try {
            hardcodedPrompt = Files.readString(Path.of(promptPath));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    public static ChatBot getCorrectChatBot(String s) {
        if(s.contains("Prove :")) {
            return godBot;
        } else if(s.contains("Build :")) {
            return buildBot;
        }
        return godBot;
    }


}
