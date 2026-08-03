import { AgentConversationStep, AgentConversationStepConfig } from './AgentConversationStep';
import {
  StepExecutionContext,
  StepExecutionResult,
  ValidationResult,
} from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import ReactorConversationModel from '@reactory/server-modules/reactory-reactor/models/ReactorChatState';
import { ReactorNodeModel } from '@reactory/server-modules/reactory-reactor/models/ReactorGraphNode';
import { ReactorNodeLinkModel } from '@reactory/server-modules/reactory-reactor/models/ReactorNodeLink';
import { nodeId, linkId } from '@reactory/server-modules/reactory-reactor/services/graph/GraphIdentity';

export interface ProcessConversationStepConfig extends AgentConversationStepConfig {
  conversationId: string;
}

export class ProcessConversationStep extends AgentConversationStep {
  public readonly stepType = 'process_conversation';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as ProcessConversationStepConfig;
    const conversationId = this.resolveTemplate(config.conversationId, context);

    if (!conversationId) {
      return {
        success: false,
        error: 'No conversationId provided to process',
        outputs: {},
        metadata: {},
      };
    }

    try {
      context.logger.info(`Starting conversation graphing for "${conversationId}" wrapping AgentConversationStep`);

      // 1. Fetch conversation from Mongo
      const conversation = await ReactorConversationModel.findById(conversationId).lean();
      if (!conversation) {
        return {
          success: false,
          error: `Conversation not found with ID ${conversationId}`,
          outputs: {},
          metadata: { conversationId },
        };
      }

      const history = conversation.history || [];
      if (history.length === 0) {
        context.logger.info(`Conversation "${conversationId}" has no history — skipping graphing`);
        return {
          success: true,
          outputs: { message: 'No history to process' },
          metadata: { conversationId },
        };
      }

      // Convert history to plain text summary
      const textToAnalyze = history
        .filter((h: any) => h.role === 'user' || h.role === 'assistant')
        .slice(-10) // analyze the last 10 messages for context
        .map((h: any) => `${h.role === 'user' ? 'User' : 'AI'}: ${h.content}`)
        .join('\n\n');

      const prompt = `You are a meticulous systems analyst. Your job is to extract a knowledge graph from this recent chat conversation history.
Identify key topics, directories, files, systems, and projects discussed.

CONVERSATION HISTORY:
${textToAnalyze}

Ensure edge source and target match exactly the name of one of the nodes (or the conversation itself).
The conversation node name is: "Conversation: ${conversation.title || 'Active Chat'}"`;

      // 2. Wrap AgentConversationStep by dynamically setting its config & calling super.executeStep
      // Define a strict JSON schema for structured output to ensure we get a valid graph back
      const structuredSchema = {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["TOPIC", "FILE", "FOLDER", "PROJECT", "SYSTEM"] },
                description: { type: "string" }
              },
              required: ["name", "type"]
            }
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                target: { type: "string" },
                type: { type: "string" },
                title: { type: "string" }
              },
              required: ["source", "target", "type"]
            }
          }
        },
        required: ["nodes", "edges"]
      };

      // Set the config for the parent AgentConversationStep
      this.config = {
        personaId: config.personaId || 'reactor',
        message: prompt,
        instructions: 'You extract structured knowledge graphs in valid JSON.',
        toolApprovalMode: 'auto',
        providerConfig: {
          structuredOutput: {
            schema: structuredSchema
          }
        }
      };

      // Execute the parent step to get the structured response
      const agentResult = await super.executeStep(context);

      if (!agentResult.success) {
        return agentResult;
      }

      const extracted = agentResult.outputs.structuredContent || {};
      const nodes = extracted.nodes || [];
      const edges = extracted.edges || [];

      context.logger.info(`Extracted ${nodes.length} nodes and ${edges.length} edges from conversation via AgentConversationStep`);

      // 3. Register Conversation root node
      const convNodeId = nodeId(`conversation::${conversationId}`);
      const convNodeName = `Conversation: ${conversation.title || 'Active Chat'}`;
      
      await ReactorNodeModel.findOneAndUpdate(
        { id: convNodeId },
        {
          $set: {
            id: convNodeId,
            index: convNodeId,
            key: `${convNodeId}`,
            name: convNodeName,
            type: 'CONVERSATION',
            nameSpace: 'reactor-conversations',
            description: `Active chat session: ${conversation.title || 'No Title'}`,
            updated: new Date(),
          },
          $setOnInsert: {
            created: new Date(),
          }
        },
        { upsert: true }
      );

      // 4. Register all extracted nodes
      const nodeNameMap = new Map<string, number>();
      nodeNameMap.set(convNodeName, convNodeId);

      for (const node of nodes) {
        const cleanName = node.name.trim();
        const logicalKey = `conversation::${conversationId}::${node.type}::${cleanName}`;
        const nId = nodeId(logicalKey);
        nodeNameMap.set(cleanName, nId);

        await ReactorNodeModel.findOneAndUpdate(
          { id: nId },
          {
            $set: {
              id: nId,
              index: nId,
              key: `${nId}`,
              name: cleanName,
              type: node.type,
              nameSpace: 'reactor-conversations',
              description: node.description || '',
              updated: new Date(),
            },
            $setOnInsert: {
              created: new Date(),
            }
          },
          { upsert: true }
        );

        // Auto-link each extracted node to the main conversation node
        const autoLinkId = linkId(convNodeId, nId, 'CONTAINS');
        await ReactorNodeLinkModel.findOneAndUpdate(
          { id: autoLinkId },
          {
            $set: {
              id: autoLinkId,
              source: convNodeId,
              target: nId,
              type: 'CONTAINS',
              types: ['CONTAINS'],
              title: 'Contains',
              updated: new Date(),
            },
            $setOnInsert: {
              created: new Date(),
            }
          },
          { upsert: true }
        );
      }

      // 5. Register all custom extracted edges
      for (const edge of edges) {
        const sourceId = nodeNameMap.get(edge.source.trim());
        const targetId = nodeNameMap.get(edge.target.trim());
        const edgeType = edge.type || 'DIRECT';

        if (sourceId !== undefined && targetId !== undefined) {
          const eId = linkId(sourceId, targetId, edgeType);
          await ReactorNodeLinkModel.findOneAndUpdate(
            { id: eId },
            {
              $set: {
                id: eId,
                source: sourceId,
                target: targetId,
                type: edgeType,
                types: [edgeType],
                title: edge.title || '',
                updated: new Date(),
              },
              $setOnInsert: {
                created: new Date(),
              }
            },
            { upsert: true }
          );
        }
      }

      context.logger.info(`Successfully completed conversation graphing for "${conversationId}"`);

      // Restore original config
      this.config = config;

      return {
        success: true,
        outputs: {
          conversationNodeId: convNodeId,
          nodesCreated: nodes.length,
          edgesCreated: edges.length,
        },
        metadata: { conversationId },
      };
    } catch (err) {
      // Restore original config
      this.config = config;
      const msg = err instanceof Error ? err.message : String(err);
      context.logger.error(`Failed to process conversation graph: ${msg}`);
      return {
        success: false,
        error: msg,
        outputs: {},
        metadata: { conversationId },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    if (!config.conversationId) {
      errors.push('conversationId is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export default ProcessConversationStep;
