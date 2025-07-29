import { Client } from 'pg';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DatabaseMacroProps, DatabaseMacroResult } from '../types';
import { 
  getDatabaseConnection, 
  formatQueryResults, 
  saveToFile, 
  generateCacheKey, 
  validateQuery, 
  createQueryResult 
} from '../utils';
import logger from '@reactory/server-core/logging';

/**
 * PostgreSQL database macro
 * Executes SQL queries against PostgreSQL databases
 */
export const PostgresMacro: Macro<DatabaseMacroResult, DatabaseMacroProps> = async (
  props: DatabaseMacroProps,
  state: ChatState): Promise<DatabaseMacroResult> => {
  const startTime = Date.now();
  const {
    connectionId,
    query,
    name,
    format = 'json',
    file = false,
    cache = true
  } = props;

  if (!connectionId || connectionId.trim().length === 0) {
    return {
      success: false,
      error: 'Connection ID is required',
      tool: 'postgres',
      params: props
    };
  }

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: 'Query is required',
      tool: 'postgres',
      params: props
    };
  }

  if (!name || name.trim().length === 0) {
    return {
      success: false,
      error: 'Operation name is required',
      tool: 'postgres',
      params: props
    };
  }

  // Validate query for security
  const validation = validateQuery(query);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || 'Query validation failed',
      tool: 'postgres',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'postgres',
        queryLength: query.length
      }
    };
  }

  // Get database connection from partner settings
  const connection = getDatabaseConnection(connectionId.trim(), state.context?.partner);
  if (!connection) {
    return {
      success: false,
      error: `Database connection '${connectionId}' not found in partner settings`,
      tool: 'postgres',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'postgres',
        queryLength: query.length
      }
    };
  }

  if (connection.variant !== 'postgres') {
    return {
      success: false,
      error: `Connection '${connectionId}' is not a PostgreSQL connection (variant: ${connection.variant})`,
      tool: 'postgres',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'postgres',
        queryLength: query.length
      }
    };
  }

  let client: Client | null = null;
  let cached = false;
  let cacheKey: string | undefined;

  try {
    // Check cache if enabled
    if (cache) {
      cacheKey = generateCacheKey(connectionId, query, name);
      const cachedResult = state.vars?.[cacheKey] as any;
      if (cachedResult && cachedResult.timestamp > Date.now() - 300000) { // 5 minute cache
        cached = true;
        const executionTime = Date.now() - startTime;
        
        return {
          success: true,
          data: {
            name: name.trim(),
            query: query.trim(),
            connectionId: connectionId.trim(),
            variant: 'postgres',
            result: cachedResult.result,
            formattedOutput: cachedResult.formattedOutput,
            format,
            savedToFile: false,
            cached: true,
            cacheKey
          },
          tool: 'postgres',
          params: props,
          metadata: {
            executionTime,
            timestamp: new Date(),
            user: state.user?.id,
            connectionId: connectionId.trim(),
            variant: 'postgres',
            queryLength: query.length,
            rowCount: cachedResult.result.rowCount,
            columnCount: cachedResult.result.columns.length
          },
          instructions: `
## PostgreSQL Query Results (Cached)

Retrieved cached results for: **${name.trim()}**

### Query Information:
- **Connection**: ${connectionId.trim()}
- **Query**: ${query.trim()}
- **Format**: ${format}
- **Cached**: Yes (${cacheKey})
- **Execution Time**: ${executionTime}ms

### Available Data:
- **result**: Query results with metadata
- **formattedOutput**: Formatted output according to format parameter
- **cached**: true (results retrieved from cache)
- **cacheKey**: Cache identifier used

### Usage:
- Use \`result.rows\` for raw query results
- Use \`formattedOutput\` for formatted display
- Use \`result.rowCount\` for result count
- Use \`data\` for comprehensive query information
          `
        };
      }
    }

    // Create PostgreSQL client
    client = new Client({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ...connection.options
    });

    // Connect to database
    await client.connect();
    const queryStartTime = Date.now();
    
    // Execute query
    const result = await client.query(query.trim());
    const queryExecutionTime = Date.now() - queryStartTime;
    
    // Create query result object
    const queryResult = createQueryResult(result, queryExecutionTime, true);
    const totalExecutionTime = Date.now() - startTime;

    // Format output
    const formattedOutput = formatQueryResults(queryResult, format, name.trim());

    // Save to file if requested
    let savedToFile = false;
    let filePath: string | undefined;
    if (file) {
      const saveResult = await saveToFile(formattedOutput, name.trim(), format, state.user?.id);
      savedToFile = saveResult.success;
      filePath = saveResult.filePath;
    }

    // Cache results if enabled
    if (cache && cacheKey) {
      if (!state.vars) {
        state.vars = {};
      }
      state.vars[cacheKey] = {
        result: queryResult,
        formattedOutput,
        timestamp: Date.now()
      };
    }

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastPostgresQuery = {
      name: name.trim(),
      query: query.trim(),
      connectionId: connectionId.trim(),
      result: queryResult,
      formattedOutput,
      format,
      savedToFile,
      cached,
      lastExecuted: new Date()
    };

    // Log query for security
    logger.info(`PostgresMacro executed: ${name.trim()} by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, rows: ${queryResult.rowCount}`);

    return {
      success: true,
      data: {
        name: name.trim(),
        query: query.trim(),
        connectionId: connectionId.trim(),
        variant: 'postgres',
        result: queryResult,
        formattedOutput,
        format,
        savedToFile,
        filePath,
        cached,
        cacheKey
      },
      tool: 'postgres',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'postgres',
        queryLength: query.length,
        rowCount: queryResult.rowCount,
        columnCount: queryResult.columns.length
      },
      instructions: `
## PostgreSQL Query Results

Successfully executed query: **${name.trim()}**

### Query Information:
- **Connection**: ${connectionId.trim()}
- **Database**: ${connection.database}@${connection.host}:${connection.port}
- **Query**: ${query.trim()}
- **Format**: ${format}
- **Rows Returned**: ${queryResult.rowCount}
- **Columns**: ${queryResult.columns.length}
- **Query Time**: ${queryExecutionTime}ms
- **Total Time**: ${totalExecutionTime}ms
- **Cached**: ${cached ? 'Yes' : 'No'}
- **Saved to File**: ${savedToFile ? 'Yes' : 'No'}

### Available Data:
- **result**: Complete query results with metadata
- **formattedOutput**: Formatted output according to format parameter
- **savedToFile**: Whether output was saved to file
- **filePath**: Path to saved file (if applicable)
- **cached**: Whether results were cached
- **cacheKey**: Cache identifier (if cached)

### State Variables Available:
- lastPostgresQuery: Complete query information for future reference

### Usage:
- Use \`result.rows\` for raw query results
- Use \`formattedOutput\` for formatted display
- Use \`result.rowCount\` for result count
- Use \`result.columns\` for column names
- Use \`data\` for comprehensive query information
      `
    };

  } catch (error) {
    const totalExecutionTime = Date.now() - startTime;
    logger.error(`Error in PostgresMacro for query ${name}:`, error);
    
    return {
      success: false,
      error: `PostgreSQL query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'postgres',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'postgres',
        queryLength: query.length
      }
    };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch (error) {
        logger.error('Error closing PostgreSQL connection:', error);
      }
    }
  }
};

export const PostgresMacroRegistry: MacroComponentDefinition<typeof PostgresMacro> = {
  nameSpace: 'reactor-macros',
  name: 'postgres',
  version: '1.0.0',
  component: PostgresMacro,
  description: 'Execute SQL queries against PostgreSQL databases with structured results and comprehensive metadata',
  features: [],
  stem: 'postgres',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['database', 'postgres', 'postgresql', 'sql', 'query'],
  tools: [{
    type: "function",
    function: {
      name: "postgres",
      description: "Execute SQL queries against PostgreSQL databases with structured results and comprehensive metadata",
      icon: "storage",
      parameters: {
        type: "object",
        properties: {
          connectionId: {
            type: "string",
            description: "Connection ID from partner settings"
          },
          query: {
            type: "string",
            description: "SQL query to execute (SELECT only for security)"
          },
          name: {
            type: "string",
            description: "Name for the operation"
          },
          format: {
            type: "string",
            enum: ["json", "csv", "markdown", "text"],
            description: "Output format for results"
          },
          file: {
            type: "boolean",
            description: "Whether to save output to file"
          },
          cache: {
            type: "boolean",
            description: "Whether to cache results"
          }
        },
        required: ["connectionId", "query", "name"]
      }
    }
  }]
}; 