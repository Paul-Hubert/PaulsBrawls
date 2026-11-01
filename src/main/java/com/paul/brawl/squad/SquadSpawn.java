package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.Command;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.math.BlockPos;

/**
 * {@code /bots squad spawn KIT [number] [owner] [other owners…]} and {@code /bots squad despawn [KIT] [owner]}
 * (admin): a ready squad in one call. Spawn makes {@code number} bots (default 5) named after the kit, owned by the
 * owner (default {@code @s}, whoever runs it, also from a datapack function) and the other owners, each set on a ring
 * around the owner at the owner's height and given its kit and tag as it arrives. Despawn removes the owner's bots of
 * that kit (or all of them). Everything here runs on the server thread; the HTTP answers hop back to it.
 */
final class SquadSpawn {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");

    private record Recruit(String name, double x, double y, double z) {}

    /** One spawn call: who asked, the kit, the owners, where they face, who came. */
    private static final class Muster {
        final ServerCommandSource src;
        final SquadKits.Kit kit;
        final JsonArray owners;
        final String ownerNames;
        final ServerWorld world;
        final float yaw;
        final List<String> spawned = new ArrayList<>();
        final AtomicInteger arrived = new AtomicInteger();
        boolean spawning = true;

        Muster(ServerCommandSource src, SquadKits.Kit kit, List<GameProfile> owners, ServerPlayerEntity center) {
            this.src = src;
            this.kit = kit;
            this.owners = new JsonArray();
            for (GameProfile p : owners) this.owners.add(Squad.player(p));
            this.ownerNames = String.join(" + ", owners.stream().map(GameProfile::getName).toList());
            this.world = center.getServerWorld();
            this.yaw = center.getYaw();
        }
    }

    private SquadSpawn() {}

    // -- /bots squad spawn --------------------------------------------------------------------------------------------

    static int spawn(ServerCommandSource src, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, "[Bots] Squad est désactivé (squad.properties : enabled=false).");
        SquadSpawnPlan.SpawnArgs a;
        try {
            a = SquadSpawnPlan.parseSpawn(text);
        } catch (IllegalArgumentException e) {
            return SquadCommand.reply(src, "[Bots] " + e.getMessage() + ".");
        }
        MinecraftServer srv = src.getServer();
        Optional<GameProfile> owner = SquadCommand.owner(src, a.owner());
        if (owner.isEmpty()) {
            return SquadCommand.reply(src, a.owner().equals("@s")
                ? "[Bots] Lance-la en jeu, ou nomme le propriétaire : " + SquadSpawnPlan.SPAWN_USAGE
                : "[Bots] Joueur inconnu : " + a.owner());
        }
        List<GameProfile> owners = new ArrayList<>(List.of(owner.get()));
        for (String o : a.others()) {
            Optional<GameProfile> p = SquadCommand.owner(src, o);
            if (p.isEmpty()) return SquadCommand.reply(src, "[Bots] Joueur inconnu : " + o);
            if (owners.stream().noneMatch(x -> x.getId().equals(p.get().getId()))) owners.add(p.get());
        }
        // The squad stands around its owner, who must be in game: that is where it appears.
        ServerPlayerEntity center = srv.getPlayerManager().getPlayer(owner.get().getId());
        if (center == null) return SquadCommand.reply(src, "[Bots] " + owner.get().getName() + " n'est pas en jeu : l'escouade apparaît autour de son propriétaire.");

        // Names nobody uses: not in the roster, not online, never played here (a bot would load that save).
        List<String> roster = Squad.botNames();
        java.util.function.Predicate<String> taken = n -> roster.stream().anyMatch(r -> r.equalsIgnoreCase(n))
            || srv.getPlayerManager().getPlayer(n) != null || Squad.hasPlayed(srv, n) || SquadCommand.reservedName(n);
        List<String> names = SquadRaidPlan.names(SquadSpawnPlan.prefix(a.kit()), a.count(), taken);

