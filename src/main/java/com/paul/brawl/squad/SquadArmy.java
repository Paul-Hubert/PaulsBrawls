package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.Command;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;

/**
 * {@code /bots armee [archers] [guards]} (admin, run by a player): an army for the caller, owned by the caller,
 * appears just ahead of them, equipped and tagged, and waits for their orders. The same spawning as {@code /bots raid}
 * (the runtime's spawn, the whitelist, the arrival teleport, the kit on arrival), but the caller is the owner and no
 * order starts. Everything here runs on the server thread; the HTTP answers hop back to it.
 */
final class SquadArmy {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");

    private record Soldier(String name, SquadKits.Kit kit, SquadRaid.XYZ at) {}

    /** One army call: who asked, where they face, who has come and who is still on the way. */
    private static final class Muster {
        final ServerCommandSource src;
        final JsonObject owner;
        final ServerWorld world;
        final float yaw;
        final List<String> spawned = new ArrayList<>();
        final AtomicInteger arrived = new AtomicInteger();
        boolean spawning = true;

        Muster(ServerCommandSource src, ServerPlayerEntity caller) {
            this.src = src;
            this.owner = Squad.player(caller.getGameProfile());
            this.world = caller.getServerWorld();
            this.yaw = caller.getYaw();
        }
    }

    private SquadArmy() {}

    static int call(ServerCommandSource src, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, "[Bots] Squad est désactivé (squad.properties : enabled=false).");
        ServerPlayerEntity p = src.getPlayer();
        if (p == null) return SquadCommand.reply(src, "[Bots] À lancer en jeu, par un joueur (l'armée apparaît devant toi et t'appartient).");
        SquadRaidPlan.ArmyArgs a;
        try {
            a = SquadRaidPlan.parseArmy(text);
        } catch (IllegalArgumentException e) {
            return SquadCommand.reply(src, "[Bots] " + e.getMessage() + ".");
        }
        MinecraftServer srv = src.getServer();
        // Names nobody uses: not in the roster, not online, never played here (a bot would load that save).
        List<String> roster = Squad.botNames();
        java.util.function.Predicate<String> taken = n -> roster.stream().anyMatch(r -> r.equalsIgnoreCase(n))
            || srv.getPlayerManager().getPlayer(n) != null || Squad.hasPlayed(srv, n) || SquadCommand.reservedName(n);
        List<String> guards = SquadRaidPlan.names(SquadRaidPlan.ARMY_GUARD_PREFIX, a.guards(), taken);
        List<String> archers = SquadRaidPlan.names(SquadRaidPlan.ARMY_ARCHER_PREFIX, a.archers(), taken);

        // In rows a few blocks ahead, facing where the caller looks: guards in front, archers behind them.
        Muster m = new Muster(src, p);
        SquadRaidPlan.XZ point = SquadRaidPlan.point(p.getX(), p.getZ(), p.getYaw(), SquadRaidPlan.ARMY_AHEAD);
        SquadKits.Kit archerKit = SquadKits.find("archer").orElseThrow();
        SquadKits.Kit guardKit = SquadKits.find("guard").orElseThrow();
        List<Soldier> soldiers = new ArrayList<>();
        int n = a.total();
        for (int i = 0; i < n; i++) {
            boolean guard = i < guards.size();
            String name = guard ? guards.get(i) : archers.get(i - guards.size());
            SquadRaidPlan.XZ d = SquadRaid.rotate(SquadRaidPlan.spread(i, n), m.yaw);
            soldiers.add(new Soldier(name, guard ? guardKit : archerKit, SquadRaid.surface(m.world, point.x() + d.x(), point.z() + d.z())));
        }
        SquadCommand.reply(src, String.format(Locale.ROOT, "[Bots] Armée : %d bots (%d archers, %d gardes) arrivent devant toi, à toi…",
            n, a.archers(), a.guards()));
        spawnNext(m, soldiers, 0);
        return Command.SINGLE_SUCCESS;
    }

    /** Spawn the soldiers one by one (the runtime answers in order; the first refusal, e.g. the bot limit, ends it). */
    private static void spawnNext(Muster m, List<Soldier> soldiers, int i) {
        MinecraftServer srv = m.src.getServer();
        if (i >= soldiers.size()) {
            m.spawning = false;
            if (m.spawned.isEmpty()) return;
            if (m.arrived.get() >= m.spawned.size()) ready(m);
            return;
        }
        Soldier s = soldiers.get(i);
        JsonObject body = SquadCommand.base(m.src);
        body.addProperty("name", s.name());
        JsonArray owners = new JsonArray();
        owners.add(m.owner);
        body.add("owners", owners);
        Squad.client().post("/api/bots/spawn", body).thenAccept(res -> srv.execute(() -> {
            if (!SquadAuthoring.ok(res)) {
                String why = SquadNotice.fromJson(res).text().replace("[Bots] ", "");
                SquadCommand.reply(m.src, "[Bots] Armée : " + s.name() + " refusé (" + why + ") ; " + m.spawned.size()
                    + " bot(s) en route. Plus de bots : limits.maxBots dans squad/squad.json.");
                m.spawning = false;
                if (!m.spawned.isEmpty() && m.arrived.get() >= m.spawned.size()) ready(m);
                return;
            }
            Squad.whitelist(srv, s.name(), true);
            m.spawned.add(s.name());
            Squad.expectArrival(s.name(), m.world, s.at().x(), s.at().y(), s.at().z(), m.yaw, bot -> arrived(m, bot, s));
            spawnNext(m, soldiers, i + 1);
        }));
    }

    /** A soldier joined and stands at its place: its kit and its role tag. */
    private static void arrived(Muster m, ServerPlayerEntity bot, Soldier s) {
        String name = bot.getName().getString();
        LOGGER.info("Army bot {} arrived: {}", name, Squad.equip(m.src.getServer(), name, s.kit()));
        JsonObject body = SquadCommand.base(m.src);
        body.addProperty("name", name);
        body.add("changes", SquadCommand.array(SquadKits.tagChanges(s.kit())));
        Squad.client().post("/api/bots/tag", body).thenAccept(res -> {
            if (!SquadAuthoring.ok(res)) LOGGER.warn("Army bot {}: tag {} refused: {}", name, s.kit().name(), SquadNotice.fromJson(res).text());
        });
        if (m.arrived.incrementAndGet() >= m.spawned.size() && !m.spawning) ready(m);
    }

    private static void ready(Muster m) {
        Optional<String> who = Optional.ofNullable(m.owner.get("name")).map(e -> e.getAsString());
        SquadCommand.reply(m.src, "[Bots] Armée prête : " + String.join(", ", m.spawned) + " (à " + who.orElse("toi")
            + "). /bots order defend, ou un objet lié (/bots orders bind).");
    }
}
