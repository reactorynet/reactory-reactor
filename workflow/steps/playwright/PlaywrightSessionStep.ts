import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig } from './BasePlaywrightStep';

export interface PlaywrightSessionStepConfig extends PlaywrightBaseStepConfig {
  action?: 'open' | 'close' | 'list';
  headless?: boolean | string;
  viewport?: string | { width: number; height: number };
  userAgent?: string;
  timeout?: number;
}

/**
 * PlaywrightSessionStep - Manages browser session lifecycle in workflows.
 * 
 * Step Type: 'playwright_session'
 * Actions:
 * - 'open' (default): Launches a new Chromium browser context and page.
 * - 'close': Closes an active browser session and releases resources.
 * - 'list': Lists active sessions and current page titles.
 */
export class PlaywrightSessionStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright_session';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightSessionStepConfig;
    const service = this.getPlaywrightService(context);

    if (!service) {
      return {
        success: false,
        error: 'ReactorPlaywrightService is not available in the execution context.',
        outputs: {},
        metadata: {},
      };
    }

    const action = (this.cleanOptional(config.action, context) || 'open').toLowerCase();

    try {
      if (action === 'open') {
        const headless = config.headless !== false && config.headless !== 'false';
        let viewport: { width: number; height: number } | undefined;

        if (typeof config.viewport === 'string') {
          const [w, h] = config.viewport.split('x').map(Number);
          if (w && h) viewport = { width: w, height: h };
        } else if (config.viewport && typeof config.viewport === 'object') {
          viewport = config.viewport;
        }

        const userAgent = this.cleanOptional(config.userAgent, context);
        const timeout = typeof config.timeout === 'number' ? config.timeout : undefined;

        const { sessionId } = await service.createSession({
          headless,
          viewport: viewport || { width: 1280, height: 720 },
          userAgent,
          timeout,
        });

        const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);
        this.recordSessionActivity(sessionId, artifactsDir, {
          action: 'session_opened',
          headless,
          viewport: viewport || { width: 1280, height: 720 },
          userAgent,
        });

        // Store sessionId in context variables for subsequent steps
        const ctxAny = context as any;
        if (ctxAny?.vars) {
          ctxAny.vars.playwrightSessionId = sessionId;
        }

        context.logger.info(`[${this.id}] Playwright session opened: ${sessionId}`);

        return {
          success: true,
          outputs: {
            sessionId,
            headless,
            viewport: viewport || { width: 1280, height: 720 },
            artifactsDir,
          },
          metadata: { sessionId, headless },
        };
      }

      if (action === 'close') {
        const sessionId = await this.resolveSessionId(config, context, service, false);
        const artifactsDir = this.resolveArtifactsDirectory(sessionId, config, context);
        this.recordSessionActivity(sessionId, artifactsDir, { action: 'session_closed' });

        await service.closeSession(sessionId);

        const ctxAny = context as any;
        if (ctxAny?.vars?.playwrightSessionId === sessionId) {
          delete ctxAny.vars.playwrightSessionId;
        }

        context.logger.info(`[${this.id}] Playwright session closed: ${sessionId}`);

        return {
          success: true,
          outputs: {
            sessionId,
            closed: true,
          },
          metadata: { sessionId },
        };
      }

      if (action === 'list') {
        const sessions = service.listSessions();
        return {
          success: true,
          outputs: {
            sessions,
            count: sessions.length,
          },
          metadata: { count: sessions.length },
        };
      }

      return {
        success: false,
        error: `Unsupported playwright_session action '${action}'`,
        outputs: {},
        metadata: { action },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logger.error(`[${this.id}] playwright_session failed: ${message}`);
      return {
        success: false,
        error: message,
        outputs: {},
        metadata: { action },
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    const action = config.action || 'open';
    const validActions = ['open', 'close', 'list'];

    if (!validActions.includes(action)) {
      errors.push(`action must be one of: ${validActions.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightSessionStep;
