/**
 * Throwaway validation for the AI failure attribution path.
 *
 * Proves three things that static checks cannot:
 *   1. the table accepts the exact INSERT shape `recordFailure` issues;
 *   2. the aggregation SQL the dashboard runs actually counts a failure; and
 *   3. the error rate arithmetic produces a sensible number.
 *
 * Writes exactly one clearly-marked row and removes it again, so it is safe to run
 * against a live database. Not a test — a one-shot probe.
 */
import { Client } from 'pg';

const MARKER = '__probe__';

const run = async () => {
  const pg = new Client({
    host: process.env.REACTORY_POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.REACTORY_POSTGRES_PORT || '5432', 10),
    user: process.env.REACTORY_POSTGRES_USER || 'reactory',
    password: process.env.REACTORY_POSTGRES_PASSWORD || 'reactory',
    database: process.env.REACTORY_POSTGRES_DB || 'reactory',
  });
  await pg.connect();

  try {
    // 1. The INSERT shape from recordFailure, bounded values and all.
    await pg.query(
      `INSERT INTO reactor_ai_failures
         (user_id, conversation_id, persona_id, provider_id, model_id, use_case,
          error_code, error_message, retryable, attempts, duration_ms, turn_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        null,
        null,
        MARKER,
        'google',
        'gemini-3.7-flash',
        'standalone',
        'RATE_LIMIT',
        'probe: simulated rate limit',
        true,
        3,
        1234,
        'user-turn',
      ]
    );
    console.log('[probe] insert OK');

    // 2. The aggregation the dashboard runs.
    const totals = await pg.query(
      `SELECT
         COUNT(*)::bigint AS failures,
         COUNT(*) FILTER (WHERE f.retryable)::bigint AS retryable_failures,
         COALESCE(SUM(f.attempts), 0)::bigint AS total_attempts
       FROM reactor_ai_failures f
       WHERE f.created_at >= now() - interval '365 days'`
    );
    console.log('[probe] totals:', JSON.stringify(totals.rows[0]));
    if (Number(totals.rows[0].failures) < 1) {
      throw new Error('aggregation did not count the inserted failure');
    }

    // 3. The breakdown, including the "latest error" array picks.
    const breakdown = await pg.query(
      `SELECT
         COALESCE(f.provider_id, 'unknown') AS provider,
         COALESCE(f.model_id, 'unknown') AS model,
         COUNT(*)::bigint AS failures,
         COUNT(*) FILTER (WHERE f.retryable)::bigint AS retryable_failures,
         COALESCE(SUM(f.attempts), 0)::bigint AS total_attempts,
         (ARRAY_AGG(f.error_code ORDER BY f.created_at DESC))[1] AS last_error_code,
         (ARRAY_AGG(f.error_message ORDER BY f.created_at DESC))[1] AS last_error_message
       FROM reactor_ai_failures f
       WHERE f.created_at >= now() - interval '365 days'
       GROUP BY 1, 2
       ORDER BY failures DESC
       LIMIT 20`
    );
    console.log('[probe] breakdown rows:', breakdown.rowCount);
    console.log('[probe] first row:', JSON.stringify(breakdown.rows[0]));

    // 4. The daily bucket.
    const daily = await pg.query(
      `SELECT
         to_char(date_trunc('day', f.created_at), 'YYYY-MM-DD') AS date,
         COUNT(*)::bigint AS failures
       FROM reactor_ai_failures f
       WHERE f.created_at >= now() - interval '365 days'
       GROUP BY 1`
    );
    console.log('[probe] daily rows:', daily.rowCount, JSON.stringify(daily.rows[0] ?? null));

    // 5. Error rate arithmetic, against the real success count.
    const success = await pg.query(
      `SELECT COUNT(*)::bigint AS requests
         FROM reactor_conversation_messages m
        WHERE m.role = 'assistant'
          AND m.provider_response -> 'usage' IS NOT NULL`
    );
    const failures = Number(totals.rows[0].failures);
    const requests = Number(success.rows[0].requests);
    const rate = Math.round((failures / (failures + requests)) * 1_000_000) / 1_000_000;
    console.log(
      `[probe] errorRate = ${failures} / (${failures} + ${requests}) = ${rate}`
    );

    console.log('[probe] PASS');
  } finally {
    // Always clean up the probe row, even on failure.
    const removed = await pg.query(
      `DELETE FROM reactor_ai_failures WHERE persona_id = $1`,
      [MARKER]
    );
    console.log(`[probe] cleaned up ${removed.rowCount} row(s)`);
    await pg.end();
  }
};

run().catch((error) => {
  console.error('[probe] FAILED:', error?.message);
  process.exit(1);
});
