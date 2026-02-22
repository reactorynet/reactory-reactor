import { MongoClient, Db } from 'mongodb';
import { ChatState, Macro, MacroComponentDefinition } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';
import { DatabaseMacroProps, DatabaseMacroResult, DatabaseConnection, MongoWriteMacroResult } from '../types';
import {
  getDatabaseConnection,
  formatQueryResults,
  saveToFile,
  generateCacheKey,
  createQueryResult
} from '../utils';
import logger from '@reactory/server-core/logging';

// ─── Props interfaces ────────────────────────────────────────────────────────

/**
 * Props for MongoDB read operations (find, aggregation, raw query).
 */
export interface MongoReadMacroProps extends DatabaseMacroProps {
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
}

/**
 * Props for MongoDB write operations (insert, update, delete).
 */
export interface MongoWriteMacroProps {
  /** Connection ID from partner settings */
  connectionId: string;
  /** Name for the operation */
  name: string;
  /** MongoDB collection name */
  collection: string;
  /** Write operation type */
  writeOperation: 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
  /** Document to insert (for insertOne) */
  document?: any;
  /** Array of documents for insertMany */
  documents?: any[];
  /** MongoDB query filter (for update / delete operations) */
  filter?: any;
  /** Update operations ($set, $unset, etc.) */
  update?: any;
  /** If true, create a new document when no match is found (for update operations) */
  upsert?: boolean;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

interface MongoConnection {
  client: MongoClient;
  db: Db;
  connection: DatabaseConnection;
}

/**
 * Resolve a partner database connection, create a MongoClient and connect.
 * Returns an error result if validation fails so the caller can return early.
 */
async function connectMongo(
  connectionId: string,
  state: ChatState,
  toolName: string,
  props: any,
  startTime: number,
): Promise<MongoConnection | { error: any }> {
  const connection = getDatabaseConnection(connectionId.trim(), state.context?.partner);
  if (!connection) {
    return {
      error: {
        success: false,
        error: `Database connection '${connectionId}' not found in partner settings`,
        tool: toolName,
        params: props,
        metadata: {
          executionTime: Date.now() - startTime,
          timestamp: new Date(),
          user: state.user?.id,
          connectionId: connectionId.trim(),
          variant: 'mongo',
          queryLength: 0,
        },
      },
    };
  }

  if (connection.variant !== 'mongo') {
    return {
      error: {
        success: false,
        error: `Connection '${connectionId}' is not a MongoDB connection (variant: ${connection.variant})`,
        tool: toolName,
        params: props,
        metadata: {
          executionTime: Date.now() - startTime,
          timestamp: new Date(),
          user: state.user?.id,
          connectionId: connectionId.trim(),
          variant: 'mongo',
          queryLength: 0,
        },
      },
    };
  }

  const connectionString = `mongodb://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.database}`;
  const client = new MongoClient(connectionString, { ...connection.options });
  await client.connect();
  const db = client.db(connection.database);

  return { client, db, connection };
}

function isConnectionError(result: MongoConnection | { error: any }): result is { error: any } {
  return 'error' in result && !('client' in result);
}

// ─── MongoReadMacro ──────────────────────────────────────────────────────────

/**
 * MongoDB read macro – executes find, aggregation, or raw JSON queries.
 */
export const MongoReadMacro: Macro<DatabaseMacroResult, MongoReadMacroProps> = async (
  props: MongoReadMacroProps,
  state: ChatState,
): Promise<DatabaseMacroResult> => {
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
  } = props;

  if (!connectionId || connectionId.trim().length === 0) {
    return { success: false, error: 'Connection ID is required', tool: 'mongo', params: props };
  }

  if (!name || name.trim().length === 0) {
    return { success: false, error: 'Operation name is required', tool: 'mongo', params: props };
  }

  if (!query && !pipeline && !filter) {
    return {
      success: false,
      error: 'Either query, pipeline, or filter is required',
      tool: 'mongo',
      params: props,
      metadata: {
        executionTime: Date.now() - startTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: 0,
      },
    };
  }

  let client: MongoClient | null = null;
  let cached = false;
  let cacheKey: string | undefined;

  try {
    // Check cache
    if (cache) {
      cacheKey = generateCacheKey(connectionId, query || JSON.stringify(pipeline || filter), name);
      const cachedResult = state.vars?.[cacheKey] as any;
      if (cachedResult && cachedResult.timestamp > Date.now() - 300000) {
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
            cacheKey,
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
            columnCount: cachedResult.result.columns.length,
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

### Usage:
- Use \`result.rows\` for raw query results
- Use \`formattedOutput\` for formatted display
- Use \`result.rowCount\` for result count
          `,
        };
      }
    }

    // Connect
    const conn = await connectMongo(connectionId, state, 'mongo', props, startTime);
    if (isConnectionError(conn)) return conn.error;
    client = conn.client;

    const queryStartTime = Date.now();
    let result: any;
    let queryType = 'unknown';

