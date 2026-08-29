import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import { ReactorGraphPerspective } from '../types/model.types';

/**
 * A saved explorer view — the complete state needed to reproduce a graph
 * view in either the 2D or the 3D renderer: node positions, expanded and
 * hidden sets, type filters, layout, view mode and a world-space camera.
 * Owned by a user and optionally shared. Supersedes the never-wired
 * ReactorNodeUI type.
 */
const ReactorGraphPerspectiveSchema: Schema<ReactorGraphPerspective> = new Schema<ReactorGraphPerspective>({
  name: { type: String, required: true },
  owner: { type: String, required: true, index: true },
  projectId: { type: String, index: true },
  rootNodeId: { type: Number, index: true },
  nodePositions: [
    {
      _id: false,
      nodeId: { type: Number, required: true },
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      z: Number,
    },
  ],
  expandedKeys: [String],
  hiddenNodeIds: [Number],
  filters: {
    nodeTypes: [String],
    linkTypes: [String],
  },
  layout: String,
  viewMode: { type: String, enum: ['TWO_D', 'THREE_D'] },
  depth: Number,
  viewport: {
    cameraX: Number,
    cameraY: Number,
    cameraZ: Number,
    targetX: Number,
    targetY: Number,
    targetZ: Number,
    zoom: Number,
  },
  share: { type: Boolean, default: false },
  isDefault: { type: Boolean, default: false },
  created: { type: Date, default: () => new Date() },
  updated: { type: Date, default: () => new Date() },
}, { minimize: false });

// A user's perspective names are unique per project scope.
ReactorGraphPerspectiveSchema.index({ owner: 1, name: 1, projectId: 1 }, { unique: true });

const ReactorGraphPerspectiveModelName = 'ReactorGraphPerspective';
const ReactorGraphPerspectiveModel = mongoose.model<ReactorGraphPerspective>(
  ReactorGraphPerspectiveModelName,
  ReactorGraphPerspectiveSchema,
  'reactor_graph_perspectives'
);
export type TReactorGraphPerspectiveModel = typeof ReactorGraphPerspectiveModel;
export { ReactorGraphPerspectiveModel };
export const ReactorGraphPerspectiveModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorGraphPerspectiveModel> = {
  name: 'ReactorGraphPerspectiveModel',
  nameSpace: 'reactor',
  description: 'Reactor Graph Perspective (saved explorer view) Model',
  version: '1.0.0',
  component: ReactorGraphPerspectiveModel,
  features: [],
};

export default ReactorGraphPerspectiveModel;
