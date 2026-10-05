package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** Review of bug #7's fix: the drain logic, without a server (drainTick is what END_SERVER_TICK runs). */
class GodActionQueueTest {

    @AfterEach
    void reset() {
        GodActionQueue.clear();
    }

    @Test
    void aGodActionIsNotStuckBehindABulkBuild() {
        List<String> ran = new ArrayList<>();
        for (int i = 0; i < 500; i++) GodActionQueue.submitBulk(() -> { ran.add("place"); return "ok"; });
        CompletableFuture<String> reward = GodActionQueue.submit(() -> { ran.add("reward"); return "done"; });
        GodActionQueue.drainTick();
        assertTrue(reward.isDone(), "the action lane drains first, whatever the bulk backlog");
        assertEquals("reward", ran.get(0));
        assertEquals(1 + GodActionQueue.MAX_BULK_PER_TICK, ran.size(), "bulk work is bounded per tick");
    }

    @Test
    void anActionGivenUpOnNeverRunsLater() {
        List<String> ran = new ArrayList<>();
        CompletableFuture<String> f = GodActionQueue.submit(() -> { ran.add("punish"); return "done"; });
        assertTrue(GodActionQueue.cancelIfNotStarted(f), "not started yet → the waiter can withdraw it");
        GodActionQueue.drainTick();
        assertTrue(ran.isEmpty(), "a timed-out action reported as not executed must never execute");
        assertTrue(f.isCancelled());
    }

    @Test
    void anActionAlreadyRunCannotBeWithdrawn() {
        CompletableFuture<String> f = GodActionQueue.submit(() -> "done");
        GodActionQueue.drainTick();
        assertFalse(GodActionQueue.cancelIfNotStarted(f), "it ran — the caller must use its result, not claim failure");
        assertEquals("done", f.join());
    }

    @Test
    void aWithdrawnActionDoesNotUseUpTheTickBudget() {
        List<CompletableFuture<String>> dropped = new ArrayList<>();
        for (int i = 0; i < GodActionQueue.MAX_PER_TICK; i++) dropped.add(GodActionQueue.submit(() -> "x"));
        dropped.forEach(GodActionQueue::cancelIfNotStarted);
        CompletableFuture<String> live = GodActionQueue.submit(() -> "live");
        GodActionQueue.drainTick();
        assertEquals("live", live.join());
    }
}
