/**
 * User macro property interfaces
 */

/**
 * Properties for GetUser macro
 */
export interface GetUserProps {
  /** The email address of the user to find */
  email: string;
}

/**
 * Properties for SearchUser macro
 */
export interface SearchUserProps {
  /** Search query matching against user name or email */
  query?: string;
  /** Alternative parameter name for query */
  searchString?: string;
  /** Email to search/filter by */
  email?: string;
  /** Name to search/filter by */
  name?: string;
  /** Maximum number of users to return (default: 10) */
  limit?: number;
}

/**
 * User summary data item
 */
export interface SearchUserData {
  /** User ID */
  id: string;
  /** User's first name */
  firstName: string;
  /** User's last name */
  lastName: string;
  /** User's email address */
  email: string;
  /** Formatted user display name */
  displayName: string;
}

/**
 * Return type for SearchUser macro
 */
export interface SearchUserResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Array of users found matching search criteria */
  data?: SearchUserData[];
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: SearchUserProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Search term that was queried */
    query?: string;
    /** Total results count */
    total?: number;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Properties for CreateUser macro
 */
export interface CreateUserProps {
  /** The email address of the new user */
  email: string;
  /** The first name of the new user */
  firstName: string;
  /** The last name of the new user */
  lastName: string;
}

/**
 * Return type for GetUser macro
 */
export interface GetUserResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** User data if operation succeeded */
  data?: {
    /** User ID */
    id: string;
    /** User's first name */
    firstName: string;
    /** User's last name */
    lastName: string;
    /** User's email address */
    email: string;
    /** Whether user was found */
    found: boolean;
    /** Formatted user display name */
    displayName: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: GetUserProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Email that was searched */
    email: string;
    /** Whether user was found */
    found?: boolean;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Return type for CreateUser macro
 */
export interface CreateUserResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** User data if operation succeeded */
  data?: {
    /** User ID */
    id: string;
    /** User's first name */
    firstName: string;
    /** User's last name */
    lastName: string;
    /** User's email address */
    email: string;
    /** Whether user was created (vs already existed) */
    created: boolean;
    /** Formatted user display name */
    displayName: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: CreateUserProps;
  /** Metadata about the operation */
  metadata?: {
    /** Total execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Email that was processed */
    email: string;
    /** Whether user was created */
    created?: boolean;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}
