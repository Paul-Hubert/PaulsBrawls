package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.ConnectException;
import java.net.http.HttpTimeoutException;

import org.junit.jupiter.api.Test;

class EdenRetryTest {

    @Test
    void restartIsNeverResentOnAnAmbiguousFailure() {
        assertFalse(EdenRetry.isIdempotent("restart"));
        // Bug #16: a timed-out restart was retried, so Eden could wipe and restart the village twice.
        assertFalse(EdenRetry.shouldRetry(false, new HttpTimeoutException("request timed out")));
        assertFalse(EdenRetry.shouldRetry(false, new IOException("HTTP/1.1 header parser received no bytes")));
    }

    @Test
    void aRefusedConnectionIsAlwaysRetried() {
        assertTrue(EdenRetry.shouldRetry(false, new ConnectException("Connection refused")), "the request never arrived");
        assertTrue(EdenRetry.shouldRetry(true, new ConnectException("Connection refused")));
    }

    @Test
    void idempotentActionsRetryAnyIoFailure() {
        assertTrue(EdenRetry.isIdempotent("start"));
        assertTrue(EdenRetry.isIdempotent("stop"));
        assertTrue(EdenRetry.shouldRetry(true, new HttpTimeoutException("timed out")));
        assertFalse(EdenRetry.shouldRetry(true, new IllegalStateException("not I/O")));
    }
}
