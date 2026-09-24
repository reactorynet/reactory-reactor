import { DataSource } from 'typeorm';
import { TenantScopeError } from '@reactory/server-core/database/tenant/TenantRepository';
import Reactory from '@reactorynet/reactory-core';
import { service } from '@reactory/server-core/application/decorators/service';

/**
 * AI usage reporting, derived from the Postgres conversation message log.
 *
 * WHY THIS REPLACES THE MONGO LEDGER READ
 *
 * The previous implementation (`ReactorAIUsageService.getUsageSummary`) read a
 * Mongo ledger, `reactor_ai_usages`. That collection was empty — 0 documents —
 * while the message log held 20,006 real usage turns, so the dashboard silently
 * fell back to hardcoded fixtures in `UsageDashboard/index.ts`. A dashboard that
 * reports invented numbers is worse than one that reports nothing, so this
 * service derives everything from data that demonstrably exists.
 *
 * The measures live where the provider put them, `provider_response -> 'usage'`,
 * and are never duplicated. The *dimensions* — provider, model, user, persona —
 * live in the attribution columns added by
 * `20260916090000-AddMessageUsageAttribution`, because they cannot be recovered
 * from the envelope: the adapters normalise every stored response to the OpenAI
 * `chat.completion` shape, so no provider or model survives on it.
 *
 * TRUSTWORTHINESS
 *
 * Two failure modes in the old path were silent, and both are surfaced here
 * rather than hidden:
 *   - a model with no price reported as *free*; here it is counted in
 *     `unpricedTurns` and its cost is excluded from the total, so the total is
 *     known to be a lower bound rather than assumed complete;
 *   - token counts estimated from content length were indistinguishable from
 *     reported ones; `usage_source` separates them and `estimatedTurns` counts
 *     them.
 * `coverage` exists so a caller can tell a complete figure from a partial one.
 */

/** Filter accepted by every read on this service. */
export interface UsageAnalyticsFilter {
  userId?: string;
  provider?: string;
  model?: string;
  personaId?: string;
  useCase?: string;
  startDate?: string | Date;
  endDate?: string | Date;
}

export interface UsageTimeSeriesPoint {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdCents: number;
  costUsd: number;
  requests: number;
  /**
   * Failed turns on this day.
   *
   * Carried on the trend so a spike in failures is visible *beside* the token
   * volume rather than only in a window aggregate. The two correlate — a failing
   * provider is often a degraded one — and seeing them together is what makes the
   * cause legible.
   */
  failures: number;
}

/**
 * Failures grouped by the provider and model that was serving when the turn failed.
 *
 * This is the actionable form of the question. "40 errors" tells you nothing about
 * what to do; "6% of gemini-3.7-flash turns failed, all retryable" tells you where
 * to look. The last error code and message are included so the breakdown is usable
 * without a second query into the raw rows.
 */
export interface UsageFailureBreakdown {
  provider: string;
  model: string;
  failures: number;
  /** Failures judged retryable at the time — an availability signal. */
  retryableFailures: number;
  /** Attempts consumed by these failures, including retries. */
  totalAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}
export interface UsageModelBreakdown {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdCents: number;
  costUsd: number;
  requests: number;
}

export interface UsageProviderBreakdown {
  provider: string;
  totalTokens: number;
  costUsdCents: number;
  costUsd: number;
  requests: number;
}

export interface UsageUserBreakdown {
  userId: string;
  totalTokens: number;
  costUsdCents: number;
  costUsd: number;
  requests: number;
}

/**
 * How much of the requested window the figures actually cover.
 *
 * Deliberately part of the public result: a total over 80% of turns is a very
 * different claim from a total over all of them, and the caller should not have
 * to guess which it is holding.
 */
