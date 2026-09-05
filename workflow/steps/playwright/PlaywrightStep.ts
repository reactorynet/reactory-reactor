import { StepExecutionContext, StepExecutionResult, ValidationResult } from '@reactory/server-modules/reactory-core/workflow/YamlFlow/steps/interfaces/IYamlStep';
import { BasePlaywrightStep, PlaywrightBaseStepConfig, ScreenshotArtifact } from './BasePlaywrightStep';

export type PlaywrightOperation =
  | 'open'
  | 'close'
  | 'navigate'
  | 'click'
  | 'type'
  | 'fill'
  | 'select'
  | 'press_key'
  | 'evaluate'
  | 'inspect'
  | 'wait_for'
  | 'screenshot';

export interface PlaywrightActionItem {
  operation: PlaywrightOperation;
  selector?: string;
  url?: string;
  text?: string;
  key?: string;
  values?: string[] | string;
  script?: string;
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  timeout?: number;
  screenshot?: boolean | string;
}

export interface PlaywrightStepConfig extends PlaywrightBaseStepConfig {
  operation?: PlaywrightOperation;
  actions?: PlaywrightActionItem[];
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  values?: string[] | string;
  script?: string;
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
}

/**
 * PlaywrightStep - Unified Playwright step supporting single operations or sequential multi-action scripts.
 * 
 * Step Type: 'playwright'
 */
export class PlaywrightStep extends BasePlaywrightStep {
  public readonly stepType = 'playwright';

  protected async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const config = this.config as PlaywrightStepConfig;
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

    // If an actions array is provided, run them in sequence
    if (Array.isArray(config.actions) && config.actions.length > 0) {
      context.logger.info(`[${this.id}] Executing sequence of ${config.actions.length} Playwright actions in session [${sessionId}]`);
      const actionResults: any[] = [];
      const screenshots: ScreenshotArtifact[] = [];

      for (let i = 0; i < config.actions.length; i++) {
        const item = config.actions[i];
        const op = (this.cleanOptional(item.operation, context) || 'navigate').toLowerCase() as PlaywrightOperation;
        const res = await this.executeSingleOperation(op, item, sessionId, service, artifactsDir, context, `action_${i}_${op}`);
        
        actionResults.push(res);
        if (res.screenshot) screenshots.push(res.screenshot);

        if (res.success === false) {
          return {
            success: false,
            error: `Action ${i} (${op}) failed: ${res.error}`,
            outputs: {
              sessionId,
              completedCount: i,
              totalCount: config.actions.length,
              actions: actionResults,
              screenshots,
            },
            metadata: { sessionId, failedStep: i },
          };
        }
      }

      return {
        success: true,
        outputs: {
          sessionId,
          actionsCount: config.actions.length,
          actions: actionResults,
          screenshots,
        },
        metadata: { sessionId, actionsCount: config.actions.length },
      };
    }

    // Single operation execution
    const operation = (this.cleanOptional(config.operation, context) || 'navigate').toLowerCase() as PlaywrightOperation;
    const singleResult = await this.executeSingleOperation(operation, config, sessionId, service, artifactsDir, context, this.id);

    return {
      success: singleResult.success !== false,
      error: singleResult.error,
      outputs: {
        sessionId,
        operation,
        ...singleResult,
      },
      metadata: { sessionId, operation },
    };
  }

  private async executeSingleOperation(
    op: PlaywrightOperation,
    cfg: any,
    sessionId: string,
    service: any,
    artifactsDir: string,
    context: StepExecutionContext,
    label: string
  ): Promise<any> {
    try {
      switch (op) {
        case 'open':
          return { sessionId, opened: true };

        case 'close':
          await service.closeSession(sessionId);
          return { sessionId, closed: true };

        case 'navigate': {
          const url = this.cleanOptional(cfg.url, context);
          if (!url) throw new Error("Operation 'navigate' requires 'url'");
          const navRes = await service.navigate(sessionId, { url });
          let screenshot: ScreenshotArtifact | undefined;
          if (cfg.screenshot) {
            screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, cfg.screenshot, label);
          }
          return { url: navRes.url, title: navRes.title, status: navRes.status, screenshot };
        }

        case 'click': {
          const selector = this.cleanOptional(cfg.selector, context);
          if (!selector) throw new Error("Operation 'click' requires 'selector'");
          await service.click(sessionId, { selector });
          let screenshot: ScreenshotArtifact | undefined;
          if (cfg.screenshot) {
            screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, cfg.screenshot, label);
          }
          return { selector, clicked: true, screenshot };
        }

        case 'type':
        case 'fill': {
          const selector = this.cleanOptional(cfg.selector, context);
          const text = this.cleanOptional(cfg.text, context) ?? '';
          if (!selector) throw new Error("Operation 'type' requires 'selector'");
          await service.type(sessionId, { selector, text, clear: cfg.clear === true || op === 'fill' });
          let screenshot: ScreenshotArtifact | undefined;
          if (cfg.screenshot) {
            screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, cfg.screenshot, label);
          }
          return { selector, typed: true, screenshot };
        }

        case 'select': {
          const selector = this.cleanOptional(cfg.selector, context);
          if (!selector) throw new Error("Operation 'select' requires 'selector'");
          const vals = Array.isArray(cfg.values) ? cfg.values : String(cfg.values || '').split(',').map(s => s.trim());
          const sel = await service.select(sessionId, selector, vals);
          return { selector, selected: sel.selectedValues };
        }

        case 'press_key': {
          const key = this.cleanOptional(cfg.key, context);
          if (!key) throw new Error("Operation 'press_key' requires 'key'");
          await service.pressKey(sessionId, key);
          return { key, pressed: true };
        }

        case 'evaluate': {
          const script = this.cleanOptional(cfg.script, context);
          if (!script) throw new Error("Operation 'evaluate' requires 'script'");
          const evalRes = await service.evaluate(sessionId, { script });
          return { result: this.sanitizeOutput(evalRes.result) };
        }

        case 'inspect':
        case 'wait_for': {
          const selector = this.cleanOptional(cfg.selector, context);
          if (!selector) throw new Error("Operation 'inspect' requires 'selector'");
          const state = (this.cleanOptional(cfg.state, context) as any) || 'visible';
          const waitRes = await service.waitForSelector(sessionId, { selector, state, timeout: cfg.timeout || 15000 });
          if (!waitRes.found) throw new Error(`Selector "${selector}" not found in state "${state}"`);
          const inspected = await service.inspectElement(sessionId, selector);
          return {
            selector,
            visible: inspected.visible,
            text: inspected.text,
            tagName: inspected.tagName,
            attributes: inspected.attributes,
          };
        }

        case 'screenshot': {
          const screenshot = await this.captureScreenshot(sessionId, service, artifactsDir, cfg, label);
          return { screenshot };
        }

        default:
          throw new Error(`Unsupported operation: ${op}`);
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public validateConfig(config: Record<string, any>): ValidationResult {
    const errors: string[] = [];
    if (!config.operation && (!Array.isArray(config.actions) || config.actions.length === 0)) {
      errors.push("Either 'operation' or a non-empty 'actions' array must be provided.");
    }
    return { valid: errors.length === 0, errors };
  }
}

export default PlaywrightStep;
