import { ObjectId } from 'mongodb';
import { __testing } from '../BackfillUsage';

const { extractUsageFromHistory, parseArgs } = __testing;

describe('extractUsageFromHistory', () => {
  it('returns null when there is no response', () => {
    expect(extractUsageFromHistory({ role: 'assistant' })).toBeNull();
  });

  it('returns null when response.usage is missing', () => {
    expect(extractUsageFromHistory({ role: 'assistant', response: {} })).toBeNull();
  });

  it('handles already-normalized camelCase shape', () => {
    const item = {
      role: 'assistant',
      response: {
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedPromptTokens: 20,
        },
      },
    };
    expect(extractUsageFromHistory(item)).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedPromptTokens: 20,
    });
  });

  it('handles OpenAI snake_case shape with cached tokens', () => {
    const item = {
      role: 'assistant',
      response: {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
    };
    expect(extractUsageFromHistory(item)).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cachedPromptTokens: 800,
    });
  });

  it('handles OpenAI shape with reasoning tokens', () => {
    const item = {
      role: 'assistant',
      response: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 500,
          total_tokens: 600,
          completion_tokens_details: { reasoning_tokens: 200 },
        },
      },
    };
    expect(extractUsageFromHistory(item)).toEqual({
      promptTokens: 100,
      completionTokens: 500,
      totalTokens: 600,
      reasoningTokens: 200,
    });
  });

  it('handles Anthropic input_tokens/output_tokens shape', () => {
    const item = {
      role: 'assistant',
      response: {
        usage: {
          input_tokens: 1500,
          output_tokens: 200,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 500,
        },
      },
    };
    expect(extractUsageFromHistory(item)).toEqual({
      promptTokens: 1500,
      completionTokens: 200,
      totalTokens: 1700,
      cachedPromptTokens: 1000,
      cacheWriteTokens: 500,
    });
  });

  it('falls back to total = input + output when total_tokens is missing', () => {
    const item = {
      role: 'assistant',
      response: { usage: { prompt_tokens: 30, completion_tokens: 10 } },
    };
    expect(extractUsageFromHistory(item)).toEqual({
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
    });
  });
});

describe('parseArgs', () => {
  it('returns defaults with no flags', () => {
    const a = parseArgs([]);
    expect(a).toEqual({
      dryRun: false,
      since: null,
      userId: null,
      batchSize: 500,
      verbose: false,
    });
  });

  it('parses --dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --since=YYYY-MM-DD', () => {
    const a = parseArgs(['--since=2026-01-01']);
    expect(a.since).toBeInstanceOf(Date);
    expect(a.since!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws on invalid --since', () => {
    expect(() => parseArgs(['--since=not-a-date'])).toThrow(/Invalid --since/);
  });

  it('parses --user=hexId to ObjectId', () => {
    const id = new ObjectId().toHexString();
    const a = parseArgs([`--user=${id}`]);
    expect(a.userId).toBeInstanceOf(ObjectId);
    expect(a.userId!.toHexString()).toBe(id);
  });

  it('parses --batch=N', () => {
    expect(parseArgs(['--batch=50']).batchSize).toBe(50);
  });

  it('throws on non-numeric --batch', () => {
    expect(() => parseArgs(['--batch=abc'])).toThrow(/Invalid --batch/);
  });

  it('parses --verbose alias', () => {
    expect(parseArgs(['--verbose']).verbose).toBe(true);
    expect(parseArgs(['-v']).verbose).toBe(true);
  });
});
