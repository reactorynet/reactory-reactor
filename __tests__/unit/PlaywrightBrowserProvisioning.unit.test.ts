import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Playwright browser provisioning guard.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * `playwright` pins a Chromium build per release, and the browser is NOT part of the npm package:
 * it comes from `playwright install`. Nothing in this repository provisioned one, so a version
 * bump went green on the developer machine — which happened to have the previous build cached —
 * and failed in the built image at first macro use:
 *
 *   browserType.launch: Executable doesn't exist at
 *     /root/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell
 *
 * This suite runs `scripts/verify/playwright-browser-smoke.js`, which is the single source of
 * truth for "is a browser provisioned and does it match the package". That script is also baked
 * into the container image and run during the image build, so the jest verdict, the CI verdict and
 * the image verdict cannot drift apart — this suite re-implements none of the checks, it only
 * asserts on the report the script emits.
 *
 * NO VERSION LITERAL. The expected version comes from `package.json`, so the next playwright bump
 * is a one-line change there and this suite needs no edit.
 *
 * FAILING IS THE POINT. There is no skip: if a browser is not provisioned, or the provisioned
 * revision does not match the installed package, this suite fails, exactly as the image build
 * does. Fix it with:
 *
 *   npx playwright install --with-deps chromium
 */

const MODULE_ROOT = path.resolve(__dirname, '..', '..');
const SMOKE_SCRIPT = path.join(MODULE_ROOT, 'scripts', 'verify', 'playwright-browser-smoke.js');

/** The spec `package.json` declares — the single place a playwright version lives. */
const DECLARED_SPEC: string = JSON.parse(
  fs.readFileSync(path.join(MODULE_ROOT, 'package.json'), 'utf8'),
).dependencies.playwright;

interface SmokeCheck {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

interface SmokeReport {
  ok: boolean;
  code: number;
  playwrightVersion: string;
  playwrightCoreVersion: string;
  declaredSpec: string | null;
  declaredIn: string;
  browsersPath: string;
  browsersPathEnv: string;
  expected: Record<string, string | null>;
  found: Record<string, string[]>;
  launched: boolean;
  browserVersion: string | null;
  checks: SmokeCheck[];
}

describe('Playwright browser provisioning', () => {
  let report: SmokeReport;
  let stderr: string;
  let status: number | null;

  beforeAll(() => {
    expect(fs.existsSync(SMOKE_SCRIPT)).toBe(true);

    const result = spawnSync(process.execPath, [SMOKE_SCRIPT, '--json'], {
      cwd: MODULE_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });

    status = result.status;
    stderr = result.stderr || '';

    // Parse even on failure so the assertions below report WHICH check failed rather than
    // "exit code was 1". A missing report is itself a failure worth seeing in full.
    try {
      report = JSON.parse(result.stdout || '{}') as SmokeReport;
    } catch {
      throw new Error(
        `playwright-browser-smoke.js did not emit JSON.\nexit=${result.status}\n` +
          `stdout=${result.stdout}\nstderr=${result.stderr}`,
      );
    }
  }, 130_000);

  it('declares an exact playwright pin and installs exactly that version', () => {
    // An exact pin is what makes a browser/package mismatch detectable at all: a range would
    // resolve differently on a machine with a stale cache and there would be nothing to compare.
    expect(DECLARED_SPEC).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.declaredSpec).toBe(DECLARED_SPEC);
    expect(report.playwrightVersion).toBe(DECLARED_SPEC);
  });

  it('has playwright-core in lockstep with playwright', () => {
    expect(report.playwrightCoreVersion).toBe(report.playwrightVersion);
  });

  it('has the chromium revision the package pins, on disk', () => {
    expect(report.expected.chromium).toBeTruthy();
    expect(report.found.chromium).toContain(report.expected.chromium);
  });

  it('has the chromium headless-shell revision the package pins, on disk', () => {
    // `headless: true` launches go through chromium-headless-shell, NOT through the full
    // browser. A provisioned full browser with a stale headless shell is still broken.
    expect(report.expected.chromium_headless_shell).toBeTruthy();
    expect(report.found.chromium_headless_shell).toContain(report.expected.chromium_headless_shell);
  });

  it('launches chromium headlessly and reports the pinned browser version', () => {
    expect({
      launched: report.launched,
      browserVersion: report.browserVersion,
    }).toEqual({
      launched: true,
      browserVersion: expect.any(String),
    });
  });

  it('passes every provisioning check', () => {
    const failed = (report.checks || []).filter((check) => !check.ok);
    expect(failed.map((check) => `${check.name} — ${check.detail}${check.hint ? ` (fix: ${check.hint})` : ''}`))
      .toEqual([]);
    expect(status).toBe(0);
    expect(stderr).toBe('');
  });
});
