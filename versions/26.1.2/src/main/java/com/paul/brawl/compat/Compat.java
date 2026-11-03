package com.paul.brawl.compat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.exceptions.CommandSyntaxException;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.item.ItemInput;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.Permission;
import net.minecraft.server.permissions.Permissions;
import net.minecraft.server.players.NameAndId;
import net.minecraft.server.players.PlayerList;
import net.minecraft.server.players.UserWhiteListEntry;
import net.minecraft.util.Unit;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelHeightAccessor;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;
import net.minecraft.world.level.storage.LevelResource;

/**
 * What Minecraft 1.21.1 and 26.1.2 do differently, behind one set of signatures (docs/39 §3). Each version's
 * {@code versions/<v>/src} has its own copy of this class: same methods, same signatures, its own body. Shared code
 * calls these instead of the API that changed, and never names a type that was renamed ({@code ResourceLocation},
 * {@code Identifier}): ids go in and out as strings. Keep both copies in step: a method added to one is added to
 * the other.
 *
 * <p>This is the 26.1.2 copy.
 */
public final class Compat {
    private static final Logger LOGGER = LoggerFactory.getLogger("Compat");

    private Compat() {}

    // -- permissions --------------------------------------------------------------------------------------------------

    /** The source has at least this operator level (0 everyone, 2 command blocks and ops, 4 the console). */
    public static boolean hasPermission(CommandSourceStack source, int level) {
        return level <= 0 || source.permissions().hasPermission(permission(level));
    }

    public static boolean hasPermission(ServerPlayer player, int level) {
        return level <= 0 || player.permissions().hasPermission(permission(level));
    }

    private static Permission permission(int level) {
        return switch (level) {
            case 1 -> Permissions.COMMANDS_MODERATOR;
            case 2 -> Permissions.COMMANDS_GAMEMASTER;
            case 3 -> Permissions.COMMANDS_ADMIN;
            default -> Permissions.COMMANDS_OWNER;
        };
    }

    // -- ids and registries -------------------------------------------------------------------------------------------

    /** An item by its id ({@code minecraft:bow}, {@code paulsbrawls:coin}); empty if malformed or unknown. */
    public static Optional<Item> item(String id) {
        return Optional.ofNullable(Identifier.tryParse(id)).flatMap(BuiltInRegistries.ITEM::getOptional);
    }

    public static Optional<EntityType<?>> entityType(String id) {
        return Optional.ofNullable(Identifier.tryParse(id)).flatMap(BuiltInRegistries.ENTITY_TYPE::getOptional);
    }

    /** The registry key {@code namespace:path} in {@code registry}. */
    public static <T> ResourceKey<T> key(ResourceKey<? extends Registry<T>> registry, String namespace, String path) {
        return ResourceKey.create(registry, Identifier.fromNamespaceAndPath(namespace, path));
    }

    /** The key's id, {@code minecraft:overworld}. */
    public static String id(ResourceKey<?> key) {
        return key.identifier().toString();
    }

    /** The key's path, {@code overworld}. */
    public static String path(ResourceKey<?> key) {
        return key.identifier().getPath();
    }

    public static Item registerItem(String namespace, String path, Item.Properties properties) {
        ResourceKey<Item> key = key(Registries.ITEM, namespace, path);
        return Registry.register(BuiltInRegistries.ITEM, key, new Item(properties.setId(key)));
    }

    public static <T extends CustomPacketPayload> CustomPacketPayload.Type<T> payloadType(String namespace, String path) {
        return new CustomPacketPayload.Type<>(Identifier.fromNamespaceAndPath(namespace, path));
    }

    /** A client-to-server play payload. */
    public static <T extends CustomPacketPayload> void registerServerboundPayload(
            CustomPacketPayload.Type<T> type, StreamCodec<? super RegistryFriendlyByteBuf, T> codec) {
        PayloadTypeRegistry.serverboundPlay().register(type, codec);
    }

