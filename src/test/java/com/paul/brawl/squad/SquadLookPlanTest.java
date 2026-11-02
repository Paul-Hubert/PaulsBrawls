package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

import org.junit.jupiter.api.Test;

class SquadLookPlanTest {

    private record Visit(int cx, int sy, int cz, double tIn, double tOut) {
        String cell() {
            return cx + "," + sy + "," + cz;
        }
    }

    private static List<Visit> plan(double[] o, double[] d, double t0, double tMax) {
        List<Visit> out = new ArrayList<>();
        SquadLookPlan.sections(o[0], o[1], o[2], d[0], d[1], d[2], t0, tMax, (cx, sy, cz, a, b) -> out.add(new Visit(cx, sy, cz, a, b)));
        return out;
    }

    private static String cellAt(double[] o, double[] d, double t) {
        return Math.floorDiv((int) Math.floor(o[0] + d[0] * t), 16) + "," + Math.floorDiv((int) Math.floor(o[1] + d[1] * t), 16) + ","
            + Math.floorDiv((int) Math.floor(o[2] + d[2] * t), 16);
    }

    private static double[] unit(double x, double y, double z) {
        double n = Math.sqrt(x * x + y * y + z * z);
        return new double[] { x / n, y / n, z / n };
    }

    @Test
    void aRayCrossesTheSectionsItPassesThroughInOrderContiguously() {
        Random rnd = new Random(37);
        for (int i = 0; i < 300; i++) {
            double[] o = { rnd.nextDouble() * 4000 - 2000, rnd.nextDouble() * 380 - 64, rnd.nextDouble() * 4000 - 2000 };
            double[] d = unit(rnd.nextGaussian(), rnd.nextGaussian() * 0.3, rnd.nextGaussian());
            double t0 = rnd.nextDouble() * 50;
            double tMax = t0 + rnd.nextDouble() * 700;
            List<Visit> v = plan(o, d, t0, tMax);
            assertEquals(t0, v.get(0).tIn(), 0);
            assertEquals(tMax, v.get(v.size() - 1).tOut(), 1e-9);
            for (int k = 1; k < v.size(); k++) assertEquals(v.get(k - 1).tOut(), v.get(k).tIn(), 0, "contiguous at " + k);
            for (Visit x : v) assertTrue(x.tOut() >= x.tIn());
            // Every point of the ray, sampled every 0.05 blocks, is in the section visited for its t.
            Set<String> visited = new LinkedHashSet<>();
            for (Visit x : v) visited.add(x.cell());
            int k = 0;
            for (double t = t0; t < tMax; t += 0.05) {
                while (k < v.size() - 1 && v.get(k).tOut() <= t) k++;
                Visit x = v.get(k);
                String at = cellAt(o, d, t);
                if (t > x.tIn() + 1e-6 && t < x.tOut() - 1e-6) assertEquals(x.cell(), at, "ray " + i + " at t=" + t);
                assertTrue(visited.contains(at), "ray " + i + ": the section of t=" + t + " is visited");
            }
        }
    }

    @Test
    void aRayAlongAnAxisAndOneThroughACornerVisitBothSides() {
        // Straight along +x on a section's floor (y 64): one row of sections, each 16 long.
        List<Visit> v = plan(new double[] { 0.5, 64, 8 }, new double[] { 1, 0, 0 }, 0, 40);
        assertEquals(List.of("0,4,0", "1,4,0", "2,4,0"), v.stream().map(Visit::cell).toList());
        assertEquals(15.5, v.get(0).tOut(), 1e-9);
        assertEquals(31.5, v.get(1).tOut(), 1e-9);
        // Through the corner (16, 16) in x and z: the two sections beside it are visited, for no length.
        double[] d = unit(1, 0, 1);
        List<Visit> c = plan(new double[] { 8, 70, 8 }, d, 0, 20);
        List<String> cells = c.stream().map(Visit::cell).toList();
        assertEquals("0,4,0", cells.get(0));
        assertTrue(cells.contains("1,4,1"));
        assertTrue(cells.contains("1,4,0") || cells.contains("0,4,1"), "a side of the corner: " + cells);
    }

    @Test
    void aVisitorStopsTheWalk() {
        List<Visit> seen = new ArrayList<>();
        SquadLookPlan.sections(0.5, 70, 0.5, 1, 0, 0, 0, 1000, (cx, sy, cz, a, b) -> {
            seen.add(new Visit(cx, sy, cz, a, b));
            return seen.size() < 3;
        });
        assertEquals(3, seen.size());
        assertTrue(plan(new double[] { 0, 0, 0 }, new double[] { 1, 0, 0 }, 5, 5).isEmpty());
    }

    @Test
    void theHeightClipEndsTheRayWhereItLeavesTheWorld() {
        // A world from -64 to 320.
        assertEquals(4096, SquadLookPlan.clipHeight(70, 0, -64, 320, 4096), 0); // level: never leaves
        assertEquals(250, SquadLookPlan.clipHeight(70, 1, -64, 320, 4096), 1e-9); // straight up
        assertEquals(134, SquadLookPlan.clipHeight(70, -1, -64, 320, 4096), 1e-9); // straight down
        assertEquals(268, SquadLookPlan.clipHeight(70, -0.5, -64, 320, 4096), 1e-9);
        assertEquals(100, SquadLookPlan.clipHeight(70, 0.001, -64, 320, 100), 0); // the reach first
        assertEquals(0, SquadLookPlan.clipHeight(330, 1, -64, 320, 4096), 0); // above, going up
        assertEquals(0, SquadLookPlan.clipHeight(330, 0, -64, 320, 4096), 0); // above, level
        assertEquals(394, SquadLookPlan.clipHeight(330, -1, -64, 320, 4096), 1e-9); // above, looking down: it crosses the world
        assertEquals(0, SquadLookPlan.clipHeight(-70, -1, -64, 320, 4096), 0); // below, going down
    }
}
