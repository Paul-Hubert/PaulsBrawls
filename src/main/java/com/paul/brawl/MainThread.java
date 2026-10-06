package com.paul.brawl;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Run a short world read or write on the main server thread and wait for it (bounded). Moved out of
 * {@code ChatBotFunctions.runOnMain} so the builtin ChatBot and the MCP servers share one hop (docs/27 §5).
 *
 * <p>On the server thread itself the body runs inline: queueing and waiting from the thread that drains the queue
 * would deadlock.
 */
public final class MainThread {

    private static final Logger LOGGER = LoggerFactory.getLogger("MainThread");

    /** Generous: a normal tick is 50 ms and {@link GodActionQueue#MAX_PER_TICK} is 8. */
    public static final long TIMEOUT_SECONDS = 5;

    private MainThread() {}

    /**
     * The body's result, run on the main thread. A {@link WorldRefusal} thrown by the body propagates unchanged;
     * a drain that does not start the body in time throws a refusal saying it was not executed (and it never will
     * be), and one that started but did not finish says the result is unknown.
     */
    public static <T> T call(Supplier<T> body) {
        var server = ChatBotActions.server();
        if (server != null && server.isOnThread()) return body.get();
        Object[] box = new Object[1];
        var future = GodActionQueue.submit(() -> {
            box[0] = body.get();
            return "ok";
        });
        try {
            future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException te) {
            if (GodActionQueue.cancelIfNotStarted(future)) {
                LOGGER.warn("Main-thread queue did not drain within {}s — server frozen/paused/stopping?", TIMEOUT_SECONDS);
                throw new WorldRefusal("Erreur côté serveur: action différée non exécutée (serveur indisponible).");
            }
            try {
                future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            } catch (Exception again) {
                LOGGER.warn("Main-thread action started but did not finish in time: {}", again.getMessage());
                throw new WorldRefusal("Erreur côté serveur: l'action a peut-être été exécutée (résultat inconnu), ne la relance pas.");
            }
        } catch (java.util.concurrent.ExecutionException ee) {
            if (ee.getCause() instanceof WorldRefusal r) throw r;
            LOGGER.warn("Main-thread action threw: {}", String.valueOf(ee.getCause()), ee.getCause());
            throw new WorldRefusal("Erreur côté serveur lors de l'exécution de cette action.");
        } catch (Exception e) {
            LOGGER.warn("Main-thread queue join failed: {}", e.getMessage(), e);
            throw new WorldRefusal("Erreur côté serveur lors de l'exécution de cette action.");
        }
        @SuppressWarnings("unchecked")
        T out = (T) box[0];
        return out;
    }

    /** {@link #call} for a body with no result. */
    public static void run(Runnable body) {
        call(() -> {
            body.run();
            return null;
        });
    }
}
