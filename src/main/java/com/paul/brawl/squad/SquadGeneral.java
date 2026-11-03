package com.paul.brawl.squad;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Predicate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.Command;
import com.paul.brawl.compat.Compat;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.levelgen.Heightmap;

/**
 * {@code /bots general …} (admin, docs/38): a Claude Code instance commanding an army of squads, with no body. The
 * runtime keeps the General (ticket, allowance, squads, orders, events); the mod gives it a virtual owner and a spawn
 * point (the caller's position, their facing the axis of attack), and spawns its bots when the runtime asks
 * ({@code general-spawn} over SSE): names, whitelist, the arrival teleport around the spawn point, the kit and its tag,
 * each step reported back ({@code /api/general/spawned|arrived|failed}). {@code general-despawn} removes a disbanded
 * squad like {@code /bots despawn}.
 */
final class SquadGeneral {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");
    private static final String DISABLED = "[Bots] Squad est désactivé (squad.properties : enabled=false).";

    private SquadGeneral() {}

    // -- /bots general create|allow|tell|stop|list --------------------------------------------------------------------

    static int create(CommandSourceStack src, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, DISABLED);
        ServerPlayer p = src.getPlayer();
        if (p == null) return SquadCommand.reply(src, "[Bots] À lancer en jeu, par un joueur : ta position est le point d'apparition, ton regard l'axe d'attaque.");
        List<String> parts = SquadArgs.tokenize(text == null ? "" : text.trim());
        if (parts.isEmpty()) return SquadCommand.reply(src, "[Bots] Usage : " + SquadGeneralPlan.CREATE_USAGE);
        String name = parts.get(0);
        if (!SquadGeneralPlan.NAME.matcher(name).matches()) return SquadCommand.reply(src, "[Bots] Nom de général invalide « " + name + " » (3 à 11 caractères : lettres, chiffres, _).");
        SquadGeneralPlan.Terms terms;
        try {
            terms = SquadGeneralPlan.parseTerms(String.join(" ", parts.subList(1, parts.size())), true);
        } catch (IllegalArgumentException e) {
            return SquadCommand.reply(src, "[Bots] " + e.getMessage() + ". Usage : " + SquadGeneralPlan.CREATE_USAGE);
        }
        MinecraftServer srv = src.getServer();
        if (srv.getPlayerList().getPlayerByName(name) != null) return SquadCommand.reply(src, "[Bots] " + name + " est un joueur en ligne : choisis un autre nom.");
        Optional<GameProfile> owner = Squad.profile(srv, name);
        if (owner.isEmpty()) return SquadCommand.reply(src, "[Bots] Le propriétaire virtuel " + name + " est introuvable (le serveur doit être en mode hors ligne).");

