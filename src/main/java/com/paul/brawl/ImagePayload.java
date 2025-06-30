package com.paul.brawl;

import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.codec.PacketCodecs;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.util.Identifier;

public record ImagePayload(byte[] image) implements CustomPayload {

    public static final Identifier identifier = Identifier.of("screenshot", "proof");

    public static final CustomPayload.Id<ImagePayload> ID = new CustomPayload.Id<>(identifier);
    public static final PacketCodec<RegistryByteBuf, ImagePayload> CODEC = PacketCodec.tuple(
        PacketCodecs.BYTE_ARRAY, ImagePayload::image,
         ImagePayload::new);
    // should you need to send more data, add the appropriate record parameters and change your codec:
    // public static final PacketCodec<RegistryByteBuf, BlockHighlightPayload> CODEC = PacketCodec.tuple(
    //         BlockPos.PACKET_CODEC, BlockHighlightPayload::blockPos,
    //         PacketCodecs.INTEGER, BlockHighlightPayload::myInt,
    //         Uuids.PACKET_CODEC, BlockHighlightPayload::myUuid,
    //         BlockHighlightPayload::new
    // );
 
    @Override
    public CustomPayload.Id<? extends CustomPayload> getId() {
        return ID;
    }
}