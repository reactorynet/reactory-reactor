import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import Reactory from "@reactorynet/reactory-core";
import {
  GetUserProps,
  CreateUserProps,
  GetUserResult,
  CreateUserResult,
  SearchUserProps,
  SearchUserResult,
  SearchUserData,
} from "./types";
import logger from "@reactory/server-core/logging";

/**
 * Searches for users by query string (name or email)
 */
export const SearchUser: Macro<SearchUserResult, SearchUserProps> = async (
  props: SearchUserProps,
  state: ChatState
): Promise<SearchUserResult> => {
  const startTime = Date.now();
  const rawQuery = props?.query || props?.searchString || props?.email || props?.name || "";
  const query = rawQuery.trim();
  const limit = Number(props?.limit) || 10;

  const userService = state.context?.getService<Reactory.Service.IReactoryUserService>("core.UserService@1.0.0");

  if (!userService) {
    return {
      success: false,
      error: "User service not found in execution context",
      tool: "searchUser",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        query,
      },
    };
  }

  try {
    let foundUsers: any[] = [];

    if (query.length > 0) {
      if (typeof userService.searchUser === "function") {
        foundUsers = await userService.searchUser(query, "email", limit);
      } else if (typeof userService.search === "function") {
        const searchResult = await userService.search({ search: query, limit });
        foundUsers = searchResult?.users || [];
      } else if (typeof userService.findUserWithEmail === "function" && query.includes("@")) {
        const singleUser = await userService.findUserWithEmail(query);
        if (singleUser) foundUsers = [singleUser];
      }
    } else {
      if (typeof userService.listAllUsers === "function") {
        foundUsers = await userService.listAllUsers();
        if (foundUsers.length > limit) {
          foundUsers = foundUsers.slice(0, limit);
        }
      }
    }

    const executionTime = Date.now() - startTime;

    const normalizedUsers: SearchUserData[] = (foundUsers || []).map((u: any) => {
      const id = u.id || u._id?.toString() || "";
      const firstName = u.firstName || "";
      const lastName = u.lastName || "";
      const email = u.email || "";
      const displayName = `${firstName} ${lastName}`.trim() || email || id;
      return {
        id,
        firstName,
        lastName,
        email,
        displayName,
      };
    });

    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastSearchUser = normalizedUsers;

    const userRows = normalizedUsers
      .map(
        (u, idx) =>
          `${idx + 1}. **${u.displayName}** (Email: \`${u.email}\`, User ID: \`${u.id}\`)`
      )
      .join("\n");

    const instructions = `
## User Search Results (Found: ${normalizedUsers.length})

${normalizedUsers.length > 0 ? userRows : `No users found matching query "${query}".`}

### Usage Notes:
- To assign support tickets or ownership, copy the **User ID** (\`id\`) and pass it as \`assignTo\` in \`updateSupportTicket\`.
- Ownership must always sit with a user account, not an AI agent persona.
    `;

    return {
      success: true,
      data: normalizedUsers,
      tool: "searchUser",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        query,
        total: normalizedUsers.length,
      },
      instructions,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in SearchUser macro for query "${query}":`, error);

    return {
      success: false,
      error: `Error searching users: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "searchUser",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        query,
      },
    };
  }
};

export const SearchUserRegistry: MacroComponentDefinition<typeof SearchUser> = {
  nameSpace: "reactor-macros",
  name: "searchUser",
  version: "1.0.0",
  component: SearchUser,
  description: "Search for users by name or email to retrieve their user ID, display name, and email for ticket assignment or user lookup",
  features: [
    {
      feature: "search",
      featureType: Reactory.FeatureType.function,
      action: ["search", "find", "lookup", "filter"],
      description: "Operation that searches for users by name or email with structured results.",
      stem: "search",
    },
  ],
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "user",
  tags: ["user", "search", "find", "email", "lookup", "assign"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "searchUser",
        description: "Search for users by name or email to retrieve user ID, name, and email for assignment or lookup",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search term to match against user name or email address",
            },
            limit: {
              type: "number",
              description: "Maximum number of users to return (default: 10)",
            },
          },
        },
      },
    },
  ],
};

