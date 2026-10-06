package com.paul.brawl;

/**
 * A world port (docs/27 §5) refusing an effect it cannot apply: the player went offline, an item or block id does
 * not resolve, the main thread did not run the action in time. The message is the text the model reads, in French
 * where a player could see it. Never thrown for a programming error.
 */
public class WorldRefusal extends RuntimeException {
    public WorldRefusal(String message) {
        super(message, null, false, false);
    }
}
