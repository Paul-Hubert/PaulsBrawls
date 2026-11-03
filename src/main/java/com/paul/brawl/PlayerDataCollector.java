package com.paul.brawl;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.scores.Scoreboard;

public class PlayerDataCollector {

    public static JsonObject collect(ServerPlayer player) {
        JsonObject data = new JsonObject();

        // 📛 Player name
        data.addProperty("name", player.getName().getString());

        // 📍 Position and dimension
        BlockPos pos = player.blockPosition();
        data.addProperty("x", pos.getX());
        data.addProperty("y", pos.getY());
        data.addProperty("z", pos.getZ());
        data.addProperty("dimension", player.level().dimension().location().toString());

        // ❤️ Health and ⚡️XP
        data.addProperty("health", player.getHealth());
        data.addProperty("xp_level", player.experienceLevel);

        // 🎒 Inventory
        JsonArray inventory = new JsonArray();
        for (ItemStack item : player.getInventory().items) {
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
        for (MobEffectInstance effect : player.getActiveEffects()) {
            JsonObject eff = new JsonObject();
            eff.addProperty("effect", effect.getEffect().toString());
            eff.addProperty("duration", effect.getDuration());
            eff.addProperty("amplifier", effect.getAmplifier());
            effects.add(eff);
        }
        data.add("effects", effects);

        // 🏷️ Tags
        JsonArray tags = new JsonArray();
        for (String tag : player.getTags()) {
            tags.add(tag);
        }
        data.add("tags", tags);

        // 📊 Scoreboard (if used for quests)
        JsonObject scores = new JsonObject();
        Scoreboard scoreboard = player.getScoreboard();
        scoreboard.getObjectiveNames().forEach(objective -> {
            var obj = scoreboard.getObjective(objective);
            if (obj != null) {
                var score = scoreboard.getPlayerScoreInfo(player, obj);
                if (score != null) {
                    scores.addProperty(objective, score.value());
                }
            }
        });
        data.add("scores", scores);

        // ☀️ Time and weather
        if (player.level() instanceof ServerLevel sw) {
            JsonObject worldData = new JsonObject();
            worldData.addProperty("time", sw.getDayTime());
            worldData.addProperty("is_raining", sw.isRaining());
            worldData.addProperty("is_thundering", sw.isThundering());
            data.add("world", worldData);
        }
        
        return data;
    }
} 