export const GetUser: Macro<GetUserResult, GetUserProps> = async (
  props: GetUserProps,
  state: ChatState
): Promise<GetUserResult> => {
  const startTime = Date.now();
  const { email } = props;

  if (!email || email.trim().length === 0) {
    return {
      success: false,
      error: "No email provided",
      tool: "getUser",
      params: props,
    };
  }

  const userService = state.context?.getService<Reactory.Service.IReactoryUserService>("core.UserService@1.0.0");

  if (!userService) {
    return {
      success: false,
      error: "No user service found",
      tool: "getUser",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        email: email.trim(),
      },
    };
  }

  try {
    const user = await userService.findUserWithEmail(email.trim());
    const executionTime = Date.now() - startTime;

    if (!user) {
      return {
        success: true,
        data: {
          id: "",
          firstName: "",
          lastName: "",
          email: email.trim(),
          found: false,
          displayName: "",
        },
        tool: "getUser",
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          email: email.trim(),
          found: false,
        },
        instructions: `
## User Lookup Results

No user found with email: **${email.trim()}**

### Search Information:
- **Email**: ${email.trim()}
- **Found**: No
- **Execution Time**: ${executionTime}ms

### Available Data:
- **found**: false (user does not exist)
- **email**: The email that was searched
- **id, firstName, lastName, displayName**: Empty strings (user not found)

### Usage:
- Use \`found\` to determine if user exists
- Use \`email\` to confirm the search parameter
- Consider using createUser if you need to create this user
        `,
      };
    }

    const displayName = `${user.firstName} ${user.lastName}`.trim();

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastGetUser = {
      user,
      email: email.trim(),
      found: true,
      lastAccessed: new Date(),
    };

    // Log access for security
    logger.info(`GetUser macro accessed: ${email.trim()} by user: ${state.user?.id || "unknown"}, found: true`);

    return {
      success: true,
      data: {
        id: user.id || (user as any)._id?.toString(),
        firstName: user.firstName,
        lastName: user.lastName,
        email: email.trim(),
        found: true,
        displayName,
      },
      tool: "getUser",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        email: email.trim(),
        found: true,
      },
      instructions: `
## User Lookup Results

Successfully found user: **${displayName}**

### User Information:
- **ID**: ${user.id || (user as any)._id?.toString()}
- **Name**: ${displayName}
- **Email**: ${email.trim()}
- **Found**: Yes
- **Execution Time**: ${executionTime}ms

### Available Data:
- **id**: User's unique identifier (use this for ticket assignment via \`updateSupportTicket\`)
- **firstName**: User's first name
- **lastName**: User's last name
- **email**: User's email address
- **found**: true (user exists)
- **displayName**: Formatted full name

### State Variables Available:
- lastGetUser: Complete user information for future reference

### Usage:
- Use \`id\` for user identification in ticket assignment or other operations
- Use \`displayName\` for user-friendly display
- Use \`found\` to confirm user exists
- Use \`data\` for comprehensive user information
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in GetUser macro for email ${email}:`, error);

    return {
      success: false,
      error: `Error finding user: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "getUser",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        email: email.trim(),
      },
    };
  }
};

export const GetUserRegistry: MacroComponentDefinition<typeof GetUser> = {
  nameSpace: "reactor-macros",
  name: "getUser",
  version: "1.0.0",
  component: GetUser,
  description: "Retrieve user information by email with structured results and metadata",
  features: [
    {
      feature: "find",
      featureType: Reactory.FeatureType.function,
      action: ["find", "get", "retrieve", "lookup"],
      description: "Operation that finds a user by email with structured results.",
      stem: "find",
    },
  ],
  roles: ["ADMIN", "USER", "SUPPORT_ADMIN", "SUPPORT"],
  stem: "user",
  tags: ["user", "find", "email", "lookup"],
  tools: [
    {
      type: "function",
      safeForAutoExecution: true,
      function: {
        name: "getUser",
        description: "Retrieve a user by their email address with structured results and metadata",
        parameters: {
          type: "object",
          properties: {
            email: {
              type: "string",
              description: "The email address of the user to find",
            },
          },
          required: ["email"],
        },
      },
    },
  ],
};

/**
 * Creates a new user with the given email, first name, and last name
 * @param props - CreateUserProps - { email, firstName, lastName }
 * @param state - ChatState
 * @returns
 */
export const CreateUser: Macro<CreateUserResult, CreateUserProps> = async (
  props: CreateUserProps,
  state: ChatState
): Promise<CreateUserResult> => {
  const startTime = Date.now();
  const { email, firstName, lastName } = props;

  if (!email || email.trim().length === 0) {
    return {
      success: false,
      error: "No email provided",
      tool: "createUser",
      params: props,
    };
  }

  if (!firstName || firstName.trim().length === 0) {
    return {
      success: false,
      error: "No first name provided",
      tool: "createUser",
      params: props,
    };
  }

  if (!lastName || lastName.trim().length === 0) {
    return {
      success: false,
      error: "No last name provided",
      tool: "createUser",
      params: props,
    };
  }

  const userService = state.context?.getService<Reactory.Service.IReactoryUserService>("core.UserService@1.0.0");

  if (!userService) {
    return {
      success: false,
      error: "No user service found",
      tool: "createUser",
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        email: email.trim(),
      },
    };
  }

  try {
    // Check if user already exists
    let user = await userService.findUserWithEmail(email.trim());

    if (user) {
      const displayName = `${user.firstName} ${user.lastName}`.trim();
      const executionTime = Date.now() - startTime;

      return {
        success: true,
        data: {
          id: user.id || (user as any)._id?.toString(),
          firstName: user.firstName,
          lastName: user.lastName,
          email: email.trim(),
          created: false,
          displayName,
        },
        tool: "createUser",
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          email: email.trim(),
          created: false,
        },
        instructions: `
## User Creation Results

User already exists: **${displayName}**

### User Information:
- **ID**: ${user.id || (user as any)._id?.toString()}
- **Name**: ${displayName}
- **Email**: ${email.trim()}
- **Created**: No (user already existed)
- **Execution Time**: ${executionTime}ms

### Available Data:
- **id**: User's unique identifier
- **firstName**: User's first name
- **lastName**: User's last name
- **email**: User's email address
- **created**: false (user already existed)
- **displayName**: Formatted full name

### Usage:
- Use \`created\` to determine if a new user was created
- Use \`id\` for user identification in other operations
- Use \`displayName\` for user-friendly display
- Consider using getUser if you just need to retrieve user info
        `,
      };
    }

    // Create new user
    user = await userService.createUser({
      email: email.trim(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
    });

    if (!user) {
      return {
        success: false,
        error: `Failed to create user with email ${email.trim()}`,
        tool: "createUser",
        params: props,
        metadata: {
          executionTime: Date.now() - startTime,
          timestamp: new Date(),
          user: state.user?.id,
          email: email.trim(),
        },
      };
    }

    const displayName = `${user.firstName} ${user.lastName}`.trim();
    const executionTime = Date.now() - startTime;

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastCreateUser = {
      user,
      email: email.trim(),
      created: true,
      lastCreated: new Date(),
    };

    // Log creation for security
    logger.info(`CreateUser macro executed: ${email.trim()} by user: ${state.user?.id || "unknown"}, created: true`);

    return {
      success: true,
      data: {
        id: user.id || (user as any)._id?.toString(),
        firstName: user.firstName,
        lastName: user.lastName,
        email: email.trim(),
        created: true,
        displayName,
      },
      tool: "createUser",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        email: email.trim(),
        created: true,
      },
      instructions: `
## User Creation Results

Successfully created new user: **${displayName}**

### User Information:
- **ID**: ${user.id || (user as any)._id?.toString()}
- **Name**: ${displayName}
- **Email**: ${email.trim()}
- **Created**: Yes (new user)
- **Execution Time**: ${executionTime}ms

### Available Data:
- **id**: User's unique identifier
- **firstName**: User's first name
- **lastName**: User's last name
- **email**: User's email address
- **created**: true (new user was created)
- **displayName**: Formatted full name

### State Variables Available:
- lastCreateUser: Complete user information for future reference

### Usage:
- Use \`id\` for user identification in other operations
- Use \`displayName\` for user-friendly display
- Use \`created\` to confirm a new user was created
- Use \`data\` for comprehensive user information
      `,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error creating user with email ${email}:`, error);

    return {
      success: false,
      error: `Error creating user: ${error instanceof Error ? error.message : "Unknown error"}`,
      tool: "createUser",
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        email: email.trim(),
      },
    };
  }
};

export const CreateUserRegistry: MacroComponentDefinition<typeof CreateUser> = {
  nameSpace: "reactor-macros",
  name: "createUser",
  version: "1.0.0",
  component: CreateUser,
  description: "Create a new user with structured results and comprehensive metadata",
  features: [
    {
      feature: "create",
      featureType: Reactory.FeatureType.function,
      action: ["create", "add", "register", "new"],
      description: "Operation that creates a new user with structured results.",
      stem: "create",
    },
  ],
  stem: "user",
  roles: ["ADMIN"],
  tags: ["user", "create", "register", "new"],
  tools: [
    {
      type: "function",
      function: {
        name: "createUser",
        description: "Create a new user with the specified details and structured results",
        parameters: {
          type: "object",
          properties: {
            email: {
              type: "string",
              description: "The email address of the new user",
            },
            firstName: {
              type: "string",
              description: "The first name of the new user",
            },
            lastName: {
              type: "string",
              description: "The last name of the new user",
            },
          },
          required: ["email", "firstName", "lastName"],
        },
      },
    },
  ],
};
