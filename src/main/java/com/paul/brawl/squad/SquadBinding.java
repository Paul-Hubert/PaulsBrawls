package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Pattern;

import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.LoreComponent;
import net.minecraft.component.type.NbtComponent;
import net.minecraft.item.ItemStack;
import net.minecraft.item.RangedWeaponItem;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.nbt.NbtElement;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

/**
 * An order bound to an item stack (docs/29 §5.4 item 1), stored in {@code minecraft:custom_data} as
 * {@code squad: {order, line, glint, lore}}. On the stack because the binding travels with the item, two shields can
 * carry two orders, and it survives a runtime restart; the runtime stays the only writer of squad state.
 * <ul>
 *   <li>{@code order}: the canonical name {@code /api/orders/check} answered (stock name, else {@code author:name}),
 *       so a given item still means the binder's command.</li>
 *   <li>{@code line}: the rest of the bind line as typed (args, {@code @bot} filters, take flags), parsed by
 *       {@link SquadArgs#order} at each click.</li>
 *   <li>{@code glint} and {@code lore} record what the bind added (the glint override, one lore line), so
 *       {@link #clear} removes exactly that and nothing the item had before.</li>
 * </ul>
 * The record, its NBT form, the lore list edit and the bind-line parsing are tested without a Minecraft bootstrap
 * (SquadBindingTest); the stack methods are the thin part around them.
 */
public record SquadBinding(String order, String line, boolean glint, String lore) {

    public static final String KEY = "squad";
    /** A lore line longer than this is cut (a long bind line would make a very wide tooltip). */
    static final int MAX_LORE = 60;
    /** {@code name} or {@code author:name}, as {@code /bots order} accepts it (the runtime lower-cases both). */
    static final Pattern ORDER_REF = Pattern.compile("(?:[A-Za-z0-9_]{1,16}:)?[A-Za-z0-9][A-Za-z0-9-]{1,31}");

    /** {@code /bots orders bind <order> [args…]}: the order token, and the rest kept as typed. */
    public record BindLine(String order, String rest) {}

    // -- pure parts (JUnit) -----------------------------------------------------------------------------------------

    /** The first token is the order, the rest is the line (trimmed); empty when no order was typed. */
    static Optional<BindLine> parse(String typed) {
        String t = typed == null ? "" : typed.trim();
        if (t.isEmpty()) return Optional.empty();
        int sp = indexOfSpace(t);
        return Optional.of(sp < 0 ? new BindLine(t, "") : new BindLine(t.substring(0, sp), t.substring(sp + 1).trim()));
    }

    static boolean validOrder(String token) {
        return token != null && ORDER_REF.matcher(token).matches();
    }

    /** « Ordre : mur-de-boucliers spacing=2 », cut to {@link #MAX_LORE} characters. */
    static String loreFor(String order, String line) {
        String s = "Ordre : " + order + (line == null || line.isBlank() ? "" : " " + line.trim());
        return s.length() <= MAX_LORE ? s : s.substring(0, MAX_LORE - 1) + "…";
    }

    /**
     * The lore lines without the one the bind added: the last line whose text is {@code lore} (a bind appends its
     * line, so a player's own identical line above it stays). Unchanged when there is none.
     */
    static <T> List<T> withoutLore(List<T> lines, Function<T, String> text, String lore) {
        List<T> out = new ArrayList<>(lines);
        if (lore == null || lore.isEmpty()) return out;
        for (int i = out.size() - 1; i >= 0; i--) {
            if (lore.equals(text.apply(out.get(i)))) {
                out.remove(i);
                break;
            }
        }
        return out;
    }

    NbtCompound toNbt() {
        NbtCompound n = new NbtCompound();
        n.putString("order", order);
        n.putString("line", line);
        n.putBoolean("glint", glint);
        n.putString("lore", lore);
        return n;
    }

    /** The binding in a custom-data compound, if it has a {@code squad} compound with an order. */
    static Optional<SquadBinding> fromCustomData(NbtCompound data) {
        if (data == null || !data.contains(KEY, NbtElement.COMPOUND_TYPE)) return Optional.empty();
        NbtCompound n = data.getCompound(KEY);
        String order = n.getString("order");
        if (order.isBlank()) return Optional.empty();
        return Optional.of(new SquadBinding(order, n.getString("line"), n.getBoolean("glint"), n.getString("lore")));
    }

    // -- the stack ----------------------------------------------------------------------------------------------------

    /** The stack's binding, if any (empty stacks and stacks without custom data have none). */
    public static Optional<SquadBinding> read(ItemStack stack) {
        if (stack == null || stack.isEmpty()) return Optional.empty();
        NbtComponent data = stack.get(DataComponentTypes.CUSTOM_DATA);
        if (data == null || !data.contains(KEY)) return Optional.empty();
        return fromCustomData(data.copyNbt());
    }

    /**
     * Bind the stack: a binding already there is cleared first, so a rebind leaves only the new one. Adds one lore
     * line (gold, not italic) and the glint override when the item has none of its own. Returns the binding stored.
     */
    public static SquadBinding write(ItemStack stack, String order, String line) {
        clear(stack);
        String lore = loreFor(order, line);
        boolean glint = !stack.contains(DataComponentTypes.ENCHANTMENT_GLINT_OVERRIDE);
        if (glint) stack.set(DataComponentTypes.ENCHANTMENT_GLINT_OVERRIDE, true);
        LoreComponent old = stack.getOrDefault(DataComponentTypes.LORE, LoreComponent.DEFAULT);
        if (old.lines().size() < LoreComponent.MAX_LORES) {
            stack.set(DataComponentTypes.LORE, old.with(Text.literal(lore).styled(s -> s.withColor(Formatting.GOLD).withItalic(false))));
        } else {
            lore = ""; // no room for our line: record none, so unbind removes none of the item's own
        }
        SquadBinding b = new SquadBinding(order, line == null ? "" : line.trim(), glint, lore);
        NbtComponent.set(DataComponentTypes.CUSTOM_DATA, stack, nbt -> nbt.put(KEY, b.toNbt()));
        return b;
    }

    /**
     * Remove the stack's binding: the {@code squad} key (the whole custom data when nothing else is left), the lore
     * line the bind added, and the glint override only if the bind added it. Returns what was removed.
     */
    public static Optional<SquadBinding> clear(ItemStack stack) {
        Optional<SquadBinding> b = read(stack);
        if (b.isEmpty()) return b;
        NbtComponent.set(DataComponentTypes.CUSTOM_DATA, stack, nbt -> nbt.remove(KEY));
        LoreComponent old = stack.get(DataComponentTypes.LORE);
        if (old != null) {
            List<Text> lines = withoutLore(old.lines(), Text::getString, b.get().lore());
            // Setting the item's default (no lines) drops the lore from the stack's changes, rather than marking it removed.
            if (lines.size() != old.lines().size()) stack.set(DataComponentTypes.LORE, lines.isEmpty() ? LoreComponent.DEFAULT : new LoreComponent(lines));
        }
        if (b.get().glint()) stack.remove(DataComponentTypes.ENCHANTMENT_GLINT_OVERRIDE);
        return b;
    }

    /** A bow or a crossbow: its trigger is the arrow it shoots, not the right-click (§5.4 item 4). */
    public static boolean isLauncher(ItemStack stack) {
        return stack != null && stack.getItem() instanceof RangedWeaponItem;
    }

    private static int indexOfSpace(String s) {
        for (int i = 0; i < s.length(); i++) if (Character.isWhitespace(s.charAt(i))) return i;
        return -1;
    }
}
