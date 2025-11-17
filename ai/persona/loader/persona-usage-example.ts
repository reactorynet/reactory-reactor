import { 
  personaLoader, 
  loadPersonaFromFile, 
  loadPersonaFromString, 
  loadPersonasFromDirectory,
  mergePersonaWithConfig,
  savePersonaToFile,
  validatePersonaConfig 
} from './persona-loader';

// Example 1: Load a persona from a YAML file
async function exampleLoadFromFile() {
  console.log('=== Example 1: Load Persona from File ===');
  
  try {
    const persona = loadPersonaFromFile('./persona-template.yaml');
    console.log('Loaded persona:', persona.name);
    console.log('Persona ID:', persona.id);
    console.log('Available tools:', persona.tools?.length || 0);
    console.log('Available resources:', persona.resources?.length || 0);
  } catch (error) {
    console.error('Error loading persona from file:', error);
  }
}

// Example 2: Load a persona from a YAML string
async function exampleLoadFromString() {
  console.log('\n=== Example 2: Load Persona from String ===');
  
  const yamlContent = `
id: "example-persona"
name: "Example Persona"
description: "An example persona loaded from string"
modelId: "gemini-2.5-pro"
providerId: "google"
defaultGreeting: "Hello, I am an example persona!"
persona: |
  # Example Persona
  This is an example persona loaded from a YAML string.
  
  ## Background
  I am a test persona created for demonstration purposes.
  
  ## Expertise
  - Example domain knowledge
  - Test scenarios
  - Demonstration capabilities

features: |
  # Your Capabilities and Guidelines
  
  You have access to tools that you can call via the tool interface.
  
  ## Example Domain Tool Usage Principles:
  1. **Always use tool results**: Present relevant information directly to the user
  2. **Be efficient**: Summarize key information and provide specific details when relevant
  3. **Be specific**: Extract and present data clearly from tool results
  4. **Handle errors gracefully**: Explain failures and suggest alternatives
  5. **Don't repeat requests**: Don't ask for information you already have

tools:
  includes:
    - readFile
    - writeFile
    - http
    - listDirectory

macros:
  includes:
    - NewRequestMacroDefinition
    - ListRequestsMacroDefinition

resources:
  - id: "example-resource"
    name: "Example Resource"
    description: "An example resource for demonstration"
    type: "text"
    url: "/example/resource.md"
    created: "2024-01-01T00:00:00.000Z"

metadata:
  version: "1.0.0"
  created: "2024-01-01T00:00:00.000Z"
  author: "Example"
  tags: ["example", "demo"]
  `;

  try {
    const persona = loadPersonaFromString(yamlContent);
    console.log('Loaded persona from string:', persona.name);
    console.log('Persona description:', persona.description);
    console.log('Default greeting:', persona.defaultGreeting);
  } catch (error) {
    console.error('Error loading persona from string:', error);
  }
}

// Example 3: Load multiple personas from a directory
async function exampleLoadFromDirectory() {
  console.log('\n=== Example 3: Load Personas from Directory ===');
  
  try {
    const personas = loadPersonasFromDirectory('./personas');
    console.log(`Loaded ${personas.length} personas from directory`);
    
    personas.forEach(persona => {
      console.log(`- ${persona.name} (${persona.id})`);
    });
  } catch (error) {
    console.error('Error loading personas from directory:', error);
  }
}

