/**
 * Property interfaces for fs macros - converting from array-based args to named parameters
 */
import { MacroErrorCode } from '../errors';

/**
 * Properties for ReadFile macro
 */
export interface ReadFileProps {
  /** The file path to read */
  path: string;
  /** Optional ID for the code block */
  id?: string;
}

/**
 * Return type for ReadFile macro
 */
export interface ReadFileResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** File data if operation succeeded */
  data?: {
    /** Raw file content as string */
    content: string;
    /** Formatted markdown code block with syntax highlighting */
    codeBlock: string;
    /** File statistics and properties */
    metadata: {
      /** Full file path */
      path: string;
      /** File size in bytes */
      size: number;
      /** File size formatted as human readable string */
      sizeFormatted: string;
      /** File extension/mime type */
      mimeType: string;
      /** Last modified date */
      lastModified: Date;
      /** File creation date */
      created: Date;
    };
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: ReadFileProps;
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Properties for WriteFile macro
 */
export interface WriteFileProps {
  /** The file path to write to */
  path: string;
  /** The content to write */
  content: string;
  /** Write mode: 'overwrite', 'create', 'append', 'prepend', or 'insert' */
  mode?: 'overwrite' | 'create' | 'append' | 'prepend' | 'insert';
  /** Start line number for insert mode */
  start?: string | number;
  /** End line number for insert mode */
  end?: string | number;
}

/**
 * Return type for WriteFile macro
 */
export interface WriteFileResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** File data if operation succeeded */
  data?: {
    /** Full file path */
    path: string;
    /** Written content */
    content: string;
    /** Write mode used */
    mode: string;
    /** File size in bytes */
    size: number;
    /** File size formatted as human readable string */
    sizeFormatted: string;
    /** Type of operation performed */
    operation: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: WriteFileProps;
  /** Metadata about the operation */
  metadata?: {
    /** Execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Whether file existed before operation */
    fileExisted: boolean;
    /** Type of operation performed */
    operationType: string;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * A single directory entry as returned by ListDirectory, in the shorthand form
 * the macro emits so a listing costs as few tokens as possible when it is sent
 * to a model. `ListDirectory`'s `instructions` field carries the same legend.
 */
export interface ListDirectoryItem {
  /** Name. */
  n: string;
  /** Extension, without the leading dot. Absent for directories. */
  e?: string;
  /** Size in bytes. */
  s?: number;
  /** True when the entry is a directory. */
  d: boolean;
  /** True when the entry is a file. */
  f: boolean;
  /** Path — repo/listing-relative when known, else absolute. */
  p?: string;
  /** Last modified, ISO 8601. */
  m?: string;
  [key: string]: unknown;
}

/**
 * Return type for ListDirectory macro
 */
export interface ListDirectoryResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /**
   * Directory data if operation succeeded.
   *
   * Keys are deliberately abbreviated: this payload goes to a model as a tool
   * result, and directory listings are large enough that full key names cost
   * real tokens on every row. The `instructions` field on the result documents
   * the legend for the model.
   */
  data?: {
    /** Full directory path. */
    p: string;
    /**
     * Directory entries in shorthand form:
     * `n` name, `e` extension, `s` size in bytes, `d` isDirectory,
     * `f` isFile, `p` path, `m` modified (ISO).
     */
    items: ListDirectoryItem[];
    /** Statistical summary of directory contents. */
    sum: {
      /** Total number of items. */
      t: number;
      /** Number of files. */
      f: number;
      /** Number of directories. */
      d: number;
      /** Total size in bytes. */
      s: number;
      /** Total size formatted as a human readable string. */
      sf: string;
    };
    /** Formatted output string. */
    out: string;
    /** Output format used. */
    fmt: string;
    /** File pattern filter used. */
    pat: string;
    /** Whether subfolders were included. */
    sub: boolean;
    /** Whether the listing was truncated. */
    tr?: boolean;
    /** Total entry count before truncation. */
    tc?: number;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: ListDirectoryProps;
  /** Metadata about the operation. Abbreviated for the same reason as `data`. */
  metadata?: {
    /** Execution time in milliseconds. */
    ms?: number;
    /** Timestamp of operation. */
    ts: Date;
    /** User who performed the operation. */
    u?: string;
    /** File pattern filter used. */
    pat: string;
    /** Output format used. */
    fmt: string;
    /** Whether subfolders were included. */
    sub: boolean;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Return type for PathInfo macro
 */
export interface PathInfoResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Path information data if operation succeeded */
  data?: {
    /** Complete PathInfo object */
    pathInfo: any;
    /** Human-readable summary of key information */
    summary: {
      /** Type of path (File, Directory, Symbolic Link, etc.) */
      type: string;
      /** Size formatted as human readable string */
      sizeFormatted: string;
      /** File permissions in rwx format */
      permissions: string;
      /** Last modified date as ISO string */
      lastModified: string;
      /** Whether the path is accessible */
      isAccessible: boolean;
    };
    /** JSON formatted output for display */
    formattedOutput: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: PathInfoProps;
  /** Metadata about the operation */
  metadata?: {
    /** Execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Path that was analyzed */
    path: string;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Return type for ExtractTextFromFile macro
 */
export interface ExtractTextFromFileResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** Text extraction data if operation succeeded */
  data?: {
    /** Full file path */
    path: string;
    /** Raw extracted text content */
    extractedText: string;
    /** Line range information */
    lineRange: {
      /** Start line number (1-based) */
      start: number;
      /** End line number (1-based) */
      end: number;
      /** Total number of lines in the file */
      totalLines: number;
    };
    /** File metadata */
    fileInfo: {
      /** File extension/mime type */
      mimeType: string;
      /** File size in bytes */
      size: number;
      /** File size formatted as human readable string */
      sizeFormatted: string;
      /** Last modified date */
      lastModified: Date;
    };
    /** Formatted code block for display */
    formattedOutput: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: ExtractTextFromFileProps;
  /** Metadata about the operation */
  metadata?: {
    /** Execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Path that was processed */
    path: string;
    /** Line range that was extracted */
    lineRange: string;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Properties for ListDirectory macro
 */
export interface ListDirectoryProps {
  /** The directory path to list */
  path: string;
  /** Whether to include subfolders */
  subfolders?: boolean;
  /** File pattern filter (supports wildcards) */
  pattern?: string;
  /** Output format: 'text', 'json', or formatter FQN */
  format?: string;
  /** Whether to escape output in code blocks */
  escape?: boolean;
}

/**
 * Properties for PathInfo macro
 */
export interface PathInfoProps {
  /** The file or directory path to get info for */
  path: string;
}

/**
 * Properties for RemoveDirectory macro
 */
export interface RemoveDirectoryProps {
  /** The directory path to remove */
  path: string;
}

/**
 * Properties for ExtractTextFromFile macro
 */
export interface ExtractTextFromFileProps {
  /** The file path to extract from */
  path: string;
  /** Start line number */
  start: string | number;
  /** End line number */
  end: string | number;
}

/**
 * Properties for InsertSnippet macro
 */
export interface InsertSnippetProps {
  /** The file path to insert into */
  path: string;
  /** Start line number */
  start: string;
  /** End line number (optional, defaults to start) */
  end?: string;
  /** The snippet content to insert */
  snippet: string;
  /**
   * If true, disables the automatic overlap-trimming safety feature. Set
   * to true when the snippet contains structural boundaries (such as `}`,
   * `]`, blank lines) that legitimately match the surrounding file lines
   * and must not be stripped.
   *
   * Default: false (overlap detection is on, but with the structural-line
   * refinement that already prevents the most common false positive).
   */
  exactMatch?: boolean;
}

/**
 * Return type for InsertSnippet macro.
 *
 * Mirrors the structured shape used by WriteFile so callers (AI agents,
 * UI, logs) can programmatically distinguish success from failure and
 * inspect what the macro actually did — overlap trimming is visible in
 * `data.trimmedLeading` / `data.trimmedTrailing`, which makes the
 * silent-mutation behaviour observable instead of opaque.
 */
export interface InsertSnippetResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** Result details if operation succeeded */
  data?: {
    /** Full file path */
    path: string;
    /** Operation mode: 'insert' (no end given) or 'replace' (start+end) */
    mode: 'insert' | 'replace';
    /** Operation type label, e.g. 'insert', 'replace', 'blocked_open_handles' */
    operation: string;
    /** Resolved 1-based start line */
    startLine: number;
    /** Resolved 1-based end line (startLine - 1 for pure insert) */
    endLine: number;
    /** Number of original file lines preserved before the edit point */
    linesBefore: number;
    /** Number of original file lines preserved after the edit point */
    linesAfter: number;
    /** Number of lines in the submitted snippet (before trim) */
    snippetLines: number;
    /** Number of snippet lines actually written (after any overlap trim) */
    insertedLines: number;
    /** Lines stripped from the leading edge by overlap detection */
    trimmedLeading: number;
    /** Lines stripped from the trailing edge by overlap detection */
    trimmedTrailing: number;
    /** Whether overlap detection was bypassed via exactMatch */
    exactMatch: boolean;
    /** Final total line count of the file */
    totalLines: number;
    /** File size in bytes after the edit */
    size: number;
    /** File size formatted as human readable string */
    sizeFormatted: string;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: InsertSnippetProps;
  /** Metadata about the operation */
  metadata?: {
    /** Execution time in milliseconds */
    executionTime: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** Whether file existed before operation */
    fileExisted: boolean;
    /** Type of operation performed */
    operationType: string;
  };
  /** Instructions for AI on how to use the data */
  instructions?: string;
}

/**
 * Properties for MakeDirectory macro
 */
export interface MakeDirectoryProps {
  /** Array of directory paths to create */
  paths: string[];
}

/**
 * Properties for DeleteDirectory macro
 */
export interface DeleteDirectoryProps {
  /** Array of directory paths to delete */
  paths: string[];
}

/**
 * Properties for CreateModuleStructure macro
 */
export interface CreateModuleStructureProps {
  /** Array of file paths to create in the module structure */
  fileStructure: string[];
  /** Optional content generators mapping patterns to generator IDs */
  contentGenerators?: Array<{
    pattern: string;
    generatorId: string;
  }>;
}