package com.paul.brawl.squad;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonObject;
import com.paul.brawl.AgentBackend;

/**
 * {@code /bots create NAME <request>} and {@code /bots fix NAME [feedback]} (docs/29 §8.1): one turn of the
 * {@code squad-author} agent. Minecraft-free (SquadAuthoringTest): players are UUIDs, lines go through a
 * {@link Teller}.
 * <ol>
 *   <li>The player's slot is reserved first (one authoring turn per player; {@code maxAuthoring} for everyone).</li>
 *   <li>The runtime opens the session ({@code POST /api/authoring/open}): it checks the name and ownership, mints the
 *       {@code cmd-…} ticket, and builds the agent's message (for a fix: the current code and the last report).</li>
 *   <li>The agent's turn runs in a fresh agent session (everything it needs is in the message).</li>
 *   <li>The session is closed ({@code POST /api/authoring/close}): the ticket dies and the runtime says what was
 *       submitted. Then the player gets « Commande NAME prête (vN) … /bots order NAME », the command clickable.</li>
 * </ol>
 */
public final class SquadAuthoring {

    private static final Logger LOGGER = LoggerFactory.getLogger("SquadAuthoring");

    /** How lines reach a player. */
    public interface Teller {
        void tell(UUID player, SquadNotice line);
    }

    private final SquadClient client;
    private final AgentBackend agent;
    private final Teller teller;
    private final String agentName;
    private final Duration turnTimeout;
    private final int maxConcurrent;
    private final Map<UUID, String> running = new ConcurrentHashMap<>(); // player → command name
    private final Map<UUID, String> agentSessions = new ConcurrentHashMap<>();
    private final AtomicInteger active = new AtomicInteger();

    public SquadAuthoring(SquadClient client, AgentBackend agent, Teller teller, String agentName, Duration turnTimeout, int maxConcurrent) {
        this.client = client;
        this.agent = agent;
        this.teller = teller;
        this.agentName = agentName;
        this.turnTimeout = turnTimeout;
        this.maxConcurrent = Math.max(1, maxConcurrent);
    }

    /** Start a turn. Returns the thread running it, or null when refused on the spot (the player was told why). */
    public Thread start(String mode, UUID player, String playerName, String name, String request, JsonObject snap) {
        String already = running.putIfAbsent(player, name);
        if (already != null) {
            teller.tell(player, SquadNotice.of("[Bots] « " + already + " » est déjà en cours d'écriture : attends qu'elle soit prête."));
            return null;
        }
        if (active.incrementAndGet() > maxConcurrent) {
            active.decrementAndGet();
            running.remove(player, name);
            teller.tell(player, SquadNotice.of("[Bots] Trop de commandes en cours d'écriture sur le serveur : réessaie dans quelques minutes."));
            return null;
        }
        return Thread.ofVirtual().name("squad-author-" + playerName).start(() -> {
            try {
                run(mode, player, playerName, name, request, snap);
            } catch (RuntimeException e) {
                LOGGER.warn("Authoring turn for {} ({}) crashed: {}", playerName, name, e.toString());
                teller.tell(player, SquadNotice.of("[Bots] « " + name + " » n'a pas pu être écrite : erreur interne."));
            } finally {
                agentSessions.remove(player);
                running.remove(player, name);
                active.decrementAndGet();
            }
        });
    }

    private void run(String mode, UUID player, String playerName, String name, String request, JsonObject snap) {
        JsonObject body = new JsonObject();
        body.addProperty("mode", mode);
        body.add("by", by(player, playerName));
        body.addProperty("name", name);
        body.addProperty("request", request == null ? "" : request);
        body.add("snap", snap == null ? new JsonObject() : snap);
        JsonObject open = await(client.post("/api/authoring/open", body));
        if (!ok(open) || !open.has("ticket")) {
            teller.tell(player, SquadNotice.fromJson(open));
            return;
        }
        String ticket = open.get("ticket").getAsString();
        String message = open.get("message").getAsString();
        teller.tell(player, SquadNotice.of("[Bots] " + ("fix".equals(mode) ? "Correction" : "Écriture") + " de « " + name
            + " »… (quelques minutes ; tu seras prévenu quand elle sera prête)"));

        AgentBackend.Reply reply;
        String sid = null;
        try {
            sid = agent.createSession("Commande " + name + " — " + playerName);
            agentSessions.put(player, sid);
            reply = agent.send(sid, agentName, message, null, turnTimeout);
        } catch (AgentBackend.AgentException e) {
            reply = new AgentBackend.Reply("", AgentBackend.Failure.DOWN, e.getMessage());
        }
        if (!reply.ok() && reply.failure() == AgentBackend.Failure.TIMEOUT && sid != null) agent.abort(sid);

        JsonObject closeBody = new JsonObject();
        closeBody.addProperty("ticket", ticket);
        JsonObject close = await(client.post("/api/authoring/close", closeBody));
        JsonObject submitted = close.has("submitted") && close.get("submitted").isJsonObject() ? close.getAsJsonObject("submitted") : null;

        if (submitted != null) {
            int v = submitted.get("version").getAsInt();
            String summary = submitted.has("summary") ? submitted.get("summary").getAsString() : "";
            String usage = submitted.has("usage") ? submitted.get("usage").getAsString() : "/bots order " + name;
            teller.tell(player, SquadNotice.suggest("[Bots] Commande « " + name + " » prête (v" + v + ") : " + summary + ". Utilise ",
                usage, "/bots order " + name + " ", "Clique pour préparer la commande"));
            if (reply.ok() && !reply.text().isBlank()) teller.tell(player, SquadNotice.of("[Bots] " + clip(reply.text())));
            LOGGER.info("Squad command {} v{} written for {}.", name, v, playerName);
        } else {
            String why = reply.ok()
                ? (reply.text().isBlank() ? "l'agent n'a rien soumis" : clip(reply.text()))
                : switch (reply.failure()) {
                    case DOWN -> "l'agent est injoignable";
                    case TIMEOUT -> "l'agent a dépassé le temps imparti";
                    case ERROR -> "l'agent a échoué";
                };
            if (!reply.ok()) LOGGER.warn("Authoring turn for {} ({}) failed ({}): {}", playerName, name, reply.failure(), reply.detail());
            teller.tell(player, SquadNotice.of("[Bots] « " + name + " » n'a pas pu être écrite : " + why + "."));
        }
    }

    /** Whether a turn of this player runs. */
    public boolean writing(UUID player) {
        return running.containsKey(player);
    }

    /** Stop every running turn (server stopping). */
    public void abortAll() {
        for (String sid : agentSessions.values()) {
            try {
                agent.abort(sid);
            } catch (RuntimeException ignored) {
                // best-effort
            }
        }
    }

    static JsonObject by(UUID uuid, String name) {
        JsonObject o = new JsonObject();
        o.addProperty("uuid", uuid.toString());
        o.addProperty("name", name);
        return o;
    }

    static boolean ok(JsonObject o) {
        return o.has("ok") && o.get("ok").getAsBoolean();
    }

    private static JsonObject await(java.util.concurrent.CompletableFuture<JsonObject> f) {
        try {
            return f.get(60, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return SquadClient.failure(SquadClient.UNREACHABLE);
        } catch (ExecutionException | TimeoutException e) {
            return SquadClient.failure(SquadClient.UNREACHABLE);
        }
    }

    private static String clip(String s) {
        String one = s.strip().replace('\n', ' ');
        return one.length() > 300 ? one.substring(0, 300) + "…" : one;
    }
}
