import MacroDefinitions from '../macro';

const [, IndexContentMacroDefinition] = MacroDefinitions;

function makeState(indexImpl: (index: string, documents: any[]) => Promise<any>) {
  const mockContext = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    getService: jest.fn().mockReturnValue({
      index: jest.fn(indexImpl),
    }),
  };
  return { context: mockContext, vars: {} } as any;
}

describe('IndexContent Macro Definition — follow-up C: input-side sanity caps', () => {
  it('should describe the document limits in the tool schema', () => {
    expect(IndexContentMacroDefinition.name).toBe('IndexContent');
    const tool = IndexContentMacroDefinition.tools[0];
    expect(tool.function.parameters.properties.documents.description).toContain('500 documents');
  });

  it('rejects an empty documents array (existing validation, unchanged)', async () => {
    const state = makeState(async () => ({ success: true, id: 'idx' }));
    const result: any = await (IndexContentMacroDefinition.component as any)(
      { index: 'test-index', documents: [] },
      state
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be empty');
  });

  it('rejects a batch exceeding the per-call document count cap', async () => {
    const state = makeState(async () => ({ success: true, id: 'idx' }));
    const documents = Array.from({ length: 501 }, (_, i) => ({ id: `doc-${i}`, content: 'x' }));

    const result: any = await (IndexContentMacroDefinition.component as any)(
      { index: 'test-index', documents },
      state
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Too many documents');
    expect(result.instructions).toContain('Batch Too Large');
    // Must fail BEFORE calling the search service — no partial/inconsistent indexing.
    expect(state.context.getService().index).not.toHaveBeenCalled();
  });

  it('accepts a batch at exactly the document count cap', async () => {
    const state = makeState(async () => ({ success: true, id: 'idx' }));
    const documents = Array.from({ length: 500 }, (_, i) => ({ id: `doc-${i}`, content: 'x' }));

    const result: any = await (IndexContentMacroDefinition.component as any)(
      { index: 'test-index', documents },
      state
    );

    expect(result.success).toBe(true);
  });

  it('rejects a payload exceeding the combined character budget even with few documents', async () => {
    const state = makeState(async () => ({ success: true, id: 'idx' }));
    // A small number of documents but each carrying a huge field — total
    // stringified size must be what triggers this guard, not document count.
    const documents = [
      { id: 'doc-1', content: 'X'.repeat(6_000_000) },
    ];

    const result: any = await (IndexContentMacroDefinition.component as any)(
      { index: 'test-index', documents },
      state
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
    expect(result.instructions).toContain('Payload Too Large');
    expect(state.context.getService().index).not.toHaveBeenCalled();
  });

  it('proceeds normally for a small, well-formed batch', async () => {
    const state = makeState(async () => ({ success: true, id: 'test-index' }));
    const documents = [{ id: 'doc-1', content: 'hello world' }];

    const result: any = await (IndexContentMacroDefinition.component as any)(
      { index: 'test-index', documents },
      state
    );

    expect(result.success).toBe(true);
    expect(result.data.indexedCount).toBe(1);
  });
});
