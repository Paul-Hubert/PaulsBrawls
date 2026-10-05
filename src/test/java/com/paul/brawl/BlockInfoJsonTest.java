package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.Test;

class BlockInfoJsonTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void emitsAnArrayAStrictParserAccepts() throws Exception {
        String json = new BlockInfoJson().add(-1, 1, 0, "minecraft:stone").add(0, 0, 1, "minecraft:grass_block").toJson();
        JsonNode arr = MAPPER.readTree(json); // bug #18: the old pseudo-JSON could not be parsed at all
        assertEquals(2, arr.size());
        assertEquals(-1, arr.get(0).get("x").asInt());
        assertEquals("minecraft:grass_block", arr.get(1).get("block").asText());
    }

    @Test
    void emptyIsAnEmptyArray() throws Exception {
        assertEquals(0, MAPPER.readTree(new BlockInfoJson().toJson()).size());
    }

    @Test
    void ids_areEscaped() throws Exception {
        String json = new BlockInfoJson().add(0, 0, 0, "weird\"id\\").toJson();
        assertEquals("weird\"id\\", MAPPER.readTree(json).get(0).get("block").asText());
    }
}
