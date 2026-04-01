import mongoose, { Document, Schema } from 'mongoose';
import { IMCPRegistry, MCPRegistryType } from '../types/mcp.types';

export interface IMCPRegistryDocument extends IMCPRegistry, Document {
  id: string;
}

const MCPRegistrySchema = new Schema<IMCPRegistryDocument>(
  {
    name: { type: String, required: true },
    type: { 
      type: String, 
      enum: Object.values(MCPRegistryType), 
      required: true 
    },
    url: { type: String, required: true },
    description: { type: String },
    credentials: {
      type: { type: String },
      token: { type: String },
      username: { type: String },
      password: { type: String }
    },
    enabled: { type: Boolean, default: true }
  },
  {
    timestamps: true
  }
);

const MCPRegistryModel = mongoose.model<IMCPRegistryDocument>('MCPRegistry', MCPRegistrySchema);

export default MCPRegistryModel;