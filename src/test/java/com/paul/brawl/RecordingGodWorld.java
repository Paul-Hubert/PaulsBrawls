package com.paul.brawl;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * A {@link GodWorld} that records what reached it. It stands in for Minecraft only — the rules under test
 * ({@link GodService}, the MCP servers) are the real code. Known item/entity ids and online players are explicit, so
 * a refusal the real world would raise is raised here for the same reason.
 */
class RecordingGodWorld implements GodWorld {

    final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    final Set<UUID> online = Collections.synchronizedSet(new HashSet<>());
    final Set<String> knownItems = new HashSet<>(Set.of("minecraft:diamond", "diamond", "minecraft:dirt",
        "minecraft:enchanted_book[minecraft:enchantments={levels:{\"minecraft:sharpness\":5}}]"));
    final Set<String> knownEntities = new HashSet<>(Set.of("minecraft:zombie", "minecraft:cow"));

    private void need(UUID player) {
        if (!online.contains(player)) throw new WorldRefusal(MinecraftBuildWorld.OFFLINE);
    }

    @Override public boolean isOnline(UUID player) { return online.contains(player); }

    @Override public void giveItem(UUID player, String item, int count) {
        need(player);
        if (!knownItems.contains(item)) {
            throw new WorldRefusal("Reward cancelled, item " + item + " does not exist or is malformed, please try again.");
        }
        calls.add("give " + item + " x" + count);
    }

    @Override public void offerTrade(UUID player, String giveItem, int giveAmount, String takeItem, int takeAmount) {
        need(player);
        if (!knownItems.contains(giveItem)) throw new WorldRefusal("Trade cancelled. " + giveItem + " was not a correct item. Please try again.");
        if (!knownItems.contains(takeItem)) throw new WorldRefusal("Trade cancelled. " + takeItem + " was not a correct item. Please try again.");
        calls.add("trade " + giveAmount + " " + giveItem + " for " + takeAmount + " " + takeItem);
    }

    @Override public void strike(UUID player, int strikes) { need(player); calls.add("strike x" + strikes); }

    @Override public void setWeather(UUID player, String type, int seconds) { need(player); calls.add("weather " + type + " " + seconds); }

    @Override public int spawn(UUID player, String entity, int count, int dx, int dy, int dz, boolean griefing) {
        need(player);
        if (!knownEntities.contains(entity)) throw new WorldRefusal("Spawn annulé : type d'entité inconnu '" + entity + "'.");
        calls.add("spawn " + entity + " x" + count + " at " + dx + "," + dy + "," + dz + (griefing ? " grief" : ""));
        return count;
    }

    @Override public void appear(UUID player, double distance, double height, boolean facePlayer) {
        need(player);
        calls.add("appear " + distance + " " + height + " " + facePlayer);
    }

    @Override public void vanish(UUID player) { calls.add("vanish"); }

    @Override public void tell(UUID player, String line) { need(player); calls.add("tell " + line); }

    @Override public void speak(String line) { calls.add("speak " + line); }

    @Override public void gesture(UUID player, String kind) { calls.add("gesture " + kind); }

    @Override public String playerContext(UUID player) { need(player); calls.add("context"); return "{\"name\":\"Alice\"}"; }

    @Override public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        need(player);
        calls.add("terrain " + centerX + " " + centerZ + " " + radius);
        return "terrain-map";
    }
}
