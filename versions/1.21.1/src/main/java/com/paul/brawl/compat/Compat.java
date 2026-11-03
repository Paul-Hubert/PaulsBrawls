package com.paul.brawl.compat;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

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
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.Tag;
import net.minecraft.nbt.TagParser;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import net.minecraft.server.players.UserWhiteListEntry;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResultHolder;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.MobSpawnType;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.Unbreakable;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelHeightAccessor;
import net.minecraft.world.level.saveddata.SavedData;

/**
 * What Minecraft 1.21.1 and 26.1.2 do differently, behind one set of signatures (docs/39 §3). Each version's
 * {@code versions/<v>/src} has its own copy of this class: same methods, same signatures, its own body. Shared code
 * calls these instead of the API that changed, and never names a type that was renamed ({@code ResourceLocation},
 * {@code Identifier}): ids go in and out as strings. Keep both copies in step: a method added to one is added to
 * the other.
 *
 * <p>This is the 1.21.1 copy.
 */
public final class Compat {
    private Compat() {}

    // -- permissions --------------------------------------------------------------------------------------------------

    /** The source has at least this operator level (0 everyone, 2 command blocks and ops, 4 the console). */
    public static boolean hasPermission(CommandSourceStack source, int level) {
        return source.hasPermission(level);
    }

    public static boolean hasPermission(ServerPlayer player, int level) {
        return player.hasPermissions(level);
    }

    // -- ids and registries -------------------------------------------------------------------------------------------

    /** An item by its id ({@code minecraft:bow}, {@code paulsbrawls:coin}); empty if malformed or unknown. */
    public static Optional<Item> item(String id) {
        return Optional.ofNullable(ResourceLocation.tryParse(id)).flatMap(BuiltInRegistries.ITEM::getOptional);
    }

    public static Optional<EntityType<?>> entityType(String id) {
        return Optional.ofNullable(ResourceLocation.tryParse(id)).flatMap(BuiltInRegistries.ENTITY_TYPE::getOptional);
    }

    /** The registry key {@code namespace:path} in {@code registry}. */
    public static <T> ResourceKey<T> key(ResourceKey<? extends Registry<T>> registry, String namespace, String path) {
        return ResourceKey.create(registry, ResourceLocation.fromNamespaceAndPath(namespace, path));
    }

    /** The key's id, {@code minecraft:overworld}. */
    public static String id(ResourceKey<?> key) {
        return key.location().toString();
    }

    /** The key's path, {@code overworld}. */
    public static String path(ResourceKey<?> key) {
        return key.location().getPath();
    }

    public static Item registerItem(String namespace, String path, Item.Properties properties) {
        return Registry.register(BuiltInRegistries.ITEM, ResourceLocation.fromNamespaceAndPath(namespace, path), new Item(properties));
    }

