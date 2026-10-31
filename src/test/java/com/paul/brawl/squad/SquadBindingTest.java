package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import java.util.function.Function;

import org.junit.jupiter.api.Test;

import net.minecraft.nbt.NbtCompound;

/** The binding's pure parts: the bind line, the lore line and its removal, the custom-data form (no bootstrap). */
class SquadBindingTest {

    @Test
    void bindLineSplitsTheOrderFromTheRestKeptAsTyped() {
        assertEquals(new SquadBinding.BindLine("mur-de-boucliers", ""), SquadBinding.parse("  mur-de-boucliers ").orElseThrow());
        assertEquals(new SquadBinding.BindLine("tir", "volley=5  @Archer1 --free"),
            SquadBinding.parse("tir   volley=5  @Archer1 --free ").orElseThrow());
        assertEquals("text=\"a b\"", SquadBinding.parse("ma-cmd text=\"a b\"").orElseThrow().rest());
        assertTrue(SquadBinding.parse("   ").isEmpty());
        assertTrue(SquadBinding.parse(null).isEmpty());
    }

    @Test
    void orderNamesAreNameOrAuthorColonName() {
        assertTrue(SquadBinding.validOrder("epee"));
        assertTrue(SquadBinding.validOrder("mur-de-boucliers"));
        assertTrue(SquadBinding.validOrder("PUALHubert:garde-2"));
        assertTrue(SquadBinding.validOrder("squad:tir"));
        assertTrue(SquadBinding.validOrder("Defend")); // the runtime lower-cases it
        assertFalse(SquadBinding.validOrder("a"));
        assertFalse(SquadBinding.validOrder("-x"));
        assertFalse(SquadBinding.validOrder("a:b:c"));
        assertFalse(SquadBinding.validOrder(":tir"));
        assertFalse(SquadBinding.validOrder("tir!"));
        assertFalse(SquadBinding.validOrder("x".repeat(33)));
        assertFalse(SquadBinding.validOrder(null));
    }

    @Test
    void loreLineNamesTheOrderAndItsLineAndIsCut() {
        assertEquals("Ordre : mur-de-boucliers", SquadBinding.loreFor("mur-de-boucliers", ""));
        assertEquals("Ordre : mur-de-boucliers spacing=2", SquadBinding.loreFor("mur-de-boucliers", " spacing=2 "));
        String longLore = SquadBinding.loreFor("tir", "x".repeat(100));
        assertEquals(SquadBinding.MAX_LORE, longLore.length());
        assertTrue(longLore.startsWith("Ordre : tir xxx") && longLore.endsWith("…"));
    }

    @Test
    void unbindRemovesOnlyTheLastLineWithTheBindsText() {
        Function<String, String> id = s -> s;
        String ours = "Ordre : epee";
        assertEquals(List.of("Forgée par Paul"), SquadBinding.withoutLore(List.of("Forgée par Paul", ours), id, ours));
        // A player's own identical line above ours stays; ours (appended last) goes.
        assertEquals(List.of(ours, "x"), SquadBinding.withoutLore(List.of(ours, "x", ours), id, ours));
        assertEquals(List.of("a", "b"), SquadBinding.withoutLore(List.of("a", "b"), id, ours));
        assertEquals(List.of(), SquadBinding.withoutLore(List.of(ours), id, ours));
        assertEquals(List.of("a"), SquadBinding.withoutLore(List.of("a"), id, ""));
    }

    @Test
    void customDataRoundTripsAndKeepsOtherKeys() {
        SquadBinding b = new SquadBinding("PUALHubert:garde", "radius=8 @Guard1 --reclaim", true, "Ordre : PUALHubert:garde radius=8 @Guard1 --reclaim");
        NbtCompound data = new NbtCompound();
        data.putString("other", "kept");
        data.put(SquadBinding.KEY, b.toNbt());
        assertEquals(Optional.of(b), SquadBinding.fromCustomData(data));
        assertEquals("kept", data.getString("other"));

        data.remove(SquadBinding.KEY); // what clear() does, through NbtComponent.set
        assertTrue(SquadBinding.fromCustomData(data).isEmpty());
        assertFalse(data.isEmpty());
    }

    @Test
    void customDataWithoutAnOrderIsNoBinding() {
        assertTrue(SquadBinding.fromCustomData(null).isEmpty());
        assertTrue(SquadBinding.fromCustomData(new NbtCompound()).isEmpty());
        NbtCompound wrongType = new NbtCompound();
        wrongType.putString(SquadBinding.KEY, "epee");
        assertTrue(SquadBinding.fromCustomData(wrongType).isEmpty());
        NbtCompound blank = new NbtCompound();
        NbtCompound inner = new NbtCompound();
        inner.putString("order", " ");
        blank.put(SquadBinding.KEY, inner);
        assertTrue(SquadBinding.fromCustomData(blank).isEmpty());
        // Missing fields read as defaults: a hand-edited binding with only an order still works.
        NbtCompound minimal = new NbtCompound();
        NbtCompound only = new NbtCompound();
        only.putString("order", "epee");
        minimal.put(SquadBinding.KEY, only);
        assertEquals(Optional.of(new SquadBinding("epee", "", false, "")), SquadBinding.fromCustomData(minimal));
    }
}
