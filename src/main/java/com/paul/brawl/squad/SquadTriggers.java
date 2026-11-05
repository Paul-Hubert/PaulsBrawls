package com.paul.brawl.squad;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonObject;
import com.paul.brawl.compat.Compat;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * The clicks of bound items (docs/29 §5.4 items 3–5), on the server thread. Every hook only watches: it never
 * cancels vanilla, so the shield still blocks and the bow still draws.
 * <ul>
 *   <li><b>Use</b> (Fabric's {@code UseItemCallback} through {@link Compat#watchItemUse}, always {@code PASS}): the
 *       right-click of a bound item is a {@code use} trigger; sneaking, any bound item (a bow too) stops its order.
 *       A bow or crossbow's right-click is not a trigger: its arrow is.</li>
 *   <li><b>Arrow release</b> ({@link ServerEntityEvents#ENTITY_LOAD}): an arrow from a player's bound bow or crossbow,
 *       entering the world within 2 blocks of their eyes (an arrow loaded with its chunk is not a shot), not while
 *       sneaking. It is tracked until its first hit.</li>
 *   <li><b>Arrow hit</b> ({@code AbstractArrowMixin}, at the head of {@code onHitEntity} and
 *       {@code onHitBlock}): the first hit of a tracked arrow, with the point or the entity it hit.</li>
 * </ul>
 * Nobody triggers from a roster bot (bots use items too, e.g. {@code raiseShield}), a spectator, or while Squad is
 * off. Each trigger takes the snapshot at that moment, goes through the per-player limiter, and is sent
 * asynchronously to {@code /api/orders/trigger}; a non-blank answer is shown to the player (a delivered click answers
 * {@code ''}: no chat line per click).
 */
public final class SquadTriggers {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");
    /** A released arrow starts at the shooter's eyes − 0.1; 2 blocks (squared) leaves room for any client offset. */
    static final double RELEASE_RADIUS_SQ = 2 * 2;

    private static final SquadTriggerLimiter LIMITER = new SquadTriggerLimiter(System::nanoTime);
    private static final SquadArrows<Shot> ARROWS = new SquadArrows<>(System::nanoTime);

    /** A tracked arrow: whose, the binding of the bow it left, that bow's item id, and the squad selected at the shot. */
    private record Shot(UUID player, SquadBinding binding, String item, String squad) {}

    private SquadTriggers() {}

    public static void register() {
        Compat.watchItemUse((player, world, hand) -> {
            if (!world.isClientSide() && player instanceof ServerPlayer sp) {
                try {
                    onUse(sp, player.getItemInHand(hand));
                } catch (RuntimeException e) {
                    LOGGER.warn("Bound item use by {} failed: {}", sp.getName().getString(), e.toString());
                }
            }
        });
        ServerEntityEvents.ENTITY_LOAD.register((entity, world) -> {
            if (!Compat.isArrow(entity) || !(entity instanceof Projectile arrow)) return;
            try {
                onArrowLoad(arrow, world);
            } catch (RuntimeException e) {
                LOGGER.warn("Bound arrow release failed: {}", e.toString());
            }
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            LIMITER.forget(handler.getPlayer().getUUID());
            SquadSelection.clear(handler.getPlayer().getUUID());
        });
    }

    private static void onUse(ServerPlayer sp, ItemStack stack) {
        Optional<SquadBinding> b = SquadBinding.read(stack);
        if (b.isEmpty() || !mayTrigger(sp)) return;
        if (SquadSelection.isSelector(b.get().order())) {
            select(sp); // any item, a bow too, sneaking or not
            return;
        }
        if (sp.isShiftKeyDown()) fire(sp, b.get(), itemId(stack), SquadTriggerJson.Kind.USE, null, true, selection(sp));
        else if (!SquadBinding.isLauncher(stack)) fire(sp, b.get(), itemId(stack), SquadTriggerJson.Kind.USE, null, false, selection(sp));
    }

    private static void onArrowLoad(Projectile arrow, ServerLevel world) {
        if (!(arrow.getOwner() instanceof ServerPlayer sp)) return;
        // The bow or crossbow it was shot from, copied into the arrow at the shot (null for a dispenser's arrow).
        ItemStack weapon = arrow.getWeaponItem();
        if (!SquadBinding.isLauncher(weapon)) return;
        Optional<SquadBinding> b = SquadBinding.read(weapon);
        if (b.isEmpty() || SquadSelection.isSelector(b.get().order()) || !mayTrigger(sp) || sp.isShiftKeyDown()) return;
        if (arrow.position().distanceToSqr(sp.getEyePosition()) > RELEASE_RADIUS_SQ) return;
        if (!LIMITER.firstOfShot(sp.getUUID(), world.getGameTime())) return;
        String item = itemId(weapon);
        String squad = selection(sp);
        // A release the limiter dropped is not tracked either: the shot is one gesture, its hit goes with it.
        if (fire(sp, b.get(), item, SquadTriggerJson.Kind.ARROW_RELEASE, null, false, squad)) {
            ARROWS.track(arrow.getUUID(), new Shot(sp.getUUID(), b.get(), item, squad));
        }
    }

    /** The player's selected squad, or null (a bound item's click then says {@link SquadSelection#NONE}). */
    private static String selection(ServerPlayer sp) {
        return SquadSelection.selected(sp.getUUID()).orElse(null);
    }

    /**
     * The selector's click (docs/40): the bot under the crosshair, as far as the player sees ({@link SquadLook}),
     * selects its squad; no bot of theirs there deselects. The answer is one chat line.
     */
    private static void select(ServerPlayer sp) {
        UUID who = sp.getUUID();
        if (!LIMITER.tryAcquire(who)) return;
        MinecraftServer srv = sp.level().getServer();
        SquadLook.cast(sp).thenAccept(look -> srv.execute(() -> {
            ServerPlayer p = srv.getPlayerList().getPlayer(who);
            if (p == null) return;
            SquadTriggerJson.EntityRef e = look.entity();
            String bot = null;
            if (e != null && e.player() && e.username() != null) {
                for (String n : Squad.botNames()) if (n.equalsIgnoreCase(e.username())) bot = n;
            }
            String text;
            if (bot == null) {
                text = SquadSelection.deselectedText(SquadSelection.clear(who));
            } else if (Squad.botsOf(who).stream().noneMatch(bot::equalsIgnoreCase)) {
                text = "[Bots] " + bot + " n'est pas à toi.";
            } else {
                Optional<String> squad = SquadSelection.squadOf(Squad.tagsOf(bot));
                if (squad.isEmpty()) {
                    text = "[Bots] " + bot + " n'est dans aucune escouade (seuls les bots de /bots squad spawn en ont une).";
                } else {
                    SquadSelection.select(who, squad.get());
                    List<String> members = Squad.botsOf(who).stream().filter(n -> Squad.tagsOf(n).contains(squad.get())).toList();
                    text = SquadSelection.selectedText(squad.get(), members);
                }
            }
            for (Component t : Squad.render(SquadNotice.of(text))) p.sendSystemMessage(t);
        }));
    }

    /**
     * From the mixin, at the head of {@code onHitEntity} / {@code onHitBlock}, on both sides and for every arrow:
     * it returns at once unless this is a server arrow tracked at its release, and it never throws into vanilla.
     */
    public static void onArrowHit(Projectile arrow, HitResult hit) {
        if (arrow.level().isClientSide() || ARROWS.isEmpty()) return;
        try {
            Shot s = ARROWS.take(arrow.getUUID());
            if (s == null) return;
            MinecraftServer srv = arrow.level().getServer();
            ServerPlayer sp = srv == null ? null : srv.getPlayerList().getPlayer(s.player());
            if (sp == null || !mayTrigger(sp)) return;
            SquadTriggerJson.Hit where;
            if (hit instanceof EntityHitResult eh) {
                SquadTriggerJson.EntityRef e = CommanderSnap.entity(eh.getEntity());
                where = new SquadTriggerJson.Hit(e.x(), e.y(), e.z(), e);
            } else {
                Vec3 p = hit.getLocation();
                where = new SquadTriggerJson.Hit(p.x, p.y, p.z, null);
            }
            fire(sp, s.binding(), s.item(), SquadTriggerJson.Kind.ARROW_HIT, where, false, s.squad());
        } catch (RuntimeException e) {
            LOGGER.warn("Bound arrow hit failed: {}", e.toString());
        }
    }

    private static boolean mayTrigger(ServerPlayer sp) {
        if (!Squad.enabled() || sp.isSpectator()) return false;
        String name = Compat.name(sp.getGameProfile());
        for (String bot : Squad.botNames()) if (bot.equalsIgnoreCase(name)) return false;
        return true;
    }

    /**
     * Send one trigger for the selected {@code squad}, the snapshot taken now; false when the limiter dropped it, or
     * when no squad is selected (the player is told, docs/40).
     */
    private static boolean fire(ServerPlayer sp, SquadBinding binding, String item, SquadTriggerJson.Kind kind,
                                SquadTriggerJson.Hit hit, boolean stop, String squad) {
        UUID who = sp.getUUID();
        if (!LIMITER.tryAcquire(who)) return false;
        if (squad == null) {
            if (LIMITER.shouldShow(who, SquadSelection.NONE)) for (Component t : Squad.render(SquadNotice.of(SquadSelection.NONE))) sp.sendSystemMessage(t);
            return false;
        }
        String uuid = sp.getStringUUID();
        String name = sp.getName().getString();
        boolean admin = Compat.hasPermission(sp, 2);
        MinecraftServer srv = sp.level().getServer();
        // Sent once the look is found (SquadLook, a tick or more), after this player's earlier triggers.
        CommanderSnap.take(sp).thenCompose(snap -> {
            snap.add("trigger", SquadTriggerJson.trigger(kind, item, hit));
            return Squad.client().post("/api/orders/trigger", SquadTriggerJson.body(uuid, name, admin, binding, stop, squad, snap));
        }).thenAccept(r -> srv.execute(() -> answer(srv, who, r)));
        return true;
    }

    /** The runtime's line, on the server thread; nothing for a delivered click, once for a repeated line. */
    private static void answer(MinecraftServer srv, UUID who, JsonObject r) {
        SquadNotice n = SquadNotice.fromJson(r);
        if (n.text().isBlank() || !LIMITER.shouldShow(who, n.text())) return;
        ServerPlayer p = srv.getPlayerList().getPlayer(who);
        if (p != null) for (Component t : Squad.render(n)) p.sendSystemMessage(t);
    }

    static String itemId(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
    }
}
