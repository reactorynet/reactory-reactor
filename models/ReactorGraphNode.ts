import mongoose, { Schema } from 'mongoose';
import { ObjectId } from 'mongodb';
import Reactory from '@reactorynet/reactory-core';
import Hash from '@reactory/server-core/utils/hash';
import { 
  ReactorNodeCategory, 
  ReactorNode, 
  ReactorNodeType, 
  ReactorNodeMetricType, 
  ReactorNodeUI, 
  ReactorNodeMetric
} from '../types/model.types';


const ColumnCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.columncategory@1.0.0`)),
  name: 'Column',
  description: 'Column',
  children: []
}

const ViewCategory: ReactorNodeCategory = {
  id: new ObjectId(Hash(`reactor.viewcategory@1.0.0`)),
  name: 'View',
  description: 'View',
  children: [ColumnCategory]
}

const StoredProcedureCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.storedprocedurecategory@1.0.0`)),
  name: 'Stored Procedure',
  description: 'Stored Procedure',
  children: [ColumnCategory]
}

const TableCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.tablecategory@1.0.0`)),
  name: 'Table',
  description: 'Table',
  children: [ColumnCategory]  
}

const DatabaseCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.databasecategory@1.0.0`)),
  name: 'Database',
  description: 'Database',
  children: [
    TableCategory,
    StoredProcedureCategory,
    ViewCategory,
    ColumnCategory,
  ]
}

const MicroServiceCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.microservicecategory@1.0.0`)),
  name: 'Micro Service',
  description: 'Micro Service',
  children: []
}

const GraphQLCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.graphqlcategory@1.0.0`)),
  name: 'GraphQL',
  description: 'GraphQL',
  children: []
}

const RestCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.restcategory@1.0.0`)),
  name: 'REST',
  description: 'REST',
  children: []
}

const ThirdPartyCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.thirdpartycategory@1.0.0`)),
  name: 'Third Party',
  description: 'Third Party',
  children: []
}

const DevOpsCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.devopscategory@1.0.0`)),
  name: 'DevOps',
  description: 'DevOps',
  children: []
}


const HttpTransportCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.httptransportcategory@1.0.0`)),
  name: 'HTTP',
  description: 'HTTP',
  children: []
}

const GrpcTransportCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.grpctransportcategory@1.0.0`)),
  name: 'GRPC',
  description: 'GRPC',
  children: []
}

const TransportCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.transportcategory@1.0.0`)),
  name: 'Transport',
  description: 'Transport',
  children: [
    HttpTransportCategory,
    GrpcTransportCategory
  ]
}

const SystemCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.systemcategory@1.0.0`)),
  name: 'System',
  description: 'System',
  children: [
    DatabaseCategory,
    MicroServiceCategory,
    GraphQLCategory,
    RestCategory,
    ThirdPartyCategory,
    DevOpsCategory,
    TransportCategory
  ]
}

const ClusterCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.clustercategory@1.0.0`)),
  name: 'Cluster',
  description: 'Cluster',
  children: [
    SystemCategory
  ]
}

const SuperClusterCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.superclustercategory@1.0.0`)),
  name: 'Super Cluster',
  description: 'Super Cluster',
  children: [
    ClusterCategory
  ]
}

const CosmicWebCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.cosmicwebcategory@1.0.0`)),
  name: 'Cosmic Web',
  description: 'Cosmic Web',
  children: [
    SuperClusterCategory
  ]
}

const UniverseCategory: ReactorNodeCategory = { 
  id: new ObjectId(Hash(`reactor.universecategory@1.0.0`)),
  name: 'Universe',
  description: 'Universe',
  children: [
    CosmicWebCategory
  ]
}



export const DefaultReactorNodeCategories: ReactorNodeCategory[] = [ 
  ColumnCategory,
  TableCategory,
  ViewCategory,
  StoredProcedureCategory,
  DatabaseCategory,
  
  MicroServiceCategory,
  GraphQLCategory,
  RestCategory,
  ThirdPartyCategory,

  SystemCategory,
  ClusterCategory,
  CosmicWebCategory,
  UniverseCategory,
];


const ReactorNodeCategorySchema: Schema<ReactorNodeCategory> = new Schema<ReactorNodeCategory>({  
  id: ObjectId,
  name: String,
  description: String,
  children: [{ type: ObjectId, ref: 'ReactorCategoryNode' }],
  nodes: [{ type: ObjectId, ref: 'ReactorNode' }],
});


const ReactorNodeMetricTypeSchema: Schema<ReactorNodeMetricType> = new Schema<ReactorNodeMetricType>({ 
  id: ObjectId,
  name: String,
  description: String,
  units: String,
});

