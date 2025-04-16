import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

export const startServer = async (args: any[], context: Reactory.Server.IReactoryContext) => {
  const server = new Server(
    {
      name: "example-server",
      version: "1.0.0"
    },
    {
      capabilities: {
        prompts: {}
      }
    }
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [{
        name: "example-prompt",
        description: "An example prompt template",
        arguments: [{
          name: "arg1",
          description: "Example argument",
          required: true
        }]
      }]
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== "example-prompt") {
      throw new Error("Unknown prompt");
    }
    return {
      description: "Example prompt",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Example prompt text"
        }
      }]
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  //await startClient(args, context);
}


