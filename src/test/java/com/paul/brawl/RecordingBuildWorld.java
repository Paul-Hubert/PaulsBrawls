package com.paul.brawl;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** A {@link BuildWorld} that records placements (absolute positions) instead of setting blocks. See RecordingGodWorld. */
class RecordingBuildWorld implements BuildWorld {

    final Set<UUID> online = Collections.synchronizedSet(new HashSet<>());
    final Map<UUID, int[]> origins = Collections.synchronizedMap(new HashMap<>());
    final Set<String> knownBlocks = new HashSet<>(Set.of("minecraft:stone", "minecraft:oak_planks",
        "minecraft:oak_stairs[facing=north]"));
    /** One entry per placed block: "x,y,z block". */
    final List<String> placed = Collections.synchronizedList(new ArrayList<>());
    /** The size of every place() batch that reached the world (one per tool call). */
    final List<Integer> batches = Collections.synchronizedList(new ArrayList<>());
    final Set<String> knownEntities = new HashSet<>(Set.of("minecraft:cow", "minecraft:villager", "minecraft:zombie",
        "minecraft:wither", "minecraft:ender_dragon", "minecraft:armor_stand"));
    /** One entry per spawned creature: "x,y,z entity nbt persistent". */
    final List<String> spawned = Collections.synchronizedList(new ArrayList<>());
    /** The size of every spawn() batch that reached the world. */
    final List<Integer> spawnBatches = Collections.synchronizedList(new ArrayList<>());

    @Override public boolean isOnline(UUID player) { return online.contains(player); }

    @Override public int[] origin(UUID player) { return origins.get(player); }

    @Override public String blockInfo(UUID player) { return "[{\"x\":0,\"y\":0,\"z\":0,\"block\":\"minecraft:grass_block\"}]"; }

    @Override public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) { return "terrain-map"; }

    @Override public boolean isKnownBlock(String block) { return knownBlocks.contains(block); }

    @Override public CompletableFuture<String> place(UUID player, int[] origin, List<int[]> offsets, String block) {
        if (!online.contains(player)) return CompletableFuture.failedFuture(new WorldRefusal(MinecraftBuildWorld.OFFLINE));
        batches.add(offsets.size());
        for (int[] o : offsets) placed.add((origin[0] + o[0]) + "," + (origin[1] + o[1]) + "," + (origin[2] + o[2]) + " " + block);
        return CompletableFuture.completedFuture(offsets.size() + " bloc(s) " + block + " placé(s).");
    }

    @Override public boolean isKnownEntity(String entity) { return knownEntities.contains(entity); }

    /** A stand-in for SNBT parsing: one balanced {…}. */
    @Override public boolean isValidNbt(String nbt) {
        int depth = 0;
        for (char c : nbt.toCharArray()) {
            if (c == '{') depth++;
            else if (c == '}' && --depth < 0) return false;
        }
        return nbt.startsWith("{") && nbt.endsWith("}") && depth == 0;
    }

    @Override public CompletableFuture<Integer> spawn(UUID player, int[] origin, List<int[]> offsets, String entity, String nbt, boolean persistent) {
        if (!online.contains(player)) return CompletableFuture.failedFuture(new WorldRefusal(MinecraftBuildWorld.OFFLINE));
        if (entity.equals("minecraft:armor_stand")) return CompletableFuture.failedFuture(new WorldRefusal("Refusé : pas une créature."));
        spawnBatches.add(offsets.size());
        for (int[] o : offsets) {
            spawned.add((origin[0] + o[0]) + "," + (origin[1] + o[1]) + "," + (origin[2] + o[2]) + " " + entity + " " + nbt + " " + persistent);
        }
        return CompletableFuture.completedFuture(offsets.size());
    }
}
