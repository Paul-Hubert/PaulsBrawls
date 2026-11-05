package com.paul.brawl.squad;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Squads and the selected squad (docs/40). Each {@code /bots squad spawn} is one squad: its bots carry the roster tag
 * {@code esc-N}, N new for every spawn. A player picks a squad with the selector (an item bound to {@link #SELECT}): a
 * right-click on one of their bots selects that bot's squad, a right-click with no bot under the crosshair deselects.
 * Every bound item's click, and {@code /bots order}, then goes to the selected squad only (the runtime's {@code squad}
 * field); a bound item's click with nothing selected is refused with {@link #NONE}.
 *
 * <p>Minecraft-free (SquadSelectionTest): the tag rules, the texts and the per-player selection, kept in memory (a
 * restart or a disconnect forgets it).
 */
public final class SquadSelection {

    /** The reserved order a selector item is bound to ({@code /bots orders bind select}); never sent to the runtime. */
    public static final String SELECT = "select";
    /** A squad's roster tag: {@code esc-} and its number (the runtime's tags: a-z, 0-9, _ and -, 24 at most). */
    static final Pattern TAG = Pattern.compile("esc-([0-9]{1,9})");
    static final String NONE = "[Bots] Aucune escouade sélectionnée.";

    private static final Map<UUID, String> SELECTED = new ConcurrentHashMap<>();

    private SquadSelection() {}

    // -- the tags ---------------------------------------------------------------------------------------------------

    /** Whether a bound order is the selector. */
    static boolean isSelector(String order) {
        return order != null && order.equalsIgnoreCase(SELECT);
    }

    /** The squad of a bot, from its tags: its {@code esc-N} tag (the lowest, should it have several). */
    static Optional<String> squadOf(List<String> tags) {
        String best = null;
        long n = Long.MAX_VALUE;
        for (String t : tags) {
            Matcher m = TAG.matcher(t);
            if (m.matches() && Long.parseLong(m.group(1)) < n) {
                n = Long.parseLong(m.group(1));
                best = t;
            }
        }
        return Optional.ofNullable(best);
    }

    /** A new squad's tag: one past the highest number among {@code tags} and {@code floor} (the last one given here). */
    static String nextTag(Iterable<String> tags, long floor) {
        long max = Math.max(0, floor);
        for (String t : tags) {
            Matcher m = TAG.matcher(t);
            if (m.matches()) max = Math.max(max, Long.parseLong(m.group(1)));
        }
        return "esc-" + (max + 1);
    }

    /** The number in a squad's tag (0 for anything else). */
    static long number(String tag) {
        Matcher m = TAG.matcher(tag == null ? "" : tag);
        return m.matches() ? Long.parseLong(m.group(1)) : 0;
    }

    /** « escouade 3 ». */
    static String label(String tag) {
        Matcher m = TAG.matcher(tag == null ? "" : tag);
        return m.matches() ? "escouade " + m.group(1) : String.valueOf(tag);
    }

    // -- the texts ----------------------------------------------------------------------------------------------------

    /** The answer to a selection: the squad and its bots. */
    static String selectedText(String tag, List<String> members) {
        String who = members.isEmpty() ? "aucun bot" : String.join(", ", members) + " (" + members.size() + (members.size() > 1 ? " bots)" : " bot)");
        return "[Bots] " + capitalized(label(tag)) + " sélectionnée : " + who + ".";
    }

    /** The answer to a click on nothing: deselected, or there was nothing to deselect. */
    static String deselectedText(boolean had) {
        return had ? "[Bots] Escouade désélectionnée." : NONE;
    }

    private static String capitalized(String s) {
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    // -- the selection --------------------------------------------------------------------------------------------------

    static Optional<String> selected(UUID player) {
        return Optional.ofNullable(SELECTED.get(player));
    }

    static void select(UUID player, String tag) {
        SELECTED.put(player, tag);
    }

    /** Deselect; whether there was a selection. */
    static boolean clear(UUID player) {
        return SELECTED.remove(player) != null;
    }
}
