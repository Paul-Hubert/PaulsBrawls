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

		int owed = GibberMath.owed(totalRevenue, currentRevenue);
		if (owed == 0) return;

		// Bug #10: giveItemStack's result was ignored and the player marked paid in full, so coins that did not
		// fit were lost. Insert max-size stacks and credit only what actually landed; the rest stays owed and is
		// paid on the next salary tick or login, once there is room.
		int inserted = 0;
		int left = owed;
		while (left > 0) {
			int n = Math.min(left, new ItemStack(Money.MONEY).getMaxCount());
			ItemStack stack = new ItemStack(Money.MONEY, n);
			player.getInventory().insertStack(stack); // shrinks `stack` to what did not fit
			int got = n - stack.getCount();
			inserted += got;
			left -= n;
			if (got < n) break; // inventory full
		}
		if (inserted > 0) state.setPlayerValue(uuid, GibberMath.paidAfter(currentRevenue, inserted));
		if (inserted < owed) {
			LOGGER.info("{}: inventory full, {} of {} coin(s) still owed", player.getName().getString(), owed - inserted, owed);
		}
	}

	public static void UpdateRevenueAll(MinecraftServer server) {
		for (var player : server.getPlayerManager().getPlayerList()) {
			updateRevenue(player.getUuid(), server);
		}
	}

}