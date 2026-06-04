package com.paul.brawl;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.BoolArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class LLMCommand {

    private static final Logger LOGGER = LoggerFactory.getLogger("LLMCommand");

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("llm")
                    .requires(source -> source.hasPermissionLevel(2))
                    .executes(ctx -> {
                        printStatus(ctx.getSource());
                        return Command.SINGLE_SUCCESS;
                    })
                    .then(CommandManager.literal("provider")
                        .then(CommandManager.argument("name", StringArgumentType.word())
                            .suggests((c, b) -> {
                                for (String name : LLMConfig.INSTANCE.providers.keySet()) {
                                    b.suggest(name);
                                }
                                return b.buildFuture();
                            })
                            .executes(ctx -> setActiveProvider(ctx.getSource(), StringArgumentType.getString(ctx, "name")))
                        )
                    )
                    .then(CommandManager.literal("model")
                        .then(CommandManager.argument("name", StringArgumentType.greedyString())
                            .executes(ctx -> setModel(ctx.getSource(), StringArgumentType.getString(ctx, "name")))
                        )
                    )
                    .then(CommandManager.literal("host")
                        .then(CommandManager.argument("host", StringArgumentType.greedyString())
                            .executes(ctx -> setHost(ctx.getSource(), StringArgumentType.getString(ctx, "host")))
                        )
                    )
                    .then(CommandManager.literal("port")
                        .then(CommandManager.argument("port", IntegerArgumentType.integer(1, 65535))
                            .executes(ctx -> setPort(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "port")))
                        )
                    )
                    .then(CommandManager.literal("apikey")
                        .then(CommandManager.argument("key", StringArgumentType.greedyString())
                            .executes(ctx -> setApiKey(ctx.getSource(), StringArgumentType.getString(ctx, "key")))
                        )
                    )
                    .then(CommandManager.literal("reload")
                        .executes(ctx -> {
                            ChatBot.reloadClients();
                            printStatus(ctx.getSource());
                            return Command.SINGLE_SUCCESS;
                        })
                    )
                    .then(CommandManager.literal("bridge")
                        .executes(ctx -> {
                            printBridgeStatus(ctx.getSource());
                            return Command.SINGLE_SUCCESS;
                        })
                        .then(CommandManager.literal("enabled")
                            .then(CommandManager.argument("on", BoolArgumentType.bool())
                                .executes(ctx -> setBridgeEnabled(ctx.getSource(), BoolArgumentType.getBool(ctx, "on")))
                            )
                        )
                        .then(CommandManager.literal("url")
                            .then(CommandManager.argument("url", StringArgumentType.greedyString())
                                .executes(ctx -> setBridgeUrl(ctx.getSource(), StringArgumentType.getString(ctx, "url")))
                            )
                        )
                        .then(CommandManager.literal("bot")
                            .then(CommandManager.argument("name", StringArgumentType.word())
                                .executes(ctx -> setBotUsername(ctx.getSource(), StringArgumentType.getString(ctx, "name")))
                            )
                        )
                        .then(CommandManager.literal("griefing")
                            .then(CommandManager.argument("on", BoolArgumentType.bool())
                                .executes(ctx -> setGriefing(ctx.getSource(), BoolArgumentType.getBool(ctx, "on")))
                            )
                        )
                        .then(CommandManager.literal("waitmax")
                            .then(CommandManager.argument("seconds", IntegerArgumentType.integer(1, 600))
                                .executes(ctx -> setWaitMax(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "seconds")))
                            )
                        )
                        .then(CommandManager.literal("spawnmax")
                            .then(CommandManager.argument("count", IntegerArgumentType.integer(1, 64))
                                .executes(ctx -> setSpawnMax(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "count")))
                            )
                        )
                        .then(CommandManager.literal("idle")
                            .then(CommandManager.argument("seconds", IntegerArgumentType.integer(5, 3600))
                                .executes(ctx -> setIdleTimeout(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "seconds")))
                            )
                        )
                    )
            );
        });
    }

    private static int setBridgeEnabled(ServerCommandSource source, boolean on) {
        BridgeConfig.INSTANCE.enabled = on;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setBridgeUrl(ServerCommandSource source, String url) {
        BridgeConfig.INSTANCE.bridgeUrl = url;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setBotUsername(ServerCommandSource source, String name) {
        BridgeConfig.INSTANCE.botUsername = name;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setGriefing(ServerCommandSource source, boolean on) {
        BridgeConfig.INSTANCE.creatureGriefingAllowed = on;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setWaitMax(ServerCommandSource source, int seconds) {
        BridgeConfig.INSTANCE.waitMaxSeconds = seconds;
        // Keep the idle watchdog strictly above the longest deliberate Wait.
        if (BridgeConfig.INSTANCE.idleTimeoutSeconds <= seconds) {
            BridgeConfig.INSTANCE.idleTimeoutSeconds = seconds + 30;
        }
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setSpawnMax(ServerCommandSource source, int count) {
        BridgeConfig.INSTANCE.spawnCountMax = count;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setIdleTimeout(ServerCommandSource source, int seconds) {
        if (seconds <= BridgeConfig.INSTANCE.waitMaxSeconds) {
            source.sendError(Text.literal("idle timeout must exceed waitMax (" + BridgeConfig.INSTANCE.waitMaxSeconds + "s)"));
            return 0;
        }
        BridgeConfig.INSTANCE.idleTimeoutSeconds = seconds;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static void printBridgeStatus(ServerCommandSource source) {
        source.sendFeedback(() -> Text.literal(BridgeConfig.INSTANCE.describe()), false);
    }

    private static int setActiveProvider(ServerCommandSource source, String name) {
        if (!LLMConfig.INSTANCE.setProvider(name)) {
            source.sendError(Text.literal("Unknown provider: " + name + ". Available: " + LLMConfig.INSTANCE.providers.keySet()));
            return 0;
        }
        ChatBot.reloadClients();
        LOGGER.info("Switched LLM provider to {}", name);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setModel(ServerCommandSource source, String name) {
        LLMConfig.INSTANCE.active().model = name;
        LLMConfig.INSTANCE.save();
        LOGGER.info("Set {} model to {}", LLMConfig.INSTANCE.activeProvider, name);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setHost(ServerCommandSource source, String host) {
        LLMConfig.INSTANCE.active().host = host;
        LLMConfig.INSTANCE.save();
        ChatBot.reloadClients();
        LOGGER.info("Set {} host to {}", LLMConfig.INSTANCE.activeProvider, host);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setPort(ServerCommandSource source, int port) {
        LLMConfig.INSTANCE.active().port = port;
        LLMConfig.INSTANCE.save();
        ChatBot.reloadClients();
        LOGGER.info("Set {} port to {}", LLMConfig.INSTANCE.activeProvider, port);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setApiKey(ServerCommandSource source, String key) {
        LLMConfig.INSTANCE.active().apiKey = key;
        LLMConfig.INSTANCE.save();
        ChatBot.reloadClients();
        LOGGER.info("Updated {} API key", LLMConfig.INSTANCE.activeProvider);
        source.sendFeedback(() -> Text.literal("API key updated for " + LLMConfig.INSTANCE.activeProvider), false);
        return Command.SINGLE_SUCCESS;
    }

    private static void printStatus(ServerCommandSource source) {
        var c = LLMConfig.INSTANCE;
        var p = c.active();
        StringBuilder sb = new StringBuilder();
        sb.append("LLM active provider: ").append(c.activeProvider).append("\n");
        for (var entry : c.providers.entrySet()) {
            String marker = entry.getKey().equals(c.activeProvider) ? "* " : "  ";
            var s = entry.getValue();
            sb.append(marker)
              .append(entry.getKey())
              .append(" -> ")
              .append(s.baseUrl())
              .append(" | model=").append(s.model)
              .append(" | apikey=").append(s.apiKey == null || s.apiKey.isEmpty() ? "<env>" : "<set>")
              .append("\n");
        }
        sb.append("Active baseUrl: ").append(p.baseUrl());
        source.sendFeedback(() -> Text.literal(sb.toString()), false);
    }
}
