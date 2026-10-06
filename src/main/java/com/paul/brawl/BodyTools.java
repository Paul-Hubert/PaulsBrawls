package com.paul.brawl;

import java.util.List;
import java.util.Map;

/**
 * Port: the Mineflayer tools that move the avatar body (the Node MCP server behind {@link MCPGateway}), as the
 * {@code god} MCP server re-exposes them through {@code body_tools} / {@code body_call} (docs/27 §4). Proxying keeps
 * {@link GodToolGate} in the mod and the Node process unchanged.
 */
public interface BodyTools {

    record Spec(String name, String description, Map<String, Object> inputSchema) {}

    /** The tools the Node server currently advertises (empty when it is down). */
    List<Spec> list();

    /** Whether {@code name} is one of them. */
    boolean has(String name);

    /** Run one tool with JSON arguments; the result text (an error text when the call failed). */
    String call(String name, String argumentsJson);
}
