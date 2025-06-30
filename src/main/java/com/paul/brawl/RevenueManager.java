package com.paul.brawl;

import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.item.ItemStack;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class RevenueManager {

	public final static String TOTAL_REVENUE_KEY = "total_revenue";
	
	private static final Logger LOGGER = LoggerFactory.getLogger("Revenue_Manager");

	public static void register() {
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			ServerPlayerEntity player = handler.getPlayer();
			UUID uuid = player.getUuid();

			updateRevenue(uuid, server);
		});
	}

	public static void updateRevenue(UUID uuid, MinecraftServer server) {

		var player = server.getPlayerManager().getPlayer(uuid);
		if(player == null) {
			LOGGER.info("player is null");
			return;
		}	

		PlayerPersistentState state = PlayerPersistentState.getState(server);

		var totalRevenue = state.getGlobalValue(TOTAL_REVENUE_KEY);

		var currentRevenue = state.getPlayerValue(uuid);

		if (currentRevenue < totalRevenue) {
			int diff = totalRevenue - currentRevenue;

			// Give player items to get to the total required amount
			player.giveItemStack(new ItemStack(Money.MONEY, diff));
			state.setPlayerValue(uuid, totalRevenue);
		}
	}

	public static void UpdateRevenueAll(MinecraftServer server) {
		for (var player : server.getPlayerManager().getPlayerList()) {
			updateRevenue(player.getUuid(), server);
		}
	}

}