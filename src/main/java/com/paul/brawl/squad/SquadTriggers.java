package com.paul.brawl.squad;

import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonObject;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.entity.projectile.PersistentProjectileEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.Text;
import net.minecraft.util.TypedActionResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.Vec3d;

/**
 * The clicks of bound items (docs/29 §5.4 items 3–5), on the server thread. Every hook only watches: it never
 * cancels vanilla, so the shield still blocks and the bow still draws.
 * <ul>
 *   <li><b>Use</b> ({@link UseItemCallback}, always {@code PASS}): the right-click of a bound item is a {@code use}
 *       trigger; sneaking, any bound item (a bow too) stops its order. A bow or crossbow's right-click is not a
 *       trigger: its arrow is.</li>
 *   <li><b>Arrow release</b> ({@link ServerEntityEvents#ENTITY_LOAD}): an arrow from a player's bound bow or crossbow,
 *       entering the world within 2 blocks of their eyes (an arrow loaded with its chunk is not a shot), not while
 *       sneaking. It is tracked until its first hit.</li>
 *   <li><b>Arrow hit</b> ({@code PersistentProjectileEntityMixin}, at the head of {@code onEntityHit} and
 *       {@code onBlockHit}): the first hit of a tracked arrow, with the point or the entity it hit.</li>
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

    /** A tracked arrow: whose, the binding of the bow it left, and that bow's item id. */
    private record Shot(UUID player, SquadBinding binding, String item) {}

    private SquadTriggers() {}

    public static void register() {
        UseItemCallback.EVENT.register((player, world, hand) -> {
            ItemStack stack = player.getStackInHand(hand);
            if (!world.isClient() && player instanceof ServerPlayerEntity sp) {
                try {
                    onUse(sp, stack);
                } catch (RuntimeException e) {
                    LOGGER.warn("Bound item use by {} failed: {}", sp.getName().getString(), e.toString());
                }
            }
            return TypedActionResult.pass(stack);
        });
        ServerEntityEvents.ENTITY_LOAD.register((entity, world) -> {
            if (!(entity instanceof PersistentProjectileEntity arrow)) return;
            try {
                onArrowLoad(arrow, world);
            } catch (RuntimeException e) {
                LOGGER.warn("Bound arrow release failed: {}", e.toString());
            }
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> LIMITER.forget(handler.getPlayer().getUuid()));
    }

    private static void onUse(ServerPlayerEntity sp, ItemStack stack) {
        Optional<SquadBinding> b = SquadBinding.read(stack);
        if (b.isEmpty() || !mayTrigger(sp)) return;
        if (sp.isSneaking()) fire(sp, b.get(), itemId(stack), SquadTriggerJson.Kind.USE, null, true);
        else if (!SquadBinding.isLauncher(stack)) fire(sp, b.get(), itemId(stack), SquadTriggerJson.Kind.USE, null, false);
    }

    private static void onArrowLoad(PersistentProjectileEntity arrow, ServerWorld world) {
        if (!(arrow.getOwner() instanceof ServerPlayerEntity sp)) return;
        // The bow or crossbow it was shot from, copied into the arrow at the shot (null for a dispenser's arrow).
        ItemStack weapon = arrow.getWeaponStack();
        if (!SquadBinding.isLauncher(weapon)) return;
        Optional<SquadBinding> b = SquadBinding.read(weapon);
        if (b.isEmpty() || !mayTrigger(sp) || sp.isSneaking()) return;
        if (arrow.getPos().squaredDistanceTo(sp.getEyePos()) > RELEASE_RADIUS_SQ) return;
        if (!LIMITER.firstOfShot(sp.getUuid(), world.getTime())) return;
        String item = itemId(weapon);
        // A release the limiter dropped is not tracked either: the shot is one gesture, its hit goes with it.
        if (fire(sp, b.get(), item, SquadTriggerJson.Kind.ARROW_RELEASE, null, false)) {
            ARROWS.track(arrow.getUuid(), new Shot(sp.getUuid(), b.get(), item));
        }
    }

    /**
     * From the mixin, at the head of {@code onEntityHit} / {@code onBlockHit}, on both sides and for every arrow:
     * it returns at once unless this is a server arrow tracked at its release, and it never throws into vanilla.
     */
    public static void onArrowHit(PersistentProjectileEntity arrow, HitResult hit) {
        if (arrow.getWorld().isClient() || ARROWS.isEmpty()) return;
        try {
            Shot s = ARROWS.take(arrow.getUuid());
            if (s == null) return;
            MinecraftServer srv = arrow.getServer();
            ServerPlayerEntity sp = srv == null ? null : srv.getPlayerManager().getPlayer(s.player());
            if (sp == null || !mayTrigger(sp)) return;
            SquadTriggerJson.Hit where;
            if (hit instanceof EntityHitResult eh) {
                SquadTriggerJson.EntityRef e = CommanderSnap.entity(eh.getEntity());
                where = new SquadTriggerJson.Hit(e.x(), e.y(), e.z(), e);
            } else {
                Vec3d p = hit.getPos();
                where = new SquadTriggerJson.Hit(p.x, p.y, p.z, null);
            }
            fire(sp, s.binding(), s.item(), SquadTriggerJson.Kind.ARROW_HIT, where, false);
        } catch (RuntimeException e) {
            LOGGER.warn("Bound arrow hit failed: {}", e.toString());
        }
    }

    private static boolean mayTrigger(ServerPlayerEntity sp) {
        if (!Squad.enabled() || sp.isSpectator()) return false;
        String name = sp.getGameProfile().getName();
        for (String bot : Squad.botNames()) if (bot.equalsIgnoreCase(name)) return false;
        return true;
    }

    /** Send one trigger, the snapshot taken now; false when the limiter dropped it. */
    private static boolean fire(ServerPlayerEntity sp, SquadBinding binding, String item, SquadTriggerJson.Kind kind,
                                SquadTriggerJson.Hit hit, boolean stop) {
        UUID who = sp.getUuid();
        if (!LIMITER.tryAcquire(who)) return false;
        JsonObject snap = CommanderSnap.of(sp);
        snap.add("trigger", SquadTriggerJson.trigger(kind, item, hit));
        JsonObject body = SquadTriggerJson.body(sp.getUuidAsString(), sp.getName().getString(), sp.hasPermissionLevel(2), binding, stop, snap);
        MinecraftServer srv = sp.getServer();
        Squad.client().post("/api/orders/trigger", body).thenAccept(r -> srv.execute(() -> answer(srv, who, r)));
        return true;
    }

    /** The runtime's line, on the server thread; nothing for a delivered click, once for a repeated line. */
    private static void answer(MinecraftServer srv, UUID who, JsonObject r) {
        SquadNotice n = SquadNotice.fromJson(r);
        if (n.text().isBlank() || !LIMITER.shouldShow(who, n.text())) return;
        ServerPlayerEntity p = srv.getPlayerManager().getPlayer(who);
        if (p != null) for (Text t : Squad.render(n)) p.sendMessage(t, false);
    }

    static String itemId(ItemStack stack) {
        return Registries.ITEM.getId(stack.getItem()).getPath();
    }
}
