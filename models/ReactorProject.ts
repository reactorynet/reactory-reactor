// ReactorProject Mongoose Schema and Model
import mongoose, { Schema } from 'mongoose';
import { ObjectId } from 'mongodb';
import Reactory from '@reactorynet/reactory-core';
import Hash from '@reactory/server-core/utils/hash';


// Sub-schemas for embedded documents
const DependencySchema = new Schema({
  id: ObjectId,
  fqn: String,
  name: String,
  nameSpace: String,
  version: String,
  description: String,
}, { _id: false });

const PathSpecSchema = new Schema({
  // Deterministic numeric hash id (see GraphIdentity / Hash()), not an ObjectId.
  id: Number,
  path: String,
  filter: String,
  type: String,
}, { _id: false });

const FileSpecSchema = new Schema({
  // Deterministic numeric hash id (see listFiles -> Hash()), not an ObjectId.
  id: Number,
  path: String,
  type: String,
  content: String,
}, { _id: false });

const DeploymentSchema = new Schema({
  id: ObjectId,
  environment: String,
  status: String,
  name: String,
  description: String,
  version: String,
  ciProvider: String,
  ciPipeline: String,
  ciBranch: String,
  ciBuildId: String,
  ciBuildUrl: String,
  commitHash: String,
  commitMessage: String,
  commitAuthor: String,
  created: Date,
  updated: Date,
}, { _id: false });

const DashboardSchema = new Schema({
  id: ObjectId,
  name: String,
  description: String,
  url: String,
  type: String,
  refreshInterval: Number,
  created: Date,
  updated: Date,
}, { _id: false });

const ErrorSchema = new Schema({
  message: String,
  stack: String,
}, { _id: false });

const NoteSchema = new Schema({
  id: ObjectId,
  content: String,
  format: String,
  created: Date,
  updated: Date,
}, { _id: false });

const SecuritySchema = new Schema({
  securityContact: { type: ObjectId, ref: 'User' },
  complianceTags: [String],
  riskLevel: String,
  dataClassification: String,
  vulnerabilityStatus: String,
  lastSecurityReview: Date,
  securityNotes: String,
  securityPoliciesUrl: String,
  encryptionAtRest: Boolean,
  encryptionInTransit: Boolean,
  dependenciesWithKnownVulnerabilities: Number,
  vulnerabilityReportUrl: String,
}, { _id: false });

const ProjectDocumentationSchema = new Schema({ 
  id: ObjectId,
  title: String,
  content: String,
  path: String, // e.g., /docs/getting-started
  url: String, // e.g., https://docs.example.com/getting-started
  format: String, // e.g., markdown, html
  created: { type: Date, default: () => new Date() },
  updated: { type: Date, default: () => new Date() },
}, { _id: false });

const ReactorSlackChannelSchema = new Schema({ 
  id: ObjectId,
  name: String,
  channelId: String,
  created: { type: Date, default: () => new Date() },
  updated: { type: Date, default: () => new Date() },
}, { _id: false });

const ReactorProjectSchema: Schema = new Schema({
  id: ObjectId,
  client: { type: ObjectId, ref: 'ReactoryClient' },
  businessUnit: { type: ObjectId, ref: 'BusinessUnit' },
  organization: { type: ObjectId, ref: 'Organization' },
  fqn: String,
  name: String,
  nameSpace: String,
  version: String,
  repoPath: String,
  repoUrl: String,
  projectTypes: [String], 
  lastSync: Date,
  description: String,
  tasksUrl: String,
  primaryDocumentation: ProjectDocumentationSchema,
  secondaryDocumentation: [ProjectDocumentationSchema],
  primarySlackChannel: ReactorSlackChannelSchema,
  secondarySlackChannels: [ReactorSlackChannelSchema],  
  dependencies: [DependencySchema],
  pathSpecs: [PathSpecSchema],
  files: [FileSpecSchema],
  deployments: [DeploymentSchema],
  dashboards: [DashboardSchema],
  processor: String,
  processorOptions: Schema.Types.Mixed,
  // Detected processor configs ({ id, processor, options }). The service works
  // with the plural `processors` array; without this field it was silently
  // dropped on save (only the legacy singular `processor` string persisted).
  processors: [new Schema({
    id: String,
    processor: String,
    options: Schema.Types.Mixed,
  }, { _id: false })],
  owner: { type: ObjectId, ref: 'User' },
  ownerTeam: { type: ObjectId, ref: 'Team' },
  teams: [{ type: ObjectId, ref: 'Team' }],
  engineers: [{ type: ObjectId, ref: 'User' }],
  activeBranch: String,
  mainBranch: String,
  branches: [String],
  tags: [String],
  created: { type: Date, default: () => new Date() },
  updated: { type: Date, default: () => new Date() },
  errors: [ErrorSchema],
  notes: [NoteSchema],
  security: SecuritySchema,
});

const ReactorProjectModelName = 'ReactorProject';
export const ReactorProjectModel = mongoose.model(ReactorProjectModelName, ReactorProjectSchema, 'reactor_projects');
export type TReactorProjectModel = typeof ReactorProjectModel;
export const ReactorProjectModelComponentRegistryEntry: Reactory.IReactoryComponentDefinition<typeof ReactorProjectModel> = {
  name: 'ReactorProjectModel',
  nameSpace: 'reactor',
  description: 'Reactor Project Model',
  version: '1.0.0',
  component: ReactorProjectModel,
  features: []
};