export interface UsageCoverage {
  /** Assistant rows carrying a usage envelope — the denominator. */
  turns: number;
  /** Turns with a resolved provider and model. */
  attributedTurns: number;
  /** Turns whose cost could be priced. */
  pricedTurns: number;
  /** Turns excluded from the cost total because no price is known. */
  unpricedTurns: number;
  /** Turns whose token counts were estimated rather than reported. */
  estimatedTurns: number;
  /** Turns that reported a usage envelope of all zeros. */
  zeroUsageTurns: number;
  /**
   * Turns whose routed provider differs from the one the session declared —
   * i.e. the request did not go where the conversation said it would.
   */
  reroutedTurns: number;
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsdCents: number;
  totalCostUsd: number;
  totalRequests: number;
  avgDurationMs: number | null;
  /**
   * Failed turns in the window.
   *
   * Was structurally 0 before `reactor_ai_failures` existed: `recordUsage` only ran
   * on the success path and the message log only holds completed turns, so a failed
   * turn left no trace anywhere and the one dashboard meant to reveal "the AI is
   * failing" could not. It now counts rows from the failure table.
   */
  errorCount: number;
  /**
   * Failed turns as a share of all turns attempted: `failures / (failures + requests)`.
   *
   * A fraction in 0..1, not a percentage. This is the number worth alerting on — a
   * raw error count is proportional to traffic and therefore not actionable, whereas
   * a rate answers "is the AI getting less reliable?".
   *
   * `0` when no turns were attempted, which reads correctly as "nothing failed"
   * because nothing ran.
   */
  errorRate: number;
  /** Failures grouped by the provider and model that was serving. */
  errorBreakdown: UsageFailureBreakdown[];
  timeSeries: UsageTimeSeriesPoint[];
  modelBreakdown: UsageModelBreakdown[];
  providerBreakdown: UsageProviderBreakdown[];
  userBreakdown: UsageUserBreakdown[];
  coverage: UsageCoverage;
}
export interface UsageLedgerRecord {
  id: string;
  userId: string | null;
  personaId: string | null;
  provider: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  use_case: string | null;
  usageSource: string | null;
  status: string;
  createdAt: string;
}

export interface UsageLedgerPage {
  records: UsageLedgerRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/** `cost_usd_cents` is NUMERIC, so Postgres hands it back as a string. */
/** `cost_usd_cents` is NUMERIC, so Postgres hands it back as a string. */
const centsToUsd = (cents: number): number => Math.round((cents / 100) * 1_000_000) / 1_000_000;

/**
 * Bound a value to a column's length, normalising empty values to `null`.
 *
 * The failure columns are length-capped, and a provider error message can be
 * arbitrarily long — it sometimes carries a request echo. Truncating on write is
 * deliberate: an unbounded insert would fail outright, turning a recorded failure
 * into an unrecorded one, which is the exact problem this path exists to solve.
 */
const bounded = (value: unknown, maxLength: number): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
};

/** Bound an optional numeric column, normalising anything non-finite to `null`. */
const boundedInt = (value: unknown, round = false): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed)) return null;
  return round ? Math.round(parsed) : Math.trunc(parsed);
};


/**
 * A guarded `jsonb -> bigint` cast.
 *
 * The guard is not defensive padding: a provider that reports a token count as
 * a decimal or a string containing units would abort the whole aggregation with
 * `22P02 invalid input syntax for type bigint`, taking the dashboard down for
 * every user over one malformed row. A malformed value contributes 0 and is
 * caught by `coverage.zeroUsageTurns`.
 */
const intFrom = (expression: string): string =>
  `CASE WHEN (${expression}) ~ '^[0-9]+$' THEN (${expression})::bigint ELSE 0 END`;

/**
 * Prompt tokens for a row.
 *
 * Reads both casings because the stored shape has changed across adapter
 * versions. The legacy ingest script read *only* the snake_case spellings, which
 * matched no stored row, and then silently fabricated counts from content
 * length — the bug this guards against recurring.
 */
const PROMPT_TOKENS = `COALESCE(
  m.provider_response->'usage'->>'promptTokens',
  m.provider_response->'usage'->>'prompt_tokens',
  m.provider_response->'usage'->>'input_tokens',
  '0'
)`;

const COMPLETION_TOKENS = `COALESCE(
  m.provider_response->'usage'->>'completionTokens',
  m.provider_response->'usage'->>'completion_tokens',
  m.provider_response->'usage'->>'output_tokens',
  '0'
)`;

/** Present iff the row carries a usable usage envelope. */
const HAS_USAGE = `m.provider_response -> 'usage' IS NOT NULL AND jsonb_typeof(m.provider_response -> 'usage') = 'object'`;

