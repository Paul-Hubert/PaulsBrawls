package com.paul.brawl.squad;

import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * The JSON a bound item's click sends (docs/29 §5.4 item 5, §10 {@code /api/orders/trigger}), built from plain values
 * so its shape is tested without Minecraft (SquadTriggerJsonTest). The runtime's {@code snapshot()} sanitizer
 * ({@code squad/src/http/server.ts}) reads exactly these fields and drops the rest.
 * <ul>
 *   <li>{@code trigger: {kind, item, hit?: {position, entity?}}}, added to the commander's snapshot.</li>
 *   <li>An entity, in {@code hit} and in the snapshot's {@code lookEntity}: {@code {id, name, type, username?,
 *       position}}. {@code id} is the network entity id, mineflayer's key ({@code bot.entities[id]}).</li>
 * </ul>
 */
public final class SquadTriggerJson {

    /** The trigger kinds the runtime accepts (any other kind and the trigger is dropped). */
    public enum Kind {
        USE("use"), ARROW_RELEASE("arrow-release"), ARROW_HIT("arrow-hit");

        public final String wire;

        Kind(String wire) {
            this.wire = wire;
        }
    }

    /** An entity as a script sees it; {@code username} only for a player. */
    public record EntityRef(int id, String name, boolean player, String username, double x, double y, double z) {
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.addProperty("name", name);
            o.addProperty("type", player ? "player" : "mob");
            if (player && username != null) o.addProperty("username", username);
            o.add("position", vec(x, y, z));
            return o;
        }
    }

    /** Where an arrow hit: the exact point on a block, or the hit entity's position (and the entity). */
    public record Hit(double x, double y, double z, EntityRef entity) {
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.add("position", vec(x, y, z));
            if (entity != null) o.add("entity", entity.toJson());
            return o;
        }
    }

    private SquadTriggerJson() {}

    public static JsonObject vec(double x, double y, double z) {
        JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }

    /** {@code {kind, item, hit?}}; {@code item} is the item's id path ({@code shield}, {@code bow}). */
    public static JsonObject trigger(Kind kind, String item, Hit hit) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", kind.wire);
        o.addProperty("item", item);
        if (hit != null) o.add("hit", hit.toJson());
        return o;
    }

    /**
     * The body of {@code POST /api/orders/trigger}: who, the binding's order and line (parsed like
     * {@code /bots order}), {@code stop} only for the stop gesture, and the snapshot (with its trigger).
     */
    public static JsonObject body(String uuid, String name, boolean admin, SquadBinding binding, boolean stop, JsonObject snap) {
        JsonObject b = new JsonObject();
        JsonObject by = new JsonObject();
        by.addProperty("uuid", uuid);
        by.addProperty("name", name);
        b.add("by", by);
        b.addProperty("admin", admin);
        b.addProperty("command", binding.order());
        SquadArgs.OrderArgs a = SquadArgs.order(binding.line());
        b.add("tokens", array(a.tokens()));
        b.add("filters", array(a.filters()));
        if (a.take() != null) b.addProperty("take", a.take());
        if (stop) b.addProperty("stop", true);
        b.add("snap", snap);
        return b;
    }

    private static JsonArray array(List<String> items) {
        JsonArray a = new JsonArray();
        for (String s : items) a.add(s);
        return a;
    }
}
