import { MongoClient, Db, Collection } from 'mongodb';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DatabaseMacroProps, DatabaseMacroResult } from '../types';
import { 
  getDatabaseConnection, 
  formatQueryResults, 
  saveToFile, 
  generateCacheKey, 
  createQueryResult 
} from '../utils';
import logger from '@reactory/server-core/logging';

/**
 * MongoDB-specific properties extending the base database macro props
 */
export interface MongoMacroProps extends DatabaseMacroProps {
  /** MongoDB collection name */
  collection?: string;
  /** MongoDB aggregation pipeline (alternative to query) */
  pipeline?: any[];
  /** MongoDB query filter (alternative to query) */
  filter?: any;
  /** MongoDB projection (fields to return) */
  projection?: any;
  /** MongoDB sort options */
  sort?: any;
  /** MongoDB limit */
  limit?: number;
  /** MongoDB skip */
  skip?: number;
  /** Write operation type */
  writeOperation?: 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
  /** Document(s) to insert */
  document?: any;
  /** Array of documents for insertMany */
  documents?: any[];
  /** Update operations ($set, $unset, etc.) */
  update?: any;
  /** If true, create a new document when no document matches the query (for update operations) */
  upsert?: boolean;
}

/**
 * MongoDB database macro
 * Executes queries against MongoDB databases
 */
