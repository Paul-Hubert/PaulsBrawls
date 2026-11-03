package com.paul.brawl;

import com.paul.brawl.compat.Compat;

import net.minecraft.world.item.Item;

public class Money {
    
    public static Item MONEY;

    public static void register() {
        
        registerCoinItem();

    }

    public static void registerCoinItem() {
        MONEY = Compat.registerItem("paulsbrawls", "coin", new Item.Properties().stacksTo(99));
    }

} 