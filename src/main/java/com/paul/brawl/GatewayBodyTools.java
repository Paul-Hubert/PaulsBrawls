package com.paul.brawl;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.internal.JsonSchemaElementUtils;

/** The real {@link BodyTools}: {@link MCPGateway}, the LangChain4j MCP client to the Node Mineflayer server. */
public final class GatewayBodyTools implements BodyTools {

    @Override
    public List<Spec> list() {
        List<Spec> out = new ArrayList<>();
        for (ToolSpecification ts : MCPGateway.INSTANCE.tools()) {
            Map<String, Object> schema = ts.parameters() == null ? Map.of("type", "object")
                : JsonSchemaElementUtils.toMap(ts.parameters());
            out.add(new Spec(ts.name(), ts.description(), schema));
        }
        return out;
    }

    @Override
    public boolean has(String name) {
        return MCPGateway.INSTANCE.handlesTool(name);
    }

    @Override
    public String call(String name, String argumentsJson) {
        return MCPGateway.INSTANCE.execute(ToolExecutionRequest.builder()
            .id("mcp-proxy")
            .name(name)
            .arguments(argumentsJson)
            .build());
    }
}
