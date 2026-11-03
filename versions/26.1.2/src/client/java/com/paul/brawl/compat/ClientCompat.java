package com.paul.brawl.compat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.brigadier.arguments.ArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;

import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.network.chat.Component;

/**
 * The client side of {@link Compat}: what 1.21.1 and 26.1.2 do differently on the client, one copy per version with
 * the same signatures (docs/39 §3). This is the 26.1.2 copy.
 */
public final class ClientCompat {
    private static final Logger LOGGER = LoggerFactory.getLogger("ClientCompat");

    private ClientCompat() {}

    public static LiteralArgumentBuilder<FabricClientCommandSource> literal(String name) {
        return ClientCommands.literal(name);
    }

    public static <T> RequiredArgumentBuilder<FabricClientCommandSource, T> argument(String name, ArgumentType<T> type) {
        return ClientCommands.argument(name, type);
    }

    /** A line in the player's chat, from the client. */
    public static void chat(Component message) {
        Minecraft.getInstance().gui.getChat().addClientSystemMessage(message);
    }

    /**
     * The screen, resized to {@code width}×{@code height}, as PNG bytes. On the render thread; {@code then} runs there
     * (26.x: once the GPU has copied the frame, after this returns), and not at all if the capture fails.
     */
    public static void screenshot(int width, int height, Consumer<byte[]> then) {
        Screenshot.takeScreenshot(Minecraft.getInstance().getMainRenderTarget(), shot -> {
            NativeImage resized = new NativeImage(width, height, true);
            Path file = null;
            try {
                shot.resizeSubRectTo(0, 0, shot.getWidth(), shot.getHeight(), resized);
                // 26.x's NativeImage encodes PNG to a file only (asByteArray is gone).
                file = Files.createTempFile("paulsbrawls-screenshot", ".png");
                resized.writeToFile(file);
                then.accept(Files.readAllBytes(file));
            } catch (IOException e) {
                LOGGER.warn("Screenshot failed: {}", e.toString());
            } finally {
                shot.close();
                resized.close();
                if (file != null) {
                    try {
                        Files.deleteIfExists(file);
                    } catch (IOException e) {
                        LOGGER.warn("Could not delete {}: {}", file, e.toString());
                    }
                }
            }
        });
    }
}