// Example 4: Create a persona from a YAML string
async function exampleCreateFromYaml() {
  console.log('\n=== Example 4: Create Persona from YAML ===');
  
  const yamlConfig = `
id: "new-persona"
name: "New Persona"
description: "A new persona created from YAML"
modelId: "gemini-2.5-pro"
providerId: "google"
defaultGreeting: "Hello, I am a new persona!"
persona: |
  # New Persona
  I am a new persona created from YAML configuration.
  
  ## Background
  Created for demonstration of YAML-based persona creation.
  
  ## Capabilities
  - YAML configuration support
  - Dynamic persona creation
  - Flexible tool integration

features: |
  # Your Capabilities and Guidelines
  
  You are a new persona created from YAML configuration.
  
  ## New Domain Tool Usage Principles:
  1. **Always use tool results**: Present relevant information directly to the user
  2. **Be efficient**: Summarize key information and provide specific details when relevant
  3. **Be specific**: Extract and present data clearly from tool results
  4. **Handle errors gracefully**: Explain failures and suggest alternatives
  5. **Don't repeat requests**: Don't ask for information you already have

tools:
  includes:
    - readFile
    - writeFile
    - http
    - listDirectory
    - shell

macros:
  includes:
    - NewRequestMacroDefinition
    - ListRequestsMacroDefinition
    - CatalogRequestsMacroDefinition

resources:
  - id: "new-resource"
    name: "New Resource"
    description: "A new resource for the new persona"
    type: "text"
    url: "/new/resource.md"
    created: "2024-01-01T00:00:00.000Z"

validation:
  required:
    - id
    - name
    - description
    - persona
    - features

metadata:
  version: "1.0.0"
  created: "2024-01-01T00:00:00.000Z"
  author: "System"
  tags: ["new", "yaml", "demo"]
  `;

  try {
    const persona = loadPersonaFromString(yamlConfig);
    console.log('Created new persona:', persona.name);
    console.log('Persona ID:', persona.id);
    console.log('Validation passed:', true);
  } catch (error) {
    console.error('Error creating persona from YAML:', error);
  }
}

// Example 5: Save a persona to YAML
async function exampleSaveToYaml() {
  console.log('\n=== Example 5: Save Persona to YAML ===');
  
  // Create a sample persona
  const samplePersona = {
    id: "sample-persona",
    name: "Sample Persona",
    description: "A sample persona for saving to YAML",
    persona: "# Sample Persona\n\nThis is a sample persona for demonstration.",
    features: "# Sample Features\n\nSample features for demonstration.",
    modelId: "gemini-2.5-pro",
    providerId: "google",
    defaultGreeting: "Hello, I am a sample persona!",
    config: {
      apiKey: "sample-key",
      apiBaseURL: "https://api.example.com"
    },
    tools: [] as any[],
    macros: [] as any[],
    resources: [] as any[],
    prompts: {}
  };

  try {
    savePersonaToFile(samplePersona, './sample-persona.yaml');
    console.log('Saved persona to sample-persona.yaml');
    
    // Verify by loading it back
    const loadedPersona = loadPersonaFromFile('./sample-persona.yaml');
    console.log('Verified loaded persona:', loadedPersona.name);
  } catch (error) {
    console.error('Error saving persona to YAML:', error);
  }
}

// Example 6: Advanced merging with custom configuration
async function exampleAdvancedMerging() {
  console.log('\n=== Example 6: Advanced Merging ===');
  
  // Create an existing persona
  const existingPersona = {
    id: "existing-persona",
    name: "Existing Persona",
    description: "An existing persona for merging",
    persona: "# Existing Persona\n\nThis is an existing persona.",
    features: "# Existing Features\n\nExisting features.",
    modelId: "gemini-2.5-pro",
    providerId: "google",
    defaultGreeting: "Hello, I am an existing persona!",
    config: {
      apiKey: "existing-key"
    },
    tools: [
      { name: "existingTool", function: { name: "existingTool" } }
    ],
    macros: [
      { name: "existingMacro" }
    ],
    resources: [
      {
        id: "existing-resource",
        name: "Existing Resource",
        description: "An existing resource",
        type: "text",
        url: "/existing/resource.md",
        created: new Date()
      }
    ],
    prompts: {}
  };

  // YAML config to merge
  const mergeConfig = `
name: "Updated Persona"
description: "Updated description for the persona"
defaultGreeting: "Hello, I am an updated persona!"

tools:
  includes:
    - newTool1
    - newTool2

macros:
  includes:
    - newMacro1
    - newMacro2

resources:
  - id: "new-resource"
    name: "New Resource"
    description: "A new resource to add"
    type: "text"
    url: "/new/resource.md"
    created: "2024-01-01T00:00:00.000Z"

merge:
  mode: "merge"
  options:
    overwriteExisting: false
    preserveExistingTools: true
    preserveExistingMacros: true
    preserveExistingResources: true
    updateMetadata: true
  `;

  try {
    const mergedPersona = mergePersonaWithConfig(existingPersona, mergeConfig);
    console.log('Merged persona name:', mergedPersona.name);
    console.log('Merged persona description:', mergedPersona.description);
    console.log('Original tools preserved:', mergedPersona.tools?.length || 0);
    console.log('Original resources preserved:', mergedPersona.resources?.length || 0);
  } catch (error) {
    console.error('Error merging persona:', error);
  }
}

