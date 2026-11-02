package com.paul.brawl.squad;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import it.unimi.dsi.fastutil.ints.IntOpenHashSet;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ShapeContext;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.entity.Entity;
import net.minecraft.fluid.FluidState;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ChunkFilter;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.ChunkPos;
import net.minecraft.util.math.ChunkSectionPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import net.minecraft.world.chunk.ChunkSection;
import net.minecraft.world.chunk.PalettedContainer;
import net.minecraft.world.chunk.WorldChunk;

/**
 * Where the commander looks, as far as they can see (docs/29 §7.1): the block and the entity their crosshair points at,
 * out to {@link #REACH} blocks, clipped to the chunks the server sends them (their view) and to the world's height.
 * {@link CommanderSnap} takes it for every order, authoring request and bound item's click, and the order starts once
 * it is there.
 *
 * <p>The walk runs on a worker thread ({@code squad-look}), never on the server thread, which only copies, once a
 * tick ({@code END_SERVER_TICK}, the world settled for that tick), what the worker will read:
 * <ul>
 *   <li><b>The sections</b> the ray crosses ({@link SquadLookPlan#sections}), each block-state container copied
 *       ({@code PalettedContainer.copy()}), within {@link #COPY_BUDGET_NANOS} a tick for every look together. A chunk
 *       not loaded reads as air (the server never loads one for a look); the first column outside the player's view
 *       ends the ray (they cannot see past it).</li>
 *   <li><b>The entities</b> along it, until one is found: those a crosshair can target ({@code canHit()}, not a
 *       spectator) that the player's client can see (within the entity's tracking range and in a chunk of their
 *       view), each as its targeting box.</li>
 * </ul>
 * The worker walks that copy as vanilla's {@code BlockView.raycast} does (outline shapes, fluids ignored, the player's
 * shape context), in pieces of {@link #SEGMENT} blocks, and picks the entity as {@code ProjectileUtil.raycast} does
 * ({@link SquadLookTargets}), until it hits a block, reaches what was copied, or has spent {@link #STEP_BUDGET_NANOS}.
 * When it stops short, it keeps where it got to; at the next tick's end the server thread takes its answer (a step
 * still running then is left to finish: a walk may take several ticks), copies the world from there as it is now, and
 * the worker goes on. A section the walk needed but the plan had not copied (a ray along a section's edge) stops it
 * at the start of its piece, and is copied next tick. A look not done after {@link #MAX_TICKS} goes with what it has.
 *
 * <p>Server thread only, but for {@link #walk}, on the worker, which reads the copies and the look's final fields.
 */
public final class SquadLook {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");

    /** The longest look, blocks; in practice the player's view (≤ 32 chunks) and the world's height end it sooner. */
    public static final double REACH = 4096;
    /** The server thread copies sections for at most this long a tick, all looks together (at least a few sections each). */
    static final long COPY_BUDGET_NANOS = 1_000_000L;
    /** The sections a look copies in a tick before the budget is checked: a look always moves on. */
    static final int MIN_SECTIONS = 4;
    /** One step of the worker walks at most this long (well under a tick), then stops where it got to. */
    static final long STEP_BUDGET_NANOS = 20_000_000L;
    /** The walk's piece, blocks: a section the plan missed restarts at most this much. */
    static final double SEGMENT = 32;
    /**
     * Each piece starts this far (blocks) before where the last one ended, and a stretch's last piece ends this far
     * before the copy's end: vanilla's walk nudges its ends by 1e-7 of the piece, and a hit on a face at the seam is
     * found by either piece.
     */
    static final double EPS = 1e-3;
    /** Entities are looked up in boxes along this many blocks of the ray (one box over a long diagonal is a square). */
    static final double ENTITY_PIECE = 32;
    /** Ticks a look may take before it goes with what it has (none takes more than a few). */
    static final int MAX_TICKS = 100;

    /** What a look found: the block (its position and id path) and the entity before it (the snapshot's ref), each or none. */
    public record Look(BlockPos block, String blockName, SquadTriggerJson.EntityRef entity) {
        public static final Look NONE = new Look(null, null, null);
    }

    private static final ArrayDeque<Ray> RAYS = new ArrayDeque<>();
    private static ExecutorService worker;
    private static boolean stopped;
    private static int ticks;
    private static long lastWarn;

    private SquadLook() {}

