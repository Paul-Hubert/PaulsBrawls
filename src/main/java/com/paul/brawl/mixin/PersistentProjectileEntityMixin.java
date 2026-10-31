package com.paul.brawl.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.paul.brawl.squad.SquadTriggers;

import net.minecraft.entity.projectile.PersistentProjectileEntity;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;

/**
 * An arrow's first hit, for an arrow shot from a bound bow or crossbow (docs/29 §5.4: the {@code arrow-hit} trigger).
 * Fabric has no event for a projectile hit. Both injections only observe, at HEAD, and never cancel; SquadTriggers
 * returns at once for client arrows and for every arrow it did not track at its release.
 *
 * <p>Targets, checked with {@code javap} on the 1.21.1+build.3 named jar: {@code protected void
 * onEntityHit(EntityHitResult)} and {@code protected void onBlockHit(BlockHitResult)}, both declared by
 * {@code PersistentProjectileEntity} (overriding {@code ProjectileEntity}'s). A subclass that overrides one without
 * calling super (the trident's {@code onEntityHit}) skips this, which is fine: only bow and crossbow arrows count.
 */
@Mixin(PersistentProjectileEntity.class)
public abstract class PersistentProjectileEntityMixin {

	@Inject(method = "onEntityHit(Lnet/minecraft/util/hit/EntityHitResult;)V", at = @At("HEAD"))
	private void paulsbrawls$squadEntityHit(EntityHitResult hit, CallbackInfo ci) {
		SquadTriggers.onArrowHit((PersistentProjectileEntity) (Object) this, hit);
	}

	@Inject(method = "onBlockHit(Lnet/minecraft/util/hit/BlockHitResult;)V", at = @At("HEAD"))
	private void paulsbrawls$squadBlockHit(BlockHitResult hit, CallbackInfo ci) {
		SquadTriggers.onArrowHit((PersistentProjectileEntity) (Object) this, hit);
	}
}