export const MongoMacro: Macro<DatabaseMacroResult, MongoMacroProps> = async (
  props: MongoMacroProps,
  state: ChatState): Promise<DatabaseMacroResult> => {
  const startTime = Date.now();
  const {
    connectionId,
    query,
    name,
    format = 'json',
    file = false,
    cache = true,
    collection,
    pipeline,
    filter,
    projection,
    sort,
    limit,
    skip,
    writeOperation,
    document,
    documents,
    update,
    upsert = false,
  } = props;

  if (!connectionId || connectionId.trim().length === 0) {
    return {
      success: false,
      error: 'Connection ID is required',
      tool: 'mongo',
      params: props
    };
  }

  if (!name || name.trim().length === 0) {
    return {
      success: false,
      error: 'Operation name is required',
      tool: 'mongo',
      params: props
    };
  }

  // Validate that we have either a query, pipeline, filter, or write operation
  if (!query && !pipeline && !filter && !writeOperation) {
    return {
      success: false,
      error: 'Either query, pipeline, filter, or writeOperation is required',
      tool: 'mongo',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: 0
      }
    };
  }

  // Validate write operation parameters
  if (writeOperation) {
    if (!collection) {
      return {
        success: false,
        error: 'Collection name is required for write operations',
        tool: 'mongo',
        params: props,
      };
    }

    if ((writeOperation === 'insertOne') && !document) {
      return {
        success: false,
        error: 'A document is required for insertOne operations',
        tool: 'mongo',
        params: props,
      };
    }

    if ((writeOperation === 'insertMany') && (!documents || !Array.isArray(documents) || documents.length === 0)) {
      return {
        success: false,
        error: 'A non-empty documents array is required for insertMany operations',
        tool: 'mongo',
        params: props,
      };
    }

    if ((writeOperation === 'updateOne' || writeOperation === 'updateMany') && (!filter || !update)) {
      return {
        success: false,
        error: 'Both filter and update are required for update operations',
        tool: 'mongo',
        params: props,
      };
    }

    if ((writeOperation === 'deleteOne' || writeOperation === 'deleteMany') && !filter) {
      return {
        success: false,
        error: 'A filter is required for delete operations',
        tool: 'mongo',
        params: props,
      };
    }

    // Prevent empty filter deletes (safety guard)
    if ((writeOperation === 'deleteMany') && Object.keys(filter).length === 0) {
      return {
        success: false,
        error: 'Empty filter on deleteMany is not allowed — this would delete all documents. Use a specific filter.',
        tool: 'mongo',
        params: props,
      };
    }
  }

  // Get database connection from partner settings
  const connection = getDatabaseConnection(connectionId.trim(), state.context?.partner);
  if (!connection) {
    return {
      success: false,
      error: `Database connection '${connectionId}' not found in partner settings`,
      tool: 'mongo',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: query?.length || 0
      }
    };
  }

  if (connection.variant !== 'mongo') {
    return {
      success: false,
      error: `Connection '${connectionId}' is not a MongoDB connection (variant: ${connection.variant})`,
      tool: 'mongo',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: query?.length || 0
      }
    };
  }

  let client: MongoClient | null = null;
  let db: Db | null = null;
  let cached = false;
  let cacheKey: string | undefined;

  try {
    // Check cache if enabled
    if (cache) {
      cacheKey = generateCacheKey(connectionId, query || JSON.stringify(pipeline || filter), name);
      const cachedResult = state.vars?.[cacheKey] as any;
      if (cachedResult && cachedResult.timestamp > Date.now() - 300000) { // 5 minute cache
        cached = true;
        const executionTime = Date.now() - startTime;
        
        return {
          success: true,
          data: {
            name: name.trim(),
            query: query || JSON.stringify(pipeline || filter),
            connectionId: connectionId.trim(),
            variant: 'mongo',
            result: cachedResult.result,
            formattedOutput: cachedResult.formattedOutput,
            format,
            savedToFile: false,
            cached: true,
            cacheKey
          },
          tool: 'mongo',
          params: props,
          metadata: {
            executionTime,
            timestamp: new Date(),
            user: state.user?.id,
            connectionId: connectionId.trim(),
            variant: 'mongo',
            queryLength: query?.length || 0,
            rowCount: cachedResult.result.rowCount,
            columnCount: cachedResult.result.columns.length
          },
          instructions: `
## MongoDB Query Results (Cached)

Retrieved cached results for: **${name.trim()}**

### Query Information:
- **Connection**: ${connectionId.trim()}
- **Query**: ${query || JSON.stringify(pipeline || filter)}
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

    // Create MongoDB connection string
    const connectionString = `mongodb://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
    
    // Create MongoDB client
    client = new MongoClient(connectionString, {
      ...connection.options
    });

    // Connect to database
    await client.connect();
    db = client.db(connection.database);
    
    const queryStartTime = Date.now();
    let result: any;
    let queryType = 'unknown';

    // Handle write operations separately
    if (writeOperation) {
      if (!collection) {
        throw new Error('Collection name is required for write operations');
      }
      const coll = db.collection(collection);
      let writeResult: any;

      switch (writeOperation) {
        case 'insertOne': {
          writeResult = await coll.insertOne(document);
          queryType = 'insertOne';
          result = { insertedId: writeResult.insertedId, acknowledged: writeResult.acknowledged };
          break;
        }
        case 'insertMany': {
          writeResult = await coll.insertMany(documents!);
          queryType = 'insertMany';
          result = { insertedCount: writeResult.insertedCount, insertedIds: writeResult.insertedIds, acknowledged: writeResult.acknowledged };
          break;
        }
        case 'updateOne': {
          writeResult = await coll.updateOne(filter, update, { upsert });
          queryType = 'updateOne';
          result = {
            matchedCount: writeResult.matchedCount,
            modifiedCount: writeResult.modifiedCount,
            upsertedId: writeResult.upsertedId,
            acknowledged: writeResult.acknowledged,
          };
          break;
        }
        case 'updateMany': {
          writeResult = await coll.updateMany(filter, update, { upsert });
          queryType = 'updateMany';
          result = {
            matchedCount: writeResult.matchedCount,
            modifiedCount: writeResult.modifiedCount,
            upsertedId: writeResult.upsertedId,
            acknowledged: writeResult.acknowledged,
          };
          break;
        }
        case 'deleteOne': {
          writeResult = await coll.deleteOne(filter);
          queryType = 'deleteOne';
          result = { deletedCount: writeResult.deletedCount, acknowledged: writeResult.acknowledged };
          break;
        }
        case 'deleteMany': {
          writeResult = await coll.deleteMany(filter);
          queryType = 'deleteMany';
          result = { deletedCount: writeResult.deletedCount, acknowledged: writeResult.acknowledged };
          break;
        }
        default:
          throw new Error(`Unsupported write operation: ${writeOperation}`);
      }

      const writeExecutionTime = Date.now() - queryStartTime;
      const totalExecutionTime = Date.now() - startTime;

      logger.info(`MongoMacro write executed: ${name.trim()} [${writeOperation}] by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, collection: ${collection}`);

      return {
        success: true,
        data: {
          name: name.trim(),
          writeOperation,
          connectionId: connectionId.trim(),
          variant: 'mongo',
          result,
          collection,
          queryType,
        },
        tool: 'mongo',
        params: props,
        metadata: {
          executionTime: totalExecutionTime,
          timestamp: new Date(),
          user: state.user?.id,
          connectionId: connectionId.trim(),
          variant: 'mongo',
          queryLength: 0,
        },
        instructions: `
## MongoDB Write Result

Successfully executed **${writeOperation}** on **${collection}**: **${name.trim()}**

### Operation Details:
- **Connection**: ${connectionId.trim()}
- **Database**: ${connection.database}@${connection.host}:${connection.port}
- **Collection**: ${collection}
- **Operation**: ${writeOperation}
- **Execution Time**: ${writeExecutionTime}ms

### Result:
\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`
        `
      };
    }

    // Execute read query based on provided parameters
    if (pipeline && Array.isArray(pipeline)) {
      // Aggregation pipeline
      if (!collection) {
        throw new Error('Collection name is required for aggregation pipeline');
      }
      const coll = db.collection(collection);
      result = await coll.aggregate(pipeline).toArray();
      queryType = 'aggregation';
    } else if (filter) {
      // Find query with filter
      if (!collection) {
        throw new Error('Collection name is required for find query');
      }
      const coll = db.collection(collection);
      let cursor = coll.find(filter, projection);
      
      if (sort) cursor = cursor.sort(sort);
      if (skip) cursor = cursor.skip(skip);
      if (limit) cursor = cursor.limit(limit);
      
      result = await cursor.toArray();
      queryType = 'find';
    } else if (query) {
      // Raw query (eval - use with caution)
      // Note: This is potentially dangerous and should be restricted in production
      if (!collection) {
        throw new Error('Collection name is required for raw query');
      }
      const coll = db.collection(collection);
      
      // Parse the query as a find operation for safety
      try {
        const queryObj = JSON.parse(query);
        result = await coll.find(queryObj).toArray();
        queryType = 'find';
      } catch (parseError) {
        throw new Error('Invalid query format. Please use valid JSON for find operations.');
      }
    } else {
      throw new Error('No valid query parameters provided');
    }

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
    state.vars.lastMongoQuery = {
      name: name.trim(),
      query: query || JSON.stringify(pipeline || filter),
      connectionId: connectionId.trim(),
      collection,
      queryType,
      result: queryResult,
      formattedOutput,
      format,
      savedToFile,
      cached,
      lastExecuted: new Date()
    };

    // Log query for security
    logger.info(`MongoMacro executed: ${name.trim()} by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, collection: ${collection}, rows: ${queryResult.rowCount}`);

    return {
      success: true,
      data: {
        name: name.trim(),
        query: query || JSON.stringify(pipeline || filter),
        connectionId: connectionId.trim(),
        variant: 'mongo',
        result: queryResult,
        formattedOutput,
        format,
        savedToFile,
        filePath,
        cached,
        cacheKey
      },
      tool: 'mongo',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: query?.length || 0,
        rowCount: queryResult.rowCount,
        columnCount: queryResult.columns.length
      },
      instructions: `
## MongoDB Query Results

Successfully executed query: **${name.trim()}**

### Query Information:
- **Connection**: ${connectionId.trim()}
- **Database**: ${connection.database}@${connection.host}:${connection.port}
- **Collection**: ${collection || 'N/A'}
- **Query Type**: ${queryType}
- **Query**: ${query || JSON.stringify(pipeline || filter)}
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
- lastMongoQuery: Complete query information for future reference

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
    logger.error(`Error in MongoMacro for query ${name}:`, error);
    
    return {
      success: false,
      error: `MongoDB query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'mongo',
      params: props,
      metadata: {
        executionTime: totalExecutionTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: query?.length || 0
      }
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (error) {
        logger.error('Error closing MongoDB connection:', error);
      }
    }
  }
};

export const MongoMacroRegistry: MacroComponentDefinition<typeof MongoMacro> = {
  nameSpace: 'reactor-macros',
  name: 'mongo',
  version: '1.0.0',
  component: MongoMacro,
  description: 'Execute queries against MongoDB databases with structured results and comprehensive metadata',
  features: [],
  stem: 'mongo',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['database', 'mongo', 'mongodb', 'nosql', 'query', 'write', 'insert', 'update', 'delete'],
  tools: [{
    type: "function",
    function: {
      name: "mongo",
      description: "Execute read queries against MongoDB databases (find, aggregation, raw JSON query)",
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
            description: "JSON query string for find operations"
          },
          name: {
            type: "string",
            description: "Name for the operation"
          },
          collection: {
            type: "string",
            description: "MongoDB collection name"
          },
          pipeline: {
            type: "array",
            description: "MongoDB aggregation pipeline",
            items: {
              type: "object",
              description: "Aggregation stage"
            }
          },
          filter: {
            type: "object",
            description: "MongoDB find filter"
          },
          projection: {
            type: "object",
            description: "MongoDB projection (fields to return, e.g., {'name': 1, 'email': 1, '_id': 0})"
          },
          sort: {
            type: "object",
            description: "MongoDB sort options (e.g., {'name': 1, 'created': -1})"
          },
          limit: {
            type: "number",
            description: "MongoDB limit"
          },
          skip: {
            type: "number",
            description: "MongoDB skip"
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
        required: ["connectionId", "name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mongoWrite",
      description: "Execute write operations (insert, update, delete) against MongoDB databases with validation",
      icon: "edit",
      parameters: {
        type: "object",
        properties: {
          connectionId: {
            type: "string",
            description: "Connection ID from partner settings"
          },
          name: {
            type: "string",
            description: "Name for the operation"
          },
          collection: {
            type: "string",
            description: "MongoDB collection name"
          },
          writeOperation: {
            type: "string",
            enum: ["insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany"],
            description: "The write operation to perform"
          },
          document: {
            type: "object",
            description: "Document to insert (for insertOne)"
          },
          documents: {
            type: "array",
            items: { type: "object" },
            description: "Array of documents to insert (for insertMany)"
          },
          filter: {
            type: "object",
            description: "Filter for update/delete operations"
          },
          update: {
            type: "object",
            description: "Update operations (e.g., { '$set': { 'field': 'value' } })"
          },
          upsert: {
            type: "boolean",
            description: "If true, create a new document when no match is found (for update operations)"
          }
        },
        required: ["connectionId", "name", "collection", "writeOperation"]
      }
    }
  }]
}; 