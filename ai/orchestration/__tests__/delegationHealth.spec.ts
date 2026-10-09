/**
 * Orchestration (delegation) health — CI smoke spec.
 *
 * These are the deterministic, server-less half of the orchestration smoke tests
 * documented in `reactory-data/profiles/reactor/personas/reactor/workspace/notes/orchestration-smoke-tests.md`.
 * They encode the delegation-stall signature so the regression is caught in CI.
 *
 * The live halves (T1 tool execution, T3 restart durability, T5 concurrency) still
 * require a running server + LLM and are exercised via the runbook.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  analyzeDelegationTranscript,
  isDelegationHealthy,
} from '../delegationHealth';

// ---------------------------------------------------------------------------
// Fixtures — real captured log lines (see the ticket REACTORY-.../2269478065).
// ---------------------------------------------------------------------------

/** The REAL captured stalled delegation (QualityQuinn session 6ac3e72a52e025e43f3e8004). */
const STALLED_LOG = [
  '[2026-10-05T18:06:34.752Z] [DEBUG] Sending message {"personaId":"QualityQuinn","chatSessionId":"6ac3e72a52e025e43f3e8004","messageLength":7506,"role":"user"}',
  '[2026-10-05T18:06:36.379Z] [INFO] [sendMessage] AUTO mode: executing 2 tool(s) server-side (iteration 1) {"tools":["readFile","readFile"],"conversationId":"6ac3e72a52e025e43f3e8004"}',
  '[2026-10-05T18:06:36.379Z] [INFO] [sendMessage] AUTO mode: skipping client-side tool "readFile" — will be forwarded to client {"toolName":"readFile"}',
  '[2026-10-05T18:06:36.397Z] [INFO] [sendMessage] AUTO mode: skipping client-side tool "readFile" — will be forwarded to client {"toolName":"readFile"}',
  '[2026-10-05T18:06:36.407Z] [INFO] [sendMessage] AUTO mode: pausing — client-side tool(s) pending. Server will resume when client reports results via ReactorCompleteClientToolCalls. {"conversationId":"6ac3e72a52e025e43f3e8004"}',
].join('\n');

/** A healthy delegation: server-side tools execute, no pause. */
const HEALTHY_LOG = [
  '[2026-10-06T05:00:00.000Z] [DEBUG] Sending message {"personaId":"QualityQuinn","chatSessionId":"abc","role":"user"}',
  '[2026-10-06T05:00:01.000Z] [INFO] [sendMessage] AUTO mode: executing 2 tool(s) server-side (iteration 1) {"tools":["readFile","grep"],"conversationId":"abc"}',
  '[2026-10-06T05:00:02.000Z] [INFO] [sendMessage] AUTO mode: executing 1 tool(s) server-side (iteration 2) {"tools":["readFile"],"conversationId":"abc"}',
  '[2026-10-06T05:00:03.000Z] [DEBUG] Response generated {"conversationId":"abc"}',
].join('\n');

/** A pause line with NO deferred tool — not a stall. */
const PAUSE_NO_TOOL_LOG =
  '[2026-10-06T05:00:00.000Z] [INFO] [sendMessage] AUTO mode: pausing — client-side tool(s) pending.';

describe('delegationHealth', () => {
  describe('analyzeDelegationTranscript', () => {
    it('detects the real stalled delegation turn', () => {
      const health = analyzeDelegationTranscript(STALLED_LOG);

      expect(health.stalled).toBe(true);
      expect(health.healthy).toBe(false);
      expect(health.pendingClientTools).toEqual(['readFile', 'readFile']);
      expect(health.serverSideTools).toEqual(['readFile', 'readFile']);
      expect(health.lastIteration).toBe(1);
      expect(health.reason).toMatch(/client-side tool/i);
    });

    it('treats a healthy server-side turn as healthy', () => {
      const health = analyzeDelegationTranscript(HEALTHY_LOG);

      expect(health.healthy).toBe(true);
      expect(health.stalled).toBe(false);
      expect(health.reason).toBeUndefined();
      expect(health.serverSideTools).toEqual(['readFile', 'grep', 'readFile']);
      expect(health.lastIteration).toBe(2);
    });

    it('does not flag a pause line that has no deferred tool', () => {
      const health = analyzeDelegationTranscript(PAUSE_NO_TOOL_LOG);

      expect(health.stalled).toBe(false);
      expect(health.healthy).toBe(true);
    });

    it('handles empty / junk input without throwing', () => {
      expect(analyzeDelegationTranscript('').healthy).toBe(true);
      expect(analyzeDelegationTranscript(undefined as any).healthy).toBe(true);
      expect(analyzeDelegationTranscript('random noise\n').healthy).toBe(true);
    });

    it('exposes a convenience predicate', () => {
      expect(isDelegationHealthy(STALLED_LOG)).toBe(false);
      expect(isDelegationHealthy(HEALTHY_LOG)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Durability check over any real delegation transcripts on disk.
  // Skips cleanly when the data root is not available (e.g. plain CI checkout).
  // -------------------------------------------------------------------------
  describe('real session logs on disk', () => {
    const dataRoot = process.env.APP_DATA_ROOT
      || process.env.REACTORY_DATA_ROOT
      || '/Users/wernerw/Projects/reactory/reactory-data';

    const collectSessionLogs = (): string[] => {
      const profiles = path.join(dataRoot, 'profiles');
      if (!fs.existsSync(profiles)) return [];

      const logs: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 4) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // only descend into .../chats/<persona>/... to bound the walk
            if (entry.name === 'chats' || dir.includes(`${path.sep}chats`)) {
              walk(full, depth + 1);
            }
          } else if (entry.isFile() && entry.name === 'session.log') {
            logs.push(full);
          }
        }
      };
      walk(profiles, 0);
      return logs;
    };

    it('reports the stall status of every delegation transcript (durability signal)', () => {
      const logs = collectSessionLogs();

      if (logs.length === 0) {
        // No transcripts available in this environment — nothing to assert.
        expect(logs).toEqual([]);
        return;
      }

      const results = logs.map((file) => {
        let text = '';
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          text = '';
        }
        return { file, ...analyzeDelegationTranscript(text) };
      });

      const stalled = results.filter((r) => r.stalled);

      // Surface the count for humans; the assertion itself is that the analyser
      // ran over real data without throwing and produced a verdict per file.
      // eslint-disable-next-line no-console
      console.log(
        `[orchestration-health] ${results.length} transcript(s); `
        + `${stalled.length} stalled${stalled.length ? `: ${stalled.map((s) => path.basename(path.dirname(s.file))).join(', ')}` : ''}`,
      );

      expect(results.length).toBe(logs.length);
      expect(results.every((r) => typeof r.healthy === 'boolean')).toBe(true);
    });
  });
});
