package com.paul.brawl;

import net.minecraft.nbt.NbtCompound;
import net.minecraft.registry.RegistryWrapper;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.PersistentState;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public class PlayerPersistentState extends PersistentState {
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
        return server.getOverworld().getPersistentStateManager().getOrCreate(
            PlayerPersistentState.TYPE,
            STATE_KEY
        );
    }

    public static PlayerPersistentState fromNbt(NbtCompound tag, RegistryWrapper.WrapperLookup registryLookup) {
        PlayerPersistentState state = new PlayerPersistentState();
        NbtCompound playerData = tag.getCompound(PLAYER_DATA_KEY);
        for (String key : playerData.getKeys()) {
            try {
                UUID uuid = UUID.fromString(key);
                int value = playerData.getInt(key);
                state.playerMap.put(uuid, value);
            } catch (IllegalArgumentException ignored) {}
        }

        NbtCompound globalData = tag.getCompound(GLOBAL_DATA_KEY);
        for (String key : globalData.getKeys()) {
            try {
                int value = globalData.getInt(key);
                state.globalMap.put(key, value);
            } catch (IllegalArgumentException ignored) {}
        }
        return state;
    }

    public static final Type<PlayerPersistentState> TYPE = new Type<>(
        PlayerPersistentState::createNew,
        PlayerPersistentState::fromNbt,
        null
    );

    @Override
    public NbtCompound writeNbt(NbtCompound tag, RegistryWrapper.WrapperLookup registryLookup) {
        NbtCompound playerData = new NbtCompound();
        for (Map.Entry<UUID, Integer> entry : playerMap.entrySet()) {
            playerData.putInt(entry.getKey().toString(), entry.getValue());
        }
        tag.put(PLAYER_DATA_KEY, playerData);

        NbtCompound globalData = new NbtCompound();
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
        markDirty();
    }

    public int getGlobalValue(String str) {
        return globalMap.getOrDefault(str, 0);
    }

    public void setGlobalValue(String str, int value) {
        globalMap.put(str, value);
        markDirty();
    }
} 