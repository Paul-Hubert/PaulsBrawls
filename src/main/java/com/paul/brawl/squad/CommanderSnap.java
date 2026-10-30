package com.paul.brawl.squad;

import com.google.gson.JsonObject;

import net.minecraft.entity.Entity;
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
 * entity if one is in front of it). Taken on the main thread; it becomes {@code ctx.commander.at} in the script.
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
        EntityHitResult hit = ProjectileUtil.raycast(p, eye, eye.add(dir.multiply(blockDist)), box,
            e -> !e.isSpectator() && e != p, blockDist * blockDist);
        if (hit != null) {
            Entity e = hit.getEntity();
            JsonObject en = new JsonObject();
            en.addProperty("name", Registries.ENTITY_TYPE.getId(e.getType()).getPath());
            en.addProperty("type", e instanceof net.minecraft.entity.player.PlayerEntity ? "player" : "mob");
            if (e instanceof net.minecraft.entity.player.PlayerEntity pl) en.addProperty("username", pl.getName().getString());
            en.add("position", vec(e.getPos()));
            o.add("lookEntity", en);
        }
        return o;
    }

    private static JsonObject vec(Vec3d v) {
        JsonObject o = new JsonObject();
        o.addProperty("x", v.x);
        o.addProperty("y", v.y);
        o.addProperty("z", v.z);
        return o;
    }
}
