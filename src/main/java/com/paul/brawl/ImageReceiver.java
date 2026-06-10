package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.network.ServerPlayerEntity;

public class ImageReceiver {
    
    public static void commonRegister() {
		PayloadTypeRegistry.playC2S().register(ImagePayload.ID, ImagePayload.CODEC);
	}
    
    public static void register() {
        ServerPlayNetworking.registerGlobalReceiver(ImagePayload.ID, (data, context) -> {
            byte[] bytes = data.image();
            String s = data.text();
            //saveImage(bytes);
            var player = context.player();
            checkProof(bytes, player, s);
        });
    }

    private static void checkProof(byte[] bytes, ServerPlayerEntity player, String text) {
        ChatBot bot = ChatBot.getCorrectChatBot(text);
        // /prove rides the same encounter semantics as /pray: try to claim the
        // single shared avatar so God may Appear in response to the proof. If
        // another player holds it, the reply is simply bodiless.
        if (bot.needsGodTools && !GodSessionManager.claim(player)) {
            ChatPrinter.sendMessage(player, "Dieu : (occupé ailleurs — je regarde ta preuve, mais sans forme.)");
        }
        bot.sendImageChatRequest(text, bytes, player);
    }

    private static void saveImage(byte[] bytes) {
        try {
            Files.write(Path.of("proof_screen.png"), bytes, StandardOpenOption.CREATE);
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

}