        JsonObject body = SquadCommand.base(src);
        body.addProperty("name", name);
        body.add("owner", Squad.player(owner.get()));
        JsonObject spawn = new JsonObject();
        spawn.addProperty("x", p.getX());
        spawn.addProperty("y", p.getY());
        spawn.addProperty("z", p.getZ());
        spawn.addProperty("yaw", p.getYRot());
        spawn.addProperty("dimension", Compat.path(p.level().dimension()));
        body.add("spawn", spawn);
        body.add("allowance", allowance(terms));
        if (terms.reinforce() != null) body.addProperty("reinforce", terms.reinforce());
        if (terms.range() != null) body.addProperty("range", terms.range());
        Squad.client().post("/api/general/create", body).thenAccept(r -> srv.execute(() -> {
            SquadCommand.show(src, r);
            if (!SquadAuthoring.ok(r) || !r.has("ticket")) return;
            String ticket = r.get("ticket").getAsString();
            src.sendSuccess(() -> Component.literal("[Bots] Ticket : ").append(copyable(ticket, ticket)), false);
            String ps = SquadGeneralPlan.launchLine(ticket);
            src.sendSuccess(() -> Component.literal("Lance l'instance depuis le dépôt (PowerShell) : ").append(copyable(ps, ps)), false);
            String sh = SquadGeneralPlan.launchLinePosix(ticket);
            src.sendSuccess(() -> Component.literal("ou (bash) : ").append(copyable("[copier]", sh)), false);
            src.sendSuccess(() -> Component.literal("Dis-lui sa mission (objectif et/ou stratégie) ; sans objectif, il attaque le long de l'axe. "
                + "/bots general tell " + name + " … lui parle d'ici ; /bots general stop " + name + " [despawn] l'arrête."), false);
        }));
        return Command.SINGLE_SUCCESS;
    }

    static int allow(CommandSourceStack src, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, DISABLED);
        List<String> parts = SquadArgs.tokenize(text == null ? "" : text.trim());
        if (parts.size() < 2) return SquadCommand.reply(src, "[Bots] Usage : " + SquadGeneralPlan.ALLOW_USAGE);
        SquadGeneralPlan.Terms terms;
        try {
            terms = SquadGeneralPlan.parseTerms(String.join(" ", parts.subList(1, parts.size())), false);
        } catch (IllegalArgumentException e) {
            return SquadCommand.reply(src, "[Bots] " + e.getMessage() + ". Usage : " + SquadGeneralPlan.ALLOW_USAGE);
        }
        JsonObject body = SquadCommand.base(src);
        body.addProperty("name", parts.get(0));
        body.add("allowance", allowance(terms));
        if (terms.reinforce() != null) body.addProperty("reinforce", terms.reinforce());
        if (terms.range() != null) body.addProperty("range", terms.range());
        post(src, "/api/general/allow", body);
        return Command.SINGLE_SUCCESS;
    }

    static int tell(CommandSourceStack src, String name, String text) {
        if (!Squad.enabled()) return SquadCommand.reply(src, DISABLED);
        JsonObject body = SquadCommand.base(src);
        body.addProperty("name", name);
        body.addProperty("text", text);
        post(src, "/api/general/tell", body);
        return Command.SINGLE_SUCCESS;
    }

    /** Revoke the ticket and stop the orders; with {@code despawn}, every bot of the General leaves too. */
    static int stop(CommandSourceStack src, String name, boolean despawn) {
        if (!Squad.enabled()) return SquadCommand.reply(src, DISABLED);
        JsonObject body = SquadCommand.base(src);
        body.addProperty("name", name);
        MinecraftServer srv = src.getServer();
        Squad.client().post("/api/general/stop", body).thenAccept(r -> srv.execute(() -> {
            SquadCommand.show(src, r);
            if (!despawn || !SquadAuthoring.ok(r) || !r.has("bots")) return;
            List<String> bots = strings(r.get("bots"));
            for (String b : bots) SquadCommand.despawnBot(src, b);
            if (!bots.isEmpty()) SquadCommand.reply(src, "[Bots] " + bots.size() + " bot(s) du général " + name + " retiré(s).");
        }));
        return Command.SINGLE_SUCCESS;
    }

    static int list(CommandSourceStack src) {
        if (!Squad.enabled()) return SquadCommand.reply(src, DISABLED);
        post(src, "/api/general/list", SquadCommand.base(src));
        return Command.SINGLE_SUCCESS;
    }

    // -- the runtime's requests (SSE, any thread) -----------------------------------------------------------------------

    /**
     * {@code general-spawn}: {@code n} new bots of {@code kit} named {@code prefix01…}, or the dead bots of {@code revive}
     * brought back (the runtime already revived them; their kits in {@code kits}), placed around the spawn point.
     */
    static void onSpawn(MinecraftServer srv, JsonObject data) {
        srv.execute(() -> {
            try {
                spawn(srv, data);
            } catch (RuntimeException e) {
                LOGGER.warn("General spawn request failed: {}", e.toString());
                if (data.has("request")) failed(data.get("request").getAsString(), "erreur du mod : " + e.getMessage(), null);
            }
        });
    }

    /** {@code general-despawn}: a disbanded squad's bots leave, like {@code /bots despawn}. */
    static void onDespawn(MinecraftServer srv, JsonObject data) {
        srv.execute(() -> {
            CommandSourceStack console = srv.createCommandSourceStack();
            for (String b : strings(data.get("bots"))) SquadCommand.despawnBot(console, b);
        });
    }

    private static void spawn(MinecraftServer srv, JsonObject d) {
        String request = d.get("request").getAsString();
        JsonObject s = d.getAsJsonObject("spawn");
        ServerLevel world = world(srv, s.has("dimension") ? s.get("dimension").getAsString() : "overworld");
        double x = s.get("x").getAsDouble(), z = s.get("z").getAsDouble();
        float yaw = s.get("yaw").getAsFloat();
        JsonObject ownerJson = d.getAsJsonObject("owner");

        List<String> revive = strings(d.get("revive"));
        if (!revive.isEmpty()) {
            JsonObject kits = d.has("kits") && d.get("kits").isJsonObject() ? d.getAsJsonObject("kits") : new JsonObject();
            for (int i = 0; i < revive.size(); i++) {
                String name = revive.get(i);
                SquadRaidPlan.XZ at = SquadGeneralPlan.place(x, z, yaw, i, revive.size());
                double y = surface(world, at.x(), at.z());
                Optional<SquadKits.Kit> kit = kits.has(name) ? SquadKits.find(kits.get(name).getAsString()) : Optional.empty();
                Squad.expectArrival(name, world, at.x(), y, at.z(), yaw, bot -> {
                    if (kit.isPresent()) Squad.resetToKitLater(srv, name, kit.get(), answer -> arrived(request, name));
                    else arrived(request, name);
                });
            }
            return;
        }

        String kitName = d.get("kit").getAsString();
        Optional<SquadKits.Kit> kit = SquadKits.find(kitName);
        int n = d.get("n").getAsInt();
        if (kit.isEmpty() || !SquadGeneralPlan.knownKit(kitName)) {
            for (int i = 0; i < n; i++) failed(request, "kit inconnu « " + kitName + " »", null);
            return;
        }
        List<String> roster = Squad.botNames();
        Predicate<String> taken = name -> roster.stream().anyMatch(r -> r.equalsIgnoreCase(name))
            || srv.getPlayerList().getPlayerByName(name) != null || Squad.hasPlayed(srv, name) || SquadCommand.reservedName(name);
        List<String> names;
        try {
            names = SquadRaidPlan.names(d.get("prefix").getAsString(), n, taken);
        } catch (IllegalStateException e) {
            for (int i = 0; i < n; i++) failed(request, "plus de nom libre", null);
            return;
        }
        List<Bot> bots = new ArrayList<>();
        for (int i = 0; i < names.size(); i++) {
            SquadRaidPlan.XZ at = SquadGeneralPlan.place(x, z, yaw, i, names.size());
            bots.add(new Bot(names.get(i), at.x(), surface(world, at.x(), at.z()), at.z()));
        }
        spawnNext(srv, request, ownerJson, world, yaw, kit.get(), bots, 0);
    }

    private record Bot(String name, double x, double y, double z) {}

    /** One after the other, as the runtime answers; the first refusal (the bot limit) fails the rest. */
    private static void spawnNext(MinecraftServer srv, String request, JsonObject owner, ServerLevel world, float yaw, SquadKits.Kit kit, List<Bot> bots, int i) {
        if (i >= bots.size()) return;
        Bot b = bots.get(i);
        JsonObject body = new JsonObject();
        body.add("by", owner);
        body.addProperty("admin", true);
        body.addProperty("name", b.name());
        JsonArray owners = new JsonArray();
        owners.add(owner);
        body.add("owners", owners);
        Squad.client().post("/api/bots/spawn", body).thenAccept(res -> srv.execute(() -> {
            if (!SquadAuthoring.ok(res)) {
                String why = SquadNotice.fromJson(res).text();
                for (int k = i; k < bots.size(); k++) failed(request, why, bots.get(k).name());
                return;
            }
            Squad.whitelist(srv, b.name(), true);
            report("/api/general/spawned", request, b.name());
            Squad.expectArrival(b.name(), world, b.x(), b.y(), b.z(), yaw, bot -> Squad.equipLater(srv, b.name(), kit, answer -> {
                LOGGER.info("General bot {} arrived: {}", b.name(), answer);
                JsonObject tag = new JsonObject();
                tag.add("by", owner);
                tag.addProperty("admin", true);
                tag.addProperty("name", b.name());
                tag.add("changes", SquadCommand.array(SquadKits.tagChanges(kit)));
                Squad.client().post("/api/bots/tag", tag).thenAccept(t -> arrived(request, b.name()));
            }));
            spawnNext(srv, request, owner, world, yaw, kit, bots, i + 1);
        }));
    }

    private static void arrived(String request, String name) {
        report("/api/general/arrived", request, name);
    }

    private static void failed(String request, String text, String name) {
        JsonObject body = new JsonObject();
        body.addProperty("request", request);
        body.addProperty("text", text);
        if (name != null) body.addProperty("name", name);
        Squad.client().post("/api/general/failed", body);
    }

    private static void report(String path, String request, String name) {
        JsonObject body = new JsonObject();
        body.addProperty("request", request);
        body.addProperty("name", name);
        Squad.client().post(path, body).thenAccept(r -> {
            if (!SquadAuthoring.ok(r)) LOGGER.warn("General {} {}: {}", path, name, SquadNotice.fromJson(r).text());
        });
    }

    // -- plumbing -------------------------------------------------------------------------------------------------------

    private static void post(CommandSourceStack src, String path, JsonObject body) {
        Squad.client().post(path, body).thenAccept(r -> src.getServer().execute(() -> SquadCommand.show(src, r)));
    }

    private static JsonObject allowance(SquadGeneralPlan.Terms t) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, Integer> e : t.allowance().entrySet()) o.addProperty(e.getKey(), e.getValue());
        return o;
    }

    private static List<String> strings(JsonElement e) {
        List<String> out = new ArrayList<>();
        if (e != null && e.isJsonArray()) for (JsonElement x : e.getAsJsonArray()) out.add(x.getAsString());
        return out;
    }

    private static Component copyable(String shown, String copied) {
        return Component.literal(shown).withStyle(s -> s.withColor(ChatFormatting.GOLD).withUnderlined(true)
            .withClickEvent(Compat.copyToClipboard(copied))
            .withHoverEvent(Compat.showText(Component.literal("Clique pour copier"))));
    }

    /** The world of a dimension name ("overworld", "the_nether"…), the overworld when unknown. */
    private static ServerLevel world(MinecraftServer srv, String dimension) {
        for (ServerLevel w : srv.getAllLevels()) {
            if (Compat.path(w.dimension()).equals(dimension.toLowerCase(Locale.ROOT))) return w;
        }
        return srv.overworld();
    }

    /** The first free block above the ground at (x, z), leaves left out (the chunk is loaded first), as SquadRaid. */
    private static double surface(ServerLevel world, double x, double z) {
        int bx = (int) Math.floor(x);
        int bz = (int) Math.floor(z);
        world.getChunk(bx >> 4, bz >> 4);
        return world.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, bx, bz);
    }
}