    if (pipeline && Array.isArray(pipeline)) {
      if (!collection) throw new Error('Collection name is required for aggregation pipeline');
      result = await conn.db.collection(collection).aggregate(pipeline).toArray();
      queryType = 'aggregation';
    } else if (filter) {
      if (!collection) throw new Error('Collection name is required for find query');
      let cursor = conn.db.collection(collection).find(filter, projection);
      if (sort) cursor = cursor.sort(sort);
      if (skip) cursor = cursor.skip(skip);
      if (limit) cursor = cursor.limit(limit);
      result = await cursor.toArray();
      queryType = 'find';
    } else if (query) {
      if (!collection) throw new Error('Collection name is required for raw query');
      try {
        const queryObj = JSON.parse(query);
        result = await conn.db.collection(collection).find(queryObj).toArray();
        queryType = 'find';
      } catch {
        throw new Error('Invalid query format. Please use valid JSON for find operations.');
      }
    } else {
      throw new Error('No valid query parameters provided');
    }

    const queryExecutionTime = Date.now() - queryStartTime;
    const queryResult = createQueryResult(result, queryExecutionTime, true);
    const totalExecutionTime = Date.now() - startTime;
    const formattedOutput = formatQueryResults(queryResult, format, name.trim());

    // Save to file
    let savedToFile = false;
    let filePath: string | undefined;
    if (file) {
      const saveResult = await saveToFile(formattedOutput, name.trim(), format, state.user?.id);
      savedToFile = saveResult.success;
      filePath = saveResult.filePath;
    }

    // Cache
    if (cache && cacheKey) {
      if (!state.vars) state.vars = {};
      state.vars[cacheKey] = { result: queryResult, formattedOutput, timestamp: Date.now() };
    }

    // Store in state
    if (!state.vars) state.vars = {};
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
      lastExecuted: new Date(),
    };

    logger.info(`MongoReadMacro executed: ${name.trim()} by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, collection: ${collection}, rows: ${queryResult.rowCount}`);

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
        cacheKey,
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
        columnCount: queryResult.columns.length,
      },
      instructions: `
## MongoDB Query Results

Successfully executed query: **${name.trim()}**

### Query Information:
- **Connection**: ${connectionId.trim()}
- **Database**: ${conn.connection.database}@${conn.connection.host}:${conn.connection.port}
- **Collection**: ${collection || 'N/A'}
- **Query Type**: ${queryType}
- **Rows Returned**: ${queryResult.rowCount}
- **Columns**: ${queryResult.columns.length}
- **Query Time**: ${queryExecutionTime}ms
- **Total Time**: ${totalExecutionTime}ms
- **Cached**: ${cached ? 'Yes' : 'No'}
- **Saved to File**: ${savedToFile ? 'Yes' : 'No'}

### State Variables Available:
- lastMongoQuery: Complete query information for future reference

### Usage:
- Use \`result.rows\` for raw query results
- Use \`formattedOutput\` for formatted display
- Use \`result.rowCount\` for result count
- Use \`result.columns\` for column names
      `,
    };
  } catch (error) {
    const totalExecutionTime = Date.now() - startTime;
    logger.error(`Error in MongoReadMacro for query ${name}:`, error);
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
        queryLength: query?.length || 0,
      },
    };
  } finally {
    if (client) {
      try { await client.close(); } catch (e) { logger.error('Error closing MongoDB connection:', e); }
    }
  }
};

// ─── MongoWriteMacro ─────────────────────────────────────────────────────────

/**
 * MongoDB write macro – executes insert, update, and delete operations.
 */
