import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig, ScreenshotArtifact } from './BasePlaywrightStep';

export type PlaywrightActionType = 'click' | 'type' | 'fill' | 'select' | 'press_key';

export interface PlaywrightActionStepConfig extends PlaywrightBaseStepConfig {
  action: PlaywrightActionType;
  selector?: string;
  text?: string;
  clear?: boolean | string;
  delay?: number;
  values?: string[] | string;
  key?: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  waitForSelector?: boolean;
}

/**
 * PlaywrightActionStep - Executes user interactions (click, type, select, pressKey) on DOM elements.
 * 
 * Step Type: 'playwright_action'
 * Features:
 * - Supports rich CSS / Playwright selectors (e.g. `text=Submit`, `button:has-text("Save")`, `[data-testid="login"]`).
 * - Automatically ensures target element is present/visible prior to interaction.
 * - Records action, timing, and screenshot into session artifacts.
 */
export class PlaywrightActionStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright_action';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightActionStepConfig;
    const service = this.getPlaywrightService(context);

    if (!service) {
      return {
        success: false,
        error: 'ReactorPlaywrightService is not available in the execution context.',
        outputs: {},
        metadata: {},
      };
    }

    const action = (this.cleanOptional(config.action, context) || 'click').toLowerCase() as PlaywrightActionType;
    const selector = this.cleanOptional(config.selector, context);
    const timeout = typeof config.timeout === 'number' ? config.timeout : undefined;

    const sessionId = await this.resolveSessionId(config, context, service, true);
    const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);

    try {
      // Auto-wait for selector when applicable
      if (selector && config.waitForSelector !== false) {
        context.logger.debug(`[${this.id}] Waiting for selector "${selector}" to be visible`);
        const waitRes = await service.waitForSelector(sessionId, {
          selector,
          state: 'visible',
          timeout: timeout || 15000,
        });
        if (!waitRes.found) {
          throw new Error(`Selector "${selector}" was not visible within timeout.`);
        }
      }

      let actionDetails: Record<string, any> = { action, selector };

      switch (action) {
        case 'click': {
          if (!selector) throw new Error(`Action 'click' requires a 'selector'.`);
          const button = (this.cleanOptional(config.button, context) as any) || 'left';
          const clickCount = config.clickCount ? Number(config.clickCount) : 1;
          await service.click(sessionId, { selector, button, clickCount, timeout });
          actionDetails = { ...actionDetails, button, clickCount };
          break;
        }

        case 'type':
        case 'fill': {
          if (!selector) throw new Error(`Action '${action}' requires a 'selector'.`);
          const rawText = this.cleanOptional(config.text, context) ?? '';
          const clear = config.clear === true || config.clear === 'true' || action === 'fill';
          const delay = config.delay ? Number(config.delay) : 0;
          await service.type(sessionId, { selector, text: rawText, clear, delay });
          actionDetails = { ...actionDetails, textLength: rawText.length, clear };
          break;
        }

        case 'select': {
          if (!selector) throw new Error(`Action 'select' requires a 'selector'.`);
          let values: string[] = [];
          if (Array.isArray(config.values)) {
            values = config.values.map(v => this.cleanOptional(v, context) || String(v));
          } else if (typeof config.values === 'string') {
            values = config.values.split(',').map(s => s.trim());
          }
          const selResult = await service.select(sessionId, selector, values);
          actionDetails = { ...actionDetails, selectedValues: selResult.selectedValues };
          break;
        }

        case 'press_key': {
          const key = this.cleanOptional(config.key, context);
          if (!key) throw new Error(`Action 'press_key' requires a 'key' (e.g. 'Enter', 'Tab').`);
          await service.pressKey(sessionId, key);
          actionDetails = { ...actionDetails, key };
          break;
        }

        default:
          throw new Error(`Unsupported playwright_action '${action}'`);
      }

      let screenshot: ScreenshotArtifact | undefined;
      if (config.screenshot) {
        screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, config.screenshot, `${this.id}_${action}`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: `action_${action}`,
        ...actionDetails,
        screenshot: screenshot?.url || screenshot?.path,
      });

      return {
        success: true,
        outputs: {
          sessionId,
          action,
          selector,
          success: true,
          ...actionDetails,
          ...(screenshot ? { screenshot } : {}),
        },
        metadata: { sessionId, action, selector, hasScreenshot: !!screenshot },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logger.error(`[${this.id}] playwright_action (${action}) failed: ${message}`);

      let failureScreenshot: ScreenshotArtifact | undefined;
      if (config.screenshotOnFailure !== false) {
        failureScreenshot = await this.captureScreenshot(sessionId, service, artifactsDir, true, `${this.id}_action_failure`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: `action_${action}_failed`,
        selector,
        error: message,
        screenshot: failureScreenshot?.url || failureScreenshot?.path,
      });

      return {
        success: false,
        error: message,
        outputs: {
          sessionId,
          action,
          selector,
          ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
        },
        metadata: { sessionId, action, selector, failed: true },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const validActions = ['click', 'type', 'fill', 'select', 'press_key'];

    if (!config.action || !validActions.includes(config.action)) {
      errors.push(`action is required and must be one of: ${validActions.join(', ')}`);
    }

    if (config.action && ['click', 'type', 'fill', 'select'].includes(config.action)) {
      if (!config.selector || typeof config.selector !== 'string') {
        errors.push(`selector is required for action '${config.action}'`);
      }
    }

    if (config.action === 'press_key' && (!config.key || typeof config.key !== 'string')) {
      errors.push("key is required for action 'press_key'");
    }

    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightActionStep;
