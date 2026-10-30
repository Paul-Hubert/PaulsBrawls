package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.suggestion.SuggestionProvider;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.command.CommandSource;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

/**
 * {@code /bots} (docs/29 §9). Admins: spawn, despawn, owners, stop all, list all. Owners: create, fix, order, stop,
 * list, orders, tag, commands, show, share, unshare, delete, revert, ticket. Anyone: status (the runtime's load).
 * Every call goes to the squad runtime asynchronously; its French answer is shown on the main thread.
 */
public final class SquadCommand {

    private static final String DISABLED = "[Bots] Squad est désactivé (squad.properties : enabled=false).";

    private SquadCommand() {}

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
            CommandManager.literal("bots")
                .executes(c -> help(c.getSource()))
                // -- admin --------------------------------------------------------------------------------------
                .then(CommandManager.literal("spawn").requires(s -> s.hasPermissionLevel(2))
                    .then(CommandManager.argument("bot", StringArgumentType.word())
                        .then(CommandManager.argument("owners", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> spawn(c, StringArgumentType.getString(c, "bot"), StringArgumentType.getString(c, "owners"))))))
                .then(CommandManager.literal("despawn").requires(s -> s.hasPermissionLevel(2))
                    .then(CommandManager.argument("bot", StringArgumentType.word()).suggests(ALL_BOTS)
                        .executes(c -> despawn(c, StringArgumentType.getString(c, "bot")))))
                .then(CommandManager.literal("owners").requires(s -> s.hasPermissionLevel(2))
                    .then(CommandManager.argument("bot", StringArgumentType.word()).suggests(ALL_BOTS)
                        .then(CommandManager.literal("add").then(CommandManager.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> owners(c, true))))
                        .then(CommandManager.literal("remove").then(CommandManager.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> owners(c, false))))))
                .then(CommandManager.literal("equip").requires(s -> s.hasPermissionLevel(2))
                    .then(CommandManager.argument("bot", StringArgumentType.word()).suggests(ALL_BOTS)
                        .then(CommandManager.argument("kit", StringArgumentType.word()).suggests(KITS)
                            .executes(c -> equip(c, StringArgumentType.getString(c, "bot"), StringArgumentType.getString(c, "kit"))))))
                // -- owners -------------------------------------------------------------------------------------
                .then(CommandManager.literal("create")
                    .then(CommandManager.argument("name", StringArgumentType.word())
                        .executes(c -> reply(c.getSource(), "[Bots] Dis ce que la commande doit faire : /bots create "
                            + StringArgumentType.getString(c, "name") + " <description>"))
                        .then(CommandManager.argument("request", StringArgumentType.greedyString())
                            .executes(c -> author(c, "create", StringArgumentType.getString(c, "request"))))))
                .then(CommandManager.literal("fix")
                    .then(CommandManager.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .executes(c -> author(c, "fix", ""))
                        .then(CommandManager.argument("feedback", StringArgumentType.greedyString())
                            .executes(c -> author(c, "fix", StringArgumentType.getString(c, "feedback"))))))
                .then(CommandManager.literal("order")
                    // Greedy: "owner:NAME" has a colon, which a Brigadier word refuses. First token = the command.
                    .then(CommandManager.argument("command", StringArgumentType.greedyString()).suggests(ORDER_LINE)
                        .executes(c -> order(c, StringArgumentType.getString(c, "command")))))
                .then(CommandManager.literal("stop")
                    .executes(c -> stop(c, ""))
                    .then(CommandManager.argument("target", StringArgumentType.greedyString()).suggests(STOP_TARGETS)
                        .executes(c -> stop(c, StringArgumentType.getString(c, "target")))))
                .then(CommandManager.literal("list")
                    .executes(c -> call(c, "/api/bots/list", b -> b))
                    .then(CommandManager.literal("all").requires(s -> s.hasPermissionLevel(2))
                        .executes(c -> call(c, "/api/bots/list", b -> {
                            b.addProperty("all", true);
                            return b;
                        }))))
                .then(CommandManager.literal("orders").executes(c -> call(c, "/api/orders/list", b -> b)))
                .then(CommandManager.literal("status").executes(SquadCommand::status))
                .then(CommandManager.literal("tag")
                    .then(CommandManager.argument("bot", StringArgumentType.word()).suggests(MY_BOTS)
                        .then(CommandManager.argument("changes", StringArgumentType.greedyString())
                            .executes(c -> call(c, "/api/bots/tag", b -> {
                                b.addProperty("name", StringArgumentType.getString(c, "bot"));
                                b.add("changes", array(SquadArgs.tokenize(StringArgumentType.getString(c, "changes"))));
                                return b;
                            })))))
                .then(CommandManager.literal("commands").executes(c -> call(c, "/api/commands/list", b -> b)))
                .then(CommandManager.literal("show")
                    .then(CommandManager.argument("name", StringArgumentType.greedyString()).suggests(MY_COMMANDS)
                        .executes(c -> call(c, "/api/commands/show", b -> {
                            b.addProperty("name", StringArgumentType.getString(c, "name").trim());
                            return b;
                        }))))
                .then(CommandManager.literal("share")
                    .then(CommandManager.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .then(CommandManager.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> share(c, false)))))
                .then(CommandManager.literal("unshare")
                    .then(CommandManager.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .then(CommandManager.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> share(c, true)))))
                .then(CommandManager.literal("delete")
                    .then(CommandManager.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .executes(c -> call(c, "/api/commands/delete", b -> {
                            b.addProperty("name", StringArgumentType.getString(c, "name"));
                            return b;
                        }))))
                .then(CommandManager.literal("revert")
                    .then(CommandManager.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .then(CommandManager.argument("version", IntegerArgumentType.integer(1))
                            .executes(c -> call(c, "/api/commands/revert", b -> {
                                b.addProperty("name", StringArgumentType.getString(c, "name"));
                                b.addProperty("version", IntegerArgumentType.getInteger(c, "version"));
                                return b;
                            })))))
                .then(CommandManager.literal("ticket")
                    .then(CommandManager.literal("revoke").executes(c -> call(c, "/api/authoring/revoke", b -> b)))
                    .then(CommandManager.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .executes(SquadCommand::ticket)))
        ));
    }

    // -- suggestions ------------------------------------------------------------------------------------------------

    private static final SuggestionProvider<ServerCommandSource> KITS = (c, b) -> CommandSource.suggestMatching(SquadKits.NAMES, b);
    private static final SuggestionProvider<ServerCommandSource> ALL_BOTS = (c, b) -> CommandSource.suggestMatching(Squad.botNames(), b);
    private static final SuggestionProvider<ServerCommandSource> MY_BOTS = (c, b) -> {
        ServerPlayerEntity p = c.getSource().getPlayer();
        return CommandSource.suggestMatching(p == null || c.getSource().hasPermissionLevel(2) ? Squad.botNames() : Squad.botsOf(p.getUuid()), b);
    };
    /** {@code /bots order …}: the command name first, then {@code @bot} filters and the take flags. */
    private static final SuggestionProvider<ServerCommandSource> ORDER_LINE = (c, b) -> {
        ServerPlayerEntity p = c.getSource().getPlayer();
        if (p == null) return b.buildFuture();
        String rem = b.getRemaining();
        int cut = rem.lastIndexOf(' ') + 1;
        if (cut == 0) return CommandSource.suggestMatching(Squad.commandsOf(p.getUuid(), false), b);
        List<String> opts = new ArrayList<>();
        for (String n : Squad.botsOf(p.getUuid())) opts.add("@" + n);
        opts.add("--reclaim");
        opts.add("--free");
        return CommandSource.suggestMatching(opts, b.createOffset(b.getStart() + cut));
    };
    private static final SuggestionProvider<ServerCommandSource> MY_COMMANDS = (c, b) -> {
        ServerPlayerEntity p = c.getSource().getPlayer();
        return CommandSource.suggestMatching(p == null ? List.of() : Squad.commandsOf(p.getUuid(), false), b);
    };
    private static final SuggestionProvider<ServerCommandSource> OWN_COMMANDS = (c, b) -> {
        ServerPlayerEntity p = c.getSource().getPlayer();
        return CommandSource.suggestMatching(p == null ? List.of() : Squad.commandsOf(p.getUuid(), true), b);
    };
    private static final SuggestionProvider<ServerCommandSource> ONLINE_PLAYERS = (c, b) -> {
        String rem = b.getRemaining();
        int cut = Math.max(rem.lastIndexOf(' '), rem.lastIndexOf(',')) + 1;
        return CommandSource.suggestMatching(c.getSource().getServer().getPlayerNames(), b.createOffset(b.getStart() + cut));
    };
    private static final SuggestionProvider<ServerCommandSource> STOP_TARGETS = (c, b) -> {
        ServerPlayerEntity p = c.getSource().getPlayer();
        List<String> opts = new ArrayList<>(List.of("all"));
        opts.addAll(Squad.orderIds());
        if (p != null) {
            for (String n : Squad.botsOf(p.getUuid())) opts.add("@" + n);
            opts.addAll(Squad.commandsOf(p.getUuid(), false));
        }
        return CommandSource.suggestMatching(opts, b);
    };

    // -- handlers ---------------------------------------------------------------------------------------------------

    private static int help(ServerCommandSource src) {
        String[] lines = {
            "[Bots] Tes bots exécutent des commandes écrites sur demande :",
            " /bots create NOM <ce qu'elle doit faire> — faire écrire une commande",
            " /bots order NOM [arguments] [@bot …] [--reclaim|--free] — la lancer sur tes bots",
            " /bots stop [all | #id | NOM | @bot] — arrêter",
            " /bots fix NOM [ce qui ne va pas] — la corriger d'après son dernier rapport",
            " /bots list · orders · commands · show NOM · tag BOT +étiquette -étiquette · status",
            " /bots share NOM JOUEUR… · unshare · delete NOM · revert NOM VERSION · ticket NOM",
        };
        for (String l : lines) src.sendFeedback(() -> Text.literal(l), false);
        if (src.hasPermissionLevel(2)) {
            src.sendFeedback(() -> Text.literal(" Admin : /bots spawn BOT JOUEUR1 [JOUEUR2 …] · equip BOT archer|guard|miner|farmer · despawn BOT · owners BOT add|remove JOUEUR… · list all · stop all"), false);
        }
        return Command.SINGLE_SUCCESS;
    }

    private static int spawn(CommandContext<ServerCommandSource> c, String bot, String ownersText) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerCommandSource src = c.getSource();
        MinecraftServer srv = src.getServer();
        if (!SquadArgs.BOT_NAME.matcher(bot).matches()) return reply(src, "[Bots] Nom de bot invalide (3 à 16 caractères : lettres, chiffres, _).");
        if (srv.getPlayerManager().getPlayer(bot) != null || Squad.hasPlayed(srv, bot)) {
            return reply(src, "[Bots] " + bot + " est le nom d'un joueur qui a déjà joué ici (le bot hériterait de son inventaire) : choisis-en un autre.");
        }
        if (reservedName(bot)) return reply(src, "[Bots] " + bot + " est réservé (avatar de Dieu ou villageois).");
        JsonArray owners = new JsonArray();
        for (String name : SquadArgs.names(ownersText)) {
            Optional<GameProfile> p = Squad.profile(srv, name);
            if (p.isEmpty()) return reply(src, "[Bots] Joueur inconnu : " + name);
            owners.add(Squad.player(p.get()));
        }
        ServerPlayerEntity admin = src.getPlayer();
        JsonObject body = base(src);
        body.addProperty("name", bot);
        body.add("owners", owners);
        Squad.client().post("/api/bots/spawn", body).thenAccept(r -> srv.execute(() -> {
            if (SquadAuthoring.ok(r)) {
                Squad.whitelist(srv, bot, true);
                if (admin != null) Squad.expectArrival(bot, admin);
            }
            show(src, r);
        }));
        return Command.SINGLE_SUCCESS;
    }

    /** {@code /bots equip BOT KIT} (admin): the kit's items server-side, then the kit's tag on the runtime's roster. */
    private static int equip(CommandContext<ServerCommandSource> c, String bot, String kitName) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerCommandSource src = c.getSource();
        Optional<SquadKits.Kit> kit = SquadKits.find(kitName);
        if (kit.isEmpty()) return reply(src, "[Bots] Kit inconnu : " + kitName + " (" + String.join(", ", SquadKits.NAMES) + ").");
        Optional<String> name = Squad.botNames().stream().filter(n -> n.equalsIgnoreCase(bot)).findFirst();
        if (name.isEmpty()) return reply(src, "[Bots] " + bot + " n'est pas un bot de la squad (/bots list all).");
        reply(src, Squad.equip(src.getServer(), name.get(), kit.get()));
        JsonObject body = base(src);
        body.addProperty("name", name.get());
        body.add("changes", array(SquadKits.tagChanges(kit.get())));
        Squad.client().post("/api/bots/tag", body).thenAccept(r -> {
            if (!SquadAuthoring.ok(r)) src.getServer().execute(() -> show(src, r));
        });
        return Command.SINGLE_SUCCESS;
    }

    private static boolean reservedName(String bot) {
        String n = bot.toLowerCase(Locale.ROOT);
        return n.equals(com.paul.brawl.BridgeConfig.INSTANCE.botUsername.toLowerCase(Locale.ROOT))
            || n.equals(com.paul.brawl.VillageConfig.INSTANCE.edenAvatarName.toLowerCase(Locale.ROOT))
            || com.paul.brawl.VillagersCommand.activeScenarioBots.stream().anyMatch(v -> v.equalsIgnoreCase(bot));
    }

    private static int despawn(CommandContext<ServerCommandSource> c, String bot) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerCommandSource src = c.getSource();
        MinecraftServer srv = src.getServer();
        JsonObject body = base(src);
        body.addProperty("name", bot);
        Squad.client().post("/api/bots/despawn", body).thenAccept(r -> srv.execute(() -> {
            if (SquadAuthoring.ok(r) && r.has("bot")) {
                String name = r.getAsJsonObject("bot").get("name").getAsString();
                Squad.whitelist(srv, name, false);
                ServerPlayerEntity p = srv.getPlayerManager().getPlayer(name);
                if (p != null) p.networkHandler.disconnect(Text.literal("Bot retiré."));
            }
            show(src, r);
        }));
        return Command.SINGLE_SUCCESS;
    }

    private static int owners(CommandContext<ServerCommandSource> c, boolean add) {
        ServerCommandSource src = c.getSource();
        JsonArray players = new JsonArray();
        for (String name : SquadArgs.names(StringArgumentType.getString(c, "players"))) {
            Optional<GameProfile> p = Squad.profile(src.getServer(), name);
            if (p.isEmpty()) return reply(src, "[Bots] Joueur inconnu : " + name);
            players.add(Squad.player(p.get()));
        }
        return call(c, "/api/bots/owners", b -> {
            b.addProperty("name", StringArgumentType.getString(c, "bot"));
            b.add(add ? "add" : "remove", players);
            return b;
        });
    }

    private static int author(CommandContext<ServerCommandSource> c, String mode, String text) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerPlayerEntity p = c.getSource().getPlayer();
        if (p == null) return reply(c.getSource(), "[Bots] À lancer en jeu, par un joueur.");
        String name = StringArgumentType.getString(c, "name").toLowerCase(Locale.ROOT);
        if (!SquadArgs.COMMAND_NAME.matcher(name).matches()) return reply(c.getSource(), "[Bots] Nom de commande invalide (a-z, 0-9 et -, 2 à 32 caractères).");
        Squad.authoring().start(mode, p.getUuid(), p.getName().getString(), name, text, CommanderSnap.of(p));
        return Command.SINGLE_SUCCESS;
    }

    private static int order(CommandContext<ServerCommandSource> c, String line) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerPlayerEntity p = c.getSource().getPlayer();
        if (p == null) return reply(c.getSource(), "[Bots] À lancer en jeu, par un joueur (les bots ont besoin de ta position).");
        String trimmed = line.trim();
        int sp = trimmed.indexOf(' ');
        String name = sp < 0 ? trimmed : trimmed.substring(0, sp);
        SquadArgs.OrderArgs a = SquadArgs.order(sp < 0 ? "" : trimmed.substring(sp + 1));
        return call(c, "/api/orders/start", b -> {
            b.addProperty("command", name);
            b.add("tokens", array(a.tokens()));
            b.add("filters", array(a.filters()));
            if (a.take() != null) b.addProperty("take", a.take());
            b.add("snap", CommanderSnap.of(p));
            return b;
        });
    }

    private static int stop(CommandContext<ServerCommandSource> c, String target) {
        return call(c, "/api/orders/stop", b -> {
            b.addProperty("target", target.trim());
            return b;
        });
    }

    private static int share(CommandContext<ServerCommandSource> c, boolean remove) {
        ServerCommandSource src = c.getSource();
        JsonArray players = new JsonArray();
        for (String name : SquadArgs.names(StringArgumentType.getString(c, "players"))) {
            Optional<GameProfile> p = Squad.profile(src.getServer(), name);
            if (p.isEmpty()) return reply(src, "[Bots] Joueur inconnu : " + name);
            players.add(Squad.player(p.get()));
        }
        return call(c, "/api/commands/share", b -> {
            b.addProperty("name", StringArgumentType.getString(c, "name"));
            b.add("players", players);
            b.addProperty("remove", remove);
            return b;
        });
    }

    /** {@code /bots ticket NAME}: a manual authoring ticket for the player's own Claude Code session. */
    private static int ticket(CommandContext<ServerCommandSource> c) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerPlayerEntity p = c.getSource().getPlayer();
        if (p == null) return reply(c.getSource(), "[Bots] À lancer en jeu, par un joueur.");
        ServerCommandSource src = c.getSource();
        JsonObject body = base(src);
        body.addProperty("mode", "manual");
        body.addProperty("name", StringArgumentType.getString(c, "name").toLowerCase(Locale.ROOT));
        body.addProperty("request", "");
        body.add("snap", CommanderSnap.of(p));
        Squad.client().post("/api/authoring/open", body).thenAccept(r -> src.getServer().execute(() -> {
            if (!SquadAuthoring.ok(r)) {
                show(src, r);
                return;
            }
            String id = r.get("ticket").getAsString();
            Text t = Text.literal(id).styled(s -> s.withColor(Formatting.GOLD).withUnderline(true)
                .withClickEvent(new net.minecraft.text.ClickEvent(net.minecraft.text.ClickEvent.Action.COPY_TO_CLIPBOARD, id))
                .withHoverEvent(new net.minecraft.text.HoverEvent(net.minecraft.text.HoverEvent.Action.SHOW_TEXT, Text.literal("Clique pour copier le ticket"))));
            src.sendFeedback(() -> Text.literal("[Bots] Ticket d'écriture (2 h) : ").append(t), false);
            src.sendFeedback(() -> Text.literal("Serveur MCP : " + SquadConfig.INSTANCE.url + "/mcp/squad — donne ce ticket à ton agent ; /bots ticket revoke l'annule."), false);
        }));
        return Command.SINGLE_SUCCESS;
    }

    /**
     * {@code /bots status} (anyone, docs/32 C): the runtime's load over its last 10 s window — ELU, the loop's p99
     * and the slowest bot's ticks per second. The line is built by {@link SquadStatusFormat}.
     */
    private static int status(CommandContext<ServerCommandSource> c) {
        ServerCommandSource src = c.getSource();
        if (!Squad.enabled()) return reply(src, DISABLED);
        Squad.client().post("/api/metrics", base(src)).thenAccept(r -> src.getServer().execute(() -> reply(src, SquadStatusFormat.format(r))));
        return Command.SINGLE_SUCCESS;
    }

    // -- plumbing ---------------------------------------------------------------------------------------------------

    /** POST with {@code by}/{@code admin} added; show the runtime's answer to the source. */
    private static int call(CommandContext<ServerCommandSource> c, String path, Function<JsonObject, JsonObject> fill) {
        ServerCommandSource src = c.getSource();
        if (!Squad.enabled()) return reply(src, DISABLED);
        JsonObject body = fill.apply(base(src));
        CompletableFuture<JsonObject> f = Squad.client().post(path, body);
        f.thenAccept(r -> src.getServer().execute(() -> {
            show(src, r);
            if (r.has("notify") && r.get("notify").isJsonArray() && r.has("notifyText")) {
                SquadNotice n = SquadNotice.of(r.get("notifyText").getAsString());
                for (var u : r.getAsJsonArray("notify")) Squad.tell(UUID.fromString(u.getAsString()), n);
            }
        }));
        return Command.SINGLE_SUCCESS;
    }

    /** {@code by} (the player, or the console as an admin) and {@code admin}. */
    private static JsonObject base(ServerCommandSource src) {
        JsonObject b = new JsonObject();
        ServerPlayerEntity p = src.getPlayer();
        JsonObject by = new JsonObject();
        by.addProperty("uuid", p != null ? p.getUuidAsString() : "00000000-0000-0000-0000-00000000c0de");
        by.addProperty("name", p != null ? p.getName().getString() : "Console");
        b.add("by", by);
        b.addProperty("admin", src.hasPermissionLevel(2));
        return b;
    }

    private static void show(ServerCommandSource src, JsonObject r) {
        SquadNotice n = SquadNotice.fromJson(r);
        if (n.text().isBlank()) return;
        for (Text t : Squad.render(n)) src.sendFeedback(() -> t, false);
    }

    private static int reply(ServerCommandSource src, String text) {
        for (Text t : Squad.render(SquadNotice.of(text))) src.sendFeedback(() -> t, false);
        return 0;
    }

    private static JsonArray array(List<String> items) {
        JsonArray a = new JsonArray();
        for (String s : items) a.add(s);
        return a;
    }
}
