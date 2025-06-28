import { promises as fs, existsSync } from 'fs';
import pathModule from 'path';
import { CreateModuleStructureProps } from '../types';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import logger from '@reactory/server-core/logging';

interface ContentGeneratorMap {
  pattern: RegExp;
  generatorId: string;
}

export const CreateModuleStructure: Macro<string, CreateModuleStructureProps> = async (
  props: CreateModuleStructureProps,
  state: ChatState
): Promise<string> => {
  const { fileStructure, contentGenerators = [] } = props;
  if (!Array.isArray(fileStructure)) {
    return 'First argument must be an array of file paths';
  }
  let generatorMaps: ContentGeneratorMap[] = [];
  if (contentGenerators) {
    try {
      if (typeof contentGenerators === 'string') {
        generatorMaps = JSON.parse(contentGenerators);
      } else if (Array.isArray(contentGenerators)) {
        generatorMaps = contentGenerators.map(gen => ({
          pattern: new RegExp(gen.pattern),
          generatorId: gen.generatorId
        }));
      }
    } catch (err) {
      logger.error('Error parsing content generators:', err);
      return 'Error parsing content generators';
    }
  }
  const results: string[] = [];
  for (const path of fileStructure) {
    try {
      const dirPath = pathModule.dirname(path);
      if (!existsSync(dirPath)) {
        await fs.mkdir(dirPath, { recursive: true });
        results.push(`✅ Created directory: ${dirPath}`);
      }
      let content = '';
      let contentGenerated = false;
      for (const generator of generatorMaps) {
        if (generator.pattern.test(path)) {
          try {
            const generatorFunc = state.context.getService<any>(generator.generatorId);
            if (generatorFunc && typeof generatorFunc.generate === 'function') {
              content = await generatorFunc.generate(path);
              contentGenerated = true;
              break;
            }
          } catch (err) {
            logger.error(`Error calling content generator for ${path}:`, err);
            results.push(`❌ Error generating content for ${path}: ${err.message}`);
          }
        }
      }
      await fs.writeFile(path, content, 'utf-8');
      results.push(`✅ Created file: ${path}${contentGenerated ? ' with generated content' : ''}`);
    } catch (err) {
      logger.error(`Error creating file/directory at ${path}:`, err);
      results.push(`❌ Error: ${err.message}`);
    }
  }
  return results.join('\n');
};

export const CreateModuleStructureComponentRegister: MacroComponentDefinition<typeof CreateModuleStructure> = {
  component: CreateModuleStructure,
  name: 'createModuleStructure',
  nameSpace: 'reactor-macros',
  version: '1.0.0',
  description: '', // Should import readme if needed
  features: [],
  stem: 'module',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['macro', 'module', 'structure', 'create', 'generator'],
  tools: [{
    type: "function",
    function: {
      name: "createModuleStructure",
      description: "Creates a new module file structure with optional content generation",
      parameters: {
        type: "object",
        properties: {
          fileStructure: {
            type: "array",
            description: "Array of file paths to create",
            items: {
              type: "string"
            }
          },
          contentGenerators: {
            type: "array",
            description: "Optional array of objects mapping regex patterns to generator function IDs",
            items: {
              type: "object",
              properties: {
                pattern: {
                  type: "string",
                  description: "Regex pattern to match file paths"
                },
                generatorId: {
                  type: "string", 
                  description: "Generator function ID"
                }
              }
            }
          }
        },
        required: ["fileStructure"]
      }
    }
  }]
};
