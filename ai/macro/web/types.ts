
/**
 * Properties for HTTP macro requests
 */
export interface HttpMacroProps {
  /** The URL to send the request to */
  url: string;
  /** The HTTP method to use */
  method: string;
  /** Request options (can be a string, object, or function) */
  options?: any;
  /** The format to return the data in (text, json, blob) */
  returnFormat?: 'text' | 'json' | 'blob';
}

/**
 * Properties for GET requests
 */
export interface GetMacroProps {
  /** The URL to send the GET request to */
  url: string;
  /** The format to return the data in (text, json, blob) */
  format?: 'text' | 'json' | 'blob';
  /** Request options (can be a string, object, or function) */
  options?: any;
}

/**
 * Properties for POST requests
 */
export interface PostMacroProps {
  /** The URL to send the POST request to */
  url: string;
  /** The format to return the data in (text, json, blob) */
  format?: 'text' | 'json' | 'blob';
  /** Request options (can be a string, object, or function) */
  options?: any;
}

/**
 * Properties for PUT requests
 */
export interface PutMacroProps {
  /** The URL to send the PUT request to */
  url: string;
  /** The format to return the data in (text, json, blob) */
  format?: 'text' | 'json' | 'blob';
  /** Request options (can be a string, object, or function) */
  options?: any;
}

/**
 * Properties for DELETE requests
 */
export interface DeleteMacroProps {
  /** The URL to send the DELETE request to */
  url: string;
  /** The format to return the data in (text, json, blob) */
  format?: 'text' | 'json' | 'blob';
  /** Request options (can be a string, object, or function) */
  options?: any;
}

/**
 * Properties for PATCH requests
 */
export interface PatchMacroProps {
  /** The URL to send the PATCH request to */
  url: string;
  /** The format to return the data in (text, json, blob) */
  format?: 'text' | 'json' | 'blob';
  /** Request options (can be a string, object, or function) */
  options?: any;
}

/**
 * Properties for the legacy FetchMacro
 */
export interface FetchMacroProps {
  /** The URL to send the request to */
  url: string;
  /** Request initialization options */
  requestInit?: RequestInit;
  /** The format to return the data in (text, json, blob) */
  returnFormat?: 'text' | 'json' | 'blob';
}

/**
 * Return type for HTTP macros
 */
export interface HttpMacroResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** HTTP response data if operation succeeded */
  data?: {
    /** Full URL that was requested */
    url: string;
    /** HTTP method used */
    method: string;
    /** HTTP status code */
    status: number;
    /** HTTP status text */
    statusText: string;
    /** Response headers as key-value pairs */
    headers: Record<string, string>;
    /** Response content (formatted according to returnFormat) */
    content: any;
    /** Time taken for the HTTP request in milliseconds */
    responseTime: number;
    /** Size of response content in bytes */
    contentLength: number;
    /** MIME type of response */
    contentType: string;
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
    /** URL that was requested */
    url: string;
    /** HTTP method used */
    method: string;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}