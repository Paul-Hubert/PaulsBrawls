package com.paul.brawl;

import static com.paul.brawl.McpTools.error;
import static com.paul.brawl.McpTools.integer;
import static com.paul.brawl.McpTools.ok;
import static com.paul.brawl.McpTools.optBool;
import static com.paul.brawl.McpTools.optInt;
import static com.paul.brawl.McpTools.optNumber;
import static com.paul.brawl.McpTools.optStr;
import static com.paul.brawl.McpTools.str;
import static com.paul.brawl.McpTools.tool;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.schema.JsonSchemaValidator;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpStatelessSyncServer;
import io.modelcontextprotocol.spec.McpSchema;

/**
 * The {@code god} MCP server (docs/27 §4–5): what God can do in the world, for an external agent. Every call carries
 * a god {@link AgentTickets ticket} minted by {@code /pray} or {@code /prove}, and is refused unless that ticket's
 * player owns the CURRENT avatar session (same generation) and is online. Clamps and refusals are
 * {@link GodService}'s; the avatar's Mineflayer tools are proxied behind {@link GodToolGate}.
 */
public final class GodMcpServer {

    static final String TICKET_DOC = "Le ticket de séance donné dans la prière (commence par 'god-').";

    private final GodService god;
    private final AgentTickets tickets;
    private final BodyTools body;
    private final BooleanSupplier bridgeEnabled;
    private final McpJsonMapper mapper;
    private final McpStatelessSyncServer server;

    public GodMcpServer(McpHttpEndpoint endpoint, McpJsonMapper mapper, JsonSchemaValidator validator,
            GodService god, AgentTickets tickets, BodyTools body, BooleanSupplier bridgeEnabled) {
        this.god = god;
        this.tickets = tickets;
        this.body = body;
        this.bridgeEnabled = bridgeEnabled;
        this.mapper = mapper;
        this.server = McpServer.sync(endpoint)
            .serverInfo("paulsbrawls-god", "1.0.0")
            .instructions("Tu es Dieu dans un serveur Minecraft. Chaque outil exige le ticket de la prière en cours ; "
                + "il désigne le joueur qui prie, et lui seul. Parle au joueur avec say (en français).")
            .jsonMapper(mapper)
            .jsonSchemaValidator(validator)
            .validateToolInputs(true)
            .capabilities(McpSchema.ServerCapabilities.builder().tools(false).build())
            .tools(tools())
            .build();
    }

    McpStatelessSyncServer server() {
        return server;
    }

    private static McpTools.Schema ticketOnly() {
        return McpTools.Schema.object().str("ticket", TICKET_DOC, true);
    }

