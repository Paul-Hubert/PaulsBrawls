package com.paul.brawl;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Port: the Builder's world effects, keyed by player UUID and free of Minecraft types (docs/27 §4). The caps live in
 * {@link BuildService}; {@link MinecraftBuildWorld} is the real implementation, and the MCP contract tests inject a
 * recording one. Methods throw {@link WorldRefusal} when they cannot apply.
 */
public interface BuildWorld {

    boolean isOnline(UUID player);

    /** The player's {@code /construction} pivot as {x, y, z}, or null if they never set one. */
    int[] origin(UUID player);

    /** The topmost blocks of the 3×3 columns around the pivot, as JSON (empty if no pivot). */
    String blockInfo(UUID player);

    /** {@link QueryTerrain}'s relief map around the player. */
    String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius);

    /** Whether the block string parses like {@code /setblock}. */
    boolean isKnownBlock(String block);

    /**
     * Queue one placement task on the main thread's bulk lane: {@code block} at {@code origin + offset} for every
     * offset, in the player's world. Completes with a short report, or exceptionally with a {@link WorldRefusal}.
     */
    CompletableFuture<String> place(UUID player, int[] origin, List<int[]> offsets, String block);

    /** Whether {@code entity} names an entity type {@code /summon} accepts. */
    boolean isKnownEntity(String entity);

    /** Whether {@code nbt} parses as an SNBT compound, as {@code /summon} reads it. */
    boolean isValidNbt(String nbt);

    /**
     * Queue one spawn task on the bulk lane: an {@code entity} with {@code nbt} (null: none) centred on the block at
     * {@code origin + offset} for every offset, kept from despawning when {@code persistent}. Only mobs: anything
     * else completes exceptionally with a {@link WorldRefusal}. Completes with how many spawned.
     */
    CompletableFuture<Integer> spawn(UUID player, int[] origin, List<int[]> offsets, String entity, String nbt, boolean persistent);
}
