package com.paul.brawl;

import java.io.IOException;
import java.net.ConnectException;

/**
 * Bug #16 — which failed {@code /villagers} POSTs may be re-sent. Minecraft-free (EdenRetryTest).
 *
 * <p>{@code start} and {@code stop} are idempotent on Eden's side (a second start reports "already running"), so any
 * I/O failure is worth a retry. {@code restart} is NOT: it wipes every villager's state. A timeout or a "received no
 * bytes" close may mean Eden got the request and is executing it, so re-sending would restart (and wipe) twice. Only a
 * refused connection proves the request never arrived.
 */
public final class EdenRetry {
    private EdenRetry() {}

    /** May a request that failed with {@code rootCause} be sent again? */
    public static boolean shouldRetry(boolean idempotent, Throwable rootCause) {
        if (rootCause instanceof ConnectException) return true; // never reached Eden
        return idempotent && rootCause instanceof IOException;
    }

    /** Whether a {@code /scenario/<action>} POST is safe to repeat. */
    public static boolean isIdempotent(String action) {
        return !"restart".equals(action);
    }
}
