package com.paul.brawl;

import java.util.UUID;

/**
 * Port: every world effect God has, keyed by player UUID and free of Minecraft types (docs/27 §4–5). The rules
 * (clamps, ownership, refusals) live in {@link GodService} in front of it; an implementation only applies an
 * already-checked effect. {@link MinecraftGodWorld} is the real one; the MCP contract tests inject a recording one.
 *
 * <p>Callable from any thread except where noted: the implementation hops to the main thread itself. Every method
 * throws {@link WorldRefusal} when the player is offline or the effect cannot be applied.
 */
public interface GodWorld {

    /** Whether the player is connected. */
    boolean isOnline(UUID player);

    /** Give {@code count} of {@code item} (parsed like {@code /give}, components allowed); overflow drops at the feet. */
    void giveItem(UUID player, String item, int count);

    /** Store a trade offer for {@code /accept} and show it to the player; refuses unknown items. */
    void offerTrade(UUID player, String giveItem, int giveAmount, String takeItem, int takeAmount);

    /** Strike the player with {@code strikes} lightning bolts. */
    void strike(UUID player, int strikes);

    /** Run {@code /weather <type> <seconds>} ({@code type} is already one of clear, rain, thunder). */
    void setWeather(UUID player, String type, int seconds);

    /** Spawn up to {@code count} entities at a block offset from the player; returns how many spawned. */
    int spawn(UUID player, String entity, int count, int dx, int dy, int dz, boolean griefing);

    /** Teleport the avatar in front of the player through the bridge and make it invulnerable. */
    void appear(UUID player, double distance, double height, boolean facePlayer);

    /** Send the avatar to its parking spot and make it mortal again. */
    void vanish(UUID player);

    /** A private chat line to the player (already prefixed). */
    void tell(UUID player, String line);

    /** A line spoken aloud by the avatar in public chat. */
    void speak(String line);

    /** Body choreography: {@code look} turns the avatar to the player; anything else is a bridge gesture. */
    void gesture(UUID player, String kind);

    /** The player snapshot JSON plus the recent chat log, read on the main thread. */
    String playerContext(UUID player);

    /** {@link QueryTerrain}'s ASCII relief map around the player (its own clamps apply). */
    String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius);
}
