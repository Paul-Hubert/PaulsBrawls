package com.paul.brawl.squad;

import com.google.gson.JsonObject;

import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.entity.projectile.ProjectileUtil;
import net.minecraft.registry.Registries;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * Where the commander stands and looks when they give an order or ask for a command (docs/29 §7.1): the exact
 * position, rotation, dimension, held item, and what they look at within 64 blocks (the nearest block, and an
 * entity a crosshair could target if one is in front of it: a creature or a player, not an arrow or an item). Taken
 * on the main thread; it becomes {@code ctx.commander.at} in the script. A bound item's click adds {@code trigger}
 * to it (SquadTriggers).
 */
public final class CommanderSnap {

    public static final double REACH = 64;

    private CommanderSnap() {}

    public static JsonObject of(ServerPlayerEntity p) {
        JsonObject o = new JsonObject();
        o.add("position", vec(p.getPos()));
        o.addProperty("yaw", p.getYaw());
        o.addProperty("pitch", p.getPitch());
        o.addProperty("dimension", p.getWorld().getRegistryKey().getValue().getPath());
        var held = p.getMainHandStack();
        if (!held.isEmpty()) o.addProperty("heldItem", Registries.ITEM.getId(held.getItem()).getPath());

        Vec3d eye = p.getCameraPosVec(1.0f);
        Vec3d dir = p.getRotationVec(1.0f);
        Vec3d end = eye.add(dir.multiply(REACH));
        BlockHitResult block = p.getWorld().raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE, p));
        double blockDist = REACH;
        if (block != null && block.getType() == HitResult.Type.BLOCK) {
            BlockPos bp = block.getBlockPos();
            JsonObject b = new JsonObject();
            b.addProperty("x", bp.getX());
            b.addProperty("y", bp.getY());
            b.addProperty("z", bp.getZ());
            b.addProperty("name", Registries.BLOCK.getId(p.getWorld().getBlockState(bp).getBlock()).getPath());
            o.add("lookBlock", b);
            blockDist = block.getPos().distanceTo(eye);
        }
        Box box = p.getBoundingBox().stretch(dir.multiply(blockDist)).expand(1.0);
        // What a crosshair can target, as vanilla's: canHit() is false for arrows, items and XP orbs. Without it a
        // bound bow's arrow-release snapshot, taken as the arrow enters the world in front of the eyes, named that
        // arrow as lookEntity, and `tir` shot at it before the hit came (found live, docs/29 §16).
        EntityHitResult hit = ProjectileUtil.raycast(p, eye, eye.add(dir.multiply(blockDist)), box,
            e -> e != p && !e.isSpectator() && e.canHit(), blockDist * blockDist);
        if (hit != null) o.add("lookEntity", entity(hit.getEntity()).toJson());
        return o;
    }

    /**
     * An entity as a script sees it (the snapshot's {@code lookEntity}, a bound bow's {@code hit.entity}), with its
     * network id: the id is the same for every client, so a bot finds it in {@code bot.entities} (docs/29 §5.4).
     */
    static SquadTriggerJson.EntityRef entity(Entity e) {
        Vec3d pos = e.getPos();
        boolean player = e instanceof PlayerEntity;
        return new SquadTriggerJson.EntityRef(e.getId(), Registries.ENTITY_TYPE.getId(e.getType()).getPath(), player,
            player ? e.getName().getString() : null, pos.x, pos.y, pos.z);
    }

    private static JsonObject vec(Vec3d v) {
        return SquadTriggerJson.vec(v.x, v.y, v.z);
    }
}
