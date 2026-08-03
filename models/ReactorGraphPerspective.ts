import mongoose, { Schema } from 'mongoose';
import Reactory from '@reactorynet/reactory-core';
import { ReactorGraphPerspective } from '../types/model.types';

/**
 * A saved explorer view — node positions, expanded node set and camera —
 * owned by a user and optionally shared. Supersedes the never-wired
 * ReactorNodeUI type.
 */
const ReactorGraphPerspectiveSchema: Schema<ReactorGraphPerspective> = new Schema<ReactorGraphPerspective>({
  name: { type: String, required: true },
  owner: { type: String, required: true, index: true },
  projectId: { type: String, index: true },
  rootNodeId: Number,
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
  created: { type: Date, default: () => new Date() },
  updated: { type: Date, default: () => new Date() },
});

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
