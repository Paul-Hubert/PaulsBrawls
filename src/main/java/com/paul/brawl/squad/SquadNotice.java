package com.paul.brawl.squad;

import com.google.gson.JsonObject;

/**
 * A line for a player, Minecraft-free: French text and an optional clickable suffix ({@code [Corriger]},
 * {@code /bots order defend}). {@code run} = the click runs the command; otherwise it is put in the chat box.
 */
public record SquadNotice(String text, String clickLabel, String clickCommand, boolean run, String hover) {

    public static SquadNotice of(String text) {
        return new SquadNotice(text, null, null, false, null);
    }

    public static SquadNotice suggest(String text, String label, String command, String hover) {
        return new SquadNotice(text, label, command, false, hover);
    }

    public boolean hasClick() {
        return clickLabel != null && clickCommand != null;
    }

    /** From the runtime's JSON: {@code {text, click?: {label, command, run?}}}. */
    public static SquadNotice fromJson(JsonObject o) {
        String text = o.has("text") && !o.get("text").isJsonNull() ? o.get("text").getAsString() : "";
        if (o.has("click") && o.get("click").isJsonObject()) {
            JsonObject c = o.getAsJsonObject("click");
            String label = c.has("label") ? c.get("label").getAsString() : null;
            String cmd = c.has("command") ? c.get("command").getAsString() : null;
            boolean run = c.has("run") && c.get("run").getAsBoolean();
            return new SquadNotice(text, label, cmd, run, null);
        }
        return of(text);
    }
}
