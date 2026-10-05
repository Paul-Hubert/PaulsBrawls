package com.paul.brawl;

/**
 * Bug #6 — the registry id inside an item string. {@code getItemFromString} split on {@code ':'}, so the item-component
 * syntax the Reward tool advertises ({@code minecraft:enchanted_book[minecraft:enchantments={…}]}) and a bare
 * {@code diamond} both failed. Minecraft-free (ItemIdsTest).
 */
public final class ItemIds {
    private ItemIds() {}

    /** {@code "ns:path"} for an item string: components ({@code [...]}) and NBT ({@code {...}}) stripped, namespace
     *  defaulted to {@code minecraft}, lower-cased. {@code null} for a blank input. */
    public static String baseId(String itemString) {
        if (itemString == null) return null;
        String s = itemString.trim();
        int cut = s.length();
        int bracket = s.indexOf('[');
        if (bracket >= 0) cut = Math.min(cut, bracket);
        int brace = s.indexOf('{');
        if (brace >= 0) cut = Math.min(cut, brace);
        s = s.substring(0, cut).trim().toLowerCase(java.util.Locale.ROOT);
        if (s.isEmpty()) return null;
        return s.indexOf(':') >= 0 ? s : "minecraft:" + s;
    }
}
