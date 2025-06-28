
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