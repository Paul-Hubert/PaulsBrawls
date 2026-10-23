package com.paul.brawl;

import java.time.Duration;

/**
 * The external agent as {@link AgentTurns} sees it (docs/27 §6): sessions that keep a player's conversation, one
 * blocking call per turn, and an abort. Two implementations, picked by {@code agentKind} in
 * {@code god_agent.properties}: {@link AgentClient} ({@code opencode serve} over HTTP) and {@link ClaudeCodeClient}
 * (one headless {@code claude -p} process per turn). Minecraft-free.
 *
 * <p>The contract both keep, pinned by their end-to-end tests:
 * <ul>
 *   <li>{@link #send} never throws and never waits longer than {@code timeout}: it returns the turn's final
 *       assistant text, or a {@link Failure} — {@code DOWN} (the agent cannot be reached or died mid-turn),
 *       {@code TIMEOUT}, {@code ERROR} (it answered with an error, or the turn was aborted).</li>
 *   <li>{@link #abort} stops a running turn of that session; best-effort, never throws.</li>
 *   <li>A session id from {@link #createSession} can be sent to again: the agent remembers the conversation.
 *       Forgetting it (a new id) starts a fresh one.</li>
 * </ul>
 */
public interface AgentBackend {

    /** What went wrong, so the caller can pick the French message (docs/27 §6 failure table). */
    enum Failure { DOWN, TIMEOUT, ERROR }

    /** One agent turn: the final assistant text, or a failure with its detail (for the log). */
    record Reply(String text, Failure failure, String detail) {
        static Reply ok(String text) { return new Reply(text, null, null); }
        static Reply fail(Failure f, String detail) { return new Reply("", f, detail); }
        public boolean ok() { return failure == null; }
    }

    /** Thrown by {@link #createSession} when the agent cannot be reached or refuses. */
    final class AgentException extends Exception {
        final Failure failure;
        AgentException(Failure failure, String message) {
            super(message);
            this.failure = failure;
        }
    }

    /** A new conversation; returns its id. */
    String createSession(String title) throws AgentException;

    /** One turn of {@code agent} in session {@code sessionId}: {@code text} plus an optional PNG/JPEG image. */
    Reply send(String sessionId, String agent, String text, byte[] image, Duration timeout);

    /** Stop the session's running turn, if any. */
    void abort(String sessionId);
}
