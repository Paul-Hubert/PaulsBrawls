package com.paul.brawl;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;

import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.model.chat.request.json.JsonArraySchema;
import dev.langchain4j.model.chat.request.json.JsonBooleanSchema;
import dev.langchain4j.model.chat.request.json.JsonIntegerSchema;
import dev.langchain4j.model.chat.request.json.JsonNumberSchema;
import dev.langchain4j.model.chat.request.json.JsonObjectSchema;
import dev.langchain4j.model.chat.request.json.JsonSchemaElement;
import dev.langchain4j.model.chat.request.json.JsonStringSchema;

/**
 * Adapter that turns the Jackson-annotated POJOs in {@link ChatBotFunctions} into
 * LangChain4j {@link ToolSpecification}s. Keeps the schema descriptions co-located
 * with the POJOs (matching the pre-Phase-0 style where the OpenAI SDK auto-derived
 * schemas from {@code @JsonClassDescription} / {@code @JsonPropertyDescription}).
 *
 * <p>Conventions:
 * <ul>
 *   <li>Tool name = class simple name ({@code Reward}, {@code BuildPlan}, …).</li>
 *   <li>Every non-static field with {@link JsonPropertyDescription} becomes a property
 *       and is marked required — matches the old behaviour where the OpenAI SDK treated
 *       all annotated fields as required.</li>
 *   <li>Nested objects (e.g. {@code SubBuild}) and {@code List<T>} are walked recursively.</li>
 * </ul>
 */
public class JsonSchemaAdapter {

    public static ToolSpecification toolSpec(Class<?> cls) {
        JsonClassDescription cd = cls.getAnnotation(JsonClassDescription.class);
        String description = (cd != null) ? cd.value() : cls.getSimpleName();
        String name = cls.getSimpleName();

        JsonObjectSchema params = buildObjectSchema(cls);

        return ToolSpecification.builder()
            .name(name)
            .description(description)
            .parameters(params)
            .build();
    }

    private static JsonObjectSchema buildObjectSchema(Class<?> cls) {
        JsonObjectSchema.Builder b = JsonObjectSchema.builder();

        JsonClassDescription cd = cls.getAnnotation(JsonClassDescription.class);
        if (cd != null) b.description(cd.value());

        List<String> required = new ArrayList<>();
        for (Field f : cls.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers())) continue;
            JsonPropertyDescription pd = f.getAnnotation(JsonPropertyDescription.class);
            if (pd == null) continue;
            String fname = f.getName();
            JsonSchemaElement schema = schemaFor(f.getGenericType(), pd.value());
            b.addProperty(fname, schema);
            // Fields marked @OptionalField (or {@code Appear.distance} etc.)
            // are left off the required list so the model may omit them.
            if (f.getAnnotation(OptionalField.class) == null) {
                required.add(fname);
            }
        }
        if (!required.isEmpty()) b.required(required);
        return b.build();
    }

    private static JsonSchemaElement schemaFor(Type type, String description) {
        if (type instanceof Class<?> cls) {
            if (cls == String.class) {
                return JsonStringSchema.builder().description(description).build();
            }
            if (cls == int.class || cls == Integer.class
                || cls == long.class || cls == Long.class
                || cls == short.class || cls == Short.class) {
                return JsonIntegerSchema.builder().description(description).build();
            }
            if (cls == double.class || cls == Double.class
                || cls == float.class || cls == Float.class) {
                return JsonNumberSchema.builder().description(description).build();
            }
            if (cls == boolean.class || cls == Boolean.class) {
                return JsonBooleanSchema.builder().description(description).build();
            }
            // Nested user POJO — walk recursively. The object schema carries its own
            // class-level description if @JsonClassDescription is set, so we don't
            // need to thread the property-level `description` here.
            return buildObjectSchema(cls);
        }
        if (type instanceof ParameterizedType pt) {
            Type raw = pt.getRawType();
            if (raw instanceof Class<?> rawCls && List.class.isAssignableFrom(rawCls)) {
                Type item = pt.getActualTypeArguments()[0];
                JsonSchemaElement itemSchema = schemaFor(item, "");
                return JsonArraySchema.builder()
                    .description(description)
                    .items(itemSchema)
                    .build();
            }
        }
        // Fallback — treat as string. Should not happen for the current toolset.
        return JsonStringSchema.builder().description(description).build();
    }
}
