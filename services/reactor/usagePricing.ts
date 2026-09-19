import { DataSource } from 'typeorm';
import { loadProviders, findModelById } from '../../ai/providers/provider-loader';

/**
 * Model pricing resolution for usage reporting.
 *
 * A single place that answers "what does this model cost?", so cost is computed
 * identically by the live write path and by the historical backfill. Before this
 * existed there were two answers: `ReactorAIUsageService.calculateCost` read
 * `providers.yaml`, and `reactory_ai_models` held its own rates in Postgres.
 * They could diverge silently, and — worse — an unknown model returned
 * `costUsdCents: 0`, so an unpriced model reported as *free* rather than as
 * *unknown*. That is a silent money error, so the contract here is deliberately
 * stricter:
 *
 *   - a priced model  -> rates and `source`
 *   - a local model   -> zero (genuinely free: it runs on our own hardware)
 *   - anything else   -> `null`, meaning "unknown", never `0`
 *
 * Callers must therefore decide what to do with `null` rather than have it
 * silently collapse to a free turn. Reporting counts those turns so the gap is
 * visible instead of flattering the bill.
 */

export type PricingSource = 'database' | 'static';

export interface ModelPricing {
  /** USD cents per input (prompt) token. */
  inputCostPerTokenUsdCents: number;
  /** USD cents per output (completion) token. */
  outputCostPerTokenUsdCents: number;
  /** Where the rates came from, for diagnostics. */
  source: PricingSource;
}

/**
 * Providers whose models run on our own infrastructure.
 *
 * Their absent price means "free" rather than "unknown", and conflating the two
 * is the distinction this module exists to preserve. Verified against
 * `reactory_ai_models`, where every Ollama/llama.cpp row carries NULL rates.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'llamacpp',
  'llama.cpp',
  'vllm',
  'local',
]);

/** Normalise a provider id for comparison: lower-case, trimmed. */
const normaliseProvider = (providerId?: string | null): string =>
  String(providerId ?? '').trim().toLowerCase();

/** Normalise a model id for comparison: trimmed, case preserved. */
const normaliseModel = (modelId?: string | null): string =>
  String(modelId ?? '').trim();

/** Whether a provider is one of ours, and therefore genuinely free to run. */
export const isLocalProvider = (providerId?: string | null): boolean =>
  LOCAL_PROVIDERS.has(normaliseProvider(providerId));

/** The zero-cost pricing used for local models. */
export const FREE_PRICING: ModelPricing = {
  inputCostPerTokenUsdCents: 0,
  outputCostPerTokenUsdCents: 0,
  source: 'static',
};

/**
 * Cost in USD cents for a turn.
 *
 * Rounded to 6 decimal places, matching the `NUMERIC(18,6)` column. Kept as a
 * pure function so the figure can be asserted in tests without a database.
 */
export const calculateCostUsdCents = (
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number
): number => {
  const prompt = Number.isFinite(promptTokens) ? Math.max(promptTokens, 0) : 0;
  const completion = Number.isFinite(completionTokens)
    ? Math.max(completionTokens, 0)
    : 0;

  const raw =
    prompt * pricing.inputCostPerTokenUsdCents +
    completion * pricing.outputCostPerTokenUsdCents;

  return Math.round(raw * 1_000_000) / 1_000_000;
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  // Postgres returns NUMERIC as a string; parse rather than trusting the type.
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Build pricing from a row/object whose rates may be absent or NULL. */
const pricingFromRates = (
  input: unknown,
  output: unknown,
  source: PricingSource
): ModelPricing | null => {
  const inputRate = toNumber(input);
  const outputRate = toNumber(output);

  // Both absent -> no usable price at all.
  if (inputRate === null && outputRate === null) return null;

  // One rate present and the other legitimately 0 is fine; treat a missing half
  // as 0 rather than discarding the half we do know.
  return {
    inputCostPerTokenUsdCents: inputRate ?? 0,
    outputCostPerTokenUsdCents: outputRate ?? 0,
    source,
  };
};

/**
 * Pricing from `providers.yaml`.
 *
 * The fallback source, kept because it is the registry the routers already read
 * and it covers models not yet synced into `reactory_ai_models`.
 */
export const resolvePricingFromStatic = (
  modelId?: string | null,
  providerId?: string | null
): ModelPricing | null => {
  const model = normaliseModel(modelId);
  if (!model) return null;

  try {
    const providers = loadProviders();
    const found = findModelById(providers, model);
    if (!found?.model) return null;

    // Prefer the entry belonging to the routed provider when the registry
    // carries the same model id under several providers with different rates.
    const isRoutedProvider =
      !providerId ||
      normaliseProvider(found.provider?.id) === normaliseProvider(providerId);

    const pricing = pricingFromRates(
      found.model.inputCostPerTokenUsdCents,
      found.model.outputCostPerTokenUsdCents,
      'static'
    );

    if (pricing && isRoutedProvider) return pricing;

    // The id resolved to a different provider than the one that served the
    // call. Rates for another provider's endpoint are not this turn's rates, so
    // report nothing rather than something wrong.
    return isRoutedProvider ? pricing : null;
  } catch {
    return null;
  }
};

/**
 * Pricing from `reactory_ai_models`.
 *
 * The primary source. Keyed on `(providerId, modelKey)` because the same model
 * id legitimately appears under several providers with different rates — `gpt-4`
 * exists under both `openai` and `azure-openai`, and only the former is priced.
 * Matching on the model id alone could therefore pick up the wrong row's rates.
 */
export const resolvePricingFromDatabase = async (
  dataSource: DataSource | null | undefined,
  modelId?: string | null,
  providerId?: string | null
): Promise<ModelPricing | null> => {
  const model = normaliseModel(modelId);
  if (!model || !dataSource?.isInitialized) return null;

  const provider = normaliseProvider(providerId);

  try {
    // Provider-scoped first, then any provider. `LIMIT 1` with an explicit
    // ordering keeps the result deterministic rather than whichever row the
    // planner happens to return first.
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      `SELECT "inputCostPerTokenUsdCents" AS input,
              "outputCostPerTokenUsdCents" AS output
         FROM reactory_ai_models
        WHERE "modelKey" = $1
          AND ("isEnabled" IS NULL OR "isEnabled" = true)
          AND ($2 = '' OR lower("providerId") = $2)
        ORDER BY (lower("providerId") = $2) DESC, "sortOrder" ASC NULLS LAST
        LIMIT 1`,
      [model, provider]
    );

    const row = rows?.[0];
    if (!row) return null;

    return pricingFromRates(row.input, row.output, 'database');
  } catch {
    // A pricing lookup must never break a turn; the caller treats null as
    // "unpriced" and reporting surfaces the gap.
    return null;
  }
};

