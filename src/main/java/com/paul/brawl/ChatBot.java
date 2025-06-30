package com.paul.brawl;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.openai.client.OpenAIClientAsync;
import com.openai.client.okhttp.OpenAIOkHttpClientAsync;
import com.openai.models.ChatModel;
import com.openai.models.responses.EasyInputMessage;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams;
import com.openai.models.responses.ResponseInputImage;
import com.openai.models.responses.ResponseInputItem;

public class ChatBot {

    public static OpenAIClientAsync client;

    public static final String NULL_ID = "null"; 
    public static String previousResponseId = NULL_ID;
    
    public static String PROMPT_STATE_KEY = "prompt_state_key";

    
    private static final Logger LOGGER = LoggerFactory.getLogger("ChatCommand");

    public static final String hardcodedPrompt = "Tu joues le rôle de Dieu dans le jeu Minecraft. Les joueurs te doivent le respect et si tu ressens le moindre irrespect à ton égard, tu dois écrire !mal. Si le joueur a un bon comportement, obéis à Dieu et lui parle respectueusement, écris !bien. Sois sévère. Tu peux donner des quetes et vérifier s'ils sont bien complétés uniquement avec des preuves infaillibles en image qu'ils vous soumettront. Pour ceux qui réussissent une quete, tu peux leur donner une récompense avec !donne minecraft:diamond ou un autre item minecraft";
    public static String prompt = "";

    public static void register() {
        // Configures using the `OPENAI_API_KEY`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` environment variables
        client = OpenAIOkHttpClientAsync.fromEnv();

    }

    public static ResponseCreateParams.Builder makeBuilder() {
        var builder = ResponseCreateParams.builder()
            .model(ChatModel.GPT_4_1);

        if(!previousResponseId.equals(NULL_ID)) {
            builder = builder.previousResponseId(previousResponseId);
        }

        return builder;
    }

    private static CompletableFuture<Response> sendBuilder(ResponseCreateParams.Builder builder, Consumer<? super Response> callback) {

        CompletableFuture<Response> response = client.responses().create(builder.build());

        getPreviousId(response);

        setupCallback(response, callback);
        
        return response;
    }

    private static void getPreviousId(CompletableFuture<Response> response) {
        response.thenAccept(r -> {
            previousResponseId = r.id();
        });
    }

    public static CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, Consumer<? super Response> callback) {

        var builder = makeBuilder();
        
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

        
        var prompts = getPromptList();
        prompts.add(messageInputItem);

        builder = builder.inputOfResponse(prompts);

        var response = sendBuilder(builder, callback);

        return response;

    }
    
    public static CompletableFuture<Response> sendChatRequest(String input, Consumer<? super Response> callback) {

        var builder = makeBuilder();
        
        var prompts = getPromptList();

        prompts.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.USER)
                .content(input)
                .build()));
        
        builder.inputOfResponse(prompts);
        
        var response = sendBuilder(builder, callback);

        return response;
    }

    public static List<ResponseInputItem> getPromptList() {
        List<ResponseInputItem> l = new ArrayList<ResponseInputItem>();

        // prompt engineering roleplaying
        l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content(hardcodedPrompt + "\n" + prompt)
                .build()));
        return l;
    }

    public static void setupCallback(CompletableFuture<Response> response, Consumer<? super Response> callback) {
        response.handleAsync(
            (r, ex) -> {
                if (ex == null) {
                    callback.accept(r);
                    return 1L;
                } else {
                    LOGGER.error(ex.getMessage());
                    ex.printStackTrace();
                    return -1L;
                }
            }
        );
    }

    public static String getResponseText(Response response) {

        StringBuilder builder = new StringBuilder();

        response.output().stream()
                .flatMap(item -> item.message().stream())
                .flatMap(message -> message.content().stream())
                .flatMap(content -> content.outputText().stream())
                .forEach(outputText -> {
                    builder.append(outputText.text());
                    builder.append("\n");
                });

        return builder.toString();
    }

    

}
