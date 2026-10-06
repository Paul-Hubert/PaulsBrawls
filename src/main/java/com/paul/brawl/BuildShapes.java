package com.paul.brawl;

import java.util.ArrayList;
import java.util.List;

/**
 * The block offsets one placement call covers (Minecraft-free, unit-tested in BuildServiceTest). Shared by the
 * builtin textual {@code PlaceLine}/{@code PlaceBlocks} scanner and the {@code builder} MCP tools, so a line is
 * walked one way only.
 */
public final class BuildShapes {
    private BuildShapes() {}

    /**
     * The blocks of {@code PlaceLine(x,y,z,x2,y2,z2)}: {@code max(1, longest axis delta) + 1} steps from the first
     * point to the second (so a zero-length line places its block twice, as it always did — see
     * {@link BuildGuard#lineBlocks}). Call only after the size cap: this allocates one entry per block.
     */
    public static List<int[]> line(int x, int y, int z, int x2, int y2, int z2) {
        int dx = x2 - x, dy = y2 - y, dz = z2 - z;
        int maxLen = Math.max(1, Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz))));
        List<int[]> out = new ArrayList<>(maxLen + 1);
        for (int i = 0; i <= maxLen; i++) {
            out.add(new int[] { x + dx * i / maxLen, y + dy * i / maxLen, z + dz * i / maxLen });
        }
        return out;
    }

    /** The blocks of {@code PlaceBlocks(xs, ys, zs)}: one per index, up to the shortest array. */
    public static List<int[]> points(int[] xs, int[] ys, int[] zs) {
        int n = Math.min(xs.length, Math.min(ys.length, zs.length));
        List<int[]> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++) out.add(new int[] { xs[i], ys[i], zs[i] });
        return out;
    }
}
