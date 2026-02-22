import { VariableMacro, SliceVariableMacro } from '../variableMacro.macro';
import { createMockState } from './support/mockState';

// Mock the logger
jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// Mock executeMacro for nested macro calls — return the same state to avoid losing vars
jest.mock('../..', () => ({
  executeMacro: jest.fn().mockImplementation((_macro: string, state: any) =>
    Promise.resolve({ value: 'nested-result', state, error: null }),
  ),
}));

describe('VariableMacro', () => {
  describe('set operation', () => {
    it('should set a variable in state.vars', async () => {
      const state = createMockState();
      const result: any = await VariableMacro({ key: 'color', value: 'blue' }, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('set');
      expect(result.key).toBe('color');
      expect(state.vars.color).toBe('blue');
    });

    it('should initialise vars if undefined', async () => {
      const state = createMockState({ vars: undefined as any });
      const result: any = await VariableMacro({ key: 'x', value: '1' }, state);

      expect(result.success).toBe(true);
      expect(state.vars.x).toBe('1');
    });

    it('should overwrite an existing variable', async () => {
      const state = createMockState();
      state.vars.name = 'Alice';
      const result: any = await VariableMacro({ key: 'name', value: 'Bob' }, state);

      expect(result.success).toBe(true);
      expect(state.vars.name).toBe('Bob');
    });
  });

  describe('get operation', () => {
    it('should return a variable value when value is omitted', async () => {
      const state = createMockState();
      state.vars.greeting = 'hello';
      const result: any = await VariableMacro({ key: 'greeting' }, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('get');
      expect(result.value).toBe('hello');
    });

    it('should return undefined for a non-existent variable', async () => {
      const state = createMockState();
      const result: any = await VariableMacro({ key: 'missing' }, state);

      expect(result.success).toBe(true);
      expect(result.value).toBeUndefined();
    });
  });

  describe('delete operation', () => {
    it('should delete a variable when value is "del"', async () => {
      const state = createMockState();
      state.vars.temp = 42;
      const result: any = await VariableMacro({ key: 'temp', value: 'del' }, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('delete');
      expect(state.vars.temp).toBeUndefined();
    });
  });

  describe('nested macro execution', () => {
    it('should execute a nested macro when value starts with @', async () => {
      const state = createMockState();
      const result: any = await VariableMacro({ key: 'data', value: '@someMacro(arg)' }, state);

      expect(result.success).toBe(true);
      expect(state.vars.data).toBe('nested-result');
    });
  });

  describe('error handling', () => {
    it('should return an error when state is null', async () => {
      const result: any = await VariableMacro({ key: 'x', value: '1' }, null as any);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

describe('SliceVariableMacro', () => {
  describe('array slicing', () => {
    it('should slice an array by range', async () => {
      const state = createMockState();
      state.vars.numbers = [10, 20, 30, 40, 50];
      const result: any = await SliceVariableMacro(
        { variableName: 'numbers', predicate: '0:3' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.slicedData).toEqual([10, 20, 30]);
    });

    it('should select specific indices from an array', async () => {
      const state = createMockState();
      state.vars.letters = ['a', 'b', 'c', 'd', 'e'];
      const result: any = await SliceVariableMacro(
        { variableName: 'letters', predicate: '0,2,4' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.slicedData).toEqual(['a', 'c', 'e']);
    });

    it('should store sliced result in a target variable', async () => {
      const state = createMockState();
      state.vars.items = [1, 2, 3, 4];
      const result: any = await SliceVariableMacro(
        { variableName: 'items', predicate: '0:2', targetVariable: 'sliced' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe('store');
      expect(state.vars.sliced).toEqual([1, 2]);
    });
  });

  describe('object slicing', () => {
    it('should extract a nested property path', async () => {
      const state = createMockState();
      state.vars.config = { db: { host: 'localhost', port: 5432 } };
      const result: any = await SliceVariableMacro(
        { variableName: 'config', predicate: 'db.host' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.slicedData).toBe('localhost');
    });

    it('should extract multiple properties by comma-separated names', async () => {
      const state = createMockState();
      state.vars.person = { name: 'Alice', age: 30, email: 'a@b.com', phone: '555' };
      const result: any = await SliceVariableMacro(
        { variableName: 'person', predicate: 'name,email' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.slicedData).toEqual({ name: 'Alice', email: 'a@b.com' });
    });
  });

  describe('string slicing', () => {
    it('should slice a string by range', async () => {
      const state = createMockState();
      state.vars.text = 'Hello, World!';
      const result: any = await SliceVariableMacro(
        { variableName: 'text', predicate: '0:5' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.slicedData).toBe('Hello');
    });
  });

  describe('error handling', () => {
    it('should fail when the source variable does not exist', async () => {
      const state = createMockState();
      const result: any = await SliceVariableMacro(
        { variableName: 'nope', predicate: '0:1' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when state or vars is not defined', async () => {
      const state = createMockState({ vars: undefined as any });
      const result: any = await SliceVariableMacro(
        { variableName: 'x', predicate: '0:1' },
        state,
      );

      expect(result.success).toBe(false);
    });
  });
});
