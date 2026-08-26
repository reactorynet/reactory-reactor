import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import { ReactorNodeLink, ReactorLinkType } from '../types/model.types';

/**
 * Persisted edge between two graph nodes. Endpoints are the deterministic
 * numeric node ids produced by GraphIdentity, so an edge can be stored and
 * resolved independently of whether its endpoint nodes are currently in the
 * lazy tree cache.
 */
const ReactorNodeLinkSchema: Schema<ReactorNodeLink> = new Schema<ReactorNodeLink>({
  id: { type: Number, index: true, unique: true },
  source: { type: Number, index: true },
  target: { type: Number, index: true },
  type: { type: String },
  types: {
    type: [String],
    enum: Object.values(ReactorLinkType),
    default: [ReactorLinkType.DIRECT],
  },
  title: String,
  description: String,
  // Stored as a string so both numeric (catalog hash) and Mongo ObjectId
  // project ids can be scoped without a type clash.
  projectId: { type: String, index: true },
  runId: { type: String, index: true },
  indexedAt: { type: Date, index: true },
  data: Schema.Types.Mixed,
  created: { type: Date, default: () => new Date() },
  updated: { type: Date, default: () => new Date() },
});

// Fast lookup of all edges touching a node in either direction.
ReactorNodeLinkSchema.index({ source: 1, target: 1 });
ReactorNodeLinkSchema.index({ projectId: 1, runId: 1 });
ReactorNodeLinkSchema.index({ source: 1, types: 1 });
ReactorNodeLinkSchema.index({ target: 1, types: 1 });
ReactorNodeLinkSchema.index({ projectId: 1, source: 1 });
ReactorNodeLinkSchema.index({ projectId: 1, target: 1 });

const ReactorNodeLinkModelName = 'ReactorNodeLink';
const ReactorNodeLinkModel = mongoose.model<ReactorNodeLink>(
  ReactorNodeLinkModelName,
  ReactorNodeLinkSchema,
  'reactor_node_links'
);
export type TReactorNodeLinkModel = typeof ReactorNodeLinkModel;
export { ReactorNodeLinkModel };
export const ReactorNodeLinkModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorNodeLinkModel> = {
  name: 'ReactorNodeLinkModel',
  nameSpace: 'reactor',
  description: 'Reactor Node Link (edge) Model',
  version: '1.0.0',
  component: ReactorNodeLinkModel,
  features: [],
};

export default ReactorNodeLinkModel;
