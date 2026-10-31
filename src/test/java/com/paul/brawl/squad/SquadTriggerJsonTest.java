package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** The trigger's JSON, field for field what the runtime's snapshot() sanitizer reads (squad/src/http/server.ts). */
class SquadTriggerJsonTest {

    @Test
    void useTriggerHasKindAndItemOnly() {
        assertEquals(JsonParser.parseString("{\"kind\":\"use\",\"item\":\"shield\"}"),
            SquadTriggerJson.trigger(SquadTriggerJson.Kind.USE, "shield", null));
        assertEquals("arrow-release", SquadTriggerJson.trigger(SquadTriggerJson.Kind.ARROW_RELEASE, "bow", null).get("kind").getAsString());
    }

    @Test
    void blockHitCarriesTheExactPoint() {
        JsonObject t = SquadTriggerJson.trigger(SquadTriggerJson.Kind.ARROW_HIT, "crossbow",
            new SquadTriggerJson.Hit(10.25, 64.0, -3.5, null));
        assertEquals(JsonParser.parseString("{\"kind\":\"arrow-hit\",\"item\":\"crossbow\",\"hit\":{\"position\":{\"x\":10.25,\"y\":64.0,\"z\":-3.5}}}"), t);
    }

    @Test
    void entityHitCarriesTheEntityWithItsNetworkId() {
        SquadTriggerJson.EntityRef zombie = new SquadTriggerJson.EntityRef(4711, "zombie", false, null, 1, 2, 3);
        JsonObject t = SquadTriggerJson.trigger(SquadTriggerJson.Kind.ARROW_HIT, "bow", new SquadTriggerJson.Hit(1, 2, 3, zombie));
        JsonObject e = t.getAsJsonObject("hit").getAsJsonObject("entity");
        assertEquals(4711, e.get("id").getAsInt());
        assertEquals("zombie", e.get("name").getAsString());
        assertEquals("mob", e.get("type").getAsString());
        assertFalse(e.has("username"));
        assertEquals(JsonParser.parseString("{\"x\":1.0,\"y\":2.0,\"z\":3.0}"), e.get("position"));
        assertEquals(e.get("position"), t.getAsJsonObject("hit").get("position"));
    }

    @Test
    void aPlayerEntityHasItsUsername() {
        JsonObject e = new SquadTriggerJson.EntityRef(12, "player", true, "PUALHubert", 0, 70, 0).toJson();
        assertEquals("player", e.get("type").getAsString());
        assertEquals("PUALHubert", e.get("username").getAsString());
        assertEquals(12, e.get("id").getAsInt());
        // A mob never carries a username, even if one is given.
        assertFalse(new SquadTriggerJson.EntityRef(13, "zombie", false, "x", 0, 0, 0).toJson().has("username"));
    }

    @Test
    void bodyParsesTheBindingsLineLikeBotsOrder() {
        SquadBinding b = new SquadBinding("mur-de-boucliers", "spacing=2 @Guard1 --reclaim", true, "Ordre : mur-de-boucliers spacing=2 @Guard1 --reclaim");
        JsonObject snap = new JsonObject();
        snap.add("trigger", SquadTriggerJson.trigger(SquadTriggerJson.Kind.USE, "shield", null));
        JsonObject body = SquadTriggerJson.body("uuid-1", "PUALHubert", false, b, false, snap);
        assertEquals(JsonParser.parseString("{\"uuid\":\"uuid-1\",\"name\":\"PUALHubert\"}"), body.get("by"));
        assertFalse(body.get("admin").getAsBoolean());
        assertEquals("mur-de-boucliers", body.get("command").getAsString());
        assertEquals(JsonParser.parseString("[\"spacing=2\"]"), body.get("tokens"));
        assertEquals(JsonParser.parseString("[\"Guard1\"]"), body.get("filters"));
        assertEquals("reclaim", body.get("take").getAsString());
        assertFalse(body.has("stop"));
        assertEquals("use", body.getAsJsonObject("snap").getAsJsonObject("trigger").get("kind").getAsString());
    }

    @Test
    void stopGestureAndAnEmptyLine() {
        JsonObject body = SquadTriggerJson.body("u", "n", true, new SquadBinding("tir", "", false, "Ordre : tir"), true, new JsonObject());
        assertTrue(body.get("stop").getAsBoolean());
        assertTrue(body.get("admin").getAsBoolean());
        assertEquals(0, body.getAsJsonArray("tokens").size());
        assertEquals(0, body.getAsJsonArray("filters").size());
        assertFalse(body.has("take"));
    }
}
