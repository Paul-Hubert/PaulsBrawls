package com.paul.brawl;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.mojang.brigadier.Command;

import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.text.Text;

public class Screenshotter {

	private static volatile boolean flag = false;
	private static ExecutorService executor;

	public static void register() {
		registerCommand();
		registerTickEvent();

		executor = Executors.newSingleThreadExecutor();
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
				ClientCommandManager.literal("prouver")
						.executes(context -> {
							sendProofScreenshot();
							return Command.SINGLE_SUCCESS;
						})
					);
		});
	}

	public static void sendProofScreenshot() {

		MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(Text.literal("Screenshotting in 1 second"));

		executor.submit(() -> {
			try {
				Thread.sleep(1000);
			} catch (InterruptedException e) {
				// TODO Auto-generated catch block
				e.printStackTrace();
			}
			flag = true;
		});
	}

	private static void sendProofScreenshotAfterDelay() {

		MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(Text.literal("Screenshotted, sending to God"));

		NativeImage nativeImage = ScreenshotRecorder.takeScreenshot(MinecraftClient.getInstance().getFramebuffer());
		
		var img2 = new NativeImage(854, 480, true);
		
		nativeImage.resizeSubRectTo(0, 0, nativeImage.getWidth(), nativeImage.getHeight(), img2);

		try {
			ImagePayload payload =  new ImagePayload (img2.getBytes());
			ClientPlayNetworking.send(payload);
		} catch (IOException e) {
			e.printStackTrace();
		} finally {
			nativeImage.close();
		}

	}


}