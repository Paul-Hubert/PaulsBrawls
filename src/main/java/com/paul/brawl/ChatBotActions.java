package com.paul.brawl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.FloatArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.block.Block;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LightningEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

public class ChatBotActions {

    private static final Logger LOGGER = LoggerFactory.getLogger("ChatBotActions");

    public static void register() {
        registerCommandMessageEvent();
    }

    public static void giveGoodReward(ServerPlayerEntity player) {
        giveItem(player, Money.MONEY, 10);
    }

    public static void giveBadReward(ServerPlayerEntity player) {
        smite(player);
    }

    public static String sendTradeOffer(ServerPlayerEntity player, String giveItemName, int giveAmount, String takeItemName, int takeAmount) {
        var error = TradeOffers.updateOffer(player, giveItemName, giveAmount, takeItemName, takeAmount);
        if(error != null) {
            return error;
        }

        var message = "Dieu t'a proposé un échange : \n Tu reçois " + giveAmount + " " + giveItemName + " contre " + takeAmount + " " + takeItemName;
        ChatPrinter.sendMessage(player, message);

        return "Dieu a proposé un échange au joueur : Dieu donne "
             + giveAmount + " " + giveItemName + " contre " + takeAmount + " " + takeItemName
             + "\nLe joueur peut accepter, ou non, cet échange.";
    }

    public static String giveItemFromString(ServerPlayerEntity player, String itemName, int amount) {
        
        var item = getItemFromString(itemName);
        if(item == null) {
            return "Récompense annulée, l'item " + itemName + " n'existe pas, veuillez rééssayer.";
        }

        giveItem(player, item, amount);

        return "Vous avez donné une récompense au joueur : " + amount + " " + itemName;
    }

    public static String giveItemWithCommand(ServerPlayerEntity player, String item, int amount) {

        var command = "/give " + player.getName().getString() + " " + item + " " + amount;
        
        var manager = player.getServer().getCommandManager();
        var source = player.getServer().getCommandSource();

        manager.executeWithPrefix(source, command);
        return "";

    }


    public static void giveItem(ServerPlayerEntity player, Item item, int amount) {
        player.giveItemStack(new ItemStack(item, amount));
    }

    public static String[] stripArguments(String str, String commandName) {
        var strs = str.split(commandName + " ", 1);
        if(strs.length < 2) return null;
        var second = strs[1];

        strs = second.split(" ");
        return strs;
    }

    public static Item getItemFromString(String str) {
        if (str == null) {
            LOGGER.error("Invalid item string: " + str);
            return null;
        }

        var strs = str.split(":");
        if(strs.length < 2) {
            LOGGER.error("Invalid item string: " + str);
            return null;
        }
        var nameSpace = strs[0];
        var name = strs[1];

        // Get a Minecraft Item instance from a string like "minecraft:stone"
        Identifier id;
        try {
            id = Identifier.of(nameSpace, name);
            return Registries.ITEM.getOrEmpty(id).orElse(null);
        } catch (Exception e) {
            LOGGER.error("Invalid item string: " + str + " Exception " + e);
            return null;
        }
    }

    public static String smite(ServerPlayerEntity player, int amount) {
        for(int i = 0; i<amount; i++) {
            smite(player);
        }
        return "Dieu a puni le joueur " + amount + " fois.";
    }

    public static void smite(ServerPlayerEntity player) {
        if (player != null && player.getWorld() != null) {
            if (player != null && player.getWorld() != null) {
                World world = player.getWorld();
                BlockPos pos = player.getBlockPos();
                LightningEntity lightning = EntityType.LIGHTNING_BOLT.create(world);
                if (lightning != null) {
                    lightning.refreshPositionAfterTeleport(pos.getX(), pos.getY(), pos.getZ());
                    world.spawnEntity(lightning);
                }
            }
        }
    }

    public static void registerCommandMessageEvent() {

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("bloc")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("x", FloatArgumentType.floatArg())
                    .then(CommandManager.argument("y", FloatArgumentType.floatArg())
                        .executes(context -> {
                            float x = FloatArgumentType.getFloat(context, "x");
                            float y = FloatArgumentType.getFloat(context, "y");
                            placeBlockAtImageSpot(context.getSource().getPlayer(), x, y, "minecraft:stone");
                            return Command.SINGLE_SUCCESS;
                        })))
            );
        });

    }

    public static void placeBlockAtImageSpots(ServerPlayerEntity player, float[] x, float[] y, String blockType) {
        for(int i = 0; i<Math.min(x.length, x.length); i++) {
            var X = x[i];
            var Y = y[i];
            placeBlockAtImageSpot(player, X, Y, blockType);
        }
    }

    public static void placeBlockAtImageSpot(ServerPlayerEntity player, float x, float y, String blockType) {

        BlockPos pos = Raycaster.raycast(player, x, y);

        if (pos != null) {
            Item blockItem = getItemFromString(blockType);
            if (blockItem != null) {
                Block block = Block.getBlockFromItem(blockItem);
                if (block != null) {
                    player.getWorld().setBlockState(pos, block.getDefaultState());
                }
            }
        }


    }


    public static String changeWeather(ServerPlayerEntity player, String weatherType, int durationSeconds) {
        if (player == null || player.getServer() == null) {
            return "Impossible de changer la météo : joueur ou serveur invalide.";
        }
        String command = "/weather " + weatherType.toLowerCase() + " " + durationSeconds;
        player.getServer().getCommandManager().executeWithPrefix(
            player.getServer().getCommandSource(),
            command
        );
        return "La météo a été changée en " + weatherType + " pour " + (durationSeconds > 0 ? durationSeconds + " secondes." : "une durée indéterminée.");
    }

}