    public static void register() {
        ServerTickEvents.END_SERVER_TICK.register(SquadLook::tick);
        ServerLifecycleEvents.SERVER_STARTED.register(srv -> stopped = false);
        ServerLifecycleEvents.SERVER_STOPPING.register(srv -> stop());
    }

    /** Cast {@code p}'s look as it is now (server thread). The future completes on the server thread, a tick or more later. */
    public static CompletableFuture<Look> cast(ServerPlayerEntity p) {
        if (stopped || !(p.getWorld() instanceof ServerWorld)) return CompletableFuture.completedFuture(Look.NONE);
        Ray r = new Ray(p, ticks);
        if (r.end <= 0) return CompletableFuture.completedFuture(Look.NONE);
        RAYS.add(r);
        return r.done;
    }

    private static void tick(MinecraftServer srv) {
        ticks++;
        if (RAYS.isEmpty()) return;
        long budgetEnd = System.nanoTime() + COPY_BUDGET_NANOS;
        for (Iterator<Ray> it = RAYS.iterator(); it.hasNext();) {
            Ray r = it.next();
            if (r.step != null) {
                if (!r.step.isDone()) continue; // the worker is still on it: it goes on, longer than a frame
                Walked w = null;
                try {
                    w = r.step.join();
                } catch (RuntimeException e) {
                    warn("a look's walk failed (" + e + "): the snapshot goes without it");
                }
                r.step = null;
                if (w == null) {
                    r.finish();
                    it.remove();
                    continue;
                }
                r.apply(w);
                if (r.finished) {
                    r.finish();
                    it.remove();
                    continue;
                }
            }
            if (ticks - r.startTick > MAX_TICKS || r.player.isRemoved()) {
                if (!r.player.isRemoved()) warn("a look took more than " + MAX_TICKS + " ticks: the snapshot goes with what it found");
                r.finish();
                it.remove();
                continue;
            }
            Copy c = copy(r, budgetEnd);
            r.step = CompletableFuture.supplyAsync(() -> walk(r, c), worker());
        }
    }

    /** The server stops: every look goes with what it has, the worker with it. */
    private static void stop() {
        stopped = true;
        for (Ray r : RAYS) r.finish();
        RAYS.clear();
        if (worker != null) worker.shutdownNow();
        worker = null;
    }

    private static ExecutorService worker() {
        if (worker == null) {
            worker = Executors.newSingleThreadExecutor(task -> {
                Thread t = new Thread(task, "squad-look");
                t.setDaemon(true);
                return t;
            });
        }
        return worker;
    }

    private static void warn(String text) {
        long now = System.currentTimeMillis();
        if (now - lastWarn < 60_000) return;
        lastWarn = now;
        LOGGER.warn("Squad look: {}", text);
    }

    // -- the server thread's copy ---------------------------------------------------------------------------------

    /** The next stretch of the look, copied: the sections from where it got to (and the ones it asked for), its entities. */
    private static Copy copy(Ray r, long budgetEnd) {
        CopiedView view = new CopiedView(r.world.getBottomY(), r.world.getTopY(), r.view);
        for (long key : r.missing) copySection(r, view, ChunkSectionPos.unpackX(key), ChunkSectionPos.unpackY(key), ChunkSectionPos.unpackZ(key));
        r.missing.clear();
        double from = Math.max(0, r.t - EPS); // the backward overlap of the walk's first piece
        double[] to = { from };
        int[] n = { 0 };
        SquadLookPlan.sections(r.eye.x, r.eye.y, r.eye.z, r.dir.x, r.dir.y, r.dir.z, from, r.end, (cx, sy, cz, tIn, tOut) -> {
            if (!r.view.isWithinDistance(cx, cz)) {
                r.end = Math.max(r.t, Math.min(r.end, tIn)); // the player sees nothing past here
                return false;
            }
            copySection(r, view, cx, sy, cz);
            to[0] = tOut;
            return ++n[0] < MIN_SECTIONS || System.nanoTime() < budgetEnd;
        });
        double t1 = Math.min(to[0], r.end);
        boolean last = t1 >= r.end;
        List<SquadLookTargets.Target<SquadTriggerJson.EntityRef>> targets = r.entity == null ? targets(r, from, t1) : List.of();
        return new Copy(view, targets, r.t, t1, last);
    }

