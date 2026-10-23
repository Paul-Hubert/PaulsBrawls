package com.paul.brawl;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema;

/**
 * Small helpers shared by {@link GodMcpServer} and {@link BuilderMcpServer}: hand-written JSON Schemas (no
 * reflection, so the advertised schema is exactly what is checked), the agent-facing metadata of a tool
 * ({@link Meta}: title, MCP annotations, output schema), argument reading, and results.
 */
final class McpTools {

    private McpTools() {}

    /** Thrown by argument readers; becomes an {@code isError} result. */
    static final class BadArgs extends RuntimeException {
        BadArgs(String message) {
            super(message, null, false, false);
        }
    }

    /** A JSON Schema object builder: {@code type: object}, properties, required, no additional properties. */
    static final class Schema {
        private final Map<String, Object> props = new LinkedHashMap<>();
        private final List<String> required = new ArrayList<>();

        static Schema object() {
            return new Schema();
        }

        Schema str(String name, String description, boolean req) {
            return prop(name, Map.of("type", "string", "description", description), req);
        }

        Schema strEnum(String name, String description, List<String> values, boolean req) {
            return prop(name, Map.of("type", "string", "enum", values, "description", description), req);
        }

        Schema integer(String name, String description, boolean req) {
            return prop(name, Map.of("type", "integer", "description", description), req);
        }

        Schema number(String name, String description, boolean req) {
            return prop(name, Map.of("type", "number", "description", description), req);
        }

        Schema bool(String name, String description, boolean req) {
            return prop(name, Map.of("type", "boolean", "description", description), req);
        }

        Schema intArray(String name, String description, boolean req) {
            return prop(name, Map.of("type", "array", "items", Map.of("type", "integer"), "description", description), req);
        }

        Schema anyObject(String name, String description, boolean req) {
            return prop(name, Map.of("type", "object", "description", description), req);
        }

        private Schema prop(String name, Map<String, Object> schema, boolean req) {
            props.put(name, schema);
            if (req) required.add(name);
            return this;
        }

