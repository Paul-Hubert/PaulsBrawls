package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;

/**
 * The Minecraft-free part of forgetting a squad bot's save (SquadSavesTest). A bot logs in as an offline player, so
 * the server keeps a save for it (playerdata, stats, advancements, keyed by its offline UUID). A despawned bot's save
 * used to stay, and since a name with a save is never given to a new bot (it would load that save), every squad
 * spawn took new numbers: 474 saves on production (2026-11-02). Now a despawned bot's save is deleted once it has
 * left (the server writes the save as a player leaves), and its name is free again. {@link Squad} deletes the files.
 */
public final class SquadSaves {

    /** A despawned bot still online, or still in the cached roster, is waited for this long, then let go. */
    static final long WAIT_MS = 120_000;

    /** The names the mod gives bots: the kits' (Garde01, Archer01, Mineur01, Fermier01) and the raiders'. */
    public static List<String> prefixes() {
        List<String> out = new ArrayList<>();
        for (String k : SquadKits.NAMES) SquadKits.find(k).ifPresent(kit -> out.add(SquadSpawnPlan.prefix(kit)));
        out.add(SquadRaidPlan.ARCHER_PREFIX);
        out.add(SquadRaidPlan.GUARD_PREFIX);
        return out;
    }

    /** Every name {@link SquadRaidPlan#names} can make from these prefixes, prefix by prefix, in numeric order. */
    public static List<String> generatedNames(List<String> prefixes) {
        List<String> out = new ArrayList<>();
        for (String p : prefixes) {
            for (int i = 1; i <= SquadRaidPlan.MAX_NUMBER; i++) {
                String n = SquadRaidPlan.numbered(p, i);
                if (n.length() > 16) break;
                out.add(n);
            }
        }
        return out;
    }

    /** What {@link #due} found: the saves to delete now, and the names given up after {@link #WAIT_MS}. */
    public record Due(List<String> delete, List<String> givenUp) {}

    private record Wait(String name, long since) {}

    /** Despawned bots whose save is still to delete (lower-case name → the exact name: the offline UUID is case-sensitive). */
    private final Map<String, Wait> waiting = new LinkedHashMap<>();

    /** A bot was despawned: forget its save once it is gone. */
    public synchronized void forget(String name, long now) {
        waiting.put(name.toLowerCase(Locale.ROOT), new Wait(name, now));
    }

    public synchronized boolean isEmpty() {
        return waiting.isEmpty();
    }

    /**
     * The saves that can go now: their bot is no longer online (its save is written) and no longer in the roster (the
     * cache can lag the despawn by a state event; a bot spawned again under the name is a roster bot, whose save
     * stays). A name still waiting after {@link #WAIT_MS} is given up. Both leave the list.
     */
    public synchronized Due due(long now, Predicate<String> online, Predicate<String> inRoster) {
        List<String> delete = new ArrayList<>();
        List<String> givenUp = new ArrayList<>();
        for (Iterator<Wait> it = waiting.values().iterator(); it.hasNext(); ) {
            Wait w = it.next();
            if (!online.test(w.name()) && !inRoster.test(w.name())) {
                delete.add(w.name());
                it.remove();
            } else if (now - w.since() > WAIT_MS) {
                givenUp.add(w.name());
                it.remove();
            }
        }
        return new Due(delete, givenUp);
    }
}
