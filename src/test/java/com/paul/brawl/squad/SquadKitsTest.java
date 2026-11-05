package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
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
    void archersBowHasInfinityAndUnbreakingThreeAndStillComesWithArrows() {
        SquadKits.Item bow = SquadKits.find("archer").orElseThrow().items().stream()
            .filter(i -> i.slot() == SquadKits.Slot.MAINHAND).findFirst().orElseThrow();
        assertEquals(Map.of("infinity", 1, "unbreaking", 3), bow.enchantments());
        // Infinity needs at least one arrow in the inventory.
        assertTrue(SquadKits.find("archer").orElseThrow().items().stream().anyMatch(i -> i.id().equals("arrow") && i.count() >= 1));
        // Nothing else in any kit is enchanted.
        for (String name : SquadKits.NAMES) {
            for (SquadKits.Item i : SquadKits.find(name).orElseThrow().items()) {
                if (i != bow && !i.id().equals("bow")) assertTrue(i.enchantments().isEmpty(), name + " " + i.id());
            }
        }
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
            assertTrue(k.items().stream().allMatch(i -> i.id().matches("[a-z_|]+") && i.count() >= 1 && i.count() <= 64), name);
            assertTrue(k.items().stream().flatMap(i -> i.enchantments().entrySet().stream())
                .allMatch(e -> e.getKey().matches("[a-z_]+") && e.getValue() >= 1 && e.getValue() <= 255), name);
        }
        assertEquals(SquadKits.KITS.keySet(), Set.copyOf(SquadKits.NAMES));
    }

    @Test
    void pluralNamesFindTheKit() {
        assertEquals("guard", SquadKits.find("guards").orElseThrow().name());
        assertEquals("archer", SquadKits.find("Archers").orElseThrow().name());
        assertEquals("miner", SquadKits.find("miners").orElseThrow().name());
        assertEquals("farmer", SquadKits.find("FARMERS").orElseThrow().name());
        assertTrue(SquadKits.find("wizards").isEmpty());
        assertTrue(SquadKits.find("s").isEmpty());
        assertTrue(SquadKits.find(null).isEmpty());
    }

    @Test
    void aRespawnedBotGetsTheCommandsKitElseItsKitTagElseNone() {
        SquadKits.Kit guard = SquadKits.find("guard").orElseThrow();
        SquadKits.Kit archer = SquadKits.find("archer").orElseThrow();
        assertEquals(guard, SquadKits.forReset(java.util.Optional.of(guard), List.of("archer")).orElseThrow(), "the command's kit");
        assertEquals(archer, SquadKits.forReset(java.util.Optional.empty(), List.of("scout", "archer")).orElseThrow(), "its kit tag");
        assertTrue(SquadKits.forReset(java.util.Optional.empty(), List.of("scout")).isEmpty(), "no kit tag: none");
        assertTrue(SquadKits.forReset(java.util.Optional.empty(), List.of()).isEmpty());
    }

    @Test
    void spearmanAndHorsemanCarrySpearsAndOnlyMountedKitsRide() {
        assertEquals(Set.of("shield"), ids("spearman", SquadKits.Slot.OFFHAND));
        assertTrue(ids("horseman", SquadKits.Slot.OFFHAND).isEmpty(), "no shield");
        assertEquals(ids("spearman", SquadKits.Slot.MAINHAND), ids("horseman", SquadKits.Slot.MAINHAND));
        assertEquals(Set.of("bow"), ids("horsearcher", SquadKits.Slot.MAINHAND));
        assertTrue(SquadKits.find("horseman").orElseThrow().mounted());
        assertTrue(SquadKits.find("horsearcher").orElseThrow().mounted());
        assertTrue(!SquadKits.find("spearman").orElseThrow().mounted());
        assertTrue(!SquadKits.find("guard").orElseThrow().mounted());
        assertEquals("horseman", SquadKits.find("horsemen".replace("men", "man") + "s").orElseThrow().name());
    }

    @Test
    void kitTagsReplaceEachOther() {
        assertEquals(List.of("-archer", "-miner", "-farmer", "-spearman", "-horseman", "-horsearcher", "+guard"), SquadKits.tagChanges(SquadKits.find("Guard").orElseThrow()));
    }
}
