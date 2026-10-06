package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** BuildShapes + BuildService (docs/27 phase 2): the cap and the block check sit in front of the world. */
class BuildServiceTest {

    private final UUID admin = UUID.randomUUID();
    private RecordingBuildWorld world;
    private BuildService build;
    private final int[] origin = { 100, 64, -20 };

    @BeforeEach
    void setUp() {
        world = new RecordingBuildWorld();
        world.online.add(admin);
        build = new BuildService(world);
    }

    @Test
    void lineWalksLikeTheOldPlaceLineAt() {
        List<int[]> l = BuildShapes.line(0, 0, 0, 4, 2, 0);
        assertEquals(5, l.size());
        assertArrayEquals(new int[] { 0, 0, 0 }, l.get(0));
        assertArrayEquals(new int[] { 2, 1, 0 }, l.get(2));
        assertArrayEquals(new int[] { 4, 2, 0 }, l.get(4));
        assertEquals(BuildGuard.lineBlocks(0, 0, 0, 4, 2, 0), l.size());
        assertEquals(BuildGuard.lineBlocks(3, 3, 3, 3, 3, 3), BuildShapes.line(3, 3, 3, 3, 3, 3).size());
    }

    @Test
    void pointsStopAtTheShortestArray() {
        assertEquals(2, BuildShapes.points(new int[] { 1, 2, 3 }, new int[] { 0, 0 }, new int[] { 5, 6, 7 }).size());
    }

    @Test
    void placementsAreRelativeToTheOrigin() {
        String out = build.place(admin, origin, List.of(new int[] { 1, 0, 2 }), "minecraft:stone");
        assertEquals("1 bloc(s) minecraft:stone placé(s).", out);
        assertEquals(List.of("101,64,-18 minecraft:stone"), world.placed);
    }

    @Test
    void refusalsNeverReachTheWorld() {
        assertTrue(build.place(admin, null, List.of(new int[] { 0, 0, 0 }), "minecraft:stone").startsWith("Aucun point de référence"));
        assertTrue(build.place(admin, origin, List.of(new int[] { 0, 0, 0 }), "minecraft:unobtainium").startsWith("Bloc inconnu"));
        assertTrue(build.placeLine(admin, origin, 0, 0, 0, 1_000_000, 0, 0, "minecraft:stone").startsWith("Appel refusé : 1000001 blocs"),
            "a huge line is refused before any position is allocated");
        int[] xs = new int[BuildGuard.MAX_BLOCKS_PER_CALL + 1];
        assertTrue(build.place(admin, origin, BuildShapes.points(xs, xs, xs), "minecraft:stone").startsWith("Appel refusé"));
        assertTrue(world.placed.isEmpty());
    }

    @Test
    void exactlyTheCapIsAllowed() {
        int n = BuildGuard.MAX_BLOCKS_PER_CALL;
        build.placeLine(admin, origin, 0, 0, 0, n - 1, 0, 0, "minecraft:oak_planks");
        assertEquals(n, world.placed.size());
    }

    @Test
    void anOfflinePlayerIsReported() {
        world.online.clear();
        assertEquals(MinecraftBuildWorld.OFFLINE, build.place(admin, origin, List.of(new int[] { 0, 0, 0 }), "minecraft:stone"));
    }
}
