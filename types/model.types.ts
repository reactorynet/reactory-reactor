import { ObjectId } from 'mongodb';

export enum ReactorNodeType { 
  INPUT = 'INPUT',
  OUTPUT = 'OUTPUT',
  PROCESS = 'PROCESS',
  SYSTEM = 'SYSTEM',
  DATASTORE = 'DATASTORE',
  CHILD = 'CHILD',  
  CONNECTION = 'CONNECTION',
  DEPENDENCY = 'DEPENDENCY',
  CONTAINER = 'CONTAINER',
  CLOUD = 'CLOUD',
  CONSUMER = 'CONSUMER',
  CONFIG = 'CONFIG',
  FOLDER = 'FOLDER',
  FILE = 'FILE',
  FUNCTION = 'FUNCTION',
  ENDPOINT = 'ENDPOINT',
}


export interface ReactorNodeCategory {
  id: string | ObjectId
  name: string
  description: string
  children: ReactorNodeCategory[]
  nodes?: ReactorNode[]
}

export interface ReactorNodeMetricType {
  id: string | ObjectId
  name: string
  description?: string
  units: string
}

export interface ReactorNodeMetric {
  id: string | ObjectId
  type: ReactorNodeMetricType
  value: string
}

export interface ReactorNodeLink {
  id: string | ObjectId
  type: string
  description: string
  source: string | ObjectId
  target: string | ObjectId
}

export interface ReactorNodeForceLink extends ReactorNodeLink { 
  value: number;
}

export interface ReactorNodeAttribute {
  id: number
  key: string
  value: string  
}

export interface ReactorNode extends Reactory.IComponentFqnDefinition {
  id: number
  index: number
  key: string
  type: ReactorNodeType
  categories?: ReactorNodeCategory[]  
  description?: string
  parentId?: number
  source?: string
  locations?: string[]
  providerId?: string
  attributes?: ReactorNodeAttribute[] 
  metrics?: ReactorNodeMetric[]
  children?: ReactorNode[]
  dependencies?: ReactorNode[]  
  inputs?: ReactorNode[]
  outputs?: ReactorNode[]
  links?: Partial<ReactorNodeLink>[]
  created?: Date
  updated?: Date
  data: any
}

export interface ReactorDataNode<T> extends ReactorNode { 
  data: T
}

export interface ReactorNodePosition {
  x: number
  y: number
}

export interface ReactorNodeOption {
  id: number
  key: string
  value: string
}

export interface ReactorNodeUI {
  id: number
  node: ReactorNode | ReactorDataNode<any>
  position: ReactorNodePosition
  options: ReactorNodeOption[]
}

/**
 * Generic AI Model definition for provider abstraction.
 */
export interface AIModel {
  id: string;
  name?: string;
  created?: number;
  provider?: string;
  [key: string]: any;
}

/**
 * Generic list response for AI provider abstraction.
 */
export interface AIListResponse<T> {
  data: T[];
  object: string;
  has_more?: boolean;
}

/**
 * Generic fine-tuning job object for provider abstraction.
 */
export interface AIFineTuningJob {
  id: string;
  model: string;
  created_at: number;
  finished_at?: number;
  fine_tuned_model?: string;
  status: string;
  [key: string]: any;
}

/**
 * Generic fine-tuning job creation params.
 */
export interface CreateAIFineTuningJobParams {
  model: string;
  training_file: string;
  validation_file?: string;
  hyperparameters?: Record<string, any>;
  suffix?: string;
}

/**
 * Generic fine-tuning event.
 */
export interface AIFineTuningEvent {
  id: string;
  created_at: number;
  level: string;
  message: string;
  object: string;
}

/**
 * Generic file object for AI provider abstraction.
 */
export interface AIFile {
  id: string;
  object: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status_details?: string;
  url?: string;
  [key: string]: any;
}

/**
 * Generic image object for AI provider abstraction.
 */
export interface AIImage {
  url?: string;
  b64_json?: string;
  [key: string]: any;
}

/**
 * Generic image generation result.
 */
export interface AIImageGenerationResult {
  created: number;
  data: Partial<AIImage>[];
}

/**
 * Generic image generation params.
 */
export interface AIImageGenerationParams {
  prompt: string;
  n?: number;
  response_format?: string;
  size?: string;
  user?: string;
  [key: string]: any;
}

/**
 * Generic chat params for AI provider abstraction.
 */
export interface AIChatParams {
  personaId: string;
  message: string;
  chatSessionId?: string;
  [key: string]: any;
}

/**
 * Generic audio chat params for AI provider abstraction.
 */
export interface AIAudioChatParams extends AIChatParams {
  audio: string | Buffer[];
  format: string;
  [key: string]: any;
}

/**
 * Generic chat choice object for AI provider abstraction.
 */
export interface AIChatChoice { 
  index: number;
  message: {
    role: string;
    content: string;
    tool_calls?: {
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }[];
  };
  finish_reason: string;
  [key: string]: any;
}

/**
 * Generic chat completion result for AI provider abstraction.
 */
export interface AIChatCompletion {
  id: ObjectId | string;
  object: string;
  created: Date;
  choices: AIChatChoice[];
  [key: string]: any;
}

export interface McpSession {
  id: string | ObjectId;
  serverName: string;
  description?: string;
  serviceCommand?: string;
  headers?: Record<string, string>;
  url?: string;
  token?: string;
  tools?: any[]; 
  status: 'active' | 'inactive' | 'terminated' | 'error' | 'pending';
  created: Date;
  updated: Date;
  expires?: Date;
}

export interface BackStageCatalogInfo {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    annotations?: Record<string, string>;
    title?: string;
    description?: string;
    links?: Array<{
      title: string;
      url: string;
    }>;
    tags?: string[];
  };
  spec: {
    owner: string;
    system?: string;
    type?: string;
    lifecycle?: string;
    [key: string]: any;
  };
}

export interface Manifest {
  metadata: {
    type: string;
    project: string;
    description: string;
    category: string;
    tier: string;
    data_classification: string;
    last_updated: string;
    owner: {
      team: string;
      slack: string;
      email: string;
    };
    escalation: {
      slack: string;
      pagerduty_svc: string;
    };
    [key: string]: any;
  };
}

export interface ResourceYaml {
  version: string;
  metadata: {
    name: string;
    team: string;
    project: string;
    owner_contact: string;
    [key: string]: any;
  };
  environments: Array<{
    name: string;
    resources: Array<{
      name: string;
      type: string;
      spec: Record<string, any>;
      [key: string]: any;
    }>;
    [key: string]: any;
  }>;
  [key: string]: any;
}