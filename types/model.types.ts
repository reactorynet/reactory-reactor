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