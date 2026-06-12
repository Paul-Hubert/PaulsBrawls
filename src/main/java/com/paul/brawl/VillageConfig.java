package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Configuration for the AI-village integration (VILLAGE_PLAN.md):
 * the localhost trade-settlement listener this mod hosts, and the URL of the
 * Node village process's admin API (used by the /village command).
 *
 * Persisted alongside the other configs so admins can tune it without a
 * restart. Same pattern as {@link BridgeConfig}.
 */
public class VillageConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("VillageConfig");

    public static final Path CONFIG_PATH = Path.of("village_config.properties");

    public static final VillageConfig INSTANCE = new VillageConfig();

    /** Whether the settlement HTTP listener runs at all. */
    public boolean enabled = true;

    /** Port for the localhost-only settlement listener (POST /trade/execute). */
    public int listenerPort = 8767;

    /** Admin API of the Node village process (npm run village). */
    public String nodeAdminUrl = "http://127.0.0.1:8766";

    private VillageConfig() {
        load();
    }

    public synchronized void save() {
        Properties p = new Properties();
        p.setProperty("enabled",      Boolean.toString(enabled));
        p.setProperty("listenerPort", Integer.toString(listenerPort));
        p.setProperty("nodeAdminUrl", nodeAdminUrl);
        try (var out = Files.newOutputStream(CONFIG_PATH)) {
            p.store(out, "AI village configuration");
        } catch (IOException e) {
            LOGGER.warn("Failed to save village config: {}", e.getMessage());
        }
    }

    public synchronized void load() {
        if (!Files.exists(CONFIG_PATH)) return;
        Properties p = new Properties();
        try (var in = Files.newInputStream(CONFIG_PATH)) {
            p.load(in);
        } catch (IOException e) {
            LOGGER.warn("Failed to load village config: {}", e.getMessage());
            return;
        }
        enabled      = parseBool(p.getProperty("enabled"), enabled);
        listenerPort = parseInt(p.getProperty("listenerPort"), listenerPort);
        nodeAdminUrl = p.getProperty("nodeAdminUrl", nodeAdminUrl);
    }

    public String describe() {
        return "VillageConfig{enabled=" + enabled
            + ", listenerPort=" + listenerPort
            + ", nodeAdminUrl=" + nodeAdminUrl
            + "}";
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
}
