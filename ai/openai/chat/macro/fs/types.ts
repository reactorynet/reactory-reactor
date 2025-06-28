/**
 * Property interfaces for fs macros - converting from array-based args to named parameters
 */

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
  start?: string;
  /** End line number for insert mode */
  end?: string;
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
  start: string;
  /** End line number */
  end: string;
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