export interface ResolvedPricing {
  /** `null` when the model could not be priced and is not local. */
  pricing: ModelPricing | null;
  /**
   * True when a cost of zero is legitimately zero rather than unknown.
   * Distinguishes an Ollama turn from an unrecognised paid model.
   */
  freeByDefinition: boolean;
}

/**
 * Resolve pricing for a model, preferring the database over the static registry.
 *
 * Local providers short-circuit: their absence of a price means free, and
 * consulting the registry for them would only risk matching an unrelated row.
 */
export const resolveModelPricing = async (
  dataSource: DataSource | null | undefined,
  modelId?: string | null,
  providerId?: string | null
): Promise<ResolvedPricing> => {
  if (isLocalProvider(providerId)) {
    return { pricing: FREE_PRICING, freeByDefinition: true };
  }

  const fromDatabase = await resolvePricingFromDatabase(
    dataSource,
    modelId,
    providerId
  );
  if (fromDatabase) {
    return {
      pricing: isSuspectZeroRate(fromDatabase, providerId) ? null : fromDatabase,
      freeByDefinition: false,
    };
  }

  const fromStatic = resolvePricingFromStatic(modelId, providerId);
  if (fromStatic) {
    return {
      pricing: isSuspectZeroRate(fromStatic, providerId) ? null : fromStatic,
      freeByDefinition: false,
    };
  }

  return { pricing: null, freeByDefinition: false };
};

/**
 * Whether a resolved rate pair is a *suspect* zero rather than a known zero.
 *
 * A paid provider whose registry row carries 0/0 is almost certainly missing its
 * rates rather than offering a free endpoint — `xai/grok-4.5` and `xai/grok-4.20`
 * read that way in the current data, reporting 97 turns at zero cost. Presenting
 * such a turn as costing nothing is precisely the silent-zero failure this module
 * exists to remove, so a zero rate from a non-local provider is treated as
 * *unknown* and counted in `coverage.unpricedTurns` instead.
 *
 * Local providers are exempt: for Ollama and llama.cpp the zero is real.
 */
export const isSuspectZeroRate = (
  pricing: ModelPricing,
  providerId?: string | null
): boolean =>
  !isLocalProvider(providerId) &&
  pricing.inputCostPerTokenUsdCents === 0 &&
  pricing.outputCostPerTokenUsdCents === 0;

/**
 * Extract token counts from a provider response envelope.
 *
 * Every stored envelope is the OpenAI `chat.completion` shape, so the camelCase
 * fields are the ones actually present. The snake_case variants are still read,
 * because they are what a raw provider SDK returns before adaption and the
 * adapters have changed casing across versions.
 *
 * The legacy ingest script read *only* the snake_case spellings, which matched
 * no row at all, and then fell through to estimating counts from content length
 * — fabricating figures and billing real money against them. Reading both
 * spellings and reporting which was used is what prevents a recurrence.
 */
export const extractUsage = (
  providerResponse: unknown
): { promptTokens: number; completionTokens: number; totalTokens: number; source: 'provider' | 'none' } => {
  const usage = (providerResponse as any)?.usage;
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'none' };
  }

  const readNumber = (...candidates: unknown[]): number => {
    for (const candidate of candidates) {
      const parsed = toNumber(candidate);
      if (parsed !== null) return parsed;
    }
    return 0;
  };

  const promptTokens = readNumber(
    usage.promptTokens,
    usage.prompt_tokens,
    usage.input_tokens
  );
  const completionTokens = readNumber(
    usage.completionTokens,
    usage.completion_tokens,
    usage.output_tokens
  );
  const totalTokens = readNumber(
    usage.totalTokens,
    usage.total_tokens,
    promptTokens + completionTokens
  );

  const hasAny = promptTokens > 0 || completionTokens > 0 || totalTokens > 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    source: hasAny ? 'provider' : 'none',
  };
};
