package com.paul.brawl;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * An Anthropic Messages API endpoint ({@code POST /v1/messages}, streaming SSE or plain JSON) that plays a fixed
 * script, standing in ONLY for the paid LLM in {@link ClaudeCodeE2ETest}: Claude Code ({@code claude -p}), its
 * agents, permissions and MCP client, and the mod's MCP servers are real. It is {@link ScriptedLlm}'s twin for the
 * Anthropic wire format. The script reads which agent is calling from the tools it is offered:
 * <ul>
 *   <li>{@code mcp__god__say} offered → the God: appear + reward + say with the ticket from the prayer, then stop.
 *       A prayer containing SILENT gets plain text only; SLOW appears, then hangs (abort and kill tests).</li>
 *   <li>the sub-agent tool ({@code Agent} or {@code Task}) offered → the Builder: one sub-agent call to
 *       {@code sub-builder}, then a closing sentence.</li>
 *   <li>{@code mcp__builder__place_line} without a sub-agent tool → a sub-builder: begin, place_line, end, sentence.</li>
 *   <li>anything else → plain text (Claude Code's own side requests, e.g. titles).</li>
 * </ul>
 * Every request is recorded so the test can check what Claude Code exposed and sent.
 */
final class ScriptedAnthropic implements AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern GOD_TICKET = Pattern.compile("god-[A-Za-z0-9_-]+");
    private static final Pattern BLD_TICKET = Pattern.compile("bld-[A-Za-z0-9_-]+");
    private static final Pattern SUB_BUILD = Pattern.compile("sub_build\\W{1,8}(sb-[A-Za-z0-9_-]+)");

    /** One request: the tools offered, whether the turn's user message carried an image, its text, the system prompt. */
    record Seen(String path, List<String> tools, boolean image, String lastUser, String system, JsonNode body) {}

    final List<Seen> seen = Collections.synchronizedList(new ArrayList<>());
    /** Requests to paths this mock does not serve (to see what a Claude Code version needs). */
    final List<String> unknown = Collections.synchronizedList(new ArrayList<>());
    volatile long delayMillis = 0;
    private final AtomicInteger ids = new AtomicInteger();
    private final HttpServer http;

    ScriptedAnthropic() throws IOException {
        JdkHttpServers.tcpNoDelay();
        http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        http.createContext("/", this::handle);
        http.setExecutor(Executors.newThreadPerTaskExecutor(Thread.ofVirtual().factory()));
        http.start();
    }

    String baseUrl() {
        return "http://127.0.0.1:" + http.getAddress().getPort();
    }

    @Override
    public void close() {
        http.stop(0);
    }

    private void handle(HttpExchange ex) throws IOException {
        try (ex) {
            String path = ex.getRequestURI().getPath();
            byte[] raw = ex.getRequestBody().readAllBytes();
            if (path.equals("/v1/messages/count_tokens")) {
                json(ex, 200, "{\"input_tokens\":12}");
            } else if (path.equals("/v1/messages") && "POST".equals(ex.getRequestMethod())) {
                messages(ex, JSON.readTree(raw));
            } else {
                unknown.add(ex.getRequestMethod() + " " + ex.getRequestURI());
                json(ex, 404, "{\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"mock: no such route\"}}");
            }
        } catch (RuntimeException e) {
            unknown.add("mock failure: " + e);
        }
    }

    private void messages(HttpExchange ex, JsonNode body) throws IOException {
        List<String> tools = new ArrayList<>();
        for (JsonNode t : body.path("tools")) tools.add(t.path("name").asText());
        // This turn = the messages after the last user message that carries text (tool results are user messages too).
        List<JsonNode> turn = new ArrayList<>();
        String lastUser = "";
        boolean image = false;
        for (JsonNode m : body.path("messages")) {
            if ("user".equals(m.path("role").asText()) && hasUserText(m)) {
                turn.clear();
                lastUser = m.path("content").toString();
                image = lastUser.contains("\"type\":\"image\"");
            }
            turn.add(m);
        }
        String system = body.path("system").toString();
        seen.add(new Seen(ex.getRequestURI().toString(), tools, image, lastUser, system, body));
        int toolResults = 0;
        for (JsonNode m : turn) {
            for (JsonNode c : m.path("content")) if ("tool_result".equals(c.path("type").asText())) toolResults++;
        }
        String turnText = turn.toString();
        if (delayMillis > 0) sleep(delayMillis);

        if (lastUser.contains("BADKEY")) {
            json(ex, 401, "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}");
            return;
        }
        String agentTool = tools.contains("Agent") ? "Agent" : tools.contains("Task") ? "Task" : null;
        List<Map<String, Object>> blocks;
        if (tools.contains("mcp__god__say")) {
            String ticket = find(GOD_TICKET, lastUser, 0);
            if (lastUser.contains("SLOW") && toolResults == 0) {
                blocks = List.of(toolUse("mcp__god__appear", Map.of("ticket", ticket)));
            } else if (lastUser.contains("SLOW")) {
                sleep(120_000);
                blocks = List.of(text("trop tard"));
            } else if (lastUser.contains("SILENT") || toolResults > 0) {
                blocks = List.of(text(lastUser.contains("SILENT") ? "Je t'ai entendu, mortel." : ""));
            } else {
                blocks = List.of(
                    toolUse("mcp__god__appear", Map.of("ticket", ticket)),
                    toolUse("mcp__god__reward", Map.of("ticket", ticket, "item", "minecraft:diamond", "amount", 2)),
                    toolUse("mcp__god__say", Map.of("ticket", ticket, "message", "Je t'ai entendu.")));
            }
        } else if (agentTool != null && tools.stream().anyMatch(n -> n.startsWith("mcp__builder__"))) {
            if (lastUser.contains("<task-notification>")) {
                // A background sub-agent finished: Claude Code wakes the planner with a notification.
                blocks = List.of(text("Une tour de guet se dresse au nord."));
            } else if (toolResults == 0) {
                String ticket = find(BLD_TICKET, lastUser, 0);
                blocks = List.of(toolUse(agentTool, Map.of("description", "tour de guet", "subagent_type", "sub-builder",
                    "prompt", "Ticket : " + ticket + ". Ancre : anchor_x=4 anchor_y=0 anchor_z=4. Construis une tour de guet.")));
            } else if (turnText.contains("Async agent launched")) {
                blocks = List.of(text("Les bâtisseurs sont à l'œuvre."));
            } else {
                blocks = List.of(text("Une tour de guet se dresse au nord."));
            }
        } else if (tools.contains("mcp__builder__place_line")) {
            String ticket = find(BLD_TICKET, lastUser, 0);
            String sb = find(SUB_BUILD, turnText, 1);
            blocks = switch (toolResults) {
                case 0 -> List.of(toolUse("mcp__builder__begin_sub_build",
                    Map.of("ticket", ticket, "label", "tour", "anchor_x", 4, "anchor_y", 0, "anchor_z", 4)));
                case 1 -> List.of(toolUse("mcp__builder__place_line", Map.of("ticket", ticket, "sub_build", sb,
                    "x1", 0, "y1", 0, "z1", 0, "x2", 0, "y2", 4, "z2", 0, "block", "minecraft:stone")));
                case 2 -> List.of(toolUse("mcp__builder__end_sub_build", Map.of("ticket", ticket, "sub_build", sb)));
                default -> List.of(text("Tour finie."));
            };
        } else {
            blocks = List.of(text("Titre"));
        }

        String stop = blocks.stream().anyMatch(b -> "tool_use".equals(b.get("type"))) ? "tool_use" : "end_turn";
        String model = body.path("model").asText("mock");
        if (body.path("stream").asBoolean(false)) stream(ex, model, blocks, stop);
        else json(ex, 200, JSON.writeValueAsString(message(model, blocks, stop)));
    }

    private static boolean hasUserText(JsonNode m) {
        JsonNode c = m.path("content");
        if (c.isTextual()) return true;
        for (JsonNode b : c) if ("text".equals(b.path("type").asText()) || "image".equals(b.path("type").asText())) {
            // Claude Code may append a text block (e.g. a reminder) next to tool results; a turn starts at a message
            // with no tool_result.
            for (JsonNode b2 : c) if ("tool_result".equals(b2.path("type").asText())) return false;
            return true;
        }
        return false;
    }

    private Map<String, Object> message(String model, List<Map<String, Object>> blocks, String stop) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", "msg_mock_" + ids.incrementAndGet());
        m.put("type", "message");
        m.put("role", "assistant");
        m.put("model", model);
        m.put("content", blocks);
        m.put("stop_reason", stop);
        m.put("stop_sequence", null);
        m.put("usage", Map.of("input_tokens", 10, "output_tokens", 5));
        return m;
    }

    private void stream(HttpExchange ex, String model, List<Map<String, Object>> blocks, String stop) throws IOException {
        ex.getResponseHeaders().set("Content-Type", "text/event-stream");
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.sendResponseHeaders(200, 0);
        OutputStream out = ex.getResponseBody();
        Map<String, Object> start = message(model, List.of(), null);
        event(out, "message_start", Map.of("type", "message_start", "message", start));
        for (int i = 0; i < blocks.size(); i++) {
            Map<String, Object> b = blocks.get(i);
            if ("text".equals(b.get("type"))) {
                event(out, "content_block_start", Map.of("type", "content_block_start", "index", i,
                    "content_block", Map.of("type", "text", "text", "")));
                event(out, "content_block_delta", Map.of("type", "content_block_delta", "index", i,
                    "delta", Map.of("type", "text_delta", "text", b.get("text"))));
            } else {
                event(out, "content_block_start", Map.of("type", "content_block_start", "index", i,
                    "content_block", Map.of("type", "tool_use", "id", b.get("id"), "name", b.get("name"), "input", Map.of())));
                event(out, "content_block_delta", Map.of("type", "content_block_delta", "index", i,
                    "delta", Map.of("type", "input_json_delta", "partial_json", JSON.writeValueAsString(b.get("input")))));
            }
            event(out, "content_block_stop", Map.of("type", "content_block_stop", "index", i));
        }
        Map<String, Object> delta = new LinkedHashMap<>();
        delta.put("stop_reason", stop);
        delta.put("stop_sequence", null);
        event(out, "message_delta", Map.of("type", "message_delta", "delta", delta, "usage", Map.of("output_tokens", 5)));
        event(out, "message_stop", Map.of("type", "message_stop"));
        out.close();
    }

    private static void event(OutputStream out, String name, Object data) throws IOException {
        out.write(("event: " + name + "\ndata: " + JSON.writeValueAsString(data) + "\n\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private Map<String, Object> toolUse(String name, Map<String, Object> input) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("type", "tool_use");
        b.put("id", "toolu_mock_" + ids.incrementAndGet());
        b.put("name", name);
        b.put("input", input);
        return b;
    }

    private static Map<String, Object> text(String t) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("type", "text");
        b.put("text", t);
        return b;
    }

    private static String find(Pattern p, String s, int group) {
        Matcher m = p.matcher(s);
        return m.find() ? m.group(group) : "missing";
    }

    private static void json(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(b);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
