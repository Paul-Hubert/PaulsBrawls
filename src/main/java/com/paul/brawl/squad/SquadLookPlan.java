package com.paul.brawl.squad;

/**
 * The geometry of the commander's long look ({@link SquadLook}), Minecraft-free: where a ray leaves the world's
 * height, and the chunk sections it crosses, in order (a 3D DDA over 16-block cells, Amanatides–Woo), each with the
 * stretch of the ray inside it. The server thread copies those sections for the worker that walks the ray.
 *
 * <p>A ray is {@code origin + t·dir}, {@code dir} a unit vector, so {@code t} is in blocks.
 */
final class SquadLookPlan {

    /** At most this many sections per call: a guard against a non-finite input, never reached by a real ray. */
    static final int MAX_SECTIONS = 1 << 16;

    private SquadLookPlan() {}

    /** One section the ray crosses: its chunk x, section y (world section coordinates), chunk z, where it enters and leaves. */
    @FunctionalInterface
    interface SectionVisitor {
        /** False stops the walk. */
        boolean visit(int cx, int sy, int cz, double tIn, double tOut);
    }

    /**
     * How far the ray goes before it leaves the world's height for good, at most {@code reach}: blocks are in
     * {@code [bottomY, topY)}. 0 when it starts above going up, below going down, or level outside.
     */
    static double clipHeight(double y, double dy, int bottomY, int topY, double reach) {
        double exit;
        if (dy > 0) exit = (topY - y) / dy;
        else if (dy < 0) exit = (bottomY - y) / dy;
        else exit = y >= bottomY && y < topY ? reach : 0;
        return Math.max(0, Math.min(reach, exit));
    }

    /**
     * The sections the ray crosses between {@code t0} and {@code tMax}, in order, contiguous: the first one entered at
     * {@code t0}, each next one entered where the last was left, the last one left at {@code tMax}. A ray through an
     * edge or a corner also visits the sections beside it, for no length ({@code tIn == tOut}): a voxel walk along that
     * edge may read either side.
     */
    static void sections(double ox, double oy, double oz, double dx, double dy, double dz, double t0, double tMax, SectionVisitor v) {
        if (!(tMax > t0)) return;
        double px = ox + dx * t0;
        double py = oy + dy * t0;
        double pz = oz + dz * t0;
        int cx = Math.floorDiv((int) Math.floor(px), 16);
        int cy = Math.floorDiv((int) Math.floor(py), 16);
        int cz = Math.floorDiv((int) Math.floor(pz), 16);
        int sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        int sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        int sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
        double ddx = sx != 0 ? 16 / Math.abs(dx) : Double.POSITIVE_INFINITY;
        double ddy = sy != 0 ? 16 / Math.abs(dy) : Double.POSITIVE_INFINITY;
        double ddz = sz != 0 ? 16 / Math.abs(dz) : Double.POSITIVE_INFINITY;
        double tx = sx > 0 ? t0 + ((cx + 1) * 16.0 - px) / dx : sx < 0 ? t0 + (cx * 16.0 - px) / dx : Double.POSITIVE_INFINITY;
        double ty = sy > 0 ? t0 + ((cy + 1) * 16.0 - py) / dy : sy < 0 ? t0 + (cy * 16.0 - py) / dy : Double.POSITIVE_INFINITY;
        double tz = sz > 0 ? t0 + ((cz + 1) * 16.0 - pz) / dz : sz < 0 ? t0 + (cz * 16.0 - pz) / dz : Double.POSITIVE_INFINITY;
        double tIn = t0;
        for (int n = 0; n < MAX_SECTIONS; n++) {
            double tOut = Math.min(Math.min(tx, ty), Math.min(tz, tMax));
            if (tOut < tIn) tOut = tIn; // a boundary the rounding put a hair behind
            if (!v.visit(cx, cy, cz, tIn, tOut) || tOut >= tMax) return;
            tIn = tOut;
            if (tx <= ty && tx <= tz) {
                cx += sx;
                tx += ddx;
            } else if (ty <= tz) {
                cy += sy;
                ty += ddy;
            } else {
                cz += sz;
                tz += ddz;
            }
        }
    }
}
