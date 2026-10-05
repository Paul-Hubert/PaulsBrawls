package com.paul.brawl;

import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.fabric.api.entity.event.v1.EntityElytraEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.UnbreakableComponent;
import net.minecraft.item.ItemStack;
import net.minecraft.server.network.ServerPlayerEntity;

public class FlagManager {
    
    public static final Logger LOGGER = LoggerFactory.getLogger("FlagManager");

    /** Bug #11: whose glow the mod set — only that glow is ever cleared. */
    private static final FlagGlow GLOW = new FlagGlow();

	public static void register() {
        
        banElytra();

        dropOnHit();

        glowFlagholders();

    }

    // ban elytra
    public static void banElytra() {
        EntityElytraEvents.ALLOW.register((entity) -> {
            if (entity instanceof net.minecraft.server.network.ServerPlayerEntity player) {
                if(checkInventory(player) != null) {
                    return false;
                }
            }
            return true;
        });
    }

    // drop flag on hit
    public static void dropOnHit() {
        ServerLivingEntityEvents.ALLOW_DAMAGE.register((entity, source, amount) -> {
            if (entity instanceof ServerPlayerEntity player) {
                // Bug #11: every Flag the player carries drops, wherever it sits.
                for (ItemStack flag : findFlags(player)) dropItem(player, flag);
            }
            return true; // allow the damage
        });
    }

    // make flag holders glow
    public static void glowFlagholders() {
        ServerTickEvents.START_WORLD_TICK.register((server) -> {
            for(var player : server.getPlayers()) {
                var hasFlag = checkInventory(player) != null;
                updateGlow(player, hasFlag);
            }
        });
        // Vanilla saves the glowing flag with the player. Clear a glow the mod owns before that save (DISCONNECT fires
        // before PlayerManager.remove saves; SERVER_STOPPING before saveAllPlayerData), or it comes back unowned.
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            if (GLOW.forget(handler.getPlayer().getUuid())) handler.getPlayer().setGlowing(false);
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            for (var player : server.getPlayerManager().getPlayerList()) {
                if (GLOW.forget(player.getUuid())) player.setGlowing(false);
            }
        });
    }

    /** The first Flag the player carries, or null. */
    public static ItemStack checkInventory(ServerPlayerEntity player) {
        List<ItemStack> flags = findFlags(player);
        return flags.isEmpty() ? null : flags.get(0);
    }

    /**
     * Every Flag banner in the main inventory, the armour slots (a banner can be worn on the head) and the offhand.
     * Bug #11: only {@code main} was scanned, so a Flag in the offhand or on the head bypassed the elytra ban, the
     * drop-on-hit and the glow.
     */
    public static List<ItemStack> findFlags(ServerPlayerEntity player) {
        var inv = player.getInventory();
        List<ItemStack> out = new ArrayList<>();
        for (var slots : List.of(inv.main, inv.armor, inv.offHand)) {
            for (var stack : slots) {
                if (!stack.isEmpty() && stack.getItem() instanceof net.minecraft.item.BannerItem
                        && FlagGlow.isFlagName(stack.getName().getString())) {
                    out.add(stack);
                }
            }
        }
        return out;
    }

    public static void dropItem(ServerPlayerEntity player, ItemStack item) {
        if (item == null || item.isEmpty()) {
            return;
        }
        // Make indestructible
        item.set(DataComponentTypes.UNBREAKABLE, new UnbreakableComponent(true));
        player.dropItem(item.copyAndEmpty(), true, false);
        
    }

    /** Bug #11: glow while carrying a Flag; clear only a glow this mod set (never another source's). */
    public static void updateGlow(ServerPlayerEntity player, boolean hasFlag) {
        switch (GLOW.update(player.getUuid(), hasFlag, player.isGlowing())) {
            case SET -> player.setGlowing(true);
            case CLEAR -> player.setGlowing(false);
            case NONE -> { }
        }
    }

}