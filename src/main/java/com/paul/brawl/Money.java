package com.paul.brawl;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.Item;

public class Money {
    
    public static Item MONEY;

    public static void register() {
        
        registerCoinItem();

    }

    public static void registerCoinItem() {
        MONEY = Registry.register(
			BuiltInRegistries.ITEM,
			ResourceLocation.fromNamespaceAndPath("paulsbrawls", "coin"),
			new Item(new Item.Properties().stacksTo(99))
		);
    }

} 