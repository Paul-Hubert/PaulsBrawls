package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.Command;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.world.Heightmap;

/**
 * {@code /bots raid [distance] [archers] [guards]} (admin, run by a player): an enemy army, fully equipped, appears
 * {@code distance} blocks ahead of the caller and attacks the caller's own bots (the stock {@code raid} command).
 * {@code /bots raid stop} stops it; {@code /bots raid clear} despawns every raider.
 *
 * <p>The raiders are ordinary roster bots owned by {@link SquadRaidPlan#OWNER}, a virtual player, so they are
 * the caller's enemies for the friendly-fire rule and for the scripts. They go through the runtime like
 * {@code /bots spawn} (whitelist, join gate); on their first join each one is teleported to its place at the spawn
 * point and given its kit. When all have come (or after {@link SquadRaidPlan#startTimeoutMs}), the raid order starts
 * on behalf of the owner. Everything here runs on the server thread; the HTTP answers hop back to it.
 */
final class SquadRaid {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");
    /** After the last raider came: time for its kit to reach the runtime's bot (role selectors read its inventory). */
    private static final long SETTLE_MS = 3_000;

    /** The raid being assembled (one at a time), or null. Server thread only. */
    private static Pending pending;

    /** A raid between `/bots raid` and the start of its order. */
    private static final class Pending {
        final ServerCommandSource src;
        final String caller;
        final double x, y, z;
        final String dimension;
        final ServerWorld world;
        final XYZ spawn;
        final float yaw;
        final Set<String> waiting = new HashSet<>();
        final List<String> spawned = new ArrayList<>();
        boolean spawning = true;
        boolean launched;

        Pending(ServerCommandSource src, ServerPlayerEntity caller, XYZ spawn, float yaw) {
            this.src = src;
            this.caller = caller.getName().getString();
            this.x = caller.getX();
            this.y = caller.getY();
            this.z = caller.getZ();
            this.dimension = caller.getWorld().getRegistryKey().getValue().getPath();
            this.world = caller.getServerWorld();
            this.spawn = spawn;
            this.yaw = yaw;
        }
    }

    private record XYZ(double x, double y, double z) {}

    private record Raider(String name, SquadKits.Kit kit, XYZ at) {}

    private SquadRaid() {}

    // -- /bots raid ---------------------------------------------------------------------------------------------------

    static int call(ServerCommandSource src, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, "[Bots] Squad est désactivé (squad.properties : enabled=false).");
        ServerPlayerEntity p = src.getPlayer();
        if (p == null) return SquadCommand.reply(src, "[Bots] À lancer en jeu, par un joueur (l'armée apparaît devant toi).");
        SquadRaidPlan.Args a;
        try {
            a = SquadRaidPlan.parse(text);
        } catch (IllegalArgumentException e) {
            return SquadCommand.reply(src, "[Bots] " + e.getMessage() + ".");
        }
        if (pending != null && !pending.launched) return SquadCommand.reply(src, "[Bots] Un raid est déjà en préparation : attends son départ, ou /bots raid clear.");
        MinecraftServer srv = src.getServer();
        Optional<GameProfile> owner = Squad.profile(srv, SquadRaidPlan.OWNER);
        if (owner.isEmpty()) return SquadCommand.reply(src, "[Bots] Le propriétaire virtuel " + SquadRaidPlan.OWNER + " est introuvable (le serveur doit être en mode hors ligne).");

        // Names nobody uses: not in the roster, not online, never played here (a bot would load that save).
        List<String> roster = Squad.botNames();
        java.util.function.Predicate<String> taken = n -> roster.stream().anyMatch(r -> r.equalsIgnoreCase(n))
            || srv.getPlayerManager().getPlayer(n) != null || Squad.hasPlayed(srv, n) || SquadCommand.reservedName(n);
        List<String> archers = SquadRaidPlan.names(SquadRaidPlan.ARCHER_PREFIX, a.archers(), taken);
        List<String> guards = SquadRaidPlan.names(SquadRaidPlan.GUARD_PREFIX, a.guards(), taken);

        ServerWorld world = p.getServerWorld();
        SquadRaidPlan.XZ point = SquadRaidPlan.point(p.getX(), p.getZ(), p.getYaw(), a.distance());
        XYZ center = surface(world, point.x(), point.z());
        // They face the caller: the look direction turned around.
        float facing = p.getYaw() + 180;
        List<Raider> raiders = new ArrayList<>();
        int n = a.total();
        SquadKits.Kit archerKit = SquadKits.find("archer").orElseThrow();
        SquadKits.Kit guardKit = SquadKits.find("guard").orElseThrow();
        for (int i = 0; i < n; i++) {
            SquadRaidPlan.XZ d = SquadRaidPlan.spread(i, n);
            // Guards first, in the front rows (nearer the caller), archers behind them.
            boolean guard = i < guards.size();
            String name = guard ? guards.get(i) : archers.get(i - guards.size());
            SquadRaidPlan.XZ front = rotate(d, facing);
            raiders.add(new Raider(name, guard ? guardKit : archerKit, surface(world, point.x() + front.x(), point.z() + front.z())));
        }

