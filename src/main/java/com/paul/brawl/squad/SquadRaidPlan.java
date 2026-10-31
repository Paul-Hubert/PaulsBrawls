package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;

/**
 * The Minecraft-free part of {@code /bots raid} (SquadRaidPlanTest): its arguments, where the enemy army appears,
 * its bots' names and their places on arrival, and how long to wait for them. {@link SquadRaid} does the rest on the
 * server.
 *
 * <p>The raiders belong to a virtual owner, {@link #OWNER}, never to the admin who calls the raid: the friendly-fire
 * rule and the scripts' friends are "bots sharing an owner", so raiders owned by the caller would be on the caller's
 * own team and spare their army.
 */
public final class SquadRaidPlan {

    /** The raiders' owner: a player nobody logs in as (offline mode gives the name its offline UUID). */
    public static final String OWNER = "Envahisseur";
    public static final String ARCHER_PREFIX = "EnnArcher";
    public static final String GUARD_PREFIX = "EnnGarde";

    public static final int DEFAULT_DISTANCE = 200;
    public static final int DEFAULT_ARCHERS = 10;
    public static final int DEFAULT_GUARDS = 10;
    public static final int MIN_DISTANCE = 16;
    public static final int MAX_DISTANCE = 2000;
    public static final int MAX_PER_ROLE = 30;

    /** Raiders per row where they appear, and the gap between two of them, in blocks. */
    static final int ROW = 5;
    static final int GAP = 2;

    /** The runtime logs bots in 4 s apart (I1); this much more for the chunks, the login and the kit. */
    static final long LOGIN_STAGGER_MS = 4_000;
    static final long START_SLACK_MS = 30_000;

    public record Args(int distance, int archers, int guards) {
        public int total() {
            return archers + guards;
        }
    }

    /** A point on the ground plane. */
    public record XZ(double x, double z) {}

    private SquadRaidPlan() {}

    /**
     * {@code [distance] [archers] [guards]}, positional, every one optional (200, 10, 10). Throws
     * IllegalArgumentException with the French line for the admin.
     */
    public static Args parse(String text) {
        List<String> parts = SquadArgs.tokenize(text == null ? "" : text.trim());
        if (parts.size() > 3) throw new IllegalArgumentException("trop d'arguments (usage : /bots raid [distance] [archers] [gardes])");
        int distance = parts.size() > 0 ? number(parts.get(0), "distance", MIN_DISTANCE, MAX_DISTANCE) : DEFAULT_DISTANCE;
        int archers = parts.size() > 1 ? number(parts.get(1), "archers", 0, MAX_PER_ROLE) : DEFAULT_ARCHERS;
        int guards = parts.size() > 2 ? number(parts.get(2), "gardes", 0, MAX_PER_ROLE) : DEFAULT_GUARDS;
        if (archers + guards == 0) throw new IllegalArgumentException("il faut au moins un envahisseur");
        return new Args(distance, archers, guards);
    }

    private static int number(String s, String what, int min, int max) {
        int n;
        try {
            n = Integer.parseInt(s);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("« " + what + " » : nombre entier attendu, reçu « " + s + " »");
        }
        if (n < min || n > max) throw new IllegalArgumentException("« " + what + " » : entre " + min + " et " + max);
        return n;
    }

    /**
     * {@code distance} blocks from (x, z) along the horizontal look direction of {@code yaw} (Minecraft degrees: 0
     * looks to +Z, 90 to -X). The pitch is ignored, so looking at the ground still sends the army far ahead.
     */
    public static XZ point(double x, double z, float yaw, double distance) {
        double r = Math.toRadians(yaw);
        return new XZ(x - Math.sin(r) * distance, z + Math.cos(r) * distance);
    }

    /**
     * {@code count} free names {@code PREFIX01}, {@code PREFIX02}…: a name {@code taken} refuses (in the roster, online,
     * or someone already played under it: a bot would load that save) is skipped, so numbers can have gaps.
     */
    public static List<String> names(String prefix, int count, Predicate<String> taken) {
        List<String> out = new ArrayList<>();
        for (int i = 1; out.size() < count; i++) {
            String n = String.format(Locale.ROOT, "%s%02d", prefix, i);
            if (n.length() > 16 || i > 9_999) throw new IllegalStateException("no free raider name left for " + prefix);
            if (!taken.test(n)) out.add(n);
        }
        return out;
    }

    /**
     * Where raider {@code i} of {@code n} appears, relative to the point: rows of {@link #ROW}, {@link #GAP} blocks
     * apart, centred on it, so twenty bots do not land in one block (and push each other into walls).
     */
    public static XZ spread(int i, int n) {
        int rows = (n + ROW - 1) / ROW;
        int row = i / ROW;
        int inRow = Math.min(ROW, n - row * ROW);
        double x = ((i % ROW) - (inRow - 1) / 2.0) * GAP;
        double z = (row - (rows - 1) / 2.0) * GAP;
        return new XZ(x, z);
    }

    /** How long to wait for every raider before starting the raid with those that came: 4 s each, plus 30 s. */
    public static long startTimeoutMs(int count) {
        return LOGIN_STAGGER_MS * count + START_SLACK_MS;
    }

    /** The raid order's arguments: the caller's position when they called it, and the caller as the target. */
    public static List<String> orderTokens(double x, double y, double z, String target) {
        List<String> out = new ArrayList<>();
        out.add("x=" + Math.round(x));
        out.add("y=" + Math.round(y));
        out.add("z=" + Math.round(z));
        if (target != null && !target.isBlank()) out.add("target=" + target);
        return out;
    }
}
