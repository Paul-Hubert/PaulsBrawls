package com.paul.brawl;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.command.argument.MessageArgumentType;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ChatCommand {
    private static final Logger LOGGER = LoggerFactory.getLogger("ChatCommand");

    public static void register() {
        chatCommand();
        registerPromptCommand();
        registerKillSwitch();
    }

    // chat with god
    public static void chatCommand() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("pray")
                    .requires(source -> source.hasPermissionLevel(0)) // Open to everyone
                    .then(CommandManager.literal("stop")
                        .executes(context -> {
                            // Player can end their own active session.
                            var player = context.getSource().getPlayer();
                            if (player != null && GodSessionManager.isActive(player)) {
                                ChatBot.endPrayerSession(player);
                                ChatPrinter.sendMessage(player, "Dieu : (la séance est close.)");
                            }
                            return Command.SINGLE_SUCCESS;
                        })
                    )
                    .then(CommandManager.argument("text", MessageArgumentType.message())
                        .executes(context -> {
                            Text input = MessageArgumentType.getMessage(context, "text");
                            onChatCommand(context.getSource(), input.getString());
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });

    }

    /**
     * Admin kill-switch — force-end whatever session is live, drop everything
     * pending, and (re)stop the bridge until re-enabled.
     */
    public static void registerKillSwitch() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("godbody")
                    .requires(source -> source.hasPermissionLevel(2))
                    .then(CommandManager.literal("off")
                        .executes(ctx -> {
                            int dropped = GodActionQueue.clear();
                            // Bug #5: commands run on the server thread, so restore directly —
                            // the queue that would have carried restoreAvatar was just cleared.
                            ChatBotActions.restoreAvatarOnMain(ctx.getSource().getServer());
                            BuildGuard.cancelAll(); // bug #7: sub-builds stop at their next turn
                            GodBody.vanish();
                            GodSessionManager.forceEndSession();
                            BridgeConfig.INSTANCE.enabled = false;
                            BridgeConfig.INSTANCE.save();
                            ctx.getSource().sendFeedback(
                                () -> Text.literal("Killed god-body: " + dropped + " queued action(s) dropped, session released, bridge disabled."),
                                true);
                            return Command.SINGLE_SUCCESS;
                        })
                    )
                    .then(CommandManager.literal("on")
                        .executes(ctx -> {
                            BridgeConfig.INSTANCE.enabled = true;
                            BridgeConfig.INSTANCE.save();
                            ctx.getSource().sendFeedback(() -> Text.literal("Bridge re-enabled."), true);
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });
    }

    public static void onChatCommand(ServerCommandSource source, String input) {

        try {
            var player = source.getPlayer();
            ChatPrinter.sendMessage(player, player.getName().getString() + " : " + input);

            // Try to claim the single shared avatar. If another player owns it,
            // serve the prayer bodiless (text only — God still answers, but the
            // bot won't manifest). If the claim succeeds, the LLM gets to call
            // Appear when it chooses; we never auto-teleport here.
            boolean owned = GodSessionManager.claim(player);
            if (!owned) {
                ChatPrinter.sendMessage(player, "Dieu : (occupé ailleurs — je t'écoute, mais sans forme.)");
            }

            ChatBot.godBot.sendChatRequest(input, player);
        } catch(Exception e) {
            LOGGER.error(e.toString());
            e.printStackTrace();
        }


    }


    public static void registerPromptCommand() {

        // /prompt text
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("prompt")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("text", MessageArgumentType.message())
                        .executes(context -> {
                            Text text = MessageArgumentType.getMessage(context, "text");

                            ChatBot.godBot.prompt = text.getString();
                            ChatBot.buildBot.prompt = text.getString();

                            var message = "Changed prompt " + text;
                            ChatPrinter.sendMessage(context.getSource().getPlayer(), message);
                            LOGGER.info(message);
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("prompt")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                        .executes(context -> {
                            ChatBot.godBot.readPrompt();
                            ChatBot.buildBot.readPrompt();
                            Text text = Text.literal("Hardcoded prompt : ").append(ChatBot.godBot.hardcodedPrompt).append("\nCustom Prompt : ").append(ChatBot.godBot.prompt);
                            context.getSource().getPlayer().sendMessage(text);
                            return Command.SINGLE_SUCCESS;
                        })
                    );
        });
    }

    

}
