/**
 * Database connection types
 */
import { MacroErrorCode } from '../errors';

export type DatabaseVariant = 'postgres' | 'mysql' | 'mongo' | 'mssql' | 'redis';

/**
 * Output format types for database results
 */
export type OutputFormat = 'json' | 'csv' | 'markdown' | 'text';

/**
 * Base properties for all database macros
 */
export interface DatabaseMacroProps {
  /** Connection ID from partner settings */
  connectionId: string;
  /** SQL query to execute */
  query: string;
  /** Name for the operation */
  name: string;
  /** Output format */
  format?: OutputFormat;
  /** Whether to save output to file */
  file?: boolean;
  /** Whether to cache results */
  cache?: boolean;
}

/**
 * Database connection configuration
 */
export interface DatabaseConnection {
  /** Connection variant */
  variant: DatabaseVariant;
  /** Host address */
  host: string;
  /** Port number */
  port: number;
  /** Database name */
  database: string;
  /** Username */
  username: string;
  /** Password */
  password: string;
  /** Additional connection options */
  options?: Record<string, any>;
}

/**
 * Database query result
 */
export interface DatabaseQueryResult {
  /** Query execution time in milliseconds */
  executionTime: number;
  /** Number of rows returned */
  rowCount: number;
  /** Column names */
  columns: string[];
  /** Query results as array of objects */
  rows: Record<string, any>[];
  /** Raw query result */
  raw: any;
  /** Whether query was successful */
  success: boolean;
  /** Error message if query failed */
  error?: string;
}

/**
 * Base result type for database macros
 */
export interface DatabaseMacroResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** Database operation data if operation succeeded */
  data?: {
    /** Operation name */
    name: string;
    /** SQL query executed */
    query: string;
    /** Connection ID used */
    connectionId: string;
    /** Database variant */
    variant: DatabaseVariant;
    /** Query results */
    result: DatabaseQueryResult;
    /** Formatted output based on format parameter */
    formattedOutput: string;
    /** Output format used */
    format: OutputFormat;
    /** Whether output was saved to file */
    savedToFile: boolean;
    /** File path if saved */
    filePath?: string;
    /** Whether results were cached */
    cached: boolean;
    /** Cache key if cached */
    cacheKey?: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: DatabaseMacroProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Connection ID used */
    connectionId: string;
    /** Database variant */
    variant: DatabaseVariant;
    /** Query length */
    queryLength: number;
    /** Row count */
    rowCount?: number;
    /** Column count */
    columnCount?: number;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Result type for MongoDB write operations (insert, update, delete).
 * Separate from DatabaseMacroResult because write results carry
 * operation-specific fields instead of query rows / formatted output.
 */
export interface MongoWriteMacroResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** Write operation data if succeeded */
  data?: {
    /** Operation name */
    name: string;
    /** The write operation that was performed */
    writeOperation: string;
    /** Connection ID used */
    connectionId: string;
    /** Database variant */
    variant: DatabaseVariant;
    /** MongoDB collection name */
    collection: string;
    /** Operation-specific result (insertedId, matchedCount, deletedCount, etc.) */
    result: any;
    /** Categorised query type (insertOne, updateMany, etc.) */
    queryType: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: any;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Connection ID used */
    connectionId: string;
    /** Database variant */
    variant: DatabaseVariant;
    /** Query length */
    queryLength: number;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}