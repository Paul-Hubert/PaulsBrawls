package com.paul.brawl;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import com.mojang.brigadier.exceptions.CommandSyntaxException;

import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.SpawnReason;
import net.minecraft.entity.mob.MobEntity;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.StringNbtReader;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

/** The real {@link BuildWorld}: placements and spawns on the {@link GodActionQueue} bulk lane, reads through {@link MainThread}. */
public final class MinecraftBuildWorld implements BuildWorld {

    static final String OFFLINE = "Le joueur n'est plus connecté.";

    static ServerPlayerEntity online(UUID player) {
        MinecraftServer server = ChatBotActions.server();
        ServerPlayerEntity p = server == null || player == null ? null : server.getPlayerManager().getPlayer(player);
        if (p == null) throw new WorldRefusal(OFFLINE);
        return p;
    }

    @Override
    public boolean isOnline(UUID player) {
        return MainThread.call(() -> {
            MinecraftServer server = ChatBotActions.server();
            return server != null && player != null && server.getPlayerManager().getPlayer(player) != null;
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
        if (server == null || server.isOnThread()) {
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
        Identifier id = Identifier.tryParse(entity);
        return id != null && Registries.ENTITY_TYPE.getOrEmpty(id).map(EntityType::isSummonable).orElse(false);
    }

    @Override
    public boolean isValidNbt(String nbt) {
        try {
            StringNbtReader.parse(nbt);
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
        if (server == null || server.isOnThread()) {
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
    static int spawnAll(ServerPlayerEntity player, BlockPos origin, List<int[]> offsets, String entity, String nbt, boolean persistent) {
        if (!(player.getWorld() instanceof ServerWorld world)) throw new WorldRefusal("Impossible de faire apparaître : monde invalide.");
        NbtCompound base;
        try {
            base = nbt == null || nbt.isBlank() ? new NbtCompound() : StringNbtReader.parse(nbt);
        } catch (CommandSyntaxException e) {
            throw new WorldRefusal("NBT mal formé : " + e.getMessage());
        }
        boolean init = base.isEmpty();
        base.remove("Passengers");
        base.putString("id", entity);
        int spawned = 0;
        for (int[] off : offsets) {
            BlockPos pos = origin.add(off[0], off[1], off[2]);
            if (!World.isValid(pos)) continue;
            Entity e = EntityType.loadEntityWithPassengers(base.copy(), world, en -> {
                en.refreshPositionAndAngles(pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5, en.getYaw(), en.getPitch());
                return en;
            });
            if (e == null) continue;
            if (!(e instanceof MobEntity mob)) {
                throw new WorldRefusal("Refusé : '" + entity + "' n'est pas une créature (seules les créatures peuvent apparaître).");
            }
            if (init) mob.initialize(world, world.getLocalDifficulty(pos), SpawnReason.COMMAND, null);
            if (persistent) mob.setPersistent();
            if (world.spawnNewEntityAndPassengers(mob)) spawned++;
        }
        return spawned;
    }
}