    private static void copySection(Ray r, CopiedView view, int cx, int sy, int cz) {
        if (sy < r.world.getBottomSectionCoord() || sy >= r.world.getTopSectionCoord()) return; // VOID_AIR, read without a copy
        long key = ChunkSectionPos.asLong(cx, sy, cz);
        if (view.has(key)) return;
        if (cx != r.lastCx || cz != r.lastCz || r.lastChunk == null) {
            // Never loads a chunk: one the server does not hold is one the player cannot see.
            r.lastChunk = r.world.getChunkManager().getWorldChunk(cx, cz);
            r.lastCx = cx;
            r.lastCz = cz;
            if (r.lastChunk == null) r.lastCx = Integer.MIN_VALUE;
        }
        WorldChunk chunk = r.lastChunk;
        ChunkSection s = chunk == null ? null : chunk.getSection(chunk.sectionCoordToIndex(sy));
        if (s == null || s.isEmpty()) view.air(key);
        else view.put(key, s.getBlockStateContainer().copy());
    }

    /** The entities a crosshair could target along {@code [t0, t1]} of the look, that the player's client shows. */
    private static List<SquadLookTargets.Target<SquadTriggerJson.EntityRef>> targets(Ray r, double t0, double t1) {
        List<SquadLookTargets.Target<SquadTriggerJson.EntityRef>> out = new ArrayList<>();
        IntOpenHashSet seen = new IntOpenHashSet();
        Entity root = r.player.getRootVehicle();
        for (double a = t0; a < t1; a += ENTITY_PIECE) {
            Box q = new Box(r.at(a), r.at(Math.min(t1, a + ENTITY_PIECE))).expand(1.0);
            for (Entity e : r.world.getOtherEntities(r.player, q, e -> !e.isSpectator() && e.canHit() && shown(r, e))) {
                if (!seen.add(e.getId())) continue;
                out.add(new SquadLookTargets.Target<>(e.getBoundingBox().expand(e.getTargetingMargin()), e.getRootVehicle() == root, CommanderSnap.entity(e)));
            }
        }
        return out;
    }

    /** As vanilla's entity tracker: within the entity's tracking range of the player, in a chunk of the player's view. */
    private static boolean shown(Ray r, Entity e) {
        int range = r.server.adjustTrackingDistance(e.getType().getMaxTrackDistance() * 16);
        double dx = e.getX() - r.player.getX();
        double dz = e.getZ() - r.player.getZ();
        ChunkPos c = e.getChunkPos();
        return dx * dx + dz * dz <= (double) range * range && r.view.isWithinDistance(c.x, c.z);
    }

    // -- the worker's walk ----------------------------------------------------------------------------------------

    /** One step: the copied stretch, piece by piece, until a block, the stretch's end, a missing section, or the budget. */
    private static Walked walk(Ray r, Copy c) {
        long stopAt = System.nanoTime() + STEP_BUDGET_NANOS;
        double end = c.last ? c.t1 : Math.max(c.t0, c.t1 - EPS);
        double a = c.t0;
        while (a < end) {
            double b = Math.min(end, a + SEGMENT);
            try {
                BlockHitResult h = c.view.raycast(new RaycastContext(r.at(Math.max(0, a - EPS)), r.at(b), RaycastContext.ShapeType.OUTLINE,
                    RaycastContext.FluidHandling.NONE, r.shape));
                if (h.getType() == HitResult.Type.BLOCK) {
                    double tb = h.getPos().distanceTo(r.eye);
                    BlockPos bp = h.getBlockPos();
                    String name = Registries.BLOCK.getId(c.view.getBlockState(bp).getBlock()).getPath();
                    return new Walked(tb, bp.toImmutable(), name, entityBefore(r, c, tb), Long.MIN_VALUE);
                }
            } catch (Missing m) {
                return new Walked(a, null, null, entityBefore(r, c, a), m.key);
            }
            a = b;
            if (System.nanoTime() > stopAt) break;
        }
        return new Walked(a, null, null, entityBefore(r, c, a), Long.MIN_VALUE);
    }

    private static SquadTriggerJson.EntityRef entityBefore(Ray r, Copy c, double t) {
        if (c.targets.isEmpty() || t <= 0) return null;
        return SquadLookTargets.pick(c.targets, r.eye, r.at(t), t * t);
    }

    // -- state ----------------------------------------------------------------------------------------------------

