package com.paul.brawl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.fabricmc.fabric.api.entity.event.v1.EntityElytraEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.UnbreakableComponent;
import net.minecraft.item.ItemStack;
import net.minecraft.server.network.ServerPlayerEntity;

public class FlagManager {
    
    public static final Logger LOGGER = LoggerFactory.getLogger("FlagManager");

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
                var item = checkInventory(player);
                dropItem(player, item);
            }
            return true; // allow the damage
        });
    }

    // ban elytra
    public static void glowFlagholders() {
        ServerTickEvents.START_WORLD_TICK.register((server) -> {
            for(var player : server.getPlayers()) {

                var hasFlag = checkInventory(player) != null;
                updateGlow(player, hasFlag);
            }
        });
    }

    public static ItemStack checkInventory(ServerPlayerEntity player) {
        
        for (var stack : player.getInventory().main) {
            if (!stack.isEmpty() && stack.getItem() instanceof net.minecraft.item.BannerItem) {
                if (stack.getName().getString().contains("Flag")) {
                    return stack;
                }
            }
        }

        return null;
    }

    public static void dropItem(ServerPlayerEntity player, ItemStack item) {
        if (item == null || item.isEmpty()) {
            return;
        }
        // Make indestructible
        item.set(DataComponentTypes.UNBREAKABLE, new UnbreakableComponent(true));
        player.dropItem(item.copyAndEmpty(), true, false);
        
    }

    public static void updateGlow(ServerPlayerEntity player, boolean b) {
        player.setGlowing(b);
    }

}