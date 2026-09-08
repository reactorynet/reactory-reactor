import Reactory from '@reactorynet/reactory-core';
import { IWorkflowStepDesignerDefinition } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/types/StepDesignerDefinition';
import { PlaywrightSessionStep } from './PlaywrightSessionStep';
import { PlaywrightNavigateStep } from './PlaywrightNavigateStep';
import { PlaywrightActionStep } from './PlaywrightActionStep';
import { PlaywrightEvaluateStep } from './PlaywrightEvaluateStep';
import { PlaywrightInspectStep } from './PlaywrightInspectStep';
import { PlaywrightScreenshotStep } from './PlaywrightScreenshotStep';
import { PlaywrightStep } from './PlaywrightStep';

export {
  BasePlaywrightStep,
  PlaywrightScreenshotConfig,
  ScreenshotArtifact,
  PlaywrightBaseStepConfig,
} from './BasePlaywrightStep';

export { PlaywrightSessionStep, PlaywrightNavigateStep, PlaywrightActionStep, PlaywrightEvaluateStep, PlaywrightInspectStep, PlaywrightScreenshotStep, PlaywrightStep };

interface ReactorStepProvider extends Reactory.Workflow.IWorkflowStepProvider {
  definition?: IWorkflowStepDesignerDefinition;
}

// ── Designer Definitions for Visual Workflow Designer ─────────────────────

export const playwrightSessionDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright_session',
  name: 'Playwright Session',
  category: 'integration',
  description: 'Manage headless Playwright browser session lifecycle (open, close, list)',
  icon: 'language',
  color: '#2e7d32',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'sessionId', type: 'output', dataType: 'string', description: 'Created browser session ID' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      action: { type: 'string', title: 'Action', enum: ['open', 'close', 'list'], default: 'open' },
      sessionId: { type: 'string', title: 'Session ID', description: 'Target session ID (for close)' },
      headless: { type: 'boolean', title: 'Headless Mode', default: true },
      viewport: { type: 'string', title: 'Viewport (WxH)', default: '1280x720' },
      timeout: { type: 'number', title: 'Timeout (ms)', default: 30000 },
    },
    required: ['action'],
  },
  defaultProperties: { action: 'open', headless: true, viewport: '1280x720', timeout: 30000 },
  tags: ['playwright', 'browser', 'automation', 'session'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'PS',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0x2e7d32, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 4 },
        dimensions: { width: 130, height: 80 },
      },
    },
  },
};

export const playwrightNavigateDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright_navigate',
  name: 'Playwright Navigate',
  category: 'integration',
  description: 'Navigate the browser to a URL with wait conditions and automatic screenshot capture',
  icon: 'open_in_browser',
  color: '#1565c0',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'title', type: 'output', dataType: 'string', description: 'Page Title' },
    { name: 'url', type: 'output', dataType: 'string', description: 'Final URL' },
    { name: 'status', type: 'output', dataType: 'number', description: 'HTTP Status code' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      url: { type: 'string', title: 'URL', description: 'Target URL to navigate to (supports ${variable})' },
      waitUntil: {
        type: 'string',
        title: 'Wait Until',
        enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
        default: 'load',
      },
      screenshot: { type: 'boolean', title: 'Take Screenshot', default: false },
      sessionId: { type: 'string', title: 'Session ID', description: 'Optional session ID' },
    },
    required: ['url'],
  },
  defaultProperties: { waitUntil: 'load', screenshot: false },
  tags: ['playwright', 'browser', 'navigate', 'url'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'NAV',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0x1565c0, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 4 },
        dimensions: { width: 130, height: 80 },
      },
    },
  },
};

export const playwrightActionDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright_action',
  name: 'Playwright Action',
  category: 'integration',
  description: 'Interact with DOM elements (click, type, fill, select, press key) with selector auto-wait',
  icon: 'mouse',
  color: '#e65100',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'success', type: 'output', dataType: 'boolean', description: 'Action success status' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        title: 'Action Type',
        enum: ['click', 'type', 'fill', 'select', 'press_key'],
        default: 'click',
      },
      selector: { type: 'string', title: 'CSS / Playwright Selector', description: 'Target element selector' },
      text: { type: 'string', title: 'Text to Type' },
      key: { type: 'string', title: 'Key to Press' },
      screenshot: { type: 'boolean', title: 'Take Screenshot', default: false },
      sessionId: { type: 'string', title: 'Session ID' },
    },
    required: ['action'],
  },
  defaultProperties: { action: 'click', screenshot: false },
  tags: ['playwright', 'browser', 'click', 'type', 'action'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'ACT',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0xe65100, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 4 },
        dimensions: { width: 130, height: 80 },
      },
    },
  },
};

export const playwrightEvaluateDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright_evaluate',
  name: 'Playwright Evaluate',
  category: 'integration',
  description: 'Evaluate JavaScript in browser page context with optional selector scoping',
  icon: 'code',
  color: '#6a1b9a',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'result', type: 'output', dataType: 'any', description: 'Serialized evaluation result' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      script: { type: 'string', title: 'JavaScript Script / Function', description: 'JavaScript code to evaluate' },
      selector: { type: 'string', title: 'Scoped Selector', description: 'Optional element selector to evaluate on' },
      sessionId: { type: 'string', title: 'Session ID' },
    },
    required: ['script'],
  },
  defaultProperties: { script: 'document.title' },
  tags: ['playwright', 'browser', 'evaluate', 'javascript'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'EVAL',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0x6a1b9a, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 4 },
        dimensions: { width: 130, height: 80 },
      },
    },
  },
};

