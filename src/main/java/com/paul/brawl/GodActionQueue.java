package com.paul.brawl;

import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
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

    /** Bulk lane budget per tick (textual build placements), drained after the action lane. */
    public static final int MAX_BULK_PER_TICK = 8;

    /**
     * The future handed back by {@link #submit}. {@code started} is claimed exactly once — by the drain when it runs
     * the body, or by {@link #cancelIfNotStarted} when a waiter gives up — so a caller that reports "not executed"
     * after a timeout is telling the truth: the body will never run later.
     */
    static final class Pending extends CompletableFuture<String> {
        final AtomicBoolean started = new AtomicBoolean();
    }

    private record QueuedAction(Supplier<String> body, Pending result) {}

    /** God actions (Reward, Punishment, …): small, latency-sensitive, waited on for 5 s by runOnMain. */
    private static final Queue<QueuedAction> QUEUE = new ConcurrentLinkedQueue<>();
    /**
     * Textual build placements (bug #7 moved them onto the main thread). A separate lane, so a large BuildPlan cannot
     * push a God action past runOnMain's 5 s wait — which used to report "non exécutée" for an action that then ran
     * anyway, inviting the model to retry it.
     */
    private static final Queue<QueuedAction> BULK = new ConcurrentLinkedQueue<>();

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
        Pending f = new Pending();
        QUEUE.add(new QueuedAction(body, f));
        return f;
    }

    /** Enqueue a bulk world write (a textual build placement) on the low-priority lane. */
    public static CompletableFuture<String> submitBulk(Supplier<String> body) {
        Pending f = new Pending();
        BULK.add(new QueuedAction(body, f));
        return f;
    }

    /**
     * Give up on a submitted action: true if it had not started and now never will (its future is cancelled);
     * false if the drain already claimed it (it is running or done — wait for its result instead).
     */
    public static boolean cancelIfNotStarted(CompletableFuture<String> f) {
        if (!(f instanceof Pending p)) return false;
        if (!p.started.compareAndSet(false, true)) return false;
        p.cancel(false);
        return true;
    }

    /** Drop every queued action — used by the kill-switch and session-end paths. */
    public static int clear() {
        return clearLane(QUEUE) + clearLane(BULK);
    }

    private static int clearLane(Queue<QueuedAction> lane) {
        int n = 0;
        QueuedAction a;
        while ((a = lane.poll()) != null) {
            if (a.result().started.compareAndSet(false, true)) a.result().cancel(false);
            n++;
        }
        return n;
    }

    public static int size() {
        return QUEUE.size() + BULK.size();
    }

    /** One tick's work: up to {@link #MAX_PER_TICK} actions, then up to {@link #MAX_BULK_PER_TICK} bulk writes. */
    static void drainTick() {
        drainLane(QUEUE, MAX_PER_TICK);
        drainLane(BULK, MAX_BULK_PER_TICK);
    }

    private static void drainLane(Queue<QueuedAction> lane, int budget) {
        int ran = 0;
        while (ran < budget) {
            QueuedAction a = lane.poll();
            if (a == null) break;
            if (!a.result().started.compareAndSet(false, true)) continue; // a waiter gave up on it — never run it
            ran++;
            try {
                a.result().complete(a.body().get());
            } catch (Throwable t) {
                LOGGER.warn("queued action threw on main thread: {}", t.getMessage(), t);
                a.result().completeExceptionally(t);
            }
        }
    }

    public static void register() {
        ServerTickEvents.END_SERVER_TICK.register(server -> drainTick());
        LOGGER.info("GodActionQueue registered (MAX_PER_TICK={}, MAX_BULK_PER_TICK={})", MAX_PER_TICK, MAX_BULK_PER_TICK);
    }
}
