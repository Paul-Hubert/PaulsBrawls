package com.paul.brawl;

import com.mojang.authlib.GameProfile;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ServerEntryPoint implements DedicatedServerModInitializer {

	public static final Logger LOGGER = LoggerFactory.getLogger("Gibber");

	@Override
	public void onInitializeServer() {


		// Money
		GibCommand.register();

		RevenueManager.register();

		SalaryScheduler.register();

		Money.register();



		FlagManager.register();

		ChatBot.register();

		// God-Body wiring (see GOD_BOT_INTEGRATION_PLAN.md §7, §6c, §8)
		GodActionQueue.register();
		GodScheduler.register();

		// Track the live server so off-thread callers (idle watchdog) can
		// reach the bot without holding a player reference.
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			ChatBotActions.setServer(server);
			LOGGER.info("BridgeConfig loaded: {}", BridgeConfig.INSTANCE.describe());
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			GodActionQueue.clear();
			GodSessionManager.forceEndSession();
			ChatBotActions.setServer(null);
		});

		// Op the bot on join so it can run /tp. The check matches the
		// username at JOIN time so a bot that reconnects keeps its op.
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			var player = handler.getPlayer();
			if (player == null) return;
			String name = player.getName().getString();
			if (!name.equals(BridgeConfig.INSTANCE.botUsername)) return;
			GameProfile profile = player.getGameProfile();
			if (!server.getPlayerManager().isOperator(profile)) {
				server.getPlayerManager().addToOperators(profile);
				LOGGER.info("Opped god-body bot '{}' on join.", name);
			}
		});
	}

}