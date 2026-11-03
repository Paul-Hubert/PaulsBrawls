package com.paul.brawl.squad;

import java.util.Collection;

/**
 * What a roster bot's death does that a player's does not (docs/35 D2): it drops nothing. Its inventory is simply
 * lost, because {@code /bots squad respawn} gives it its kit again (D3); the server's other players are unchanged (no
 * {@code keepInventory} gamerule). Minecraft-free (SquadDeathTest); the hook is {@code mixin/PlayerMixin}.
 */
public final class SquadDeath {

    private SquadDeath() {}

    /** Whether the dying player is a roster bot (names compared case-insensitively, as the join gate does). */
    public static boolean dropsNothing(Collection<String> rosterBots, String playerName) {
        if (playerName == null || rosterBots == null) return false;
        for (String b : rosterBots) if (b != null && b.equalsIgnoreCase(playerName)) return true;
        return false;
    }
}