export const playwrightInspectDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright_inspect',
  name: 'Playwright Inspect',
  category: 'integration',
  description: 'Inspect DOM element properties, text, and attributes with assertion checks',
  icon: 'visibility',
  color: '#00838f',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'text', type: 'output', dataType: 'string', description: 'Extracted inner text' },
    { name: 'visible', type: 'output', dataType: 'boolean', description: 'Element visibility' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', title: 'Selector', description: 'Target element selector to inspect' },
      state: { type: 'string', title: 'Expected State', enum: ['visible', 'hidden', 'attached', 'detached'], default: 'visible' },
      expectedText: { type: 'string', title: 'Expected Substring' },
      sessionId: { type: 'string', title: 'Session ID' },
    },
    required: ['selector'],
  },
  defaultProperties: { state: 'visible' },
  tags: ['playwright', 'browser', 'inspect', 'assert'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'INSP',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0x00838f, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 4 },
        dimensions: { width: 130, height: 80 },
      },
    },
  },
};

export const playwrightScreenshotDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright_screenshot',
  name: 'Playwright Screenshot',
  category: 'integration',
  description: 'Capture screenshot to workflow session artifacts with safe CDN URL generation',
  icon: 'photo_camera',
  color: '#c2185b',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'url', type: 'output', dataType: 'string', description: 'Safe CDN URL of the captured screenshot' },
    { name: 'path', type: 'output', dataType: 'string', description: 'File system path' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Image Name', default: 'screenshot' },
      fullPage: { type: 'boolean', title: 'Full Page', default: true },
      type: { type: 'string', title: 'Format', enum: ['png', 'jpeg'], default: 'png' },
      sessionId: { type: 'string', title: 'Session ID' },
    },
  },
  defaultProperties: { name: 'screenshot', fullPage: true, type: 'png' },
  tags: ['playwright', 'browser', 'screenshot', 'capture'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'SHOT',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0xc2185b, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 4 },
        dimensions: { width: 130, height: 80 },
      },
    },
  },
};

export const playwrightUnifiedDesigner: IWorkflowStepDesignerDefinition = {
  id: 'playwright',
  name: 'Playwright Web Automation',
  category: 'integration',
  description: 'Multi-action Playwright automation step for browser navigation, interaction, and validation',
  icon: 'language',
  color: '#00796b',
  inputPorts: [
    { name: 'previous', type: 'control_input', dataType: 'any', description: 'Previous step in workflow' },
  ],
  outputPorts: [
    { name: 'next', type: 'control_output', dataType: 'any', description: 'Next step in workflow' },
    { name: 'sessionId', type: 'output', dataType: 'string', description: 'Browser session ID' },
  ],
  propertySchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        title: 'Operation',
        enum: ['navigate', 'click', 'type', 'select', 'press_key', 'evaluate', 'inspect', 'screenshot', 'open', 'close'],
        default: 'navigate',
      },
      url: { type: 'string', title: 'URL' },
      selector: { type: 'string', title: 'Selector' },
      text: { type: 'string', title: 'Text to Type' },
      script: { type: 'string', title: 'Evaluation Script' },
      screenshot: { type: 'boolean', title: 'Take Screenshot', default: false },
    },
  },
  defaultProperties: { operation: 'navigate', screenshot: false },
  tags: ['playwright', 'browser', 'automation'],
  rendering: {
    webgl: {
      type: 'webgl',
      theme: 'circuit',
      circuit: {
        elementType: 'icChip',
        labelPrefix: 'PW',
        colors: { body: 0x1a1a1a, bodyHover: 0x2a2a2a, bodySelected: 0x00796b, pins: 0x808080, pinsConnected: 0xb87333 },
        features: { hasNotch: true, pinCount: 6 },
        dimensions: { width: 140, height: 90 },
      },
    },
  },
};

/**
 * Playwright workflow step providers array.
 */
export const playwrightWorkflowStepProviders: ReactorStepProvider[] = [
  {
    stepType: 'playwright_session',
    constructor: PlaywrightSessionStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Manage headless Playwright browser session lifecycle (open, close, list)',
      version: '1.0.0',
    },
    definition: playwrightSessionDesigner,
  },
  {
    stepType: 'playwright_navigate',
    constructor: PlaywrightNavigateStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Navigate the browser to a URL with wait conditions and automatic screenshot capture',
      version: '1.0.0',
    },
    definition: playwrightNavigateDesigner,
  },
  {
    stepType: 'playwright_action',
    constructor: PlaywrightActionStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Interact with DOM elements (click, type, fill, select, press key) with selector auto-wait',
      version: '1.0.0',
    },
    definition: playwrightActionDesigner,
  },
  {
    stepType: 'playwright_evaluate',
    constructor: PlaywrightEvaluateStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Evaluate JavaScript in browser page context with optional selector scoping',
      version: '1.0.0',
    },
    definition: playwrightEvaluateDesigner,
  },
  {
    stepType: 'playwright_inspect',
    constructor: PlaywrightInspectStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Inspect DOM element properties, text, and attributes with assertion checks',
      version: '1.0.0',
    },
    definition: playwrightInspectDesigner,
  },
  {
    stepType: 'playwright_screenshot',
    constructor: PlaywrightScreenshotStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Capture screenshot to workflow session artifacts with safe CDN URL generation',
      version: '1.0.0',
    },
    definition: playwrightScreenshotDesigner,
  },
  {
    stepType: 'playwright',
    constructor: PlaywrightStep as unknown as Reactory.Workflow.IStepConstructor,
    options: {
      description: 'Unified multi-action Playwright automation step for browser interaction and validation',
      version: '1.0.0',
    },
    definition: playwrightUnifiedDesigner,
  },
];

export default playwrightWorkflowStepProviders;
