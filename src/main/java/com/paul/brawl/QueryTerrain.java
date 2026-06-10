package com.paul.brawl;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;

import net.minecraft.block.BlockState;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.entry.RegistryEntry;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.world.Heightmap;
import net.minecraft.world.World;
import net.minecraft.world.biome.Biome;

/**
 * On-demand relief snapshot for the AI God.
 *
 * <p>Returns a compact ASCII heightmap centered on a chosen point (defaults to
 * the praying player), plus a one-line summary (center, biome, Y range, slope
 * direction). Body reads each (x,z) column's top Y through
 * {@code World.getTopY(Heightmap.Type, x, z)} — that's a per-chunk cached
 * value, not a block scan, so the grid is cheap regardless of radius.
 *
 * <p>Design notes:
 * <ul>
 *   <li>The output grid is always {@value #GRID}x{@value #GRID} cells regardless
 *       of {@code radius}; bigger radius just samples coarser. Keeps the token
 *       cost roughly constant (~300–400 tokens per call) so the model isn't
 *       discouraged from calling it.</li>
 *   <li>{@link Heightmap.Type#MOTION_BLOCKING_NO_LEAVES} is the variant that
 *       matches "ground God can stand or build on" — the same heightmap used
 *       for hostile mob spawn checks.</li>
 *   <li>Water is detected by inspecting the block at the heightmap top: if its
 *       {@link BlockState#getFluidState()} is non-empty it renders as
 *       {@code ~} instead of an elevation glyph.</li>
 *   <li>Calls {@link World#getBlockState(BlockPos)} and {@link World#getBiome},
 *       so the dispatch in {@link ChatBotFunctions} wraps execution in
 *       {@code runOnMain(...)} — consistent with the other world-touching
 *       tools and safe against off-thread chunk loads.</li>
 * </ul>
 */
@JsonClassDescription(
    "Returns a compact ASCII relief map of the terrain centered on a position. "
  + "Call this before planning builds, picking creature spawn spots, choosing where "
  + "to appear, or describing the landscape — it is much cheaper than walking the "
  + "world block-by-block. Output is a 16x16 grid using the characters "
  + "' .:-=+*#%@' to show elevation from low to high relative to the visible Y "
  + "range, with '~' marking water columns, plus a header naming the center "
  + "column's biome, Y range, and dominant slope direction. The center is "
  + "clamped to within 128 blocks of the player; columns in unloaded chunks "
  + "render as '?' rather than forcing the server to load them.")
public class QueryTerrain {

    @OptionalField
    @JsonPropertyDescription("Absolute world X to center the snapshot on. Omit to center on the praying player.")
    public Integer centerX;

    @OptionalField
    @JsonPropertyDescription("Absolute world Z to center the snapshot on. Omit to center on the praying player.")
    public Integer centerZ;

    @OptionalField
    @JsonPropertyDescription("Half-width of the sampled area in blocks. Clamped 8..64, default 32. Larger radius covers more area at coarser resolution; the output grid is always 16x16 cells.")
    public Integer radius;

    /** Output grid dimension. 16x16 keeps token cost ~constant. */
    private static final int GRID = 16;
    /** Low→high shading ramp. {@code ~} is reserved for water cells. */
    private static final char[] SHADE = " .:-=+*#%@".toCharArray();
    private static final int DEFAULT_RADIUS = 32;
    private static final int MIN_RADIUS = 8;
    private static final int MAX_RADIUS = 64;
    /** Max distance the center may stray from the player. Without this the
     *  model can point the probe at far-away coordinates and force dozens of
     *  synchronous chunk loads/generations on the main thread (the sampling
     *  loop runs inside a GodActionQueue action, inline in the tick). */
    private static final int MAX_CENTER_OFFSET = 128;

