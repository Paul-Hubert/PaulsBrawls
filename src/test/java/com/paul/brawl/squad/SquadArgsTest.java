package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

class SquadArgsTest {

    @Test
    void tokensSplitOnSpacesAndKeepQuotedRuns() {
        assertEquals(List.of("oak_log", "32"), SquadArgs.tokenize("  oak_log   32 "));
        assertEquals(List.of("text=hello world", "x"), SquadArgs.tokenize("text=\"hello world\" x"));
        assertEquals(List.of("it's", "fine"), SquadArgs.tokenize("\"it's\" fine"));
        assertEquals(List.of(""), SquadArgs.tokenize("\"\""));
        assertTrue(SquadArgs.tokenize(null).isEmpty());
    }

    @Test
    void botFiltersAndTakeFlagsAreSeparated() {
        SquadArgs.OrderArgs a = SquadArgs.order("radius=12 @Archer1 @Brute_2 --reclaim 5");
        assertEquals(List.of("radius=12", "5"), a.tokens());
        assertEquals(List.of("Archer1", "Brute_2"), a.filters());
        assertEquals("reclaim", a.take());
        assertNull(SquadArgs.order("x").take());
        assertEquals("free", SquadArgs.order("--free").take());
        // "@" alone or an invalid bot name stays a plain token
        assertEquals(List.of("@", "@a"), SquadArgs.order("@ @a").tokens());
    }

    @Test
    void playerNamesAcceptCommasAndSpaces() {
        assertEquals(List.of("Alice", "Bob", "Carl"), SquadArgs.names("Alice, Bob  Carl,Alice"));
    }

    @Test
    void commandNames() {
        assertTrue(SquadArgs.COMMAND_NAME.matcher("defend-2").matches());
        assertTrue(!SquadArgs.COMMAND_NAME.matcher("Defend").matches());
        assertTrue(!SquadArgs.COMMAND_NAME.matcher("a").matches());
    }
}