// Example 7: Get role capabilities
async function exampleGetRoleCapabilities() {
  console.log('\n=== Example 7: Get Role Capabilities ===');
  
  const samplePersona = {
    id: "role-persona",
    name: "Role Persona",
    description: "A persona for testing role capabilities",
    persona: "# Role Persona",
    features: "# Role Features",
    modelId: "gemini-2.5-pro",
    providerId: "google",
    defaultGreeting: "Hello!",
    tools: [
      { name: "adminTool", function: { name: "adminTool" } },
      { name: "userTool", function: { name: "userTool" } }
    ],
    macros: [] as any[],
    resources: [
      {
        id: "admin-resource",
        name: "Admin Resource",
        description: "Admin-only resource",
        type: "text",
        url: "/admin/resource.md",
        created: new Date()
      }
    ],
    prompts: {}
  };

  try {
    const adminCapabilities = personaLoader.getRoleCapabilities(samplePersona, ['ADMIN']);
    const userCapabilities = personaLoader.getRoleCapabilities(samplePersona, ['USER']);
    
    console.log('Admin capabilities:', adminCapabilities);
    console.log('User capabilities:', userCapabilities);
  } catch (error) {
    console.error('Error getting role capabilities:', error);
  }
}

// Example 8: Validate configuration
async function exampleValidateConfiguration() {
  console.log('\n=== Example 8: Validate Configuration ===');
  
  const validConfig = {
    id: "valid-persona",
    name: "Valid Persona",
    description: "A valid persona configuration",
    persona: "# Valid Persona",
    features: "# Valid Features",
    modelId: "gemini-2.5-pro",
    providerId: "google",
    defaultGreeting: "Hello!",
    tools: { includes: ["readFile", "writeFile"] },
    macros: { includes: ["NewRequestMacroDefinition"] },
    resources: [] as any[],
    validation: {
      required: ["id", "name", "description"],
      types: {
        id: "string",
        name: "string",
        description: "string"
      }
    }
  };

  const invalidConfig = {
    // Missing required fields
    id: "", // Empty ID to trigger validation error
    name: "", // Empty name to trigger validation error
    description: "Invalid configuration"
  } as any;

  try {
    const validResult = validatePersonaConfig(validConfig);
    console.log('Valid config result:', validResult.isValid);
    console.log('Valid config errors:', validResult.errors);

    const invalidResult = validatePersonaConfig(invalidConfig);
    console.log('Invalid config result:', invalidResult.isValid);
    console.log('Invalid config errors:', invalidResult.errors);
  } catch (error) {
    console.error('Error validating configuration:', error);
  }
}

// Run all examples
async function runAllExamples() {
  console.log('Starting Persona Loader Examples...\n');
  
  await exampleLoadFromFile();
  await exampleLoadFromString();
  await exampleLoadFromDirectory();
  await exampleCreateFromYaml();
  await exampleSaveToYaml();
  await exampleAdvancedMerging();
  await exampleGetRoleCapabilities();
  await exampleValidateConfiguration();
  
  console.log('\n=== All Examples Completed ===');
}

// Export the examples for individual use
export {
  exampleLoadFromFile,
  exampleLoadFromString,
  exampleLoadFromDirectory,
  exampleCreateFromYaml,
  exampleSaveToYaml,
  exampleAdvancedMerging,
  exampleGetRoleCapabilities,
  exampleValidateConfiguration,
  runAllExamples
};

// Run examples if this file is executed directly
if (require.main === module) {
  runAllExamples().catch(console.error);
} 