    public String execute(ServerPlayerEntity player) {
        if (player == null) return "QueryTerrain: aucun joueur lié à l'appel.";
        World world = player.getWorld();
        if (world == null) return "QueryTerrain: monde indisponible.";

        BlockPos playerPos = player.getBlockPos();
        int cx = (centerX != null) ? centerX : playerPos.getX();
        int cz = (centerZ != null) ? centerZ : playerPos.getZ();
        cx = MathHelper.clamp(cx, playerPos.getX() - MAX_CENTER_OFFSET, playerPos.getX() + MAX_CENTER_OFFSET);
        cz = MathHelper.clamp(cz, playerPos.getZ() - MAX_CENTER_OFFSET, playerPos.getZ() + MAX_CENTER_OFFSET);
        boolean centerClamped = (centerX != null && centerX != cx) || (centerZ != null && centerZ != cz);
        int r = (radius == null) ? DEFAULT_RADIUS : radius;
        r = MathHelper.clamp(r, MIN_RADIUS, MAX_RADIUS);
        // Step so the 2r-wide sample window maps onto GRID cells. At r=8 step
        // collapses to 1 (full resolution); at r=64 step=8 (coarse overview).
        int step = Math.max(1, (2 * r) / GRID);

        int[][] heights = new int[GRID][GRID];
        boolean[][] water = new boolean[GRID][GRID];
        boolean[][] unloaded = new boolean[GRID][GRID];
        int minY = Integer.MAX_VALUE;
        int maxY = Integer.MIN_VALUE;

        // Reusable mutable BlockPos avoids 256 allocations per call.
        BlockPos.Mutable scratch = new BlockPos.Mutable();

        for (int gz = 0; gz < GRID; gz++) {
            for (int gx = 0; gx < GRID; gx++) {
                int worldX = cx - r + gx * step;
                int worldZ = cz - r + gz * step;

                // Never sample an unloaded chunk — getTopY/getBlockState would
                // synchronously load (or generate) it on the main thread.
                if (!world.isChunkLoaded(worldX >> 4, worldZ >> 4)) {
                    unloaded[gz][gx] = true;
                    continue;
                }

                // getTopY returns the Y of the first non-blocking position above
                // the heightmap top, so the surface block itself is at result-1.
                int terrainY = world.getTopY(Heightmap.Type.MOTION_BLOCKING_NO_LEAVES, worldX, worldZ) - 1;
                heights[gz][gx] = terrainY;
                if (terrainY < minY) minY = terrainY;
                if (terrainY > maxY) maxY = terrainY;

                scratch.set(worldX, terrainY, worldZ);
                BlockState st = world.getBlockState(scratch);
                if (!st.getFluidState().isEmpty()) {
                    water[gz][gx] = true;
                }
            }
        }

        if (minY > maxY) {
            return "QueryTerrain: la zone autour de (" + cx + "," + cz
                + ") n'est pas chargée — recentre plus près du joueur.";
        }

        // Slope: mean Y of last vs first column (W→E) and last vs first row
        // (N→S), counting only loaded cells per edge.
        double avgW = 0, avgE = 0, avgN = 0, avgS = 0;
        int nW = 0, nE = 0, nN = 0, nS = 0;
        for (int g = 0; g < GRID; g++) {
            if (!unloaded[g][0])        { avgW += heights[g][0];        nW++; }
            if (!unloaded[g][GRID - 1]) { avgE += heights[g][GRID - 1]; nE++; }
            if (!unloaded[0][g])        { avgN += heights[0][g];        nN++; }
            if (!unloaded[GRID - 1][g]) { avgS += heights[GRID - 1][g]; nS++; }
        }
        String slope;
        if (nW == 0 || nE == 0 || nN == 0 || nS == 0) {
            slope = "unknown (edge unloaded)";
        } else {
            slope = describeSlope(avgE / nE - avgW / nW, avgS / nS - avgN / nN);
        }

        // Biome at the center column.
        String biome;
        try {
            RegistryEntry<Biome> entry = world.getBiome(new BlockPos(cx, playerPos.getY(), cz));
            biome = entry.getKey().map(RegistryKey::getValue).map(Object::toString).orElse("unknown");
        } catch (Exception e) {
            biome = "unknown";
        }

        StringBuilder sb = new StringBuilder(GRID * (GRID * 2 + 1) + 320);
        sb.append("Terrain snapshot — center=(").append(cx).append(',').append(cz).append(") ")
          .append("radius=").append(r).append(" step=").append(step);
        if (centerClamped) {
            sb.append(" (center clamped to within ").append(MAX_CENTER_OFFSET).append(" blocks of the player)");
        }
        sb.append('\n');
        sb.append("Biome=").append(biome)
          .append("  Y range ").append(minY).append("..").append(maxY)
          .append(" (Δ").append(maxY - minY).append(")")
          .append("  playerY=").append(playerPos.getY())
          .append("  slope=").append(slope).append('\n');
        sb.append("Legend: '").append(new String(SHADE)).append("' low→high across the Y range above, '~'=water, '?'=unloaded (not sampled). ")
          .append("Each cell covers ").append(step).append('x').append(step).append(" blocks. ")
          .append("Top row = north (−Z), bottom = south (+Z); left = west (−X), right = east (+X).\n");

        int span = Math.max(1, maxY - minY);
        int rampMax = SHADE.length - 1;
        for (int gz = 0; gz < GRID; gz++) {
            for (int gx = 0; gx < GRID; gx++) {
                if (unloaded[gz][gx]) {
                    sb.append("? ");
                    continue;
                }
                if (water[gz][gx]) {
                    sb.append("~ ");
                    continue;
                }
                int idx = (int) Math.round(((double) (heights[gz][gx] - minY) / span) * rampMax);
                idx = MathHelper.clamp(idx, 0, rampMax);
                sb.append(SHADE[idx]).append(' ');
            }
            sb.append('\n');
        }

        String result = sb.toString();

        // TEMP — mirror the snapshot to the praying player's chat so we can eyeball
        // what God is actually seeing. Vanilla chat is proportional, so the grid
        // will look slightly skewed, but the pattern is still readable. Safe to
        // call sendMessage directly here: dispatch wraps this whole execute() in
        // runOnMain, so we're on the server thread. Remove once tuned.
        for (String line : result.split("\n")) {
            ChatPrinter.sendMessage(player, line);
        }

        return result;
    }

    /** Maps a (dx,dz) elevation gradient to a cardinal/diagonal string. */
    private static String describeSlope(double dx, double dz) {
        double mag = Math.sqrt(dx * dx + dz * dz);
        if (mag < 1.5) return String.format("flat (Δ%.1f across area)", mag);
        // atan2(dz, dx) with the world convention east=+X, south=+Z:
        //   0°=E, 90°=S, ±180°=W, -90°=N.
        double ang = Math.toDegrees(Math.atan2(dz, dx));
        String dir;
        if      (ang >= -22.5 && ang <  22.5)  dir = "E";
        else if (ang >=  22.5 && ang <  67.5)  dir = "SE";
        else if (ang >=  67.5 && ang < 112.5)  dir = "S";
        else if (ang >= 112.5 && ang < 157.5)  dir = "SW";
        else if (ang >= -67.5 && ang < -22.5)  dir = "NE";
        else if (ang >= -112.5 && ang < -67.5) dir = "N";
        else if (ang >= -157.5 && ang < -112.5) dir = "NW";
        else                                    dir = "W";
        return String.format("rising toward %s (Δ%.1f)", dir, mag);
    }
}
