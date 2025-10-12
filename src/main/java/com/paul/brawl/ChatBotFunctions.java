package com.paul.brawl;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams.Builder;
import com.openai.models.responses.ResponseFunctionToolCall;
import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.math.BlockPos;

public class ChatBotFunctions {

    @JsonClassDescription("Gives a reward to the player in the form of an item.")
    static class Reward {
        @JsonPropertyDescription("The name of the item to give. Examples: minecraft:diamond, minecraft:enchanted_book[minecraft:enchantments={mending: 1, sharpness: 4, unbreaking: 3}]")
        public String itemName;
        @JsonPropertyDescription("The number of items to give.")
        public int amount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.giveItemFromString(player, itemName, amount);
        }
    }

    @JsonClassDescription("Offers a trade to the player.")
    static class Trade {
        @JsonPropertyDescription("The name of the item to give to the player in the trade. Example: minecraft:diamond")
        public String giveItemName;
        @JsonPropertyDescription("The number of items to give to the player in the trade.")
        public int giveAmount;

        @JsonPropertyDescription("The name of the item to take from the player in the trade. Example: minecraft:diamond")
        public String takeItemName;
        @JsonPropertyDescription("The number of items to take from the player in the trade.")
        public int takeAmount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.sendTradeOffer(player, giveItemName, giveAmount, takeItemName, takeAmount);
        }
    }

    @JsonClassDescription("Punishes the player by inflicting a number of punishments.")
    static class Punishment {
        @JsonPropertyDescription("The number of punishments to inflict to the player.")
        public int amount;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.smite(player, amount);
        }
    }

    @JsonClassDescription("Changes the weather of the player's world.")
    static class ChangeWeather {
        @JsonPropertyDescription("Type of weather to set. Examples: clear, rain, thunder")
        public String weatherType;
        @JsonPropertyDescription("Weather duration in seconds. 0 for permanent.")
        public int durationSeconds;

        public String execute(ServerPlayerEntity player) {
            return ChatBotActions.changeWeather(player, weatherType, durationSeconds);
        }
    }

    @JsonClassDescription("Place a block at a chosen location, relative to the user defined pivot of the construction.")
    static class Place {
        @JsonPropertyDescription("X coordinate of the chosen position relative to the user defined pivot of the construction.")
        public int[] x;
        @JsonPropertyDescription("Y coordinate of the chosen position relative to the user defined pivot of the construction.")
        public int[] y;
        @JsonPropertyDescription("Z coordinate of the chosen position relative to the user defined pivot of the construction.")
        public int[] z;
        @JsonPropertyDescription("Type of block to place. Example: minecraft:stone")
        public String blockType;

        public String execute(ServerPlayerEntity player) {
            ChatBotActions.placeBlockAtImageSpots(player, x, y, z, blockType);
            return "Block placed.";
        }
    }

    /*
    @JsonClassDescription("Fill a cube of blocks at a chosen location on an image.")
    static class FillCube {
        @JsonPropertyDescription("X coordinate of the beginning of the line.")
        public int x;
        @JsonPropertyDescription("Y coordinate of the beginning of the line.")
        public int y;
        @JsonPropertyDescription("Z coordinate of the beginning of the line.")
        public int z;
        @JsonPropertyDescription("X coordinate of the end of the line.")
        public int x2;
        @JsonPropertyDescription("Y coordinate of the end of the line.")
        public int y2;
        @JsonPropertyDescription("Z coordinate of the end of the line.")
        public int z2; 
        @JsonPropertyDescription("Type of block to place. Example: minecraft:stone")
        public String blockType;

        public String execute(ServerPlayerEntity player) {
            ChatBotActions.placeBlockAtImageSpots(player, x, y, z, blockType);
            return "Block placed.";
        }
    }
    */

    public static Builder registerTools(Builder builder) {
        return builder
            .addTool(Reward.class)
            .addTool(Trade.class)
            .addTool(Punishment.class)
            .addTool(ChangeWeather.class)
            .addTool(Place.class);
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
            case "Reward":
                ret = function.arguments(Reward.class).execute(player);
                break;
            case "Trade":
                ret = function.arguments(Trade.class).execute(player);
                break;
            case "Punishment":
                ret = function.arguments(Punishment.class).execute(player);
                break;
            case "ChangeWeather":
                ret = function.arguments(ChangeWeather.class).execute(player);
                break;
            case "Place":
                ret = function.arguments(Place.class).execute(player);
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
