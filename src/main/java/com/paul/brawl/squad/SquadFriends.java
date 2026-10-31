package com.paul.brawl.squad;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * Friendly fire between squad bots (docs/system/squad/overview.md, "Damage rules"): a bot never hurts a bot that
 * shares an owner with it, nor a player who owns it. Found in a 20-bot fight: archers' arrows and guards' sweeps hit
 * their own team and the defence fell apart at once. Everything else is untouched: a bot still hurts mobs, other
 * players, and bots of other owners (PvP stays on).
 *
 * Minecraft-free, so it is unit-tested; the damage hook only asks {@link #spare}. Built once per roster update from
 * the runtime's state (bots[].owners), because the hook runs on every damage event of the server.
 */
public final class SquadFriends {

    public static final SquadFriends EMPTY = new SquadFriends(Map.of());

    /** Lower-case bot name → its owners' UUIDs. */
    private final Map<String, Set<UUID>> owners;

    private SquadFriends(Map<String, Set<UUID>> owners) {
        this.owners = owners;
    }

    /** From the runtime state's `bots` array ({name, owners: [{uuid, name}]}); malformed entries are skipped. */
    public static SquadFriends of(JsonArray bots) {
        if (bots == null) return EMPTY;
        Map<String, Set<UUID>> map = new HashMap<>();
        for (JsonElement el : bots) {
            try {
                JsonObject b = el.getAsJsonObject();
                Set<UUID> set = new HashSet<>();
                JsonElement os = b.get("owners");
                if (os != null && os.isJsonArray()) {
                    for (JsonElement o : os.getAsJsonArray()) {
                        try {
                            set.add(UUID.fromString(o.getAsJsonObject().get("uuid").getAsString()));
                        } catch (RuntimeException e) {
                            // an owner without a readable uuid protects nobody
                        }
                    }
                }
                map.put(b.get("name").getAsString().toLowerCase(Locale.ROOT), Set.copyOf(set));
            } catch (RuntimeException e) {
                // a bot entry without a name: not a bot we can recognise
            }
        }
        return map.isEmpty() ? EMPTY : new SquadFriends(Map.copyOf(map));
    }

    public boolean isBot(String name) {
        return name != null && owners.containsKey(name.toLowerCase(Locale.ROOT));
    }

    /**
     * Whether damage dealt by the player {@code attacker} (for an arrow: its shooter) to the player {@code victim}
     * must be cancelled: the attacker is a squad bot, and the victim is a squad bot sharing at least one owner with
     * it, or one of its owners.
     */
    public boolean spare(String attacker, String victim, UUID victimUuid) {
        if (attacker == null || owners.isEmpty()) return false;
        Set<UUID> mine = owners.get(attacker.toLowerCase(Locale.ROOT));
        if (mine == null || mine.isEmpty()) return false;
        if (victimUuid != null && mine.contains(victimUuid)) return true;
        Set<UUID> theirs = victim == null ? null : owners.get(victim.toLowerCase(Locale.ROOT));
        if (theirs == null) return false;
        for (UUID u : theirs) if (mine.contains(u)) return true;
        return false;
    }
}
