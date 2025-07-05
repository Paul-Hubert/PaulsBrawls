package com.paul.brawl;

import org.joml.Quaternionf;
import org.joml.Vector3f;

import net.minecraft.entity.Entity;
import net.minecraft.entity.projectile.ProjectileUtil;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

public class Raycaster {
    

    public static BlockPos raycast(ServerPlayerEntity player, float x, float y) {
        var c = player.getRotationVec(0.1f);
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
        var dir = new Vec3d(direction.x, direction.y, direction.z);
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
            BlockPos ret = result.getBlockPos().add(result.getSide().getVector());
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

    private static HitResult raycastInDirection(ServerPlayerEntity player, Vec3d direction) {
        Entity entity = player.getCameraEntity();
        if (entity == null) {
            return null;
        }
     
        double reachDistance = 100;//Change this to extend the reach

        HitResult target = raycast(entity, reachDistance, false, direction);

        Vec3d cameraPos = entity.getCameraPosVec(0.1f);
     
     
        Vec3d vec3d3 = cameraPos.add(direction.multiply(reachDistance));
        Box box = entity
                .getBoundingBox()
                .stretch(entity.getRotationVec(1.0F).multiply(reachDistance))
                .expand(1.0D, 1.0D, 1.0D);
        EntityHitResult entityHitResult = ProjectileUtil.raycast(
                entity,
                cameraPos,
                vec3d3,
                box,
                (entityx) -> !entityx.isSpectator() && (entityx.groundCollision || entityx.verticalCollision || entityx.horizontalCollision),
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
            Vec3d direction
    ) {
        Vec3d end = entity.getCameraPosVec(0.1f).add(direction.multiply(maxDistance));
        return entity.getWorld().raycast(new RaycastContext(
                entity.getCameraPosVec(0.1f),
                end,
                RaycastContext.ShapeType.OUTLINE,
                includeFluids ? RaycastContext.FluidHandling.ANY : RaycastContext.FluidHandling.NONE,
                entity
        ));
    }
}
