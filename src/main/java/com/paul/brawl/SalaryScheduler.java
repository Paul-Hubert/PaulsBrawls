package com.paul.brawl;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class SalaryScheduler {
    private static final Logger LOGGER = LoggerFactory.getLogger("SalaryScheduler");
    private static ScheduledExecutorService scheduler;
    private static boolean started = false;
    public static String SALARY_KEY = "salary_per_day";
    public static String SALARY_PERIOD_KEY = "salary_period";

    public static void register() {
        ServerLifecycleEvents.SERVER_STARTED.register((server) -> {
			start(server);
		});
		ServerLifecycleEvents.SERVER_STOPPING.register((server) -> {
			stop();
		});
    }

    public static void giveDailyRevenue(MinecraftServer server) {
        PlayerPersistentState state = PlayerPersistentState.getState(server);
        var amount = state.getGlobalValue(SALARY_KEY);
        var val = state.getGlobalValue(RevenueManager.TOTAL_REVENUE_KEY);
        // Increment by daily income
        val += amount;
        state.setGlobalValue(RevenueManager.TOTAL_REVENUE_KEY, val);
        //LOGGER.info("gibbed daily salary " + amount);
        RevenueManager.UpdateRevenueAll(server);
    }

    public static void start(MinecraftServer server) {
        if (started) return;
        started = true;
        scheduler = Executors.newSingleThreadScheduledExecutor();
        

        //long initialDelay = getInitialDelayToMidnight();
        //long period = TimeUnit.DAYS.toSeconds(1);
        
        PlayerPersistentState state = PlayerPersistentState.getState(server);
        int period = state.getGlobalValue(SALARY_PERIOD_KEY);

        if(period == 0) {
            state.setGlobalValue(SalaryScheduler.SALARY_PERIOD_KEY, 10);
            period = 10;
        }
        
        
        scheduler.scheduleAtFixedRate(() -> {
            // Ensure this runs on the main server thread
            server.execute(() -> {
                giveDailyRevenue(server);
            });
        }, 0, period, TimeUnit.SECONDS);
    }

    private static long getInitialDelayToMidnight() {
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay();
        return Duration.between(now, nextMidnight).getSeconds() + 5; // make sure it doesn't double trigger;
    }

    public static void stop() {
        if (scheduler != null && !scheduler.isShutdown()) {
            scheduler.shutdownNow();
            started = false;
        }
    }

    public static void restart(MinecraftServer server) {
        stop();
        start(server);
    }
} 