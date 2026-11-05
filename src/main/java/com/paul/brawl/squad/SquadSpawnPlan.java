package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * The Minecraft-free part of {@code /bots squad spawn|despawn} (SquadSpawnPlanTest): the arguments, the bots' names,
 * and their places on a ring around the owner. {@link SquadSpawn} does the rest on the server.
 */
public final class SquadSpawnPlan {

    public static final int DEFAULT_COUNT = 5;
    public static final int MAX_COUNT = 30;
    /** The ring: no closer than this to the owner, and about this far between two bots along it. */
    static final double MIN_RADIUS = 2.5;
    static final double SPACING = 1.5;

    static final String SPAWN_USAGE = "/bots squad spawn archer|guard|miner|farmer|spearman|horseman|horsearcher [nombre=5] [propriétaire=@s] [autres propriétaires…]";
    static final String DESPAWN_USAGE = "/bots squad despawn [archer|guard|miner|farmer|spearman|horseman|horsearcher] [propriétaire=@s]";
    static final String RESPAWN_USAGE = "/bots squad respawn [archer|guard|miner|farmer|spearman|horseman|horsearcher] [nombre] [propriétaire=@s]";

    /** {@code owner} is a player name or {@code @s}; {@code others} the other owners, in order. */
    public record SpawnArgs(SquadKits.Kit kit, int count, String owner, List<String> others) {}

    /** No kit: every bot of the owner. */
    public record DespawnArgs(Optional<SquadKits.Kit> kit, String owner) {}

    /** No kit: every dead bot of the owner; no count: all of them. */
    public record RespawnArgs(Optional<SquadKits.Kit> kit, Optional<Integer> count, String owner) {}

    /** An offset from the owner, on the ground plane. */
    public record XZ(double x, double z) {}

    private SquadSpawnPlan() {}

    /**
     * {@code KIT [number] [owner] [other owners…]}: the kit first; then a number if the next token is one (1 to
     * {@link #MAX_COUNT}, default {@link #DEFAULT_COUNT}); then the owner (default {@code @s}); the rest are the other
     * owners. Throws IllegalArgumentException with the French line for the admin.
     */
    public static SpawnArgs parseSpawn(String text) {
        List<String> t = SquadArgs.names(text);
        if (t.isEmpty()) throw new IllegalArgumentException("usage : " + SPAWN_USAGE);
        SquadKits.Kit kit = kit(t.get(0));
        int i = 1;
        int count = DEFAULT_COUNT;
        if (i < t.size() && t.get(i).matches("\\d+")) {
            count = Integer.parseInt(t.get(i));
            if (count < 1 || count > MAX_COUNT) throw new IllegalArgumentException("« nombre » : entre 1 et " + MAX_COUNT);
            i++;
        }
        String owner = i < t.size() ? t.get(i++) : "@s";
        List<String> others = new ArrayList<>();
        for (; i < t.size(); i++) {
            String o = t.get(i);
            if (!o.equalsIgnoreCase(owner) && others.stream().noneMatch(o::equalsIgnoreCase)) others.add(o);
        }
        return new SpawnArgs(kit, count, owner, List.copyOf(others));
    }

    /** {@code [KIT] [owner]}: a kit name first if given, then the owner (default {@code @s}). */
    public static DespawnArgs parseDespawn(String text) {
        List<String> t = SquadArgs.names(text);
        int i = 0;
        Optional<SquadKits.Kit> kit = Optional.empty();
        if (i < t.size() && SquadKits.find(t.get(i)).isPresent()) kit = SquadKits.find(t.get(i++));
        String owner = i < t.size() ? t.get(i++) : "@s";
        if (i < t.size()) throw new IllegalArgumentException("trop d'arguments (usage : " + DESPAWN_USAGE + ")");
        return new DespawnArgs(kit, owner);
    }

    /**
     * {@code [KIT] [number] [owner]} (docs/35 F7): a kit name first if given (singular or plural), then a number (1 to
     * {@link #MAX_COUNT}) if the next token is one, then the owner (default {@code @s}).
     */
    public static RespawnArgs parseRespawn(String text) {
        List<String> t = SquadArgs.names(text);
        int i = 0;
        Optional<SquadKits.Kit> kit = Optional.empty();
        if (i < t.size() && SquadKits.find(t.get(i)).isPresent()) kit = SquadKits.find(t.get(i++));
        Optional<Integer> count = Optional.empty();
        if (i < t.size() && t.get(i).matches("\\d+")) {
            int n = Integer.parseInt(t.get(i++));
            if (n < 1 || n > MAX_COUNT) throw new IllegalArgumentException("« nombre » : entre 1 et " + MAX_COUNT);
            count = Optional.of(n);
        }
        String owner = i < t.size() ? t.get(i++) : "@s";
        if (i < t.size()) throw new IllegalArgumentException("trop d'arguments (usage : " + RESPAWN_USAGE + ")");
        return new RespawnArgs(kit, count, owner);
    }

    /** « 7 gardes », « 1 garde », « 3 bots »: a count and the kit's label (or « bot »), French plural. */
    public static String counted(int n, Optional<SquadKits.Kit> kit) {
        String word = kit.map(SquadKits.Kit::label).orElse("bot");
        return n + " " + word + (n > 1 ? "s" : "");
    }

    private static SquadKits.Kit kit(String name) {
        return SquadKits.find(name).orElseThrow(() -> new IllegalArgumentException(
            "kit inconnu : " + name + " (" + String.join(", ", SquadKits.NAMES) + ")"));
    }

    /** The bots' name prefix for a kit: its French label, capitalised (Garde01, Archer01, Mineur01, Fermier01). */
    public static String prefix(SquadKits.Kit kit) {
        String l = kit.label();
        return l.substring(0, 1).toUpperCase(Locale.ROOT) + l.substring(1);
    }

    /**
     * Where bot {@code i} of {@code n} stands, relative to the owner: evenly on a ring, about {@link #SPACING} blocks
     * apart and at least {@link #MIN_RADIUS} away, so no two bots land in one block (or in the owner).
     */
    public static XZ ring(int i, int n) {
        double r = Math.max(MIN_RADIUS, n * SPACING / (2 * Math.PI));
        double a = 2 * Math.PI * i / Math.max(1, n);
        return new XZ(Math.round(Math.cos(a) * r * 100) / 100.0, Math.round(Math.sin(a) * r * 100) / 100.0);
    }
}
