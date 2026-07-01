
/**
 * Options shared by every web/http macro variant that control how the response
 * is cached to the agent's session workspace and whether a child summarizer
 * session is spawned to compress large HTML bodies.
 */
export interface WebMacroExtraOptions {
  /**
   * When true (default), the response body is written to a file under the
   * agent's session workspace so it does not bloat the parent context.
   */
  cacheToWorkspace?: boolean;
  /**
   * Responses larger than this many characters are replaced in `data.content`
   * with a small reference object pointing at the cached file. The full body
   * is always written to disk when `cacheToWorkspace` is true.
   */
  inlineThreshold?: number;
  /**
   * When true and the response is HTML, the HTML is stripped to plain text and
   * a child agent session is spawned to produce a structured summary. The
   * summary is returned to the parent agent in place of the raw body.
   */
  summarize?: boolean;
  /** Persona id to use for the summarizer child session. Defaults to the current session persona. */
  summaryPersonaId?: string;
  /** Optional guidance for what the summary should focus on. */
  summaryFocus?: string;
  /** Maximum number of plain-text characters to send to the summarizer (default 100000). */
  summaryMaxChars?: number;
}

/**
 * Properties for HTTP macro requests
 */
export interface HttpMacroProps extends WebMacroExtraOptions {
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
export interface GetMacroProps extends WebMacroExtraOptions {
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
export interface PostMacroProps extends WebMacroExtraOptions {
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
export interface PutMacroProps extends WebMacroExtraOptions {
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
export interface DeleteMacroProps extends WebMacroExtraOptions {
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
export interface PatchMacroProps extends WebMacroExtraOptions {
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
export interface FetchMacroProps extends WebMacroExtraOptions {
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
    /**
     * Response content. For small responses this is the raw body (text/json).
     * For large responses this is a small reference object pointing at the
     * cached file — see `inlined`, `cachedPath`.
     */
    content: any;
    /** Time taken for the HTTP request in milliseconds */
    responseTime: number;
    /** Size of response content in bytes */
    contentLength: number;
    /** MIME type of response */
    contentType: string;
    /** True when `content` holds the full body; false when `content` is a reference to the cached file. */
    inlined?: boolean;
    /** Path to the cached response body in the agent's session workspace (when caching is enabled). */
    cachedPath?: string;
    /** Size in bytes of the cached response body. */
    cachedSize?: number;
    /** Path to a plain-text extraction of an HTML response (when `summarize` is enabled). */
    textPath?: string;
    /** Size in bytes of the plain-text extraction. */
    textSize?: number;
    /** Summary produced by the child summarizer session (when `summarize` is enabled). */
    summary?: string;
    /** Conversation id of the child summarizer session, for follow-up messages. */
    summaryConversationId?: string;
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