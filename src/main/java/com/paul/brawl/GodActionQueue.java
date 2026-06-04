package com.paul.brawl;

import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;

/**
 * Main-thread FIFO action queue for world mutations triggered from off-thread
 * (the LangChain4j callback runs on an llm-worker thread, never on the server
 * tick thread). See GOD_BOT_INTEGRATION_PLAN.md §7.
 *
 * <p>Producer side: any thread can {@link #submit} a {@link Supplier} of a
 * result string; it returns a {@link CompletableFuture} that completes when
 * the body runs on the main thread.
 *
 * <p>Consumer side: a single drain on {@code END_SERVER_TICK} runs up to
 * {@link #MAX_PER_TICK} items in enqueue order. Leftover items roll to the
 * next tick — order is preserved by {@link ConcurrentLinkedQueue}'s FIFO.
 */
public final class GodActionQueue {

    private static final Logger LOGGER = LoggerFactory.getLogger("GodActionQueue");

    /** Bounds per-tick work so a burst of tool calls can't lag-spike the server. */
    public static final int MAX_PER_TICK = 8;

    private record QueuedAction(Supplier<String> body, CompletableFuture<String> result) {}

    private static final Queue<QueuedAction> QUEUE = new ConcurrentLinkedQueue<>();

    private GodActionQueue() {}

    /**
     * Enqueue a world mutation. The body runs on the main server thread no
     * later than the next-after-current tick, and its return value (or
     * exception) completes the returned future.
     *
     * <p>The body MUST be short — anything heavy (LLM call, network I/O)
     * belongs on a worker thread, with only the final world write enqueued
     * here.
     */
    public static CompletableFuture<String> submit(Supplier<String> body) {
        CompletableFuture<String> f = new CompletableFuture<>();
        QUEUE.add(new QueuedAction(body, f));
        return f;
    }

    /** Drop every queued action — used by the kill-switch and session-end paths. */
    public static int clear() {
        int n = 0;
        QueuedAction a;
        while ((a = QUEUE.poll()) != null) {
            a.result().cancel(false);
            n++;
        }
        return n;
    }

    public static int size() {
        return QUEUE.size();
    }

    public static void register() {
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            for (int i = 0; i < MAX_PER_TICK; i++) {
                QueuedAction a = QUEUE.poll();
                if (a == null) break;
                try {
                    a.result().complete(a.body().get());
                } catch (Throwable t) {
                    LOGGER.warn("queued action threw on main thread: {}", t.getMessage(), t);
                    a.result().completeExceptionally(t);
                }
            }
        });
        LOGGER.info("GodActionQueue registered (MAX_PER_TICK={})", MAX_PER_TICK);
    }
}
