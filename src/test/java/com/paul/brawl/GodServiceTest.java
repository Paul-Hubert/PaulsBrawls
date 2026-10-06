package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The rules extracted in docs/27 phase 2, against a recording world: what reaches the world, and what is refused. */
class GodServiceTest {

    private final UUID alice = UUID.randomUUID();
    private final UUID bob = UUID.randomUUID();
    private RecordingGodWorld world;
    private GodService god;

    @BeforeEach
    void setUp() {
        world = new RecordingGodWorld();
        world.online.addAll(List.of(alice, bob));
        god = new GodService(world, BridgeConfig.INSTANCE);
        GodSessionManager.forceEndSession();
    }

    @AfterEach
    void tearDown() {
        GodSessionManager.forceEndSession();
    }

    @Test
    void rewardIsClampedAndKeepsComponents() {
        String out = god.reward(alice, "minecraft:diamond", 1000);
        assertEquals(List.of("give minecraft:diamond x" + BridgeConfig.INSTANCE.rewardMax), world.calls);
        assertTrue(out.contains("limité à " + BridgeConfig.INSTANCE.rewardMax + " sur 1000"), out);

        String book = "minecraft:enchanted_book[minecraft:enchantments={levels:{\"minecraft:sharpness\":5}}]";
        god.reward(alice, book, 1);
        assertEquals("give " + book + " x1", world.calls.get(1), "the component string reaches the world untouched");
    }

    @Test
    void rewardRefusalsNeverReachTheWorld() {
        assertTrue(god.reward(alice, "minecraft:diamond", 0).startsWith("Reward cancelled, amount must be at least 1"));
        assertTrue(god.reward(alice, " ", 3).startsWith("Reward cancelled, item"));
        assertTrue(world.calls.isEmpty());
        assertTrue(god.reward(alice, "minecraft:nope", 3).contains("does not exist"), "the world's refusal is the result");
    }

    @Test
    void tradeAmountsAreCheckedBeforeTheWorld() {
        assertTrue(god.offerTrade(alice, "minecraft:diamond", 1, "minecraft:dirt", -5).startsWith("Trade cancelled."));
        assertTrue(god.offerTrade(alice, "minecraft:diamond", 513, "minecraft:dirt", 1).startsWith("Trade cancelled."));
        assertTrue(world.calls.isEmpty());
        assertTrue(god.offerTrade(alice, "minecraft:diamond", 2, "minecraft:dirt", 64).startsWith("God offered a trade"));
        assertEquals(List.of("trade 2 minecraft:diamond for 64 minecraft:dirt"), world.calls);
    }

    @Test
    void punishmentIsClamped() {
        String out = god.punish(alice, 50);
        assertEquals(List.of("strike x" + BridgeConfig.INSTANCE.punishmentMax), world.calls);
        assertTrue(out.contains("limité à"), out);
        god.punish(alice, -4);
        assertEquals("strike x0", world.calls.get(1), "a negative count strikes nobody");
    }

    @Test
    void weatherTypeIsValidatedAndDurationClamped() {
        assertTrue(god.changeWeather(alice, "snow", 10).startsWith("Météo refusée"));
        assertTrue(world.calls.isEmpty());
        god.changeWeather(alice, "THUNDER", 5_000_000);
        god.changeWeather(alice, "rain", -3);
        assertEquals(List.of("weather thunder " + GodService.MAX_WEATHER_SECONDS, "weather rain 0"), world.calls);
    }

    @Test
    void spawnCountAndOffsetsAreClamped() {
        int max = BridgeConfig.INSTANCE.spawnOffsetMax;
        god.spawnCreature(alice, "minecraft:zombie", 99, 1000, -1000, 3);
        assertEquals(List.of("spawn minecraft:zombie x" + BridgeConfig.INSTANCE.spawnCountMax
            + " at " + max + "," + (-max) + ",3"), world.calls);
        assertTrue(god.spawnCreature(alice, "", 1, 0, 0, 0).startsWith("Spawn annulé"));
        assertTrue(god.spawnCreature(alice, "minecraft:dragon", 1, 0, 0, 0).contains("inconnu"));
    }