const ReactorNodeMetricValueSchema: Schema<ReactorNodeMetric> = new Schema<ReactorNodeMetric>({ 
  id: ObjectId,
  type: {
    type: ObjectId,
    ref: 'ReactorNodeMetricType'
  },
  value: String,
});

const ReactorNodeSchema: Schema<ReactorNode> = new Schema<ReactorNode>({
  // Deterministic numeric id derived from the node's logical key (GraphIdentity).
  id: { type: Number, index: true, unique: true },
  index: Number,
  // Pipe-delimited ancestry key of ids, e.g. "12345|67890".
  key: { type: String, index: true },
  type: {
    type: String,
    enum: Object.values(ReactorNodeType),
    default: ReactorNodeType.PROCESS,
  },
  categories: [{ type: ObjectId, ref: 'ReactorCategoryNode' }],
  nameSpace: String,
  name: String,
  version: String,
  description: String,
  // FQN of the processor that owns/produced this node.
  providerId: { type: String, index: true },
  // Parent node id (numeric), null for project roots.
  parentId: { type: Number, index: true },
  // Absolute source location (file path / repo path) where applicable.
  source: String,
  attributes: [{ }],
  metrics: [ReactorNodeMetricValueSchema],
  children: [{ type: Number }],
  inputs: [{ type: Number }],
  outputs: [{ type: Number }],
  dependencies: [{ type: Number }],
  // Free-form node payload (relativePath, language, symbol kind, etc.).
  data: Schema.Types.Mixed,
  // Project scoping + GC fields (session 02)
  projectId: { type: String, index: true },
  projectFqn: { type: String, index: true },
  runId: { type: String, index: true },
  indexedAt: { type: Date, index: true },
  // Reserved for session 08 incremental (nullable)
  contentHash: String,
  created: {
    type: Date,
    default: () => { return new Date() }
  },
  updated: {
    type: Date,
    default: () => { return new Date() }
  },
});

// Compound indexes for graph queries, containment, and project-scoped GC
ReactorNodeSchema.index({ projectId: 1, runId: 1 });
ReactorNodeSchema.index({ projectId: 1, parentId: 1 });
ReactorNodeSchema.index({ projectId: 1, type: 1 });
ReactorNodeSchema.index({ type: 1, name: 1 });
ReactorNodeSchema.index({ projectFqn: 1, type: 1 });


const ReactorNodeUISchema: Schema<ReactorNodeUI> = new Schema<ReactorNodeUI>({ 
  id: ObjectId,
  node: {
    type: ObjectId,
    ref: 'ReactorNode'
  },
  position: {
    x: Number,
    y: Number,
  },
  options: [{
    id: ObjectId,
    key: String,
    value: String,
  }],
});

const ReactorNodeCategoryName = 'ReactorNodeCategory';
const ReactorNodeCategoryModel = mongoose.model<ReactorNodeCategory>(ReactorNodeCategoryName, ReactorNodeCategorySchema, 'reactor_node_categories');
export type TReactorNodeCategoryModel = typeof ReactorNodeCategoryModel;
export const ReactorNodeCategoryModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorNodeCategoryModel> = { 
  name: 'ReactorNodeCategoryModel',
  nameSpace: 'reactor',
  description: 'Reactor Node Category Model',
  version: '1.0.0',
  component: ReactorNodeCategoryModel,
  features: []
}

const ReactorNodeMetricTypeName = 'ReactorNodeMetricType'; 
const ReactorNodeMetricTypeModel = mongoose.model<ReactorNodeMetricType>(ReactorNodeMetricTypeName, ReactorNodeMetricTypeSchema, 'reactor_node_metric_types');
export type TReactorNodeMetricTypeModel = typeof ReactorNodeMetricTypeModel;
export const ReactorNodeMetricTypeModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorNodeMetricTypeModel> = { 
  name: 'ReactorNodeMetricTypeModel',
  nameSpace: 'reactor',
  description: 'Reactor Node Metric Type Model',
  version: '1.0.0',
  component: ReactorNodeMetricTypeModel,
  features: []
}

const ReactorNodeModelName = 'ReactorNode';
const ReactorNodeModel = mongoose.model<ReactorNode>(ReactorNodeModelName, ReactorNodeSchema, 'reactor_nodes');
export { ReactorNodeModel };
export type TReactorNodeModel = typeof ReactorNodeModel;
export const ReactorNodeModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorNodeModel> = { 
  name: 'ReactorNodeModel',
  nameSpace: 'reactor',
  description: 'Reactor Node Model',
  version: '1.0.0',
  component: ReactorNodeModel,
  features: []
}
