package com.paul.brawl;

import java.util.HashMap;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.joml.Vector3f;

public class Raycaster {
    
    private static HashMap<UUID, BlockPos> lastPos = new HashMap<>();

    public static BlockPos raycast(ServerPlayer player, float x, float y) {
        var c = player.getViewVector(0.1f);
        Vector3f cameraDirection = new Vector3f((float) c.x,(float) c.y,(float) c.z);
        System.out.println(cameraDirection);
        
        double fov = 70 * Math.PI / 180;

        double angleSize = fov / 2;
        
        Vector3f verticalRotationAxis = new Vector3f(cameraDirection);
        verticalRotationAxis.cross(new Vector3f(0,1,0));
        
        Vector3f horizontalRotationAxis = new Vector3f(cameraDirection);
        horizontalRotationAxis.cross(verticalRotationAxis);
        horizontalRotationAxis.normalize();
         
        verticalRotationAxis = new Vector3f(cameraDirection);
        verticalRotationAxis.cross(horizontalRotationAxis);

        Vector3f direction = map(
                (float) angleSize,
                cameraDirection,
                horizontalRotationAxis,
                verticalRotationAxis,
                x,
                y
        );
        var dir = new Vec3(direction.x, direction.y, direction.z);
        HitResult nextHit = raycastInDirection(player, dir);

        if(nextHit == null) {
            System.out.println("Null");
            return null;
        }

        if(nextHit.getType() == HitResult.Type.MISS) {
            System.out.println("Miss");
            return null;
        }

        if (nextHit.getType() == HitResult.Type.BLOCK) {
            var result = (BlockHitResult) nextHit;
            BlockPos ret = result.getBlockPos();
            // for getting the block facing the side that is selected
            //.add(result.getSide().getVector());
            return ret;
        } else if(nextHit.getType() == HitResult.Type.ENTITY) {
            System.out.println("Entity");
            return null;
        }

        return null;
    }


    private static Vector3f map(float anglePerPixel, Vector3f center, Vector3f horizontalRotationAxis,
        Vector3f verticalRotationAxis, float x, float y) {
        float horizontalRotation = x * anglePerPixel;
        float verticalRotation = y * anglePerPixel;
    
        final Vector3f temp2 = center;
        var a = verticalRotationAxis;
        temp2.rotateAxis(verticalRotation, a.x, a.y, a.z);
        a = horizontalRotationAxis;
        temp2.rotateAxis(horizontalRotation, a.x, a.y, a.z);
        return temp2;
    }

    private static HitResult raycastInDirection(ServerPlayer player, Vec3 direction) {
        Entity entity = player.getCamera();
        if (entity == null) {
            return null;
        }
     
        double reachDistance = 100;//Change this to extend the reach

        HitResult target = raycast(entity, reachDistance, false, direction);

        Vec3 cameraPos = entity.getEyePosition(0.1f);
     
     
        Vec3 vec3d3 = cameraPos.add(direction.scale(reachDistance));
        AABB box = entity
                .getBoundingBox()
                .expandTowards(entity.getViewVector(1.0F).scale(reachDistance))
                .inflate(1.0D, 1.0D, 1.0D);
        EntityHitResult entityHitResult = ProjectileUtil.getEntityHitResult(
                entity,
                cameraPos,
                vec3d3,
                box,
                (entityx) -> !entityx.isSpectator() && (entityx.verticalCollisionBelow || entityx.verticalCollision || entityx.horizontalCollision),
                reachDistance
        );
     
        if (entityHitResult == null) {
            return target;
        }
     
        return entityHitResult;
    }
     
    private static HitResult raycast(
            Entity entity,
            double maxDistance,
            boolean includeFluids,
            Vec3 direction
    ) {
        Vec3 end = entity.getEyePosition(0.1f).add(direction.scale(maxDistance));
        return entity.level().clip(new ClipContext(
                entity.getEyePosition(0.1f),
                end,
                ClipContext.Block.OUTLINE,
                includeFluids ? ClipContext.Fluid.ANY : ClipContext.Fluid.NONE,
                entity
        ));
    }

    public static BlockPos getLastPos(UUID uuid) {
        return lastPos.get(uuid);
    }

    public static void setLastPos(ServerPlayer player) {
        lastPos.put(player.getUUID(), raycast(player, 0, 0));
    }

}
