package com.paul.brawl;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Admin surface for the AI village:
 *
 *   /village status  — query the Node village process's admin API
 *   /village pause   — stop the village's LLM scheduling (reflexes keep running)
 *   /village resume
 *   /village on|off  — enable/disable this mod's trade-settlement listener
 *
 * All HTTP is async; feedback hops back to the main thread via server.execute.
 */
public class VillageCommand {

    private static final Logger LOGGER = LoggerFactory.getLogger("VillageCommand");
    private static final Gson GSON = new Gson();

    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build();

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("village")
                    .requires(source -> source.hasPermissionLevel(2))
                    .then(CommandManager.literal("status").executes(ctx -> {
                        fetchStatus(ctx.getSource());
                        return Command.SINGLE_SUCCESS;
                    }))
                    .then(CommandManager.literal("pause").executes(ctx -> {
                        post(ctx.getSource(), "/village/pause", "Village LLM scheduling paused.");
                        return Command.SINGLE_SUCCESS;
                    }))
                    .then(CommandManager.literal("resume").executes(ctx -> {
                        post(ctx.getSource(), "/village/resume", "Village LLM scheduling resumed.");
                        return Command.SINGLE_SUCCESS;
                    }))
                    .then(CommandManager.literal("on").executes(ctx -> {
                        VillageConfig.INSTANCE.enabled = true;
                        VillageConfig.INSTANCE.save();
                        VillageHttpListener.start(ctx.getSource().getServer());
                        ctx.getSource().sendFeedback(() -> Text.literal(
                            "Village settlement listener enabled (" + VillageConfig.INSTANCE.describe() + ")"), true);
                        return Command.SINGLE_SUCCESS;
                    }))
                    .then(CommandManager.literal("off").executes(ctx -> {
                        VillageConfig.INSTANCE.enabled = false;
                        VillageConfig.INSTANCE.save();
                        VillageHttpListener.stop();
                        ctx.getSource().sendFeedback(() -> Text.literal("Village settlement listener disabled."), true);
                        return Command.SINGLE_SUCCESS;
                    }))
                    .executes(ctx -> {
                        ctx.getSource().sendFeedback(() -> Text.literal(
                            VillageConfig.INSTANCE.describe()
                            + " listener=" + (VillageHttpListener.isRunning() ? "RUNNING" : "stopped")), false);
                        return Command.SINGLE_SUCCESS;
                    })
            );
        });
    }

    private static void fetchStatus(ServerCommandSource source) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(VillageConfig.INSTANCE.nodeAdminUrl + "/village/status"))
            .timeout(Duration.ofSeconds(4))
            .GET()
            .build();
        HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString())
            .handle((resp, ex) -> {
                String message;
                if (ex != null || resp.statusCode() >= 300) {
                    message = "Village process unreachable at " + VillageConfig.INSTANCE.nodeAdminUrl
                        + (ex != null ? " (" + ex.getMessage() + ")" : " (HTTP " + resp.statusCode() + ")")
                        + " — is `npm run village` running?";
                } else {
                    message = summarizeStatus(resp.body());
                }
                final String finalMessage = message;
                source.getServer().execute(() ->
                    source.sendFeedback(() -> Text.literal(finalMessage), false));
                return null;
            });
    }

    private static String summarizeStatus(String json) {
        try {
            JsonObject root = GSON.fromJson(json, JsonObject.class);
            StringBuilder sb = new StringBuilder("Village: ");
            JsonObject scheduler = root.getAsJsonObject("scheduler");
            if (scheduler != null) {
                sb.append("LLM ").append(scheduler.get("paused").getAsBoolean() ? "PAUSED" : "active")
                  .append(" (inFlight ").append(scheduler.get("inFlight").getAsInt())
                  .append(", pending ").append(scheduler.get("pending").getAsInt())
                  .append(", done ").append(scheduler.get("completed").getAsInt()).append(")");
            }
            sb.append(", conversations: ").append(root.has("conversations") ? root.get("conversations").getAsInt() : 0);
            JsonArray bots = root.getAsJsonArray("bots");
            if (bots != null) {
                for (var element : bots) {
                    JsonObject bot = element.getAsJsonObject();
                    sb.append("\n  ").append(bot.get("name").getAsString())
                      .append(" (").append(bot.get("role").getAsString()).append(") ")
                      .append(bot.get("state").getAsString());
                    if (!bot.get("job").isJsonNull()) {
                        sb.append(", job: ").append(bot.get("job").getAsString());
                    }
                    if (bot.get("inConversation").getAsBoolean()) {
                        sb.append(", talking");
                    }
                }
            }
            return sb.toString();
        } catch (Exception e) {
            LOGGER.warn("Failed to parse village status: {}", e.getMessage());
            return "Village status (raw): " + json.substring(0, Math.min(json.length(), 400));
        }
    }

    private static void post(ServerCommandSource source, String path, String successMessage) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(VillageConfig.INSTANCE.nodeAdminUrl + path))
            .timeout(Duration.ofSeconds(4))
            .POST(HttpRequest.BodyPublishers.noBody())
            .build();
        HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString())
            .handle((resp, ex) -> {
                String message = (ex != null || resp.statusCode() >= 300)
                    ? "Village process unreachable — is `npm run village` running?"
                    : successMessage;
                source.getServer().execute(() ->
                    source.sendFeedback(() -> Text.literal(message), true));
                return null;
            });
    }
}
