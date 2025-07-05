package com.paul.brawl;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.entity.effect.StatusEffectInstance;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.scoreboard.Scoreboard;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.item.ItemStack;

public class PlayerDataCollector {

    public static JsonObject collect(ServerPlayerEntity player) {
        JsonObject data = new JsonObject();

        // 📛 Player name
        data.addProperty("name", player.getName().getString());

        // 📍 Position and dimension
        BlockPos pos = player.getBlockPos();
        data.addProperty("x", pos.getX());
        data.addProperty("y", pos.getY());
        data.addProperty("z", pos.getZ());
        data.addProperty("dimension", player.getWorld().getRegistryKey().getValue().toString());

        // ❤️ Health and ⚡️XP
        data.addProperty("health", player.getHealth());
        data.addProperty("xp_level", player.experienceLevel);

        // 🎒 Inventory
        JsonArray inventory = new JsonArray();
        for (ItemStack item : player.getInventory().main) {
            if (!item.isEmpty()) {
                JsonObject itemJson = new JsonObject();
                itemJson.addProperty("item", item.getItem().toString());
                itemJson.addProperty("count", item.getCount());
                inventory.add(itemJson);
            }
        }
        data.add("inventory", inventory);

        // 🧪 Potion effects
        JsonArray effects = new JsonArray();
        for (StatusEffectInstance effect : player.getStatusEffects()) {
            JsonObject eff = new JsonObject();
            eff.addProperty("effect", effect.getEffectType().toString());
            eff.addProperty("duration", effect.getDuration());
            eff.addProperty("amplifier", effect.getAmplifier());
            effects.add(eff);
        }
        data.add("effects", effects);

        // 🏷️ Tags
        JsonArray tags = new JsonArray();
        for (String tag : player.getCommandTags()) {
            tags.add(tag);
        }
        data.add("tags", tags);

        // 📊 Scoreboard (if used for quests)
        JsonObject scores = new JsonObject();
        Scoreboard scoreboard = player.getScoreboard();
        scoreboard.getObjectiveNames().forEach(objective -> {
            var obj = scoreboard.getNullableObjective(objective);
            if (obj != null) {
                var score = scoreboard.getScore(player, obj);
                if (score != null) {
                    scores.addProperty(objective, score.getScore());
                }
            }
        });
        data.add("scores", scores);

        // ☀️ Time and weather
        if (player.getWorld() instanceof ServerWorld sw) {
            JsonObject worldData = new JsonObject();
            worldData.addProperty("time", sw.getTimeOfDay());
            worldData.addProperty("is_raining", sw.isRaining());
            worldData.addProperty("is_thundering", sw.isThundering());
            data.add("world", worldData);
        }
        
        return data;
    }
} 