        Map<String, Object> build() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", "object");
            m.put("properties", props);
            m.put("required", required);
            m.put("additionalProperties", false);
            return m;
        }
    }

    /**
     * What an LLM client is told about a tool besides its description: a human title and the MCP annotations
     * (Claude Code, for one, runs read-only tools concurrently and shows titles). The hints describe the Minecraft
     * world the mod owns, a closed domain, so {@code openWorldHint} is false for every tool. A tool with an
     * {@code outputSchema} returns {@code structuredContent} next to the same text (clients that ignore structured
     * output lose nothing); the SDK checks it against the schema before it leaves the server.
     */
    record Meta(String title, boolean readOnly, boolean destructive, boolean idempotent, Map<String, Object> outputSchema) {

        /** Reads the world, changes nothing. */
        static Meta read(String title) {
            return new Meta(title, true, false, true, null);
        }

        /** Changes the world: {@code destructive} if it may overwrite or harm, {@code idempotent} if repeating it adds nothing. */
        static Meta write(String title, boolean destructive, boolean idempotent) {
            return new Meta(title, false, destructive, idempotent, null);
        }

        Meta output(Map<String, Object> schema) {
            return new Meta(title, readOnly, destructive, idempotent, schema);
        }

        McpSchema.ToolAnnotations annotations() {
            return new McpSchema.ToolAnnotations(title, readOnly, readOnly ? null : destructive, idempotent, false, null);
        }
    }

    /** A closed object schema for structured output: every listed property required. */
    static Map<String, Object> outputObject(Map<String, Object> properties) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "object");
        m.put("properties", properties);
        m.put("required", List.copyOf(properties.keySet()));
        m.put("additionalProperties", false);
        return m;
    }

    static Map<String, Object> intProp(String description) {
        return Map.of("type", "integer", "description", description);
    }

    static Map<String, Object> strProp(String description) {
        return Map.of("type", "string", "description", description);
    }

    static SyncToolSpecification tool(String name, Meta meta, String description, Schema schema,
            Function<Map<String, Object>, McpSchema.CallToolResult> body) {
        McpSchema.Tool.Builder tb = McpSchema.Tool.builder(name, schema.build())
            .title(meta.title())
            .description(description)
            .annotations(meta.annotations());
        if (meta.outputSchema() != null) tb.outputSchema(meta.outputSchema());
        McpSchema.Tool t = tb.build();
        return SyncToolSpecification.builder()
            .tool(t)
            .callHandler((ctx, req) -> {
                Map<String, Object> args = req.arguments() == null ? Map.of() : req.arguments();
                try {
                    return body.apply(args);
                } catch (BadArgs e) {
                    return error(e.getMessage());
                } catch (RuntimeException e) {
                    org.slf4j.LoggerFactory.getLogger("McpTools").warn("MCP tool {} threw: {}", name, e.toString(), e);
                    return error("Erreur côté serveur pendant '" + name + "'.");
                }
            })
            .build();
    }

    static McpSchema.CallToolResult ok(String text) {
        return McpSchema.CallToolResult.builder().addTextContent(text == null ? "" : text).isError(false).build();
    }

    /** A success with the same facts twice: the text the model reads, and {@code structured} for the output schema. */
    static McpSchema.CallToolResult ok(String text, Map<String, Object> structured) {
        return McpSchema.CallToolResult.builder().addTextContent(text).structuredContent(structured).isError(false).build();
    }

    /** A world-layer outcome: {@code isError} exactly when it was refused. */
    static McpSchema.CallToolResult result(WorldOutcome o) {
        return o.refused() ? error(o.text()) : ok(o.text());
    }

    static McpSchema.CallToolResult error(String text) {
        return McpSchema.CallToolResult.builder().addTextContent(text).isError(true).build();
    }

    // -- argument readers (the SDK already validated the schema; these re-check, never trust) ------------------

    static String str(Map<String, Object> a, String name) {
        Object v = a.get(name);
        if (!(v instanceof String s) || s.isBlank()) throw new BadArgs("Argument '" + name + "' manquant ou vide.");
        return s;
    }

    static String optStr(Map<String, Object> a, String name) {
        Object v = a.get(name);
        return v instanceof String s ? s : null;
    }

    static int integer(Map<String, Object> a, String name) {
        Integer v = optInt(a, name);
        if (v == null) throw new BadArgs("Argument entier '" + name + "' manquant.");
        return v;
    }

    static Integer optInt(Map<String, Object> a, String name) {
        Object v = a.get(name);
        if (v == null) return null;
        if (v instanceof Number n) {
            double d = n.doubleValue();
            if (d != Math.rint(d) || d > Integer.MAX_VALUE || d < Integer.MIN_VALUE) {
                throw new BadArgs("Argument '" + name + "' doit être un entier 32 bits.");
            }
            return (int) d;
        }
        throw new BadArgs("Argument '" + name + "' doit être un entier.");
    }

    static Double optNumber(Map<String, Object> a, String name) {
        Object v = a.get(name);
        if (v == null) return null;
        if (v instanceof Number n && Double.isFinite(n.doubleValue())) return n.doubleValue();
        throw new BadArgs("Argument '" + name + "' doit être un nombre.");
    }

    static Boolean optBool(Map<String, Object> a, String name) {
        Object v = a.get(name);
        if (v == null) return null;
        if (v instanceof Boolean b) return b;
        throw new BadArgs("Argument '" + name + "' doit être un booléen.");
    }

    /** An integer array of at most {@code max} entries (checked before copying). */
    static int[] intArray(Map<String, Object> a, String name, int max) {
        Object v = a.get(name);
        if (!(v instanceof List<?> list)) throw new BadArgs("Argument '" + name + "' doit être un tableau d'entiers.");
        if (list.size() > max) throw new BadArgs(BuildService.overCap(list.size()));
        int[] out = new int[list.size()];
        for (int i = 0; i < out.length; i++) {
            Object e = list.get(i);
            if (!(e instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())
                    || Math.abs(n.doubleValue()) > Integer.MAX_VALUE) {
                throw new BadArgs("Argument '" + name + "' doit être un tableau d'entiers.");
            }
            out[i] = n.intValue();
        }
        return out;
    }
}
