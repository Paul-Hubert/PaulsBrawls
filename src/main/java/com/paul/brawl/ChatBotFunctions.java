package com.paul.brawl;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams.Builder;
import com.openai.models.responses.ResponseFunctionToolCall;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBotFunctions {

    @JsonClassDescription("Gives a good reward to the player.")
    static class GiveReward {
        @JsonPropertyDescription("The name of the item to give. Example: minecraft:diamond")
        public String itemName;
        @JsonPropertyDescription("The amount of itemName to give to the player.")
        public int amount;

        public GiveReward execute(ServerPlayerEntity player) {
            ChatBotActions.giveItem(player, itemName, amount);
            return this;
        }

        public String toString() {
            return "Gave " + amount + " times " + itemName + " to the player.";
        }
    }

    @JsonClassDescription("Punishes the player.")
    static class GivePunishment {
        @JsonPropertyDescription("The amount of punishments to give to the player.")
        public int amount;

        public GivePunishment execute(ServerPlayerEntity player) {
            ChatBotActions.smite(player, amount);
            return this;
        }

        public String toString() {
            return "Punished the player.";
        }
    }

    @JsonClassDescription("Gives a reward to the player.")
    static class BadReward {
        @JsonPropertyDescription("The name of the item to give. Example: minecraft:diamond")
        public String itemName;
        @JsonPropertyDescription("The amount of itemName to give to the player.")
        public int amount;

        public GiveReward execute() {
            return copy();
        }

        public void apply(ServerPlayerEntity player) {
            ChatBotActions.giveItem(player, itemName, amount);
        }

        public GiveReward copy() {
            var c = new GiveReward();
            c.itemName = itemName;
            c.amount = amount;
            return c;
        }
    }

    public static Builder registerTools(Builder builder) {
        return builder
            .addTool(GivePunishment.class)
            .addTool(GiveReward.class);
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
            case "GiveReward":
                ret = function.arguments(GiveReward.class).execute(player);
                break;
            case "GivePunishment":
                ret = function.arguments(GivePunishment.class).execute(player);
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
