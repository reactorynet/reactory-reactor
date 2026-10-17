import { describe, it, expect } from '@jest/globals';
import {
  createAutoToolBatch,
  describeAutoToolBatch,
} from '../toolBatchReport';
import { analyzeDelegationTranscript } from '../delegationHealth';

/**
 * The AUTO loop's iteration summary must describe what actually happened.
 *
 * Regression under test (ticket REACTORY-302016408/20261006/2269478065): the line was
 * written before classification, counted every requested call, and was followed by a
 * `skipping client-side tool "readFile"` line for one of those same calls. The result
 * was a transcript claiming `readFile` executed server-side *and* was forwarded to a
 * client, within one iteration — which is exactly the inconsistency that made the
 * stall undiagnosable.
 */
describe('toolBatchReport', () => {
  it('starts empty', () => {
    expect(createAutoToolBatch()).toEqual({
      executedServerTools: [],
      deferredClientTools: [],
      refusedTools: [],
    });
  });

  it('counts only the tools the server actually executed', () => {
    const batch = createAutoToolBatch();
    batch.executedServerTools.push('grep', 'listFiles');
    batch.deferredClientTools.push('chart');
    batch.refusedTools.push('notDeclared');

    const { message, meta } = describeAutoToolBatch(batch, 2);

    expect(message).toBe('[sendMessage] AUTO mode: executing 2 tool(s) server-side (iteration 2)');
    expect(meta.tools).toEqual(['grep', 'listFiles']);
    expect(meta.clientTools).toEqual(['chart']);
    expect(meta.refusedTools).toEqual(['notDeclared']);
  });

  it('never reports a client-side tool as server-executed', () => {
    const batch = createAutoToolBatch();
    // The stalled shape: two calls requested, both classified client-side.
    batch.deferredClientTools.push('readFile', 'readFile');

    const { message, meta } = describeAutoToolBatch(batch, 1);

    expect(message).toContain('executing 0 tool(s) server-side');
    expect(meta.tools).toEqual([]);
  });

  it('does not alias its arrays, so later mutation cannot rewrite an emitted summary', () => {
    const batch = createAutoToolBatch();
    batch.executedServerTools.push('grep');

    const { meta } = describeAutoToolBatch(batch, 1);
    batch.executedServerTools.push('readFile');

    expect(meta.tools).toEqual(['grep']);
  });

  it('produces a line the health analyser reads as server-side execution', () => {
    const batch = createAutoToolBatch();
    batch.executedServerTools.push('readFile', 'grep');

    const { message, meta } = describeAutoToolBatch(batch, 1);
    const logLine = `[2026-10-05T18:06:36.379Z] [INFO] ${message} ${JSON.stringify(meta)}`;

    const health = analyzeDelegationTranscript(logLine);
    expect(health.serverSideTools).toEqual(['readFile', 'grep']);
    expect(health.pendingClientTools).toEqual([]);
    expect(health.stalled).toBe(false);
    expect(health.lastIteration).toBe(1);
  });

  it('reads as a stall only when a pause really followed a deferred tool', () => {
    const batch = createAutoToolBatch();
    batch.deferredClientTools.push('chart');

    const { message } = describeAutoToolBatch(batch, 1);

    // The summary line alone is not a stall — it has no pause and no skip record.
    expect(analyzeDelegationTranscript(message).stalled).toBe(false);
  });
});
