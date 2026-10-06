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
 * place through it. Never throws: refusals are returned as text (or as a completed future holding the text).
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
    public CompletableFuture<String> submit(UUID player, int[] origin, List<int[]> offsets, String block) {
        if (origin == null) {
            return CompletableFuture.completedFuture(
                "Aucun point de référence : l'admin doit lancer /construction avant de construire.");
        }
        if (offsets.isEmpty()) return CompletableFuture.completedFuture("Aucun bloc à placer.");
        if (!BuildGuard.withinCallCap(offsets.size())) return CompletableFuture.completedFuture(overCap(offsets.size()));
        if (block == null || block.isBlank() || !world.isKnownBlock(block.trim())) {
            return CompletableFuture.completedFuture("Bloc inconnu ou mal formé : '" + block + "'.");
        }
        try {
            return world.place(player, origin, offsets, block.trim());
        } catch (WorldRefusal r) {
            return CompletableFuture.completedFuture(r.getMessage());
        }
    }

    /** {@link #submit}, then wait (bounded) so the caller's next step sees the blocks. */
    public String place(UUID player, int[] origin, List<int[]> offsets, String block) {
        return await(submit(player, origin, offsets, block));
    }

    /** {@code PlaceLine}: the size is checked before any position is allocated. */
    public String placeLine(UUID player, int[] origin, int x, int y, int z, int x2, int y2, int z2, String block) {
        long n = BuildGuard.lineBlocks(x, y, z, x2, y2, z2);
        if (!BuildGuard.withinCallCap(n)) return overCap(n);
        return place(player, origin, BuildShapes.line(x, y, z, x2, y2, z2), block);
    }

    public int[] origin(UUID player) {
        try {
            return world.origin(player);
        } catch (WorldRefusal r) {
            return null;
        }
    }

    public String blockInfo(UUID player) {
        try {
            return world.blockInfo(player);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
    }

    public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        try {
            return world.queryTerrain(player, centerX, centerZ, radius);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
    }

    public static String overCap(long blocks) {
        return "Appel refusé : " + blocks + " blocs demandés, au plus " + BuildGuard.MAX_BLOCKS_PER_CALL
            + " par appel. Découpe la forme en plusieurs appels.";
    }

    /** Wait for a placement; a cancelled queue (/godbody off, server stop) or a timeout is reported, not thrown. */
    public static String await(CompletableFuture<String> f) {
        try {
            return f.get(PLACE_WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException te) {
            return "Placement toujours en file après " + PLACE_WAIT_SECONDS + " s (serveur gelé ou arrêté ?).";
        } catch (ExecutionException ee) {
            return ee.getCause() instanceof WorldRefusal r ? r.getMessage()
                : "Erreur côté serveur pendant le placement.";
        } catch (java.util.concurrent.CancellationException ce) {
            return "Placement annulé (construction arrêtée par un administrateur ou par l'arrêt du serveur).";
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return "Placement interrompu.";
        }
    }
}
