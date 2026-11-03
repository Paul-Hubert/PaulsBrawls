package com.paul.brawl;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

public class ChatPrinter {
    private static final Queue<String> messageBuffer = new ConcurrentLinkedQueue<>();
    private static boolean registered = false;

    public static void broadcast(String text) {
        messageBuffer.add(text);
        if (!registered) {
            ServerTickEvents.START_SERVER_TICK.register(server -> {
                while (!messageBuffer.isEmpty()) {
                    String msg = messageBuffer.poll();
                    server.getPlayerList().broadcastSystemMessage(
                        net.minecraft.network.chat.Component.literal(msg),
                        false
                    );
                }
            });
            registered = true;
        }
    }

    public static void sendMessage(ServerPlayer player, String text) {
        player.sendSystemMessage(Component.literal(text));

    }

}
