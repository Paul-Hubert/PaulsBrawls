package com.paul.brawl;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * An OpenAI-compatible chat-completions endpoint (streaming) that plays a fixed script, standing in ONLY for the
 * paid LLM in {@link AgentE2ETest}. opencode, its agents/permissions/prompts and the mod's MCP servers are real.
 * The script reads which agent is calling from the tools it is offered:
 * <ul>
 *   <li>{@code god_say} offered → the God: appear + reward + say with the ticket from the prayer, then stop. A
 *       prayer containing SILENT gets plain text only; SLOW appears, then hangs (watchdog and kill tests).</li>
 *   <li>{@code task} offered → the Builder: one {@code task} to {@code sub-builder}, then a closing sentence.</li>
 *   <li>{@code builder_place_line} without {@code task} → a sub-builder: begin, place_line, end, sentence.</li>
 *   <li>no tools → plain text (opencode's own title/summary calls).</li>
 * </ul>
 * Every request is recorded so the test can check what opencode exposed and sent.
 */
final class ScriptedLlm implements AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern GOD_TICKET = Pattern.compile("god-[A-Za-z0-9_-]+");
    private static final Pattern BLD_TICKET = Pattern.compile("bld-[A-Za-z0-9_-]+");
    private static final Pattern SUB_BUILD = Pattern.compile("sub_build=(sb-[A-Za-z0-9_-]+)");

    /** One request opencode made: the tools it offered and whether an image was attached. */
    record Seen(List<String> tools, boolean image, String lastUser) {}

    final List<Seen> seen = Collections.synchronizedList(new ArrayList<>());
    volatile long delayMillis = 0;
    private final HttpServer http;

    ScriptedLlm() throws IOException {
        http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        http.createContext("/v1/chat/completions", this::complete);
        http.createContext("/v1/models", ex -> reply(ex, 200, "{\"object\":\"list\",\"data\":[{\"id\":\"mock\",\"object\":\"model\"}]}"));
        http.setExecutor(Executors.newThreadPerTaskExecutor(Thread.ofVirtual().factory()));
        http.start();
    }

    int port() {
        return http.getAddress().getPort();
    }

    @Override
    public void close() {
        http.stop(0);
    }

    private void complete(HttpExchange ex) throws IOException {
        JsonNode body = JSON.readTree(ex.getRequestBody().readAllBytes());
        List<String> tools = new ArrayList<>();
        for (JsonNode t : body.path("tools")) tools.add(t.path("function").path("name").asText());
        // Only the messages after the last user message belong to this turn (sessions keep earlier turns).
        List<JsonNode> turn = new ArrayList<>();
        String lastUser = "";
        boolean image = false;
        for (JsonNode m : body.path("messages")) {
            if ("user".equals(m.path("role").asText())) {
                turn.clear();
                lastUser = m.path("content").toString();
                image = lastUser.contains("image_url");
            }
            turn.add(m);
        }
        seen.add(new Seen(tools, image, lastUser));
        int toolResults = (int) turn.stream().filter(m -> "tool".equals(m.path("role").asText())).count();
        String turnText = turn.toString();

        if (delayMillis > 0) sleep(delayMillis);

        ex.getResponseHeaders().set("Content-Type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        try (OutputStream out = ex.getResponseBody()) {
            if (tools.contains("god_say")) {
                String ticket = find(GOD_TICKET, lastUser);
                if (lastUser.contains("SLOW") && toolResults == 0) {
                    // Appear, then hang on the next call: a turn that is stuck while the body is out.
                    toolCalls(out, List.of(call("god_appear", Map.of("ticket", ticket))));
                } else if (lastUser.contains("SLOW")) {
                    sleep(120_000);
                } else if (lastUser.contains("SILENT") || toolResults > 0) {
                    text(out, lastUser.contains("SILENT") ? "Je t'ai entendu, mortel." : "");
                } else {
                    toolCalls(out, List.of(
                        call("god_appear", Map.of("ticket", ticket)),
                        call("god_reward", Map.of("ticket", ticket, "item", "minecraft:diamond", "amount", 2)),
                        call("god_say", Map.of("ticket", ticket, "message", "Je t'ai entendu."))));
                }
            } else if (tools.contains("task")) {
                if (toolResults == 0) {
                    String ticket = find(BLD_TICKET, lastUser);
                    toolCalls(out, List.of(call("task", Map.of("description", "tour de guet",
                        "subagent_type", "sub-builder",
                        "prompt", "Ticket : " + ticket + ". Ancre : anchor_x=4 anchor_y=0 anchor_z=4. Construis une tour de guet."))));
                } else {
                    text(out, "Une tour de guet se dresse au nord.");
                }
            } else if (tools.contains("builder_place_line")) {
                String ticket = find(BLD_TICKET, lastUser);
                switch (toolResults) {
                    case 0 -> toolCalls(out, List.of(call("builder_begin_sub_build",
                        Map.of("ticket", ticket, "label", "tour", "anchor_x", 4, "anchor_y", 0, "anchor_z", 4))));
                    case 1 -> toolCalls(out, List.of(call("builder_place_line", Map.of("ticket", ticket,
                        "sub_build", find(SUB_BUILD, turnText, 1), "x1", 0, "y1", 0, "z1", 0, "x2", 0, "y2", 4, "z2", 0,
                        "block", "minecraft:stone"))));
                    case 2 -> toolCalls(out, List.of(call("builder_end_sub_build",
                        Map.of("ticket", ticket, "sub_build", find(SUB_BUILD, turnText, 1)))));
                    default -> text(out, "Tour finie.");
                }
            } else {
                text(out, "Titre");
            }
            out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
        }
    }

    private static Map<String, Object> call(String name, Map<String, Object> args) {
        return Map.of("name", name, "args", args);
    }

    private static void toolCalls(OutputStream out, List<Map<String, Object>> calls) throws IOException {
        List<Object> tc = new ArrayList<>();
        for (int i = 0; i < calls.size(); i++) {
            tc.add(Map.of("index", i, "id", "call_" + System.nanoTime() + "_" + i, "type", "function",
                "function", Map.of("name", calls.get(i).get("name"), "arguments", JSON.writeValueAsString(calls.get(i).get("args")))));
        }
        chunk(out, Map.of("role", "assistant", "tool_calls", tc), null);
        chunk(out, Map.of(), "tool_calls");
    }

    private static void text(OutputStream out, String text) throws IOException {
        chunk(out, Map.of("role", "assistant", "content", text), null);
        chunk(out, Map.of(), "stop");
    }

    private static void chunk(OutputStream out, Map<String, Object> delta, String finish) throws IOException {
        Map<String, Object> choice = new java.util.HashMap<>();
        choice.put("index", 0);
        choice.put("delta", delta);
        choice.put("finish_reason", finish);
        Map<String, Object> c = new java.util.HashMap<>();
        c.put("id", "chatcmpl-mock");
        c.put("object", "chat.completion.chunk");
        c.put("created", System.currentTimeMillis() / 1000);
        c.put("model", "mock");
        c.put("choices", List.of(choice));
        if (finish != null) c.put("usage", Map.of("prompt_tokens", 1, "completion_tokens", 1, "total_tokens", 2));
        out.write(("data: " + JSON.writeValueAsString(c) + "\n\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static String find(Pattern p, String s) {
        return find(p, s, 0);
    }

    private static String find(Pattern p, String s, int group) {
        Matcher m = p.matcher(s);
        return m.find() ? m.group(group) : "missing";
    }

    private static void reply(HttpExchange ex, int status, String body) throws IOException {
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
