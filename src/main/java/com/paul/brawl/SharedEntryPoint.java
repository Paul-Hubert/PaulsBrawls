package com.paul.brawl;

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class SharedEntryPoint implements ModInitializer {

	public static final Logger LOGGER = LoggerFactory.getLogger("Gibber");

	@Override
	public void onInitialize() {

		ProofReceiver.commonRegister();

	}

}