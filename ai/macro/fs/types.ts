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
 * Return type for ListDirectory macro
 */
export interface ListDirectoryResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Standardized error code for programmatic handling */
  errorCode?: MacroErrorCode;
  /** Directory data if operation succeeded */
  data?: {
    /** Full directory path */
    path: string;
    /** Array of PathInfo objects */
    items: any[];
    /** Statistical summary of directory contents */
    summary: {
      /** Total number of items */
      totalItems: number;
      /** Number of files */
      files: number;
      /** Number of directories */
      directories: number;
      /** Total size in bytes */
      totalSize: number;
      /** Total size formatted as human readable string */
      totalSizeFormatted: string;
    };
    /** Formatted output string */
    formattedOutput: string;
    /** Output format used */
    format: string;
    /** File pattern filter used */
    pattern: string;
    /** Whether subfolders were included */
    includeSubfolders: boolean;
  };
  /** Tool name for context */
  tool: string;
  /** Original parameters passed to the macro */
  params: ListDirectoryProps;
  /** Metadata about the operation */
  metadata?: {
    /** Execution time in milliseconds */
    executionTime?: number;
    /** Timestamp of operation */
    timestamp: Date;
    /** User who performed the operation */
    user?: string;
    /** File pattern filter used */
    pattern: string;
    /** Output format used */
    format: string;
    /** Whether subfolders were included */
    includeSubfolders: boolean;
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