package com.paul.brawl;

import static com.paul.brawl.McpTools.error;
import static com.paul.brawl.McpTools.integer;
import static com.paul.brawl.McpTools.ok;
import static com.paul.brawl.McpTools.optInt;
import static com.paul.brawl.McpTools.optStr;
import static com.paul.brawl.McpTools.str;
import static com.paul.brawl.McpTools.tool;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.schema.JsonSchemaValidator;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpStatelessServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpStatelessSyncServer;
import io.modelcontextprotocol.spec.McpSchema;

/**
 * The {@code builder} MCP server (docs/27 §4): block-placement primitives with BuildGuard's caps, for an external
 * agent that does its own planning and sub-agents. Every call carries a builder {@link AgentTickets ticket} minted
 * by {@code /build}; placements go through a {@link SubBuilds} lease (≤ 4 server-wide) and {@link BuildService}
 * (≤ 128 blocks per call, known blocks only, main-thread bulk lane).
 */
public final class BuilderMcpServer {

    static final String TICKET_DOC = "Le ticket de construction donné dans la demande (commence par 'bld-').";

    private final BuildService build;
    private final AgentTickets tickets;
    private final SubBuilds subBuilds;
    private final McpStatelessSyncServer server;

    public BuilderMcpServer(McpHttpEndpoint endpoint, McpJsonMapper mapper, JsonSchemaValidator validator,
            BuildService build, AgentTickets tickets, SubBuilds subBuilds) {
        this.build = build;
        this.tickets = tickets;
        this.subBuilds = subBuilds;
        this.server = McpServer.sync(endpoint)
            .serverInfo("paulsbrawls-builder", "1.0.0")
            .instructions("Construis dans Minecraft autour du pivot /construction de l'admin. Ouvre une sous-construction "
                + "(begin_sub_build) par structure, place des blocs relativement à son ancre, puis ferme-la (end_sub_build). "
                + "Au plus " + BuildGuard.MAX_CONCURRENT_SUB_BUILDS + " sous-constructions en parallèle sur le serveur, "
                + BuildGuard.MAX_BLOCKS_PER_CALL + " blocs par appel.")
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

    private List<SyncToolSpecification> tools() {
        String block = "Bloc Minecraft comme pour /setblock, ex. minecraft:oak_planks ou minecraft:oak_stairs[facing=north].";
        return List.of(
            tool("get_build_origin",
                "Coordonnées absolues du pivot /construction de l'admin (l'origine de toutes les ancres).",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true),
                withTicket((p, a) -> {
                    int[] o = build.origin(p);
                    return o == null ? error(noOrigin()) : ok("Pivot : x=" + o[0] + " y=" + o[1] + " z=" + o[2]);
                })),
            tool("get_block_info",
                "Les blocs de surface des 3×3 colonnes autour du pivot, en décalages depuis le pivot (JSON).",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true),
                withTicket((p, a) -> build.origin(p) == null ? error(noOrigin()) : ok(build.blockInfo(p)))),
            tool("query_terrain",
                "Carte ASCII 16×16 du relief autour du joueur (ou d'un centre absolu à moins de 128 blocs), avec biome et pente.",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true)
                    .integer("center_x", "X absolu du centre (défaut : le joueur).", false)
                    .integer("center_z", "Z absolu du centre (défaut : le joueur).", false)
                    .integer("radius", "Demi-largeur en blocs, 8..64 (défaut 32).", false),
                withTicket((p, a) -> ok(build.queryTerrain(p, optInt(a, "center_x"), optInt(a, "center_z"), optInt(a, "radius"))))),
            tool("begin_sub_build",
                "Ouvre une sous-construction à une ancre décalée du pivot (±" + SubBuilds.MAX_ANCHOR_OFFSET
                    + " par axe). Retourne l'identifiant sub_build à passer aux place_*. Au plus "
                    + BuildGuard.MAX_CONCURRENT_SUB_BUILDS + " ouvertes sur tout le serveur ; une sous-construction sans appel pendant "
                    + "quelques minutes est fermée automatiquement.",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true)
                    .str("label", "Nom court de la structure (ex. 'tour nord').", false)
                    .integer("anchor_x", "Décalage X (est+) de l'ancre depuis le pivot.", true)
                    .integer("anchor_y", "Décalage Y (haut+) de l'ancre depuis le pivot.", true)
                    .integer("anchor_z", "Décalage Z (sud+) de l'ancre depuis le pivot.", true),
                withTicket((p, a) -> {
                    int[] o = build.origin(p);
                    if (o == null) return error(noOrigin());
                    SubBuilds.Result r = subBuilds.begin(p, o, optStr(a, "label"),
                        integer(a, "anchor_x"), integer(a, "anchor_y"), integer(a, "anchor_z"));
                    if (r.lease() == null) return error(r.refusal());
                    int[] an = r.lease().anchor();
                    return ok("sub_build=" + r.lease().id() + " ancre absolue x=" + an[0] + " y=" + an[1] + " z=" + an[2]);
                })),
            tool("place_block",
                "Place un bloc à un décalage (x, y, z) depuis l'ancre de la sous-construction.",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true)
                    .str("sub_build", "L'identifiant rendu par begin_sub_build.", true)
                    .integer("x", "Décalage X depuis l'ancre.", true)
                    .integer("y", "Décalage Y depuis l'ancre.", true)
                    .integer("z", "Décalage Z depuis l'ancre.", true)
                    .str("block", block, true),
                withLease((p, l, a) -> build.place(p, l.anchor(),
                    List.of(new int[] { integer(a, "x"), integer(a, "y"), integer(a, "z") }), str(a, "block")))),
            tool("place_line",
                "Place une ligne droite de blocs entre deux décalages depuis l'ancre (au plus "
                    + BuildGuard.MAX_BLOCKS_PER_CALL + " blocs).",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true)
                    .str("sub_build", "L'identifiant rendu par begin_sub_build.", true)
                    .integer("x1", "Départ X.", true).integer("y1", "Départ Y.", true).integer("z1", "Départ Z.", true)
                    .integer("x2", "Arrivée X.", true).integer("y2", "Arrivée Y.", true).integer("z2", "Arrivée Z.", true)
                    .str("block", block, true),
                withLease((p, l, a) -> build.placeLine(p, l.anchor(),
                    integer(a, "x1"), integer(a, "y1"), integer(a, "z1"),
                    integer(a, "x2"), integer(a, "y2"), integer(a, "z2"), str(a, "block")))),
            tool("place_blocks",
                "Place le même bloc à plusieurs décalages depuis l'ancre : xs[i], ys[i], zs[i] (tableaux de même longueur, au plus "
                    + BuildGuard.MAX_BLOCKS_PER_CALL + ").",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true)
                    .str("sub_build", "L'identifiant rendu par begin_sub_build.", true)
                    .intArray("xs", "Décalages X.", true).intArray("ys", "Décalages Y.", true).intArray("zs", "Décalages Z.", true)
                    .str("block", block, true),
                withLease((p, l, a) -> {
                    int cap = BuildGuard.MAX_BLOCKS_PER_CALL;
                    int[] xs = McpTools.intArray(a, "xs", cap), ys = McpTools.intArray(a, "ys", cap), zs = McpTools.intArray(a, "zs", cap);
                    if (xs.length != ys.length || ys.length != zs.length) {
                        throw new McpTools.BadArgs("xs, ys et zs doivent avoir la même longueur ("
                            + xs.length + ", " + ys.length + ", " + zs.length + ").");
                    }
                    return build.place(p, l.anchor(), BuildShapes.points(xs, ys, zs), str(a, "block"));
                })),
            tool("end_sub_build",
                "Ferme la sous-construction et libère sa place pour une autre.",
                McpTools.Schema.object().str("ticket", TICKET_DOC, true)
                    .str("sub_build", "L'identifiant rendu par begin_sub_build.", true),
                withTicket((p, a) -> subBuilds.end(str(a, "sub_build"), p)
                    ? ok("Sous-construction fermée.")
                    : error("Sous-construction inconnue ou déjà fermée.")))
        );
    }

    private static String noOrigin() {
        return "Aucun point de référence : l'admin doit lancer /construction avant de construire.";
    }

    @FunctionalInterface
    interface TicketBody {
        McpSchema.CallToolResult apply(UUID player, Map<String, Object> args);
    }

    @FunctionalInterface
    interface LeaseBody {
        String apply(UUID player, SubBuilds.Lease lease, Map<String, Object> args);
    }

    /** Resolve the builder ticket and check the player is online, then run the body. */
    private Function<Map<String, Object>, McpSchema.CallToolResult> withTicket(TicketBody body) {
        return a -> {
            AgentTickets.Ticket t = tickets.resolve(optStr(a, "ticket"), AgentTickets.Kind.BUILDER);
            if (t == null) {
                return error("Ticket de construction inconnu ou expiré : cette construction n'est plus active.");
            }
            if (!build.world().isOnline(t.player())) return error(MinecraftBuildWorld.OFFLINE);
            return body.apply(t.player(), a);
        };
    }

    /** {@link #withTicket} plus a live sub-build lease owned by the same player. */
    private Function<Map<String, Object>, McpSchema.CallToolResult> withLease(LeaseBody body) {
        return withTicket((p, a) -> {
            SubBuilds.Result r = subBuilds.use(optStr(a, "sub_build"), p);
            if (r.lease() == null) return error(r.refusal());
            String out = body.apply(p, r.lease(), a);
            boolean placed = out.endsWith("placé(s).");
            return placed ? ok(out) : error(out);
        });
    }
}
