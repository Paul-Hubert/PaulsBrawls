package com.paul.brawl;

import java.util.ArrayList;
import java.util.List;

import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.Content;
import dev.langchain4j.data.message.ImageContent;
import dev.langchain4j.data.message.TextContent;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.TokenCountEstimator;

/**
 * A {@link TokenCountEstimator} that also counts images.
 *
 * <p>LangChain4j 1.0.0's {@code OpenAiTokenCountEstimator} throws
 * {@code IllegalArgumentException: Unknown content type: ImageContent} on any user message with an image, and
 * {@code TokenWindowChatMemory.add} calls it, so every builtin {@code /build} and {@code /prove} crashed before
 * the request was sent. This wrapper gives the text to the delegate and charges each image a fixed
 * {@link #IMAGE_TOKENS}.
 */
public final class ImageAwareTokenEstimator implements TokenCountEstimator {

    /**
     * gpt-4o's high-detail cost for the client's 854×480 screenshot: 85 base + 2 tiles of 512 px × 170.
     * A budget, not an invoice.
     */
    public static final int IMAGE_TOKENS = 425;

    private final TokenCountEstimator delegate;

    public ImageAwareTokenEstimator(TokenCountEstimator delegate) {
        this.delegate = delegate;
    }

    @Override
    public int estimateTokenCountInText(String text) {
        return delegate.estimateTokenCountInText(text);
    }

    @Override
    public int estimateTokenCountInMessage(ChatMessage message) {
        return delegate.estimateTokenCountInMessage(textOnly(message)) + IMAGE_TOKENS * imageCount(message);
    }

    @Override
    public int estimateTokenCountInMessages(Iterable<ChatMessage> messages) {
        List<ChatMessage> texts = new ArrayList<>();
        int images = 0;
        for (ChatMessage m : messages) {
            texts.add(textOnly(m));
            images += imageCount(m);
        }
        return delegate.estimateTokenCountInMessages(texts) + IMAGE_TOKENS * images;
    }

    private static int imageCount(ChatMessage message) {
        if (!(message instanceof UserMessage user)) return 0;
        int n = 0;
        for (Content c : user.contents()) if (c instanceof ImageContent) n++;
        return n;
    }

    /** The message with every image dropped (a placeholder if nothing else is left). */
    private static ChatMessage textOnly(ChatMessage message) {
        if (imageCount(message) == 0) return message;
        UserMessage user = (UserMessage) message;
        List<Content> kept = new ArrayList<>();
        for (Content c : user.contents()) if (!(c instanceof ImageContent)) kept.add(c);
        if (kept.isEmpty()) kept.add(TextContent.from("[image]"));
        return user.name() == null ? UserMessage.from(kept) : UserMessage.from(user.name(), kept);
    }
}
