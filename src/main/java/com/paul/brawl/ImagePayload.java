package com.paul.brawl;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

public record ImagePayload(byte[] image, String text) implements CustomPacketPayload {

    public static final ResourceLocation identifier = ResourceLocation.fromNamespaceAndPath("screenshot", "image");

    public static final CustomPacketPayload.Type<ImagePayload> ID = new CustomPacketPayload.Type<>(identifier);
    public static final StreamCodec<RegistryFriendlyByteBuf, ImagePayload> CODEC = StreamCodec.composite(
        ByteBufCodecs.BYTE_ARRAY, ImagePayload::image,
        ByteBufCodecs.STRING_UTF8, ImagePayload::text,
         ImagePayload::new);
    // should you need to send more data, add the appropriate record parameters and change your codec:
    // public static final PacketCodec<RegistryByteBuf, BlockHighlightPayload> CODEC = PacketCodec.tuple(
    //         BlockPos.PACKET_CODEC, BlockHighlightPayload::blockPos,
    //         PacketCodecs.INTEGER, BlockHighlightPayload::myInt,
    //         Uuids.PACKET_CODEC, BlockHighlightPayload::myUuid,
    //         BlockHighlightPayload::new
    // );
 
    @Override
    public CustomPacketPayload.Type<? extends CustomPacketPayload> type() {
        return ID;
    }
}