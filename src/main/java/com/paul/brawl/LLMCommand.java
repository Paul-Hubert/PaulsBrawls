package com.paul.brawl;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.BoolArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class LLMCommand {

    private static final Logger LOGGER = LoggerFactory.getLogger("LLMCommand");

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<CommandSourceStack>literal("llm")
                    .requires(source -> source.hasPermission(2))
                    .executes(ctx -> {
                        printStatus(ctx.getSource());
                        return Command.SINGLE_SUCCESS;
                    })
                    .then(Commands.literal("provider")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .suggests((c, b) -> {
                                for (String name : LLMConfig.INSTANCE.providers.keySet()) {
                                    b.suggest(name);
                                }
                                return b.buildFuture();
                            })
                            .executes(ctx -> setActiveProvider(ctx.getSource(), StringArgumentType.getString(ctx, "name")))
                        )
                    )
                    .then(Commands.literal("model")
                        .then(Commands.argument("name", StringArgumentType.greedyString())
                            .executes(ctx -> setModel(ctx.getSource(), StringArgumentType.getString(ctx, "name")))
                        )
                    )
                    .then(Commands.literal("host")
                        .then(Commands.argument("host", StringArgumentType.greedyString())
                            .executes(ctx -> setHost(ctx.getSource(), StringArgumentType.getString(ctx, "host")))
                        )
                    )
                    .then(Commands.literal("port")
                        .then(Commands.argument("port", IntegerArgumentType.integer(1, 65535))
                            .executes(ctx -> setPort(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "port")))
                        )
                    )
                    .then(Commands.literal("apikey")
                        .then(Commands.argument("key", StringArgumentType.greedyString())
                            .executes(ctx -> setApiKey(ctx.getSource(), StringArgumentType.getString(ctx, "key")))
                        )
                    )
                    .then(Commands.literal("timeout")
                        .then(Commands.argument("seconds", IntegerArgumentType.integer(5, 1800))
                            .executes(ctx -> setTimeout(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "seconds")))
                        )
                    )
                    .then(Commands.literal("reload")
                        .executes(ctx -> {
                            ChatBot.reloadClients();
                            printStatus(ctx.getSource());
                            return Command.SINGLE_SUCCESS;
                        })
                    )
                    .then(Commands.literal("bridge")
                        .executes(ctx -> {
                            printBridgeStatus(ctx.getSource());
                            return Command.SINGLE_SUCCESS;
                        })
                        .then(Commands.literal("enabled")
                            .then(Commands.argument("on", BoolArgumentType.bool())
                                .executes(ctx -> setBridgeEnabled(ctx.getSource(), BoolArgumentType.getBool(ctx, "on")))
                            )
                        )
                        .then(Commands.literal("url")
                            .then(Commands.argument("url", StringArgumentType.greedyString())
                                .executes(ctx -> setBridgeUrl(ctx.getSource(), StringArgumentType.getString(ctx, "url")))
                            )
                        )
                        .then(Commands.literal("bot")
                            .then(Commands.argument("name", StringArgumentType.word())
                                .executes(ctx -> setBotUsername(ctx.getSource(), StringArgumentType.getString(ctx, "name")))
                            )
                        )
                        .then(Commands.literal("griefing")
                            .then(Commands.argument("on", BoolArgumentType.bool())
                                .executes(ctx -> setGriefing(ctx.getSource(), BoolArgumentType.getBool(ctx, "on")))
                            )
                        )
                        .then(Commands.literal("waitmax")
                            .then(Commands.argument("seconds", IntegerArgumentType.integer(1, 600))
                                .executes(ctx -> setWaitMax(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "seconds")))
                            )
                        )
                        .then(Commands.literal("spawnmax")
                            .then(Commands.argument("count", IntegerArgumentType.integer(1, 64))
                                .executes(ctx -> setSpawnMax(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "count")))
                            )
                        )
                        .then(Commands.literal("idle")
                            .then(Commands.argument("seconds", IntegerArgumentType.integer(5, 3600))
                                .executes(ctx -> setIdleTimeout(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "seconds")))
                            )
                        )
                    )
            );
        });
    }

    private static int setBridgeEnabled(CommandSourceStack source, boolean on) {
        BridgeConfig.INSTANCE.enabled = on;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setBridgeUrl(CommandSourceStack source, String url) {
        BridgeConfig.INSTANCE.bridgeUrl = url;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setBotUsername(CommandSourceStack source, String name) {
        BridgeConfig.INSTANCE.botUsername = name;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setGriefing(CommandSourceStack source, boolean on) {
        BridgeConfig.INSTANCE.creatureGriefingAllowed = on;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setWaitMax(CommandSourceStack source, int seconds) {
        BridgeConfig.INSTANCE.waitMaxSeconds = seconds;
        // Keep the idle watchdog strictly above the longest deliberate Wait.
        if (BridgeConfig.INSTANCE.idleTimeoutSeconds <= seconds) {
            BridgeConfig.INSTANCE.idleTimeoutSeconds = seconds + 30;
        }
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setSpawnMax(CommandSourceStack source, int count) {
        BridgeConfig.INSTANCE.spawnCountMax = count;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setIdleTimeout(CommandSourceStack source, int seconds) {
        if (seconds <= BridgeConfig.INSTANCE.waitMaxSeconds) {
            source.sendFailure(Component.literal("idle timeout must exceed waitMax (" + BridgeConfig.INSTANCE.waitMaxSeconds + "s)"));
            return 0;
        }
        BridgeConfig.INSTANCE.idleTimeoutSeconds = seconds;
        BridgeConfig.INSTANCE.save();
        printBridgeStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static void printBridgeStatus(CommandSourceStack source) {
        source.sendSuccess(() -> Component.literal(BridgeConfig.INSTANCE.describe()), false);
    }

    private static int setActiveProvider(CommandSourceStack source, String name) {
        if (!LLMConfig.INSTANCE.setProvider(name)) {
            source.sendFailure(Component.literal("Unknown provider: " + name + ". Available: " + LLMConfig.INSTANCE.providers.keySet()));
            return 0;
        }
        ChatBot.reloadClients();
        LOGGER.info("Switched LLM provider to {}", name);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setModel(CommandSourceStack source, String name) {
        LLMConfig.INSTANCE.active().model = name;
        LLMConfig.INSTANCE.save();
        LOGGER.info("Set {} model to {}", LLMConfig.INSTANCE.activeProvider, name);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setHost(CommandSourceStack source, String host) {
        LLMConfig.INSTANCE.active().host = host;
        LLMConfig.INSTANCE.save();
        ChatBot.reloadClients();
        LOGGER.info("Set {} host to {}", LLMConfig.INSTANCE.activeProvider, host);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setPort(CommandSourceStack source, int port) {
        LLMConfig.INSTANCE.active().port = port;
        LLMConfig.INSTANCE.save();
        ChatBot.reloadClients();
        LOGGER.info("Set {} port to {}", LLMConfig.INSTANCE.activeProvider, port);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static int setApiKey(CommandSourceStack source, String key) {
        LLMConfig.INSTANCE.active().apiKey = key;
        LLMConfig.INSTANCE.save();
        ChatBot.reloadClients();
        LOGGER.info("Updated {} API key", LLMConfig.INSTANCE.activeProvider);
        source.sendSuccess(() -> Component.literal("API key updated for " + LLMConfig.INSTANCE.activeProvider), false);
        return Command.SINGLE_SUCCESS;
    }

    private static int setTimeout(CommandSourceStack source, int seconds) {
        LLMConfig.INSTANCE.timeoutSeconds = seconds;
        LLMConfig.INSTANCE.save();
        // Cached OpenAiChatModel was built with the old timeout — rebuild it.
        ChatBot.reloadClients();
        LOGGER.info("Set LLM request timeout to {}s", seconds);
        printStatus(source);
        return Command.SINGLE_SUCCESS;
    }

    private static void printStatus(CommandSourceStack source) {
        var c = LLMConfig.INSTANCE;
        var p = c.active();
        StringBuilder sb = new StringBuilder();
        sb.append("LLM active provider: ").append(c.activeProvider).append(" | timeout=").append(c.timeoutSeconds).append("s\n");
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
        source.sendSuccess(() -> Component.literal(sb.toString()), false);
    }
}
