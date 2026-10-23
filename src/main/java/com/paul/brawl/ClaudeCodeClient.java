package com.paul.brawl;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The {@code agentKind = claude-code} {@link AgentBackend}: each turn is one headless Claude Code process,
 * {@code claude -p}, run in the agent directory ({@code god-agent/claude-code/} by default) with that directory's
 * MCP config ({@code .mcp.json}: the mod's two servers, bearer token from {@code PAULSBRAWLS_MCP_TOKEN}), settings
 * ({@code settings.json}: permissions) and agents ({@code .claude/agents/god.md}, {@code builder.md},
 * {@code sub-builder.md}). The command line, checked against Claude Code 2.1.309:
 *
 * <pre>
 * claude -p --input-format stream-json --output-format stream-json --verbose
 *        --agent &lt;god|builder&gt; --mcp-config .mcp.json --strict-mcp-config
 *        --settings settings.json --setting-sources project --permission-mode dontAsk
 *        (--session-id &lt;uuid&gt; | --resume &lt;uuid&gt;) [--model &lt;model&gt;]
 * </pre>
 *
 * <ul>
 *   <li><b>Input</b>: one stream-json user message on stdin, written as UTF-8 (never on the command line, whose
 *       encoding follows the server's locale): the text, plus the {@code /prove} or {@code /build} screenshot as a
 *       base64 {@code image} block.</li>
 *   <li><b>Sessions</b>: {@link #createSession} only mints a UUID; the first turn creates the conversation with
 *       {@code --session-id}, later ones continue it with {@code --resume} (Claude Code stores it under its own
 *       config directory). A new id is a fresh conversation ({@code /pray reset}).</li>
 *   <li><b>Result</b>: the {@code text} of the LAST {@code result} message. A builder whose sub-agents run in the
 *       background answers once when it launches them and again when Claude Code wakes it with their completion;
 *       the process exits after the last answer.</li>
 *   <li><b>Failures</b>: the binary cannot start, an MCP server is not connected at start ({@code system/init}), or
 *       the process dies without a result → {@code DOWN}; no exit within {@code timeout} → the process tree is
 *       killed, {@code TIMEOUT}; an error result (API error, max turns), an aborted turn, or an {@code api_retry}
 *       for HTTP 401/403 (Claude Code would retry a refused key ten times; the turn is stopped at the first)
 *       → {@code ERROR}. Transient API errors (429, 5xx) are left to Claude Code's retries, within {@code timeout}.</li>
 *   <li><b>Abort</b> ({@code /pray stop}, the watchdog, {@code /godbody off}) kills the session's process tree.</li>
 * </ul>
 * Blocking; callers run it on a virtual thread. Minecraft-free (ClaudeCodeClientTest, ClaudeCodeE2ETest).
 */
public final class ClaudeCodeClient implements AgentBackend {

    private static final Logger LOGGER = LoggerFactory.getLogger("ClaudeCodeClient");
    /** The base URL of the mod's MCP servers, read by {@code .mcp.json} ({@code ${PAULSBRAWLS_MCP_URL:-…}}). */
    public static final String MCP_URL_ENV = "PAULSBRAWLS_MCP_URL";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** How much of the process's stderr is kept for the log. */
    private static final int STDERR_KEEP = 4000;

    private final String bin;
    private final Path dir;
    private final String model;
    private final Map<String, String> env;
    /** Tests only: start from an empty environment instead of the server's. */
    private final boolean cleanEnvironment;
    /** Sessions that exist on Claude Code's side (their next turn uses --resume). */
    private final Set<String> started = ConcurrentHashMap.newKeySet();
    private final Map<String, Process> running = new ConcurrentHashMap<>();
    private final Set<String> aborted = ConcurrentHashMap.newKeySet();

    /**
     * @param bin   the {@code claude} executable (a name on PATH or a path)
     * @param dir   the agent directory ({@code .mcp.json}, {@code settings.json}, {@code .claude/agents/})
     * @param model blank = Claude Code's default model
     * @param env   added to the inherited environment (the mod passes the MCP token and URL)
     */
    public ClaudeCodeClient(String bin, Path dir, String model, Map<String, String> env) {
        this(bin, dir, model, env, false);
    }

    /** {@code cleanEnvironment}: the process gets ONLY {@code env} (tests isolate HOME, PATH and the API endpoint). */
    ClaudeCodeClient(String bin, Path dir, String model, Map<String, String> env, boolean cleanEnvironment) {
        this.cleanEnvironment = cleanEnvironment;
        this.bin = bin;
        this.dir = dir.toAbsolutePath().normalize();
        this.model = model == null ? "" : model.trim();
        this.env = Map.copyOf(env);
    }

    @Override
    public String createSession(String title) {
        return UUID.randomUUID().toString();
    }

    /** The command line of one turn (package-private for tests). */
    List<String> command(String sessionId, String agent) {
        List<String> cmd = new ArrayList<>(List.of(bin, "-p",
            "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--agent", agent,
            "--mcp-config", dir.resolve(".mcp.json").toString(), "--strict-mcp-config",
            "--settings", dir.resolve("settings.json").toString(), "--setting-sources", "project",
            "--permission-mode", "dontAsk"));
        cmd.addAll(started.contains(sessionId) ? List.of("--resume", sessionId) : List.of("--session-id", sessionId));
        if (!model.isEmpty()) cmd.addAll(List.of("--model", model));
        return cmd;
    }

    /** The one stream-json input line: the text and the optional image (package-private for tests). */
    static String inputLine(String text, byte[] image) {
        List<Map<String, Object>> content = new ArrayList<>();
        content.add(Map.of("type", "text", "text", text));
        if (image != null && image.length > 0) {
            content.add(Map.of("type", "image", "source", Map.of("type", "base64", "media_type", ImageMime.sniff(image),
                "data", Base64.getEncoder().encodeToString(image))));
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", "user");
        msg.put("message", Map.of("role", "user", "content", content));
        try {
            return JSON.writeValueAsString(msg);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public Reply send(String sessionId, String agent, String text, byte[] image, Duration timeout) {
        if (!Files.isDirectory(dir)) return Reply.fail(Failure.DOWN, "agent directory missing: " + dir);
        ProcessBuilder pb = new ProcessBuilder(command(sessionId, agent)).directory(dir.toFile());
        if (cleanEnvironment) pb.environment().clear();
        pb.environment().remove("CLAUDECODE"); // a server started from a Claude Code session must not look nested
        pb.environment().putAll(env);
        Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            return Reply.fail(Failure.DOWN, "cannot start '" + bin + "': " + e.getMessage());
        }
        running.put(sessionId, p);
        aborted.remove(sessionId);
        StringBuilder stderr = new StringBuilder();
        Thread errReader = Thread.ofVirtual().start(() -> drain(p, stderr));
        Turn turn = new Turn();
        Thread outReader = Thread.ofVirtual().start(() -> read(p, sessionId, turn));
        try (OutputStream in = p.getOutputStream()) {
            in.write((inputLine(text, image) + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // the process died at once; its exit is handled below
        }
        try {
            boolean exited = p.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!exited) {
                kill(p);
                return Reply.fail(Failure.TIMEOUT, "no answer within " + timeout);
            }
            outReader.join(5_000);
            errReader.join(1_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            kill(p);
            return Reply.fail(Failure.TIMEOUT, "interrupted");
        } finally {
            running.remove(sessionId, p);
        }
        if (aborted.remove(sessionId)) return Reply.fail(Failure.ERROR, "turn aborted");
        if (turn.down != null) return Reply.fail(Failure.DOWN, turn.down);
        if (turn.error != null) return Reply.fail(Failure.ERROR, turn.error);
        JsonNode r = turn.lastResult;
        if (r == null) {
            String err = abbreviate(stderr.toString());
            return Reply.fail(Failure.DOWN, "claude exited with code " + p.exitValue() + " and no result" + (err.isEmpty() ? "" : ": " + err));
        }
        return parseResult(r);
    }

    /** A {@code result} message → the reply (package-private for tests). */
    static Reply parseResult(JsonNode r) {
        boolean error = r.path("is_error").asBoolean(false) || !"success".equals(r.path("subtype").asText());
        if (error) {
            return Reply.fail(Failure.ERROR, r.path("subtype").asText() + ": " + abbreviate(r.path("result").asText(r.toString())));
        }
        return Reply.ok(r.path("result").asText("").strip());
    }

    /** What the stdout reader saw of one turn. */
    private static final class Turn {
        volatile JsonNode lastResult;
        volatile String down;
        volatile String error;
    }

    private void read(Process p, String sessionId, Turn turn) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                JsonNode m;
                try {
                    m = JSON.readTree(line);
                } catch (IOException e) {
                    continue; // not a protocol line
                }
                String type = m.path("type").asText();
                if (type.equals("system") && m.path("subtype").asText().equals("init")) {
                    started.add(sessionId); // the conversation now exists: the next turn resumes it
                    String bad = mcpProblem(m.path("mcp_servers"));
                    if (bad != null && turn.down == null) {
                        turn.down = bad;
                        LOGGER.warn("Claude Code turn {}: {}; stopping it", sessionId, bad);
                        kill(p);
                    }
                } else if (type.equals("system") && m.path("subtype").asText().equals("api_retry")) {
                    // Claude Code retries every API error, a refused key included (10 attempts with backoff): only
                    // transient ones are worth waiting for.
                    String fatal = fatalApiError(m);
                    if (fatal != null && turn.error == null) {
                        turn.error = fatal;
                        LOGGER.warn("Claude Code turn {}: {}; stopping it", sessionId, fatal);
                        kill(p);
                    }
                } else if (type.equals("result")) {
                    turn.lastResult = m;
                }
            }
        } catch (IOException e) {
            // the process was killed; its exit is handled by send
        }
    }

    /** An {@code api_retry} that no retry can fix (a refused key or account), else null (package-private for tests). */
    static String fatalApiError(JsonNode retry) {
        int status = retry.path("error_status").asInt(0);
        if (status == 401 || status == 403) {
            return "the model API refuses the credentials (HTTP " + status + ", " + retry.path("error").asText() + ")";
        }
        return null;
    }

    /** A server the agent needs that is not connected (package-private for tests); null when all are usable. */
    static String mcpProblem(JsonNode servers) {
        for (JsonNode s : servers) {
            String status = s.path("status").asText();
            if (status.equals("failed") || status.equals("needs-auth") || status.equals("disabled")) {
                return "MCP server '" + s.path("name").asText() + "' is " + status
                    + " (is the Minecraft server running with godAgent=external, and the token right?)";
            }
        }
        return null;
    }

    @Override
    public void abort(String sessionId) {
        Process p = running.get(sessionId);
        if (p == null) return;
        aborted.add(sessionId);
        kill(p);
    }

    /** Kill the process and everything it started (sub-agents run inside it, MCP clients too). */
    private static void kill(Process p) {
        p.descendants().forEach(ProcessHandle::destroyForcibly);
        p.destroyForcibly();
    }

    private static void drain(Process p, StringBuilder keep) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                synchronized (keep) {
                    if (keep.length() < STDERR_KEEP) keep.append(line).append('\n');
                }
            }
        } catch (IOException ignored) {
            // killed
        }
    }

    private static String abbreviate(String s) {
        if (s == null) return "";
        s = s.strip();
        return s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }
}
