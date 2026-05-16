package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.function.BiConsumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.openai.client.OpenAIClientAsync;
import com.openai.client.okhttp.OpenAIOkHttpClientAsync;
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
    public String previousResponseId = NULL_ID;
    
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

        ChatMessageHistory.register();

		ChatCommand.register();

        ChatBotActions.register();
        
		ImageReceiver.commonRegister();

		ImageReceiver.register();

		TradeOffers.register();

    }


    public ChatBot(String promptPath) {
        this.promptPath = promptPath;

        client = OpenAIOkHttpClientAsync.fromEnv();
        readPrompt();
    }
    

    public CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player) {
        return sendImageChatRequest(input, bytes, player, null);
    }

    public CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var builder = buildBuilder();

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


    public CompletableFuture<Response> sendFunctionOutput(String ret, ResponseFunctionToolCall function, ServerPlayerEntity player) {
        
        var builder = makeBuilder();

        builder = setPreviousResonse(builder);
        
        List<ResponseInputItem> l = new ArrayList<ResponseInputItem>();

        //l.add(ResponseInputItem.ofFunctionCall(function));
        l.add(ResponseInputItem.ofFunctionCallOutput(ResponseInputItem.FunctionCallOutput.builder()
            .callId(function.callId())
            .outputAsJson(ret)
            .build()));

        builder = builder.inputOfResponse(l);
        
        var response = sendBuilder(builder, player, null);

        return response;

    }

    public CompletableFuture<Response> sendRequest(ResponseInputItem item, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var builder = buildBuilder();
        
        var prompts = getPromptList(player);

        if(item != null) addInput(prompts, player, item);

        builder = builder.inputOfResponse(prompts);
        
        var response = sendBuilder(builder, player, callback);

        return response;
    }

    public ResponseCreateParams.Builder makeBuilder() {
        var builder = ResponseCreateParams.builder()
        .model(ChatModel.of("gpt-5.5"));//openai/gpt-oss-20b
        return builder;
    }

    public ResponseCreateParams.Builder buildTools(ResponseCreateParams.Builder builder) {
        if(needsBuildTools) {
            builder = ChatBotFunctions.registerBuildTools(builder);
        }

        if(needsBuildTools) {
            builder = ChatBotFunctions.registerGodTools(builder);
        }
        return builder;
    }

    public ResponseCreateParams.Builder setPreviousResonse(ResponseCreateParams.Builder builder) {
        if(needsPreviousResponse && !previousResponseId.equals(NULL_ID)) {
            builder = builder.previousResponseId(previousResponseId);
        }
        return builder;
    }

    public ResponseCreateParams.Builder buildBuilder() {
        var builder = makeBuilder();
        
        builder = buildTools(builder);
        
        builder = setPreviousResonse(builder);
        
        return builder;
    }

    private CompletableFuture<Response> sendBuilder(ResponseCreateParams.Builder builder, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        CompletableFuture<Response> response = client.responses().create(builder.build());

        setupCustomCallback(response, callback);

        setupGeneralCallback(response, player);

        return response;
    }
    

    public List<ResponseInputItem> getPromptList(ServerPlayerEntity player) {
        List<ResponseInputItem> l = new ArrayList<ResponseInputItem>();

        // prompt engineering roleplaying
        l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content(hardcodedPrompt + "\n" + prompt)
                .build()));

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
        
        if(needsHistory) {
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
                setPreviousId(r);
                addOutputsToHistory(r, player);
                printOutputs(r, player);
                ChatBotFunctions.checkForFunctions(r, player, this);
                
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    public void setupCustomCallback(CompletableFuture<Response> response, BiConsumer<? super Response, String> callback) {
        
        response.handleAsync(
            (r, ex) -> {
                if (ex == null && callback != null) {
                    callback.accept(r, getResponseText(r));
                    return 1L;
                } else {
                    LOGGER.error(ex.getMessage());
                    ex.printStackTrace();
                    return -1L;
                }
            }
        );
    }

    private void addInput(List<ResponseInputItem> items, ServerPlayerEntity player, ResponseInputItem item) {
        items.add(item);
        chatBotPlayerHistory.addInput(item, player);
    }
    
    private void setPreviousId(Response response) {
        try {
            previousResponseId = response.id();
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
        var text = getResponseText(response);
        if(text.isEmpty()) return;
        ChatPrinter.sendMessage(player, "Dieu : " + text);
    }


    private String getResponseText(Response response) {

        StringBuilder builder = new StringBuilder();

        response.output().stream()
                .flatMap(item -> item.message().stream())
                .flatMap(message -> message.content().stream())
                .flatMap(content -> content.outputText().stream())
                .forEach(outputText -> {
                    var str = outputText.text();
                    builder.append(str);
                    builder.append("\n");
                });

        return builder.toString();
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
