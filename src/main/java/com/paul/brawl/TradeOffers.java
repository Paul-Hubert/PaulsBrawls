package com.paul.brawl;

import java.util.HashMap;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;


public class TradeOffers {

    /** Upper bound for either side of a God trade (LLM-supplied amounts). */
    public static final int MAX_TRADE_AMOUNT = 512;

    /** A pending offer that isn't {@code /accept}ed within this window is dropped. */
    public static final long OFFER_TTL_MILLIS = 5 * 60 * 1000L;

    private static class TradeOffer {
        public String giveItemName, takeItemName;
        public int giveAmount, takeAmount;
        public final long createdAtMillis = System.currentTimeMillis();

        private Item giveItem, takeItem;

        public TradeOffer(String giveItemName, int giveAmount, String takeItemName, int takeAmount) {
            this.giveItemName = giveItemName;
            this.giveAmount = giveAmount;
            this.takeItemName = takeItemName;
            this.takeAmount = takeAmount;
        }

        public String verifyItems() {

            giveItem = ChatBotActions.getItemFromString(giveItemName);
            if(giveItem == null) {
                return "Trade cancelled. " + giveItemName + " was not a correct item. Please try again.";
            }

            takeItem = ChatBotActions.getItemFromString(takeItemName);
            if(takeItem == null) {
                return "Trade cancelled. " + takeItemName + " was not a correct item. Please try again.";
            }

            return null;
        }

        public boolean execute(ServerPlayerEntity player) {

            // Match by registry item (stack.isOf), not by translated display
            // name — two items sharing a name must not be interchangeable.
            var main = player.getInventory().main;
            int[] available = new int[main.size()];
            int amount = 0;
            for (int i = 0; i < available.length; i++) {
                var stack = main.get(i);
                if (!stack.isEmpty() && stack.isOf(takeItem)) {
                    available[i] = stack.getCount();
                    amount += stack.getCount();
                }
            }

            // planTakes rejects takeAmount < 1, so a negative amount can no
            // longer turn the removal into an addition.
            int[] takes = TradeMath.planTakes(available, takeAmount);
            if(takes == null) {
                ChatPrinter.sendMessage(player, "The trade is cancelled. You only have " + amount + " " + takeItemName + ", but " + takeAmount + " are required.");
                return false;
            }

            for (int i = 0; i < takes.length; i++) {
                if (takes[i] > 0) main.get(i).decrement(takes[i]);
            }

            giveItemsOrDrop(player, giveItem, giveAmount);

            return true;
        }
    }

    /**
     * Returns a model-facing error if either amount is outside
     * {@code [1, MAX_TRADE_AMOUNT]}, else {@code null}. Checked when the
     * {@code Trade} tool runs AND again on {@code /accept}.
     */
    public static String checkAmounts(int giveAmount, int takeAmount) {
        return TradeMath.amountError(giveAmount, takeAmount, MAX_TRADE_AMOUNT);
    }

    /** Gives in max-stack-size chunks; whatever doesn't fit drops at the player's feet. */
    private static void giveItemsOrDrop(ServerPlayerEntity player, Item item, int amount) {
        int maxPerStack = Math.max(1, item.getDefaultStack().getMaxCount());
        for (int remaining = amount; remaining > 0; ) {
            int n = Math.min(remaining, maxPerStack);
            player.getInventory().offerOrDrop(new ItemStack(item, n));
            remaining -= n;
        }
    }

    private static final Logger LOGGER = LoggerFactory.getLogger("TradeOffers");

    private static final HashMap<UUID, TradeOffer> offers = new HashMap<>();

    public static void register() {
        registerTradeCommand();
    }

    private static void registerTradeCommand() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
                LiteralArgumentBuilder.<ServerCommandSource>literal("accept")
                .executes(context -> {
                    executeOffer(context.getSource().getPlayer());
                    return Command.SINGLE_SUCCESS;
                })
            );
        });
    }

    private static void executeOffer(ServerPlayerEntity player) {
        var offer = offers.get(player.getUuid());
        if(offer == null) {
            ChatPrinter.sendMessage(player, "You have no trade request in progress, ask God with /pray.");
            return;
        }

        if(TradeMath.isExpired(offer.createdAtMillis, System.currentTimeMillis(), OFFER_TTL_MILLIS)) {
            offers.remove(player.getUuid());
            ChatPrinter.sendMessage(player, "God's trade offer has expired, ask God again with /pray.");
            return;
        }

        // Defence in depth: the offer is stored LLM output.
        if(checkAmounts(offer.giveAmount, offer.takeAmount) != null) {
            offers.remove(player.getUuid());
            ChatPrinter.sendMessage(player, "God's trade offer was invalid and has been cancelled.");
            LOGGER.warn("Dropped invalid trade offer for {}: give {} / take {}", player.getName().getString(), offer.giveAmount, offer.takeAmount);
            return;
        }

        var executed = offer.execute(player);

        // if failed, don't remove offer (probably doesn't have inventory)
        if(!executed) return;

        offers.remove(player.getUuid());
    }

    public static String updateOffer(
        ServerPlayerEntity player,
        String giveItemName, int giveAmount,
        String takeItemName, int takeAmount) {

        String error = checkAmounts(giveAmount, takeAmount);
        if(error != null) {
            return error;
        }
        var offer = new TradeOffer(giveItemName, giveAmount, takeItemName, takeAmount);
        error = offer.verifyItems();
        if(error != null) {
            return error;
        }
        offers.put(player.getUuid(), offer);
        return null;
    }

}