    /** One look in flight. The worker reads only the final fields (and its Copy). */
    private static final class Ray {
        final ServerPlayerEntity player;
        final ServerWorld world;
        final MinecraftServer server;
        final Vec3d eye;
        final Vec3d dir;
        final ShapeContext shape;
        /** The chunks the server sends the player (a record: safe to read anywhere). */
        final ChunkFilter view;
        final int startTick;
        final CompletableFuture<Look> done = new CompletableFuture<>();
        /** Walked up to here: no block before it. */
        double t;
        /** Where the look ends: REACH, the world's height, then the edge of the player's view once the plan meets it. */
        double end;
        boolean finished;
        BlockPos block;
        String blockName;
        /** The first entity in the way, before any block: once found, no more entities are copied. */
        SquadTriggerJson.EntityRef entity;
        /** Sections a walk read that the plan had not copied: copied next tick. */
        final LongOpenHashSet missing = new LongOpenHashSet();
        CompletableFuture<Walked> step;
        int lastCx = Integer.MIN_VALUE;
        int lastCz;
        WorldChunk lastChunk;

        Ray(ServerPlayerEntity p, int tick) {
            player = p;
            world = (ServerWorld) p.getWorld();
            server = world.getServer();
            eye = p.getCameraPosVec(1.0f);
            dir = p.getRotationVec(1.0f);
            shape = ShapeContext.of(p);
            view = p.getChunkFilter();
            startTick = tick;
            end = SquadLookPlan.clipHeight(eye.y, dir.y, world.getBottomY(), world.getTopY(), REACH);
        }

        Vec3d at(double d) {
            return eye.add(dir.multiply(d));
        }

        void apply(Walked w) {
            if (entity == null && w.entity != null) entity = w.entity;
            if (w.block != null) {
                block = w.block;
                blockName = w.blockName;
                finished = true;
                return;
            }
            t = Math.max(t, w.reached);
            if (w.missing != Long.MIN_VALUE) missing.add(w.missing);
            if (t >= end) finished = true;
        }

        void finish() {
            done.complete(new Look(block, blockName, entity));
        }
    }

    /** What the server thread hands the worker: the copied world, the entities, the stretch {@code [t0, t1]}. */
    private record Copy(CopiedView view, List<SquadLookTargets.Target<SquadTriggerJson.EntityRef>> targets, double t0, double t1, boolean last) {}

    /** What a step found: how far it walked, the block it hit (or null), the entity before, a section it missed. */
    private record Walked(double reached, BlockPos block, String blockName, SquadTriggerJson.EntityRef entity, long missing) {}

    /** A section the walk read that was not copied (no stack: it is control flow). */
    private static final class Missing extends RuntimeException {
        final long key;

        Missing(long key) {
            super(null, null, false, false);
            this.key = key;
        }
    }

    /**
     * The world as copied for one step: the copied sections, air where a section is empty or its chunk not loaded,
     * void air outside the height, air outside the player's view; any other section throws {@link Missing}.
     */
    private static final class CopiedView implements BlockView {
        private static final BlockState AIR = Blocks.AIR.getDefaultState();
        private static final BlockState VOID_AIR = Blocks.VOID_AIR.getDefaultState();
        private final Long2ObjectOpenHashMap<PalettedContainer<BlockState>> sections = new Long2ObjectOpenHashMap<>();
        private final LongOpenHashSet airSections = new LongOpenHashSet();
        private final int bottomY;
        private final int topY;
        private final ChunkFilter view;

        CopiedView(int bottomY, int topY, ChunkFilter view) {
            this.bottomY = bottomY;
            this.topY = topY;
            this.view = view;
        }

        boolean has(long key) {
            return sections.containsKey(key) || airSections.contains(key);
        }

        void put(long key, PalettedContainer<BlockState> states) {
            sections.put(key, states);
        }

        void air(long key) {
            airSections.add(key);
        }

        @Override
        public BlockState getBlockState(BlockPos pos) {
            int y = pos.getY();
            if (y < bottomY || y >= topY) return VOID_AIR;
            int cx = pos.getX() >> 4;
            int cz = pos.getZ() >> 4;
            long key = ChunkSectionPos.asLong(cx, y >> 4, cz);
            PalettedContainer<BlockState> s = sections.get(key);
            if (s != null) return s.get(pos.getX() & 15, y & 15, pos.getZ() & 15);
            if (airSections.contains(key) || !view.isWithinDistance(cx, cz)) return AIR;
            throw new Missing(key);
        }

        @Override
        public FluidState getFluidState(BlockPos pos) {
            return getBlockState(pos).getFluidState();
        }

        @Override
        public BlockEntity getBlockEntity(BlockPos pos) {
            return null;
        }

        @Override
        public int getHeight() {
            return topY - bottomY;
        }

        @Override
        public int getBottomY() {
            return bottomY;
        }
    }
}
