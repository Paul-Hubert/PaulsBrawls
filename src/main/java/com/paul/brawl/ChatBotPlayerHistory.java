package com.paul.brawl;

import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.openai.models.responses.ResponseInputItem;

import net.minecraft.server.network.ServerPlayerEntity;

public class ChatBotPlayerHistory {
    public static int MAX_HISTORY = 10;
    public Map<UUID, List<ResponseInputItem>> previousInputsPerPlayer = new ConcurrentHashMap<>();

    public void addInput(ResponseInputItem item, ServerPlayerEntity player) {
        List<ResponseInputItem> list = previousInputsPerPlayer.computeIfAbsent(
            player.getUuid(), k -> new LinkedList<>()
        );
        synchronized (list) {
            while (list.size() >= MAX_HISTORY) {
                list.removeFirst();
            }
            list.addLast(item);
        }
    }

    public List<ResponseInputItem> popInputs(ServerPlayerEntity player) {
        var l = previousInputsPerPlayer.get(player.getUuid());
        if(l == null) return null;
        synchronized (l) {
            var nl = List.copyOf(l);
            l.clear();
            return nl;
        }
    }

    /**
     * Returns an immutable snapshot of the player's history, or null if none.
     * Snapshotting under the per-list lock prevents ConcurrentModificationException
     * when a concurrent addInput / popInputs mutates the underlying LinkedList.
     */
    public List<ResponseInputItem> getInputs(ServerPlayerEntity player) {
        var l = previousInputsPerPlayer.get(player.getUuid());
        if (l == null) return null;
        synchronized (l) {
            return List.copyOf(l);
        }
    }

    /** Drops history for every player. Used when swapping LLM providers. */
    public void clearAll() {
        previousInputsPerPlayer.clear();
    }


}
