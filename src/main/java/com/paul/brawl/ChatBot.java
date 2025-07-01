package com.paul.brawl;

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
import com.openai.models.responses.ResponseInputImage;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBot {

    public static OpenAIClientAsync client;

    public static final String NULL_ID = "null"; 
    public static String previousResponseId = NULL_ID;
    
    public static String PROMPT_STATE_KEY = "prompt_state_key";

    
    private static final Logger LOGGER = LoggerFactory.getLogger("ChatCommand");

    public static final String hardcodedPrompt = """
            Tu joues le rôle de Dieu dans le jeu Minecraft.
            Les joueurs te doivent le respect et si tu ressens
            le moindre irrespect à ton égard, tu dois le punir
            avec la fonction GivePunishment. Sois sévère.
            Tu peux donner des quetes et vérifier s'ils ont bien 
            complétés uniquement avec des preuves infaillibles 
            en image qu'ils vous soumettront. 
            Pour ceux qui réussissent une quete, tu peux leur donner 
            une récompense avec la fonction GiveReward avec minecraft:diamond nombre
            ou un autre item minecraft. Ne donne pas plusieurs fois
            la récompense pour la même quête, et ne donne pas de récompense
            à une quête que tu n'as pas donné.
            Tu peux donner des quêtes avec des qualités différentes que tu classeras en fonction de leur catégorie (exemple quête de construction ou de combat) qui auront chacune 4 niveaux de difficulté que tu déterminera en fonction des demandes de tes fidèles.
            Chaque difficulté aura des récompenses proportionnelles à son niveau et à la manière dont la quête a été accomplie.
            Sois créatif dans tes quêtes.
            Tu ne peux recevoir qu’une seule image en preuve donc tu dois demander une seule image en preuve.
            Ne demande pas de voir des panneaux dans l’image.
            Les demandes d'accomplissement de la quête doivent êtres facile à mettre en place pour le joueur.
            """;
    public static String prompt = "";

    public static void register() {
        // Configures using the `OPENAI_API_KEY`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` environment variables
        client = OpenAIOkHttpClientAsync.fromEnv();
    }

    public static ResponseCreateParams.Builder makeBuilder(ServerPlayerEntity player) {
        var builder = ResponseCreateParams.builder()
            .model(ChatModel.GPT_4O_MINI);
        
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

        getPreviousId(response);

        setupCallback(response, player, callback);

        ChatBotFunctions.setUpCallback(response, player);
        
        return response;
    }

    public static CompletableFuture<Response> sendImageChatRequest(String input, byte[] bytes, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var builder = makeBuilder(player);
        
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

        prompts.add(messageInputItem);

        // Don't save images to history to avoid too many tokens
        //addInput(prompts, player, messageInputItem);

        builder = builder.inputOfResponse(prompts);

        var response = sendBuilder(builder, player, callback);

        return response;

    }
    
    public static CompletableFuture<Response> sendChatRequest(String input, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {

        var builder = makeBuilder(player);
        
        var prompts = getPromptList(player);

        var item = ResponseInputItem
            .ofEasyInputMessage(EasyInputMessage.builder()
            .role(EasyInputMessage.Role.USER)
            .content(input)
            .build());

        addInput(prompts, player, item);

        builder = builder.inputOfResponse(prompts);
        
        var response = sendBuilder(builder, player, callback);

        return response;
    }

    

    public static List<ResponseInputItem> getPromptList(ServerPlayerEntity player) {
        List<ResponseInputItem> l = new ArrayList<ResponseInputItem>();

        // prompt engineering roleplaying
        l.add(ResponseInputItem.ofEasyInputMessage(EasyInputMessage.builder()
                .role(EasyInputMessage.Role.SYSTEM)
                .content(hardcodedPrompt + "\n" + prompt)
                .build()));

        var lf = ChatBotPlayerHistory.getInputs(player);

        if(lf != null) {
            l.addAll(lf);
        }
        return l;
    }

    public static void setupCallback(CompletableFuture<Response> response, ServerPlayerEntity player, BiConsumer<? super Response, String> callback) {
        response.handleAsync(
            (r, ex) -> {
                if (ex == null) {
                    callback.accept(r, getResponseText(r, player));
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
    
    private static void getPreviousId(CompletableFuture<Response> response) {
        response.thenAccept(r -> {
            previousResponseId = r.id();
        });
    }

    private static void addOutputsToHistory(CompletableFuture<Response> response, ServerPlayerEntity player) {
        response.thenAccept(r -> {
            var stream = r.output().stream();
            var stream2 = stream.flatMap(item -> item.message().stream());
            stream2.forEach(message -> {
                ChatBotPlayerHistory.addInput(ResponseInputItem.ofResponseOutputMessage(message), player);
            });
        });
    }


    private static String getResponseText(Response response, ServerPlayerEntity player) {

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

    public void getPlayerLastResponseID(ServerPlayerEntity entity) {

    }

    public void setPlayerLastResponseID(ServerPlayerEntity entity, int id) {
        
    }
    

}
