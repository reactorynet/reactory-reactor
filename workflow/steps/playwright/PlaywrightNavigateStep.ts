import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig, ScreenshotArtifact } from './BasePlaywrightStep';

export interface PlaywrightNavigateStepConfig extends PlaywrightBaseStepConfig {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

/**
 * PlaywrightNavigateStep - Navigates a browser session to a target URL.
 * 
 * Step Type: 'playwright_navigate'
 * Features:
 * - Navigates to a given URL with customizable wait strategy.
 * - Automatically initializes a session if none is provided.
 * - Records visited URL, page title, and HTTP status code into session artifacts.
 * - Optional built-in screenshot capture (`screenshot: true` or `{ fullPage: true }`).
 */
export class PlaywrightNavigateStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright_navigate';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightNavigateStepConfig;
    const service = this.getPlaywrightService(context);

    if (!service) {
      return {
        success: false,
        error: 'ReactorPlaywrightService is not available in the execution context.',
        outputs: {},
        metadata: {},
      };
    }

    const rawUrl = this.cleanOptional(config.url, context);
    if (!rawUrl) {
      return {
        success: false,
        error: `Step "${this.id}" requires a valid 'url'.`,
        outputs: {},
        metadata: {},
      };
    }

    const sessionId = await this.resolveSessionId(config, context, service, true);
    const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);
    const waitUntil = (this.cleanOptional(config.waitUntil, context) as any) || 'load';

    try {
      context.logger.info(`[${this.id}] Navigating Playwright session [${sessionId}] to: ${rawUrl} (waitUntil: ${waitUntil})`);
      const navResult = await service.navigate(sessionId, {
        url: rawUrl,
        waitUntil,
      });

      let screenshot: ScreenshotArtifact | undefined;
      if (config.screenshot) {
        screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, config.screenshot, `${this.id}_nav`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'navigate',
        url: navResult.url,
        title: navResult.title,
        status: navResult.status,
        screenshot: screenshot?.url || screenshot?.path,
      });

      return {
        success: true,
        outputs: {
          sessionId,
          url: navResult.url,
          title: navResult.title,
          status: navResult.status,
          ...(screenshot ? { screenshot } : {}),
        },
        metadata: {
          sessionId,
          url: navResult.url,
          title: navResult.title,
          status: navResult.status,
          hasScreenshot: !!screenshot,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logger.error(`[${this.id}] Navigation failed: ${message}`);

      let failureScreenshot: ScreenshotArtifact | undefined;
      if (config.screenshotOnFailure !== false) {
        failureScreenshot = await this.captureScreenshot(sessionId, service, artifactsDir, true, `${this.id}_failure`);
      }

      this.recordSessionActivity(sessionId, artifactsDir, {
        action: 'navigate_failed',
        url: rawUrl,
        error: message,
        screenshot: failureScreenshot?.url || failureScreenshot?.path,
      });

      return {
        success: false,
        error: message,
        outputs: {
          sessionId,
          url: rawUrl,
          ...(failureScreenshot ? { screenshot: failureScreenshot } : {}),
        },
        metadata: { sessionId, url: rawUrl, failed: true },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    if (!config.url || typeof config.url !== 'string') {
      errors.push("url is required and must be a string");
    }
    const validWait = ['load', 'domcontentloaded', 'networkidle', 'commit'];
    if (config.waitUntil && !validWait.includes(config.waitUntil)) {
      errors.push(`waitUntil must be one of: ${validWait.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightNavigateStep;
