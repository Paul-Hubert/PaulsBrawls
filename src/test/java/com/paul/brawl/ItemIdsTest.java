package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class ItemIdsTest {

    @Test
    void componentSyntaxKeepsTheBaseId() {
        // The example the Reward tool advertises — splitting on ':' used to make it fail every time (bug #6).
        assertEquals("minecraft:enchanted_book",
            ItemIds.baseId("minecraft:enchanted_book[minecraft:enchantments={mending: 1, sharpness: 4}]"));
        assertEquals("minecraft:diamond_sword", ItemIds.baseId("minecraft:diamond_sword{Damage:3}"));
    }

    @Test
    void namespaceDefaultsToMinecraft() {
        assertEquals("minecraft:diamond", ItemIds.baseId("diamond"));
        assertEquals("minecraft:diamond", ItemIds.baseId("  Minecraft:Diamond "));
        assertEquals("paulsbrawls:coin", ItemIds.baseId("paulsbrawls:coin"));
    }

    @Test
    void blankIsNull() {
        assertNull(ItemIds.baseId(null));
        assertNull(ItemIds.baseId("   "));
        assertNull(ItemIds.baseId("[minecraft:enchantments={}]"));
    }
}