        Pending raid = new Pending(src, p, center, facing);
        pending = raid;
        SquadCommand.reply(src, String.format(Locale.ROOT,
            "[Bots] Raid : %d envahisseurs (%d archers, %d gardes) apparaissent à %d blocs, en %d %d %d. Ils viennent pour tes bots…",
            n, a.archers(), a.guards(), a.distance(), Math.round(center.x()), Math.round(center.y()), Math.round(center.z())));
        spawnNext(raid, raiders, 0, owner.get());
        return Command.SINGLE_SUCCESS;
    }

    /** Spawn the raiders one by one (the runtime answers in order; the first refusal, e.g. the bot limit, ends it). */
    private static void spawnNext(Pending raid, List<Raider> raiders, int i, GameProfile owner) {
        MinecraftServer srv = raid.src.getServer();
        if (pending != raid) return; // cleared meanwhile
        if (i >= raiders.size()) {
            spawningDone(raid);
            return;
        }
        Raider r = raiders.get(i);
        JsonObject body = SquadCommand.base(raid.src);
        body.addProperty("name", r.name());
        com.google.gson.JsonArray owners = new com.google.gson.JsonArray();
        owners.add(Squad.player(owner));
        body.add("owners", owners);
        Squad.client().post("/api/bots/spawn", body).thenAccept(res -> srv.execute(() -> {
            if (pending != raid) return;
            if (!SquadAuthoring.ok(res)) {
                SquadNotice why = SquadNotice.fromJson(res);
                SquadCommand.reply(raid.src, "[Bots] Raid : " + r.name() + " refusé (" + why.text().replace("[Bots] ", "")
                    + ") ; " + raid.spawned.size() + " envahisseur(s) en route. Plus de bots : limits.maxBots dans squad/squad.json.");
                spawningDone(raid);
                return;
            }
            Squad.whitelist(srv, r.name(), true);
            raid.spawned.add(r.name());
            raid.waiting.add(r.name().toLowerCase(Locale.ROOT));
            Squad.expectArrival(r.name(), raid.world, r.at().x(), r.at().y(), r.at().z(), raid.yaw, bot -> arrived(raid, bot, r));
            spawnNext(raid, raiders, i + 1, owner);
        }));
    }

    /** Every spawn was answered: wait for the arrivals, at most startTimeoutMs. */
    private static void spawningDone(Pending raid) {
        raid.spawning = false;
        if (raid.spawned.isEmpty()) {
            if (pending == raid) pending = null;
            return;
        }
        MinecraftServer srv = raid.src.getServer();
        CompletableFuture.delayedExecutor(SquadRaidPlan.startTimeoutMs(raid.spawned.size()), TimeUnit.MILLISECONDS)
            .execute(() -> srv.execute(() -> launch(raid)));
        if (raid.waiting.isEmpty()) settleThenLaunch(raid);
    }

    /** A raider joined and stands at its place: its kit, its role tag; the raid starts once the last one is there. */
    private static void arrived(Pending raid, ServerPlayerEntity bot, Raider r) {
        String name = bot.getName().getString();
        LOGGER.info("Raider {} arrived at {} {} {}: {}", name, Math.round(r.at().x()), Math.round(r.at().y()), Math.round(r.at().z()),
            Squad.equip(raid.src.getServer(), name, r.kit()));
        JsonObject body = SquadCommand.base(raid.src);
        body.addProperty("name", name);
        body.add("changes", SquadCommand.array(SquadKits.tagChanges(r.kit())));
        Squad.client().post("/api/bots/tag", body).thenAccept(res -> {
            if (!SquadAuthoring.ok(res)) LOGGER.warn("Raider {}: tag {} refused: {}", name, r.kit().name(), SquadNotice.fromJson(res).text());
        });
        raid.waiting.remove(name.toLowerCase(Locale.ROOT));
        if (raid.waiting.isEmpty() && !raid.spawning) settleThenLaunch(raid);
    }

    private static void settleThenLaunch(Pending raid) {
        MinecraftServer srv = raid.src.getServer();
        CompletableFuture.delayedExecutor(SETTLE_MS, TimeUnit.MILLISECONDS).execute(() -> srv.execute(() -> launch(raid)));
    }

    /** Start the `raid` order as the virtual owner (once), toward where the caller stood, against the caller. */
    private static void launch(Pending raid) {
        if (raid.launched || pending != raid) return;
        raid.launched = true;
        pending = null;
        MinecraftServer srv = raid.src.getServer();
        Optional<GameProfile> owner = Squad.profile(srv, SquadRaidPlan.OWNER);
        if (owner.isEmpty()) return;
        int missing = raid.waiting.size();
        JsonObject body = ownerBody(owner.get());
        body.addProperty("command", "raid");
        body.add("tokens", SquadCommand.array(SquadRaidPlan.orderTokens(raid.x, raid.y, raid.z, raid.caller)));
        body.add("filters", new com.google.gson.JsonArray());
        body.add("snap", snap(raid));
        Squad.client().post("/api/orders/start", body).thenAccept(res -> srv.execute(() -> {
            String text = SquadNotice.fromJson(res).text().replace("[Bots] ", "");
            if (SquadAuthoring.ok(res)) {
                SquadCommand.reply(raid.src, "[Bots] Le raid est lancé contre " + raid.caller
                    + (missing > 0 ? " (" + missing + " envahisseur(s) pas encore arrivé(s))" : "") + " : " + text
                    + " /bots raid stop l'arrête, /bots raid clear retire l'armée.");
            } else {
                SquadCommand.reply(raid.src, "[Bots] Le raid n'a pas pu partir : " + text);
            }
        }));
    }

    // -- /bots raid stop, /bots raid clear -------------------------------------------------------------------------

    static int stop(ServerCommandSource src) {
        if (!Squad.enabled()) return SquadCommand.reply(src, "[Bots] Squad est désactivé (squad.properties : enabled=false).");
        Optional<GameProfile> owner = Squad.profile(src.getServer(), SquadRaidPlan.OWNER);
        if (owner.isEmpty()) return SquadCommand.reply(src, "[Bots] Aucun raid.");
        if (pending != null) pending.launched = true; // a raid still assembling will not start
        pending = null;
        JsonObject body = ownerBody(owner.get());
        body.addProperty("target", "");
        Squad.client().post("/api/orders/stop", body).thenAccept(res -> src.getServer().execute(() -> SquadCommand.show(src, res)));
        return Command.SINGLE_SUCCESS;
    }

    static int clear(ServerCommandSource src) {
        if (!Squad.enabled()) return SquadCommand.reply(src, "[Bots] Squad est désactivé (squad.properties : enabled=false).");
        Optional<GameProfile> owner = Squad.profile(src.getServer(), SquadRaidPlan.OWNER);
        List<String> raiders = owner.isEmpty() ? List.of() : Squad.botsOf(owner.get().getId());
        if (pending != null) {
            pending.launched = true;
            Squad.forgetArrivals(pending.spawned);
        }
        pending = null;
        if (raiders.isEmpty()) return SquadCommand.reply(src, "[Bots] Aucun envahisseur à retirer.");
        AtomicInteger gone = new AtomicInteger();
        CompletableFuture<?>[] all = raiders.stream()
            .map(n -> SquadCommand.despawnBot(src, n).thenAccept(r -> {
                if (SquadAuthoring.ok(r)) gone.incrementAndGet();
            }))
            .toArray(CompletableFuture[]::new);
        CompletableFuture.allOf(all).thenRun(() -> src.getServer().execute(() ->
            SquadCommand.reply(src, "[Bots] " + gone.get() + " envahisseur(s) retiré(s)" + (gone.get() < raiders.size() ? " sur " + raiders.size() : "") + ".")));
        return Command.SINGLE_SUCCESS;
    }

    // -- plumbing ---------------------------------------------------------------------------------------------------

    /** A request made on behalf of the virtual owner (an admin request: the mod is the one asking). */
    private static JsonObject ownerBody(GameProfile owner) {
        JsonObject b = new JsonObject();
        b.add("by", Squad.player(owner));
        b.addProperty("admin", true);
        return b;
    }

    /** The commander snapshot of the raid: the owner "stands" at the spawn point, facing the caller. */
    private static JsonObject snap(Pending raid) {
        JsonObject pos = new JsonObject();
        pos.addProperty("x", raid.spawn.x());
        pos.addProperty("y", raid.spawn.y());
        pos.addProperty("z", raid.spawn.z());
        JsonObject o = new JsonObject();
        o.add("position", pos);
        o.addProperty("yaw", raid.yaw);
        o.addProperty("pitch", 0);
        o.addProperty("dimension", raid.dimension);
        return o;
    }

    /**
     * The ground at (x, z): the chunk is loaded (generated if need be) first, then the heightmap gives the first free
     * block above the surface, leaves left out (a bot on a canopy cannot pathfind down, docs/29 §16).
     */
    private static XYZ surface(ServerWorld world, double x, double z) {
        int bx = (int) Math.floor(x);
        int bz = (int) Math.floor(z);
        world.getChunk(bx >> 4, bz >> 4);
        int y = world.getTopY(Heightmap.Type.MOTION_BLOCKING_NO_LEAVES, bx, bz);
        return new XYZ(bx + 0.5, y, bz + 0.5);
    }

    /** A formation offset (x across, z toward the front) turned to face `yaw`. */
    private static SquadRaidPlan.XZ rotate(SquadRaidPlan.XZ d, float yaw) {
        double r = Math.toRadians(yaw);
        // Facing direction f = (-sin, cos); its right-hand side s = (-cos, -sin).
        double fx = -Math.sin(r), fz = Math.cos(r);
        double sx = -Math.cos(r), sz = -Math.sin(r);
        return new SquadRaidPlan.XZ(d.x() * sx - d.z() * fx, d.x() * sz - d.z() * fz);
    }
}
