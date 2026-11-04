package com.paul.brawl.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Lets a client without Fabric join, as on 1.21.1: the bots (Squad's runtime, the unified bridge's {@code LLMBot}) are
 * mineflayer clients, and the mod registers an item ({@code paulsbrawls:coin}) in a synced registry.
 *
 * <p>Fabric API's registry sync on 26.1.2 ({@code fabric-registry-sync-v0} 7.1.1,
 * {@code RegistrySyncManager.configureClient}) disconnects a client that cannot receive the sync packet unless every
 * registry with modded entries is marked optional ({@code areAllRegistriesOptional}), with "This server requires
 * Fabric Loader and Fabric API installed on your client!". 1.21.1's (5.3.1) returned instead, so such a client joined
 * without a sync. Answering true here takes that branch's {@code return}: no sync, no kick; a client that can receive
 * the sync never reaches the call. {@code areAllRegistriesOptional} has no other caller (checked with {@code javap}).
 *
 * <p>26.1.2 only ({@code versions/26.1.2/src/main/resources/paulsbrawls.version.mixins.json}, docs/39 §3.5). As on
 * 1.21.1, a vanilla client that is sent a coin gets an item id it does not know.
 */
@Mixin(targets = "net.fabricmc.fabric.impl.registry.sync.RegistrySyncManager")
public abstract class RegistrySyncVanillaClientsMixin {

	@Inject(method = "areAllRegistriesOptional", at = @At("HEAD"), cancellable = true)
	private static void paulsbrawls$letVanillaClientsJoin(CallbackInfoReturnable<Boolean> cir) {
		cir.setReturnValue(true);
	}
}
