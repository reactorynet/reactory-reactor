// mysql2 is an optional dependency - dynamically imported to avoid startup failures
let mysql: any = null;
try {
  mysql = require('mysql2/promise');
} catch {
  // mysql2 not installed - macro will return an informative error at runtime
}
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
 * MySQL database macro
 * Executes SQL queries against MySQL databases
 */
export const MySqlMacro: Macro<DatabaseMacroResult, DatabaseMacroProps> = async (
  props: DatabaseMacroProps,
  state: ChatState): Promise<DatabaseMacroResult> => {
  const startTime = Date.now();

  // Guard: check if mysql2 dependency is available
  if (!mysql) {
    return {
      success: false,
      error: 'MySQL support is not available. The mysql2 package is not installed. Run `yarn add mysql2` in the server project to enable MySQL queries.',
      tool: 'mysql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: props.connectionId?.trim() || '',
        variant: 'mysql',
        queryLength: props.query?.length || 0
      }
    };
  }

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
      tool: 'mysql',
      params: props
    };
  }

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: 'Query is required',
      tool: 'mysql',
      params: props
    };
  }

  if (!name || name.trim().length === 0) {
    return {
      success: false,
      error: 'Operation name is required',
      tool: 'mysql',
      params: props
    };
  }

  // Validate query for security
  const validation = validateQuery(query);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || 'Query validation failed',
      tool: 'mysql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mysql',
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
      tool: 'mysql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mysql',
        queryLength: query.length
      }
    };
  }

  if (connection.variant !== 'mysql') {
    return {
      success: false,
      error: `Connection '${connectionId}' is not a MySQL connection (variant: ${connection.variant})`,
      tool: 'mysql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mysql',
        queryLength: query.length
      }
    };
  }

  let connectionPool: mysql.Connection | null = null;
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
            variant: 'mysql',
            result: cachedResult.result,
            formattedOutput: cachedResult.formattedOutput,
            format,
            savedToFile: false,
            cached: true,
            cacheKey
          },
          tool: 'mysql',
          params: props,
          metadata: {
            executionTime,
            timestamp: new Date(),
            user: state.user?.id,
            connectionId: connectionId.trim(),
            variant: 'mysql',
            queryLength: query.length,
            rowCount: cachedResult.result.rowCount,
            columnCount: cachedResult.result.columns.length
          },
          instructions: `
## MySQL Query Results (Cached)

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

    // Create MySQL connection
    connectionPool = await mysql.createConnection({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ...connection.options
    });

    const queryStartTime = Date.now();
    
    // Execute query
    const [rows, fields] = await connectionPool.execute(query.trim());
    const queryExecutionTime = Date.now() - queryStartTime;
    
    // Create query result object
    const queryResult = createQueryResult(rows, queryExecutionTime, true);
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
    state.vars.lastMySqlQuery = {
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
    logger.info(`MySqlMacro executed: ${name.trim()} by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, rows: ${queryResult.rowCount}`);

    return {
      success: true,
      data: {
        name: name.trim(),
        query: query.trim(),
        connectionId: connectionId.trim(),
        variant: 'mysql',
        result: queryResult,
        formattedOutput,
        format,
        savedToFile,
        filePath,
        cached,
        cacheKey
      },
      tool: 'mysql',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mysql',
        queryLength: query.length,
        rowCount: queryResult.rowCount,
        columnCount: queryResult.columns.length
      },
      instructions: `
## MySQL Query Results

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
- lastMySqlQuery: Complete query information for future reference

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
    logger.error(`Error in MySqlMacro for query ${name}:`, error);
    
    return {
      success: false,
      error: `MySQL query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'mysql',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mysql',
        queryLength: query.length
      }
    };
  } finally {
    if (connectionPool) {
      try {
        await connectionPool.end();
      } catch (error) {
        logger.error('Error closing MySQL connection:', error);
      }
    }
  }
};

export const MySqlMacroRegistry: MacroComponentDefinition<typeof MySqlMacro> = {
  nameSpace: 'reactor-macros',
  name: 'mysql',
  version: '1.0.0',
  component: MySqlMacro,
  description: 'Execute SQL queries against MySQL databases with structured results and comprehensive metadata',
  features: [],
  stem: 'mysql',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['database', 'mysql', 'sql', 'query'],
  tools: [{
    type: "function",
    function: {
      name: "mysql",
      description: "Execute SQL queries against MySQL databases with structured results and comprehensive metadata",
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