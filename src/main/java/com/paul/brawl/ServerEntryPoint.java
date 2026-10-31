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
		// Before any JDK HttpServer exists (:8767 settlement, :8771 MCP): the JDK reads this once (JdkHttpServers).
		JdkHttpServers.tcpNoDelay();

		// Money
		GibCommand.register();

		RevenueManager.register();

		SalaryScheduler.register();

		Money.register();



		// Squad friendly fire (docs/29): before FlagManager, so a cancelled hit between bots of one owner drops no Flag.
		com.paul.brawl.squad.Squad.registerFriendlyFire();

		FlagManager.register();

		ChatBot.register();

		// God-Body wiring (see GOD_BOT_INTEGRATION_PLAN.md §7, §6c, §8)
		GodActionQueue.register();
		GodScheduler.register();

		// AI village (see VILLAGE_PLAN.md): trade settlement + admin command.
		VillageCommand.register();

		// Eden village — scenario control (/villagers start|stop|restart).
		VillagersCommand.register();

		// Squad (docs/29): player-owned bots, /bots, a thin front over the squad runtime (squad/).
		com.paul.brawl.squad.SquadCommand.register();
		// Orders bound to items (docs/29 §5.4): the right-click, the arrow released and its first hit (with the mixin).
		com.paul.brawl.squad.SquadTriggers.register();

		// Track the live server so off-thread callers (idle watchdog) can
		// reach the bot without holding a player reference.
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			ChatBotActions.setServer(server);
			LOGGER.info("BridgeConfig loaded: {}", BridgeConfig.INSTANCE.describe());
			VillageHttpListener.start(server);
			// docs/27: the god/builder MCP servers, only when godAgent = external.
			ExternalAgent.start();
			com.paul.brawl.squad.Squad.start(server);
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			GodActionQueue.clear();
			// Bug #5: SERVER_STOPPING runs on the server thread before players are saved,
			// so the cleared flag is what lands in the avatar's player data.
			ChatBotActions.restoreAvatarOnMain(server);
			BuildGuard.cancelAll(); // bug #7: no sub-build keeps placing into a stopping world
			GodSessionManager.forceEndSession();
			ExternalAgent.stop();
			com.paul.brawl.squad.Squad.stop();
			ChatBotActions.setServer(null);
			VillageHttpListener.stop();
		});

		// Op bots on join so they can run /tp, /spreadplayers, /give, etc.
		// Covers: the God-body avatar (LLMBot), Eden's avatar (Dieu), and any
		// active scenario villager bots (populated by /villagers start|restart).
		// Squad bots: the join gate (a bot's name from elsewhere is kicked), arrival next to the admin, missed lines.
		// Squad bots are never op'd: they are not in the list below.
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			var player = handler.getPlayer();
			if (player != null) com.paul.brawl.squad.Squad.onJoin(player, handler::disconnect);
		});

		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			var player = handler.getPlayer();
			if (player == null) return;
			String name = player.getName().getString();
			boolean shouldOp = name.equals(BridgeConfig.INSTANCE.botUsername)
				|| name.equals(VillageConfig.INSTANCE.edenAvatarName)
				|| VillagersCommand.activeScenarioBots.contains(name);
			if (!shouldOp) return;
			GameProfile profile = player.getGameProfile();
			if (!server.getPlayerManager().isOperator(profile)) {
				server.getPlayerManager().addToOperators(profile);
				LOGGER.info("Opped bot '{}' on join.", name);
			}
		});
	}

}