    @Test
    void onlyTheSessionOwnerMovesTheBody() {
        assertTrue(GodSessionManager.claim(alice));
        assertTrue(god.appear(bob, null, null, null).contains("occupé"), "a bodiless player cannot summon the body");
        assertTrue(god.vanish(bob).contains("ne tiens pas"));
        assertTrue(world.calls.isEmpty());

        assertEquals("God a pris forme physique devant le joueur.", god.appear(alice, 99.0, -5.0, null));
        assertEquals("appear " + BridgeConfig.INSTANCE.appearMaxDistance + " " + BridgeConfig.INSTANCE.appearMinHeight + " true",
            world.calls.get(0), "distance and height are clamped");
        assertTrue(GodSessionManager.hasManifested());
        assertEquals("God a disparu.", god.vanish(alice));
        assertFalse(GodSessionManager.hasManifested());
    }

    @Test
    void gesturesOnlyMoveAManifestedOwnersBody() {
        god.reward(alice, "minecraft:diamond", 1);
        assertFalse(world.calls.stream().anyMatch(c -> c.startsWith("gesture")), "no session, no gesture");
        GodSessionManager.claim(alice);
        god.appear(alice, null, null, null);
        world.calls.clear();
        god.reward(bob, "minecraft:diamond", 1);
        assertFalse(world.calls.stream().anyMatch(c -> c.startsWith("gesture")), "bug #8: a bodiless reward does not nod the owner's body");
        god.punish(alice, 1);
        assertTrue(world.calls.containsAll(List.of("gesture look", "gesture swing")));
    }

    @Test
    void sayTellsThePlayerAndSpeaksOnlyWhenManifested() {
        assertEquals("Message transmis au joueur.", god.say(alice, "  Approche, mortel.  "));
        assertEquals(List.of("tell Dieu : Approche, mortel."), world.calls);
        GodSessionManager.claim(alice);
        god.appear(alice, null, null, null);
        world.calls.clear();
        god.say(alice, "Tremble.");
        assertEquals(List.of("tell Dieu : Tremble.", "speak Tremble."), world.calls);
        assertTrue(god.say(alice, "   ").startsWith("Message vide"));
        god.say(alice, "x".repeat(5000));
        assertEquals("tell Dieu : " + "x".repeat(GodService.MAX_SAY_CHARS), world.calls.get(2));
    }

    @Test
    void anOfflinePlayerIsARefusalNotACrash() {
        world.online.remove(alice);
        assertEquals(MinecraftBuildWorld.OFFLINE, god.punish(alice, 1));
        assertEquals(MinecraftBuildWorld.OFFLINE, god.playerContext(alice));
    }

    @Test
    void waitIsClamped() {
        assertEquals(BridgeConfig.INSTANCE.waitMaxSeconds, god.waitSeconds(10_000));
        assertEquals(BridgeConfig.INSTANCE.waitMinSeconds, god.waitSeconds(-1));
    }

    @Test
    void sessionGenerationsAndEndListeners() {
        long g0 = GodSessionManager.generation();
        GodSessionManager.claim(alice);
        long g1 = GodSessionManager.generation();
        assertTrue(g1 > g0);
        GodSessionManager.claim(alice);
        assertEquals(g1, GodSessionManager.generation(), "re-praying mid-session keeps the generation");
        UUID[] ended = new UUID[1];
        GodSessionManager.addEndListener(u -> ended[0] = u);
        GodSessionManager.endSession(bob);
        assertTrue(GodSessionManager.isOwner(alice), "another player cannot end the session");
        GodSessionManager.endSession(alice);
        assertEquals(alice, ended[0]);
        assertTrue(GodSessionManager.generation() > g1);
    }
}
