package com.paul.brawl;

/**
 * Bug #8 — who may drive the shared avatar through MCP (Mineflayer) tools. Minecraft-free so the decision is
 * unit-tested (GodToolGateTest); {@link ChatBotFunctions} feeds it the live session/bridge state.
 *
 * <p>MCP tools move, dig and fight with the avatar bot itself. They had no gate at all: a bodiless prayer
 * (another player holds the body) or a disabled bridge ({@code /godbody off}) could still drive it.
 */
public final class GodToolGate {
    private GodToolGate() {}

    /** The French refusal the model reads, or {@code null} when the call may run. */
    public static String mcpRefusal(boolean bridgeEnabled, boolean ownsSession) {
        if (!bridgeEnabled) return "Le corps de Dieu est désactivé par un administrateur — cet outil est indisponible.";
        if (!ownsSession) return "Le corps de Dieu est occupé avec un autre fidèle — cet outil ne peut pas l'utiliser.";
        return null;
    }
}
