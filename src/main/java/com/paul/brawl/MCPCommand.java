package com.paul.brawl;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

/**
 * Admin command surface for {@link MCPGateway}.
 *
 * <ul>
 *   <li>{@code /mcp} — print one-line status (permission level 0 — diagnostic).</li>
 *   <li>{@code /mcp status} — alias for {@code /mcp}.</li>
 *   <li>{@code /mcp reload} — tear down the MCP client, drop the cached spec list,
 *       reconnect now (off the server thread; the status is printed when it is done). Permission level 2 — destructive in that any in-flight
 *       prayer's cached tool set is invalidated.</li>
 * </ul>
 *
 * <p>The gateway itself auto-reconnects with backoff
 * ({@link MCPGateway#RECONNECT_BACKOFF_MS}), so {@code /mcp reload} is only
 * needed when the admin wants to refresh the tool LIST (e.g. after adding a new
 * tool on the Node side) or to skip the backoff window.
 */
public class MCPCommand {

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("mcp")
                    .executes(ctx -> {
                        printStatus(ctx.getSource());
                        return Command.SINGLE_SUCCESS;
                    })
                    .then(CommandManager.literal("status")
                        .executes(ctx -> {
                            printStatus(ctx.getSource());
                            return Command.SINGLE_SUCCESS;
                        })
                    )
                    .then(CommandManager.literal("reload")
                        .requires(source -> source.hasPermissionLevel(2))
                        .executes(ctx -> {
                            // Bug #18: reload() tears down the client and re-handshakes over HTTP/SSE — on the
                            // server thread that froze the tick for the whole connect timeout. Run it on the LLM
                            // worker pool and report back on the server thread when it is done.
                            ServerCommandSource source = ctx.getSource();
                            source.sendFeedback(() -> Text.literal("MCP: rechargement en cours…"), false);
                            LLMConfig.INSTANCE.sharedExecutor().execute(() -> {
                                MCPGateway.INSTANCE.reload();
                                source.getServer().execute(() -> printStatus(source));
                            });
                            return Command.SINGLE_SUCCESS;
                        })
                    )
            );
        });
    }

    private static void printStatus(ServerCommandSource source) {
        source.sendFeedback(() -> Text.literal(MCPGateway.INSTANCE.status()), false);
    }
}
