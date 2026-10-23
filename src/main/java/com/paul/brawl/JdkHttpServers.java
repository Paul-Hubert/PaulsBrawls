package com.paul.brawl;

/**
 * Tuning of the JDK's built-in {@code com.sun.net.httpserver} for the mod's loopback servers (the {@code god}/
 * {@code builder} MCP servers on {@code :8771} and the village settlement listener on {@code :8767}).
 *
 * <p><b>TCP_NODELAY.</b> The JDK server writes a response's headers and its body as two small TCP segments. With
 * Nagle's algorithm on, the body waits for the ACK of the headers, and the client delays that ACK (~40 ms on
 * Linux): every request paid ~40 ms of idle time, so a build of 500 {@code place_*} calls spent ~20 s waiting on
 * TCP. The server turns Nagle off when {@code sun.net.httpserver.nodelay} is true, but it reads that property
 * ONCE, in the static initializer of {@code sun.net.httpserver.ServerConfig}, i.e. when the first
 * {@code HttpServer} of the JVM is created. {@link #tcpNoDelay()} must therefore run before that: the server
 * entry point calls it first thing, and every creator of an {@code HttpServer} calls it again (a no-op after the
 * first). An explicit {@code -Dsun.net.httpserver.nodelay=false} is respected.
 *
 * <p>No behaviour changes for the settlement listener: the same bytes, sent without the stall.
 */
public final class JdkHttpServers {

    static final String NODELAY = "sun.net.httpserver.nodelay";

    private JdkHttpServers() {}

    /** Ask the JDK HttpServer for TCP_NODELAY, unless the property was set explicitly. Idempotent. */
    public static void tcpNoDelay() {
        if (System.getProperty(NODELAY) == null) System.setProperty(NODELAY, "true");
    }
}
