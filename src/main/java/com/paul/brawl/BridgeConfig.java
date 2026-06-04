package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Configuration for the Node-side bridge and the avatar's behaviour limits.
 *
 * <p>Single source of truth for the bot's username — the Mineflayer
 * {@code --username} flag, the op-on-join hook in {@link ServerEntryPoint},
 * and the avatar lookup in {@link ChatBotActions} all read from here.
 *
 * <p>Persisted alongside {@link LLMConfig} so admins can tune everything via
 * the {@code /llm} command set without restarting the server.
 */
public class BridgeConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("BridgeConfig");

    public static final Path CONFIG_PATH = Path.of("bridge_config.properties");

    public static final BridgeConfig INSTANCE = new BridgeConfig();

    /** Host + port of the Node bridge HTTP server. */
    public String bridgeUrl = "http://127.0.0.1:8765";

    /** Whether the mod should issue any bridge calls. When false God answers bodiless. */
    public boolean enabled = true;

    /** Username of the Mineflayer bot — must match the bridge's {@code --username} flag. */
    public String botUsername = "LLMBot";

    /** Parking spot the bot teleports to on Vanish. Picked far away so it can't be seen. */
    public double parkingX = 0;
    public double parkingY = -64;
    public double parkingZ = 0;

    /** Clamps on the {@code Appear} tool's optional fields. */
    public double appearMinDistance = 1.0;
    public double appearMaxDistance = 6.0;
    public double appearMinHeight   = 0.0;
    public double appearMaxHeight   = 4.0;

    /** Clamps on the {@code Wait} tool. The watchdog timeout below must exceed this. */
    public int waitMinSeconds = 1;
    public int waitMaxSeconds = 30;

    /** Clamp on {@code SpawnCreature.count}. */
    public int spawnCountMax = 8;

    /**
     * Whether god-spawned creatures may damage terrain (creeper explosions,
     * endermen picking up blocks, etc.). Default off so a single bored prayer
     * can't level the spawn region.
     */
    public boolean creatureGriefingAllowed = false;

    /**
     * Idle-watchdog timeout in seconds. Must be larger than {@link #waitMaxSeconds}
     * so a deliberate {@code Wait(30)} doesn't trip the watchdog and dismiss the body.
     */
    public int idleTimeoutSeconds = 90;

    private BridgeConfig() {
        load();
    }

    public synchronized void save() {
        Properties p = new Properties();
        p.setProperty("bridgeUrl",                bridgeUrl);
        p.setProperty("enabled",                  Boolean.toString(enabled));
        p.setProperty("botUsername",              botUsername);
        p.setProperty("parkingX",                 Double.toString(parkingX));
        p.setProperty("parkingY",                 Double.toString(parkingY));
        p.setProperty("parkingZ",                 Double.toString(parkingZ));
        p.setProperty("appearMinDistance",        Double.toString(appearMinDistance));
        p.setProperty("appearMaxDistance",        Double.toString(appearMaxDistance));
        p.setProperty("appearMinHeight",          Double.toString(appearMinHeight));
        p.setProperty("appearMaxHeight",          Double.toString(appearMaxHeight));
        p.setProperty("waitMinSeconds",           Integer.toString(waitMinSeconds));
        p.setProperty("waitMaxSeconds",           Integer.toString(waitMaxSeconds));
        p.setProperty("spawnCountMax",            Integer.toString(spawnCountMax));
        p.setProperty("creatureGriefingAllowed",  Boolean.toString(creatureGriefingAllowed));
        p.setProperty("idleTimeoutSeconds",       Integer.toString(idleTimeoutSeconds));
        try (var out = Files.newOutputStream(CONFIG_PATH)) {
            p.store(out, "God-Body bridge configuration");
        } catch (IOException e) {
            LOGGER.warn("Failed to save bridge config: {}", e.getMessage());
        }
    }

    public synchronized void load() {
        if (!Files.exists(CONFIG_PATH)) return;
        Properties p = new Properties();
        try (var in = Files.newInputStream(CONFIG_PATH)) {
            p.load(in);
        } catch (IOException e) {
            LOGGER.warn("Failed to load bridge config: {}", e.getMessage());
            return;
        }
        bridgeUrl               = p.getProperty("bridgeUrl",   bridgeUrl);
        enabled                 = parseBool(p.getProperty("enabled"),   enabled);
        botUsername             = p.getProperty("botUsername", botUsername);
        parkingX                = parseDouble(p.getProperty("parkingX"),         parkingX);
        parkingY                = parseDouble(p.getProperty("parkingY"),         parkingY);
        parkingZ                = parseDouble(p.getProperty("parkingZ"),         parkingZ);
        appearMinDistance       = parseDouble(p.getProperty("appearMinDistance"), appearMinDistance);
        appearMaxDistance       = parseDouble(p.getProperty("appearMaxDistance"), appearMaxDistance);
        appearMinHeight         = parseDouble(p.getProperty("appearMinHeight"),   appearMinHeight);
        appearMaxHeight         = parseDouble(p.getProperty("appearMaxHeight"),   appearMaxHeight);
        waitMinSeconds          = parseInt(p.getProperty("waitMinSeconds"),       waitMinSeconds);
        waitMaxSeconds          = parseInt(p.getProperty("waitMaxSeconds"),       waitMaxSeconds);
        spawnCountMax           = parseInt(p.getProperty("spawnCountMax"),        spawnCountMax);
        creatureGriefingAllowed = parseBool(p.getProperty("creatureGriefingAllowed"), creatureGriefingAllowed);
        idleTimeoutSeconds      = parseInt(p.getProperty("idleTimeoutSeconds"),   idleTimeoutSeconds);
    }

    private static boolean parseBool(String s, boolean fallback) {
        if (s == null) return fallback;
        return Boolean.parseBoolean(s.trim());
    }

    private static int parseInt(String s, int fallback) {
        if (s == null) return fallback;
        try { return Integer.parseInt(s.trim()); }
        catch (NumberFormatException e) { return fallback; }
    }

    private static double parseDouble(String s, double fallback) {
        if (s == null) return fallback;
        try { return Double.parseDouble(s.trim()); }
        catch (NumberFormatException e) { return fallback; }
    }

    public String describe() {
        return "BridgeConfig{enabled=" + enabled
            + ", url=" + bridgeUrl
            + ", bot=" + botUsername
            + ", appear=[" + appearMinDistance + ".." + appearMaxDistance + "], h=[" + appearMinHeight + ".." + appearMaxHeight + "]"
            + ", wait=[" + waitMinSeconds + ".." + waitMaxSeconds + "s]"
            + ", spawnMax=" + spawnCountMax
            + ", griefing=" + creatureGriefingAllowed
            + ", idle=" + idleTimeoutSeconds + "s"
            + "}";
    }
}
