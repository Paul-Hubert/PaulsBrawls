package com.paul.brawl;

/**
 * What a world-layer call ({@link GodService}, {@link BuildService}) did: the text the model reads, and whether the
 * call was <b>refused</b> — nothing happened, or not what was asked (bad argument, unknown item/entity/block, owner
 * gate, offline player, a placement that did not complete…). A clamp is not a refusal: the effect happened, and the
 * text says by how much it was limited.
 *
 * <p>The builtin ChatBot reads only {@link #text()} (unchanged texts); the MCP servers turn a refusal into an
 * {@code isError: true} tool result, so an external agent can tell "done" from "refused" without parsing French or
 * English prose.
 */
public record WorldOutcome(String text, boolean refused) {

    public WorldOutcome {
        text = text == null ? "" : text;
    }

    public static WorldOutcome done(String text) {
        return new WorldOutcome(text, false);
    }

    public static WorldOutcome refused(String text) {
        return new WorldOutcome(text, true);
    }

    public boolean ok() {
        return !refused;
    }
}
