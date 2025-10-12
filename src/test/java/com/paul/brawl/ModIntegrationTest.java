package com.paul.brawl;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import static org.junit.jupiter.api.Assertions.*;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Integration tests for the Paul's Brawls mod
 * Tests the complete mod functionality including OpenAI integration
 */
public class ModIntegrationTest {
    
    @BeforeEach
    void setUp() {
        // Set up test environment
        System.setProperty("OPENAI_API_KEY", "test-key");
        System.setProperty("OPENAI_ORG_ID", "test-org");
        System.setProperty("OPENAI_PROJECT_ID", "test-project");
    }
    
    @Test
    @DisplayName("Complete mod initialization should work")
    void testCompleteModInitialization() {
        assertDoesNotThrow(() -> {
            // Initialize all mod components
            ChatBot.register();
            
            // Verify all components are initialized
            assertNotNull(ChatBot.client);
            assertNotNull(ChatBot.prompt);
        });
    }
    
    @Test
    @DisplayName("ChatBot functions should be properly registered")
    void testChatBotFunctionsRegistration() {
        assertDoesNotThrow(() -> {
            var builder = com.openai.models.responses.ResponseCreateParams.builder();
            var result = ChatBotFunctions.registerTools(builder);
            assertNotNull(result);
        });
    }
    
    @Test
    @DisplayName("Mod should handle missing API key gracefully")
    void testMissingApiKeyHandling() {
        // Clear API key
        System.clearProperty("OPENAI_API_KEY");
        
        assertDoesNotThrow(() -> {
            ChatBot.register();
        });
    }
    
    @Test
    @DisplayName("Prompt file should be readable")
    void testPromptFileReading() {
        assertDoesNotThrow(() -> {
            ChatBot.readPrompt();
            // Prompt should not be null or empty
            assertNotNull(ChatBot.hardcodedPrompt);
        });
    }
}
