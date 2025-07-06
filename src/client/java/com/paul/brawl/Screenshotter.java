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

import static com.mojang.brigadier.arguments.StringArgumentType.*;

public class Screenshotter {

	private static boolean flag = false;
	private static String text;
	private static ExecutorService executor;

	public static void register() {
		registerCommands();
		registerTickEvent();

		executor = Executors.newSingleThreadExecutor();

		ImageReceiver.commonRegister();
	}

	// send screen shot on start of next tick to avoid chat locking the view
	private static void registerTickEvent() {
		ClientTickEvents.START_CLIENT_TICK.register((c) -> {
			if(!flag) return;
			flag = false;
			sendScreenshotAfterDelay();
		});
	}
	
	// /proof
	public static void registerCommands() {
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			dispatcher.register(
				ClientCommandManager.literal("prouver")
						.then(ClientCommandManager.argument("text", string()))
						.executes(context -> {
							var s = getString(context, "text");
							sendProofScreenshot(s);
							return Command.SINGLE_SUCCESS;
						})
					);
		});

		ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> {
			dispatcher.register(
				ClientCommandManager.literal("construire")
						.then(ClientCommandManager.argument("text", string())
						.executes(context -> {
							var s = getString(context, "text");
							sendBuildScreenshot(s);
							return Command.SINGLE_SUCCESS;
						}))
					);
		});
	}

	public static void sendBuildScreenshot(String s) {
		sendScreenshot("construire : " + s);
	}

	public static void sendProofScreenshot(String s) {
		sendScreenshot("prouver : " + s);
	}

	public static void sendScreenshot(String text) {

		MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(Text.literal("Capture d'écran dans 1 seconde"));

		Screenshotter.text = text;

		executor.submit(() -> {
			try {
				Thread.sleep(1000);
			} catch (InterruptedException e) {
				e.printStackTrace();
			}
			flag = true;
		});
	}

	private static void sendScreenshotAfterDelay() {

		MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(Text.literal("Capture d'écran prise, envoi à Dieu..."));

		NativeImage nativeImage = ScreenshotRecorder.takeScreenshot(MinecraftClient.getInstance().getFramebuffer());
		
		var img2 = new NativeImage(854, 480, true);
		
		nativeImage.resizeSubRectTo(0, 0, nativeImage.getWidth(), nativeImage.getHeight(), img2);

		try {
			ImagePayload payload =  new ImagePayload (img2.getBytes(), text);
			ClientPlayNetworking.send(payload);
		} catch (IOException e) {
			e.printStackTrace();
		} finally {
			nativeImage.close();
		}

	}


}