export const MongoWriteMacro: Macro<MongoWriteMacroResult, MongoWriteMacroProps> = async (
  props: MongoWriteMacroProps,
  state: ChatState,
): Promise<MongoWriteMacroResult> => {
  const startTime = Date.now();
  const {
    connectionId,
    name,
    collection,
    writeOperation,
    document,
    documents,
    filter,
    update,
    upsert = false,
  } = props;

  // ── Validation ───────────────────────────────────────────
  if (!connectionId || connectionId.trim().length === 0) {
    return { success: false, error: 'Connection ID is required', tool: 'mongoWrite', params: props };
  }

  if (!name || name.trim().length === 0) {
    return { success: false, error: 'Operation name is required', tool: 'mongoWrite', params: props };
  }

  if (!collection || collection.trim().length === 0) {
    return { success: false, error: 'Collection name is required for write operations', tool: 'mongoWrite', params: props };
  }

  if (!writeOperation) {
    return { success: false, error: 'writeOperation is required', tool: 'mongoWrite', params: props };
  }

  if (writeOperation === 'insertOne' && !document) {
    return { success: false, error: 'A document is required for insertOne operations', tool: 'mongoWrite', params: props };
  }

  if (writeOperation === 'insertMany' && (!documents || !Array.isArray(documents) || documents.length === 0)) {
    return { success: false, error: 'A non-empty documents array is required for insertMany operations', tool: 'mongoWrite', params: props };
  }

  if ((writeOperation === 'updateOne' || writeOperation === 'updateMany') && (!filter || !update)) {
    return { success: false, error: 'Both filter and update are required for update operations', tool: 'mongoWrite', params: props };
  }

  if ((writeOperation === 'deleteOne' || writeOperation === 'deleteMany') && !filter) {
    return { success: false, error: 'A filter is required for delete operations', tool: 'mongoWrite', params: props };
  }

  if (writeOperation === 'deleteMany' && filter && Object.keys(filter).length === 0) {
    return {
      success: false,
      error: 'Empty filter on deleteMany is not allowed — this would delete all documents. Use a specific filter.',
      tool: 'mongoWrite',
      params: props,
    };
  }

  // ── Connect ──────────────────────────────────────────────
  let client: MongoClient | null = null;

  try {
    const conn = await connectMongo(connectionId, state, 'mongoWrite', props, startTime);
    if (isConnectionError(conn)) return conn.error;
    client = conn.client;

    const coll = conn.db.collection(collection);
    const opStartTime = Date.now();
    let result: any;
    let queryType: string = writeOperation;

    switch (writeOperation) {
      case 'insertOne': {
        const wr = await coll.insertOne(document);
        result = { insertedId: wr.insertedId, acknowledged: wr.acknowledged };
        break;
      }
      case 'insertMany': {
        const wr = await coll.insertMany(documents!);
        result = { insertedCount: wr.insertedCount, insertedIds: wr.insertedIds, acknowledged: wr.acknowledged };
        break;
      }
      case 'updateOne': {
        const wr = await coll.updateOne(filter, update, { upsert });
        result = { matchedCount: wr.matchedCount, modifiedCount: wr.modifiedCount, upsertedId: wr.upsertedId, acknowledged: wr.acknowledged };
        break;
      }
      case 'updateMany': {
        const wr = await coll.updateMany(filter, update, { upsert });
        result = { matchedCount: wr.matchedCount, modifiedCount: wr.modifiedCount, upsertedId: wr.upsertedId, acknowledged: wr.acknowledged };
        break;
      }
      case 'deleteOne': {
        const wr = await coll.deleteOne(filter);
        result = { deletedCount: wr.deletedCount, acknowledged: wr.acknowledged };
        break;
      }
      case 'deleteMany': {
        const wr = await coll.deleteMany(filter);
        result = { deletedCount: wr.deletedCount, acknowledged: wr.acknowledged };
        break;
      }
      default:
        throw new Error(`Unsupported write operation: ${writeOperation}`);
    }

    const opTime = Date.now() - opStartTime;
    const totalTime = Date.now() - startTime;

    logger.info(`MongoWriteMacro executed: ${name.trim()} [${writeOperation}] by user: ${state.user?.id || 'unknown'}, connection: ${connectionId.trim()}, collection: ${collection}`);

    return {
      success: true,
      data: {
        name: name.trim(),
        writeOperation,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        collection,
        result,
        queryType,
      },
      tool: 'mongoWrite',
      params: props,
      metadata: {
        executionTime: totalTime,
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
- **Database**: ${conn.connection.database}@${conn.connection.host}:${conn.connection.port}
- **Collection**: ${collection}
- **Operation**: ${writeOperation}
- **Execution Time**: ${opTime}ms

### Result:
\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`
      `,
    };
  } catch (error) {
    const totalTime = Date.now() - startTime;
    logger.error(`Error in MongoWriteMacro for operation ${name}:`, error);
    return {
      success: false,
      error: `MongoDB write failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      tool: 'mongoWrite',
      params: props,
      metadata: {
        executionTime: totalTime,
        timestamp: new Date(),
        user: state.user?.id,
        connectionId: connectionId.trim(),
        variant: 'mongo',
        queryLength: 0,
      },
    };
  } finally {
    if (client) {
      try { await client.close(); } catch (e) { logger.error('Error closing MongoDB connection:', e); }
    }
  }
};

// ─── Registry definitions (1 tool per macro) ─────────────────────────────────

export const MongoReadMacroRegistry: MacroComponentDefinition<typeof MongoReadMacro> = {
  nameSpace: 'reactor-macros',
  name: 'mongo',
  version: '1.0.0',
  component: MongoReadMacro,
  description: 'Execute read queries against MongoDB databases (find, aggregation, raw JSON query)',
  features: [],
  stem: 'mongo',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['database', 'mongo', 'mongodb', 'nosql', 'query', 'read', 'find', 'aggregate'],
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
  }]
};

export const MongoWriteMacroRegistry: MacroComponentDefinition<typeof MongoWriteMacro> = {
  nameSpace: 'reactor-macros',
  name: 'mongoWrite',
  version: '1.0.0',
  component: MongoWriteMacro,
  description: 'Execute write operations (insert, update, delete) against MongoDB databases with validation',
  features: [],
  stem: 'mongo',
  roles: ['DEVELOPER', 'ADMIN'],
  tags: ['database', 'mongo', 'mongodb', 'nosql', 'write', 'insert', 'update', 'delete'],
  tools: [{
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
