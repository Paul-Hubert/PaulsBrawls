package com.paul.brawl;

import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.filter.FilteredMessage;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.registry.RegistryKey;
import net.minecraft.network.message.MessageType;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.text.Text;

import java.util.LinkedList;
import java.util.List;

public class ChatMessageHistory {
    private static final int MAX_HISTORY = 200;
    private static final LinkedList<String> messageHistory = new LinkedList<>();

    public static void register() {
        ServerMessageEvents.CHAT_MESSAGE.register(ChatMessageHistory::onChatMessage);
        ServerMessageEvents.COMMAND_MESSAGE.register(ChatMessageHistory::onCommandMessage);
        ServerMessageEvents.GAME_MESSAGE.register(ChatMessageHistory::onGameMessage);
    }

    private static void addMessageToHistory(String content) {
        synchronized (messageHistory) {
            if (messageHistory.size() >= MAX_HISTORY) {
                messageHistory.removeFirst();
            }
            messageHistory.addLast(content);
        }
    }

    private static void onChatMessage(SignedMessage message, ServerPlayerEntity sender, MessageType.Parameters parameters) {
        String content = message.getContent().getString();
        addMessageToHistory(sender.getName().getString() + " : " + content);
    }

    private static void onCommandMessage(SignedMessage message, ServerCommandSource source, MessageType.Parameters parameters) {
        String content = message.getContent().getString();
        addMessageToHistory(source.getPlayer().getName().getString() + " command : " + content);
    }

    private static void onGameMessage(MinecraftServer server, Text text, boolean flag) {
        String content = text.getString();
        addMessageToHistory("Game : " + content);
    }

    public static String getHistory() {
        synchronized (messageHistory) {
            String message = messageHistory.stream().reduce("", (a, b) -> a + "\n" + b);
            return message;
        }
    }
} 