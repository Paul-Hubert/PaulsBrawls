package com.paul.brawl;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

import org.slf4j.LoggerFactory;

/**
 * Sub-build leases for the {@code builder} MCP server (docs/27 §4): the server-side form of BuildGuard's
 * "at most 4 parallel sub-builds". An agent's sub-agent opens a lease with {@code begin_sub_build}, places relative
 * to its anchor, and closes it with {@code end_sub_build}. A lease idle for {@code idleMillis}, or opened before a
 * {@link BuildGuard#cancelAll()} ({@code /godbody off}, server stop), is dropped and its slot released — so an agent
 * that dies cannot hold the slots, and cancelled builds stay cancelled. Every call sweeps, and
 * {@link #startSweeper} sweeps on a timer too, so a dead lease does not keep its BuildGuard slot (shared with the
 * builtin {@code BuildSubAgent}) until some later builder call. Minecraft-free (SubBuildsSweeperTest, the bench).
 */
public final class SubBuilds {

    /** Anchor offsets from the pivot are limited to ±this per axis. */
    public static final int MAX_ANCHOR_OFFSET = 256;

    public static final class Lease {
        final String id;
        final UUID player;
        final String label;
        final int[] anchor; // absolute
        final int epoch;
        volatile long lastUse;
        private final java.util.concurrent.atomic.AtomicInteger mobs = new java.util.concurrent.atomic.AtomicInteger();

        Lease(String id, UUID player, String label, int[] anchor, int epoch, long now) {
            this.id = id;
            this.player = player;
            this.label = label;
            this.anchor = anchor;
            this.epoch = epoch;
            this.lastUse = now;
        }

        public String id() { return id; }
        public UUID player() { return player; }
        public String label() { return label; }
        public int[] anchor() { return anchor.clone(); }

        /** Reserve {@code n} of this lease's {@link BuildGuard#MAX_MOBS_PER_SUB_BUILD} spawns; false (none taken) if they do not fit. */
        public boolean reserveMobs(int n) {
            while (true) {
                int m = mobs.get();
                if (m + n > BuildGuard.MAX_MOBS_PER_SUB_BUILD) return false;
                if (mobs.compareAndSet(m, m + n)) return true;
            }
        }

        /** Give back a reservation whose spawn was refused. */
        public void returnMobs(int n) {
            mobs.updateAndGet(m -> Math.max(0, m - n));
        }
    }

    /** {@code lease} on success, else the refusal the model reads. */
    public record Result(Lease lease, String refusal) {}

    private final Map<String, Lease> leases = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final LongSupplier clock;
    private final long idleMillis;

    public SubBuilds(LongSupplier clock, long idleMillis) {
        this.clock = clock;
        this.idleMillis = idleMillis;
    }

    /** Open a lease at {@code origin + (ax, ay, az)} if a BuildGuard slot is free. */
    public synchronized Result begin(UUID player, int[] origin, String label, int ax, int ay, int az) {
        sweep();
        if (Math.abs(ax) > MAX_ANCHOR_OFFSET || Math.abs(ay) > MAX_ANCHOR_OFFSET || Math.abs(az) > MAX_ANCHOR_OFFSET) {
            return new Result(null, "Ancre refusée : chaque décalage doit rester entre -" + MAX_ANCHOR_OFFSET
                + " et " + MAX_ANCHOR_OFFSET + " blocs du pivot.");
        }
        if (!BuildGuard.tryAcquire()) {
            return new Result(null, "Sous-construction refusée : " + BuildGuard.MAX_CONCURRENT_SUB_BUILDS
                + " tournent déjà sur le serveur. Termine-en une (end_sub_build) ou réessaie plus tard.");
        }
        byte[] b = new byte[9];
        random.nextBytes(b);
        String id = "sb-" + Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        int[] anchor = { origin[0] + ax, origin[1] + ay, origin[2] + az };
        Lease l = new Lease(id, player, label == null ? "" : label, anchor, BuildGuard.epoch(), clock.getAsLong());
        leases.put(id, l);
        return new Result(l, null);
    }

    /** The caller's live lease (its idle clock restarts), or the refusal. */
    public synchronized Result use(String id, UUID player) {
        sweep();
        Lease l = id == null ? null : leases.get(id.trim());
        if (l == null) {
            return new Result(null, "Sous-construction inconnue, terminée, annulée ou expirée : '" + id
                + "'. Ouvre-en une nouvelle avec begin_sub_build.");
        }
        if (!l.player.equals(player)) {
            return new Result(null, "Cette sous-construction appartient à une autre construction.");
        }
        l.lastUse = clock.getAsLong();
        return new Result(l, null);
    }

    /** Close the caller's lease and release its slot; false if it was not live. */
    public synchronized boolean end(String id, UUID player) {
        Result r = use(id, player);
        if (r.lease() == null) return false;
        drop(r.lease());
        return true;
    }

    /** Close every lease of {@code player} (null = all), e.g. when their build ticket dies. */
    public synchronized int endAll(UUID player) {
        int n = 0;
        for (Lease l : leases.values()) {
            if (player == null || l.player.equals(player)) {
                drop(l);
                n++;
            }
        }
        return n;
    }

    public int live() {
        return leases.size();
    }

    /**
     * Sweep every {@code periodMillis} on a daemon thread until the returned handle is closed (external mode starts
     * it with the MCP servers and closes it on server stop). Idleness is still measured with the injected clock,
     * so a test advances that clock and the sweeper does the rest.
     */
    public AutoCloseable startSweeper(long periodMillis) {
        ScheduledExecutorService ex = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "sub-build-sweeper");
            t.setDaemon(true);
            return t;
        });
        ex.scheduleWithFixedDelay(() -> {
            try {
                sweep();
            } catch (RuntimeException e) {
                LoggerFactory.getLogger("SubBuilds").warn("Sub-build sweep failed: {}", e.toString());
            }
        }, periodMillis, periodMillis, TimeUnit.MILLISECONDS);
        return ex::shutdownNow;
    }

    /** The sweep period for an idle limit: a quarter of it, between 1 s and 30 s. */
    public static long sweepPeriodMillis(long idleMillis) {
        return Math.max(1_000, Math.min(30_000, idleMillis / 4));
    }

    /** Drop idle and cancelled leases, releasing their slots. */
    public synchronized void sweep() {
        long now = clock.getAsLong();
        for (Lease l : leases.values()) {
            if (BuildGuard.cancelledSince(l.epoch) || now - l.lastUse >= idleMillis) drop(l);
        }
    }

    private void drop(Lease l) {
        if (leases.remove(l.id) != null) BuildGuard.release();
    }
}
