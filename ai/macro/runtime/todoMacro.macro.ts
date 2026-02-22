import Reactory from "@reactorynet/reactory-core";
import { ChatState, Macro, MacroComponentDefinition } from "../../../types/chat";
import {
  TodoMacroProps,
  TodoList,
  TodoItem,
  TodoStatus,
  TodoExecutionMode,
} from './types';
import logger from '@reactory/server-core/logging';

const TODOS_VAR_PREFIX = 'reactor.todos';

/**
 * Generate a short unique id for todo items and lists.
 */
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Retrieve all todo lists from state vars.
 */
function getTodoLists(state: ChatState): Record<string, TodoList> {
  if (!state.vars) state.vars = {};
  if (!state.vars[TODOS_VAR_PREFIX]) {
    state.vars[TODOS_VAR_PREFIX] = {} as Record<string, TodoList>;
  }
  return state.vars[TODOS_VAR_PREFIX] as Record<string, TodoList>;
}

/**
 * The TodoMacro allows an AI agent to create and manage todo lists
 * that can be executed in series or in parallel.
 *
 * It abstracts over the variable macro by storing structured todo lists
 * inside `state.vars["reactor.todos"]`.
 *
 * Supported actions:
 *  - create  – create a new todo list
 *  - list    – list all todo lists (summary)
 *  - get     – get a specific todo list with all items
 *  - add     – add a todo item to an existing list
 *  - update  – update a todo item (status, description, result)
 *  - assign  – assign a todo item to a persona / agent
 *  - remove  – remove a todo item from a list
 */
export const TodoMacro: Macro<unknown, TodoMacroProps> = async (
  props: TodoMacroProps,
  state: ChatState,
): Promise<unknown> => {
  const { action } = props;

  try {
    if (!state) {
      return { error: 'Chat state is not defined', success: false };
    }

    const lists = getTodoLists(state);
    const now = new Date().toISOString();

    switch (action) {
      // ── CREATE ──────────────────────────────────────────────
      case 'create': {
        const name = props.name || 'Untitled';
        const executionMode: TodoExecutionMode = props.executionMode || 'series';
        const id = generateId();

        const newList: TodoList = {
          id,
          name,
          executionMode,
          items: [],
          createdAt: now,
          updatedAt: now,
        };

        lists[id] = newList;

        logger.info(`TodoMacro: created list "${name}" (${id}) mode=${executionMode}`);
        return {
          success: true,
          operation: 'create',
          listId: id,
          list: newList,
        };
      }

      // ── LIST ────────────────────────────────────────────────
      case 'list': {
        const summaries = Object.values(lists).map((l) => ({
          id: l.id,
          name: l.name,
          executionMode: l.executionMode,
          totalItems: l.items.length,
          pending: l.items.filter((i) => i.status === 'pending').length,
          inProgress: l.items.filter((i) => i.status === 'in_progress').length,
          completed: l.items.filter((i) => i.status === 'completed').length,
          failed: l.items.filter((i) => i.status === 'failed').length,
        }));

        return {
          success: true,
          operation: 'list',
          lists: summaries,
        };
      }

      // ── GET ─────────────────────────────────────────────────
      case 'get': {
        if (!props.listId) {
          return { error: 'listId is required for the get action', success: false };
        }
        const list = lists[props.listId];
        if (!list) {
          return { error: `Todo list "${props.listId}" not found`, success: false };
        }

        return {
          success: true,
          operation: 'get',
          list,
        };
      }

      // ── ADD ─────────────────────────────────────────────────
      case 'add': {
        if (!props.listId) {
          return { error: 'listId is required for the add action', success: false };
        }
        const list = lists[props.listId];
        if (!list) {
          return { error: `Todo list "${props.listId}" not found`, success: false };
        }
        if (!props.title) {
          return { error: 'title is required when adding a todo item', success: false };
        }

        const todoItem: TodoItem = {
          id: generateId(),
          title: props.title,
          description: props.description,
          status: 'pending',
          assignee: props.assignee,
          createdAt: now,
          updatedAt: now,
        };

        list.items.push(todoItem);
        list.updatedAt = now;

        logger.info(`TodoMacro: added item "${todoItem.title}" to list ${list.id}`);
        return {
          success: true,
          operation: 'add',
          listId: list.id,
          todo: todoItem,
        };
      }

      // ── UPDATE ──────────────────────────────────────────────
      case 'update': {
        if (!props.listId) {
          return { error: 'listId is required for the update action', success: false };
        }
        if (!props.todoId) {
          return { error: 'todoId is required for the update action', success: false };
        }
        const list = lists[props.listId];
        if (!list) {
          return { error: `Todo list "${props.listId}" not found`, success: false };
        }

        const item = list.items.find((i) => i.id === props.todoId);
        if (!item) {
          return { error: `Todo item "${props.todoId}" not found in list "${props.listId}"`, success: false };
        }

        if (props.status) item.status = props.status;
        if (props.description !== undefined) item.description = props.description;
        if (props.result !== undefined) item.result = props.result;
        if (props.assignee !== undefined) item.assignee = props.assignee;
        item.updatedAt = now;
        list.updatedAt = now;

        logger.info(`TodoMacro: updated item "${item.id}" in list ${list.id}`);
        return {
          success: true,
          operation: 'update',
          listId: list.id,
          todo: item,
        };
      }

      // ── ASSIGN ──────────────────────────────────────────────
      case 'assign': {
        if (!props.listId) {
          return { error: 'listId is required for the assign action', success: false };
        }
        if (!props.todoId) {
          return { error: 'todoId is required for the assign action', success: false };
        }
        if (!props.assignee) {
          return { error: 'assignee is required for the assign action', success: false };
        }
        const list = lists[props.listId];
        if (!list) {
          return { error: `Todo list "${props.listId}" not found`, success: false };
        }

        const item = list.items.find((i) => i.id === props.todoId);
        if (!item) {
          return { error: `Todo item "${props.todoId}" not found in list "${props.listId}"`, success: false };
        }

        item.assignee = props.assignee;
        item.updatedAt = now;
        list.updatedAt = now;

        logger.info(`TodoMacro: assigned item "${item.id}" to "${props.assignee}"`);
        return {
          success: true,
          operation: 'assign',
          listId: list.id,
          todo: item,
          assignee: props.assignee,
        };
      }

      // ── REMOVE ──────────────────────────────────────────────
      case 'remove': {
        if (!props.listId) {
          return { error: 'listId is required for the remove action', success: false };
        }
        if (!props.todoId) {
          return { error: 'todoId is required for the remove action', success: false };
        }
        const list = lists[props.listId];
        if (!list) {
          return { error: `Todo list "${props.listId}" not found`, success: false };
        }

        const idx = list.items.findIndex((i) => i.id === props.todoId);
        if (idx === -1) {
          return { error: `Todo item "${props.todoId}" not found in list "${props.listId}"`, success: false };
        }

        const [removed] = list.items.splice(idx, 1);
        list.updatedAt = now;

        logger.info(`TodoMacro: removed item "${removed.id}" from list ${list.id}`);
        return {
          success: true,
          operation: 'remove',
          listId: list.id,
          removedTodo: removed,
        };
      }

      default:
        return {
          error: `Unknown action "${action}". Supported actions: create, list, get, add, update, assign, remove`,
          success: false,
        };
    }
  } catch (err) {
    return {
      error: `Error in todo macro: ${err instanceof Error ? err.message : 'Unknown error'}`,
      success: false,
    };
  }
};

