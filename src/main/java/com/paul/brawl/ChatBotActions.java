package com.paul.brawl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.exceptions.CommandSyntaxException;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.command.argument.BlockArgumentParser;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LightningEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.RegistryWrapper;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3i;
import net.minecraft.world.World;


import com.openai.client.OpenAIClientAsync;
import com.openai.client.okhttp.OpenAIOkHttpClientAsync;
import com.openai.models.ChatModel;
import com.openai.models.responses.EasyInputMessage;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams;
import com.openai.models.responses.ResponseInputImage;
import com.openai.models.responses.ResponseInputItem;

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

        var message = "God has offered you a trade: \n You receive " + giveAmount + " " + giveItemName + " for " + takeAmount + " " + takeItemName;
        ChatPrinter.sendMessage(player, message);

        return "God offered a trade to the player: God gives "
             + giveAmount + " " + giveItemName + " for " + takeAmount + " " + takeItemName
             + "\nThe player may accept or decline this trade.";
    }

    public static String giveItemFromString(ServerPlayerEntity player, String itemName, int amount) {
        
        var item = getItemFromString(itemName);
        if(item == null) {
            return "Reward cancelled, item " + itemName + " does not exist, please try again.";
        }

        giveItem(player, item, amount);

        return "You gave the player a reward: " + amount + " " + itemName;
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
        return "God punished the player  " + amount + " times.";
    }

    public static void smite(ServerPlayerEntity player) {
        if (player == null || player.getWorld() == null) return;
        World world = player.getWorld();
        BlockPos pos = player.getBlockPos();
        LightningEntity lightning = EntityType.LIGHTNING_BOLT.create(world);
        if (lightning != null) {
            lightning.refreshPositionAfterTeleport(pos.getX(), pos.getY(), pos.getZ());
            world.spawnEntity(lightning);
        }
    }

    public static void registerCommandMessageEvent() {

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("block")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("x", IntegerArgumentType.integer())
                    .then(CommandManager.argument("y", IntegerArgumentType.integer())
                    .then(CommandManager.argument("z", IntegerArgumentType.integer())
                        .executes(context -> {
                            int x = IntegerArgumentType.getInteger(context, "x");
                            int y = IntegerArgumentType.getInteger(context, "y");
                            int z = IntegerArgumentType.getInteger(context, "z");
                            placeBlock(context.getSource().getPlayer(), x, y, z, "minecraft:stone");
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
                        ChatBot.buildBot.clearPreviousResponseId(context.getSource().getPlayer());
                        ChatBot.buildBot.chatBotPlayerHistory.popInputs(context.getSource().getPlayer());
                        return Command.SINGLE_SUCCESS;
                    })
            );
        });

    }

    public static void placeLine(ServerPlayerEntity player, int x, int y, int z, int x2, int y2, int z2, String blockType) {

        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return;

        placeLineAt(player, pos, x, y, z, x2, y2, z2, blockType);
    }

    public static void placeBlock(ServerPlayerEntity player, int x, int y, int z, String blockType) {

        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return;

        placeBlockAt(player, pos, x, y, z, blockType);
    }

    public static void placeBlocks(ServerPlayerEntity player, int[] x, int[] y, int[] z, String blockType) {

        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return;

        placeBlocksAt(player, pos, x, y, z, blockType);
    }

    public static void placeBlockAt(ServerPlayerEntity player, BlockPos pivot, int x, int y, int z, String blockType) {
        if (pivot == null) return;
        // BlockPos.add(int, int, int) already returns a new BlockPos — no copy needed.
        changeBlockAtPos(player, blockType, pivot.add(x, y, z));
    }

    public static void placeLineAt(ServerPlayerEntity player, BlockPos pivot, int x, int y, int z, int x2, int y2, int z2, String blockType) {
        if (pivot == null) return;
        int dx = x2 - x;
        int dy = y2 - y;
        int dz = z2 - z;
        int maxLen = Math.max(1, Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz))));
        for (int i = 0; i <= maxLen; i++) {
            int X = x + dx * i / maxLen;
            int Y = y + dy * i / maxLen;
            int Z = z + dz * i / maxLen;
            changeBlockAtPos(player, blockType, pivot.add(X, Y, Z));
        }
    }

    public static void placeBlocksAt(ServerPlayerEntity player, BlockPos pivot, int[] x, int[] y, int[] z, String blockType) {
        if (pivot == null) return;
        for (int i = 0; i < Math.min(x.length, Math.min(y.length, z.length)); i++) {
            changeBlockAtPos(player, blockType, pivot.add(x[i], y[i], z[i]));
        }
    }


    public static String getBlockInfo(ServerPlayerEntity player) {
        StringBuilder sb = new StringBuilder();

        sb.append("Surrounding block info : \n");

        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return "";
        
        var zone = 3;
        sb.append("[\n");
        for(int i = 0; i<zone; i++) {
            for(int j = 0; j<zone; j++) {
                for(int k = zone-1; k>-zone+1; k--) {
                    Vec3i v = new Vec3i(i - zone/2, k - zone/2, j - zone/2);
                    var p = pos.add(v);
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
        if (pos == null) return;
        BlockState state = parseBlockState(player, blockType);
        if (state == null) return;
        player.getWorld().setBlockState(pos, state);
    }

    private static BlockState parseBlockState(ServerPlayerEntity player, String blockType) {
        if (blockType == null || player.getServer() == null) return null;
        RegistryWrapper<Block> wrapper = player.getServer().getRegistryManager()
            .getWrapperOrThrow(RegistryKeys.BLOCK);
        try {
            return BlockArgumentParser.block(wrapper, blockType, false).blockState();
        } catch (CommandSyntaxException e) {
            int bracket = blockType.indexOf('[');
            if (bracket < 0) {
                LOGGER.warn("Failed to parse block {}: {}", blockType, e.getMessage());
                return null;
            }
            String base = blockType.substring(0, bracket);
            LOGGER.warn("Failed to parse blockstate {}, falling back to {}: {}",
                blockType, base, e.getMessage());
            try {
                return BlockArgumentParser.block(wrapper, base, false).blockState();
            } catch (CommandSyntaxException ex) {
                LOGGER.warn("Fallback also failed for {}: {}", base, ex.getMessage());
                return null;
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