const promptTokensSql = () => intFrom(PROMPT_TOKENS);
const completionTokensSql = () => intFrom(COMPLETION_TOKENS);

@service({
  id: 'reactor.ReactorUsageAnalyticsService@1.0.0',
  name: 'Reactor Usage Analytics Service',
  nameSpace: 'reactor',
  description:
    'Derives AI token usage, cost, latency and budget consumption from the Postgres conversation message log',
  serviceType: 'ai',
})
export class ReactorUsageAnalyticsService {
  context: Reactory.Server.IReactoryContext;

  constructor(
    _props: Reactory.Service.IReactoryServiceProps,
    context: Reactory.Server.IReactoryContext
  ) {
    this.context = context;
  }

  /** The message store, resolved lazily so importing this service stays cheap. */
  private get dataSource(): DataSource | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ReactorPostgresDataSource } = require('../../models') as {
        ReactorPostgresDataSource: DataSource;
      };
      return ReactorPostgresDataSource?.isInitialized
        ? ReactorPostgresDataSource
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Turn a filter into a parameterised `WHERE` fragment.
   *
   * Values are bound, never interpolated: the filter reaches this method from a
   * GraphQL query, so `userId` and `model` are attacker-influenced strings.
   */
  /**
   * The request's ReactoryClient key (WP-B2). Usage and failures are
   * tenant-scoped: every query filters on it and every failure row carries
   * it. A context without a partner cannot read or write tenant data.
   */
  private get clientKey(): string {
    const key = (this.context?.partner as { key?: string } | undefined)?.key;
    if (!key) {
      throw new TenantScopeError('Usage analytics require a request context with a partner (ReactoryClient)');
    }
    return key;
  }

  private buildWhere(filter: UsageAnalyticsFilter): {
    clause: string;
    params: unknown[];
  } {
    const params: unknown[] = [this.clientKey];
    const conditions: string[] = [
      `m.client_key = $1`,
      `m.role = 'assistant'`,
      HAS_USAGE,
    ];

    const push = (column: string, value: unknown) => {
      if (value === null || value === undefined) return;
      const text = String(value).trim();
      if (!text) return;
      params.push(text);
      conditions.push(`${column} = $${params.length}`);
    };

    push('m.user_id', filter.userId);
    push('m.model_id', filter.model);
    push('m.persona_id', filter.personaId);
    push('m.use_case', filter.useCase);

    // Providers are stored lower-cased by the write path; normalise the filter to
    // match rather than relying on the caller.
    if (filter.provider && String(filter.provider).trim()) {
      params.push(String(filter.provider).trim().toLowerCase());
      conditions.push(`m.provider_id = $${params.length}`);
    }

    if (filter.startDate) {
      params.push(new Date(filter.startDate));
      conditions.push(`m.created_at >= $${params.length}`);
    }

    if (filter.endDate) {
      // The old implementation compared with `<=` against the parsed value, so a
      // date-only `endDate` excluded the whole of its final day — the last day of
      // every reported window was silently missing. A date-only bound is treated
      // as inclusive of that day.
      const raw = String(filter.endDate);
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
      const end = new Date(filter.endDate);
      if (isDateOnly) {
        end.setUTCDate(end.getUTCDate() + 1);
        params.push(end);
        conditions.push(`m.created_at < $${params.length}`);
      } else {
        params.push(end);
        conditions.push(`m.created_at <= $${params.length}`);
      }
    }

    return { clause: conditions.join(' AND '), params };
  }

  /**
   * Turn a filter into a parameterised `WHERE` for the failures table.
   *
   * A deliberate parallel of `buildWhere` rather than a shared implementation: the
   * usage filter carries predicates that are meaningless for a failure row
   * (`role = 'assistant'`, a usage envelope present), and the column aliases differ.
   * Trying to parameterise one builder over both tables would obscure exactly which
   * conditions applied where — and the failure filter is small enough that the
   * duplication is cheaper than the indirection.
   *
   * The date handling matches `buildWhere` deliberately, including the inclusive
   * final day: an error rate that silently dropped the last day of its own window
   * would be worse than the bug it mirrored.
   */
  private buildFailureWhere(filter: UsageAnalyticsFilter): {
    clause: string;
    params: unknown[];
  } {
    // No role or usage predicate here: every row in the failures table is a failed
    // turn, so the table is already the filter.
    const params: unknown[] = [this.clientKey];
    const conditions: string[] = ['f.client_key = $1'];

    const push = (column: string, value: unknown) => {
      if (value === null || value === undefined) return;
      const text = String(value).trim();
      if (!text) return;
      params.push(text);
      conditions.push(`${column} = $${params.length}`);
    };

    push('f.user_id', filter.userId);
    push('f.model_id', filter.model);
    push('f.persona_id', filter.personaId);
    push('f.use_case', filter.useCase);

    if (filter.provider && String(filter.provider).trim()) {
      params.push(String(filter.provider).trim().toLowerCase());
      conditions.push(`f.provider_id = $${params.length}`);
    }

    if (filter.startDate) {
      params.push(new Date(filter.startDate));
      conditions.push(`f.created_at >= $${params.length}`);
    }

    if (filter.endDate) {
      const raw = String(filter.endDate);
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
      const end = new Date(filter.endDate);
      if (isDateOnly) {
        end.setUTCDate(end.getUTCDate() + 1);
        params.push(end);
        conditions.push(`f.created_at < $${params.length}`);
      } else {
        params.push(end);
        conditions.push(`f.created_at <= $${params.length}`);
      }
    }

    return { clause: conditions.join(' AND '), params };
  }


  /**
   * Aggregated usage over a window.
   *
   * Returns zeros with an empty breakdown when Postgres is unavailable, rather
   * than throwing: the dashboard is a read-only view and a store problem must not
   * take out the page. `coverage.turns === 0` is what tells the caller the
   * difference between "no usage" and "no data source".
   */
  async getUsageSummary(filter: UsageAnalyticsFilter = {}): Promise<UsageSummary> {
    const empty: UsageSummary = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCostUsdCents: 0,
      totalCostUsd: 0,
      totalRequests: 0,
      avgDurationMs: null,
      errorCount: 0,
      errorRate: 0,
      errorBreakdown: [],
      timeSeries: [],
      modelBreakdown: [],
      providerBreakdown: [],
      userBreakdown: [],
      coverage: {
        turns: 0,
        attributedTurns: 0,
        pricedTurns: 0,
        unpricedTurns: 0,
        estimatedTurns: 0,
        zeroUsageTurns: 0,
        reroutedTurns: 0,
      },
    };

    const dataSource = this.dataSource;
    if (!dataSource) return empty;

    const { clause, params } = this.buildWhere(filter);
    // A parallel filter for the failures table. It cannot reuse `clause`: that one
    // is written against `m.` aliases and carries the message-only predicates
    // (`role = 'assistant'`, a usage envelope present) which a failure row has no
    // concept of.
    const { clause: failureClause, params: failureParams } = this.buildFailureWhere(filter);
    const proms = promptTokensSql();
    const [
      totalsRows, timeSeriesRows, modelRows, providerRows, userRows, coverageRows,
      failureTotalsRows, failureBreakdownRows, failureDailyRows,
    ] =
      await Promise.all([
        dataSource.query(
          `SELECT
             COUNT(*)::bigint                                                  AS requests,
             COALESCE(SUM(${proms}), 0)                                        AS prompt_tokens,
             COALESCE(SUM(${comps}), 0)                                        AS completion_tokens,
             COALESCE(SUM(${proms} + ${comps}), 0)                             AS total_tokens,
             COALESCE(SUM(m.cost_usd_cents), 0)                                AS cost_cents,
             AVG(m.duration_ms)                                                AS avg_duration
           FROM reactor_conversation_messages m
          WHERE ${clause}`,
          params
        ),
        dataSource.query(
          `SELECT
             to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD')            AS date,
             COALESCE(SUM(${proms}), 0)                                        AS prompt_tokens,
             COALESCE(SUM(${comps}), 0)                                        AS completion_tokens,
             COALESCE(SUM(${proms} + ${comps}), 0)                             AS total_tokens,
             COALESCE(SUM(m.cost_usd_cents), 0)                                AS cost_cents,
             COUNT(*)::bigint                                                  AS requests
           FROM reactor_conversation_messages m
          WHERE ${clause}
          GROUP BY 1
          ORDER BY 1`,
          params
        ),
        dataSource.query(
          `SELECT
             COALESCE(m.model_id, 'unknown')                                   AS model,
             COALESCE(m.provider_id, 'unknown')                                AS provider,
             COALESCE(SUM(${proms}), 0)                                        AS prompt_tokens,
             COALESCE(SUM(${comps}), 0)                                        AS completion_tokens,
             COALESCE(SUM(${proms} + ${comps}), 0)                             AS total_tokens,
             COALESCE(SUM(m.cost_usd_cents), 0)                                AS cost_cents,
             COUNT(*)::bigint                                                  AS requests
           FROM reactor_conversation_messages m
          WHERE ${clause}
          GROUP BY 1, 2
          ORDER BY total_tokens DESC`,
          params
        ),
        dataSource.query(
          `SELECT
             COALESCE(m.provider_id, 'unknown')                                AS provider,
             COALESCE(SUM(${proms} + ${comps}), 0)                             AS total_tokens,
             COALESCE(SUM(m.cost_usd_cents), 0)                                AS cost_cents,
             COUNT(*)::bigint                                                  AS requests
           FROM reactor_conversation_messages m
          WHERE ${clause}
          GROUP BY 1
          ORDER BY total_tokens DESC`,
          params
        ),
        // Only meaningful for an unscoped view: a single-user report has no
        // breakdown to show, and computing it would be wasted work.
        filter.userId
          ? Promise.resolve([])
          : dataSource.query(
              `SELECT
                 m.user_id                                                      AS user_id,
                 COALESCE(SUM(${proms} + ${comps}), 0)                          AS total_tokens,
                 COALESCE(SUM(m.cost_usd_cents), 0)                             AS cost_cents,
                 COUNT(*)::bigint                                               AS requests
               FROM reactor_conversation_messages m
              WHERE ${clause}
                AND m.user_id IS NOT NULL
              GROUP BY 1
              ORDER BY total_tokens DESC
              LIMIT 20`,
              params
            ),
        dataSource.query(
          `SELECT
             COUNT(*)::bigint                                                       AS turns,
             COUNT(m.provider_id)::bigint                                           AS attributed_turns,
             COUNT(m.cost_usd_cents)::bigint                                        AS priced_turns,
             (COUNT(*) - COUNT(m.cost_usd_cents))::bigint                           AS unpriced_turns,
             COUNT(*) FILTER (WHERE m.usage_source = 'estimated')::bigint           AS estimated_turns,
             COUNT(*) FILTER (WHERE (${proms} + ${comps}) = 0)::bigint              AS zero_usage_turns,
             COUNT(*) FILTER (
               WHERE m.session_provider_id IS NOT NULL
                 AND m.provider_id IS NOT NULL
                 AND lower(m.session_provider_id) <> lower(m.provider_id)
             )::bigint                                                              AS rerouted_turns
           FROM reactor_conversation_messages m
          WHERE ${clause}`,
          params
        ),
        // Failures. Three queries against `reactor_ai_failures`, independent of the
        // message aggregations above — the whole reason that table is separate is so
        // this is additive rather than another special case inside the usage maths.
        dataSource.query(
          `SELECT
             COUNT(*)::bigint                                                AS failures,
             COUNT(*) FILTER (WHERE f.retryable)::bigint                     AS retryable_failures,
             COALESCE(SUM(f.attempts), 0)::bigint                            AS total_attempts
           FROM reactor_ai_failures f
          WHERE ${failureClause}`,
          failureParams
        ),
        dataSource.query(
          `SELECT
             COALESCE(f.provider_id, 'unknown')                              AS provider,
             COALESCE(f.model_id, 'unknown')                                 AS model,
             COUNT(*)::bigint                                                AS failures,
             COUNT(*) FILTER (WHERE f.retryable)::bigint                     AS retryable_failures,
             COALESCE(SUM(f.attempts), 0)::bigint                            AS total_attempts,
             (ARRAY_AGG(f.error_code ORDER BY f.created_at DESC))[1]         AS last_error_code,
             (ARRAY_AGG(f.error_message ORDER BY f.created_at DESC))[1]      AS last_error_message
           FROM reactor_ai_failures f
          WHERE ${failureClause}
          GROUP BY 1, 2
          ORDER BY failures DESC
          LIMIT 20`,
          failureParams
        ),
        dataSource.query(
          `SELECT
             to_char(date_trunc('day', f.created_at), 'YYYY-MM-DD')          AS date,
             COUNT(*)::bigint                                                AS failures
           FROM reactor_ai_failures f
          WHERE ${failureClause}
          GROUP BY 1`,
          failureParams
        ),
      ]);

    const totals = totalsRows?.[0] ?? {};
    const coverage = coverageRows?.[0] ?? {};

    const totalCostUsdCents = toNumber(totals.cost_cents);

    const failureTotals = {
      failures: toNumber(failureTotalsRows?.[0]?.failures),
      retryableFailures: toNumber(failureTotalsRows?.[0]?.retryable_failures),
      totalAttempts: toNumber(failureTotalsRows?.[0]?.total_attempts),
    };

    // Bucketed by date so the trend can carry failures beside token volume.
    const failuresByDate = new Map<string, number>(
      (failureDailyRows ?? []).map((row: any) => [String(row.date), toNumber(row.failures)])
    );

    const totalRequests = toNumber(totals.requests);

    return {
      totalPromptTokens: toNumber(totals.prompt_tokens),
      totalCompletionTokens: toNumber(totals.completion_tokens),
      totalTokens: toNumber(totals.total_tokens),
      totalCostUsdCents,
      totalCostUsd: centsToUsd(totalCostUsdCents),
      totalRequests: toNumber(totals.requests),
      avgDurationMs:
        totals.avg_duration === null || totals.avg_duration === undefined
          ? null
          : Math.round(toNumber(totals.avg_duration)),
      // Failed turns, from `reactor_ai_failures`.
      //
      // This field was previously a hardcoded 0 with a comment explaining that
      // failures were never recorded anywhere — which meant the one dashboard meant
      // to reveal "the AI is failing" could not. It now counts real rows.
      errorCount: failureTotals.failures,
      // Failures as a share of all turns attempted.
      //
      // The rate, not the count, is the figure worth acting on: a raw count scales
      // with traffic, so it says more about how busy the window was than about
      // reliability. Rounded to 6dp to keep the JSON stable across runs.
      errorRate:
        failureTotals.failures + totalRequests > 0
          ? Math.round(
              (failureTotals.failures / (failureTotals.failures + totalRequests)) * 1_000_000
            ) / 1_000_000
          : 0,
      errorBreakdown: (failureBreakdownRows ?? []).map((row: any) => ({
        provider: String(row.provider),
        model: String(row.model),
        failures: toNumber(row.failures),
        retryableFailures: toNumber(row.retryable_failures),
        totalAttempts: toNumber(row.total_attempts),
        lastErrorCode: row.last_error_code ?? null,
        lastErrorMessage: row.last_error_message ?? null,
      })),
      timeSeries: (() => {
        const points: any[] = (timeSeriesRows ?? []).map((row: any) => {
          const costUsdCents = toNumber(row.cost_cents);
          return {
            date: String(row.date),
            promptTokens: toNumber(row.prompt_tokens),
            completionTokens: toNumber(row.completion_tokens),
            totalTokens: toNumber(row.total_tokens),
            costUsdCents,
            costUsd: centsToUsd(costUsdCents),
            requests: toNumber(row.requests),
            // Joined from the failures query rather than selected alongside: the two
            // tables share only the date bucket.
            failures: failuresByDate.get(String(row.date)) ?? 0,
          };
        });

        // A day on which *everything* failed has no successful turns, so it is
        // absent from the message-derived series entirely. An outage must not be
        // invisible on the very chart meant to show it, so failure-only days are
        // added as zero-token points.
        const seen = new Set<string>(points.map((point) => point.date));
        for (const [date, failures] of failuresByDate.entries()) {
          if (seen.has(date)) continue;
          points.push({
            date,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costUsdCents: 0,
            costUsd: 0,
            requests: 0,
            failures,
          });
        }

        return points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      })(),
      modelBreakdown: (modelRows ?? []).map((row: any) => {
        const costUsdCents = toNumber(row.cost_cents);
        return {
          model: String(row.model),
          provider: String(row.provider),
          promptTokens: toNumber(row.prompt_tokens),
          completionTokens: toNumber(row.completion_tokens),
          totalTokens: toNumber(row.total_tokens),
          costUsdCents,
          costUsd: centsToUsd(costUsdCents),
          requests: toNumber(row.requests),
        };
      }),
      providerBreakdown: (providerRows ?? []).map((row: any) => {
        const costUsdCents = toNumber(row.cost_cents);
        return {
          provider: String(row.provider),
          totalTokens: toNumber(row.total_tokens),
          costUsdCents,
          costUsd: centsToUsd(costUsdCents),
          requests: toNumber(row.requests),
        };
      }),
      userBreakdown: (userRows ?? []).map((row: any) => {
        const costUsdCents = toNumber(row.cost_cents);
        return {
          userId: String(row.user_id),
          totalTokens: toNumber(row.total_tokens),
          costUsdCents,
          costUsd: centsToUsd(costUsdCents),
          requests: toNumber(row.requests),
        };
      }),
      coverage: {
        turns: toNumber(coverage.turns),
        attributedTurns: toNumber(coverage.attributed_turns),
        pricedTurns: toNumber(coverage.priced_turns),
        unpricedTurns: toNumber(coverage.unpriced_turns),
        estimatedTurns: toNumber(coverage.estimated_turns),
        zeroUsageTurns: toNumber(coverage.zero_usage_turns),
        reroutedTurns: toNumber(coverage.rerouted_turns),
      },
    };
  }

  /** Paginated per-turn ledger, newest first. */
  async getUsageList(
    filter: UsageAnalyticsFilter = {},
    page = 1,
    pageSize = 20
  ): Promise<UsageLedgerPage> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize =
      Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 200) : 20;

    const blank: UsageLedgerPage = {
      records: [],
      total: 0,
      page: safePage,
      pageSize: safeSize,
      hasNext: false,
    };

    const dataSource = this.dataSource;
    if (!dataSource) return blank;

    const { clause, params } = this.buildWhere(filter);
    const proms = promptTokensSql();
    const comps = completionTokensSql();

    const offset = (safePage - 1) * safeSize;
    // Bound parameters continue after the filter's, so the limit/offset indexes
    // are derived from the parameter count rather than hardcoded.
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const [rows, countRows] = await Promise.all([
      dataSource.query(
        `SELECT
           m.mongo_id                                                        AS id,
           m.user_id,
           m.persona_id,
           m.provider_id,
           m.model_id,
           ${proms}                                                          AS prompt_tokens,
           ${comps}                                                          AS completion_tokens,
           (${proms} + ${comps})                                             AS total_tokens,
           m.cost_usd_cents,
           m.duration_ms,
           m.use_case,
           m.usage_source,
           m.created_at
         FROM reactor_conversation_messages m
        WHERE ${clause}
        ORDER BY m.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...params, safeSize, offset]
      ),
      dataSource.query(
        `SELECT COUNT(*)::bigint AS total
           FROM reactor_conversation_messages m
          WHERE ${clause}`,
        params
      ),
    ]);

    const total = toNumber(countRows?.[0]?.total);

    return {
      records: (rows ?? []).map((row: any) => {
        const costUsdCents = toNullableNumber(row.cost_usd_cents);
        const promptTokens = toNumber(row.prompt_tokens);
        const completionTokens = toNumber(row.completion_tokens);
        // Only assistant turns carry usage, so a completed turn is a successful
        // one by construction. Retained for contract compatibility.
        return {
          id: row.id ? String(row.id) : '',
          userId: row.user_id ? String(row.user_id).trim() : null,
          personaId: row.persona_id ?? null,
          provider: row.provider_id ?? null,
          model: row.model_id ?? null,
          promptTokens,
          completionTokens,
          totalTokens: toNumber(row.total_tokens),
          costUsd: costUsdCents === null ? null : centsToUsd(costUsdCents),
          durationMs: toNullableNumber(row.duration_ms),
          use_case: row.use_case ?? null,
          usageSource: row.usage_source ?? null,
          status: 'success',
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        } as UsageLedgerRecord;
      }),
      total,
      page: safePage,
      pageSize: safeSize,
      hasNext: offset + (rows?.length ?? 0) < total,
    };
  }

  /**
   * Consumption for a user over an explicit window.
   *
   * Backs budget enforcement and the "used" columns on the budgets table. Read
   * from messages rather than from incrementing counters, because the counters
   * they replaced were only ever advanced as a side effect of the (never
   * persisted) ledger write, so every budget read 0 used.
   */
  async getConsumptionForUser(
    userId: string,
    window: { from: Date; to: Date }
  ): Promise<{ tokens: number; costUsd: number; turns: number }> {
    const dataSource = this.dataSource;
    if (!dataSource || !userId) return { tokens: 0, costUsd: 0, turns: 0 };

    const proms = promptTokensSql();
    const comps = completionTokensSql();

    const rows = await dataSource.query(
      `SELECT
         COALESCE(SUM(${proms} + ${comps}), 0) AS tokens,
         COALESCE(SUM(m.cost_usd_cents), 0)    AS cost_cents,
         COUNT(*)::bigint                      AS turns
       FROM reactor_conversation_messages m
      WHERE m.role = 'assistant'
        AND ${HAS_USAGE}
        AND m.user_id = $1
        AND m.created_at >= $2
        AND m.created_at < $3
        AND m.client_key = $4`,
      [String(userId).trim(), window.from, window.to, this.clientKey]
    );

    const row = rows?.[0] ?? {};
    const costUsdCents = toNumber(row.cost_cents);
    return {
      tokens: toNumber(row.tokens),
      costUsd: costUsdCents / 100,
      turns: toNumber(row.turns),
    };
  }

  /**
   * Record a failed AI turn.
   *
   * Called from the terminal failure path — after retries are exhausted — so a turn
   * that never produced output is still attributable. Before this existed, a failed
   * turn left no trace anywhere: `recordUsage` only ran on the success path and the
   * message log only holds completed turns. That is why `errorCount` read 0 by
   * construction rather than by accident, and why the dashboard meant to reveal
   * "the AI is failing" could not.
   *
   * BEST EFFORT — always returns a boolean and never throws.
   *
   * It is invoked from inside an error handler that is about to return a failure to
   * the user. A throw here would replace a clear provider error with an obscure
   * telemetry error at the worst possible moment, so every failure path is caught
   * and reported as `false`. The return value exists so that behaviour is assertable.
   */
  async recordFailure(input: {
    userId?: string | null;
    conversationId?: string | null;
    personaId?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    useCase?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryable?: boolean | null;
    attempts?: number | null;
    durationMs?: number | null;
    /** `user-turn` or `client-tool-continuation`, distinguishing where the spend was. */
    turnKind?: string | null;
  }): Promise<boolean> {
    const dataSource = this.dataSource;
    if (!dataSource) return false;

    try {
      await dataSource.query(
        `INSERT INTO reactor_ai_failures
           (user_id, conversation_id, persona_id, provider_id, model_id, use_case,
            error_code, error_message, retryable, attempts, duration_ms, turn_kind, client_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          bounded(input.userId, 24),
          bounded(input.conversationId, 24),
          bounded(input.personaId, 128),
          // Lower-cased so the column groups with the usage attribution's
          // `provider_id`, which the write path normalises the same way.
          bounded(input.providerId ? String(input.providerId).toLowerCase() : null, 128),
          bounded(input.modelId, 255),
          bounded(input.useCase, 64),
          bounded(input.errorCode, 64),
          bounded(input.errorMessage, 1000),
          input.retryable ?? null,
          boundedInt(input.attempts),
          boundedInt(input.durationMs, true),
          bounded(input.turnKind, 32),
          this.clientKey,
        ]
      );
      return true;
    } catch (err: any) {
      this.context.log?.(
        `Failed to record AI failure: ${err?.message}`,
        { errorCode: input.errorCode, providerId: input.providerId },
        'warning'
      );
      return false;
    }
  }

  toString?(includeVersion?: boolean): string {
    return `ReactorUsageAnalyticsService${includeVersion ? '@1.0.0' : ''}`;
  }

  description?: string =
    'Derives AI token usage, cost, latency and budget consumption from the Postgres conversation message log';
  tags?: string[] = ['ai', 'telemetry', 'tokens', 'budget', 'analytics', 'postgres'];
  nameSpace: string = 'reactor';
  name: string = 'Reactor Usage Analytics Service';
  version: string = '1.0.0';
}

export default ReactorUsageAnalyticsService;