    public static <T extends CustomPacketPayload> CustomPacketPayload.Type<T> payloadType(String namespace, String path) {
        return new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath(namespace, path));
    }

    /** A client-to-server play payload. */
    public static <T extends CustomPacketPayload> void registerServerboundPayload(
            CustomPacketPayload.Type<T> type, StreamCodec<? super RegistryFriendlyByteBuf, T> codec) {
        PayloadTypeRegistry.playC2S().register(type, codec);
    }

    // -- events -------------------------------------------------------------------------------------------------------

    /** Watches an item's right-click; vanilla goes on (the callback always passes). */
    public interface ItemUse {
        void used(Player player, Level world, InteractionHand hand);
    }

    public static void watchItemUse(ItemUse use) {
        UseItemCallback.EVENT.register((player, world, hand) -> {
            use.used(player, world, hand);
            return InteractionResultHolder.pass(player.getItemInHand(hand));
        });
    }

    /** At the start of each level's tick. */
    public static void onLevelTickStart(Consumer<ServerLevel> tick) {
        ServerTickEvents.START_WORLD_TICK.register(tick::accept);
    }

    // -- chat ---------------------------------------------------------------------------------------------------------

    public static ClickEvent runCommand(String command) {
        return new ClickEvent(ClickEvent.Action.RUN_COMMAND, command);
    }

    public static ClickEvent suggestCommand(String command) {
        return new ClickEvent(ClickEvent.Action.SUGGEST_COMMAND, command);
    }

    public static ClickEvent copyToClipboard(String text) {
        return new ClickEvent(ClickEvent.Action.COPY_TO_CLIPBOARD, text);
    }

    public static HoverEvent showText(Component text) {
        return new HoverEvent(HoverEvent.Action.SHOW_TEXT, text);
    }

    // -- players ------------------------------------------------------------------------------------------------------

    public static String name(GameProfile profile) {
        return profile.getName();
    }

    public static UUID id(GameProfile profile) {
        return profile.getId();
    }

    /** A player the server has seen (its user cache), by name. */
    public static Optional<GameProfile> cachedProfile(MinecraftServer server, String name) {
        var cache = server.getProfileCache();
        return cache == null ? Optional.empty() : cache.get(name);
    }

    public static boolean isOp(PlayerList players, GameProfile profile) {
        return players.isOp(profile);
    }

    public static void op(PlayerList players, GameProfile profile) {
        players.op(profile);
    }

    /** Add to or remove from the whitelist (adding twice is a no-op). */
    public static void whitelist(PlayerList players, GameProfile profile, boolean add) {
        var list = players.getWhiteList();
        if (!add) list.remove(profile);
        else if (!list.isWhiteListed(profile)) list.add(new UserWhiteListEntry(profile));
    }

    public static void teleport(ServerPlayer player, ServerLevel world, double x, double y, double z, float yaw, float pitch) {
        player.teleportTo(world, x, y, z, yaw, pitch);
    }

    // -- inventory and items ------------------------------------------------------------------------------------------

    /** The 36 main slots (hotbar first), the inventory's own list: writes go through. */
    public static List<ItemStack> mainItems(Inventory inv) {
        return inv.items;
    }

    public static int selectedSlot(Inventory inv) {
        return inv.selected;
    }

    public static void makeUnbreakable(ItemStack stack) {
        stack.set(DataComponents.UNBREAKABLE, new Unbreakable(true));
    }

    /** One of the parsed item, components applied, as {@code /give} makes it. */
    public static ItemStack createOne(ItemInput input) throws CommandSyntaxException {
        return input.createItemStack(1, false);
    }

    // -- NBT ----------------------------------------------------------------------------------------------------------

    public static Set<String> keys(CompoundTag tag) {
        return tag.getAllKeys();
    }

    /** The int at {@code key}, 0 if absent or not a number. */
    public static int getInt(CompoundTag tag, String key) {
        return tag.getInt(key);
    }

    /** The string at {@code key}, "" if absent. */
    public static String getString(CompoundTag tag, String key) {
        return tag.getString(key);
    }

    public static boolean getBoolean(CompoundTag tag, String key) {
        return tag.getBoolean(key);
    }

    /** The compound at {@code key}, if there is one. */
    public static Optional<CompoundTag> getCompound(CompoundTag tag, String key) {
        return tag.contains(key, Tag.TAG_COMPOUND) ? Optional.of(tag.getCompound(key)) : Optional.empty();
    }

    /** SNBT, as {@code /summon} reads it. */
    public static CompoundTag parseTag(String snbt) throws CommandSyntaxException {
        return TagParser.parseTag(snbt);
    }

    /**
     * The overworld's saved data {@code name} ({@code data/<name>.dat}), loaded or made. The data's class turns its
     * state into a tag with {@code save(CompoundTag, HolderLookup.Provider)} (1.21.1 calls it) and {@code toTag}
     * (26.1.2's codec).
     */
    public static <T extends SavedData> T savedData(MinecraftServer server, String name, Supplier<T> create,
                                                    Function<CompoundTag, T> load, Function<T, CompoundTag> toTag) {
        return server.overworld().getDataStorage().computeIfAbsent(
            new SavedData.Factory<>(create, (tag, lookup) -> load.apply(tag), null), name);
    }

    // -- entities and the world ---------------------------------------------------------------------------------------

    /** A new entity of the type, not in the world yet (null if the type cannot be made), as {@code /summon} does. */
    public static <T extends Entity> T create(EntityType<T> type, Level world) {
        return type.create(world);
    }

    /** Place it, with its rotation, before it joins the world. */
    public static void moveTo(Entity entity, double x, double y, double z, float yaw, float pitch) {
        entity.moveTo(x, y, z, yaw, pitch);
    }

    /** {@code /summon}'s load: the entity and its passengers from the tag, {@code then} run on each; null if invalid. */
    public static Entity loadEntity(CompoundTag tag, ServerLevel world, Function<Entity, Entity> then) {
        return EntityType.loadEntityRecursive(tag, world, then);
    }

    /** {@code /summon}'s initialization of a mob given no NBT (equipment, variants). */
    public static void finalizeCommandSpawn(Mob mob, ServerLevel world, BlockPos pos) {
        mob.finalizeSpawn(world, world.getCurrentDifficultyAt(pos), MobSpawnType.COMMAND, null);
    }

    /** The lowest block y of the world (the highest is {@code minY + getHeight() - 1}). */
    public static int minY(LevelHeightAccessor world) {
        return world.getMinBuildHeight();
    }

    /** The time of day in ticks (0 sunrise, grows past 24000 day after day). */
    public static long dayTime(ServerLevel world) {
        return world.getDayTime();
    }

    /** The entity's scoreboard tags ({@code /tag}). */
    public static Set<String> tags(Entity entity) {
        return entity.getTags();
    }

    /** An arrow, spectral arrow or trident ({@code AbstractArrow}, which moved package in 26.x). */
    public static boolean isArrow(Entity entity) {
        return entity instanceof AbstractArrow;
    }
}