    // -- events -------------------------------------------------------------------------------------------------------

    /** Watches an item's right-click; vanilla goes on (the callback always passes). */
    public interface ItemUse {
        void used(Player player, Level world, InteractionHand hand);
    }

    public static void watchItemUse(ItemUse use) {
        UseItemCallback.EVENT.register((player, world, hand) -> {
            use.used(player, world, hand);
            return InteractionResult.PASS;
        });
    }

    /** At the start of each level's tick. */
    public static void onLevelTickStart(Consumer<ServerLevel> tick) {
        ServerTickEvents.START_LEVEL_TICK.register(tick::accept);
    }

    // -- chat ---------------------------------------------------------------------------------------------------------

    public static ClickEvent runCommand(String command) {
        return new ClickEvent.RunCommand(command);
    }

    public static ClickEvent suggestCommand(String command) {
        return new ClickEvent.SuggestCommand(command);
    }

    public static ClickEvent copyToClipboard(String text) {
        return new ClickEvent.CopyToClipboard(text);
    }

    public static HoverEvent showText(Component text) {
        return new HoverEvent.ShowText(text);
    }

    // -- players ------------------------------------------------------------------------------------------------------

    public static String name(GameProfile profile) {
        return profile.name();
    }

    public static UUID id(GameProfile profile) {
        return profile.id();
    }

    /** A player the server has seen (its user cache), by name. */
    public static Optional<GameProfile> cachedProfile(MinecraftServer server, String name) {
        return server.services().nameToIdCache().get(name).map(n -> new GameProfile(n.id(), n.name()));
    }

    public static boolean isOp(PlayerList players, GameProfile profile) {
        return players.isOp(new NameAndId(profile));
    }

    public static void op(PlayerList players, GameProfile profile) {
        players.op(new NameAndId(profile));
    }

    /** Add to or remove from the whitelist (adding twice is a no-op). */
    public static void whitelist(PlayerList players, GameProfile profile, boolean add) {
        var list = players.getWhiteList();
        NameAndId who = new NameAndId(profile);
        if (!add) list.remove(who);
        else if (!list.isWhiteListed(who)) list.add(new UserWhiteListEntry(who));
    }

    public static void teleport(ServerPlayer player, ServerLevel world, double x, double y, double z, float yaw, float pitch) {
        player.teleportTo(world, x, y, z, Set.of(), yaw, pitch, true);
    }

    // -- inventory and items ------------------------------------------------------------------------------------------

    /** The 36 main slots (hotbar first), the inventory's own list: writes go through. */
    public static List<ItemStack> mainItems(Inventory inv) {
        return inv.getNonEquipmentItems();
    }

    public static int selectedSlot(Inventory inv) {
        return inv.getSelectedSlot();
    }

    public static void makeUnbreakable(ItemStack stack) {
        stack.set(DataComponents.UNBREAKABLE, Unit.INSTANCE);
    }

    /** One of the parsed item, components applied, as {@code /give} makes it. */
    public static ItemStack createOne(ItemInput input) throws CommandSyntaxException {
        return input.createItemStack(1);
    }

    // -- NBT ----------------------------------------------------------------------------------------------------------

    public static Set<String> keys(CompoundTag tag) {
        return tag.keySet();
    }

    /** The int at {@code key}, 0 if absent or not a number. */
    public static int getInt(CompoundTag tag, String key) {
        return tag.getIntOr(key, 0);
    }

    /** The string at {@code key}, "" if absent. */
    public static String getString(CompoundTag tag, String key) {
        return tag.getStringOr(key, "");
    }

    public static boolean getBoolean(CompoundTag tag, String key) {
        return tag.getBooleanOr(key, false);
    }

    /** The compound at {@code key}, if there is one. */
    public static Optional<CompoundTag> getCompound(CompoundTag tag, String key) {
        return tag.getCompound(key);
    }

