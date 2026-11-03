package com.paul.brawl;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.MobSpawnType;
import net.minecraft.world.level.Level;

/** The real {@link BuildWorld}: placements and spawns on the {@link GodActionQueue} bulk lane, reads through {@link MainThread}. */
public final class MinecraftBuildWorld implements BuildWorld {

    static final String OFFLINE = "Le joueur n'est plus connecté.";

    static ServerPlayer online(UUID player) {
        MinecraftServer server = ChatBotActions.server();
        ServerPlayer p = server == null || player == null ? null : server.getPlayerList().getPlayer(player);
        if (p == null) throw new WorldRefusal(OFFLINE);
        return p;
    }

    @Override
    public boolean isOnline(UUID player) {
        return MainThread.call(() -> {
            MinecraftServer server = ChatBotActions.server();
            return server != null && player != null && server.getPlayerList().getPlayer(player) != null;
        });
    }

    @Override
    public int[] origin(UUID player) {
        BlockPos p = Raycaster.getLastPos(player);
        return p == null ? null : new int[] { p.getX(), p.getY(), p.getZ() };
    }

    @Override
    public String blockInfo(UUID player) {
        return MainThread.call(() -> ChatBotActions.getBlockInfo(online(player)));
    }

    @Override
    public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        return MinecraftGodWorld.terrain(player, centerX, centerZ, radius);
    }

    @Override
    public boolean isKnownBlock(String block) {
        return ChatBotActions.isKnownBlock(ChatBotActions.server(), block);
    }

    @Override
    public CompletableFuture<String> place(UUID player, int[] origin, List<int[]> offsets, String block) {
        BlockPos o = new BlockPos(origin[0], origin[1], origin[2]);
        MinecraftServer server = ChatBotActions.server();
        java.util.function.Supplier<String> body = () -> {
            int n = ChatBotActions.placeAll(online(player), o, offsets, block);
            return n + " bloc(s) " + block + " placé(s).";
        };
        if (server == null || server.isSameThread()) {
            // Waiting on the queue from the thread that drains it would deadlock: run inline.
            try {
                return CompletableFuture.completedFuture(body.get());
            } catch (WorldRefusal r) {
                return CompletableFuture.failedFuture(r);
            }
        }
        return GodActionQueue.submitBulk(body);
    }

    @Override
    public boolean isKnownEntity(String entity) {
        ResourceLocation id = ResourceLocation.tryParse(entity);
        return id != null && BuiltInRegistries.ENTITY_TYPE.getOptional(id).map(EntityType::canSummon).orElse(false);
    }

    @Override
    public boolean isValidNbt(String nbt) {
        try {
            TagParser.parseTag(nbt);
            return true;
        } catch (CommandSyntaxException e) {
            return false;
        }
    }

    @Override
    public CompletableFuture<Integer> spawn(UUID player, int[] origin, List<int[]> offsets, String entity, String nbt, boolean persistent) {
        BlockPos o = new BlockPos(origin[0], origin[1], origin[2]);
        MinecraftServer server = ChatBotActions.server();
        java.util.function.Supplier<String> body = () -> String.valueOf(spawnAll(online(player), o, offsets, entity, nbt, persistent));
        if (server == null || server.isSameThread()) {
            try {
                return CompletableFuture.completedFuture(Integer.parseInt(body.get()));
            } catch (WorldRefusal r) {
                return CompletableFuture.failedFuture(r);
            }
        }
        return GodActionQueue.submitBulk(body).thenApply(Integer::parseInt);
    }

    /**
     * {@code /summon}'s path for each offset: the NBT (passengers dropped, so a rider cannot smuggle in a denied
     * creature), the position, {@code initialize} when no NBT was given, then persistence. Main thread only.
     */
    static int spawnAll(ServerPlayer player, BlockPos origin, List<int[]> offsets, String entity, String nbt, boolean persistent) {
        if (!(player.level() instanceof ServerLevel world)) throw new WorldRefusal("Impossible de faire apparaître : monde invalide.");
        CompoundTag base;
        try {
            base = nbt == null || nbt.isBlank() ? new CompoundTag() : TagParser.parseTag(nbt);
        } catch (CommandSyntaxException e) {
            throw new WorldRefusal("NBT mal formé : " + e.getMessage());
        }
        boolean init = base.isEmpty();
        base.remove("Passengers");
        base.putString("id", entity);
        int spawned = 0;
        for (int[] off : offsets) {
            BlockPos pos = origin.offset(off[0], off[1], off[2]);
            if (!Level.isInSpawnableBounds(pos)) continue;
            Entity e = EntityType.loadEntityRecursive(base.copy(), world, en -> {
                en.moveTo(pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5, en.getYRot(), en.getXRot());
                return en;
            });
            if (e == null) continue;
            if (!(e instanceof Mob mob)) {
                throw new WorldRefusal("Refusé : '" + entity + "' n'est pas une créature (seules les créatures peuvent apparaître).");
            }
            if (init) mob.finalizeSpawn(world, world.getCurrentDifficultyAt(pos), MobSpawnType.COMMAND, null);
            if (persistent) mob.setPersistenceRequired();
            if (world.tryAddFreshEntityWithPassengers(mob)) spawned++;
        }
        return spawned;
    }
}
