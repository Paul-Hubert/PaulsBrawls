package com.paul.brawl;

import com.paul.brawl.compat.Compat;

import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.saveddata.SavedData;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class PlayerPersistentState extends SavedData {
	private static final String STATE_KEY = "gibbers_state";
    private static final String PLAYER_DATA_KEY = "player_data";
    private static final String GLOBAL_DATA_KEY = "global_data";
    private final Map<UUID, Integer> playerMap = new HashMap<>();
    private final Map<String, Integer> globalMap = new HashMap<>();



    public PlayerPersistentState() {}

    public static PlayerPersistentState createNew() {
        return new PlayerPersistentState();
    }

    public static PlayerPersistentState getState(MinecraftServer server) {
        return Compat.savedData(server, STATE_KEY, PlayerPersistentState::createNew,
            PlayerPersistentState::fromNbt, state -> state.save(new CompoundTag(), null));
    }

    public static PlayerPersistentState fromNbt(CompoundTag tag) {
        PlayerPersistentState state = new PlayerPersistentState();
        CompoundTag playerData = Compat.getCompound(tag, PLAYER_DATA_KEY).orElseGet(CompoundTag::new);
        for (String key : Compat.keys(playerData)) {
            try {
                UUID uuid = UUID.fromString(key);
                int value = Compat.getInt(playerData, key);
                state.playerMap.put(uuid, value);
            } catch (IllegalArgumentException ignored) {}
        }

        CompoundTag globalData = Compat.getCompound(tag, GLOBAL_DATA_KEY).orElseGet(CompoundTag::new);
        for (String key : Compat.keys(globalData)) {
            try {
                int value = Compat.getInt(globalData, key);
                state.globalMap.put(key, value);
            } catch (IllegalArgumentException ignored) {}
        }
        return state;
    }

    /** The state as a tag: 1.21.1's SavedData calls it (an override there, not on 26.x), and 26.x's codec through getState. */
    public CompoundTag save(CompoundTag tag, HolderLookup.Provider registryLookup) {
        CompoundTag playerData = new CompoundTag();
        for (Map.Entry<UUID, Integer> entry : playerMap.entrySet()) {
            playerData.putInt(entry.getKey().toString(), entry.getValue());
        }
        tag.put(PLAYER_DATA_KEY, playerData);

        CompoundTag globalData = new CompoundTag();
        for (Map.Entry<String, Integer> entry : globalMap.entrySet()) {
            globalData.putInt(entry.getKey().toString(), entry.getValue());
        }
        tag.put(GLOBAL_DATA_KEY, globalData);

        return tag;
    }

    public int getPlayerValue(UUID uuid) {
        return playerMap.getOrDefault(uuid, 0);
    }

    public void setPlayerValue(UUID uuid, int value) {
        playerMap.put(uuid, value);
        setDirty();
    }

    public int getGlobalValue(String str) {
        return globalMap.getOrDefault(str, 0);
    }

    public void setGlobalValue(String str, int value) {
        globalMap.put(str, value);
        setDirty();
    }
}