    private List<SyncToolSpecification> tools() {
        return List.of(
            tool("say",
                "Parle au joueur qui prie (affiché 'Dieu : …'). Quand ton corps est apparu, ta voix résonne aussi en chat public. "
                    + "C'est ta seule façon de lui répondre.",
                ticketOnly().str("message", "Ce que Dieu dit, en français (au plus " + GodService.MAX_SAY_CHARS + " caractères).", true),
                session((p, a) -> {
                    String out = god.say(p, str(a, "message"));
                    tickets.markSaid(optStr(a, "ticket"));
                    return ok(out);
                })),
            tool("get_player_context",
                "Le joueur qui prie (position, vie, inventaire, effets… en JSON) et l'historique récent du chat et des commandes.",
                ticketOnly(),
                session((p, a) -> ok(god.playerContext(p)))),
            tool("reward",
                "Donne un objet au joueur. Syntaxe /give, composants permis (ex. minecraft:diamond, "
                    + "minecraft:enchanted_book[minecraft:enchantments={levels:{\"minecraft:sharpness\":5}}]). Quantité plafonnée côté serveur.",
                ticketOnly().str("item", "Identifiant de l'objet, avec composants éventuels.", true)
                    .integer("amount", "Nombre d'objets (au moins 1).", true),
                session((p, a) -> ok(god.reward(p, str(a, "item"), integer(a, "amount"))))),
            tool("offer_trade",
                "Propose un échange : Dieu donne give_amount give_item contre take_amount take_item. Le joueur l'accepte avec /accept "
                    + "dans les 5 minutes. Quantités de 1 à " + TradeOffers.MAX_TRADE_AMOUNT + ".",
                ticketOnly().str("give_item", "Objet donné au joueur.", true)
                    .integer("give_amount", "Quantité donnée.", true)
                    .str("take_item", "Objet pris au joueur.", true)
                    .integer("take_amount", "Quantité prise.", true),
                session((p, a) -> ok(god.offerTrade(p, str(a, "give_item"), integer(a, "give_amount"),
                    str(a, "take_item"), integer(a, "take_amount"))))),
            tool("punish",
                "Frappe le joueur de la foudre. Nombre d'éclairs plafonné côté serveur.",
                ticketOnly().integer("strikes", "Nombre d'éclairs.", true),
                session((p, a) -> ok(god.punish(p, integer(a, "strikes"))))),
            tool("change_weather",
                "Change la météo du monde.",
                ticketOnly().strEnum("weather", "Type de météo.", List.copyOf(new java.util.TreeSet<>(GodService.WEATHER_TYPES)), true)
                    .integer("duration_seconds", "Durée en secondes (0 = durée par défaut).", true),
                session((p, a) -> ok(god.changeWeather(p, str(a, "weather"), integer(a, "duration_seconds"))))),
            tool("spawn_creature",
                "Fait surgir des créatures près du joueur, à un décalage en blocs. Nombre et décalages plafonnés côté serveur. À utiliser rarement.",
                ticketOnly().str("entity", "Identifiant d'entité, ex. minecraft:zombie, minecraft:wolf.", true)
                    .integer("count", "Combien.", true)
                    .integer("dx", "Décalage X (est+).", true)
                    .integer("dy", "Décalage Y (haut+).", true)
                    .integer("dz", "Décalage Z (sud+).", true),
                session((p, a) -> ok(god.spawnCreature(p, str(a, "entity"), integer(a, "count"),
                    integer(a, "dx"), integer(a, "dy"), integer(a, "dz"))))),
            tool("appear",
                "Manifeste ton corps devant le joueur (par défaut 3 blocs devant, au sol, face à lui). Dramatique : sois parcimonieux.",
                ticketOnly().number("distance", "Blocs devant le joueur (plafonné, typiquement 1..6).", false)
                    .number("height", "Hauteur au-dessus de ses pieds (plafonnée, typiquement 0..4).", false)
                    .bool("look_at_player", "Se tourner vers le joueur (défaut vrai).", false),
                body((p, a) -> ok(god.appear(p, optNumber(a, "distance"), optNumber(a, "height"), optBool(a, "look_at_player"))))),
            tool("vanish",
                "Renvoie ton corps. La séance continue ; elle se ferme quand tu as fini (ou avec end_session).",
                ticketOnly(),
                body((p, a) -> ok(god.vanish(p)))),
            tool("wait",
                "Laisse passer des secondes avant de continuer (pour faire durer la tension). Plafonné côté serveur, typiquement 1..30.",
                ticketOnly().integer("seconds", "Secondes à attendre.", true),
                session((p, a) -> {
                    int s = god.waitSeconds(integer(a, "seconds"));
                    try {
                        Thread.sleep(s * 1000L);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return error("Attente interrompue.");
                    }
                    return ok(GodService.waitMessage(s));
                })),
            tool("query_terrain",
                "Carte ASCII 16×16 du relief autour du joueur (ou d'un centre absolu à moins de 128 blocs), avec biome et pente.",
                ticketOnly().integer("center_x", "X absolu du centre (défaut : le joueur).", false)
                    .integer("center_z", "Z absolu du centre (défaut : le joueur).", false)
                    .integer("radius", "Demi-largeur en blocs, 8..64 (défaut 32).", false),
                session((p, a) -> ok(god.queryTerrain(p, optInt(a, "center_x"), optInt(a, "center_z"), optInt(a, "radius"))))),
            tool("body_tools",
                "Liste les outils du corps (Mineflayer : se déplacer, regarder, combattre…) utilisables avec body_call, avec leurs paramètres.",
                ticketOnly(),
                body((p, a) -> {
                    List<BodyTools.Spec> specs = body.list();
                    if (specs.isEmpty()) return ok("Aucun outil du corps disponible (le processus Mineflayer est arrêté ?).");
                    StringBuilder sb = new StringBuilder();
                    for (BodyTools.Spec s : specs) {
                        sb.append("- ").append(s.name()).append(" : ").append(s.description() == null ? "" : s.description())
                            .append("\n  paramètres : ").append(json(s.inputSchema())).append('\n');
                    }
                    return ok(sb.toString());
                })),
            tool("body_call",
                "Exécute un outil du corps (voir body_tools) avec ses arguments.",
                ticketOnly().str("tool", "Nom de l'outil, tel que listé par body_tools.", true)
                    .anyObject("arguments", "Arguments de l'outil (objet JSON).", false),
                body((p, a) -> {
                    String name = str(a, "tool");
                    if (!body.has(name)) return error("Outil du corps inconnu : '" + name + "'. Appelle body_tools.");
                    Object args = a.get("arguments");
                    return ok(body.call(name, args == null ? "{}" : json(args)));
                })),
            tool("end_session",
                "Termine la rencontre maintenant : ton corps s'en va et le joueur est libéré. Sinon elle se termine quand tu cesses d'agir.",
                ticketOnly(),
                a -> {
                    // Not wrapped in session(): ending an already-ended session is harmless.
                    AgentTickets.Ticket t = tickets.resolve(optStr(a, "ticket"), AgentTickets.Kind.GOD);
                    if (t == null) return error("Ticket inconnu ou expiré : la séance est déjà close.");
                    tickets.revoke(t.id());
                    if (GodSessionManager.generation() != t.generation()) return ok("Séance déjà close.");
                    return ok(god.endSession(t.player()));
                })
        );
    }

