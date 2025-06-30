package com.paul.brawl;

import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;

public class ProofReceiver {
    
    public static void commonRegister() {
		PayloadTypeRegistry.playC2S().register(ImagePayload.ID, ImagePayload.CODEC);
	}
    
    public static void register() {
        ServerPlayNetworking.registerGlobalReceiver(ImagePayload.ID, (data, context) -> {
            byte[] bytes = data.image();
            checkProof(bytes);
        });
    }

    private static void checkProof(byte[] bytes) {
        ChatBot.sendImageChatRequest("Here's the evidence : ", bytes, r -> {
            ChatPrinter.broadcast("God : " + ChatBot.getResponseText(r));
        });
    }

}
