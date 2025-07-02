package com.paul.brawl;

import java.util.concurrent.CompletableFuture;

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
        @JsonPropertyDescription("The name of the item to give. Example: minecraft:diamond")
        public String itemName;
        @JsonPropertyDescription("The amount of itemName to give to the player.")
        public int amount;

        public Recompense execute(ServerPlayerEntity player) {
            ChatBotActions.giveItemFromString(player, itemName, amount);
            return this;
        }

        public String toString() {
            return "Dieu a donné " + amount + " " + itemName + " au joueur.";
        }
    }

    @JsonClassDescription("Punis le joueur")
    static class Punition {
        @JsonPropertyDescription("Le nombre de punitions.")
        public int amount;

        public Punition execute(ServerPlayerEntity player) {
            ChatBotActions.smite(player, amount);
            return this;
        }

        public String toString() {
            return "Dieu a puni le joueur.";
        }
    }

    public static Builder registerTools(Builder builder) {
        return builder
            .addTool(Recompense.class)
            .addTool(Punition.class);
    }

    public static void setUpCallback(CompletableFuture<Response> response, ServerPlayerEntity player) {
        response.thenAccept(r -> {
            r.output().forEach(item -> {
                if (item.isFunctionCall()) {
                    ResponseFunctionToolCall functionCall = item.asFunctionCall();
                    callFunction(functionCall, player);
                }
            });
        });
    }

    private static void callFunction(ResponseFunctionToolCall function, ServerPlayerEntity player) {
        Object ret = null;
        switch (function.name()) {
            case "Recompense":
                ret = function.arguments(Recompense.class).execute(player);
                break;
            case "Punition":
                ret = function.arguments(Punition.class).execute(player);
                break;
            default:
                throw new IllegalArgumentException("Unknown function: " + function.name());
        }
        addFunctionReturn(ret.toString(), function, player);
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
