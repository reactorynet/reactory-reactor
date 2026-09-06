import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig, ScreenshotArtifact } from './BasePlaywrightStep';

export interface PlaywrightEvaluateStepConfig extends PlaywrightBaseStepConfig {
  script: string;
  selector?: string;
}

/**
 * PlaywrightEvaluateStep - Evaluates JavaScript expressions or functions in the browser page context.
 * 
 * Step Type: 'playwright_evaluate'
 * Features:
 * - Runs JavaScript in the browser context and returns serialized results.
 * - Optional selector scoping: if a selector is provided, evaluates within the DOM element.
 * - Sanitizes results to prevent workflow instance bloat.
 * - Can take an automated screenshot of the DOM state after evaluation.
 */
export class PlaywrightEvaluateStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright_evaluate';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightEvaluateStepConfig;
    const service = this.getPlaywrightService(context);

    if (!service) {
      return {
        success: false,
        error: 'ReactorPlaywrightService is not available in the execution context.',
        outputs: {},
        metadata: {},
      };
    }

    const script = this.cleanOptional(config.script, context);
    if (!script) {
      return {
        success: false,
        error: `Step "${this.id}" requires a valid 'script'.`,
        outputs: {},
        metadata: {},
      };
    }

    const selector = this.cleanOptional(config.selector, context);
    const sessionId = await this.resolveSessionId(config, context, service, true);
    const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);

    try {
      context.logger.info(`[${this.id}] Evaluating JavaScript in Playwright session [${sessionId}]${selector ? ` (scoped to: ${selector})` : ''}`);

      let evalScript = script;
      if (selector) {
        // Wrap script to evaluate against the selector element
        evalScript = `
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error("Element not found for selector: " + ${JSON.stringify(selector)});
            const fn = (${script});
            return typeof fn === 'function' ? fn(el) : eval(${JSON.stringify(script)});
          })()
        `;
      }

      const { result } = await service.evaluate(sessionId, { script: evalScript });

      let serializedResult: any;
      try {
        serializedResult = JSON.parse(JSON.stringify(result));
      } catch {
        serializedResult = String(result);
      }

      const safeResult = this.sanitizeOutput(serializedResult, 10000);

      let screenshot: ScreenshotArtifact | undefined;
      if (config.screenshot) {
        screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, config.screenshot, `${this.id}_eval`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'evaluate',
        selector,
        scriptLength: script.length,
        resultType: typeof result,
        screenshot: screenshot?.url || screenshot?.path,
      });

      return {
        success: true,
        outputs: {
          sessionId,
          result: safeResult,
          selector,
          ...(screenshot ? { screenshot } : {}),
        },
        metadata: {
          sessionId,
          selector,
          resultType: typeof result,
          hasScreenshot: !!screenshot,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logger.error(`[${this.id}] playwright_evaluate failed: ${message}`);

      let failureScreenshot: ScreenshotArtifact | undefined;
      if (config.screenshotOnFailure !== false) {
        failureScreenshot = await this.captureScreenshot(sessionId, service, artifactsDir, true, `${this.id}_eval_failure`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'evaluate_failed',
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
          ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
        },
        metadata: { sessionId, selector, failed: true },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    if (!config.script || typeof config.script !== 'string') {
      errors.push("script is required and must be a string");
    }
    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightEvaluateStep;
