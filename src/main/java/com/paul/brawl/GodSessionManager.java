package com.paul.brawl;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ScheduledFuture;
import java.util.function.Consumer;
import java.util.concurrent.atomic.AtomicReference;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.minecraft.server.network.ServerPlayerEntity;

/**
 * Single-owner busy lock for the shared avatar (see GOD_BOT_INTEGRATION_PLAN.md §5).
 *
 * <p>One encounter at a time. A second player who prays while the body is busy
 * gets a bodiless reply: God still answers in text but doesn't manifest. This
 * removes every cross-session race over the shared avatar — there is exactly
 * one process driving Appear / Vanish / the invuln flag at any moment.
 *
 * <p>An idle watchdog force-vanishes a session that goes quiet for
 * {@link BridgeConfig#idleTimeoutSeconds}. Each user message, each Wait and
 * every tool dispatch of the owning session (bug #8) resets it; the timeout is required to exceed {@code waitMaxSeconds} so a
 * deliberate pause doesn't trip it.
 */
public final class GodSessionManager {

    private static final Logger LOGGER = LoggerFactory.getLogger("GodSessionManager");

    /** UUID of the player currently holding the avatar, or null if free. */
    private static final AtomicReference<UUID> owner = new AtomicReference<>(null);

    /** True after the model has called Appear at least once in the active session. */
    private static volatile boolean manifested = false;

    /** Pending idle-watchdog task — cancelled and replaced on every reset. */
    private static volatile ScheduledFuture<?> watchdog;

    /**
     * Bumped every time a free avatar is claimed and every time a session ends. An external-agent ticket records
     * the generation it was minted under, so a ticket from an earlier session of the same player is dead
     * (docs/27 §5).
     */
    private static volatile long generation = 0;

    /** Called with the former owner (null if none) every time a session ends, by any path. */
    private static final List<Consumer<UUID>> END_LISTENERS = new CopyOnWriteArrayList<>();

    private GodSessionManager() {}

    /**
     * Try to give {@code player} the avatar. Returns true if the lock was
     * acquired (or was already held by the same player — re-praying mid-
     * encounter just resets the timer). Returns false if another player owns
     * it.
     */
    public static synchronized boolean claim(ServerPlayerEntity player) {
        return player != null && claim(player.getUuid());
    }

    /** UUID form of {@link #claim(ServerPlayerEntity)} (Minecraft-free, used by tests and the MCP servers). */
    public static synchronized boolean claim(UUID id) {
        if (id == null) return false;
        UUID prev = owner.get();
        if (prev != null && !prev.equals(id)) {
            return false;
        }
        if (prev == null) generation++;
        owner.set(id);
        resetIdleTimer(id);
        return true;
    }

    public static boolean isActive(ServerPlayerEntity player) {
        return player != null && isOwner(player.getUuid());
    }

    /** Whether {@code id} holds the avatar session right now. */
    public static boolean isOwner(UUID id) {
        return id != null && id.equals(owner.get());
    }

    /** The current session generation (see {@link #generation}). */
    public static long generation() {
        return generation;
    }

    /** Register a callback run after every session end (idle watchdog, /pray stop, /godbody off, natural end). */
    public static void addEndListener(Consumer<UUID> listener) {
        END_LISTENERS.add(listener);
    }

    public static boolean isBusy() {
        return owner.get() != null;
    }

    public static UUID currentOwner() {
        return owner.get();
    }

    /** Marks that {@code Appear} has run in the current session. */
    public static void markManifested() {
        manifested = true;
    }

    /** Clears the manifested flag after a deliberate {@code Vanish} so speech
     *  and gestures stop routing through the parked bot while the session
     *  continues; a later {@code Appear} sets it again. */
    public static void clearManifested() {
        manifested = false;
    }

    /** Whether the avatar has been teleported in for the current session. */
    public static boolean hasManifested() {
        return manifested;
    }

    /**
     * Release the lock and stop the watchdog. Idempotent. Caller is responsible
     * for any vanish / restoreAvatar side effects — endSession only manages
     * lock state.
     */
    public static synchronized void endSession(ServerPlayerEntity player) {
        endSession(player == null ? null : player.getUuid());
    }

    /** UUID form of {@link #endSession(ServerPlayerEntity)}; null releases unconditionally. */
    public static synchronized void endSession(UUID id) {
        if (id != null && !id.equals(owner.get())) {
            // Another player's session is active; don't yank it out from under them.
            return;
        }
        forceEndSession();
    }

    /** Unconditional release — used by the admin kill-switch. */
    public static synchronized void forceEndSession() {
        UUID former = owner.getAndSet(null);
        manifested = false;
        generation++;
        if (watchdog != null) {
            watchdog.cancel(false);
            watchdog = null;
        }
        for (Consumer<UUID> l : END_LISTENERS) {
            try {
                l.accept(former);
            } catch (RuntimeException e) {
                LOGGER.warn("session-end listener threw: {}", e.getMessage(), e);
            }
        }
    }

    /**
     * Suspend the owner's idle watchdog while an LLM request is in flight. A reasoning model can take longer than
     * {@code idleTimeoutSeconds} (90 s) to answer, well inside the LLM timeout (180 s); the watchdog used to end the
     * session mid-chain. The request itself is bounded by the provider timeout, and its completion calls
     * {@link #resetIdleTimer} (the error path ends the session), so the session cannot hang. Owner-only, like reset.
     */
    public static synchronized void pauseIdleTimer(ServerPlayerEntity player) {
        if (player == null || !isOwner(player.getUuid())) return;
        if (watchdog != null) watchdog.cancel(false);
        watchdog = null;
    }

    /**
     * Cancel and reschedule the idle watchdog. Called from {@link #claim} and
     * from the per-turn hooks in {@link ChatBot} so a chatty session keeps the
     * body around indefinitely.
     */
    public static synchronized void resetIdleTimer(ServerPlayerEntity player) {
        if (player != null) resetIdleTimer(player.getUuid());
    }

    /** UUID form of {@link #resetIdleTimer(ServerPlayerEntity)}. */
    public static synchronized void resetIdleTimer(UUID id) {
        // Ownership guard: only the session owner may touch the watchdog. A
        // bodiless prayer reaching this via Appear/Wait would otherwise cancel
        // the real owner's watchdog and pin a replacement to the wrong UUID
        // (whose body then no-ops on the cur.equals(pinned) check).
        if (!isOwner(id)) return;
        if (watchdog != null) watchdog.cancel(false);
        final UUID pinned = id;
        int seconds = Math.max(BridgeConfig.INSTANCE.idleTimeoutSeconds,
                               BridgeConfig.INSTANCE.waitMaxSeconds + 5);
        watchdog = GodScheduler.schedule(() -> {
            UUID cur = owner.get();
            if (cur == null || !cur.equals(pinned)) return;
            LOGGER.info("Idle watchdog fired for {}", pinned);
            // Reach back through the server registry to vanish + clear invuln
            // safely on the main thread.
            ChatBotActions.dismissAvatarOnWatchdog(pinned);
            forceEndSession();
        }, seconds);
    }
}
