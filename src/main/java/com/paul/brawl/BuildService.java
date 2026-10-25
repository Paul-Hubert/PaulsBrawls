package com.paul.brawl;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The Builder's world layer (docs/27 §4–5): the per-call block cap and block validation in front of a
 * {@link BuildWorld}. The builtin textual scanner ({@code ChatBotFunctions}) and the {@code builder} MCP server both
 * place through it. Never throws: refusals are returned as refused {@link WorldOutcome}s (or a completed future
 * holding one). A placement is {@code done} only when its main-thread task completed.
 */
public final class BuildService {

    /** How long one placement call waits for its main-thread task (8 bulk tasks run per tick). */
    public static final long PLACE_WAIT_SECONDS = 30;

    private final BuildWorld world;

    public BuildService(BuildWorld world) {
        this.world = world;
    }

    private static volatile BuildService live;

    /** The service bound to the real world (created on first use, so tests never load Minecraft through it). */
    public static BuildService live() {
        BuildService s = live;
        if (s == null) {
            synchronized (BuildService.class) {
                if (live == null) live = new BuildService(new MinecraftBuildWorld());
                s = live;
            }
        }
        return s;
    }

    public BuildWorld world() {
        return world;
    }

    /**
     * Validate and queue one placement call; the future holds the report or the refusal. Bug #7: one call places
     * at most {@link BuildGuard#MAX_BLOCKS_PER_CALL} blocks, as ONE main-thread task on the bulk lane.
     */
    public CompletableFuture<WorldOutcome> submit(UUID player, int[] origin, List<int[]> offsets, String block) {
        if (origin == null) {
            return refusedNow("Aucun point de référence : l'admin doit lancer /construction avant de construire.");
        }
        if (offsets.isEmpty()) return refusedNow("Aucun bloc à placer.");
        if (!BuildGuard.withinCallCap(offsets.size())) return refusedNow(overCap(offsets.size()));
        if (block == null || block.isBlank() || !world.isKnownBlock(block.trim())) {
            return refusedNow("Bloc inconnu ou mal formé : '" + block + "'.");
        }
        try {
            return world.place(player, origin, offsets, block.trim()).thenApply(WorldOutcome::done);
        } catch (WorldRefusal r) {
            return refusedNow(r.getMessage());
        }
    }

    private static CompletableFuture<WorldOutcome> refusedNow(String text) {
        return CompletableFuture.completedFuture(WorldOutcome.refused(text));
    }

    /** {@link #submit}, then wait (bounded) so the caller's next step sees the blocks. */
    public WorldOutcome place(UUID player, int[] origin, List<int[]> offsets, String block) {
        return await(submit(player, origin, offsets, block));
    }

    /** {@code PlaceLine}: the size is checked before any position is allocated. */
    public WorldOutcome placeLine(UUID player, int[] origin, int x, int y, int z, int x2, int y2, int z2, String block) {
        long n = BuildGuard.lineBlocks(x, y, z, x2, y2, z2);
        if (!BuildGuard.withinCallCap(n)) return WorldOutcome.refused(overCap(n));
        return place(player, origin, BuildShapes.line(x, y, z, x2, y2, z2), block);
    }

    /**
     * Spawn {@code entity} at {@code origin + offset} for every offset (≤ {@link BuildGuard#MAX_MOBS_PER_CALL}), as one
     * bulk-lane task, then wait. Refused: an empty or oversized call, a denied or unknown entity, bad or oversized
     * NBT, a non-mob entity, or nothing spawned.
     */
    public WorldOutcome spawn(UUID player, int[] origin, List<int[]> offsets, String entity, String nbt, boolean persistent) {
        if (offsets.isEmpty()) return WorldOutcome.refused("Aucune créature à faire apparaître.");
        if (offsets.size() > BuildGuard.MAX_MOBS_PER_CALL) {
            return WorldOutcome.refused("Appel refusé : " + offsets.size() + " créatures demandées, au plus "
                + BuildGuard.MAX_MOBS_PER_CALL + " par appel.");
        }
        if (entity == null || entity.isBlank()) return WorldOutcome.refused("Type de créature vide.");
        String id = entity.trim();
        if (BuildGuard.deniedMob(id)) return WorldOutcome.refused("Refusé : '" + id + "' ne peut pas apparaître dans une construction.");
        if (!world.isKnownEntity(id)) return WorldOutcome.refused("Créature inconnue : '" + id + "'.");
        String data = nbt == null || nbt.isBlank() ? null : nbt.trim();
        if (data != null && data.length() > BuildGuard.MAX_NBT_CHARS) {
            return WorldOutcome.refused("NBT trop long : " + data.length() + " caractères, au plus " + BuildGuard.MAX_NBT_CHARS + ".");
        }
        if (data != null && !world.isValidNbt(data)) return WorldOutcome.refused("NBT mal formé : '" + abbreviate(data) + "'.");
        CompletableFuture<WorldOutcome> f;
        try {
            f = world.spawn(player, origin, offsets, id, data, persistent).thenApply(n -> n == 0
                ? WorldOutcome.refused("Aucune créature n'est apparue (position hors du monde ?).")
                : WorldOutcome.done(n + " créature(s) " + id + " apparue(s)."));
        } catch (WorldRefusal r) {
            return WorldOutcome.refused(r.getMessage());
        }
        return await(f);
    }

    private static String abbreviate(String s) {
        return s.length() <= 80 ? s : s.substring(0, 77) + "...";
    }

    public int[] origin(UUID player) {
        try {
            return world.origin(player);
        } catch (WorldRefusal r) {
            return null;
        }
    }

    public WorldOutcome blockInfo(UUID player) {
        try {
            return WorldOutcome.done(world.blockInfo(player));
        } catch (WorldRefusal r) {
            return WorldOutcome.refused(r.getMessage());
        }
    }

    public WorldOutcome queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        try {
            return WorldOutcome.done(world.queryTerrain(player, centerX, centerZ, radius));
        } catch (WorldRefusal r) {
            return WorldOutcome.refused(r.getMessage());
        }
    }

    public static String overCap(long blocks) {
        return "Appel refusé : " + blocks + " blocs demandés, au plus " + BuildGuard.MAX_BLOCKS_PER_CALL
            + " par appel. Découpe la forme en plusieurs appels.";
    }

    /** Wait for a placement; a cancelled queue (/godbody off, server stop) or a timeout is reported, not thrown. */
    public static WorldOutcome await(CompletableFuture<WorldOutcome> f) {
        try {
            return f.get(PLACE_WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException te) {
            return WorldOutcome.refused("Placement toujours en file après " + PLACE_WAIT_SECONDS + " s (serveur gelé ou arrêté ?).");
        } catch (ExecutionException ee) {
            if (ee.getCause() instanceof java.util.concurrent.CancellationException) {
                return WorldOutcome.refused("Placement annulé (construction arrêtée par un administrateur ou par l'arrêt du serveur).");
            }
            return WorldOutcome.refused(ee.getCause() instanceof WorldRefusal r ? r.getMessage()
                : "Erreur côté serveur pendant le placement.");
        } catch (java.util.concurrent.CancellationException ce) {
            return WorldOutcome.refused("Placement annulé (construction arrêtée par un administrateur ou par l'arrêt du serveur).");
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return WorldOutcome.refused("Placement interrompu.");
        }
    }
}
