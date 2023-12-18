import Reactory from "@reactory/reactory-core";
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import tar from 'tar';
import { service } from "@reactory/server-core/application/decorators/service";
import logger from "@reactory/server-core/logging";
import { Writable } from "stream";
import database from "database";
import ApiError from "@reactory/server-core/exceptions";
import IOpenAIService, { ChatParams, CreateFineTuningJobParams, FineTuningEvent, FineTuningObjectJob, ImageExtensionParams, ImageGenerationParams, ListFineTuningJobParams, OpenAIFile, OpenAIImage, OpenAIListResponse, OpenAIModel } from "../types/service.types";
import { ChatCompletionResponseMessage, OpenAIApi } from "openai";
import * as Chat from "@reactory/server-modules/reactor/ai/openai/chat/questions/factory";
import { ChatState } from "bin/utils/chatgpt/chat.types";

@service({
  id: "reactor.OpenAIService@1.0.0",
  name: "OpenAI Service",
  description: "Service for managing OpenAI API requests",
  serviceType:  "ai",
  dependencies: [
    { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
    { id: "core.UserService@1.0.0", alias: "userService" },
    { id: "core.FetchService@1.0.0", alias: "fetchService" },
  ],
})
class OpenAIService implements IOpenAIService {
  
  context: Reactory.Server.IReactoryContext;
  props: Reactory.Service.IReactoryServiceProps;
  ai: OpenAIApi;

  constructor(props: Reactory.Service.IReactoryServiceProps, 
    context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.props = props;
  }

  createFineTuningJob(params: CreateFineTuningJobParams): Promise<FineTuningObjectJob> {
    throw new Error("Method not implemented.");
  }
  listFineTuningJobs(params: ListFineTuningJobParams): Promise<FineTuningObjectJob[]> {
    throw new Error("Method not implemented.");
  }
  getFineTuningJob(jobId: string): Promise<FineTuningObjectJob> {
    throw new Error("Method not implemented.");
  }
  cancelFineTuningJob(jobId: string): Promise<FineTuningObjectJob> {
    throw new Error("Method not implemented.");
  }
  listFineTuningEvents(jobId: string): Promise<FineTuningEvent[]> {
    throw new Error("Method not implemented.");
  }
  listFiles(): Promise<OpenAIFile[]> {
    throw new Error("Method not implemented.");
  }
  uploadFile(filename: string, purpose: string): Promise<OpenAIFile> {
    throw new Error("Method not implemented.");
  }
  deleteFile(fileId: string): Promise<OpenAIFile> {
    throw new Error("Method not implemented.");
  }
  getFile(fileId: string): Promise<OpenAIFile> {
    throw new Error("Method not implemented.");
  }
  getFileContents(fileId: string): Promise<string> {
    throw new Error("Method not implemented.");
  }
  generateImage(params: ImageGenerationParams): Promise<OpenAIListResponse<OpenAIImage>> {
    throw new Error("Method not implemented.");
  }
  extendImage(params: ImageExtensionParams): Promise<OpenAIListResponse<OpenAIImage>> {
    throw new Error("Method not implemented.");
  }
  listModels(): Promise<OpenAIListResponse<OpenAIModel>> {
    throw new Error("Method not implemented.");
  }

  chat(params: ChatParams): Promise<ChatState> {
    const { botId, chatSessionId, question } = params;

    if(chatSessionId && question) { 
      return Chat.askQuestion(chatSessionId, question, this.context);
    }

    if(botId && question) { 
      return Chat.newChatSession(botId, question, this.context);
    }
  }


  
  toString?(includeVersion?: boolean): string {
    throw new Error("Method not implemented.");
  }

  description?: string;
  tags?: string[];
  nameSpace: string;
  name: string;
  version: string;

  static reactory: Reactory.Service.IReactoryServiceDefinition<OpenAIService> = {
    name: "OpenAIService",
    nameSpace: "reactor",
    version: "1.0.0",
    description: "Service for managing OpenAI API requests",
    id: "reactor.OpenAIService@1.0.0",
    serviceType: "ai",
    service(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
      return new OpenAIService(props, context);
    },    
    dependencies: [
      { id: "core.ReactoryFileService@1.0.0", alias: "fileService" },
      { id: "core.UserService@1.0.0", alias: "userService" },
      { id: "core.FetchService@1.0.0", alias: "fetchService" },
    ],
  };
  
}

export default OpenAIService.reactory;
