package com.paul.brawl;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

/**
 * Tiny {@link ScheduledExecutorService} dedicated to the {@code Wait} tool
 * (see GOD_BOT_INTEGRATION_PLAN.md §6c).
 *
 * <p>Why a separate scheduler rather than reusing {@link SalaryScheduler}'s
 * pool? Different lifetimes, different failure modes — and salary jobs run
 * forever while wait jobs are one-shot. Keeping them apart means cancelling
 * pending waits via the kill-switch can't accidentally stop salaries.
 *
 * <p>Threads are daemons so they never block JVM shutdown.
 */
public final class GodScheduler {

    private static final Logger LOGGER = LoggerFactory.getLogger("GodScheduler");

    private static ScheduledExecutorService scheduler;

    private GodScheduler() {}

    public static void register() {
        ServerLifecycleEvents.SERVER_STARTED.register(s -> ensureStarted());
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> shutdown());
    }

    private static synchronized void ensureStarted() {
        if (scheduler != null && !scheduler.isShutdown()) return;
        scheduler = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger();
            @Override public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "god-scheduler-" + seq.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        });
        LOGGER.info("GodScheduler started");
    }

    public static synchronized void shutdown() {
        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
            LOGGER.info("GodScheduler stopped");
        }
    }

    /**
     * Schedule {@code task} to run after {@code seconds}. The task runs on a
     * background thread — if it needs the main thread, it must enqueue via
     * {@link GodActionQueue} itself. Returns a handle the caller can cancel
     * (e.g. on session-end or kill-switch).
     */
    public static synchronized ScheduledFuture<?> schedule(Runnable task, long seconds) {
        ensureStarted();
        return scheduler.schedule(() -> {
            try {
                task.run();
            } catch (Throwable t) {
                LOGGER.warn("scheduled task threw: {}", t.getMessage(), t);
            }
        }, seconds, TimeUnit.SECONDS);
    }
}
