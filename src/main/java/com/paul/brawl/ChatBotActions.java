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

    /**
     * Store the offer for {@code /accept} and show it to the player. Amounts were checked by {@link GodService};
     * an unknown item comes back as a {@link WorldRefusal}. Main thread only.
     */
    public static void sendTradeOffer(ServerPlayerEntity player, String giveItemName, int giveAmount, String takeItemName, int takeAmount) {
        var error = TradeOffers.updateOffer(player, giveItemName, giveAmount, takeItemName, takeAmount);
        if (error != null) throw new WorldRefusal(error);
        var message = "God has offered you a trade: \n You receive " + giveAmount + " " + giveItemName + " for " + takeAmount + " " + takeItemName + "\n Type /accept within " + (TradeOffers.OFFER_TTL_MILLIS / 60_000) + " minutes.";
        ChatPrinter.sendMessage(player, message);
    }

    /**
     * Give an already-clamped amount (bug #6: {@link GodService} clamps to {@code rewardMax}). The item string is
     * parsed by the same parser as {@code /give}, so the advertised component syntax
     * ({@code minecraft:enchanted_book[minecraft:enchantments={…}]}) and a bare {@code diamond} both work. Stacks are
     * split to the item's max size and anything that does not fit drops at the player's feet. Main thread only.
     */
    public static void giveItemStacks(ServerPlayerEntity player, String itemName, int amount) {
        ItemStack template = parseItemStack(player.getServer(), itemName);
        if (template == null) {
            throw new WorldRefusal("Reward cancelled, item " + itemName + " does not exist or is malformed, please try again.");
        }
        int left = amount;
        while (left > 0) {
            int n = Math.min(left, Math.max(1, template.getMaxCount()));
            player.getInventory().offerOrDrop(template.copyWithCount(n));
            left -= n;
        }
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

    /** {@code strikes} lightning bolts on the player (already clamped by {@link GodService}). Main thread only. */
    public static void smite(ServerPlayerEntity player, int strikes) {
        for (int i = 0; i < strikes; i++) {
            smite(player);
        }
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
                            // Bug #18: player-only — getPlayerOrThrow gives the console a readable error, not an NPE.
                            placeBlock(context.getSource().getPlayerOrThrow(), x, y, z, "minecraft:stone");
                            return Command.SINGLE_SUCCESS;
                        }))))
            );
        });

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("construction")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .executes(context -> {
                        // Bug #18: player-only (it raycasts from the player's eyes) — the console gets a readable error.
                        ServerPlayerEntity player = context.getSource().getPlayerOrThrow();
                        Raycaster.setLastPos(player);
                        // Under LangChain4j the per-player conversation lives in the
                        // mod, so clearing the chain is just dropping the memory window.
                        ChatBot.buildBot.clearMemory(player);
                        return Command.SINGLE_SUCCESS;
                    })
            );
        });

    }

    /** {@code /block}: one block at an offset from the admin's {@code /construction} pivot (no pivot → nothing). */
    public static void placeBlock(ServerPlayerEntity player, int x, int y, int z, String blockType) {
        BlockPos pos = Raycaster.getLastPos(player.getUuid());
        if (pos == null) return;
        placeAll(player, pos, java.util.List.of(new int[] { x, y, z }), blockType);
    }

    /**
     * Set {@code blockType} at {@code origin + offset} for every offset, in the player's world. The caps (bug #7,
     * {@link BuildGuard}) were applied by {@link BuildService}; an unparseable block is a {@link WorldRefusal}.
     * Main thread only. Returns how many blocks were set.
     */
    public static int placeAll(ServerPlayerEntity player, BlockPos origin, java.util.List<int[]> offsets, String blockType) {
        BlockState state = parseBlockState(player.getServer(), blockType);
        if (state == null) throw new WorldRefusal("Bloc inconnu ou mal formé : '" + blockType + "'.");
        World world = player.getWorld();
        for (int[] o : offsets) {
            // BlockPos.add(int, int, int) already returns a new BlockPos — no copy needed.
            world.setBlockState(origin.add(o[0], o[1], o[2]), state);
        }
        return offsets.size();
    }

    /**
     * The topmost non-air block of each column in a 3×3 area around the admin's {@code /construction} pivot, as
     * offsets from it. Bug #18: this used to emit unparseable pseudo-JSON; {@link BlockInfoJson} builds a real array
     * of {@code {"x","y","z","block"}} objects, and the id is the block's registry id (not its item's).
     */
    public static String getBlockInfo(ServerPlayerEntity player) {
        BlockPos pos = Raycaster.getLastPos(player.getUuid());

        if(pos == null) return "";

        var zone = 3;
        BlockInfoJson json = new BlockInfoJson();
        for(int i = 0; i<zone; i++) {
            for(int j = 0; j<zone; j++) {
                for(int k = zone-1; k>-zone+1; k--) {
                    Vec3i v = new Vec3i(i - zone/2, k - zone/2, j - zone/2);
                    var p = pos.add(v);
                    BlockState state = player.getWorld().getBlockState(p);
                    if(state.isAir()) {
                        continue;
                    }
                    json.add(v.getX(), v.getY(), v.getZ(), Registries.BLOCK.getId(state.getBlock()).toString());
                    break;
                }
            }
        }
        return "Surrounding block info (offsets from the /construction pivot):\n" + json.toJson();
    }



    /** Whether {@code blockType} parses like {@code /setblock} does (registries are frozen, so any thread). */
    public static boolean isKnownBlock(MinecraftServer server, String blockType) {
        return parseBlockState(server, blockType) != null;
    }

    private static BlockState parseBlockState(MinecraftServer server, String blockType) {
        if (blockType == null || server == null) return null;
        RegistryWrapper<Block> wrapper = server.getRegistryManager()
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


    /** {@code /weather <type> <seconds>}; type and duration were validated by {@link GodService}. Main thread only. */
    public static void changeWeather(ServerPlayerEntity player, String weatherType, int durationSeconds) {
        if (player == null || player.getServer() == null) {
            throw new WorldRefusal("Impossible de changer la météo : joueur ou serveur invalide.");
        }
        String command = "/weather " + weatherType.toLowerCase(java.util.Locale.ROOT) + " " + durationSeconds;
        player.getServer().getCommandManager().executeWithPrefix(player.getServer().getCommandSource(), command);
    }

    /**
     * Spawn {@code count} of {@code entityType} at a block offset from {@code player}; count and offsets were
     * clamped by {@link GodService}. Runs server-side (no bridge dependency) — picked because the MCP server has no
     * /summon tool and a single canonical path avoids drift. Main thread only (GOD_BOT_INTEGRATION_PLAN.md §6a,
     * §7). Returns how many spawned.
     */
    public static int spawnCreature(ServerPlayerEntity player, String entityType, int count, int x, int y, int z, boolean griefAllowed) {
        if (player == null || !(player.getWorld() instanceof ServerWorld world)) {
            throw new WorldRefusal("Impossible de spawner : joueur ou monde invalide.");
        }
        Identifier id = Identifier.tryParse(entityType.trim());
        if (id == null) {
            throw new WorldRefusal("Spawn annulé : identifiant invalide '" + entityType + "'.");
        }
        EntityType<?> type = Registries.ENTITY_TYPE.getOrEmpty(id).orElse(null);
        if (type == null) {
            throw new WorldRefusal("Spawn annulé : type d'entité inconnu '" + entityType + "'.");
        }
        BlockPos basePos = player.getBlockPos().add(x, y, z);
        int spawned = 0;
        for (int i = 0; i < count; i++) {
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
        return spawned;
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
