package com.paul.brawl;

import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBotPlayerHistory {
    public static int MAX_HISTORY = 10;
    public Map<UUID, List<ResponseInputItem>> previousInputsPerPlayer = new HashMap<>();

    public void addInput(ResponseInputItem item, ServerPlayerEntity player) {
        List<ResponseInputItem> list = previousInputsPerPlayer.get(player.getUuid());
        if(list == null) {
            list = (List<ResponseInputItem>) new LinkedList<ResponseInputItem>();
            previousInputsPerPlayer.put(player.getUuid(), list);
        }
        if (list.size() >= MAX_HISTORY) {
            //list.removeFirst();
        }
        list.addLast(item);
    }

    public List<ResponseInputItem> popInputs(ServerPlayerEntity player) {
        var l = previousInputsPerPlayer.get(player.getUuid());
        if(l == null) return null;
        var nl = List.copyOf(l);
        l.clear();
        return nl;
    }

    public List<ResponseInputItem> getInputs(ServerPlayerEntity player) {
        return previousInputsPerPlayer.get(player.getUuid());
    }
    

}
