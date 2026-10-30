package com.paul.brawl.squad;

import java.util.Locale;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The {@code /bots status} line, from the runtime's {@code POST /api/metrics} answer (docs/32 C). Minecraft-free
 * (SquadStatusFormatTest).
 * <ul>
 *   <li>The three numbers a player can act on: ELU (how busy the runtime's one thread is), the loop's p99 delay, and
 *       the slowest bot's physics ticks per second (20 = smooth).</li>
 *   <li>A failed answer (runtime unreachable, refused token, an older runtime without the route) shows its own
 *       {@code text}, like every other {@code /bots} command.</li>
 *   <li>The mod formats from the numbers rather than relaying the runtime's {@code text}, so the line stays short
 *       and its format is pinned by a test here; the runtime's longer line (CPU, RAM) is for other clients.</li>
 * </ul>
 */
public final class SquadStatusFormat {

    /** Above either, bots move in slow motion (docs/31 §2); the same limits as the runtime's warning. */
    static final double OVERLOADED_P99_MS = 250;
    static final double OVERLOADED_ELU = 0.9;

    private SquadStatusFormat() {}

    public static String format(JsonObject r) {
        if (r == null) return SquadClient.UNREACHABLE;
        boolean ok = r.has("ok") && r.get("ok").isJsonPrimitive() && r.get("ok").getAsBoolean();
        Double elu = number(r, "elu");
        JsonObject loop = object(r, "loop");
        Double p99 = loop == null ? null : number(loop, "p99");
        if (!ok || elu == null || p99 == null) {
            String text = string(r, "text");
            return text == null || text.isBlank() ? "[Bots] Réponse illisible du runtime." : text;
        }

        String slowestName = null;
        double slowestTps = Double.MAX_VALUE;
        int online = 0;
        if (r.has("bots") && r.get("bots").isJsonArray()) {
            for (JsonElement e : r.getAsJsonArray("bots")) {
                if (!e.isJsonObject()) continue;
                JsonObject b = e.getAsJsonObject();
                if ("online".equals(string(b, "status"))) online++;
                Double tps = number(b, "ticksPerSec");
                if (tps != null && tps < slowestTps) {
                    slowestTps = tps;
                    slowestName = string(b, "name");
                }
            }
        }

        StringBuilder sb = new StringBuilder("[Bots] Runtime");
        JsonObject window = object(r, "window");
        Double seconds = window == null ? null : number(window, "seconds");
        if (seconds != null) {
            boolean complete = !window.has("complete") || !window.get("complete").isJsonPrimitive() || window.get("complete").getAsBoolean();
            sb.append(" (").append(Math.round(seconds)).append(" s").append(complete ? "" : ", mesure en cours").append(')');
        }
        sb.append(" : ELU ").append(String.format(Locale.FRANCE, "%.2f", elu))
            .append(" · boucle p99 ").append(Math.round(p99)).append(" ms · ");
        if (slowestName != null) {
            sb.append("bot le plus lent : ").append(slowestName).append(" à ")
                .append(String.format(Locale.FRANCE, "%.1f", slowestTps)).append(" ticks/s");
        } else if (online > 0) {
            sb.append(online).append(online > 1 ? " bots en ligne, pas encore mesurés" : " bot en ligne, pas encore mesuré");
        } else {
            sb.append("aucun bot en ligne");
        }
        boolean overloaded = elu > OVERLOADED_ELU || p99 > OVERLOADED_P99_MS;
        sb.append(overloaded ? " — surchargé : les bots ralentissent." : ".");
        return sb.toString();
    }

    private static Double number(JsonObject o, String key) {
        if (!o.has(key)) return null;
        JsonElement e = o.get(key);
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) return null;
        return e.getAsDouble();
    }

    private static String string(JsonObject o, String key) {
        if (!o.has(key)) return null;
        JsonElement e = o.get(key);
        return e.isJsonPrimitive() ? e.getAsString() : null;
    }

    private static JsonObject object(JsonObject o, String key) {
        return o.has(key) && o.get(key).isJsonObject() ? o.getAsJsonObject(key) : null;
    }
}
