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
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

/**
 * {@code /bots} (docs/29 §9). Admins: spawn, despawn, owners, stop all, list all. Owners: create, fix, order, stop,
 * list, orders, tag, commands, show, share, unshare, delete, revert, ticket. Anyone: status (the runtime's load), and
 * orders bind / unbind / bound (an order bound to the held item, §5.4; the clicks are SquadTriggers).
 * Every call goes to the squad runtime asynchronously; its French answer is shown on the main thread.
 */
public final class SquadCommand {

    private static final String DISABLED = "[Bots] Squad est désactivé (squad.properties : enabled=false).";
    private static final String BIND_USAGE = "[Bots] Usage : /bots orders bind NOM [arguments] [@bot …] [--reclaim|--free], l'objet à lier en main.";

    private SquadCommand() {}

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
            Commands.literal("bots")
                .executes(c -> help(c.getSource()))
                // -- admin --------------------------------------------------------------------------------------
                .then(Commands.literal("spawn").requires(s -> s.hasPermission(2))
                    .then(Commands.argument("bot", StringArgumentType.word())
                        .then(Commands.argument("owners", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> spawn(c, StringArgumentType.getString(c, "bot"), StringArgumentType.getString(c, "owners"))))))
                .then(Commands.literal("despawn").requires(s -> s.hasPermission(2))
                    .then(Commands.literal("all").executes(c -> despawnAll(c.getSource())))
                    .then(Commands.argument("bot", StringArgumentType.word()).suggests(ALL_BOTS)
                        .executes(c -> despawn(c, StringArgumentType.getString(c, "bot")))))
                .then(Commands.literal("owners").requires(s -> s.hasPermission(2))
                    .then(Commands.argument("bot", StringArgumentType.word()).suggests(ALL_BOTS)
                        .then(Commands.literal("add").then(Commands.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> owners(c, true))))
                        .then(Commands.literal("remove").then(Commands.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> owners(c, false))))))
                .then(Commands.literal("raid").requires(s -> s.hasPermission(2))
                    .executes(c -> SquadRaid.call(c.getSource(), ""))
                    .then(Commands.literal("clear").executes(c -> SquadRaid.clear(c.getSource())))
                    .then(Commands.literal("stop").executes(c -> SquadRaid.stop(c.getSource())))
                    .then(Commands.argument("args", StringArgumentType.greedyString())
                        .executes(c -> SquadRaid.call(c.getSource(), StringArgumentType.getString(c, "args")))))
                // A General (docs/38): a Claude Code instance commanding an army, no body.
                .then(Commands.literal("general").requires(s -> s.hasPermission(2))
                    .executes(c -> reply(c.getSource(), "[Bots] Usage : " + SquadGeneralPlan.CREATE_USAGE + " · allow NOM … · tell NOM texte · stop NOM [despawn] · list"))
                    .then(Commands.literal("create")
                        .executes(c -> reply(c.getSource(), "[Bots] Usage : " + SquadGeneralPlan.CREATE_USAGE))
                        .then(Commands.argument("args", StringArgumentType.greedyString()).suggests(GENERAL_TERMS)
                            .executes(c -> SquadGeneral.create(c.getSource(), StringArgumentType.getString(c, "args")))))
                    .then(Commands.literal("allow")
                        .then(Commands.argument("args", StringArgumentType.greedyString()).suggests(GENERAL_TERMS)
                            .executes(c -> SquadGeneral.allow(c.getSource(), StringArgumentType.getString(c, "args")))))
                    .then(Commands.literal("tell")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .then(Commands.argument("text", StringArgumentType.greedyString())
                                .executes(c -> SquadGeneral.tell(c.getSource(), StringArgumentType.getString(c, "name"), StringArgumentType.getString(c, "text"))))))
                    .then(Commands.literal("stop")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .executes(c -> SquadGeneral.stop(c.getSource(), StringArgumentType.getString(c, "name"), false))
                            .then(Commands.literal("despawn")
                                .executes(c -> SquadGeneral.stop(c.getSource(), StringArgumentType.getString(c, "name"), true)))))
                    .then(Commands.literal("list").executes(c -> SquadGeneral.list(c.getSource()))))
                .then(Commands.literal("squad").requires(s -> s.hasPermission(2))
                    .then(Commands.literal("spawn")
                        .executes(c -> reply(c.getSource(), "[Bots] Usage : " + SquadSpawnPlan.SPAWN_USAGE))
                        .then(Commands.argument("args", StringArgumentType.greedyString()).suggests(SQUAD_LINE)
                            .executes(c -> SquadSpawn.spawn(c.getSource(), StringArgumentType.getString(c, "args")))))
                    .then(Commands.literal("despawn")
                        .executes(c -> SquadSpawn.despawn(c.getSource(), ""))
                        .then(Commands.argument("args", StringArgumentType.greedyString()).suggests(SQUAD_LINE)
                            .executes(c -> SquadSpawn.despawn(c.getSource(), StringArgumentType.getString(c, "args")))))
                    .then(Commands.literal("respawn")
                        .executes(c -> SquadSpawn.respawn(c.getSource(), ""))
                        .then(Commands.argument("args", StringArgumentType.greedyString()).suggests(SQUAD_LINE)
                            .executes(c -> SquadSpawn.respawn(c.getSource(), StringArgumentType.getString(c, "args")))))
                    .then(Commands.literal("purge").executes(c -> SquadSpawn.purge(c.getSource()))))
                .then(Commands.literal("equip").requires(s -> s.hasPermission(2))
                    .then(Commands.argument("bot", StringArgumentType.word()).suggests(ALL_BOTS)
                        .then(Commands.argument("kit", StringArgumentType.word()).suggests(KITS)
                            .executes(c -> equip(c, StringArgumentType.getString(c, "bot"), StringArgumentType.getString(c, "kit"))))))
                // -- owners -------------------------------------------------------------------------------------
                .then(Commands.literal("create")
                    .then(Commands.argument("name", StringArgumentType.word())
                        .executes(c -> reply(c.getSource(), "[Bots] Dis ce que la commande doit faire : /bots create "
                            + StringArgumentType.getString(c, "name") + " <description>"))
                        .then(Commands.argument("request", StringArgumentType.greedyString())
                            .executes(c -> author(c, "create", StringArgumentType.getString(c, "request"))))))
                .then(Commands.literal("fix")
                    .then(Commands.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .executes(c -> author(c, "fix", ""))
                        .then(Commands.argument("feedback", StringArgumentType.greedyString())
                            .executes(c -> author(c, "fix", StringArgumentType.getString(c, "feedback"))))))
                .then(Commands.literal("order")
                    // Greedy: "owner:NAME" has a colon, which a Brigadier word refuses. First token = the command.
                    .then(Commands.argument("command", StringArgumentType.greedyString()).suggests(ORDER_LINE)
                        .executes(c -> order(c, StringArgumentType.getString(c, "command")))))
                .then(Commands.literal("stop")
                    .executes(c -> stop(c, ""))
                    .then(Commands.argument("target", StringArgumentType.greedyString()).suggests(STOP_TARGETS)
                        .executes(c -> stop(c, StringArgumentType.getString(c, "target")))))
                .then(Commands.literal("list")
                    .executes(c -> call(c, "/api/bots/list", b -> b))
                    .then(Commands.literal("all").requires(s -> s.hasPermission(2))
                        .executes(c -> call(c, "/api/bots/list", b -> {
                            b.addProperty("all", true);
                            return b;
                        }))))
                .then(Commands.literal("orders").executes(c -> call(c, "/api/orders/list", b -> b))
                    // Bound items (docs/29 §5.4): anyone, a captain may bind items to hand out. Greedy like `order`.
                    .then(Commands.literal("bind")
                        .executes(c -> reply(c.getSource(), BIND_USAGE))
                        .then(Commands.argument("line", StringArgumentType.greedyString()).suggests(ORDER_LINE)
                            .executes(c -> bind(c, StringArgumentType.getString(c, "line")))))
                    .then(Commands.literal("unbind").executes(SquadCommand::unbind))
                    .then(Commands.literal("bound").executes(SquadCommand::bound)))
                .then(Commands.literal("status").executes(SquadCommand::status))
                .then(Commands.literal("tag")
                    .then(Commands.argument("bot", StringArgumentType.word()).suggests(MY_BOTS)
                        .then(Commands.argument("changes", StringArgumentType.greedyString())
                            .executes(c -> call(c, "/api/bots/tag", b -> {
                                b.addProperty("name", StringArgumentType.getString(c, "bot"));
                                b.add("changes", array(SquadArgs.tokenize(StringArgumentType.getString(c, "changes"))));
                                return b;
                            })))))
                .then(Commands.literal("commands").executes(c -> call(c, "/api/commands/list", b -> b)))
                .then(Commands.literal("show")
                    .then(Commands.argument("name", StringArgumentType.greedyString()).suggests(MY_COMMANDS)
                        .executes(c -> call(c, "/api/commands/show", b -> {
                            b.addProperty("name", StringArgumentType.getString(c, "name").trim());
                            return b;
                        }))))
                .then(Commands.literal("share")
                    .then(Commands.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .then(Commands.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> share(c, false)))))
                .then(Commands.literal("unshare")
                    .then(Commands.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .then(Commands.argument("players", StringArgumentType.greedyString()).suggests(ONLINE_PLAYERS)
                            .executes(c -> share(c, true)))))
                .then(Commands.literal("delete")
                    .then(Commands.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .executes(c -> call(c, "/api/commands/delete", b -> {
                            b.addProperty("name", StringArgumentType.getString(c, "name"));
                            return b;
                        }))))
                .then(Commands.literal("revert")
                    .then(Commands.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .then(Commands.argument("version", IntegerArgumentType.integer(1))
                            .executes(c -> call(c, "/api/commands/revert", b -> {
                                b.addProperty("name", StringArgumentType.getString(c, "name"));
                                b.addProperty("version", IntegerArgumentType.getInteger(c, "version"));
                                return b;
                            })))))
                .then(Commands.literal("ticket")
                    .then(Commands.literal("revoke").executes(c -> call(c, "/api/authoring/revoke", b -> b)))
                    .then(Commands.argument("name", StringArgumentType.word()).suggests(OWN_COMMANDS)
                        .executes(SquadCommand::ticket)))
        ));
    }

    // -- suggestions ------------------------------------------------------------------------------------------------

    private static final SuggestionProvider<CommandSourceStack> KITS = (c, b) -> SharedSuggestionProvider.suggest(SquadKits.NAMES, b);
    /** {@code NAME archer=… guard=…}: the next key=value of {@code /bots general create|allow}. */
    private static final SuggestionProvider<CommandSourceStack> GENERAL_TERMS = (c, b) -> {
        String typed = b.getRemaining();
        int cut = typed.lastIndexOf(' ') + 1;
        if (cut == 0) return b.buildFuture(); // the General's name first
        var next = b.createOffset(b.getStart() + cut);
        for (String k : List.of("archer=", "guard=", "miner=", "farmer=", "reinforce=", "range=")) {
            if (k.startsWith(typed.substring(cut).toLowerCase(Locale.ROOT)) && !typed.contains(k)) next.suggest(k);
        }
        return next.buildFuture();
    };
    /** {@code /bots squad spawn|despawn|respawn …}: a kit first, then @s and online players (the owners). */
    private static final SuggestionProvider<CommandSourceStack> SQUAD_LINE = (c, b) -> {
        String rem = b.getRemaining();
        int cut = rem.lastIndexOf(' ') + 1;
        if (cut == 0) return SharedSuggestionProvider.suggest(SquadKits.NAMES, b);
        List<String> opts = new ArrayList<>(List.of("@s"));
        opts.addAll(List.of(c.getSource().getServer().getPlayerNames()));
        return SharedSuggestionProvider.suggest(opts, b.createOffset(b.getStart() + cut));
    };
    private static final SuggestionProvider<CommandSourceStack> ALL_BOTS = (c, b) -> SharedSuggestionProvider.suggest(Squad.botNames(), b);
    private static final SuggestionProvider<CommandSourceStack> MY_BOTS = (c, b) -> {
        ServerPlayer p = c.getSource().getPlayer();
        return SharedSuggestionProvider.suggest(p == null || c.getSource().hasPermission(2) ? Squad.botNames() : Squad.botsOf(p.getUUID()), b);
    };
    /** {@code /bots order …}: the command name first, then {@code @bot} filters and the take flags. */
    private static final SuggestionProvider<CommandSourceStack> ORDER_LINE = (c, b) -> {
        ServerPlayer p = c.getSource().getPlayer();
        if (p == null) return b.buildFuture();
        String rem = b.getRemaining();
        int cut = rem.lastIndexOf(' ') + 1;
        if (cut == 0) return SharedSuggestionProvider.suggest(Squad.commandsOf(p.getUUID(), false), b);
        List<String> opts = new ArrayList<>();
        for (String n : Squad.botsOf(p.getUUID())) opts.add("@" + n);
        opts.add("--reclaim");
        opts.add("--free");
        return SharedSuggestionProvider.suggest(opts, b.createOffset(b.getStart() + cut));
    };
    private static final SuggestionProvider<CommandSourceStack> MY_COMMANDS = (c, b) -> {
        ServerPlayer p = c.getSource().getPlayer();
        return SharedSuggestionProvider.suggest(p == null ? List.of() : Squad.commandsOf(p.getUUID(), false), b);
    };
    private static final SuggestionProvider<CommandSourceStack> OWN_COMMANDS = (c, b) -> {
        ServerPlayer p = c.getSource().getPlayer();
        return SharedSuggestionProvider.suggest(p == null ? List.of() : Squad.commandsOf(p.getUUID(), true), b);
    };
    private static final SuggestionProvider<CommandSourceStack> ONLINE_PLAYERS = (c, b) -> {
        String rem = b.getRemaining();
        int cut = Math.max(rem.lastIndexOf(' '), rem.lastIndexOf(',')) + 1;
        return SharedSuggestionProvider.suggest(c.getSource().getServer().getPlayerNames(), b.createOffset(b.getStart() + cut));
    };
    private static final SuggestionProvider<CommandSourceStack> STOP_TARGETS = (c, b) -> {
        ServerPlayer p = c.getSource().getPlayer();
        List<String> opts = new ArrayList<>(List.of("all"));
        opts.addAll(Squad.orderIds());
        if (p != null) {
            for (String n : Squad.botsOf(p.getUUID())) opts.add("@" + n);
            opts.addAll(Squad.commandsOf(p.getUUID(), false));
        }
        return SharedSuggestionProvider.suggest(opts, b);
    };

    // -- handlers ---------------------------------------------------------------------------------------------------

    private static int help(CommandSourceStack src) {
        String[] lines = {
            "[Bots] Tes bots exécutent des commandes écrites sur demande :",
            " /bots create NOM <ce qu'elle doit faire> — faire écrire une commande",
            " /bots order NOM [arguments] [@bot …] [--reclaim|--free] — la lancer sur tes bots",
            " /bots stop [all | #id | NOM | @bot] — arrêter",
            " /bots fix NOM [ce qui ne va pas] — la corriger d'après son dernier rapport",
            " /bots orders bind NOM [arguments] — lier l'objet en main : clic droit lance l'ordre, accroupi + clic droit l'arrête · orders unbind · orders bound",
            " /bots list · orders · commands · show NOM · tag BOT +étiquette -étiquette · status",
            " /bots share NOM JOUEUR… · unshare · delete NOM · revert NOM VERSION · ticket NOM",
        };
        for (String l : lines) src.sendSuccess(() -> Component.literal(l), false);
        if (src.hasPermission(2)) {
            src.sendSuccess(() -> Component.literal(" Admin : /bots spawn BOT JOUEUR1 [JOUEUR2 …] · squad spawn KIT [nombre] [propriétaire=@s] [autres…] · squad despawn [KIT] [propriétaire=@s] · squad respawn [KIT] [nombre] [propriétaire=@s] (un bot mort reste déconnecté jusque-là) · squad purge (les sauvegardes laissées par d'anciens bots) · equip BOT archer|guard|miner|farmer (il devient aussi à toi) · raid [distance] [archers] [gardes] | clear | stop · general create NOM archer=N guard=N [reinforce=N] [range=N] | allow | tell | stop | list · despawn BOT|all · owners BOT add|remove JOUEUR… · list all · stop all"), false);
        }
        return Command.SINGLE_SUCCESS;
    }

    private static int spawn(CommandContext<CommandSourceStack> c, String bot, String ownersText) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        CommandSourceStack src = c.getSource();
        MinecraftServer srv = src.getServer();
        if (!SquadArgs.BOT_NAME.matcher(bot).matches()) return reply(src, "[Bots] Nom de bot invalide (3 à 16 caractères : lettres, chiffres, _).");
        if (srv.getPlayerList().getPlayerByName(bot) != null || Squad.hasPlayed(srv, bot)) {
            return reply(src, "[Bots] " + bot + " est le nom d'un joueur qui a déjà joué ici (le bot hériterait de son inventaire) : choisis-en un autre.");
        }
        if (reservedName(bot)) return reply(src, "[Bots] " + bot + " est réservé (avatar de Dieu ou villageois).");
        // "all" is the keyword of /bots despawn all: a bot of that name could not be despawned alone.
        if (bot.equalsIgnoreCase("all")) return reply(src, "[Bots] « all » est réservé (/bots despawn all) : choisis un autre nom.");
        JsonArray owners = new JsonArray();
        for (String name : SquadArgs.names(ownersText)) {
            Optional<GameProfile> p = owner(src, name);
            if (p.isEmpty()) return reply(src, "[Bots] Joueur inconnu : " + name);
            owners.add(Squad.player(p.get()));
        }
        ServerPlayer admin = src.getPlayer();
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

    /**
     * {@code /bots equip BOT KIT} (admin): the kit's items server-side, then the kit's tag on the runtime's roster. The
     * caller, when a player, also becomes one of the bot's owners (its other owners keep it), so the bot they just
     * armed is theirs to order (the world's datapack function squad:equiper relies on it).
     */
    private static int equip(CommandContext<CommandSourceStack> c, String bot, String kitName) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        CommandSourceStack src = c.getSource();
        Optional<SquadKits.Kit> kit = SquadKits.find(kitName);
        if (kit.isEmpty()) return reply(src, "[Bots] Kit inconnu : " + kitName + " (" + String.join(", ", SquadKits.NAMES) + ").");
        Optional<String> name = Squad.botNames().stream().filter(n -> n.equalsIgnoreCase(bot)).findFirst();
        if (name.isEmpty()) return reply(src, "[Bots] " + bot + " n'est pas un bot de la squad (/bots list all).");
        Squad.equipLater(src.getServer(), name.get(), kit.get(), answer -> reply(src, answer));
        JsonObject body = base(src);
        body.addProperty("name", name.get());
        body.add("changes", array(SquadKits.tagChanges(kit.get())));
        Squad.client().post("/api/bots/tag", body).thenAccept(r -> {
            if (!SquadAuthoring.ok(r)) src.getServer().execute(() -> show(src, r));
        });
        ServerPlayer caller = src.getPlayer();
        if (caller != null && !Squad.botsOf(caller.getUUID()).contains(name.get())) {
            JsonObject own = base(src);
            own.addProperty("name", name.get());
            JsonArray add = new JsonArray();
            add.add(Squad.player(caller.getGameProfile()));
            own.add("add", add);
            Squad.client().post("/api/bots/owners", own).thenAccept(r -> src.getServer().execute(() -> show(src, r)));
        }
        return Command.SINGLE_SUCCESS;
    }

    /**
     * A player named in {@code spawn}, {@code owners} or {@code share}: {@code @s} is whoever runs the command (a
     * player typing it, or the player running a datapack function such as the world's squad:armee), else
     * {@link Squad#profile}.
     */
    static Optional<GameProfile> owner(CommandSourceStack src, String name) {
        if (name.equals("@s")) {
            ServerPlayer self = src.getPlayer();
            return self == null ? Optional.empty() : Optional.of(self.getGameProfile());
        }
        return Squad.profile(src.getServer(), name);
    }

    static boolean reservedName(String bot) {
        String n = bot.toLowerCase(Locale.ROOT);
        return n.equals(com.paul.brawl.BridgeConfig.INSTANCE.botUsername.toLowerCase(Locale.ROOT))
            || n.equals(com.paul.brawl.VillageConfig.INSTANCE.edenAvatarName.toLowerCase(Locale.ROOT))
            || com.paul.brawl.VillagersCommand.activeScenarioBots.stream().anyMatch(v -> v.equalsIgnoreCase(bot));
    }

    private static int despawn(CommandContext<CommandSourceStack> c, String bot) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        CommandSourceStack src = c.getSource();
        despawnBot(src, bot).thenAccept(r -> src.getServer().execute(() -> show(src, r)));
        return Command.SINGLE_SUCCESS;
    }

    /**
     * {@code /bots despawn all} (admin): every roster bot, each through {@link #despawnBot} (stopped, disconnected,
     * unwhitelisted, forgotten), and a raid still assembling is cancelled so it spawns no more. One line at the end.
     */
    private static int despawnAll(CommandSourceStack src) {
        if (!Squad.enabled()) return reply(src, DISABLED);
        SquadRaid.cancelAssembling();
        List<String> bots = Squad.botNames();
        if (bots.isEmpty()) return reply(src, "[Bots] Aucun bot à retirer.");
        java.util.concurrent.atomic.AtomicInteger gone = new java.util.concurrent.atomic.AtomicInteger();
        CompletableFuture<?>[] all = bots.stream()
            .map(n -> despawnBot(src, n).thenAccept(r -> {
                if (SquadAuthoring.ok(r)) gone.incrementAndGet();
            }))
            .toArray(CompletableFuture[]::new);
        CompletableFuture.allOf(all).thenRun(() -> src.getServer().execute(() ->
            reply(src, "[Bots] " + gone.get() + " bot(s) retiré(s)" + (gone.get() < bots.size() ? " sur " + bots.size() : "") + ".")));
        return Command.SINGLE_SUCCESS;
    }

    /**
     * Despawn one bot (the runtime first), then on the server thread: unwhitelist and disconnect it, and delete its
     * save once it has left (Squad.forgetSave), so its name is free for the next spawn.
     */
    static CompletableFuture<JsonObject> despawnBot(CommandSourceStack src, String bot) {
        MinecraftServer srv = src.getServer();
        JsonObject body = base(src);
        body.addProperty("name", bot);
        CompletableFuture<JsonObject> done = new CompletableFuture<>();
        Squad.client().post("/api/bots/despawn", body).thenAccept(r -> srv.execute(() -> {
            try {
                if (SquadAuthoring.ok(r) && r.has("bot")) {
                    String name = r.getAsJsonObject("bot").get("name").getAsString();
                    Squad.whitelist(srv, name, false);
                    ServerPlayer p = srv.getPlayerList().getPlayerByName(name);
                    if (p != null) p.connection.disconnect(Component.literal("Bot retiré."));
                    Squad.forgetSave(name);
                }
            } finally {
                done.complete(r);
            }
        }));
        return done;
    }

    private static int owners(CommandContext<CommandSourceStack> c, boolean add) {
        CommandSourceStack src = c.getSource();
        JsonArray players = new JsonArray();
        for (String name : SquadArgs.names(StringArgumentType.getString(c, "players"))) {
            Optional<GameProfile> p = owner(src, name);
            if (p.isEmpty()) return reply(src, "[Bots] Joueur inconnu : " + name);
            players.add(Squad.player(p.get()));
        }
        return call(c, "/api/bots/owners", b -> {
            b.addProperty("name", StringArgumentType.getString(c, "bot"));
            b.add(add ? "add" : "remove", players);
            return b;
        });
    }

    private static int author(CommandContext<CommandSourceStack> c, String mode, String text) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerPlayer p = c.getSource().getPlayer();
        if (p == null) return reply(c.getSource(), "[Bots] À lancer en jeu, par un joueur.");
        String name = StringArgumentType.getString(c, "name").toLowerCase(Locale.ROOT);
        if (!SquadArgs.COMMAND_NAME.matcher(name).matches()) return reply(c.getSource(), "[Bots] Nom de commande invalide (a-z, 0-9 et -, 2 à 32 caractères).");
        String playerName = p.getName().getString();
        CommanderSnap.take(p).thenAccept(snap -> Squad.authoring().start(mode, p.getUUID(), playerName, name, text, snap));
        return Command.SINGLE_SUCCESS;
    }

    private static int order(CommandContext<CommandSourceStack> c, String line) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerPlayer p = c.getSource().getPlayer();
        if (p == null) return reply(c.getSource(), "[Bots] À lancer en jeu, par un joueur (les bots ont besoin de ta position).");
        String trimmed = line.trim();
        int sp = trimmed.indexOf(' ');
        String name = sp < 0 ? trimmed : trimmed.substring(0, sp);
        SquadArgs.OrderArgs a = SquadArgs.order(sp < 0 ? "" : trimmed.substring(sp + 1));
        // The order starts once the look is found (SquadLook: on its worker, a tick or more).
        CommanderSnap.take(p).thenAccept(snap -> call(c, "/api/orders/start", b -> {
            b.addProperty("command", name);
            b.add("tokens", array(a.tokens()));
            b.add("filters", array(a.filters()));
            if (a.take() != null) b.addProperty("take", a.take());
            b.add("snap", snap);
            return b;
        }));
        return Command.SINGLE_SUCCESS;
    }

    /**
     * {@code /bots orders bind <order> [args…]}: the runtime checks the order as {@code /bots order} would, then, back
     * on the server thread, the binding is written on the held stack, if it is still the one held when the command
     * was typed (same hotbar slot, same item).
     */
    private static int bind(CommandContext<CommandSourceStack> c, String typed) {
        CommandSourceStack src = c.getSource();
        if (!Squad.enabled()) return reply(src, DISABLED);
        ServerPlayer p = src.getPlayer();
        if (p == null) return reply(src, "[Bots] À lancer en jeu, par un joueur (l'objet en main est lié).");
        Optional<SquadBinding.BindLine> line = SquadBinding.parse(typed);
        if (line.isEmpty()) return reply(src, BIND_USAGE);
        String order = line.get().order();
        if (!SquadBinding.validOrder(order)) return reply(src, "[Bots] Nom de commande invalide : " + order + " (NOM ou auteur:NOM).");
        ItemStack held = p.getMainHandItem();
        if (held.isEmpty()) return reply(src, "[Bots] Prends en main l'objet à lier (un bouclier, une épée, un arc…).");
        int slot = p.getInventory().selected;
        Item item = held.getItem();
        String rest = line.get().rest();
        SquadArgs.OrderArgs a = SquadArgs.order(rest);
        JsonObject body = base(src);
        body.addProperty("command", order);
        body.add("tokens", array(a.tokens()));
        body.add("filters", array(a.filters()));
        MinecraftServer srv = src.getServer();
        Squad.client().post("/api/orders/check", body).thenAccept(r -> srv.execute(() -> {
            if (!SquadAuthoring.ok(r)) {
                show(src, r);
                return;
            }
            ItemStack now = p.getMainHandItem();
            if (p.isRemoved() || now.isEmpty() || p.getInventory().selected != slot || !now.is(item)) {
                reply(src, "[Bots] Tu n'as plus le même objet en main : rien n'a été lié.");
                return;
            }
            String canonical = r.has("command") && r.get("command").isJsonPrimitive() ? r.get("command").getAsString() : order;
            SquadBinding.write(now, canonical, rest);
            String how = SquadBinding.isLauncher(now) ? "tire une flèche" : "clic droit";
            // "Ordre … lié" rather than "<item> lié": the item's name may be feminine (Épée, Arbalète, Flèche).
            Component t = prefix().append(Component.literal("Ordre « " + canonical + " » lié à ton objet (")).append(now.getHoverName())
                .append(Component.literal(") : " + how + " pour lancer ou réorienter, accroupi + clic droit pour arrêter."));
            src.sendSuccess(() -> t, false);
        }));
        return Command.SINGLE_SUCCESS;
    }

    /** {@code /bots orders unbind}: local, so it works with Squad off too (an item can always be cleaned). */
    private static int unbind(CommandContext<CommandSourceStack> c) {
        CommandSourceStack src = c.getSource();
        ServerPlayer p = src.getPlayer();
        if (p == null) return reply(src, "[Bots] À lancer en jeu, par un joueur.");
        ItemStack held = p.getMainHandItem();
        Optional<SquadBinding> b = SquadBinding.clear(held);
        if (b.isEmpty()) return reply(src, "[Bots] Cet objet n'est lié à aucun ordre.");
        Component t = prefix().append(Component.literal("Ordre « " + b.get().order() + " » délié de ton objet (")).append(held.getHoverName()).append(Component.literal(")."));
        src.sendSuccess(() -> t, false);
        return Command.SINGLE_SUCCESS;
    }

    /** {@code /bots orders bound}: the bound stacks of the main inventory and the off-hand, one line each. */
    private static int bound(CommandContext<CommandSourceStack> c) {
        CommandSourceStack src = c.getSource();
        ServerPlayer p = src.getPlayer();
        if (p == null) return reply(src, "[Bots] À lancer en jeu, par un joueur.");
        List<Component> lines = new ArrayList<>();
        List<ItemStack> stacks = new ArrayList<>(p.getInventory().items);
        stacks.addAll(p.getInventory().offhand);
        for (ItemStack s : stacks) {
            SquadBinding.read(s).ifPresent(b -> lines.add(Component.literal(" • ").append(s.getHoverName())
                .append(Component.literal(" : " + b.order() + (b.line().isBlank() ? "" : " " + b.line())))));
        }
        if (lines.isEmpty()) return reply(src, "[Bots] Aucun objet lié dans ton inventaire (/bots orders bind NOM, l'objet en main).");
        reply(src, "[Bots] Objets liés :");
        for (Component t : lines) src.sendSuccess(() -> t, false);
        return Command.SINGLE_SUCCESS;
    }

    /** "[Bots] " styled as {@link Squad#render} styles it, for a line that carries an item's (translated) name. */
    private static MutableComponent prefix() {
        return Component.literal("[Bots]").withStyle(ChatFormatting.AQUA).append(Component.literal(" "));
    }

    private static int stop(CommandContext<CommandSourceStack> c, String target) {
        return call(c, "/api/orders/stop", b -> {
            b.addProperty("target", target.trim());
            return b;
        });
    }

    private static int share(CommandContext<CommandSourceStack> c, boolean remove) {
        CommandSourceStack src = c.getSource();
        JsonArray players = new JsonArray();
        for (String name : SquadArgs.names(StringArgumentType.getString(c, "players"))) {
            Optional<GameProfile> p = owner(src, name);
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
    private static int ticket(CommandContext<CommandSourceStack> c) {
        if (!Squad.enabled()) return reply(c.getSource(), DISABLED);
        ServerPlayer p = c.getSource().getPlayer();
        if (p == null) return reply(c.getSource(), "[Bots] À lancer en jeu, par un joueur.");
        CommandSourceStack src = c.getSource();
        JsonObject body = base(src);
        body.addProperty("mode", "manual");
        body.addProperty("name", StringArgumentType.getString(c, "name").toLowerCase(Locale.ROOT));
        body.addProperty("request", "");
        CommanderSnap.take(p).thenCompose(snap -> {
            body.add("snap", snap);
            return Squad.client().post("/api/authoring/open", body);
        }).thenAccept(r -> src.getServer().execute(() -> {
            if (!SquadAuthoring.ok(r)) {
                show(src, r);
                return;
            }
            String id = r.get("ticket").getAsString();
            Component t = Component.literal(id).withStyle(s -> s.withColor(ChatFormatting.GOLD).withUnderlined(true)
                .withClickEvent(new net.minecraft.network.chat.ClickEvent(net.minecraft.network.chat.ClickEvent.Action.COPY_TO_CLIPBOARD, id))
                .withHoverEvent(new net.minecraft.network.chat.HoverEvent(net.minecraft.network.chat.HoverEvent.Action.SHOW_TEXT, Component.literal("Clique pour copier le ticket"))));
            src.sendSuccess(() -> Component.literal("[Bots] Ticket d'écriture (2 h) : ").append(t), false);
            src.sendSuccess(() -> Component.literal("Serveur MCP : " + SquadConfig.INSTANCE.url + "/mcp/squad — donne ce ticket à ton agent ; /bots ticket revoke l'annule."), false);
        }));
        return Command.SINGLE_SUCCESS;
    }

    /**
     * {@code /bots status} (anyone, docs/32 C): the runtime's load over its last 10 s window — ELU, the loop's p99
     * and the slowest bot's ticks per second. The line is built by {@link SquadStatusFormat}.
     */
    private static int status(CommandContext<CommandSourceStack> c) {
        CommandSourceStack src = c.getSource();
        if (!Squad.enabled()) return reply(src, DISABLED);
        Squad.client().post("/api/metrics", base(src)).thenAccept(r -> src.getServer().execute(() -> reply(src, SquadStatusFormat.format(r))));
        return Command.SINGLE_SUCCESS;
    }

    // -- plumbing ---------------------------------------------------------------------------------------------------

    /** POST with {@code by}/{@code admin} added; show the runtime's answer to the source. */
    private static int call(CommandContext<CommandSourceStack> c, String path, Function<JsonObject, JsonObject> fill) {
        CommandSourceStack src = c.getSource();
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
    static JsonObject base(CommandSourceStack src) {
        JsonObject b = new JsonObject();
        ServerPlayer p = src.getPlayer();
        JsonObject by = new JsonObject();
        by.addProperty("uuid", p != null ? p.getStringUUID() : "00000000-0000-0000-0000-00000000c0de");
        by.addProperty("name", p != null ? p.getName().getString() : "Console");
        b.add("by", by);
        b.addProperty("admin", src.hasPermission(2));
        return b;
    }

    static void show(CommandSourceStack src, JsonObject r) {
        SquadNotice n = SquadNotice.fromJson(r);
        if (n.text().isBlank()) return;
        for (Component t : Squad.render(n)) src.sendSuccess(() -> t, false);
    }

    static int reply(CommandSourceStack src, String text) {
        for (Component t : Squad.render(SquadNotice.of(text))) src.sendSuccess(() -> t, false);
        return 0;
    }

    static JsonArray array(List<String> items) {
        JsonArray a = new JsonArray();
        for (String s : items) a.add(s);
        return a;
    }
}
