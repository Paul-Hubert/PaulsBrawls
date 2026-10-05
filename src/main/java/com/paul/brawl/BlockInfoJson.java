package com.paul.brawl;

import java.util.ArrayList;
import java.util.List;

/**
 * Bug #18 — {@code getBlockInfo} used to emit pseudo-JSON ({@code "{x:0, y:1, z:0, block: minecraft:stone,} … ]}, an
 * unbalanced leading quote, no separators, unquoted keys and values). This builds a real JSON array of
 * {@code {"x":…,"y":…,"z":…,"block":"ns:id"}} objects. Minecraft-free (BlockInfoJsonTest parses the output).
 */
public final class BlockInfoJson {
    private final List<String> entries = new ArrayList<>();

    /** Add one surface block at an offset from the pivot. */
    public BlockInfoJson add(int x, int y, int z, String blockId) {
        entries.add("{\"x\":" + x + ",\"y\":" + y + ",\"z\":" + z + ",\"block\":\"" + escape(blockId) + "\"}");
        return this;
    }

    /** The JSON array, one entry per line. */
    public String toJson() {
        return entries.isEmpty() ? "[]" : "[\n" + String.join(",\n", entries) + "\n]";
    }

    private static String escape(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length());
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.toString();
    }
}
