package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.network.ServerPlayerEntity;

public class ProofReceiver {
    
    public static void commonRegister() {
		PayloadTypeRegistry.playC2S().register(ImagePayload.ID, ImagePayload.CODEC);
	}
    
    public static void register() {
        ServerPlayNetworking.registerGlobalReceiver(ImagePayload.ID, (data, context) -> {
            byte[] bytes = data.image();
            //saveImage(bytes);
            var player = context.player();
            checkProof(bytes, player);
        });
    }

    private static void checkProof(byte[] bytes, ServerPlayerEntity player) {
        ChatBot.sendImageChatRequest("Voici la preuve de l'accomplissement de ma quête : ", bytes, player, (r,text) -> {
            ChatPrinter.broadcast("God : " + text);
        });
    }

    private static void saveImage(byte[] bytes) {
        try {
            Files.write(Path.of("proof_screen.png"), bytes, StandardOpenOption.CREATE);
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

}
