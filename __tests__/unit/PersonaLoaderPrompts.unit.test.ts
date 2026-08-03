import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import PersonaLoaderService from '../../ai/persona/loader/persona-loader';
import {
  buildSystemPrompt,
  resolvePromptDirectives,
  hasUnresolvedPromptDirectives,
} from '../../ai/persona/loader/system-prompt';

// ── Test context ────────────────────────────────────────────────────────────

const mockContext: any = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  colors: { green: (s: string) => s },
};

const mockMacroService: any = {
  listAllMacros: () => [
    {
      name: 'FileSystemMacro',
      tools: [
        {
          type: 'function',
          function: { name: 'readFile', description: 'Reads a file from disk' },
        },
        {
          type: 'function',
          function: { name: 'writeFile', description: 'Writes a file to disk' },
        },
      ],
    },
  ],
};

const createLoader = (): PersonaLoaderService => {
  const loader = new PersonaLoaderService({} as any, mockContext);
  loader.setMacroService(mockMacroService);
  loader.populateRegistries();
  return loader;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

let workDir: string;

const AGENT_YAML = `
id: "TestAgent"
name: "Test Agent"
description: "A persona used to exercise the loader"
persona: |
  # Test Agent
  You are the Test Agent. Today is \${date}.
  Your access level: \${roleSpecificCapabilities}
features: |
  ## Tools
  \${toolDescriptions}

  ## Resources
  \${resourceDescription}
tools:
  includes:
    - readFile
    - writeFile
resources:
  - id: "docs"
    name: "Docs Folder"
    description: "Project documentation"
    type: "directory"
    url: "/tmp/docs"
    created: "2026-01-01T00:00:00.000Z"
roleCapabilities:
  USER: "You have standard test access."
prompts:
  system:
    content: "\${buildSystemPrompt()}"
    role: "system"
  reviewPrompt:
    content: |
      Review the following area: \${reviewArea}
    role: "user"
`;

const FILE_AGENT_YAML = `
id: "FileAgent"
name: "File Agent"
description: "A persona whose prompts are assembled from files"
persona: |
  # File Agent
features: |
  ## Capabilities
tools:
  includes:
    - readFile
prompts:
  system:
    files:
      - "prompts/00-identity.md"
      - "prompts/10-rules.md"
      - "prompts/99-missing.md"
    content: "Trailing inline note."
    role: "system"
  directivePrompt:
    files:
      - "prompts/20-directive.md"
    role: "system"
  separatorPrompt:
    files:
      - "prompts/00-identity.md"
      - "prompts/10-rules.md"
    separator: "\\n---\\n"
    role: "system"
`;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-loader-'));
  fs.mkdirSync(path.join(workDir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'agent.yaml'), AGENT_YAML, 'utf8');
  fs.writeFileSync(path.join(workDir, 'file.agent.yaml'), FILE_AGENT_YAML, 'utf8');
  fs.writeFileSync(path.join(workDir, 'prompts', '00-identity.md'), '# Identity\nI am the File Agent.', 'utf8');
  fs.writeFileSync(path.join(workDir, 'prompts', '10-rules.md'), '# Rules\nAlways be precise.', 'utf8');
  fs.writeFileSync(path.join(workDir, 'prompts', '20-directive.md'), 'Preamble.\n\n${buildSystemPrompt()}', 'utf8');
});

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('system-prompt helpers', () => {
  it('assembles persona + features and interpolates the standard variables', () => {
    const prompt = buildSystemPrompt({
      persona: 'I am ${userRole}.',
      features: 'Tools:\n${toolDescriptions}',
      tools: [{ type: 'function', function: { name: 'readFile', description: 'Reads a file' } }],
      userRoles: ['ADMIN'],
    });

    expect(prompt).toContain('I am ADMIN.');
    expect(prompt).toContain('- **readFile**: Reads a file');
  });

  it('leaves literal ${...} workflow syntax intact rather than throwing', () => {
    const prompt = buildSystemPrompt({
      persona: 'Use ${env.SOME_VAR} in your workflow steps.',
      features: '',
    });

    expect(prompt).toContain('${env.SOME_VAR}');
  });

  it('only resolves known directives', () => {
    const content = 'A ${buildSystemPrompt()} B ${someUnknownThing()} C';
    const resolved = resolvePromptDirectives(content, { persona: 'PERSONA', features: 'FEATURES' });

    expect(resolved).toContain('PERSONA');
    expect(resolved).toContain('FEATURES');
    expect(resolved).toContain('${someUnknownThing()}');
    expect(hasUnresolvedPromptDirectives(resolved)).toBe(false);
  });

  it('detects unresolved directives', () => {
    expect(hasUnresolvedPromptDirectives('${buildSystemPrompt()}')).toBe(true);
    expect(hasUnresolvedPromptDirectives('${buildSystemContent()}')).toBe(true);
    expect(hasUnresolvedPromptDirectives('nothing to see here')).toBe(false);
  });
});

describe('PersonaLoaderService prompt resolution', () => {
  it('materialises ${buildSystemPrompt()} at load time', () => {
    const persona = createLoader().loadFromFile(path.join(workDir, 'agent.yaml'));

    const system = persona.prompts?.system?.content || '';
    expect(system).not.toContain('${buildSystemPrompt()}');
    expect(system).toContain('You are the Test Agent.');
    expect(system).toContain('You have standard test access.');
    expect(system).toContain('- **readFile**: Reads a file from disk');
    expect(system).toContain('- **writeFile**: Writes a file to disk');
    expect(system).toContain('- **Docs Folder**: Project documentation - /tmp/docs');
  });

  it('leaves canned prompt variables for the chat session to interpolate', () => {
    const persona = createLoader().loadFromFile(path.join(workDir, 'agent.yaml'));

    expect(persona.prompts?.reviewPrompt?.content).toContain('${reviewArea}');
  });

  it('assembles prompt content from files, in sequence, relative to the agent.yaml', () => {
    const persona = createLoader().loadFromFile(path.join(workDir, 'file.agent.yaml'));

    const system = persona.prompts?.system?.content || '';
    expect(system.indexOf('I am the File Agent.')).toBeGreaterThanOrEqual(0);
    expect(system.indexOf('Always be precise.')).toBeGreaterThan(system.indexOf('I am the File Agent.'));
    // inline content is appended after the assembled files
    expect(system.indexOf('Trailing inline note.')).toBeGreaterThan(system.indexOf('Always be precise.'));
    // a missing include is logged and skipped, not fatal
    expect(mockContext.error).toHaveBeenCalled();
  });

  it('honours a custom separator', () => {
    const persona = createLoader().loadFromFile(path.join(workDir, 'file.agent.yaml'));

    expect(persona.prompts?.separatorPrompt?.content).toContain('\n---\n');
  });

  it('resolves directives found inside assembled files', () => {
    const persona = createLoader().loadFromFile(path.join(workDir, 'file.agent.yaml'));

    const content = persona.prompts?.directivePrompt?.content || '';
    expect(content).toContain('Preamble.');
    expect(content).toContain('# File Agent');
    expect(content).toContain('## Capabilities');
    expect(content).not.toContain('${buildSystemPrompt()}');
  });
});
