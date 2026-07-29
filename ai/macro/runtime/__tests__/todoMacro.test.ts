import { TodoMacro } from '../todoMacro.macro';
import { createMockState } from './support/mockState';

jest.mock('@reactory/server-core/logging', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

describe('TodoMacro', () => {
  // ── CREATE ──────────────────────────────────────────────
  describe('create', () => {
    it('should create a new todo list with defaults', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'create', name: 'Sprint 1' }, state);

      expect(result.success).toBe(true);
      expect(result.operation).toBe('create');
      expect(result.list.name).toBe('Sprint 1');
      expect(result.list.executionMode).toBe('series');
      expect(result.list.items).toEqual([]);
      expect(result.listId).toBeDefined();
    });

    it('should create a parallel list', async () => {
      const state = createMockState();
      const result: any = await TodoMacro(
        { action: 'create', name: 'Parallel Work', executionMode: 'parallel' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.list.executionMode).toBe('parallel');
    });

    it('should default name to "Untitled" when omitted', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'create' }, state);

      expect(result.list.name).toBe('Untitled');
    });
  });

  // ── ADD ─────────────────────────────────────────────────
  describe('add', () => {
    it('should add a todo item to an existing list', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'My List' }, state);
      const listId = created.listId;

      const result: any = await TodoMacro(
        { action: 'add', listId, title: 'Write tests', description: 'Unit tests for macros' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe('add');
      expect(result.todo.title).toBe('Write tests');
      expect(result.todo.status).toBe('pending');
      expect(result.todo.description).toBe('Unit tests for macros');
    });

    it('should set assignee on add when provided', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Delegation' }, state);

      const result: any = await TodoMacro(
        { action: 'add', listId: created.listId, title: 'Review PR', assignee: 'claude-persona' },
        state,
      );

      expect(result.todo.assignee).toBe('claude-persona');
    });

    it('should fail when listId is missing', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'add', title: 'Oops' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('listId');
    });

    it('should fail when list does not exist', async () => {
      const state = createMockState();
      const result: any = await TodoMacro(
        { action: 'add', listId: 'nonexistent', title: 'Oops' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when title is missing', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'X' }, state);
      const result: any = await TodoMacro({ action: 'add', listId: created.listId }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('title');
    });
  });

  // ── LIST ────────────────────────────────────────────────
  describe('list', () => {
    it('should return an empty array when no lists exist', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'list' }, state);

      expect(result.success).toBe(true);
      expect(result.lists).toEqual([]);
    });

    it('should return summaries with status counts', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Summary Test' }, state);
      const listId = created.listId;

      await TodoMacro({ action: 'add', listId, title: 'Task A' }, state);
      await TodoMacro({ action: 'add', listId, title: 'Task B' }, state);
      // Complete Task A
      const list = (await TodoMacro({ action: 'get', listId }, state) as any).list;
      await TodoMacro(
        { action: 'update', listId, todoId: list.items[0].id, status: 'completed' },
        state,
      );

      const result: any = await TodoMacro({ action: 'list' }, state);

      expect(result.lists).toHaveLength(1);
      expect(result.lists[0].totalItems).toBe(2);
      expect(result.lists[0].completed).toBe(1);
      expect(result.lists[0].pending).toBe(1);
    });
  });

  // ── GET ─────────────────────────────────────────────────
  describe('get', () => {
    it('should return the full list with items', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Get Test' }, state);
      await TodoMacro({ action: 'add', listId: created.listId, title: 'Item 1' }, state);

      const result: any = await TodoMacro({ action: 'get', listId: created.listId }, state);

      expect(result.success).toBe(true);
      expect(result.list.items).toHaveLength(1);
      expect(result.list.items[0].title).toBe('Item 1');
    });

    it('should fail without listId', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'get' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('listId');
    });

    it('should fail for a non-existent list', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'get', listId: 'nope' }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ── UPDATE ──────────────────────────────────────────────
  describe('update', () => {
    it('should update the status of a todo item', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Update Test' }, state);
      const added: any = await TodoMacro(
        { action: 'add', listId: created.listId, title: 'Do something' },
        state,
      );

      const result: any = await TodoMacro(
        { action: 'update', listId: created.listId, todoId: added.todo.id, status: 'in_progress' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.todo.status).toBe('in_progress');
    });

    it('should update description and result', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'U2' }, state);
      const added: any = await TodoMacro(
        { action: 'add', listId: created.listId, title: 'Task' },
        state,
      );

      const result: any = await TodoMacro(
        {
          action: 'update',
          listId: created.listId,
          todoId: added.todo.id,
          description: 'Updated desc',
          result: 'some output',
          status: 'completed',
        },
        state,
      );

      expect(result.todo.description).toBe('Updated desc');
      expect(result.todo.result).toBe('some output');
      expect(result.todo.status).toBe('completed');
    });

    it('should fail without listId', async () => {
      const state = createMockState();
      const result: any = await TodoMacro(
        { action: 'update', todoId: 'x', status: 'completed' },
        state,
      );

      expect(result.success).toBe(false);
    });

    it('should fail without todoId', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'X' }, state);
      const result: any = await TodoMacro(
        { action: 'update', listId: created.listId, status: 'completed' },
        state,
      );

      expect(result.success).toBe(false);
    });

    it('should fail for a non-existent todo item', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'X' }, state);
      await TodoMacro({ action: 'add', listId: created.listId, title: 'T' }, state);

      const result: any = await TodoMacro(
        { action: 'update', listId: created.listId, todoId: 'nope', status: 'completed' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ── ASSIGN ──────────────────────────────────────────────
  describe('assign', () => {
    it('should assign a todo item to an agent', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Assign Test' }, state);
      const added: any = await TodoMacro(
        { action: 'add', listId: created.listId, title: 'Delegated task' },
        state,
      );

      const result: any = await TodoMacro(
        { action: 'assign', listId: created.listId, todoId: added.todo.id, assignee: 'code-reviewer-agent' },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe('assign');
      expect(result.assignee).toBe('code-reviewer-agent');
      expect(result.todo.assignee).toBe('code-reviewer-agent');
    });

    it('should fail without assignee', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'A' }, state);
      const added: any = await TodoMacro(
        { action: 'add', listId: created.listId, title: 'T' },
        state,
      );

      const result: any = await TodoMacro(
        { action: 'assign', listId: created.listId, todoId: added.todo.id },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('assignee');
    });

    it('should fail for non-existent list', async () => {
      const state = createMockState();
      const result: any = await TodoMacro(
        { action: 'assign', listId: 'nope', todoId: 'x', assignee: 'agent' },
        state,
      );

      expect(result.success).toBe(false);
    });
  });

  // ── REMOVE ──────────────────────────────────────────────
  describe('remove', () => {
    it('should remove a todo item from the list', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Remove Test' }, state);
      const added: any = await TodoMacro(
        { action: 'add', listId: created.listId, title: 'Temp task' },
        state,
      );

      const result: any = await TodoMacro(
        { action: 'remove', listId: created.listId, todoId: added.todo.id },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe('remove');
      expect(result.removedTodo.title).toBe('Temp task');

      // Verify it's gone
      const listResult: any = await TodoMacro({ action: 'get', listId: created.listId }, state);
      expect(listResult.list.items).toHaveLength(0);
    });

    it('should fail for a non-existent todo item', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'R' }, state);

      const result: any = await TodoMacro(
        { action: 'remove', listId: created.listId, todoId: 'ghost' },
        state,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ── EDGE CASES ──────────────────────────────────────────
  describe('edge cases', () => {
    it('should fail for an unknown action', async () => {
      const state = createMockState();
      const result: any = await TodoMacro({ action: 'explode' as any }, state);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('should fail when state is null', async () => {
      const result: any = await TodoMacro({ action: 'list' }, null as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Chat state');
    });

    it('should store todos under reactor.todos in state.vars', async () => {
      const state = createMockState();
      await TodoMacro({ action: 'create', name: 'Var Check' }, state);

      expect(state.vars['reactor.todos']).toBeDefined();
      expect(Object.keys(state.vars['reactor.todos'] as object).length).toBe(1);
    });
  });

  // ── TRUNCATION ──────────────────────────────────────────
  describe('truncation', () => {
    it('should safely truncate long description on add', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Truncation Test' }, state);
      const listId = created.listId;

      const longDescription = 'a'.repeat(3000);
      const result: any = await TodoMacro(
        { action: 'add', listId, title: 'Long Desc Task', description: longDescription },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.todo.description.length).toBeLessThan(2500);
      expect(result.todo.description).toContain('TRUNCATED');
    });

    it('should safely truncate long description on update', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Truncation Test 2' }, state);
      const listId = created.listId;

      const added: any = await TodoMacro({ action: 'add', listId, title: 'Task' }, state);
      const todoId = added.todo.id;

      const longDescription = 'b'.repeat(3000);
      const result: any = await TodoMacro(
        { action: 'update', listId, todoId, description: longDescription },
        state,
      );

      expect(result.success).toBe(true);
      expect(result.todo.description.length).toBeLessThan(2500);
      expect(result.todo.description).toContain('TRUNCATED');
    });

    it('should safely truncate long result object on update', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Truncation Test 3' }, state);
      const listId = created.listId;

      const added: any = await TodoMacro({ action: 'add', listId, title: 'Task' }, state);
      const todoId = added.todo.id;

      const hugeObjectResult = {
        data: 'c'.repeat(3000),
      };

      const result: any = await TodoMacro(
        { action: 'update', listId, todoId, result: hugeObjectResult },
        state,
      );

      expect(result.success).toBe(true);
      expect(typeof result.todo.result).toBe('string');
      expect((result.todo.result as string).length).toBeLessThan(2500);
      expect(result.todo.result).toContain('TRUNCATED');
    });

    it('should not truncate short result object on update', async () => {
      const state = createMockState();
      const created: any = await TodoMacro({ action: 'create', name: 'Truncation Test 4' }, state);
      const listId = created.listId;

      const added: any = await TodoMacro({ action: 'add', listId, title: 'Task' }, state);
      const todoId = added.todo.id;

      const smallObjectResult = {
        data: 'short',
      };

      const result: any = await TodoMacro(
        { action: 'update', listId, todoId, result: smallObjectResult },
        state,
      );

      expect(result.success).toBe(true);
      expect(typeof result.todo.result).toBe('object');
      expect(result.todo.result).toEqual(smallObjectResult);
    });
  });
});
