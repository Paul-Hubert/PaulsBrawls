package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

class SquadStatusFormatTest {

    private static JsonObject json(String s) {
        return JsonParser.parseString(s).getAsJsonObject();
    }

    private static final String BOTS = "[{\"name\":\"Archer1\",\"status\":\"online\",\"ticksPerSec\":20},"
        + "{\"name\":\"Brute\",\"status\":\"online\",\"ticksPerSec\":15.24},"
        + "{\"name\":\"Late\",\"status\":\"online\",\"ticksPerSec\":null},"
        + "{\"name\":\"Gone\",\"status\":\"offline\",\"ticksPerSec\":null}]";

    @Test
    void showsEluLoopP99AndTheSlowestBotInFrench() {
        JsonObject r = json("{\"ok\":true,\"text\":\"long line\",\"window\":{\"seconds\":10,\"endedAt\":1,\"complete\":true},"
            + "\"loop\":{\"p50\":12.3,\"p99\":75.4,\"max\":178},\"elu\":0.654,\"cpuPct\":70.8,\"rssMb\":412,\"heapMb\":150,"
            + "\"skippedPackets\":0,\"bots\":" + BOTS + "}");
        assertEquals("[Bots] Runtime (10 s) : ELU 0,65 · boucle p99 75 ms · bot le plus lent : Brute à 15,2 ticks/s.",
            SquadStatusFormat.format(r));
    }

    @Test
    void anOverloadedLoopSaysSo() {
        JsonObject eluHigh = json("{\"ok\":true,\"loop\":{\"p99\":40},\"elu\":0.95,\"bots\":" + BOTS + "}");
        assertEquals("[Bots] Runtime : ELU 0,95 · boucle p99 40 ms · bot le plus lent : Brute à 15,2 ticks/s — surchargé : les bots ralentissent.",
            SquadStatusFormat.format(eluHigh));
        JsonObject p99High = json("{\"ok\":true,\"loop\":{\"p99\":429.6},\"elu\":0.5,\"bots\":[]}");
        assertEquals("[Bots] Runtime : ELU 0,50 · boucle p99 430 ms · aucun bot en ligne — surchargé : les bots ralentissent.",
            SquadStatusFormat.format(p99High));
    }

    @Test
    void botsNotMeasuredYetAndTheFirstWindow() {
        JsonObject one = json("{\"ok\":true,\"window\":{\"seconds\":3.2,\"complete\":false},\"loop\":{\"p99\":3},\"elu\":0.05,"
            + "\"bots\":[{\"name\":\"Late\",\"status\":\"online\",\"ticksPerSec\":null}]}");
        assertEquals("[Bots] Runtime (3 s, mesure en cours) : ELU 0,05 · boucle p99 3 ms · 1 bot en ligne, pas encore mesuré.",
            SquadStatusFormat.format(one));
        JsonObject two = json("{\"ok\":true,\"loop\":{\"p99\":3},\"elu\":0.05,\"bots\":[{\"name\":\"A\",\"status\":\"online\"},{\"name\":\"B\",\"status\":\"online\"}]}");
        assertEquals("[Bots] Runtime : ELU 0,05 · boucle p99 3 ms · 2 bots en ligne, pas encore mesurés.", SquadStatusFormat.format(two));
    }

    @Test
    void aFailedAnswerShowsItsOwnText() {
        assertEquals(SquadClient.UNREACHABLE, SquadStatusFormat.format(SquadClient.failure(SquadClient.UNREACHABLE)));
        assertEquals("[Bots] Erreur du runtime : no route /api/metrics",
            SquadStatusFormat.format(json("{\"ok\":false,\"text\":\"[Bots] Erreur du runtime : no route /api/metrics\"}")));
        // ok but without the numbers (a runtime from before the route): its text, or a generic line.
        assertEquals("squad up", SquadStatusFormat.format(json("{\"ok\":true,\"text\":\"squad up\"}")));
        assertEquals("[Bots] Réponse illisible du runtime.", SquadStatusFormat.format(json("{\"ok\":true}")));
        assertEquals(SquadClient.UNREACHABLE, SquadStatusFormat.format(null));
    }
}
