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
 * reflection, so the advertised schema is exactly what is checked), argument reading, and text results.
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

    static SyncToolSpecification tool(String name, String description, Schema schema,
            Function<Map<String, Object>, McpSchema.CallToolResult> body) {
        McpSchema.Tool t = McpSchema.Tool.builder(name, schema.build())
            .description(description)
            .build();
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
