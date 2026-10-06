package com.paul.brawl;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.BlockPos;

/** The real {@link BuildWorld}: placements on the {@link GodActionQueue} bulk lane, reads through {@link MainThread}. */
public final class MinecraftBuildWorld implements BuildWorld {

    static final String OFFLINE = "Le joueur n'est plus connecté.";

    static ServerPlayerEntity online(UUID player) {
        MinecraftServer server = ChatBotActions.server();
        ServerPlayerEntity p = server == null || player == null ? null : server.getPlayerManager().getPlayer(player);
        if (p == null) throw new WorldRefusal(OFFLINE);
        return p;
    }

    @Override
    public boolean isOnline(UUID player) {
        return MainThread.call(() -> {
            MinecraftServer server = ChatBotActions.server();
            return server != null && player != null && server.getPlayerManager().getPlayer(player) != null;
        });
    }

    @Override
    public int[] origin(UUID player) {
        BlockPos p = Raycaster.getLastPos(player);
        return p == null ? null : new int[] { p.getX(), p.getY(), p.getZ() };
    }

    @Override
    public String blockInfo(UUID player) {
        return MainThread.call(() -> ChatBotActions.getBlockInfo(online(player)));
    }

    @Override
    public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        return MinecraftGodWorld.terrain(player, centerX, centerZ, radius);
    }

    @Override
    public boolean isKnownBlock(String block) {
        return ChatBotActions.isKnownBlock(ChatBotActions.server(), block);
    }

    @Override
    public CompletableFuture<String> place(UUID player, int[] origin, List<int[]> offsets, String block) {
        BlockPos o = new BlockPos(origin[0], origin[1], origin[2]);
        MinecraftServer server = ChatBotActions.server();
        java.util.function.Supplier<String> body = () -> {
            int n = ChatBotActions.placeAll(online(player), o, offsets, block);
            return n + " bloc(s) " + block + " placé(s).";
        };
        if (server == null || server.isOnThread()) {
            // Waiting on the queue from the thread that drains it would deadlock: run inline.
            try {
                return CompletableFuture.completedFuture(body.get());
            } catch (WorldRefusal r) {
                return CompletableFuture.failedFuture(r);
            }
        }
        return GodActionQueue.submitBulk(body);
    }
}
