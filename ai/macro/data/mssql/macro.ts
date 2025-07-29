import sql from 'mssql';
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
 * MSSQL database macro
 * Executes SQL queries against Microsoft SQL Server databases
 */
export const MsSqlMacro: Macro<DatabaseMacroResult, DatabaseMacroProps> = async (
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
      tool: 'mssql',
      params: props
    };
  }

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: 'Query is required',
      tool: 'mssql',
      params: props
    };
  }

  if (!name || name.trim().length === 0) {
    return {
      success: false,
      error: 'Operation name is required',
      tool: 'mssql',
      params: props
    };
  }

  // Validate query for security
  const validation = validateQuery(query);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || 'Query validation failed',
      tool: 'mssql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mssql',
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
      tool: 'mssql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mssql',
        queryLength: query.length
      }
    };
  }

  if (connection.variant !== 'mssql') {
    return {
      success: false,
      error: `Connection '${connectionId}' is not a MSSQL connection (variant: ${connection.variant})`,
      tool: 'mssql',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mssql',
        queryLength: query.length
      }
    };
  }

  let pool: sql.ConnectionPool | null = null;
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
            variant: 'mssql',
            result: cachedResult.result,
            formattedOutput: cachedResult.formattedOutput,
            format,
            savedToFile: false,
            cached: true,
            cacheKey
          },
          tool: 'mssql',
          params: props,
          metadata: {
            executionTime,
            timestamp: new Date(),
            user: state.user?.id,
            connectionId: connectionId.trim(),
            variant: 'mssql',
            queryLength: query.length,
            rowCount: cachedResult.result.rowCount,
            columnCount: cachedResult.result.columns.length
          },
          instructions: `
## MSSQL Query Results (Cached)

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

    // Create MSSQL connection pool
    const config: sql.config = {
      server: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...connection.options
      }
    };

    pool = await new sql.ConnectionPool(config).connect();
    const queryStartTime = Date.now();
    
    // Execute query
    const result = await pool.request().query(query.trim());
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
    state.vars.lastMsSqlQuery = {
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
    logger.info(`MsSqlMacro executed: ${name.trim()} by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, rows: ${queryResult.rowCount}`);

    return {
      success: true,
      data: {
        name: name.trim(),
        query: query.trim(),
        connectionId: connectionId.trim(),
        variant: 'mssql',
        result: queryResult,
        formattedOutput,
        format,
        savedToFile,
        filePath,
        cached,
        cacheKey
      },
      tool: 'mssql',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mssql',
        queryLength: query.length,
        rowCount: queryResult.rowCount,
        columnCount: queryResult.columns.length
      },
      instructions: `
## MSSQL Query Results

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
- lastMsSqlQuery: Complete query information for future reference

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
    logger.error(`Error in MsSqlMacro for query ${name}:`, error);
    
    return {
      success: false,
      error: `MSSQL query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'mssql',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mssql',
        queryLength: query.length
      }
    };
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (error) {
        logger.error('Error closing MSSQL connection:', error);
      }
    }
  }
};

export const MsSqlMacroRegistry: MacroComponentDefinition<typeof MsSqlMacro> = {
  nameSpace: 'reactor-macros',
  name: 'mssql',
  version: '1.0.0',
  component: MsSqlMacro,
  description: 'Execute SQL queries against Microsoft SQL Server databases with structured results and comprehensive metadata',
  features: [],
  stem: 'mssql',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['database', 'mssql', 'sql', 'query', 'microsoft'],
  tools: [{
    type: "function",
    function: {
      name: "mssql",
      description: "Execute SQL queries against Microsoft SQL Server databases with structured results and comprehensive metadata",
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