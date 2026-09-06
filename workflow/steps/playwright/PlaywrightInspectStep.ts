import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig, ScreenshotArtifact } from './BasePlaywrightStep';

export interface PlaywrightInspectStepConfig extends PlaywrightBaseStepConfig {
  selector: string;
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  timeout?: number;
  getContent?: boolean;
  expectedText?: string;
  expectedVisible?: boolean;
}

/**
 * PlaywrightInspectStep - Inspects DOM elements, extracts attributes/text/HTML, and evaluates selector assertions.
 * 
 * Step Type: 'playwright_inspect'
 * Features:
 * - Waits for elements to reach a desired DOM state ('visible', 'attached', etc.).
 * - Extracts tag name, attributes, visibility, bounding box, child count, and text.
 * - Optional inline assertion for text matching or visibility.
 * - Captures optional screenshot with highlight for debugging.
 */
export class PlaywrightInspectStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright_inspect';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightInspectStepConfig;
    const service = this.getPlaywrightService(context);

    if (!service) {
      return {
        success: false,
        error: 'ReactorPlaywrightService is not available in the execution context.',
        outputs: {},
        metadata: {},
      };
    }

    const selector = this.cleanOptional(config.selector, context);
    if (!selector) {
      return {
        success: false,
        error: `Step "${this.id}" requires a valid 'selector'.`,
        outputs: {},
        metadata: {},
      };
    }

    const sessionId = await this.resolveSessionId(config, context, service, true);
    const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);
    const state = (this.cleanOptional(config.state, context) as any) || 'visible';
    const timeout = typeof config.timeout === 'number' ? config.timeout : undefined;

    try {
      context.logger.info(`[${this.id}] Inspecting element "${selector}" in Playwright session [${sessionId}] (state: ${state})`);

      // 1. Wait for selector state
      const waitResult = await service.waitForSelector(sessionId, {
        selector,
        state,
        timeout: timeout || 15000,
      });

      if (!waitResult.found) {
        throw new Error(`Element matching "${selector}" did not reach state "${state}" within timeout.`);
      }

      // 2. Inspect element
      const inspectResult = await service.inspectElement(sessionId, selector);

      // 3. Optional assertions
      const expectedText = this.cleanOptional(config.expectedText, context);
      if (expectedText !== undefined) {
        const textMatched = inspectResult.text.includes(expectedText);
        if (!textMatched) {
          throw new Error(`Assertion failed: expected element "${selector}" to contain text "${expectedText}", but got "${inspectResult.text}".`);
        }
      }

      if (config.expectedVisible !== undefined && inspectResult.visible !== config.expectedVisible) {
        throw new Error(`Assertion failed: expected element "${selector}" visibility to be ${config.expectedVisible}, but got ${inspectResult.visible}.`);
      }

      let screenshot: ScreenshotArtifact | undefined;
      if (config.screenshot) {
        screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, config.screenshot, `${this.id}_inspect`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'inspect',
        selector,
        found: true,
        visible: inspectResult.visible,
        tagName: inspectResult.tagName,
        textPreview: inspectResult.text.substring(0, 100),
        screenshot: screenshot?.url || screenshot?.path,
      });

      return {
        success: true,
        outputs: {
          sessionId,
          selector,
          found: true,
          visible: inspectResult.visible,
          tagName: inspectResult.tagName,
          text: inspectResult.text,
          html: this.sanitizeOutput(inspectResult.html, 4000),
          attributes: inspectResult.attributes,
          childCount: inspectResult.childCount,
          boundingBox: inspectResult.boundingBox,
          ...(screenshot ? { screenshot } : {}),
        },
        metadata: {
          sessionId,
          selector,
          visible: inspectResult.visible,
          tagName: inspectResult.tagName,
          hasScreenshot: !!screenshot,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logger.error(`[${this.id}] playwright_inspect failed: ${message}`);

      let failureScreenshot: ScreenshotArtifact | undefined;
      if (config.screenshotOnFailure !== false) {
        failureScreenshot = await this.captureScreenshot(sessionId, service, artifactsDir, true, `${this.id}_inspect_failure`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'inspect_failed',
        selector,
        error: message,
        screenshot: failureScreenshot?.url || failureScreenshot?.path,
      });

      return {
        success: false,
        error: message,
        outputs: {
          sessionId,
          selector,
          found: false,
          ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
        },
        metadata: { sessionId, selector, failed: true },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    if (!config.selector || typeof config.selector !== 'string') {
      errors.push("selector is required and must be a string");
    }
    const validStates = ['visible', 'hidden', 'attached', 'detached'];
    if (config.state && !validStates.includes(config.state)) {
      errors.push(`state must be one of: ${validStates.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightInspectStep;
