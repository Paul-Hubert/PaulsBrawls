package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.openai.client.OpenAIClientAsync;
import com.openai.client.okhttp.OpenAIOkHttpClientAsync;

public class LLMConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("LLMConfig");

    public static final String OPENAI = "openai";
    public static final String LMSTUDIO = "lmstudio";
    public static final String OLLAMA = "ollama";

    public static final Path CONFIG_PATH = Path.of("llm_config.properties");

    public static final LLMConfig INSTANCE = new LLMConfig();

    public static class ProviderSettings {
        public String host;
        public int port;
        public String model;
        public String apiKey;

        public ProviderSettings(String host, int port, String model, String apiKey) {
            this.host = host;
            this.port = port;
            this.model = model;
            this.apiKey = apiKey;
        }

        public String baseUrl() {
            return host + ":" + port + "/v1";
        }
    }

    public final Map<String, ProviderSettings> providers = new LinkedHashMap<>();
    public String activeProvider = OPENAI;

    private OpenAIClientAsync sharedClient;

    private LLMConfig() {
        providers.put(OPENAI, new ProviderSettings("https://api.openai.com", 443, "gpt-5", ""));
        providers.put(LMSTUDIO, new ProviderSettings("http://localhost", 1234, "openai/gpt-oss-20b", "lm-studio"));
        providers.put(OLLAMA, new ProviderSettings("http://localhost", 11434, "llama3.2", "ollama"));
        load();
    }

    public ProviderSettings active() {
        return providers.get(activeProvider);
    }

    public String model() {
        return active().model;
    }

    public boolean setProvider(String name) {
        if (!providers.containsKey(name)) return false;
        activeProvider = name;
        save();
        return true;
    }

    public OpenAIClientAsync buildClient() {
        ProviderSettings p = active();
        var builder = OpenAIOkHttpClientAsync.builder()
            .baseUrl(p.baseUrl())
            .apiKey(resolveApiKey(p));

        if (OPENAI.equals(activeProvider)) {
            String org = System.getenv("OPENAI_ORG_ID");
            if (org != null && !org.isEmpty()) builder = builder.organization(org);
            String project = System.getenv("OPENAI_PROJECT_ID");
            if (project != null && !project.isEmpty()) builder = builder.project(project);
        }

        return builder.build();
    }

    /**
     * Returns a cached client for the active provider. All ChatBots and sub-agents
     * should use this so we open a single OkHttp pool instead of one per consumer.
     * Invalidated by {@link #invalidateClient()} when settings change.
     */
    public synchronized OpenAIClientAsync sharedClient() {
        if (sharedClient == null) sharedClient = buildClient();
        return sharedClient;
    }

    /** Drops the cached client so the next {@link #sharedClient()} rebuilds with current settings. */
    public synchronized void invalidateClient() {
        sharedClient = null;
    }

    private String resolveApiKey(ProviderSettings p) {
        if (p.apiKey != null && !p.apiKey.isEmpty()) return p.apiKey;
        if (OPENAI.equals(activeProvider)) {
            String envKey = System.getenv("OPENAI_API_KEY");
            if (envKey != null && !envKey.isEmpty()) return envKey;
        }
        // Local servers (LM Studio, Ollama) don't validate the key but the SDK requires one.
        return activeProvider;
    }

    public synchronized void save() {
        Properties props = new Properties();
        props.setProperty("active", activeProvider);
        for (var entry : providers.entrySet()) {
            String prefix = entry.getKey() + ".";
            ProviderSettings p = entry.getValue();
            props.setProperty(prefix + "host", p.host);
            props.setProperty(prefix + "port", Integer.toString(p.port));
            props.setProperty(prefix + "model", p.model);
            props.setProperty(prefix + "apikey", p.apiKey == null ? "" : p.apiKey);
        }
        try (var out = Files.newOutputStream(CONFIG_PATH)) {
            props.store(out, "LLM provider configuration");
        } catch (IOException e) {
            LOGGER.warn("Failed to save LLM config: {}", e.getMessage());
        }
    }

    public synchronized void load() {
        if (!Files.exists(CONFIG_PATH)) return;
        Properties props = new Properties();
        try (var in = Files.newInputStream(CONFIG_PATH)) {
            props.load(in);
        } catch (IOException e) {
            LOGGER.warn("Failed to load LLM config: {}", e.getMessage());
            return;
        }
        String act = props.getProperty("active");
        if (act != null && providers.containsKey(act)) activeProvider = act;
        for (var entry : providers.entrySet()) {
            String prefix = entry.getKey() + ".";
            ProviderSettings p = entry.getValue();
            String host = props.getProperty(prefix + "host");
            if (host != null) p.host = host;
            String port = props.getProperty(prefix + "port");
            if (port != null) {
                try { p.port = Integer.parseInt(port); } catch (NumberFormatException ignored) {}
            }
            String model = props.getProperty(prefix + "model");
            if (model != null) p.model = model;
            String apiKey = props.getProperty(prefix + "apikey");
            if (apiKey != null) p.apiKey = apiKey;
        }
    }
}
