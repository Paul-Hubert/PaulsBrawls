package com.paul.brawl.squad;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The Minecraft-free part of {@code /bots general} (docs/38, SquadGeneralPlanTest): the arguments of {@code create}
 * and {@code allow}, where a General's bots appear around its spawn point, and the launch line of its Claude Code
 * instance. {@link SquadGeneral} does the rest on the server; the runtime keeps the General itself.
 */
public final class SquadGeneralPlan {

    /** A General's name: its virtual owner's player name, and the prefix of its bots' names (16 chars at most). */
    public static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{3,11}");

    public static final String CREATE_USAGE = "/bots general create NOM [archer=N] [guard=N] [miner=N] [farmer=N] [reinforce=N] [range=N]";
    public static final String ALLOW_USAGE = "/bots general allow NOM [archer=N] [guard=N] [miner=N] [farmer=N] [reinforce=N] [range=N]";

    /** The workspace of a General's Claude Code instance, from the repository's root. */
    public static final String WORKSPACE = "squad/agent/general";

    /**
     * {@code archer=10 guard=5 reinforce=4 range=300}: the allowance per kit (only the mod's kits), and the optional
     * reinforcements and range ({@code null} when absent). {@code create} needs at least one kit.
     */
    public record Terms(Map<String, Integer> allowance, Integer reinforce, Integer range) {}

    private SquadGeneralPlan() {}

    public static Terms parseTerms(String text, boolean needKit) {
        Map<String, Integer> allowance = new LinkedHashMap<>();
        Integer reinforce = null;
        Integer range = null;
        for (String part : SquadArgs.tokenize(text == null ? "" : text.trim())) {
            int eq = part.indexOf('=');
            if (eq <= 0) throw new IllegalArgumentException("« " + part + " » : attendu clé=nombre, par exemple archer=10");
            String key = part.substring(0, eq).toLowerCase(Locale.ROOT);
            int n = number(part.substring(eq + 1), key);
            switch (key) {
                case "reinforce", "renforts" -> reinforce = bounded(n, key, 0, 1000);
                case "range", "portee", "portée" -> range = bounded(n, key, 16, 4000);
                default -> {
                    if (!SquadKits.NAMES.contains(key)) {
                        throw new IllegalArgumentException("« " + key + " » : un kit (" + String.join(", ", SquadKits.NAMES) + "), reinforce ou range");
                    }
                    allowance.put(key, bounded(n, key, 0, 100));
                }
            }
        }
        if (needKit && allowance.values().stream().noneMatch(n -> n > 0)) {
            throw new IllegalArgumentException("donne au moins une dotation, par exemple archer=10 guard=10");
        }
        return new Terms(allowance, reinforce, range);
    }

    private static int number(String s, String what) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("« " + what + " » : nombre entier attendu, reçu « " + s + " »");
        }
    }

    private static int bounded(int n, String what, int min, int max) {
        if (n < min || n > max) throw new IllegalArgumentException("« " + what + " » : entre " + min + " et " + max);
        return n;
    }

    /**
     * Where bot {@code i} of {@code n} of one spawn appears: {@link SquadRaidPlan#spread}'s rows of 5, turned to face
     * {@code yaw} (the axis), so the squad stands across the axis, its rows behind each other along it.
     */
    public static SquadRaidPlan.XZ place(double x, double z, float yaw, int i, int n) {
        SquadRaidPlan.XZ d = SquadRaidPlan.spread(i, n);
        double r = Math.toRadians(yaw);
        // The axis f = (-sin, cos); its right-hand side s = (-cos, -sin). d.x() across, d.z() along (rows go back).
        double fx = -Math.sin(r), fz = Math.cos(r);
        double sx = -Math.cos(r), sz = -Math.sin(r);
        return new SquadRaidPlan.XZ(x + d.x() * sx - d.z() * fx, z + d.x() * sz - d.z() * fz);
    }

    /** The PowerShell line that starts a General's instance (the ticket is its only credential). */
    public static String launchLine(String ticket) {
        return "cd " + WORKSPACE + "; $env:SQUAD_GENERAL_TICKET='" + ticket + "'; claude";
    }

    /** The same for a POSIX shell. */
    public static String launchLinePosix(String ticket) {
        return "cd " + WORKSPACE + " && SQUAD_GENERAL_TICKET='" + ticket + "' claude";
    }

    /** The kits a spawn request may name. */
    public static boolean knownKit(String kit) {
        return kit != null && SquadKits.NAMES.contains(kit);
    }
}
