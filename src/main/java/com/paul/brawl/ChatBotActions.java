package com.paul.brawl;

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
    
    public static boolean checkForCommands(String str, ServerPlayerEntity player) {
        if(str.contains("!bien")) {
            giveGoodReward(player);
            return true;
        } if(str.contains("!mal")) {
            giveBadReward(player);
            return true;
        } if(str.contains("!donne")) {

            var args = stripArguments(str, "!donne");
            Item item = getItemFromString(args[0]);
            if(item == null) {
                return false;
            }

            int amount = 1;
            try {
                amount = Integer.parseInt(args[1]);
            } catch(Exception e) {}
            
            giveItem(player, item, amount);

            return true;
        }
        return false;
    }

    public static void giveGoodReward(ServerPlayerEntity player) {
        giveItem(player, Money.MONEY, 10);
    }

    public static void giveBadReward(ServerPlayerEntity player) {
        smite(player);
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
        if (str == null) return null;

        var strs = str.split(":");
        if(strs.length < 2) {
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
            return null;
        }
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


}
