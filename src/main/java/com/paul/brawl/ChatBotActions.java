package com.paul.brawl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LightningEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

public class ChatBotActions {

    private static final Logger LOGGER = LoggerFactory.getLogger("ChatBotActions");

    private static String message;

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

        message = null;
        LOGGER.info("before " + message);
        manager.executeWithPrefix(source, command);
        LOGGER.info("after " + message);
        return message;

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
        ServerMessageEvents.ALLOW_COMMAND_MESSAGE.register((m, s, p) -> {
            if(message == null) message = m.getSignedContent();
            return true;
        });
    }


}
