package com.paul.brawl;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
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
                    server.getPlayerManager().broadcast(
                        net.minecraft.text.Text.literal(msg),
                        false
                    );
                }
            });
            registered = true;
        }
    }
}
