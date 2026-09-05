import fs from 'fs';
import path from 'path';
import { BaseYamlStep } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/base/BaseYamlStep';
import {
  StepExecutionContext,
  StepExecutionResult,
  ValidationResult,
} from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { safeCDNUrl } from '@reactory/server-core/utils/url/safeUrl';
import type ReactorPlaywrightService from '@reactory/server-modules/reactory-reactor/services/playwright/ReactorPlaywrightService';

export const PLAYWRIGHT_SERVICE_ID = 'reactor.ReactorPlaywrightService@1.0.0';

export interface PlaywrightScreenshotConfig {
  enabled?: boolean;
  name?: string;
  path?: string;
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
  includeBase64?: boolean;
}

export interface ScreenshotArtifact {
  path: string;
  url?: string;
  sizeKb: number;
  base64?: string;
}

export interface PlaywrightBaseStepConfig {
  sessionId?: string;
  timeout?: number;
  screenshot?: boolean | PlaywrightScreenshotConfig;
  screenshotOnFailure?: boolean;
  artifactsDir?: string;
  enabled?: boolean;
}

/**
 * BasePlaywrightStep - Abstract base class for all Playwright workflow steps.
 * 
 * Provides:
 * - Playwright service resolution from the Reactory execution context.
 * - Session ID resolution (from config, workflow context variables, or auto-creation).
 * - Standardized session artifact drop locations (session.json, logs, screenshots).
 * - Integrated screenshot capture with Reactory safeCDNUrl generation.
 * - Truncation and serialization safety to prevent workflow persistence bloat.
 */
export abstract class BasePlaywrightStep extends BaseYamlStep {

  /**
   * Resolves the Playwright service from the Reactory execution context.
   */
  protected getPlaywrightService(context: StepExecutionContext): ReactorPlaywrightService | null {
    try {
      return context.reactoryContext?.getService<ReactorPlaywrightService>(PLAYWRIGHT_SERVICE_ID) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Cleans an optional templatable string value.
   * If the value contains un-interpolated `${...}` tokens or is empty, returns undefined.
   */
  protected cleanOptional(value: any, context: StepExecutionContext): string | undefined {
    if (value === undefined || value === null) return undefined;
    const resolved = this.resolveTemplate(String(value), context);
    if (typeof resolved === 'string' && (resolved.trim() === '' || resolved.includes('${'))) {
      return undefined;
    }
    return resolved;
  }

  /**
   * Resolves or ensures a Playwright browser session ID.
   */
  protected async resolveSessionId(
    config: PlaywrightBaseStepConfig,
    context: StepExecutionContext,
    service: ReactorPlaywrightService,
    autoCreate = true
  ): Promise<string> {
    const explicitId = this.cleanOptional(config.sessionId, context);
    if (explicitId) return explicitId;

    // Check workflow context variables if available
    const ctxAny = context as any;
    const fromVars = ctxAny?.vars?.playwrightSessionId || ctxAny?.workflow?.vars?.playwrightSessionId;
    if (fromVars && typeof fromVars === 'string' && !fromVars.includes('${')) {
      return fromVars;
    }

    // Check active sessions in service
    const active = service.listSessions();
    if (active.length > 0) {
      return active[active.length - 1].id;
    }

    if (!autoCreate) {
      throw new Error('No active Playwright session found and autoCreate is disabled.');
    }

    // Auto-create a session
    context.logger.info(`[${this.id}] No active Playwright session provided. Launching a new headless browser session.`);
    const created = await service.createSession({
      headless: true,
      viewport: { width: 1280, height: 720 },
      timeout: config.timeout || 30000,
    });

    if (ctxAny?.vars) {
      ctxAny.vars.playwrightSessionId = created.sessionId;
    }

    return created.sessionId;
  }

  /**
   * Resolves the file-system directory where session artifacts (screenshots, logs, metadata) are dropped.
   */
  protected resolveArtifactsDirectory(
    sessionId: string,
    config: PlaywrightBaseStepConfig,
    context: StepExecutionContext
  ): string {
    const explicitDir = this.cleanOptional(config.artifactsDir, context);
    if (explicitDir) {
      if (!fs.existsSync(explicitDir)) {
        fs.mkdirSync(explicitDir, { recursive: true });
      }
      return explicitDir;
    }

    const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT || '/tmp';
    const instanceId = (context as any)?.workflowInstanceId || (context as any)?.workflow?.id || 'default';
    const sessionDir = path.join(dataRoot, 'workflows', 'artifacts', 'playwright', instanceId, sessionId);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    return sessionDir;
  }

  /**
   * Records step execution metadata and activity into the session's session.json file.
   */
  protected recordSessionActivity(
    sessionId: string,
    artifactsDir: string,
    activity: Record<string, any>
  ): void {
    try {
      const sessionFilePath = path.join(artifactsDir, 'session.json');
      let sessionData: Record<string, any> = {
        sessionId,
        createdAt: new Date().toISOString(),
        history: [],
      };

      if (fs.existsSync(sessionFilePath)) {
        try {
          const raw = fs.readFileSync(sessionFilePath, 'utf8');
          sessionData = JSON.parse(raw);
        } catch {
          // If read/parse fails, start fresh
        }
      }

      sessionData.lastUpdated = new Date().toISOString();
      if (!Array.isArray(sessionData.history)) sessionData.history = [];
      sessionData.history.push({
        stepId: this.id,
        stepType: this.stepType,
        timestamp: new Date().toISOString(),
        ...activity,
      });

      fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData, null, 2), 'utf8');
    } catch {
      // Non-blocking: fail quietly on activity logging to prevent disrupting step execution
    }
  }

