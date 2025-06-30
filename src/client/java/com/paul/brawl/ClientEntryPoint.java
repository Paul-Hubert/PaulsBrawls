package com.paul.brawl;

import net.fabricmc.api.ClientModInitializer;

public class ClientEntryPoint implements ClientModInitializer {
	@Override
	public void onInitializeClient() {

		ProofReceiver.commonRegister();

		Screenshotter.register();

		Money.register();

	}
}