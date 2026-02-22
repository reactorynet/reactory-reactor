import { AddMacro } from '../addMacro.macro';
import { createMockState } from './support/mockState';

// Mock executeMacro (imported by addMacro but not directly used in tests)
jest.mock('../..', () => ({
  executeMacro: jest.fn(),
}));

describe('AddMacro', () => {
  it('should add a new macro to the state', async () => {
    const state = createMockState();
    const result: any = await AddMacro(
      {
        name: 'double',
        func: '(props) => Promise.resolve({ result: props.n * 2 })',
        description: 'Doubles a number',
        parameters: { n: { type: 'number', description: 'The number to double' } },
      },
      state,
    );

    expect(result.success).toBe(true);
    expect(result.operation).toBe('create');
    expect(result.macroName).toBe('double');
    expect(state.macros.length).toBe(1);
    expect(state.macros[0].name).toBe('double');
  });

  it('should fail when name is missing', async () => {
    const state = createMockState();
    const result: any = await AddMacro(
      { name: '', func: '() => {}', parameters: {} },
      state,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should fail when func is missing', async () => {
    const state = createMockState();
    const result: any = await AddMacro(
      { name: 'test', func: '', parameters: {} },
      state,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('should fail when func is not valid JavaScript', async () => {
    const state = createMockState();
    const result: any = await AddMacro(
      { name: 'bad', func: '{{invalid js}}', parameters: {} },
      state,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not create macro');
  });

  it('should fail when func does not evaluate to a function', async () => {
    const state = createMockState();
    const result: any = await AddMacro(
      { name: 'notfn', func: '"just a string"', parameters: {} },
      state,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a function');
  });
});
