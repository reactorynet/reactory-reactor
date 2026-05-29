import {
  ChatState,
  Macro,
  MacroComponentDefinition,
} from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DatabaseVariant, ListedDatabaseConnection } from '../types';
import { listDatabaseConnections } from '../utils';

export interface ListDataConnectionsProps {
  /** Optional single variant filter */
  variant?: DatabaseVariant;
  /** Optional list of variants to include */
  variants?: DatabaseVariant[];
}

export interface ListDataConnectionsResult {
  success: boolean;
  tool: string;
  params: ListDataConnectionsProps;
  data?: {
    connections: ListedDatabaseConnection[];
    total: number;
    variants: DatabaseVariant[];
  };
  error?: string;
  instructions?: string;
}

function extractUserRoles(user?: unknown): string[] {
  if (!user || typeof user !== 'object') return [];

  const src = user as {
    roles?: unknown;
    activeMembership?: { roles?: unknown };
    memberships?: Array<{ roles?: unknown }>;
  };

  const directRoles = Array.isArray(src.roles) ? src.roles : [];
  const activeMembershipRoles = Array.isArray(src.activeMembership?.roles)
    ? src.activeMembership.roles
    : [];
  const membershipsRoles = Array.isArray(src.memberships)
    ? src.memberships.flatMap((membership) =>
        Array.isArray(membership?.roles) ? membership.roles : []
      )
    : [];

  return [...directRoles, ...activeMembershipRoles, ...membershipsRoles].filter(
    (role): role is string => typeof role === 'string' && role.trim().length > 0
  );
}

function createRoleChecker(state: ChatState) {
  const runtimeContext = state.context;

  if (runtimeContext?.hasAnyRole) {
    return (roles: string[]): boolean => runtimeContext.hasAnyRole(roles);
  }

  const userRoles = extractUserRoles(runtimeContext?.user ?? state.user);
  const roleSet = new Set(userRoles.map((role) => role.toLowerCase()));

  return (roles: string[]): boolean =>
    roles.some((role) => roleSet.has(role.toLowerCase()));
}

export const ListDataConnectionsMacro: Macro<
  ListDataConnectionsResult,
  ListDataConnectionsProps
> = async (
  props: ListDataConnectionsProps,
  state: ChatState,
): Promise<ListDataConnectionsResult> => {
  const { variant, variants } = props;
  const context = state.context;

  if (!context?.partner) {
    return {
      success: false,
      tool: 'listDataConnections',
      params: props,
      error: 'Partner context is not available.',
    };
  }

  const allowedVariants = new Set<DatabaseVariant>([
    ...(variant ? [variant] : []),
    ...((variants ?? []) as DatabaseVariant[]),
  ]);

  const hasAnyRole = createRoleChecker(state);
  const allConnections = listDatabaseConnections(context.partner, hasAnyRole);
  const filteredConnections = allConnections.filter((connection) => {
    if (allowedVariants.size === 0) return true;
    return allowedVariants.has(connection.variant);
  });

  const availableVariants = Array.from(
    new Set(filteredConnections.map((connection) => connection.variant))
  ) as DatabaseVariant[];

  return {
    success: true,
    tool: 'listDataConnections',
    params: props,
    data: {
      connections: filteredConnections,
      total: filteredConnections.length,
      variants: availableVariants,
    },
    instructions: `
## Available Data Connections

Returned **${filteredConnections.length}** connection(s) available to the current agent/user.

### Usage
- Use \`connectionId\` with \`postgres\`, \`mysql\`, \`mssql\`, or \`mongo\` macros.
- If no connections are returned, verify partner settings and role assignments.
- If needed, filter by \`variant\` to narrow the list.
    `,
  };
};

export const ListDataConnectionsMacroRegistry: MacroComponentDefinition<
  typeof ListDataConnectionsMacro
> = {
  nameSpace: 'reactor-macros',
  name: 'listDataConnections',
  alias: 'listDataConnections',
  version: '1.0.0',
  component: ListDataConnectionsMacro,
  description:
    'Lists database connections available to the current user/agent from partner settings with role-aware filtering.',
  features: [],
  stem: 'list',
  roles: ['DEVELOPER', 'ADMIN', 'USER'],
  tags: ['database', 'connections', 'discovery', 'security'],
  runat: 'server',
  tools: [
    {
      type: 'function',
      safeForAutoExecution: true,
      function: {
        name: 'listDataConnections',
        icon: 'storage',
        description:
          'List available data connections from partner settings after applying role checks.',
        parameters: {
          type: 'object',
          properties: {
            variant: {
              type: 'string',
              enum: ['postgres', 'mysql', 'mssql', 'mongo', 'redis'],
              description: 'Optional single variant filter.',
            },
            variants: {
              type: 'array',
              description: 'Optional list of variants to include.',
              items: {
                type: 'string',
                enum: ['postgres', 'mysql', 'mssql', 'mongo', 'redis'],
              },
            },
          },
          required: [],
        },
      },
    },
  ],
};

export default [ListDataConnectionsMacroRegistry];
