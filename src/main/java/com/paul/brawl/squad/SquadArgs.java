package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Parsing of the free text after {@code /bots order NAME} (docs/29 §9), Minecraft-free (SquadArgsTest).
 * <ul>
 *   <li>Tokens are split on spaces; a quoted string ("…" or '…') is one token, so {@code text="hello world"} or
 *       {@code "hello world"} carries spaces.</li>
 *   <li>A token starting with {@code @} names a bot to use (repeatable): only those bots may be granted.</li>
 *   <li>{@code --free} / {@code --reclaim} override every role's {@code take}.</li>
 *   <li>Everything else is passed on as is: positional values or {@code key=value}, which the runtime maps onto the
 *       command's parameters.</li>
 * </ul>
 */
public final class SquadArgs {

    /** The order's arguments: tokens for the manifest, bot filters, an optional take override ({@code null} = per role). */
    public record OrderArgs(List<String> tokens, List<String> filters, String take) {}

    public static final Pattern COMMAND_NAME = Pattern.compile("[a-z0-9][a-z0-9-]{1,31}");
    public static final Pattern BOT_NAME = Pattern.compile("[A-Za-z0-9_]{3,16}");

    private SquadArgs() {}

    /** Split on whitespace, keeping quoted runs together ({@code key="a b"} → {@code key=a b}). */
    public static List<String> tokenize(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        StringBuilder cur = new StringBuilder();
        char quote = 0;
        boolean any = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (quote != 0) {
                if (c == quote) quote = 0;
                else cur.append(c);
            } else if (c == '"' || c == '\'') {
                quote = c;
                any = true;
            } else if (Character.isWhitespace(c)) {
                if (any || cur.length() > 0) out.add(cur.toString());
                cur.setLength(0);
                any = false;
            } else {
                cur.append(c);
                any = true;
            }
        }
        if (any || cur.length() > 0) out.add(cur.toString());
        return out;
    }

    public static OrderArgs order(String text) {
        List<String> tokens = new ArrayList<>();
        List<String> filters = new ArrayList<>();
        String take = null;
        for (String t : tokenize(text)) {
            if (t.equals("--free")) take = "free";
            else if (t.equals("--reclaim")) take = "reclaim";
            else if (t.length() > 1 && t.startsWith("@") && BOT_NAME.matcher(t.substring(1)).matches()) filters.add(t.substring(1));
            else tokens.add(t);
        }
        return new OrderArgs(List.copyOf(tokens), List.copyOf(filters), take);
    }

    /** Player names separated by spaces or commas ({@code "Alice, Bob Carl"}). */
    public static List<String> names(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        for (String part : text.split("[\\s,]+")) {
            String p = part.trim();
            if (!p.isEmpty() && !out.contains(p)) out.add(p);
        }
        return out;
    }
}
