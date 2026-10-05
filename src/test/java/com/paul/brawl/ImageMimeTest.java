package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ImageMimeTest {

    private static byte[] bytes(int... b) {
        byte[] out = new byte[b.length];
        for (int i = 0; i < b.length; i++) out[i] = (byte) b[i];
        return out;
    }

    @Test
    void pngScreenshotsAreLabelledPng() {
        // NativeImage.getBytes() output starts with the PNG signature (bug #9: it was sent as image/jpeg).
        assertEquals("image/png", ImageMime.sniff(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)));
    }

    @Test
    void otherFormatsAreRecognised() {
        assertEquals("image/jpeg", ImageMime.sniff(bytes(0xFF, 0xD8, 0xFF, 0xE0)));
        assertEquals("image/gif", ImageMime.sniff(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)));
        assertEquals("image/webp", ImageMime.sniff(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)));
    }

    @Test
    void unknownOrShortInputFallsBackToPng() {
        assertEquals("image/png", ImageMime.sniff(null));
        assertEquals("image/png", ImageMime.sniff(new byte[0]));
        assertEquals("image/png", ImageMime.sniff(bytes(0xFF, 0xD8)));
        assertEquals("image/png", ImageMime.sniff(bytes(1, 2, 3, 4, 5)));
    }
}
