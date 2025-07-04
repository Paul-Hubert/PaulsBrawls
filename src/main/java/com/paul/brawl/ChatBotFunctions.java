package com.paul.brawl;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams.Builder;
import com.openai.models.responses.ResponseFunctionToolCall;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBotFunctions {

    @JsonClassDescription("Donne une récompense au joueur sous forme d'item.")
    static class Recompense {
        @JsonPropertyDescription("Le nom de l'item à donner. Exemples: minecraft:diamond, minecraft:enchanted_book[minecraft:enchantments={mending: 1, sharpness: 4, unbreaking: 3}]")
        public String itemName;
        @JsonPropertyDescription("Le nombre d'item à donner.")
        public int amount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.giveItemFromString(player, itemName, amount);
        }
    }

    @JsonClassDescription("Propose un échange au joueur.")
    static class Echange {
        @JsonPropertyDescription("Le nom de l'item à donner au joueur en échange. Exemple: minecraft:diamond")
        public String giveItemName;
        @JsonPropertyDescription("Le nombre d'item à donner au joueur en échange.")
        public int giveAmount;

        @JsonPropertyDescription("Le nom de l'item à prendre au joueur en échange. Exemple: minecraft:diamond")
        public String takeItemName;
        @JsonPropertyDescription("Le nombre d'item à prendre au joueur en échange.")
        public int takeAmount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.sendTradeOffer(player, giveItemName, giveAmount, takeItemName, takeAmount);
        }
    }

    @JsonClassDescription("Propose un échange au joueur.")
    static class Punition {
        @JsonPropertyDescription("Le nombre de punitions à infliger au joueur.")
        public int amount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.smite(player, amount);
        }
    }

    public static Builder registerTools(Builder builder) {
        return builder
            .addTool(Recompense.class)
            .addTool(Echange.class)
            .addTool(Punition.class);
    }

    private static boolean hadFunctionCall = false;
    public static boolean checkForFunctions(Response r, ServerPlayerEntity player) {
        hadFunctionCall = false;
        r.output().forEach(item -> {
            if (item.isFunctionCall()) {
                ResponseFunctionToolCall functionCall = item.asFunctionCall();
                boolean wasFunctionCall = callFunction(functionCall, player);
                if(wasFunctionCall) hadFunctionCall = true;
            }
        });
        return hadFunctionCall;
    }

    private static boolean callFunction(ResponseFunctionToolCall function, ServerPlayerEntity player) {
        String ret = null;
        switch (function.name()) {
            case "Recompense":
                ret = function.arguments(Recompense.class).execute(player);
                break;
            case "Echange":
                ret = function.arguments(Echange.class).execute(player);
                break;
            case "Punition":
                ret = function.arguments(Punition.class).execute(player);
                break;
            default:
                throw new IllegalArgumentException("Unknown function: " + function.name());
        }
        addFunctionReturn(ret, function, player);
        return true;
    }

    private static void addFunctionReturn(String ret, ResponseFunctionToolCall function, ServerPlayerEntity player) {
        
        var item1 = ResponseInputItem.ofFunctionCall(function);
        ChatBotPlayerHistory.addInput(item1, player);
        var item2 = ResponseInputItem.ofFunctionCallOutput(ResponseInputItem.FunctionCallOutput.builder()
            .callId(function.callId())
            .outputAsJson(ret)
            .build());
        ChatBotPlayerHistory.addInput(item2, player);
        
    }

}
