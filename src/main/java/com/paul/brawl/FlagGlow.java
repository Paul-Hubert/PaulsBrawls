package com.paul.brawl;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Bug #11 — which players' glow the CTF mod owns. The per-tick {@code setGlowing(hasFlag)} used to switch OFF a glow
 * that something else had set (a command, another mod) on every player without a flag. Now the mod clears only the
 * glow it turned on itself. Minecraft-free (FlagGlowTest); {@link FlagManager} applies the decisions.
 */
public final class FlagGlow {
    /** What to do with a player's glowing flag this tick. */
    public enum Action { SET, CLEAR, NONE }

    private final Set<UUID> ours = new HashSet<>();

    /** Decide for one player: glow while a Flag is carried; on losing it, clear only a glow we set. */
    public synchronized Action update(UUID player, boolean hasFlag, boolean currentlyGlowing) {
        if (hasFlag) {
            if (currentlyGlowing && !ours.contains(player)) return Action.NONE; // glowing for another reason — leave it
            ours.add(player);
            return currentlyGlowing ? Action.NONE : Action.SET;
        }
        if (ours.remove(player)) return Action.CLEAR;
        return Action.NONE;
    }

    /** The player left: forget them (their glow is not ours to manage on rejoin). */
    public synchronized void forget(UUID player) {
        ours.remove(player);
    }

    /** True if the name marks a CTF flag banner (case-sensitive substring, as before). */
    public static boolean isFlagName(String name) {
        return name != null && name.contains("Flag");
    }
}
