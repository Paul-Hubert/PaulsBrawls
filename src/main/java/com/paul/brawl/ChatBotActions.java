package com.paul.brawl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
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
import net.minecraft.util.math.Vec3i;
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
                    .then(CommandManager.argument("x", IntegerArgumentType.integer())
                    .then(CommandManager.argument("y", IntegerArgumentType.integer())
                    .then(CommandManager.argument("z", IntegerArgumentType.integer())
                        .executes(context -> {
                            int x = IntegerArgumentType.getInteger(context, "x");
                            int y = IntegerArgumentType.getInteger(context, "y");
                            int z = IntegerArgumentType.getInteger(context, "z");
                            placeBlockAtImageSpots(context.getSource().getPlayer(), new int[] {x}, new int[] {y}, new int[] {z}, "minecraft:stone");
                            return Command.SINGLE_SUCCESS;
                        }))))
            );
        });

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("construction")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .executes(context -> {
                        Raycaster.setLastPos(context.getSource().getPlayer());
                        return Command.SINGLE_SUCCESS;
                    })
            );
        });

    }



    public static void placeBlockAtImageSpots(ServerPlayerEntity player, int[] x, int[] y, int[] z, String blockType) {
        
        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return;
        
        for(int i = 0; i<Math.min(x.length, Math.min(y.length, z.length)); i++) {
            var X = x[i];
            var Y = y[i];
            var Z = z[i];
            var p = new BlockPos(pos).add(X, Y, Z);
            changeBlockAtPos(player, blockType, p);
        }
    }


    public static String getBlockInfo(ServerPlayerEntity player) {
        StringBuilder sb = new StringBuilder();

        sb.append("Surrounding block info : \n");

        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return "";
        
        var zone = 16;
        sb.append("[\n");
        for(int i = 0; i<zone; i++) {
            for(int j = 0; j<zone; j++) {
                for(int k = zone-1; k>-zone+1; k--) {
                    Vec3i v = new Vec3i(i - zone/2, k - zone/2, j - zone/2);
                    var p = new BlockPos(pos).add(v);
                    BlockState state = player.getWorld().getBlockState(p);
                    if(state.isAir()) {
                        continue;
                    } else {
                        var name = state.getBlock().asItem().toString();
                        sb.append("\"{x:" + v.getX() + ", y:" + v.getY() + ", z:" + v.getZ() + ", block: " + name + ",\n");
                        break;
                    }
                }
            }
        }
        sb.append("]");
        return sb.toString();
    }



    public static void changeBlockAtPos(ServerPlayerEntity player, String blockType, BlockPos pos) {
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
