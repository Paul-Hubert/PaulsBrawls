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

import com.google.gson.JsonObject;
import com.openai.client.OpenAIClientAsync;
import com.openai.client.okhttp.OpenAIOkHttpClientAsync;
import com.openai.models.ChatModel;
import com.openai.models.responses.EasyInputMessage;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams;
import com.openai.models.responses.ResponseInputImage;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBot {

    public static OpenAIClientAsync client;

    public static final String NULL_ID = "null"; 
    public static String previousResponseId = NULL_ID;
    
    public static String PROMPT_STATE_KEY = "prompt_state_key";

    
    private static final Logger LOGGER = LoggerFactory.getLogger("ChatCommand");

    public static final String promptPath = "prompt.txt";

    public static String hardcodedPrompt = "";
    public static String prompt = "";

    public static void register() {
        // Configures using the `OPENAI_API_KEY`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` environment variables
        client = OpenAIOkHttpClientAsync.fromEnv();
        
        ChatBot.readPrompt();

        ChatMessageHistory.register();

		ChatCommand.register();

        ChatBotActions.register();
        
		ImageReceiver.commonRegister();

		ImageReceiver.register();

		TradeOffers.register();

    }

    

    public static CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player) {
        return sendImageChatRequest(input, bytes, player, null);
    }

    public static CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var builder = makeBuilder(player);
        
        input = modifyImagePrompt(input);

        String base64url = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(bytes);
        
        ResponseInputImage image = ResponseInputImage.builder()
                .detail(ResponseInputImage.Detail.AUTO)
                .imageUrl(base64url)
                .build();

        ResponseInputItem messageInputItem = ResponseInputItem.ofMessage(ResponseInputItem.Message.builder()
                .role(ResponseInputItem.Message.Role.USER)
                .addInputTextContent(input)
                .addContent(image)
                .build());

        
        var prompts = getPromptList(player);

        //prompts.add(messageInputItem);

        // Don't save images to history to avoid too many tokens
        addInput(prompts, player, messageInputItem);

        builder = builder.inputOfResponse(prompts);

        var response = sendBuilder(builder, player, callback);

        return response;

    }
    
    public static CompletableFuture<Response> sendChatRequest(String input, ServerPlayerEntity player) {
        return sendChatRequest(input, player, null);
    }

    public static CompletableFuture<Response> sendChatRequest(String input, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var item = ResponseInputItem
            .ofEasyInputMessage(EasyInputMessage.builder()
            .role(EasyInputMessage.Role.USER)
            .content(input)
            .build());

        return sendRequest(item, player, callback);
    }


    public static CompletableFuture<Response> sendFunctionOutput(ServerPlayerEntity player) {
        return sendRequest(null, player, null);
    }

    public static CompletableFuture<Response> sendRequest(ResponseInputItem item, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var builder = makeBuilder(player);
        
        var prompts = getPromptList(player);

        if(item != null) addInput(prompts, player, item);

        builder = builder.inputOfResponse(prompts);
        
        var response = sendBuilder(builder, player, callback);

        return response;
    }

    public static ResponseCreateParams.Builder makeBuilder(ServerPlayerEntity player) {
        var builder = ResponseCreateParams.builder()
            .model(ChatModel.GPT_4O);
        
        builder = ChatBotFunctions.registerTools(builder);
        
        /*
        if(!previousResponseId.equals(NULL_ID)) {
            builder = builder.previousResponseId(previousResponseId);
        }
        */

        return builder;
    }

    private static CompletableFuture<Response> sendBuilder(ResponseCreateParams.Builder builder, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        CompletableFuture<Response> response = client.responses().create(builder.build());

        setupCustomCallback(response, callback);

        setupGeneralCallback(response, player);

        return response;
    }
    

    public static List<ResponseInputItem> getPromptList(ServerPlayerEntity player) {
        List<ResponseInputItem> l = new ArrayList<ResponseInputItem>();

        // prompt engineering roleplaying
        l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content(hardcodedPrompt + "\n" + prompt)
                .build()));

        String jsonString = PlayerDataCollector.collect(player).toString();

        l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content("Le joueur avec lequel tu intéragis as ses informations au format json ici : \n"
                         + jsonString)
                .build()));

        l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content("L'historique du chat, des commandes et des messages du jeu est montré ici : \n"
                         + ChatMessageHistory.getHistory())
                .build()));
        
        var lf = ChatBotPlayerHistory.getInputs(player);

        if(lf != null) {
            l.addAll(lf);
        }
        return l;
    }

    public static void setupGeneralCallback(CompletableFuture<Response> response, ServerPlayerEntity player) {
        response.thenAccept(r -> {
            try {
                setPreviousId(r);
                addOutputsToHistory(r, player);
                printOutputs(r, player);
                boolean hadFunctions = ChatBotFunctions.checkForFunctions(r, player);
                
                if(hadFunctions) {
                    sendFunctionOutput(player);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    public static void setupCustomCallback(CompletableFuture<Response> response, BiConsumer<? super Response, String> callback) {
        if(callback == null) return;

        response.handleAsync(
            (r, ex) -> {
                if (ex == null) {
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

    private static void addInput(List<ResponseInputItem> items, ServerPlayerEntity player, ResponseInputItem item) {
        items.add(item);
        ChatBotPlayerHistory.addInput(item, player);
    }
    
    private static void setPreviousId(Response response) {
        previousResponseId = response.id();
    }

    private static void addOutputsToHistory(Response response, ServerPlayerEntity player) {
        response.output().stream()
            .flatMap(item -> item.message().stream())
            .forEach(message -> {
            ChatBotPlayerHistory.addInput(ResponseInputItem.ofResponseOutputMessage(message), player);
        });
    }

    private static void printOutputs(Response response, ServerPlayerEntity player) {
        var text = getResponseText(response);
        if(text.isEmpty()) return;
        ChatPrinter.sendMessage(player, "Dieu : " + text);
    }


    private static String getResponseText(Response response) {

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

    
    public static void readPrompt() {
        try {
            hardcodedPrompt = Files.readString(Path.of(promptPath));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    public static String modifyImagePrompt(String s) {
        if(s.contains("prouver :")) {
            return Prompts.proofPrompt + s;
        } else if(s.contains("construire :")) {
            return Prompts.buildPrompt + s;
        }
        return s;
    }
    

}
