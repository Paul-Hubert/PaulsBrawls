package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;

import org.junit.jupiter.api.Test;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.ImageContent;
import dev.langchain4j.data.message.TextContent;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.chat.TokenWindowChatMemory;
import dev.langchain4j.model.openai.OpenAiTokenCountEstimator;

class ImageAwareTokenEstimatorTest {

    private static final OpenAiTokenCountEstimator OPENAI = new OpenAiTokenCountEstimator("gpt-4o");
    private static final ImageAwareTokenEstimator ESTIMATOR = new ImageAwareTokenEstimator(OPENAI);

    private static UserMessage screenshot(String text) {
        return UserMessage.from(TextContent.from(text), ImageContent.from("iVBORw0KGgo=", "image/png"));
    }

    @Test
    void theBareOpenAiEstimatorThrowsOnImages() {
        // The bug: TokenWindowChatMemory.add -> OpenAiTokenCountEstimator -> "Unknown content type: ImageContent".
        assertThrows(IllegalArgumentException.class, () -> OPENAI.estimateTokenCountInMessage(screenshot("x")));
    }

    @Test
    void anImageCostsTextPlusAFixedAmount() {
        String text = "Construis une tour ici";
        assertEquals(OPENAI.estimateTokenCountInMessage(UserMessage.from(text)) + ImageAwareTokenEstimator.IMAGE_TOKENS,
            ESTIMATOR.estimateTokenCountInMessage(screenshot(text)));
    }

    @Test
    void textOnlyMessagesAreCountedExactlyAsBefore() {
        List<ChatMessage> messages = List.of(UserMessage.from("bonjour"), AiMessage.from("salut"));
        assertEquals(OPENAI.estimateTokenCountInMessages(messages), ESTIMATOR.estimateTokenCountInMessages(messages));
        assertEquals(OPENAI.estimateTokenCountInText("abc"), ESTIMATOR.estimateTokenCountInText("abc"));
    }

    @Test
    void anImageOnlyMessageAndAListAreCounted() {
        UserMessage onlyImage = UserMessage.from(ImageContent.from("iVBORw0KGgo=", "image/png"));
        List<ChatMessage> messages = List.of(screenshot("a"), onlyImage, AiMessage.from("ok"));
        int n = ESTIMATOR.estimateTokenCountInMessages(messages);
        assertEquals(OPENAI.estimateTokenCountInMessages(
                List.of(UserMessage.from("a"), UserMessage.from("[image]"), AiMessage.from("ok")))
            + 2 * ImageAwareTokenEstimator.IMAGE_TOKENS, n);
    }

    @Test
    void theChatMemoryAcceptsAScreenshot() {
        TokenWindowChatMemory memory = TokenWindowChatMemory.withMaxTokens(ChatBot.MAX_MEMORY_TOKENS, ESTIMATOR);
        memory.add(screenshot("/build une maison"));
        assertEquals(1, memory.messages().size());
    }
}