  /**
   * Captures a screenshot using the Playwright service and returns artifact paths and safe CDN URLs.
   */
  protected async captureScreenshot(
    sessionId: string,
    service: ReactorPlaywrightService,
    artifactsDir: string,
    options?: PlaywrightScreenshotConfig | boolean,
    stepName = this.id
  ): Promise<ScreenshotArtifact | undefined> {
    const screenshotOpts = typeof options === 'object' ? options : {};
    const format = screenshotOpts.type || 'png';
    const prefix = screenshotOpts.name || stepName || 'screenshot';
    const filename = `${prefix}_${Date.now()}.${format}`;
    const targetPath = screenshotOpts.path || path.join(artifactsDir, filename);

    try {
      const result = await service.screenshot(sessionId, {
        fullPage: screenshotOpts.fullPage === true,
        path: targetPath,
        type: format,
        quality: screenshotOpts.quality,
      });

      const sizeKb = Math.round((result.base64.length * 3) / 4 / 1024);
      const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT || '/tmp';
      let cdnUrl: string | undefined;

      if (targetPath.startsWith(dataRoot)) {
        const relativePath = path.relative(dataRoot, targetPath);
        cdnUrl = safeCDNUrl(relativePath);
      }

      return {
        path: targetPath,
        url: cdnUrl,
        sizeKb,
        base64: screenshotOpts.includeBase64 ? result.base64 : undefined,
      };
    } catch (err) {
      return undefined;
    }
  }

  /**
   * Safely formats and truncates strings or objects to avoid bloating workflow history payloads.
   */
  protected sanitizeOutput(value: any, maxChars = 5000): any {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return value.length > maxChars ? value.substring(0, maxChars) + '... [truncated]' : value;
    }
    if (typeof value === 'object') {
      try {
        const json = JSON.stringify(value);
        if (json.length > maxChars) {
          return {
            _warning: `Payload truncated from ${json.length} characters`,
            preview: json.substring(0, maxChars) + '...',
          };
        }
      } catch {
        return String(value);
      }
    }
    return value;
  }
}

export default BasePlaywrightStep;
