package com.paul.brawl.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.paul.brawl.squad.SquadTriggers;

import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;

/**
 * An arrow's first hit, for an arrow shot from a bound bow or crossbow (docs/29 §5.4: the {@code arrow-hit} trigger).
 * Fabric has no event for a projectile hit. Both injections only observe, at HEAD, and never cancel; SquadTriggers
 * returns at once for client arrows and for every arrow it did not track at its release.
 *
 * <p>One copy per version (docs/39 §3.5), because {@code AbstractArrow} moved package in 26.x: this is the 1.21.1
 * one ({@code net.minecraft.world.entity.projectile.AbstractArrow}); keep it in step with
 * {@code versions/26.1.2/src/main/java/com/paul/brawl/mixin/AbstractArrowMixin.java}.
 *
 * <p>Targets, checked with {@code javap} on the 1.21.1 Mojang-named jar: {@code protected void
 * onHitEntity(EntityHitResult)} and {@code protected void onHitBlock(BlockHitResult)}, both declared by
 * {@code AbstractArrow} (overriding {@code Projectile}'s). A subclass that overrides one without calling super (the
 * trident's {@code onHitEntity}) skips this, which is fine: only bow and crossbow arrows count.
 */
@Mixin(AbstractArrow.class)
public abstract class AbstractArrowMixin {

	@Inject(method = "onHitEntity(Lnet/minecraft/world/phys/EntityHitResult;)V", at = @At("HEAD"))
	private void paulsbrawls$squadEntityHit(EntityHitResult hit, CallbackInfo ci) {
		SquadTriggers.onArrowHit((Projectile) (Object) this, hit);
	}

	@Inject(method = "onHitBlock(Lnet/minecraft/world/phys/BlockHitResult;)V", at = @At("HEAD"))
	private void paulsbrawls$squadBlockHit(BlockHitResult hit, CallbackInfo ci) {
		SquadTriggers.onArrowHit((Projectile) (Object) this, hit);
	}
}
