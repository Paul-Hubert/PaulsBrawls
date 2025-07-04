package com.paul.brawl;

import java.util.HashMap;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.item.Item;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;


public class TradeOffers {

    private static class TradeOffer {
        public String giveItemName, takeItemName;
        public int giveAmount, takeAmount;

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
                return "L'échange est annulé. " + giveItemName + " n'est pas un item correct. Veuillez rééssayer.";
            }

            takeItem = ChatBotActions.getItemFromString(takeItemName);
            if(takeItem == null) {
                return "L'échange est annulé. " + takeItemName + " n'est pas un item correct. Veuillez rééssayer.";
            }

            return null;
        }

        public boolean execute(ServerPlayerEntity player) {

            int amount = 0;
            for (var stack : player.getInventory().main) {
                if (!stack.isEmpty()
                && stack.getItem().getName().getString()
                .equals(takeItem.getName().getString())) {
                    amount += stack.getCount();
                }
            }
            
            int toBeRemoved = takeAmount;

            if(amount < toBeRemoved) {
                ChatPrinter.sendMessage(player, "L'échange est annulé. Vous n'avez que " + amount + " " + takeItemName + " alors qu'il en faut " + takeAmount + ".");
                return false;
            }
            
            for (var stack : player.getInventory().main) {
                if (!stack.isEmpty()
                && stack.getItem().getName().getString()
                .equals(takeItem.getName().getString())) {
                    var actuallyRemoved = Math.min(stack.getCount(), toBeRemoved);
                    stack.setCount(stack.getCount() - actuallyRemoved);
                    toBeRemoved -= actuallyRemoved;
                    if(toBeRemoved <= 0) {
                        break;
                    }
                }
            }

            if(toBeRemoved != 0) {
                ChatPrinter.sendMessage(player, "Retiré trop d'items");
            }

            ChatBotActions.giveItem(player, giveItem, giveAmount);

            return true;
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
                LiteralArgumentBuilder.<ServerCommandSource>literal("accepter")
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
            ChatPrinter.sendMessage(player, "Vous n'avez pas de demande d'échange en cours, demandez à Dieu avec /prier.");
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

        var offer = new TradeOffer(giveItemName, giveAmount, takeItemName, takeAmount);
        String error = offer.verifyItems();
        if(error != null) {
            return error;
        }
        offers.put(player.getUuid(), offer);
        return null;
    }

}
