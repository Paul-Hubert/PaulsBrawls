package com.paul.brawl.squad;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The kits of {@code /bots equip BOT KIT} (docs/29 §9): what a bot gets for its role, so admins never have to
 * {@code /give} item by item. Minecraft-free data (SquadKitsTest); {@link Squad#equip} applies it on the main thread.
 * A kit also tags the bot with its name (and removes the other kit tags), so a command can select
 * {@code { tag: 'archer' }}.
 */
public final class SquadKits {

    /** Where an item goes: an armor slot, a hand, or the inventory. */
    public enum Slot { HEAD, CHEST, LEGS, FEET, MAINHAND, OFFHAND, INVENTORY }

    /**
     * One stack of a kit. {@code enchantments}: enchantment id (minecraft namespace) → level; {@link Squad#equip}
     * looks each one up in the server's enchantment registry (a dynamic registry since 1.21).
     */
    public record Item(Slot slot, String id, int count, Map<String, Integer> enchantments) {
        public Item {
            enchantments = Map.copyOf(enchantments);
        }

        public Item(Slot slot, String id, int count) {
            this(slot, id, count, Map.of());
        }
    }

    public record Kit(String name, String label, List<Item> items) {}

    private static Item at(Slot slot, String id) {
        return new Item(slot, id, 1);
    }

    private static Item inv(String id, int count) {
        return new Item(Slot.INVENTORY, id, count);
    }

    private static Item enchanted(Item it, Map<String, Integer> enchantments) {
        return new Item(it.slot(), it.id(), it.count(), enchantments);
    }

    /**
     * The archer's bow (Paul, 2026-11-01: « infinity and unbreakable 3 »): Infinity, so archers never run out (a {@code
     * tir} click used about 9 arrows per archer, from a kit of 64), and Unbreaking III. Infinity still needs one arrow
     * in the inventory: the kit keeps its 64, and a plain bow still works with them. Raiders get it too.
     */
    static final Map<String, Integer> ARCHER_BOW = Map.of("infinity", 1, "unbreaking", 3);

    public static final Map<String, Kit> KITS = Map.of(
        "archer", new Kit("archer", "archer", List.of(
            at(Slot.HEAD, "chainmail_helmet"), at(Slot.CHEST, "chainmail_chestplate"),
            at(Slot.LEGS, "chainmail_leggings"), at(Slot.FEET, "chainmail_boots"),
            enchanted(at(Slot.MAINHAND, "bow"), ARCHER_BOW), inv("arrow", 64), inv("stone_sword", 1), inv("cooked_beef", 16))),
        "guard", new Kit("guard", "garde", List.of(
            at(Slot.HEAD, "iron_helmet"), at(Slot.CHEST, "iron_chestplate"),
            at(Slot.LEGS, "iron_leggings"), at(Slot.FEET, "iron_boots"),
            at(Slot.MAINHAND, "iron_sword"), at(Slot.OFFHAND, "shield"), inv("cooked_beef", 16))),
        "miner", new Kit("miner", "mineur", List.of(
            at(Slot.MAINHAND, "iron_pickaxe"), inv("iron_shovel", 1), inv("iron_axe", 1),
            inv("torch", 32), inv("cooked_beef", 16))),
        "farmer", new Kit("farmer", "fermier", List.of(
            at(Slot.MAINHAND, "iron_hoe"), inv("wheat_seeds", 32), inv("bone_meal", 32),
            inv("water_bucket", 1), inv("bread", 16))));

    /** Kit names, for tab completion and the usage line. */
    public static final List<String> NAMES = List.of("archer", "guard", "miner", "farmer");

    private SquadKits() {}

    public static Optional<Kit> find(String name) {
        return Optional.ofNullable(name == null ? null : KITS.get(name.toLowerCase(java.util.Locale.ROOT)));
    }

    /** Tag changes for the runtime: drop every kit tag, add this kit's. */
    public static List<String> tagChanges(Kit kit) {
        List<String> out = new java.util.ArrayList<>();
        for (String n : NAMES) if (!n.equals(kit.name())) out.add("-" + n);
        out.add("+" + kit.name());
        return out;
    }
}
