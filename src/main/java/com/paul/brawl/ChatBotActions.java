package com.paul.brawl;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.exceptions.CommandSyntaxException;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.command.CommandRegistryAccess;
import net.minecraft.command.argument.BlockArgumentParser;
import net.minecraft.command.argument.ItemStackArgument;
import net.minecraft.command.argument.ItemStackArgumentType;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LightningEntity;
import net.minecraft.entity.mob.MobEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.RegistryWrapper;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3i;
import net.minecraft.world.World;


public class ChatBotActions {

    private static final Logger LOGGER = LoggerFactory.getLogger("ChatBotActions");

    /**
     * Latest known {@link MinecraftServer}, captured during server start/stop
     * lifecycle (see {@link ServerEntryPoint}). Lets off-thread callers (the
     * idle watchdog, /llm-driven kill switch) look up the bot avatar without
     * holding a player reference.
     */
    private static volatile MinecraftServer SERVER;

    public static void setServer(MinecraftServer server) { SERVER = server; }
    public static MinecraftServer server() { return SERVER; }

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

        var message = "God has offered you a trade: \n You receive " + giveAmount + " " + giveItemName + " for " + takeAmount + " " + takeItemName + "\n Type /accept within " + (TradeOffers.OFFER_TTL_MILLIS / 60_000) + " minutes.";
        ChatPrinter.sendMessage(player, message);