export const TodoMacroRegistry: MacroComponentDefinition<typeof TodoMacro> = {
  nameSpace: 'reactor-macros',
  name: 'todo',
  alias: 'todo',
  version: '1.0.0',
  component: TodoMacro,
  roles: ['ADMIN', 'DEVELOPER', 'USER'],
  description: `# todo macro
  Use this macro to create and manage todo lists for planning and tracking work.

  Todo lists support series or parallel execution modes, enabling the
  ReactorConversationService to execute items sequentially or concurrently.

  ## Actions
  - **create** – Create a new todo list
  - **list**   – List all todo lists with status summaries
  - **get**    – Get a specific todo list with all items
  - **add**    – Add a todo item to an existing list
  - **update** – Update a todo item (status, description, result)
  - **assign** – Assign a todo item to an AI persona / agent
  - **remove** – Remove a todo item from a list

  ## Usage
  @todo(create, "My Plan", series)
  @todo(add, <listId>, "Implement feature X")
  @todo(update, <listId>, <todoId>, status=completed)
  @todo(assign, <listId>, <todoId>, reactor-persona-id)
  @todo(list)
  @todo(get, <listId>)
  @todo(remove, <listId>, <todoId>)
  `,
  features: [
    {
      feature: 'create',
      featureType: Reactory.FeatureType.function,
      action: ['create', 'new', 'init', 'start'],
      description: 'Create a new todo list.',
      stem: 'create'
    },
    {
      feature: 'add',
      featureType: Reactory.FeatureType.function,
      action: ['add', 'append', 'insert', 'push'],
      description: 'Add a todo item to an existing list.',
      stem: 'add'
    },
    {
      feature: 'update',
      featureType: Reactory.FeatureType.function,
      action: ['update', 'modify', 'change', 'set'],
      description: 'Update a todo item status, description, or result.',
      stem: 'update'
    },
    {
      feature: 'assign',
      featureType: Reactory.FeatureType.function,
      action: ['assign', 'delegate', 'hand off'],
      description: 'Assign a todo item to another AI persona or agent.',
      stem: 'assign'
    },
    {
      feature: 'list',
      featureType: Reactory.FeatureType.function,
      action: ['list', 'show', 'display', 'summary'],
      description: 'List all todo lists with status summaries.',
      stem: 'list'
    },
    {
      feature: 'remove',
      featureType: Reactory.FeatureType.function,
      action: ['remove', 'delete', 'drop'],
      description: 'Remove a todo item from a list.',
      stem: 'remove'
    },
  ],
  stem: 'todo',
  tags: ['todo', 'task', 'plan', 'work', 'assign', 'agent'],
  tools: [{
    type: "function",
    function: {
      name: "todo",
      description: "Create and manage todo lists for planning and tracking work. Supports creating lists, adding/updating/assigning/removing items, and choosing series or parallel execution.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "get", "add", "update", "assign", "remove"],
            description: "The action to perform on the todo system"
          },
          listId: {
            type: "string",
            description: "The todo list id (required for get, add, update, assign, remove)"
          },
          name: {
            type: "string",
            description: "Name for a new todo list (used with 'create')"
          },
          executionMode: {
            type: "string",
            enum: ["series", "parallel"],
            description: "Execution strategy: 'series' (sequential) or 'parallel' (concurrent). Default: 'series'. Used with 'create'."
          },
          todoId: {
            type: "string",
            description: "The todo item id (required for update, assign, remove)"
          },
          title: {
            type: "string",
            description: "Title for a new todo item (used with 'add')"
          },
          description: {
            type: "string",
            description: "Detailed description or instructions for the todo item (used with 'add' or 'update')"
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "failed", "cancelled"],
            description: "Status to set on a todo item (used with 'update')"
          },
          result: {
            type: "string",
            description: "Result data to attach to a todo item after execution (used with 'update')"
          },
          assignee: {
            type: "string",
            description: "Persona or agent id to assign the todo to (used with 'add' or 'assign')"
          }
        },
        required: ["action"]
      }
    }
  }]
};
