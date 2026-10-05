package com.paul.brawl;

/**
 * Bug #9: the client ships {@code NativeImage.getBytes()} — PNG bytes — but the
 * request labelled every screenshot {@code image/jpeg}. Sniff the real type from
 * the magic number instead. Minecraft-free, so it is unit-tested.
 */
public final class ImageMime {
    private ImageMime() {}

    /** The MIME type of an encoded image; {@code image/png} when unrecognised (what the client sends). */
    public static String sniff(byte[] bytes) {
        if (bytes == null) return "image/png";
        if (starts(bytes, 0x89, 0x50, 0x4E, 0x47)) return "image/png";
        if (starts(bytes, 0xFF, 0xD8, 0xFF)) return "image/jpeg";
        if (starts(bytes, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
        if (bytes.length >= 12 && starts(bytes, 0x52, 0x49, 0x46, 0x46)
                && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50) {
            return "image/webp";
        }
        return "image/png";
    }

    private static boolean starts(byte[] b, int... magic) {
        if (b.length < magic.length) return false;
        for (int i = 0; i < magic.length; i++) {
            if ((b[i] & 0xFF) != magic[i]) return false;
        }
        return true;
    }
}
