package com.paul.brawl;

import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * God's world layer (docs/27 §5): every clamp and refusal in front of a {@link GodWorld}, with no LLM types and no
 * Minecraft types. The builtin {@code ChatBot} tools and the {@code god} MCP server both call it, so a rule exists
 * once. Results are the strings the model reads. A method never throws: a {@link WorldRefusal} becomes its message.
 *
 * <p>What is NOT here: who may call. The builtin path serves bodiless prayers (anyone may be rewarded), while the
 * MCP server only accepts the session owner's ticket (docs/27 §5). Only {@link #appear} and
 * {@link #vanish} gate on the session owner, because they move the one shared body.
 */
public final class GodService {

    /** The weather types {@code /weather} accepts. Anything else used to be reported as a success. */
    public static final Set<String> WEATHER_TYPES = Set.of("clear", "rain", "thunder");

    /** {@code /weather} accepts 0..1 000 000 seconds. */
    public static final int MAX_WEATHER_SECONDS = 1_000_000;

    /** Longest line {@link #say} relays (a chat line is 256 characters; the avatar splits nothing). */
    public static final int MAX_SAY_CHARS = 1000;

    private final GodWorld world;
    private final BridgeConfig cfg;

    public GodService(GodWorld world, BridgeConfig cfg) {
        this.world = world;
        this.cfg = cfg;
    }

    private static volatile GodService live;

    /** The service bound to the real world (created on first use, so tests never load Minecraft through it). */
    public static GodService live() {
        GodService s = live;
        if (s == null) {
            synchronized (GodService.class) {
                if (live == null) live = new GodService(new MinecraftGodWorld(), BridgeConfig.INSTANCE);
                s = live;
            }
        }
        return s;
    }

    public GodWorld world() {
        return world;
    }

    // -- effects -------------------------------------------------------------------------------------------------

    /** Bug #6: amount at least 1, clamped to {@code rewardMax}; the item string is parsed like {@code /give}. */
    public String reward(UUID player, String item, int amount) {
        if (amount < 1) {
            return "Reward cancelled, amount must be at least 1 (got " + amount + ").";
        }
        if (item == null || item.isBlank()) {
            return "Reward cancelled, item " + item + " does not exist or is malformed, please try again.";
        }
        int clamped = GodClamps.rewardAmount(amount, cfg.rewardMax);
        try {
            world.giveItem(player, item, clamped);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        gesture(player, "nod");
        String note = clamped < amount ? " (limité à " + clamped + " sur " + amount + " demandés)" : "";
        return "You gave the player a reward: " + clamped + " " + item + note;
    }

    /** Both amounts in 1..{@link TradeOffers#MAX_TRADE_AMOUNT}; both items must exist; {@code /accept} re-checks. */
    public String offerTrade(UUID player, String giveItem, int giveAmount, String takeItem, int takeAmount) {
        String bad = TradeMath.amountError(giveAmount, takeAmount, TradeOffers.MAX_TRADE_AMOUNT);
        if (bad != null) return bad;
        if (giveItem == null || giveItem.isBlank()) {
            return "Trade cancelled. " + giveItem + " was not a correct item. Please try again.";
        }
        if (takeItem == null || takeItem.isBlank()) {
            return "Trade cancelled. " + takeItem + " was not a correct item. Please try again.";
        }
        try {
            world.offerTrade(player, giveItem, giveAmount, takeItem, takeAmount);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        gesture(player, "nod");
        return "God offered a trade to the player: God gives "
             + giveAmount + " " + giveItem + " for " + takeAmount + " " + takeItem
             + "\nThe player may accept or decline this trade.";
    }

    /** Bug #6: strikes clamped to {@code punishmentMax} (any number used to land in one tick). */
    public String punish(UUID player, int strikes) {
        int n = GodClamps.punishments(strikes, cfg.punishmentMax);
        try {
            world.strike(player, n);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        gesture(player, "look");
        gesture(player, "swing");
        String note = n < strikes ? " (limité à " + n + " sur " + strikes + " demandés)" : "";
        return "God punished the player " + n + " times." + note;
    }

    /** Only clear, rain or thunder; duration clamped to 0..{@link #MAX_WEATHER_SECONDS} (0 = vanilla default). */
    public String changeWeather(UUID player, String type, int seconds) {
        String t = type == null ? "" : type.trim().toLowerCase(Locale.ROOT);
        if (!WEATHER_TYPES.contains(t)) {
            return "Météo refusée : type inconnu '" + type + "' (clear, rain ou thunder).";
        }
        int s = GodClamps.clamp(seconds, 0, MAX_WEATHER_SECONDS);
        try {
            world.setWeather(player, t, s);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        gesture(player, "look");
        gesture(player, "summon");
        return "La météo a été changée en " + t + " pour " + (s > 0 ? s + " secondes." : "une durée indéterminée.");
    }

    /** Count clamped to 1..{@code spawnCountMax}; each offset to ±{@code spawnOffsetMax}; griefing per config. */
    public String spawnCreature(UUID player, String entity, int count, int dx, int dy, int dz) {
        if (entity == null || entity.isBlank()) {
            return "Spawn annulé : entityType vide.";
        }
        int n = GodClamps.clamp(count, 1, Math.max(1, cfg.spawnCountMax));
        int max = cfg.spawnOffsetMax;
        boolean grief = cfg.creatureGriefingAllowed;
        int spawned;
        try {
            spawned = world.spawn(player, entity.trim(), n,
                GodClamps.spawnOffset(dx, max), GodClamps.spawnOffset(dy, max), GodClamps.spawnOffset(dz, max), grief);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        gesture(player, "summon");
        return "God a fait apparaître " + spawned + " " + entity + (spawned > 1 ? "s" : "")
            + " près du joueur" + (grief ? "" : " (griefing désactivé)") + ".";
    }

    /**
     * Manifest the shared body in front of the player. Only the session owner may: a bodiless prayer must not
     * teleport the shared body, flip its invulnerability, or touch the owner's watchdog.
     */
    public String appear(UUID player, Double distance, Double height, Boolean lookAtPlayer) {
        if (!GodSessionManager.isOwner(player)) {
            return "Le corps de Dieu est occupé avec un autre fidèle — cette rencontre reste sans forme.";
        }
        double d = clamp(distance == null ? 3.0 : distance, cfg.appearMinDistance, cfg.appearMaxDistance);
        double h = clamp(height == null ? 0.0 : height, cfg.appearMinHeight, cfg.appearMaxHeight);
        boolean face = lookAtPlayer == null || lookAtPlayer;
        try {
            world.appear(player, d, h, face);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        GodSessionManager.markManifested();
        GodSessionManager.resetIdleTimer(player);
        return "God a pris forme physique devant le joueur.";
    }

    /** Send the body away; the session continues (a later {@link #appear} brings it back). Owner only. */
    public String vanish(UUID player) {
        if (!GodSessionManager.isOwner(player)) {
            return "Tu ne tiens pas le corps de Dieu — rien à faire disparaître.";
        }
        try {
            world.vanish(player);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        // The body is gone but the session continues — stop routing speech
        // and gestures through the parked bot until the next Appear.
        GodSessionManager.clearManifested();
        return "God a disparu.";
    }

    /**
     * End the player's encounter (the external agent's {@code end_session}, or its turn ending): send the body
     * home if it is out, clear its invulnerability, release the lock. The same exit as
     * {@code ChatBot.endPrayerSession}; idempotent, and a no-op for a player who does not own the session.
     */
    public String endSession(UUID player) {
        if (!GodSessionManager.isOwner(player)) return "Aucune séance active pour ce joueur.";
        if (GodSessionManager.hasManifested()) {
            try {
                world.vanish(player);
            } catch (WorldRefusal ignored) {
                // the lock is released below whatever the main thread did
            }
        }
        GodSessionManager.endSession(player);
        return "Séance close.";
    }

    /** The {@code Wait} clamp: {@code waitMinSeconds..waitMaxSeconds}. */
    public int waitSeconds(int requested) {
        return Math.max(cfg.waitMinSeconds, Math.min(requested, cfg.waitMaxSeconds));
    }

    public static String waitMessage(int seconds) {
        return "Le temps passe… " + seconds + " seconde(s) se sont écoulées.";
    }

    /**
     * God's line to the praying player ({@code Dieu : …}), also spoken aloud through the avatar when this player
     * owns the session and the body is manifested. Blank lines are refused; long ones are cut at
     * {@link #MAX_SAY_CHARS}.
     */
    public String say(UUID player, String message) {
        if (message == null || message.isBlank()) return "Message vide : rien à dire.";
        String line = message.strip();
        if (line.length() > MAX_SAY_CHARS) line = line.substring(0, MAX_SAY_CHARS);
        try {
            world.tell(player, "Dieu : " + line);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
        if (GodSessionManager.isOwner(player) && GodSessionManager.hasManifested()) world.speak(line);
        return "Message transmis au joueur.";
    }

    public String playerContext(UUID player) {
        try {
            return world.playerContext(player);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
    }

    public String queryTerrain(UUID player, Integer centerX, Integer centerZ, Integer radius) {
        try {
            return world.queryTerrain(player, centerX, centerZ, radius);
        } catch (WorldRefusal r) {
            return r.getMessage();
        }
    }

    /**
     * Body choreography after an effect. Bug #8: only the session owner's tools move the body, and only once it
     * is manifested ({@code hasManifested()} is global — a bodiless player's Reward used to nod the owner's body).
     * Best-effort: a gesture never fails the effect it follows.
     */
    private void gesture(UUID player, String kind) {
        if (!GodSessionManager.hasManifested() || !GodSessionManager.isOwner(player)) return;
        try {
            world.gesture(player, kind);
        } catch (RuntimeException ignored) {
            // the effect already happened
        }
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(v, Math.max(lo, hi)));
    }
}
