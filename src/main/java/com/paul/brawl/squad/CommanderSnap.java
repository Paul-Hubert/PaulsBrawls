package com.paul.brawl.squad;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;
import com.google.gson.JsonObject;
import com.paul.brawl.compat.Compat;

/**
 * Where the commander stands and looks when they give an order or ask for a command (docs/29 §7.1): the exact
 * position, rotation, dimension and held item, taken on the main thread at once, and what they look at as far as they
 * can see (the nearest block, and an entity a crosshair could target if one is in front of it: a creature or a player,
 * not an arrow or an item), found by {@link SquadLook} on its worker thread, a tick or more later. It becomes
 * {@code ctx.commander.at} in the script. A bound item's click adds {@code trigger} to it (SquadTriggers).
 */
public final class CommanderSnap {

    /** A player's snapshots complete in the order they were taken (an arrow's hit after its release). */
    private static final SquadInOrder<UUID> IN_ORDER = new SquadInOrder<>();

    private CommanderSnap() {}

    /**
     * The snapshot of {@code p} now (server thread). It completes on the server thread once the look is found, after
     * every earlier snapshot of the same player: send the order then.
     */
    public static CompletableFuture<JsonObject> take(ServerPlayer p) {
        JsonObject o = new JsonObject();
        o.add("position", vec(p.position()));
        o.addProperty("yaw", p.getYRot());
        o.addProperty("pitch", p.getXRot());
        o.addProperty("dimension", Compat.path(p.level().dimension()));
        var held = p.getMainHandItem();
        if (!held.isEmpty()) o.addProperty("heldItem", BuiltInRegistries.ITEM.getKey(held.getItem()).getPath());
        CompletableFuture<JsonObject> look = SquadLook.cast(p).thenApply(l -> {
            if (l.block() != null) {
                BlockPos bp = l.block();
                JsonObject b = new JsonObject();
                b.addProperty("x", bp.getX());
                b.addProperty("y", bp.getY());
                b.addProperty("z", bp.getZ());
                b.addProperty("name", l.blockName());
                o.add("lookBlock", b);
            }
            if (l.entity() != null) o.add("lookEntity", l.entity().toJson());
            return o;
        });
        return IN_ORDER.after(p.getUUID(), look);
    }

    /**
     * An entity as a script sees it (the snapshot's {@code lookEntity}, a bound bow's {@code hit.entity}), with its
     * network id: the id is the same for every client, so a bot finds it in {@code bot.entities} (docs/29 §5.4).
     */
    static SquadTriggerJson.EntityRef entity(Entity e) {
        Vec3 pos = e.position();
        boolean player = e instanceof Player;
        return new SquadTriggerJson.EntityRef(e.getId(), BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).getPath(), player,
            player ? e.getName().getString() : null, pos.x, pos.y, pos.z);
    }

    private static JsonObject vec(Vec3 v) {
        return SquadTriggerJson.vec(v.x, v.y, v.z);
    }
}