        return "God offered a trade to the player: God gives "
             + giveAmount + " " + giveItemName + " for " + takeAmount + " " + takeItemName
             + "\nThe player may accept or decline this trade.";
    }

    /**
     * Reward. Bug #6: the amount is clamped to {@code BridgeConfig.rewardMax} and the item string is parsed by the
     * same parser as {@code /give}, so the advertised component syntax
     * ({@code minecraft:enchanted_book[minecraft:enchantments={…}]}) and a bare {@code diamond} both work — splitting
     * on {@code ':'} made the former fail every time. Stacks are split to the item's max size and anything that does
     * not fit is dropped at the player's feet. Main thread only (dispatched through runOnMain).
     */
    public static String giveItemFromString(ServerPlayerEntity player, String itemName, int amount) {
        if (amount < 1) {
            return "Reward cancelled, amount must be at least 1 (got " + amount + ").";
        }
        int clamped = GodClamps.rewardAmount(amount, BridgeConfig.INSTANCE.rewardMax);
        ItemStack template = parseItemStack(player.getServer(), itemName);
        if (template == null) {
            return "Reward cancelled, item " + itemName + " does not exist or is malformed, please try again.";
        }
        int left = clamped;
        while (left > 0) {
            int n = Math.min(left, Math.max(1, template.getMaxCount()));
            player.getInventory().offerOrDrop(template.copyWithCount(n));
            left -= n;
        }
        String note = clamped < amount ? " (limité à " + clamped + " sur " + amount + " demandés)" : "";
        return "You gave the player a reward: " + clamped + " " + itemName + note;
    }

    /** Parse an item string exactly like {@code /give} (namespace optional, item components allowed); null if bad. */
    public static ItemStack parseItemStack(MinecraftServer server, String itemString) {
        if (server == null || itemString == null || itemString.isBlank()) return null;
        try {
            CommandRegistryAccess access = CommandRegistryAccess.of(
                server.getRegistryManager(), server.getSaveProperties().getEnabledFeatures());
            ItemStackArgument arg = ItemStackArgumentType.itemStack(access).parse(new StringReader(itemString.trim()));
            return arg.createStack(1, false);
        } catch (CommandSyntaxException e) {
            LOGGER.warn("Invalid item string {}: {}", itemString, e.getMessage());
            return null;
        }
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

        // Bug #6: the registry id only — components/NBT stripped, namespace defaulted (ItemIds, unit-tested).
        // Splitting on ':' broke "ns:item[ns:component=…]" and a bare "diamond".
        String base = ItemIds.baseId(str);
        Identifier id = base == null ? null : Identifier.tryParse(base);
        if (id == null) {
            LOGGER.error("Invalid item string: " + str);
            return null;
        }
        try {
            return Registries.ITEM.getOrEmpty(id).orElse(null);
        } catch (Exception e) {
            LOGGER.error("Invalid item string: " + str + " Exception " + e);
            return null;
        }
    }

    /** Bug #6: strikes are clamped to {@code BridgeConfig.punishmentMax} (any number used to land in one tick). */
    public static String smite(ServerPlayerEntity player, int amount) {
        int strikes = GodClamps.punishments(amount, BridgeConfig.INSTANCE.punishmentMax);
        for(int i = 0; i<strikes; i++) {
            smite(player);
        }
        String note = strikes < amount ? " (limité à " + strikes + " sur " + amount + " demandés)" : "";
        return "God punished the player " + strikes + " times." + note;
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
                        // Under LangChain4j the per-player conversation lives in the
                        // mod, so clearing the chain is just dropping the memory window.
                        ChatBot.buildBot.clearMemory(context.getSource().getPlayer());
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

    /**
     * Spawn {@code count} of {@code entityType} near {@code player} at a block
     * offset. Runs server-side (no bridge dependency) — picked because the
     * MCP server has no /summon tool and a single canonical path avoids
     * drift. Must run on the main thread (see GOD_BOT_INTEGRATION_PLAN.md §6a,
     * §7); caller is expected to wrap via {@link GodActionQueue}.
     */
    public static String spawnCreature(ServerPlayerEntity player, String entityType, int count, int x, int y, int z) {
        if (player == null || !(player.getWorld() instanceof ServerWorld world)) {
            return "Impossible de spawner : joueur ou monde invalide.";
        }
        if (entityType == null || entityType.isBlank()) {
            return "Spawn annulé : entityType vide.";
        }

        Identifier id;
        try {
            id = Identifier.of(entityType.trim());
        } catch (Exception e) {
            return "Spawn annulé : identifiant invalide '" + entityType + "'.";
        }
        EntityType<?> type = Registries.ENTITY_TYPE.getOrEmpty(id).orElse(null);
        if (type == null) {
            return "Spawn annulé : type d'entité inconnu '" + entityType + "'.";
        }

        int clamped = Math.max(1, Math.min(count, Math.max(1, BridgeConfig.INSTANCE.spawnCountMax)));
        // Bug #6: offsets clamped to ±spawnOffsetMax per axis (the model could spawn anywhere in the world).
        int max = BridgeConfig.INSTANCE.spawnOffsetMax;
        BlockPos basePos = player.getBlockPos().add(
            GodClamps.spawnOffset(x, max), GodClamps.spawnOffset(y, max), GodClamps.spawnOffset(z, max));

        boolean griefAllowed = BridgeConfig.INSTANCE.creatureGriefingAllowed;

        int spawned = 0;
        for (int i = 0; i < clamped; i++) {
            // Fan creatures out by ±1 block so a count > 1 doesn't stack at one pos.
            BlockPos spawnPos = basePos.add((i % 3) - 1, 0, (i / 3) % 3 - 1);
            Entity entity = type.create(world);
            if (entity == null) continue;
            entity.refreshPositionAndAngles(
                spawnPos.getX() + 0.5,
                spawnPos.getY(),
                spawnPos.getZ() + 0.5,
                player.getYaw() + 180f, 0f);
            if (entity instanceof MobEntity mob && !griefAllowed) {
                // Vanilla flag for "can pick up blocks / break grass"; only some
                // mobs honour it, but it's the cheapest knob we have.
                mob.setCanPickUpLoot(false);
            }
            if (world.spawnEntity(entity)) spawned++;
        }
        return "God a fait apparaître " + spawned + " " + entityType + (spawned > 1 ? "s" : "")
            + " près du joueur" + (griefAllowed ? "" : " (griefing désactivé)") + ".";
    }

    /** Looks up the bot avatar by the configured username, or null if not joined. */
    public static ServerPlayerEntity findAvatar(ServerPlayerEntity prayingPlayer) {
        MinecraftServer s = (prayingPlayer != null && prayingPlayer.getServer() != null)
            ? prayingPlayer.getServer()
            : SERVER;
        if (s == null) return null;
        return s.getPlayerManager().getPlayer(BridgeConfig.INSTANCE.botUsername);
    }

    /**
     * Mark the avatar invulnerable for the duration of an encounter. Cheap and
     * race-free under the busy lock — exactly one session sets/clears the
     * flag. Must run on the main thread; caller wraps via {@link GodActionQueue}.
     */
    public static String buffAvatar(ServerPlayerEntity prayingPlayer) {
        ServerPlayerEntity bot = findAvatar(prayingPlayer);
        if (bot == null) {
            LOGGER.info("buffAvatar: bot '{}' not found (not joined?)", BridgeConfig.INSTANCE.botUsername);
            return "Avatar introuvable (pas de buff).";
        }
        bot.setInvulnerable(true);
        bot.extinguish();
        return "Avatar rendu invincible.";
    }

    public static String restoreAvatar(ServerPlayerEntity prayingPlayer) {
        ServerPlayerEntity bot = findAvatar(prayingPlayer);
        if (bot == null) return "Avatar introuvable.";
        bot.setInvulnerable(false);
        return "Avatar redevenu mortel.";
    }

    /**
     * Bug #5: clear the avatar's Invulnerable flag from a path that is ALREADY on
     * the server thread and has just dropped the action queue — {@code /godbody off}
     * and {@code SERVER_STOPPING}. Both used to leave the flag set, and it persists
     * in the avatar's player data across restarts. Never call off the main thread.
     * An avatar that is offline at that moment keeps whatever flag it saved with.
     */
    public static String restoreAvatarOnMain(MinecraftServer server) {
        if (server == null) return "Serveur indisponible.";
        ServerPlayerEntity bot = server.getPlayerManager().getPlayer(BridgeConfig.INSTANCE.botUsername);
        if (bot == null) return "Avatar introuvable.";
        bot.setInvulnerable(false);
        return "Avatar redevenu mortel.";
    }

    /**
     * Called from the idle watchdog (off-thread). Queues vanish + restoreAvatar
     * on the main thread without needing a live player reference.
     */
    public static void dismissAvatarOnWatchdog(UUID ownerUuid) {
        MinecraftServer s = SERVER;
        if (s == null) return;
        GodActionQueue.submit(() -> {
            ServerPlayerEntity bot = s.getPlayerManager().getPlayer(BridgeConfig.INSTANCE.botUsername);
            if (bot != null) bot.setInvulnerable(false);
            return "watchdog cleared invuln";
        });
        // Bridge call: not main-thread-bound, fire it off directly.
        GodBody.vanish();
    }

}
