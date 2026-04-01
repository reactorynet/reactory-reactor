import mongoose, { Document, Schema } from 'mongoose';
import { IMCPInstalledConnector, MCPTransportType } from '../types/mcp.types';

export interface IMCPInstalledConnectorDocument extends IMCPInstalledConnector, Document {
  id: string;
}

const MCPInstalledConnectorSchema = new Schema<IMCPInstalledConnectorDocument>(
  {
    name: { type: String, required: true },
    description: { type: String },
    registryId: { type: Schema.Types.ObjectId, ref: 'MCPRegistry' },
    transport: { 
      type: String, 
      enum: Object.values(MCPTransportType), 
      required: true 
    },
    config: {
      command: { type: String },
      args: [{ type: String }],
      env: { type: Map, of: String },
      url: { type: String }
    },
    status: { 
      type: String, 
      enum: ['active', 'inactive', 'error'], 
      default: 'active' 
    },
    version: { type: String },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' }
  },
  {
    timestamps: true
  }
);

const MCPInstalledConnectorModel = mongoose.model<IMCPInstalledConnectorDocument>('MCPInstalledConnector', MCPInstalledConnectorSchema);

export default MCPInstalledConnectorModel;