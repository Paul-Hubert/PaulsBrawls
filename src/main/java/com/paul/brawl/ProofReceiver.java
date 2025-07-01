package com.paul.brawl;

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
            var player = context.player();
            checkProof(bytes, player);
        });
    }

    private static void checkProof(byte[] bytes, ServerPlayerEntity player) {
        ChatBot.sendImageChatRequest("Here's the evidence : ", bytes, player, (r,text) -> {
            ChatPrinter.broadcast("God : " + text);
        });
    }

}
