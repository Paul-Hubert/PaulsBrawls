package com.paul.brawl;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.command.argument.TextArgumentType;
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
    }

    // chat with god
    public static void chatCommand() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("chat")
                    .requires(source -> source.hasPermissionLevel(0)) // Admin only
                    .then(CommandManager.argument("text", TextArgumentType.text(registryAccess))
                    .executes(context -> {
                        Text input = TextArgumentType.getTextArgument(context, "text");
                        onChatCommand(context.getSource(), input.getString());
                        return Command.SINGLE_SUCCESS;
                    })
            ));
        });

    }

    public static void onChatCommand(ServerCommandSource source, String input) {
        
        ChatPrinter.broadcast(source.getPlayer().getName().getString() + " : " + input);
        
        ChatBot.sendChatRequest(input, source.getPlayer(), (r, text) -> {
            ChatPrinter.broadcast("God : " + text);
        });
        
    }


    public static void registerPromptCommand() {

        // /gib_salary amount
        // Gives everyone money every period
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("prompt")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("text", TextArgumentType.text(registryAccess))
                        .executes(context -> {

                            Text text = TextArgumentType.getTextArgument(context, "text");

                            ChatBot.prompt = text.getString();

                            LOGGER.info("Changed prompt " + text);
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
                            Text text = Text.literal("Hardcoded prompt : ").append(ChatBot.hardcodedPrompt).append("\nCustom Prompt : ").append(ChatBot.prompt);
                            context.getSource().getPlayer().sendMessage(text);
                            return Command.SINGLE_SUCCESS;
                        })
                    );
        });
    }

    

}
