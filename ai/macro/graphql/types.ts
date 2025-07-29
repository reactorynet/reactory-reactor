/**
 * GraphQL macro property interfaces
 */

/**
 * Properties for GraphQL query macro
 */
export interface QueryGQLProps {
  /** The GraphQL query string */
  query?: string;
  /** Variables for the query as JSON string or object */
  variables?: string[] | object;
  /** Options for the query as JSON string or object */
  options?: string[] | object;
  /** Return format: 'string' or 'json' */
  format?: 'string' | 'json';
  /** Output mapping configuration */
  outmap?: any;
}

/**
 * Properties for GraphQL mutation macro
 */
export interface MutationGQLProps {
  /** The GraphQL mutation string */
  query?: string;
  /** Variables for the mutation as JSON string or object */
  variables?: string[] | object;
  /** Options for the mutation as JSON string or object */
  options?: string[] | object;
  /** Return format: 'string' or 'json' */
  format?: 'string' | 'json';
  /** Output mapping configuration */
  outmap?: any;
}

/**
 * Return type for QueryGQL macro
 */
export interface QueryGQLResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** GraphQL query data if operation succeeded */
  data?: {
    /** Query result data */
    result: any;
    /** Query string that was executed */
    query: string;
    /** Variables used in the query */
    variables: any;
    /** Options used for the query */
    options: any;
    /** Return format used */
    format: string;
    /** Output mapping applied */
    outmap?: any;
    /** Whether result was found */
    hasResult: boolean;
    /** Result size (if applicable) */
    resultSize?: number;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: QueryGQLProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Partner context */
    partner?: string;
    /** Query type */
    queryType: string;
    /** Query length */
    queryLength: number;
    /** Variables count */
    variablesCount: number;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Return type for MutationGQL macro
 */
export interface MutationGQLResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** GraphQL mutation data if operation succeeded */
  data?: {
    /** Mutation result data */
    result: any;
    /** Mutation string that was executed */
    query: string;
    /** Variables used in the mutation */
    variables: any;
    /** Options used for the mutation */
    options: any;
    /** Return format used */
    format: string;
    /** Output mapping applied */
    outmap?: any;
    /** Whether result was found */
    hasResult: boolean;
    /** Result size (if applicable) */
    resultSize?: number;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: MutationGQLProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Partner context */
    partner?: string;
    /** Query type */
    queryType: string;
    /** Query length */
    queryLength: number;
    /** Variables count */
    variablesCount: number;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}