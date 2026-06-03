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

import com.openai.client.OpenAIClientAsync;
import com.openai.models.ChatModel;
import com.openai.models.responses.EasyInputMessage;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams;
import com.openai.models.responses.ResponseFunctionToolCall;
import com.openai.models.responses.ResponseInputImage;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBot {

    public static ChatBot godBot, buildBot;

    public OpenAIClientAsync client;

    public static final String NULL_ID = "null";
    public ConcurrentHashMap<UUID, String> previousResponseIds = new ConcurrentHashMap<>();

    public static final int MAX_FUNCTION_CALL_DEPTH = 100;
    public ConcurrentHashMap<UUID, Integer> functionCallDepth = new ConcurrentHashMap<>();

    public String getPreviousResponseId(ServerPlayerEntity player) {
        return previousResponseIds.getOrDefault(player.getUuid(), NULL_ID);
    }

    public void clearPreviousResponseId(ServerPlayerEntity player) {
        previousResponseIds.remove(player.getUuid());
        functionCallDepth.remove(player.getUuid());
    }

    public static String PROMPT_STATE_KEY = "prompt_state_key";

    private static final Logger LOGGER = LoggerFactory.getLogger("ChatCommand");

    public String promptPath = "prompt.txt";

    public String hardcodedPrompt = "";
    public String prompt = "";

    public boolean hasImage = true;
    public boolean needsInfo = true;
    public boolean needsHistory = false;
    public boolean needsBuildTools = true;
    public boolean needsGodTools = true;
    public boolean needsBuildPlan = false;
    public boolean needsPreviousResponse = true;

    public ChatBotPlayerHistory chatBotPlayerHistory = new ChatBotPlayerHistory();


    public static void register() {
        // Configures using the `OPENAI_API_KEY`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` environment variables
        godBot = new ChatBot("prompt.txt");
        buildBot = new ChatBot("build_prompt.txt");

        godBot.hasImage = true;
        buildBot.hasImage = false;

        godBot.needsInfo = true;
        buildBot.needsInfo = false;

        godBot.needsHistory = false;
        buildBot.needsHistory = false;

        godBot.needsPreviousResponse = true;
        buildBot.needsPreviousResponse = true;

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

    public static void reloadClients() {
        LLMConfig.INSTANCE.invalidateClient();
        if (godBot != null) {
            godBot.client = LLMConfig.INSTANCE.sharedClient();
            godBot.previousResponseIds.clear();
            godBot.functionCallDepth.clear();
            godBot.chatBotPlayerHistory.clearAll();
        }
        if (buildBot != null) {
            buildBot.client = LLMConfig.INSTANCE.sharedClient();
            buildBot.previousResponseIds.clear();
            buildBot.functionCallDepth.clear();
            buildBot.chatBotPlayerHistory.clearAll();
        }
    }


    public ChatBot(String promptPath) {
        this.promptPath = promptPath;

        client = LLMConfig.INSTANCE.sharedClient();
        readPrompt();
    }
    

    public CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player) {
        return sendImageChatRequest(input, bytes, player, null);
    }

    public CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        functionCallDepth.put(player.getUuid(), 0);

        var builder = buildBuilder(player);

        String base64url = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(bytes);
        
        ResponseInputImage image = ResponseInputImage.builder()
                .detail(ResponseInputImage.Detail.AUTO)
                .imageUrl(base64url)
                .build();

        ResponseInputItem imageInputItem = ResponseInputItem.ofMessage(ResponseInputItem.Message.builder()
                .role(ResponseInputItem.Message.Role.USER)
                .addContent(image)
                .build());

        ResponseInputItem messageInputItem = ResponseInputItem.ofMessage(ResponseInputItem.Message.builder()
                .role(ResponseInputItem.Message.Role.USER)
                .addInputTextContent(input)
                .build());
        
        var prompts = getPromptList(player);

        // Don't save images to history to avoid too many tokens
        if(hasImage) {
            prompts.add(imageInputItem);
        }

        addInput(prompts, player, messageInputItem);

        builder = builder.inputOfResponse(prompts);

        var response = sendBuilder(builder, player, callback);

        return response;

    }
    
    public CompletableFuture<Response> sendChatRequest(String input, ServerPlayerEntity player) {
        return sendChatRequest(input, player, null);
    }

    public CompletableFuture<Response> sendChatRequest(String input, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var item = ResponseInputItem
            .ofEasyInputMessage(EasyInputMessage.builder()
            .role(EasyInputMessage.Role.USER)
            .content(input)
            .build());

        return sendRequest(item, player, callback);
    }


    public CompletableFuture<Response> sendFunctionOutputs(List<ChatBotFunctions.FunctionResult> results, ServerPlayerEntity player) {

        int depth = functionCallDepth.merge(player.getUuid(), 1, Integer::sum);
        if (depth > MAX_FUNCTION_CALL_DEPTH) {
            LOGGER.warn("Reached max function call depth ({}) for player {}, stopping chain and resetting it.",
                MAX_FUNCTION_CALL_DEPTH, player.getName().getString());
            // The last response was already recorded as previousResponseId and contains
            // function_calls we are choosing not to answer. Leaving the chain in that
            // state breaks every subsequent turn (OpenAI requires matching outputs), so
            // wipe it — the next user message will start a fresh first turn.
            clearPreviousResponseId(player);
            ChatPrinter.sendMessage(player, "Dieu : (chaîne d'appels coupée — relance ta requête.)");
            return CompletableFuture.completedFuture(null);
        }

        var builder = buildBuilder(player);

        List<ResponseInputItem> l = new ArrayList<>();
        for (var r : results) {
            l.add(ResponseInputItem.ofFunctionCallOutput(ResponseInputItem.FunctionCallOutput.builder()
                .callId(r.call().callId())
                .outputAsJson(r.result())
                .build()));
        }

        builder = builder.inputOfResponse(l);

        return sendBuilder(builder, player, null);
    }

    public CompletableFuture<Response> sendTextualContinuation(int placedCount, ServerPlayerEntity player) {

        int depth = functionCallDepth.merge(player.getUuid(), 1, Integer::sum);
        if (depth > MAX_FUNCTION_CALL_DEPTH) {
            LOGGER.warn("Reached max function call depth ({}) for player {}, stopping textual chain and resetting it.",
                MAX_FUNCTION_CALL_DEPTH, player.getName().getString());
            // The textual loop doesn't have outstanding function_calls (those are pure text),
            // so the chain is technically still valid — but we've hit the safety cap and want
            // a clean slate for the next request rather than picking up a runaway thread.
            clearPreviousResponseId(player);
            ChatPrinter.sendMessage(player, "Dieu : (construction interrompue — limite de tours atteinte.)");
            return CompletableFuture.completedFuture(null);
        }

        var builder = buildBuilder(player);

        String msg = "[system] Executed " + placedCount + " textual placement call(s) from your previous reply. "
            + "If the build is now complete, reply with one short French sentence and no call lines. "
            + "Otherwise emit more PlaceBlock / PlaceLine / PlaceBlocks lines and the system will call you again.";

        var item = ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
            .role(EasyInputMessage.Role.USER)
            .content(msg)
            .build());

        builder = builder.inputOfResponse(List.of(item));

        return sendBuilder(builder, player, null);
    }

    public CompletableFuture<Response> sendRequest(ResponseInputItem item, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        functionCallDepth.put(player.getUuid(), 0);

        var builder = buildBuilder(player);
        
        var prompts = getPromptList(player);

        if(item != null) addInput(prompts, player, item);

        builder = builder.inputOfResponse(prompts);
        
        var response = sendBuilder(builder, player, callback);

        return response;
    }

    public ResponseCreateParams.Builder makeBuilder() {
        var builder = ResponseCreateParams.builder()
            .model(ChatModel.of(LLMConfig.INSTANCE.model()));
        return builder;
    }

    public ResponseCreateParams.Builder buildTools(ResponseCreateParams.Builder builder) {
        // Direct block placement is text-only — there is no PlaceBlock/PlaceLine/PlaceBlocks tool to register.
        // needsBuildTools still gates the text scanner in setupGeneralCallback.
        if(needsGodTools) {
            builder = ChatBotFunctions.registerGodTools(builder);
        }
        if(needsBuildPlan) {
            builder = ChatBotFunctions.registerBuildPlanTool(builder);
        }
        return builder;
    }

    public ResponseCreateParams.Builder setPreviousResponse(ResponseCreateParams.Builder builder, ServerPlayerEntity player) {
        String id = getPreviousResponseId(player);
        if(needsPreviousResponse && !id.equals(NULL_ID)) {
            builder = builder.previousResponseId(id);
        }
        return builder;
    }

    public ResponseCreateParams.Builder buildBuilder(ServerPlayerEntity player) {
        var builder = makeBuilder();

        builder = buildTools(builder);

        builder = setPreviousResponse(builder, player);

        return builder;
    }

    private CompletableFuture<Response> sendBuilder(ResponseCreateParams.Builder builder, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        CompletableFuture<Response> response = client.responses().create(builder.build());

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

        try {
            var bodyMethod = root.getClass().getMethod("body");
            Object body = bodyMethod.invoke(root);
            if (body != null) LOGGER.error("Response body: {}", body);
        } catch (NoSuchMethodException ignored) {
        } catch (Exception reflectErr) {
            LOGGER.debug("Could not extract body via reflection", reflectErr);
        }

        try {
            var statusMethod = root.getClass().getMethod("statusCode");
            Object status = statusMethod.invoke(root);
            if (status != null) LOGGER.error("Status code: {}", status);
        } catch (NoSuchMethodException ignored) {
        } catch (Exception ignored) {}

        LOGGER.error("OpenAI API call failed for player {}", player.getName().getString(), root);
    }
    

    public List<ResponseInputItem> getPromptList(ServerPlayerEntity player) {
        List<ResponseInputItem> l = new ArrayList<ResponseInputItem>();

        boolean isFollowUp = needsPreviousResponse && !getPreviousResponseId(player).equals(NULL_ID);

        if(!isFollowUp) {
            // prompt engineering roleplaying — server retains it via previousResponseId chain on follow-ups
            l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                    .role(EasyInputMessage.Role.SYSTEM)
                    .content(hardcodedPrompt + "\n" + prompt)
                    .build()));
        }

        if(needsInfo) {
            String jsonString = PlayerDataCollector.collect(player).toString();

            l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                    .role(EasyInputMessage.Role.SYSTEM)
                    .content("The player you are interacting with has their information in JSON format here: \n"
                             + jsonString)
                    .build()));

            l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                    .role(EasyInputMessage.Role.SYSTEM)
                    .content("The history of chat, commands, and game messages is shown here: \n"
                             + ChatMessageHistory.getHistory())
                    .build()));

            l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                        .role(EasyInputMessage.Role.SYSTEM)
                        .content("Here is the information about the blocks near the player's cursor: \n"
                            + ChatBotActions.getBlockInfo(player))
                        .build()));
        }

        if(needsHistory && !isFollowUp) {
            var lf = chatBotPlayerHistory.getInputs(player);

            if(lf != null) {
                l.addAll(lf);
            }
        }

        return l;
    }

    public void setupGeneralCallback(CompletableFuture<Response> response, ServerPlayerEntity player) {
        response.thenAccept(r -> {
            try {
                logResponseShape(r, player);
                setPreviousId(r, player);
                addOutputsToHistory(r, player);
                printOutputs(r, player);
                boolean hadFunctionCalls = ChatBotFunctions.checkForFunctions(r, player, this);
                if(this.needsBuildTools && !hadFunctionCalls) {
                    int placed = ChatBotFunctions.checkForTextualFunctions(r, player, this);
                    if (placed > 0) {
                        this.sendTextualContinuation(placed, player);
                    }
                }

            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    private void logResponseShape(Response r, ServerPlayerEntity player) {
        // Independent counters: an item could in principle carry more than one aspect
        // (e.g. a future API revision exposing reasoning alongside a message). Counting
        // each aspect on its own surfaces that case as totals > items rather than
        // silently undercounting.
        int messages = 0, calls = 0, reasoning = 0, unclassified = 0;
        for (var item : r.output()) {
            boolean matched = false;
            if (item.isFunctionCall())         { calls++;     matched = true; }
            if (item.message().isPresent())    { messages++;  matched = true; }
            if (item.reasoning().isPresent())  { reasoning++; matched = true; }
            if (!matched) unclassified++;
        }
        LOGGER.info("Response id={} for player {}: {} message(s), {} function_call(s), {} reasoning, {} unclassified",
            r.id(), player.getName().getString(), messages, calls, reasoning, unclassified);
    }

    public void setupCustomCallback(CompletableFuture<Response> response, BiConsumer<? super Response, String> callback) {
        if (callback == null) return;
        // thenAccept skips the exceptional branch by design — errors are already
        // logged centrally in sendBuilder's whenComplete.
        response.thenAccept(r -> callback.accept(r, ChatBotFunctions.extractResponseText(r)));
    }

    private void addInput(List<ResponseInputItem> items, ServerPlayerEntity player, ResponseInputItem item) {
        items.add(item);
        chatBotPlayerHistory.addInput(item, player);
    }
    
    private void setPreviousId(Response response, ServerPlayerEntity player) {
        try {
            previousResponseIds.put(player.getUuid(), response.id());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void addOutputsToHistory(Response response, ServerPlayerEntity player) {
        response.output().stream()
            .flatMap(item -> item.message().stream())
            .forEach(message -> {
            chatBotPlayerHistory.addInput(ResponseInputItem.ofResponseOutputMessage(message), player);
        });
        response.output().stream()
            .flatMap(item -> item.reasoning().stream())
            .forEach(reasoning -> {
            chatBotPlayerHistory.addInput(ResponseInputItem.ofReasoning(reasoning), player);
        });
    }

    private void printOutputs(Response response, ServerPlayerEntity player) {
        var text = ChatBotFunctions.extractResponseText(response);
        if(needsBuildTools) {
            text = ChatBotFunctions.stripTextualFunctionCalls(text);
        }
        if(text.isEmpty()) return;
        ChatPrinter.sendMessage(player, "Dieu : " + text);
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
