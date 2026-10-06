package com.paul.brawl;

import java.util.UUID;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

/**
 * The real {@link GodWorld}: every effect resolves the player by UUID and runs on the main thread through
 * {@link MainThread}; bridge calls (the avatar) stay fire-and-forget as before.
 */
public final class MinecraftGodWorld implements GodWorld {

    private static ServerPlayerEntity online(UUID player) {
        return MinecraftBuildWorld.online(player);
    }

    @Override
    public boolean isOnline(UUID player) {
        return MainThread.call(() -> {
            MinecraftServer server = ChatBotActions.server();
            return server != null && player != null && server.getPlayerManager().getPlayer(player) != null;
        });
    }

    @Override
    public void giveItem(UUID player, String item, int count) {
        MainThread.run(() -> ChatBotActions.giveItemStacks(online(player), item, count));
    }

    @Override
    public void offerTrade(UUID player, String giveItem, int giveAmount, String takeItem, int takeAmount) {
        MainThread.run(() -> ChatBotActions.sendTradeOffer(online(player), giveItem, giveAmount, takeItem, takeAmount));
    }

    @Override
    public void strike(UUID player, int strikes) {
        MainThread.run(() -> ChatBotActions.smite(online(player), strikes));
    }

    @Override
    public void setWeather(UUID player, String type, int seconds) {
        MainThread.run(() -> ChatBotActions.changeWeather(online(player), type, seconds));
    }

    @Override
    public int spawn(UUID player, String entity, int count, int dx, int dy, int dz, boolean griefing) {
        return MainThread.call(() -> ChatBotActions.spawnCreature(online(player), entity, count, dx, dy, dz, griefing));
    }

    @Override
    public void appear(UUID player, double distance, double height, boolean facePlayer) {
        MainThread.run(() -> {
            ServerPlayerEntity p = online(player);
            GodBody.appear(p, distance, height, facePlayer); // bridge, async
            ChatBotActions.buffAvatar(p);
        });
    }

    @Override
    public void vanish(UUID player) {
        GodBody.vanish(); // bridge first: a stalled main thread must not keep the body in front of the player
        MainThread.run(() -> ChatBotActions.restoreAvatar(null)); // null → the avatar is looked up on the live server
    }

    @Override
    public void tell(UUID player, String line) {
        MainThread.run(() -> ChatPrinter.sendMessage(online(player), line));
    }

    @Override
    public void speak(String line) {
        GodBody.say(line);
    }

    @Override
    public void gesture(UUID player, String kind) {
        if ("look".equals(kind)) {
            MainThread.run(() -> GodBody.lookAt(online(player)));
        } else {
            GodBody.gesture(kind);
        }
    }

    @Override
    public String playerContext(UUID player) {
        return MainThread.call(() -> "Joueur (JSON) :\n" + PlayerDataCollector.collect(online(player))
            + "\n\nHistorique du chat, des commandes et des messages du jeu :\n" + ChatMessageHistory.getHistory());
    }

    @Override
    public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        return terrain(player, centerX, centerZ, radius);
    }

    static String terrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        QueryTerrain q = new QueryTerrain();
        q.centerX = centerX;
        q.centerZ = centerZ;
        q.radius = radius;
        return MainThread.call(() -> q.execute(online(player)));
    }
}
