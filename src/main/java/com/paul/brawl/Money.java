package com.paul.brawl;

import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;

public class Money {
    
    public static Item MONEY;

    public static void register() {
        
        registerCoinItem();

    }

    public static void registerCoinItem() {
        MONEY = Registry.register(
			Registries.ITEM,
			Identifier.of("paulsbrawls", "coin"),
			new Item(new Item.Settings().maxCount(99))
		);
    }

} 