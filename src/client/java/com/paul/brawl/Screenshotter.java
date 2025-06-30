package com.paul.brawl;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.context.CommandContext;

import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.text.Text;

public class Screenshotter {

	private static boolean flag = false;

	public static void register() {
		registerCommand();
		registerTickEvent();
	}

	// send screen shot on start of next tick to avoid chat locking the view
	private static void registerTickEvent() {
		ClientTickEvents.START_CLIENT_TICK.register((c) -> {
			if(!flag) return;
			flag = false;
			sendProofScreenshotAfterDelay();
		});
	}
		
	// /proof
	public static void registerCommand() {
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			dispatcher.register(
				ClientCommandManager.literal("proof")
						.executes(context -> {
							sendProofScreenshot();
							return Command.SINGLE_SUCCESS;
						})
					);
		});
	}

	public static void sendProofScreenshot() {
		flag = true;
	}

	private static void sendProofScreenshotAfterDelay() {

		MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(Text.literal("Screenshotting"));

		NativeImage nativeImage = ScreenshotRecorder.takeScreenshot(MinecraftClient.getInstance().getFramebuffer());
		try {
			ImagePayload payload =  new ImagePayload (nativeImage.getBytes());
			ClientPlayNetworking.send(payload);
		} catch (IOException e) {
			e.printStackTrace();
		} finally {
			nativeImage.close();
		}

	}


}