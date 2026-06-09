package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;

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

    /**
     * HTTP request timeout applied to every LLM call. Shared across all providers
     * (per-provider knobs would be overkill — just match the slowest one you use).
     *
     * <p>Default is 180 s because OpenAI reasoning models (gpt-5 and friends) routinely
     * exceed langchain4j's built-in 60 s default on long chats with tool definitions.
     * Bumped via {@code /llm timeout <seconds>}; persisted as {@code timeout_seconds}.
     * The cached {@link #sharedModel} is invalidated whenever this changes so the
     * builder picks up the new value on next call (callers go through {@link ChatBot#reloadClients()}).</p>
     */
    public int timeoutSeconds = 180;

    private ChatModel sharedModel;
    private ExecutorService sharedExecutor;

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

    /**
     * Builds a fresh {@link ChatModel} for the active provider. LangChain4j's
     * OpenAI module accepts a custom {@code baseUrl}, so the same builder serves
     * api.openai.com, LM Studio's localhost:1234, and Ollama's localhost:11434.
     */
    public ChatModel buildModel() {
        ProviderSettings p = active();
        OpenAiChatModel.OpenAiChatModelBuilder builder = OpenAiChatModel.builder()
            .baseUrl(p.baseUrl())
            .apiKey(resolveApiKey(p))
            .modelName(p.model)
            .timeout(Duration.ofSeconds(timeoutSeconds));

        if (OPENAI.equals(activeProvider)) {
            String org = System.getenv("OPENAI_ORG_ID");
            if (org != null && !org.isEmpty()) builder = builder.organizationId(org);
            String project = System.getenv("OPENAI_PROJECT_ID");
            if (project != null && !project.isEmpty()) builder = builder.projectId(project);
        }

        return builder.build();
    }

    /**
     * Returns a cached model for the active provider. All ChatBots and sub-agents
     * should use this so we open a single HTTP client pool instead of one per
     * consumer. Invalidated by {@link #invalidateClient()} when settings change.
     */
    public synchronized ChatModel sharedModel() {
        if (sharedModel == null) sharedModel = buildModel();
        return sharedModel;
    }

    /**
     * Shared worker pool for wrapping {@link ChatModel#chat} (blocking) calls in
     * {@link java.util.concurrent.CompletableFuture#supplyAsync} so callers retain
     * the existing async/callback contract. Threads are daemon so they don't keep
     * the JVM alive at shutdown.
     */
    public synchronized ExecutorService sharedExecutor() {
        if (sharedExecutor == null) {
            sharedExecutor = Executors.newFixedThreadPool(4, new ThreadFactory() {
                private final AtomicInteger seq = new AtomicInteger();
                @Override public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "llm-worker-" + seq.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                }
            });
        }
        return sharedExecutor;
    }

    /** Drops the cached model so the next {@link #sharedModel()} rebuilds with current settings. */
    public synchronized void invalidateClient() {
        sharedModel = null;
    }

    private String resolveApiKey(ProviderSettings p) {
        if (p.apiKey != null && !p.apiKey.isEmpty()) return p.apiKey;
        if (OPENAI.equals(activeProvider)) {
            String envKey = System.getenv("OPENAI_API_KEY");
            if (envKey != null && !envKey.isEmpty()) return envKey;
        }
        // Local servers (LM Studio, Ollama) don't validate the key but the client requires one.
        return activeProvider;
    }

    public synchronized void save() {
        Properties props = new Properties();
        props.setProperty("active", activeProvider);
        props.setProperty("timeout_seconds", Integer.toString(timeoutSeconds));
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
        String t = props.getProperty("timeout_seconds");
        if (t != null) {
            try { timeoutSeconds = Integer.parseInt(t); } catch (NumberFormatException ignored) {}
        }
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
