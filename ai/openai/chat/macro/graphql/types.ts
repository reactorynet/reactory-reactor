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