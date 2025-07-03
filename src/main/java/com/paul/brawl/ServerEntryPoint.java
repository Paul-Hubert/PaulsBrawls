package com.paul.brawl;

import net.fabricmc.api.DedicatedServerModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ServerEntryPoint implements DedicatedServerModInitializer {

	public static final Logger LOGGER = LoggerFactory.getLogger("Gibber");

	@Override
	public void onInitializeServer() {
		
		Money.register();

		GibCommand.register();

		RevenueManager.register();

		SalaryScheduler.register();

		FlagManager.register();

		ChatBot.register();

		ChatCommand.register();

		ProofReceiver.commonRegister();

		ProofReceiver.register();

		TradeOffers.register();

	}

}