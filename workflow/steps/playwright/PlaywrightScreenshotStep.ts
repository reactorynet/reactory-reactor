import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig } from './BasePlaywrightStep';

export interface PlaywrightScreenshotStepConfig extends PlaywrightBaseStepConfig {
  name?: string;
  path?: string;
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
  includeBase64?: boolean;
}

/**
 * PlaywrightScreenshotStep - Captures a screenshot of the active browser session.
 * 
 * Step Type: 'playwright_screenshot'
 * Features:
 * - Drops the image into the standardized workflow session artifacts folder.
 * - Computes a safe CDN URL for immediate visual display in the Reactory client or side panel.
 * - Supports fullPage capture and JPEG quality control.
 */
export class PlaywrightScreenshotStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright_screenshot';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightScreenshotStepConfig;
    const service = this.getPlaywrightService(context);

    if (!service) {
      return {
        success: false,
        error: 'ReactorPlaywrightService is not available in the execution context.',
        outputs: {},
        metadata: {},
      };
    }

    const sessionId = await this.resolveSessionId(config, context, service, true);
    const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);

    try {
      context.logger.info(`[${this.id}] Capturing Playwright screenshot for session [${sessionId}]`);

      const screenshot = await this.captureScreenshot(
        sessionId,
        service,
        artifactsDir,
        {
          name: this.cleanOptional(config.name, context) || this.id,
          path: this.cleanOptional(config.path, context),
          fullPage: config.fullPage !== false,
          type: (this.cleanOptional(config.type, context) as any) || 'png',
          quality: config.quality,
          includeBase64: config.includeBase64 === true,
        },
        this.id
      );

      if (!screenshot) {
        throw new Error('Failed to capture screenshot.');
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'screenshot_captured',
        path: screenshot.path,
        url: screenshot.url,
        sizeKb: screenshot.sizeKb,
      });

      return {
        success: true,
        outputs: {
          sessionId,
          path: screenshot.path,
          url: screenshot.url,
          sizeKb: screenshot.sizeKb,
          ...(screenshot.base64 ? { base64: screenshot.base64 } : {}),
        },
        metadata: {
          sessionId,
          path: screenshot.path,
          url: screenshot.url,
          sizeKb: screenshot.sizeKb,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logger.error(`[${this.id}] playwright_screenshot failed: ${message}`);
      return {
        success: false,
        error: message,
        outputs: { sessionId },
        metadata: { sessionId, failed: true },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const validTypes = ['png', 'jpeg'];
    if (config.type && !validTypes.includes(config.type)) {
      errors.push(`type must be one of: ${validTypes.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightScreenshotStep;
