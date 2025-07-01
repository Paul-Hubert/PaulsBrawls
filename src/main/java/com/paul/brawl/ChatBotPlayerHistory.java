package com.paul.brawl;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBotPlayerHistory {

    public static Map<UUID, List<ResponseInputItem>> previousInputsPerPlayer = new HashMap<>();

    public static void addInput(ResponseInputItem item, ServerPlayerEntity player) {
        List<ResponseInputItem> list = previousInputsPerPlayer.get(player.getUuid());
        if(list == null) {
            list = (List<ResponseInputItem>) new ArrayList<ResponseInputItem>();
            previousInputsPerPlayer.put(player.getUuid(), list);
        }
        list.add(item);
    }

    public static List<ResponseInputItem> popInputs(ServerPlayerEntity player) {
        var l = previousInputsPerPlayer.get(player.getUuid());
        if(l == null) return null;
        var nl = List.copyOf(l);
        l.clear();
        return nl;
    }

    public static List<ResponseInputItem> getInputs(ServerPlayerEntity player) {
        return previousInputsPerPlayer.get(player.getUuid());
    }
    

}