        Muster m = new Muster(src, a.kit(), owners, center);
        List<Recruit> recruits = new ArrayList<>();
        for (int i = 0; i < names.size(); i++) {
            SquadSpawnPlan.XZ d = SquadSpawnPlan.ring(i, names.size());
            double x = center.getX() + d.x(), z = center.getZ() + d.z();
            BlockPos feet = standNear(m.world, x, center.getY(), z);
            recruits.add(feet != null
                ? new Recruit(names.get(i), feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5)
                : new Recruit(names.get(i), center.getX(), center.getY(), center.getZ()));
        }
        SquadCommand.reply(src, String.format(Locale.ROOT, "[Bots] Escouade : %d %s(s) pour %s, autour de %s…",
            names.size(), a.kit().label(), m.ownerNames, center.getName().getString()));
        spawnNext(m, recruits, 0);
        return Command.SINGLE_SUCCESS;
    }

    /** Spawn the recruits one by one (the runtime answers in order; the first refusal, e.g. the bot limit, ends it). */
    private static void spawnNext(Muster m, List<Recruit> recruits, int i) {
        MinecraftServer srv = m.src.getServer();
        if (i >= recruits.size()) {
            spawnsDone(m);
            return;
        }
        Recruit r = recruits.get(i);
        JsonObject body = SquadCommand.base(m.src);
        body.addProperty("name", r.name());
        body.add("owners", m.owners.deepCopy());
        Squad.client().post("/api/bots/spawn", body).thenAccept(res -> srv.execute(() -> {
            if (!SquadAuthoring.ok(res)) {
                String why = SquadNotice.fromJson(res).text().replace("[Bots] ", "");
                SquadCommand.reply(m.src, "[Bots] Escouade : " + r.name() + " refusé (" + why + ") ; " + m.spawned.size()
                    + " bot(s) en route. Plus de bots : limits.maxBots dans squad/squad.json.");
                spawnsDone(m);
                return;
            }
            Squad.whitelist(srv, r.name(), true);
            m.spawned.add(r.name());
            Squad.expectArrival(r.name(), m.world, r.x(), r.y(), r.z(), m.yaw, bot -> arrived(m, bot));
            spawnNext(m, recruits, i + 1);
        }));
    }

    private static void spawnsDone(Muster m) {
        m.spawning = false;
        if (!m.spawned.isEmpty() && m.arrived.get() >= m.spawned.size()) ready(m);
    }

    /** A recruit joined and stands at its place: its kit (paced, kitStaggerMs) and its role tag; ready once all have theirs. */
    private static void arrived(Muster m, ServerPlayerEntity bot) {
        String name = bot.getName().getString();
        Squad.equipLater(m.src.getServer(), name, m.kit, answer -> {
            LOGGER.info("Squad bot {} arrived: {}", name, answer);
            JsonObject body = SquadCommand.base(m.src);
            body.addProperty("name", name);
            body.add("changes", SquadCommand.array(SquadKits.tagChanges(m.kit)));
            Squad.client().post("/api/bots/tag", body).thenAccept(res -> {
                if (!SquadAuthoring.ok(res)) LOGGER.warn("Squad bot {}: tag {} refused: {}", name, m.kit.name(), SquadNotice.fromJson(res).text());
            });
            if (m.arrived.incrementAndGet() >= m.spawned.size() && !m.spawning) ready(m);
        });
    }

    private static void ready(Muster m) {
        SquadCommand.reply(m.src, "[Bots] Escouade prête (" + m.kit.label() + ", à " + m.ownerNames + ") : " + String.join(", ", m.spawned) + ".");
    }

    /**
     * Feet at (x, z) near the owner's height: the nearest y within 6 blocks above or below with a solid block under
     * it and room for a body. The heightmap would put a bot on the roof when the owner is indoors or underground.
     * Null when there is none (the caller puts the bot at the owner's own spot).
     */
    static BlockPos standNear(ServerWorld world, double x, double y, double z) {
        int bx = (int) Math.floor(x), by = (int) Math.floor(y), bz = (int) Math.floor(z);
        world.getChunk(bx >> 4, bz >> 4);
        for (int k = 0; k <= 12; k++) {
            int dy = (k % 2 == 0) ? k / 2 : -(k + 1) / 2;
            BlockPos feet = new BlockPos(bx, by + dy, bz);
            BlockPos floor = feet.down();
            if (world.getBlockState(floor).isSolidBlock(world, floor)
                && world.getBlockState(feet).getCollisionShape(world, feet).isEmpty()
                && world.getBlockState(feet.up()).getCollisionShape(world, feet.up()).isEmpty()
                && world.getFluidState(feet).isEmpty()) {
                return feet;
            }
        }
        return null;
    }

    // -- /bots squad despawn ------------------------------------------------------------------------------------------

    static int despawn(ServerCommandSource src, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, "[Bots] Squad est désactivé (squad.properties : enabled=false).");
        SquadSpawnPlan.DespawnArgs a;
        try {
            a = SquadSpawnPlan.parseDespawn(text);
        } catch (IllegalArgumentException e) {
            return SquadCommand.reply(src, "[Bots] " + e.getMessage() + ".");
        }
        Optional<GameProfile> owner = SquadCommand.owner(src, a.owner());
        if (owner.isEmpty()) {
            return SquadCommand.reply(src, a.owner().equals("@s")
                ? "[Bots] Lance-la en jeu, ou nomme le propriétaire : " + SquadSpawnPlan.DESPAWN_USAGE
                : "[Bots] Joueur inconnu : " + a.owner());
        }
        String uuid = owner.get().getId().toString();
        List<String> bots = new ArrayList<>();
        for (JsonElement el : Squad.stateArray("bots")) {
            JsonObject b = el.getAsJsonObject();
            boolean owned = false;
            for (JsonElement o : b.getAsJsonArray("owners")) owned |= o.getAsJsonObject().get("uuid").getAsString().equals(uuid);
            boolean kitted = a.kit().isEmpty();
            if (!kitted && b.has("tags")) for (JsonElement t : b.getAsJsonArray("tags")) kitted |= t.getAsString().equalsIgnoreCase(a.kit().get().name());
            if (owned && kitted) bots.add(b.get("name").getAsString());
        }
        String what = a.kit().map(k -> k.label() + "s").orElse("bots");
        if (bots.isEmpty()) return SquadCommand.reply(src, "[Bots] " + owner.get().getName() + " n'a aucun bot à retirer (" + what + ").");
        AtomicInteger gone = new AtomicInteger();
        CompletableFuture<?>[] all = bots.stream()
            .map(n -> SquadCommand.despawnBot(src, n).thenAccept(r -> {
                if (SquadAuthoring.ok(r)) gone.incrementAndGet();
            }))
            .toArray(CompletableFuture[]::new);
        CompletableFuture.allOf(all).thenRun(() -> src.getServer().execute(() -> SquadCommand.reply(src,
            "[Bots] " + gone.get() + " " + what + " de " + owner.get().getName() + " retiré(s)" + (gone.get() < bots.size() ? " sur " + bots.size() : "") + ".")));
        return Command.SINGLE_SUCCESS;
    }
}
