package com.paul.brawl.squad;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/**
 * Futures that complete in the order they were registered, per key, and whose callbacks run in that order. A
 * commander's snapshots wait for their long look ({@link SquadLook}), which takes one tick or several, so a bound
 * bow's {@code arrow-hit} could otherwise reach the runtime before the {@code arrow-release} that starts its order
 * (docs/29 §5.4).
 */
final class SquadInOrder<K> {

    private static final CompletableFuture<Void> OPEN = CompletableFuture.completedFuture(null);

    /** Per key, the gate of the last future registered: open once that future's callbacks have run. */
    private final Map<K, CompletableFuture<Void>> gates = new HashMap<>();

    /**
     * {@code f}'s outcome, completed once {@code f} is and every future registered before it under {@code key} has
     * completed (failed or not) and run its callbacks. A callback added to the answer runs on the thread that
     * completes it, before the next one's. (Chaining on the earlier future itself would not do: a CompletableFuture
     * runs its dependents last-registered first.)
     */
    synchronized <T> CompletableFuture<T> after(K key, CompletableFuture<T> f) {
        CompletableFuture<Void> prev = gates.getOrDefault(key, OPEN);
        CompletableFuture<T> out = new CompletableFuture<>();
        CompletableFuture<Void> gate = new CompletableFuture<>();
        gates.put(key, gate);
        prev.thenCompose(x -> f).whenComplete((v, e) -> {
            try {
                if (e == null) out.complete(v);
                else out.completeExceptionally(e instanceof CompletionException && e.getCause() != null ? e.getCause() : e);
            } finally {
                forget(key, gate);
                gate.complete(null);
            }
        });
        return out;
    }

    /** Keys still waiting on a future (tests). */
    synchronized int pending() {
        return gates.size();
    }

    private synchronized void forget(K key, CompletableFuture<Void> gate) {
        gates.remove(key, gate);
    }
}
