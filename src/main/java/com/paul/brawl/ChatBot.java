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
import java.util.function.BiConsumer;

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
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
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
     */
    public static final int MAX_MEMORY_MESSAGES = 40;
    public ConcurrentHashMap<UUID, ChatMemory> memories = new ConcurrentHashMap<>();

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


    public static void register() {
        godBot = new ChatBot("prompt.txt");
        buildBot = new ChatBot("build_prompt.txt");

        godBot.hasImage = true;
        buildBot.hasImage = false;

        godBot.needsInfo = true;
        buildBot.needsInfo = false;

        godBot.needsBuildTools = false;
        buildBot.needsBuildTools = true;

        godBot.needsGodTools = true;
        buildBot.needsGodTools = false;

        godBot.needsBuildPlan = false;
        buildBot.needsBuildPlan = true;

        ChatMessageHistory.register();

		ChatCommand.register();

        ChatBotActions.register();

		ImageReceiver.commonRegister();

		ImageReceiver.register();

		TradeOffers.register();

		LLMCommand.register();

    }

    /**
     * Drops the cached {@link ChatModel} and wipes every player's memory so the next
     * request rebuilds against current settings. Used by /llm when provider /
     * host / port / api key change.
     */
    public static void reloadClients() {
        LLMConfig.INSTANCE.invalidateClient();
        if (godBot != null) {
            godBot.memories.clear();
            godBot.functionCallDepth.clear();
        }
        if (buildBot != null) {
            buildBot.memories.clear();
            buildBot.functionCallDepth.clear();
        }
    }


    public ChatBot(String promptPath) {
        this.promptPath = promptPath;
        readPrompt();
    }

    /** Clears the player's conversation memory and depth guard. */
    public void clearMemory(ServerPlayerEntity player) {
        memories.remove(player.getUuid());
        functionCallDepth.remove(player.getUuid());
    }

    /** Returns the player's {@link ChatMemory}, creating a fresh window if needed. */
    public ChatMemory memoryFor(ServerPlayerEntity player) {
        return memories.computeIfAbsent(player.getUuid(),
            k -> MessageWindowChatMemory.withMaxMessages(MAX_MEMORY_MESSAGES));
    }


    public CompletableFuture<ChatResponse> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player) {
        return sendImageChatRequest(input, bytes, player, null);
    }

    public CompletableFuture<ChatResponse> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player, BiConsumer<? super ChatResponse, String> callback) {

        functionCallDepth.put(player.getUuid(), 0);

        ChatMemory memory = memoryFor(player);

        // hasImage gates whether the screenshot rides along. Both bots historically
        // accepted images at the API layer; the flag exists so build_prompt sub-agents
        // that don't need vision can save tokens.
        if (hasImage) {
            String base64 = Base64.getEncoder().encodeToString(bytes);
            UserMessage userMsg = UserMessage.from(
                TextContent.from(input),
                ImageContent.from(base64, "image/jpeg")
            );
            memory.add(userMsg);
        } else {
            memory.add(UserMessage.from(input));
        }

        return doRequest(player, callback);
    }

    public CompletableFuture<ChatResponse> sendChatRequest(String input, ServerPlayerEntity player) {
        return sendChatRequest(input, player, null);
    }

    public CompletableFuture<ChatResponse> sendChatRequest(String input, ServerPlayerEntity player, BiConsumer<? super ChatResponse, String> callback) {
        functionCallDepth.put(player.getUuid(), 0);

        ChatMemory memory = memoryFor(player);
        memory.add(UserMessage.from(input));

        return doRequest(player, callback);
    }


    public CompletableFuture<ChatResponse> sendFunctionOutputs(List<ChatBotFunctions.FunctionResult> results, ServerPlayerEntity player) {

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
        for (ChatBotFunctions.FunctionResult r : results) {
            memory.add(ToolExecutionResultMessage.from(r.call(), r.result()));
        }

        return doRequest(player, null);
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
        memory.add(UserMessage.from(msg));

        return doRequest(player, null);
    }

    /**
     * Builds the full per-turn message list (system + dynamic context + memory),
     * attaches the tool specs, and submits the request on the shared blocking-LLM
     * worker pool. Returns a {@link CompletableFuture} so callers retain the old
     * async / callback style ({@code thenAccept}, {@code whenComplete}).
     */
    private CompletableFuture<ChatResponse> doRequest(ServerPlayerEntity player, BiConsumer<? super ChatResponse, String> callback) {
        List<ChatMessage> messages = buildMessageList(player);
        List<ToolSpecification> tools = ChatBotFunctions.buildToolSpecs(needsGodTools, needsBuildPlan);

        ChatRequest.Builder rb = ChatRequest.builder().messages(messages);
        if (!tools.isEmpty()) {
            rb = rb.toolSpecifications(tools);
        }
        ChatRequest req = rb.build();

        ChatModel model = LLMConfig.INSTANCE.sharedModel();
        CompletableFuture<ChatResponse> response = CompletableFuture.supplyAsync(
            () -> model.chat(req),
            LLMConfig.INSTANCE.sharedExecutor()
        );

        response.whenComplete((r, ex) -> {
            if (ex != null) logApiError(ex, player);
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
            String jsonString = PlayerDataCollector.collect(player).toString();

            messages.add(SystemMessage.from(
                "The player you are interacting with has their information in JSON format here: \n"
                + jsonString));

            messages.add(SystemMessage.from(
                "The history of chat, commands, and game messages is shown here: \n"
                + ChatMessageHistory.getHistory()));

            messages.add(SystemMessage.from(
                "Here is the information about the blocks near the player's cursor: \n"
                + ChatBotActions.getBlockInfo(player)));
        }

        ChatMemory memory = memoryFor(player);
        messages.addAll(memory.messages());

        return messages;
    }

    public void setupGeneralCallback(CompletableFuture<ChatResponse> response, ServerPlayerEntity player) {
        response.thenAccept(r -> {
            try {
                if (r == null) return;
                logResponseShape(r, player);
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
        memoryFor(player).add(aiMessage);
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
