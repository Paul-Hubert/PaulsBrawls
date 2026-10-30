package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import org.junit.jupiter.api.Test;

class SquadKitsTest {

    private static Set<String> ids(String kit, SquadKits.Slot slot) {
        return SquadKits.find(kit).orElseThrow().items().stream().filter(i -> i.slot() == slot).map(SquadKits.Item::id)
            .collect(Collectors.toSet());
    }

    @Test
    void guardWearsIronAndHoldsASwordAndAShield() {
        assertEquals(Set.of("iron_helmet"), ids("guard", SquadKits.Slot.HEAD));
        assertEquals(Set.of("iron_chestplate"), ids("guard", SquadKits.Slot.CHEST));
        assertEquals(Set.of("iron_leggings"), ids("guard", SquadKits.Slot.LEGS));
        assertEquals(Set.of("iron_boots"), ids("guard", SquadKits.Slot.FEET));
        assertEquals(Set.of("iron_sword"), ids("guard", SquadKits.Slot.MAINHAND));
        assertEquals(Set.of("shield"), ids("guard", SquadKits.Slot.OFFHAND));
    }

    @Test
    void archerWearsChainmailAndHoldsABowWithArrows() {
        for (SquadKits.Slot s : List.of(SquadKits.Slot.HEAD, SquadKits.Slot.CHEST, SquadKits.Slot.LEGS, SquadKits.Slot.FEET)) {
            assertTrue(ids("archer", s).iterator().next().startsWith("chainmail_"), s.name());
        }
        assertEquals(Set.of("bow"), ids("archer", SquadKits.Slot.MAINHAND));
        assertTrue(ids("archer", SquadKits.Slot.INVENTORY).contains("arrow"));
    }

    @Test
    void everyKitHasAToolAndAtMostOneItemPerEquipmentSlot() {
        for (String name : SquadKits.NAMES) {
            SquadKits.Kit k = SquadKits.find(name).orElseThrow();
            assertEquals(1, ids(name, SquadKits.Slot.MAINHAND).size(), name);
            for (SquadKits.Slot s : SquadKits.Slot.values()) {
                if (s == SquadKits.Slot.INVENTORY) continue;
                assertTrue(k.items().stream().filter(i -> i.slot() == s).count() <= 1, name + " " + s);
            }
            assertTrue(k.items().stream().allMatch(i -> i.id().matches("[a-z_]+") && i.count() >= 1 && i.count() <= 64), name);
        }
        assertEquals(SquadKits.KITS.keySet(), Set.copyOf(SquadKits.NAMES));
    }

    @Test
    void kitTagsReplaceEachOther() {
        assertEquals(List.of("-archer", "-miner", "-farmer", "+guard"), SquadKits.tagChanges(SquadKits.find("Guard").orElseThrow()));
    }
}
