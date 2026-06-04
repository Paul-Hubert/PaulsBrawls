package com.paul.brawl;

import java.util.concurrent.CompletableFuture;

import net.minecraft.server.network.ServerPlayerEntity;

/**
 * Semantic layer between God's tools and the dumb bridge RPC. Translates
 * player/world state into bridge calls — the bridge stays oblivious to the
 * praying player, the avatar's current pose, or what "in front of" means.
 *
 * <p>Every method returns the bridge {@link CompletableFuture} so callers
 * <em>can</em> chain off success but are not required to (best-effort).
 */
public class GodBody {

    private GodBody() {}

    /**
     * Compute a spawn point in front of the player, drop the bot there with a
     * single {@code /tp ... facing entity <player>} command, and fire the
     * matching "I just teleported in" gesture.
     *
     * <p>Uses the player's <em>yaw only</em> so distance is independent of
     * pitch — looking down at the ground shouldn't drop God between your feet.
     */
    public static CompletableFuture<Boolean> appear(
            ServerPlayerEntity player,
            double distance,
            double height,
            boolean lookAtPlayer) {
        if (player == null) return CompletableFuture.completedFuture(false);

        // Yaw 0 in vanilla MC points along +Z, increasing clockwise — so the
        // unit vector is (-sin(yaw), 0, cos(yaw)). Picking the same convention
        // here means the bot lands in the player's actual field of view.
        double yaw  = Math.toRadians(player.getYaw());
        double dirX = -Math.sin(yaw);
        double dirZ =  Math.cos(yaw);

        double x = player.getX() + dirX * distance;
        double y = player.getY() + height;
        double z = player.getZ() + dirZ * distance;

        String facing = lookAtPlayer ? player.getName().getString() : null;
        return BotBridgeClient.INSTANCE.appear(x, y, z, facing);
    }

    /** God's spoken line — posted to public chat through the bot. */
    public static CompletableFuture<Boolean> say(String line) {
        if (line == null || line.isBlank()) return CompletableFuture.completedFuture(false);
        return BotBridgeClient.INSTANCE.chat(line);
    }

    /** Re-aim the bot at the player without teleporting. */
    public static CompletableFuture<Boolean> lookAt(ServerPlayerEntity player) {
        if (player == null) return CompletableFuture.completedFuture(false);
        return BotBridgeClient.INSTANCE.look(player.getX(), player.getY() + 1.6, player.getZ());
    }

    public static CompletableFuture<Boolean> gesture(String type) {
        return BotBridgeClient.INSTANCE.gesture(type);
    }

    /** Send the bot to its parking spot. Safe to call when not currently appeared. */
    public static CompletableFuture<Boolean> vanish() {
        return BotBridgeClient.INSTANCE.vanish();
    }
}
