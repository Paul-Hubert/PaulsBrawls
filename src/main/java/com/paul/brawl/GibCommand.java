package com.paul.brawl;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class GibCommand {

    private static final Logger LOGGER = LoggerFactory.getLogger("GibCommand");
    
    public static void register() {
        // /gib amount
        // Gives everyone money
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("gib")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("amount", IntegerArgumentType.integer())
                        .executes(context -> {

                            int amount = IntegerArgumentType.getInteger(context, "amount");
                           
                            MinecraftServer server = context.getSource().getServer();
                            PlayerPersistentState state = PlayerPersistentState.getState(server);
                            var val = state.getGlobalValue(RevenueManager.TOTAL_REVENUE_KEY);
                            // Increment by given amount
                            val += amount;
                            state.setGlobalValue(RevenueManager.TOTAL_REVENUE_KEY, val);
                            
                            RevenueManager.UpdateRevenueAll(server);
                            LOGGER.info("gibbed " + amount);
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });




        // /gib_salary amount
        // Gives everyone money every period
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("gib_salary")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("amount", IntegerArgumentType.integer())
                        .executes(context -> {

                            int amount = IntegerArgumentType.getInteger(context, "amount");
                           
                            var server = context.getSource().getServer();
                            PlayerPersistentState state = PlayerPersistentState.getState(server);
                            
                            state.setGlobalValue(SalaryScheduler.SALARY_KEY, amount);

                            LOGGER.info("gibbed salary " + amount);
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });

        // /gib_salary_period amount
        // Gives everyone money at this period seconds
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("gib_salary_period")
                    .requires(source -> source.hasPermissionLevel(2)) // Admin only
                    .then(CommandManager.argument("amount", IntegerArgumentType.integer( 1))
                        .executes(context -> {

                            int amount = IntegerArgumentType.getInteger(context, "amount");
                           
                            var server = context.getSource().getServer();
                            PlayerPersistentState state = PlayerPersistentState.getState(server);
                            
                            state.setGlobalValue(SalaryScheduler.SALARY_PERIOD_KEY, amount);
                            SalaryScheduler.restart(server);

                            LOGGER.info("gibbed salary period " + amount);
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });
    }
}