    private String json(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception e) {
            return String.valueOf(o);
        }
    }

    @FunctionalInterface
    interface SessionBody {
        McpSchema.CallToolResult apply(UUID player, Map<String, Object> args);
    }

    /**
     * Resolve the god ticket; refuse unless its player owns the current session (same generation) and is online.
     * The owner's idle watchdog is reset around the call (bug #8: a long tool chain is activity).
     */
    private Function<Map<String, Object>, McpSchema.CallToolResult> session(SessionBody bodyFn) {
        return a -> {
            AgentTickets.Ticket t = tickets.resolve(optStr(a, "ticket"), AgentTickets.Kind.GOD);
            if (t == null) return error("Ticket inconnu ou expiré : cette prière n'est plus active.");
            UUID p = t.player();
            if (!GodSessionManager.isOwner(p) || GodSessionManager.generation() != t.generation()) {
                tickets.revoke(t.id());
                return error("Cette séance est terminée (fin, inactivité ou arrêt par un administrateur) : "
                    + "tu ne peux plus agir pour ce joueur.");
            }
            if (!god.world().isOnline(p)) return error(MinecraftBuildWorld.OFFLINE);
            GodSessionManager.resetIdleTimer(p);
            try {
                return bodyFn.apply(p, a);
            } finally {
                GodSessionManager.resetIdleTimer(p);
            }
        };
    }

    /** {@link #session} plus the body gate: the bridge must be enabled ({@code /godbody on}). */
    private Function<Map<String, Object>, McpSchema.CallToolResult> body(SessionBody bodyFn) {
        return session((p, a) -> {
            String refusal = GodToolGate.mcpRefusal(bridgeEnabled.getAsBoolean(), true);
            return refusal != null ? error(refusal) : bodyFn.apply(p, a);
        });
    }
}
