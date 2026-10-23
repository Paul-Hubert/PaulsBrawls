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
        WorldOutcome out = god.reward(alice, "minecraft:diamond", 1000);
        assertEquals(List.of("give minecraft:diamond x" + BridgeConfig.INSTANCE.rewardMax), world.calls);
        assertTrue(out.ok(), "a clamp is not a refusal: the reward was given");
        assertTrue(out.text().contains("limité à " + BridgeConfig.INSTANCE.rewardMax + " sur 1000"), out.text());

        String book = "minecraft:enchanted_book[minecraft:enchantments={levels:{\"minecraft:sharpness\":5}}]";
        god.reward(alice, book, 1);
        assertEquals("give " + book + " x1", world.calls.get(1), "the component string reaches the world untouched");
    }

    @Test
    void rewardRefusalsNeverReachTheWorld() {
        assertRefused(god.reward(alice, "minecraft:diamond", 0), "Reward cancelled, amount must be at least 1");
        assertRefused(god.reward(alice, " ", 3), "Reward cancelled, item");
        assertTrue(world.calls.isEmpty());
        WorldOutcome unknown = god.reward(alice, "minecraft:nope", 3);
        assertTrue(unknown.refused() && unknown.text().contains("does not exist"), "the world's refusal is the result: " + unknown);
    }

    /** Every refusal is typed as one (the MCP side turns it into isError), with the text the builtin always saw. */
    private static void assertRefused(WorldOutcome o, String prefix) {
        assertTrue(o.refused(), "not flagged as a refusal: " + o);
        assertTrue(o.text().startsWith(prefix), o.text());
    }

    @Test
    void tradeAmountsAreCheckedBeforeTheWorld() {
        assertRefused(god.offerTrade(alice, "minecraft:diamond", 1, "minecraft:dirt", -5), "Trade cancelled.");
        assertRefused(god.offerTrade(alice, "minecraft:diamond", 513, "minecraft:dirt", 1), "Trade cancelled.");
        assertRefused(god.offerTrade(alice, " ", 1, "minecraft:dirt", 1), "Trade cancelled.");
        assertTrue(world.calls.isEmpty());
        WorldOutcome ok = god.offerTrade(alice, "minecraft:diamond", 2, "minecraft:dirt", 64);
        assertTrue(ok.ok() && ok.text().startsWith("God offered a trade"), ok.toString());
        assertEquals(List.of("trade 2 minecraft:diamond for 64 minecraft:dirt"), world.calls);
    }

    @Test
    void punishmentIsClamped() {
        WorldOutcome out = god.punish(alice, 50);
        assertEquals(List.of("strike x" + BridgeConfig.INSTANCE.punishmentMax), world.calls);
        assertTrue(out.ok() && out.text().contains("limité à"), out.toString());
        god.punish(alice, -4);
        assertEquals("strike x0", world.calls.get(1), "a negative count strikes nobody");
    }

    @Test
    void weatherTypeIsValidatedAndDurationClamped() {
        assertRefused(god.changeWeather(alice, "snow", 10), "Météo refusée");
        assertTrue(world.calls.isEmpty());
        assertTrue(god.changeWeather(alice, "THUNDER", 5_000_000).ok());
        god.changeWeather(alice, "rain", -3);
        assertEquals(List.of("weather thunder " + GodService.MAX_WEATHER_SECONDS, "weather rain 0"), world.calls);
    }

    @Test
    void spawnCountAndOffsetsAreClamped() {
        int max = BridgeConfig.INSTANCE.spawnOffsetMax;
        god.spawnCreature(alice, "minecraft:zombie", 99, 1000, -1000, 3);
        assertEquals(List.of("spawn minecraft:zombie x" + BridgeConfig.INSTANCE.spawnCountMax
            + " at " + max + "," + (-max) + ",3"), world.calls);
        assertRefused(god.spawnCreature(alice, "", 1, 0, 0, 0), "Spawn annulé");
        WorldOutcome dragon = god.spawnCreature(alice, "minecraft:dragon", 1, 0, 0, 0);
        assertTrue(dragon.refused() && dragon.text().contains("inconnu"), dragon.toString());
    }

    @Test
    void onlyTheSessionOwnerMovesTheBody() {
        assertTrue(GodSessionManager.claim(alice));
        assertRefused(god.appear(bob, null, null, null), "Le corps de Dieu est occupé");
        assertRefused(god.vanish(bob), "Tu ne tiens pas");
        assertTrue(world.calls.isEmpty());

        assertEquals(WorldOutcome.done("God a pris forme physique devant le joueur."), god.appear(alice, 99.0, -5.0, null));
        assertEquals("appear " + BridgeConfig.INSTANCE.appearMaxDistance + " " + BridgeConfig.INSTANCE.appearMinHeight + " true",
            world.calls.get(0), "distance and height are clamped");
        assertTrue(GodSessionManager.hasManifested());
        assertEquals(WorldOutcome.done("God a disparu."), god.vanish(alice));
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
        assertEquals(WorldOutcome.done("Message transmis au joueur."), god.say(alice, "  Approche, mortel.  "));
        assertEquals(List.of("tell Dieu : Approche, mortel."), world.calls);
        GodSessionManager.claim(alice);
        god.appear(alice, null, null, null);
        world.calls.clear();
        god.say(alice, "Tremble.");
        assertEquals(List.of("tell Dieu : Tremble.", "speak Tremble."), world.calls);
        assertRefused(god.say(alice, "   "), "Message vide");
        god.say(alice, "x".repeat(5000));
        assertEquals("tell Dieu : " + "x".repeat(GodService.MAX_SAY_CHARS), world.calls.get(2));
    }

    @Test
    void anOfflinePlayerIsARefusalNotACrash() {
        world.online.remove(alice);
        assertEquals(WorldOutcome.refused(MinecraftBuildWorld.OFFLINE), god.punish(alice, 1));
        assertEquals(WorldOutcome.refused(MinecraftBuildWorld.OFFLINE), god.playerContext(alice));
        assertEquals(WorldOutcome.refused(MinecraftBuildWorld.OFFLINE), god.say(alice, "Où es-tu ?"));
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
