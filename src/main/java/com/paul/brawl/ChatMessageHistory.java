package com.paul.brawl;

import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import java.util.LinkedList;

public class ChatMessageHistory {
    private static final int MAX_HISTORY = 40;
    private static final LinkedList<String> messageHistory = new LinkedList<>();

    public static void register() {
        ServerMessageEvents.CHAT_MESSAGE.register(ChatMessageHistory::onChatMessage);
        ServerMessageEvents.COMMAND_MESSAGE.register(ChatMessageHistory::onCommandMessage);
        ServerMessageEvents.GAME_MESSAGE.register(ChatMessageHistory::onGameMessage);
    }

    public static void addMessageToHistory(String content) {
        synchronized (messageHistory) {
            if (messageHistory.size() >= MAX_HISTORY) {
                messageHistory.removeFirst();
            }
            messageHistory.addLast(content);
        }
    }

    private static void onChatMessage(PlayerChatMessage message, ServerPlayer sender, ChatType.Bound parameters) {
        String content = message.decoratedContent().getString();
        addMessageToHistory(sender.getName().getString() + " : " + content);
    }

    private static void onCommandMessage(PlayerChatMessage message, CommandSourceStack source, ChatType.Bound parameters) {
        String content = message.decoratedContent().getString();
        // Bug #18: a console /say or /me has no player — source.getName() is "Server" there.
        addMessageToHistory(source.getTextName() + " command : " + content);
    }

    private static void onGameMessage(MinecraftServer server, Component text, boolean flag) {
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