package com.paul.brawl.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.paul.brawl.squad.Squad;
import com.paul.brawl.squad.SquadDeath;

import net.minecraft.entity.player.PlayerEntity;

/**
 * A roster bot drops nothing when it dies (docs/35 F6, Paul's D2): its inventory is lost, and {@code /bots squad
 * respawn} gives it its kit again. Everyone else drops as vanilla does; the XP is vanilla's for bots too.
 *
 * <p>Target, checked with {@code javap} on the 1.21.1+build.3 named jar: {@code protected void dropInventory()},
 * declared by {@code PlayerEntity} (super, then unless {@code keepInventory}: {@code vanishCursedItems()} and
 * {@code inventory.dropAll()}), not overridden by {@code ServerPlayerEntity}; intermediary {@code
 * class_1657.method_16078()V}, also in the intermediary jar and the generated refmap. {@code LivingEntity.drop} calls
 * it on a death. The respawned player copies no inventory without {@code keepInventory}, so the stacks are gone.
 */
@Mixin(PlayerEntity.class)
public abstract class PlayerEntityMixin {

	@Inject(method = "dropInventory()V", at = @At("HEAD"), cancellable = true)
	private void paulsbrawls$squadBotDropsNothing(CallbackInfo ci) {
		PlayerEntity self = (PlayerEntity) (Object) this;
		if (self.getWorld().isClient()) return;
		if (SquadDeath.dropsNothing(Squad.botNames(), self.getName().getString())) ci.cancel();
	}
}
