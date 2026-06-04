package com.paul.brawl;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Mark a Jackson-described tool field as optional in the generated
 * LangChain4j {@link dev.langchain4j.model.chat.request.json.JsonObjectSchema}
 * — i.e. omit it from the {@code required} list so the model can skip it.
 *
 * <p>The default in {@link JsonSchemaAdapter} is that every annotated field
 * is required (matches the pre-Phase-0 behaviour where the OpenAI SDK auto-
 * derived required fields from {@code @JsonPropertyDescription}). Tools like
 * {@code Appear} have defaults, so they need a way to opt fields out.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.FIELD)
public @interface OptionalField {
}