    /** SNBT, as {@code /summon} reads it. */
    public static CompoundTag parseTag(String snbt) throws CommandSyntaxException {
        return TagParser.parseCompoundFully(snbt);
    }

    /**
     * The server's saved data {@code paulsbrawls:<name>} ({@code data/paulsbrawls/<name>.dat}), loaded or made. The
     * data's class turns its state into a tag with {@code save(CompoundTag, HolderLookup.Provider)} (1.21.1 calls it)
     * and {@code toTag} (this codec). A 1.21.1 world keeps it in {@code data/<name>.dat}, which the 26.x upgrade
     * leaves where it is (it moves only vanilla's files): that file is moved to the new place on first use.
     */
    public static <T extends SavedData> T savedData(MinecraftServer server, String name, Supplier<T> create,
                                                    Function<CompoundTag, T> load, Function<T, CompoundTag> toTag) {
        Identifier id = Identifier.fromNamespaceAndPath("paulsbrawls", name);
        moveLegacyFile(server, name, id);
        // Command storage is an untyped compound to the data fixers, as this data is.
        SavedDataType<T> type = new SavedDataType<>(id, create, CompoundTag.CODEC.xmap(load, toTag),
            DataFixTypes.SAVED_DATA_COMMAND_STORAGE);
        return server.getDataStorage().computeIfAbsent(type);
    }

    private static void moveLegacyFile(MinecraftServer server, String name, Identifier id) {
        Path data = server.getWorldPath(LevelResource.DATA);
        Path legacy = data.resolve(name + ".dat");
        Path current = id.withSuffix(".dat").resolveAgainst(data);
        if (!Files.isRegularFile(legacy) || Files.exists(current)) return;
        try {
            Files.createDirectories(current.getParent());
            Files.move(legacy, current);
            LOGGER.info("Moved the 1.21.1 saved data {} to {}", legacy, current);
        } catch (IOException e) {
            LOGGER.error("Could not move the 1.21.1 saved data {} to {}: {}", legacy, current, e.toString());
        }
    }

    // -- entities and the world ---------------------------------------------------------------------------------------

    /** A new entity of the type, not in the world yet (null if the type cannot be made), as {@code /summon} does. */
    public static <T extends Entity> T create(EntityType<T> type, Level world) {
        return type.create(world, EntitySpawnReason.COMMAND);
    }

    /** Place it, with its rotation, before it joins the world. */
    public static void moveTo(Entity entity, double x, double y, double z, float yaw, float pitch) {
        entity.snapTo(x, y, z, yaw, pitch);
    }

    /** {@code /summon}'s load: the entity and its passengers from the tag, {@code then} run on each; null if invalid. */
    public static Entity loadEntity(CompoundTag tag, ServerLevel world, Function<Entity, Entity> then) {
        return EntityType.loadEntityRecursive(tag, world, EntitySpawnReason.COMMAND, then::apply);
    }

    /** {@code /summon}'s initialization of a mob given no NBT (equipment, variants). */
    public static void finalizeCommandSpawn(Mob mob, ServerLevel world, BlockPos pos) {
        mob.finalizeSpawn(world, world.getCurrentDifficultyAt(pos), EntitySpawnReason.COMMAND, null);
    }

    /** The lowest block y of the world (the highest is {@code minY + getHeight() - 1}). */
    public static int minY(LevelHeightAccessor world) {
        return world.getMinY();
    }

    /** The time of day in ticks (0 sunrise, grows past 24000 day after day). */
    public static long dayTime(ServerLevel world) {
        return world.getOverworldClockTime();
    }

    /** The entity's scoreboard tags ({@code /tag}). */
    public static Set<String> tags(Entity entity) {
        return entity.entityTags();
    }

    /** An arrow, spectral arrow or trident ({@code AbstractArrow}, which moved package in 26.x). */
    public static boolean isArrow(Entity entity) {
        return entity instanceof AbstractArrow;
    }
}
