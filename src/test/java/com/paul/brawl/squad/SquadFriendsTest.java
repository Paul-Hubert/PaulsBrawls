package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;

class SquadFriendsTest {

    private static final UUID HUBERT = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID ALICE = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    private static final UUID BOB = UUID.fromString("00000000-0000-0000-0000-00000000000c");
    private static final UUID STRANGER = UUID.fromString("00000000-0000-0000-0000-00000000000d");

    private static String owner(UUID u, String name) {
        return "{\"uuid\":\"" + u + "\",\"name\":\"" + name + "\"}";
    }

    /** Archer1 and Guard1 are Hubert's; Shared is Hubert's and Alice's; Lone is Alice's; Other is Bob's. */
    private static SquadFriends roster() {
        JsonArray bots = JsonParser.parseString("["
            + "{\"name\":\"Archer1\",\"owners\":[" + owner(HUBERT, "PUALHubert") + "]},"
            + "{\"name\":\"Guard1\",\"owners\":[" + owner(HUBERT, "PUALHubert") + "]},"
            + "{\"name\":\"Shared\",\"owners\":[" + owner(HUBERT, "PUALHubert") + "," + owner(ALICE, "Alice") + "]},"
            + "{\"name\":\"Lone\",\"owners\":[" + owner(ALICE, "Alice") + "]},"
            + "{\"name\":\"Other\",\"owners\":[" + owner(BOB, "Bob") + "]}"
            + "]").getAsJsonArray();
        return SquadFriends.of(bots);
    }

    @Test
    void botsOfTheSameOwnerNeverHurtEachOther() {
        SquadFriends f = roster();
        assertTrue(f.spare("Archer1", "Guard1", null), "an arrow into a guard of the same owner");
        assertTrue(f.spare("Guard1", "Archer1", null), "a sweep into an archer of the same owner");
        assertTrue(f.spare("archer1", "GUARD1", null), "names are matched without case");
        assertTrue(f.spare("Lone", "Shared", null), "one shared owner is enough");
        assertTrue(f.spare("Shared", "Guard1", null));
    }

    @Test
    void aBotNeverHurtsItsOwnOwners() {
        SquadFriends f = roster();
        assertTrue(f.spare("Archer1", "PUALHubert", HUBERT));
        assertTrue(f.spare("Shared", "Alice", ALICE));
    }

    @Test
    void everythingElseStillTakesDamage() {
        SquadFriends f = roster();
        assertFalse(f.spare("Archer1", "Other", null), "a bot of another owner");
        assertFalse(f.spare("Archer1", "Lone", null), "Lone shares no owner with Archer1");
        assertFalse(f.spare("Archer1", "Alice", ALICE), "Alice does not own Archer1");
        assertFalse(f.spare("Archer1", "Stranger", STRANGER), "another player");
        assertFalse(f.spare("PUALHubert", "Archer1", null), "a player hitting a bot is not the bot's business");
        assertFalse(f.spare("Bob", "Other", null));
        assertFalse(f.spare(null, "Guard1", null));
        assertFalse(f.spare("Archer1", null, null));
    }

    @Test
    void anEmptyOrMalformedRosterSparesNobody() {
        assertSame(SquadFriends.EMPTY, SquadFriends.of(null));
        assertSame(SquadFriends.EMPTY, SquadFriends.of(new JsonArray()));
        assertFalse(SquadFriends.EMPTY.spare("Archer1", "Guard1", HUBERT));
        SquadFriends f = SquadFriends.of(JsonParser.parseString("[{\"owners\":[]},{\"name\":\"NoOwners\"},"
            + "{\"name\":\"BadUuid\",\"owners\":[{\"uuid\":\"nope\"}]},{\"name\":\"Ok\",\"owners\":[" + owner(HUBERT, "H") + "]},"
            + "{\"name\":\"Ok2\",\"owners\":[" + owner(HUBERT, "H") + "]}]").getAsJsonArray());
        assertTrue(f.isBot("NoOwners") && f.isBot("BadUuid") && f.isBot("ok"));
        assertFalse(f.spare("NoOwners", "Ok", null), "a bot with no owner protects nobody");
        assertFalse(f.spare("BadUuid", "Ok", HUBERT));
        assertTrue(f.spare("Ok", "Ok2", null), "the readable entries still count");
    }
}
