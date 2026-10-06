package com.paul.brawl;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Stands in for the Node Mineflayer server behind MCPGateway: one tool, calls recorded. */
class RecordingBodyTools implements BodyTools {

    final List<String> calls = Collections.synchronizedList(new ArrayList<>());

    @Override public List<Spec> list() {
        return List.of(new Spec("move-to-position", "Walk the avatar to x,y,z.",
            Map.of("type", "object", "properties", Map.of("x", Map.of("type", "number")))));
    }

    @Override public boolean has(String name) { return "move-to-position".equals(name); }

    @Override public String call(String name, String argumentsJson) {
        calls.add(name + " " + argumentsJson);
        return "moved";
    }
}
