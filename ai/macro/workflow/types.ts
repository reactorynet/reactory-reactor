

/**
 * Defines a function that formats and array of pathInfos into a string
 */
export type DirectoryListFormatter = (pathInfos: PathInfo[]) => string;

/**
 * Defines a service that can format a list of path infos into a string
 */
export type DirectoryListFormatterService = Reactory.Service.IReactoryService & {
  formatter: DirectoryListFormatter;
}

/**
 * Properties for ServiceRegister macro
 */
export interface ServiceRegisterProps {
  /** The action to perform: 'list' or 'get' */
  action?: 'list' | 'get';
  /** The service name (for get action) */
  name?: string;
  /** The service namespace (for get action) */
  nameSpace?: string;
  /** The service version (for get action) */
  version?: string;
  /** Properties for service initialization */
  props?: any;
  /** Function to call on the service */
  func?: string;
  /** Parameters for the function call */
  funcParams?: any[];
  /** Format for list output */
  format?: 'string' | 'object';
}

/**
 * Defines a Path Informaiton object that contains information about a file or directory
 */
export type PathInfo = {
  name: string;
  extension: string;
  size: number;
  created?: Date;
  modified?: Date;
  accessed?: Date;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  isBlockDevice?: boolean;
  isCharacterDevice?: boolean;
  isFIFO?: boolean;
  isSocket?: boolean;
  isWritable: boolean;
  isReadable: boolean;
  isExecutable: boolean;
  owner: string;
  group: string;
  mode?: string;
  path?: string;
  absolutePath?: string;
  relativePath?: string;
  parentPath?: string;
  parentAbsolutePath?: string;
  parentRelativePath?: string;
  error?: Error;
}

