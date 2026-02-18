import Reactory from '@reactorynet/reactory-core';
import OpenAI from "openai"
import GoogleGenAI from "google-genai";
import { TReactorConversationDocument, TReactorConversationModel, ReactorConversationHistoryItem } from "../models/ReactorChatState"
import { AIAudioChatParams, AIChatCompletion, AIChatParams, AIFile, AIFineTuningEvent, AIFineTuningJob, AIImage, AIImageGenerationParams, AIListResponse, AIModel, CreateAIFineTuningJobParams, ReactorDataNode, ReactorNode, ReactorNodeCategory, ReactorNodeLink, ReactorNodeType } from "./model.types"
import { PagingRequest, PagingResult } from "@reactory/server-core/database/types"
import { ObjectId } from "mongodb"
import { ChatState, MacroComponentDefinition, MacroToolDefinition, Schema, ToolApprovalMode } from '../ai/openai/types/chat';
import { ReactoryFileDocument, ReactoryFileModel } from 'modules/reactory-core/models/CoreFile';
import { PromptMergeStrategy, StreamingMode } from '../services/reactor/types/streaming.types';


export type KnownAIProviders = "openai" | "google" | "azure" | "xai" | "anthropic" | "cohere" | "mistral" | "meta" | "deepmind";

export type OpenAIModel = {
  id: string
  object: "model"
  created: number
  owned_by: string
}

export type OpenAIListResponse<T> = { 
  data: T[]
  object: "list",
  has_more?: boolean
}

export interface ListFineTuningJobParams {
  after?: string
  limit?: number
}


/**
 * The FineTuningObjectJob type is used to define the parameters that are used
 * for fine tuning an OpenAI model.
 * 
 * Example:
  ```ts
  {
    "object": "fine_tuning.job",
    "id": "ftjob-abc123",
    "model": "davinci-002",
    "created_at": 1692661014,
    "finished_at": 1692661190,
    "fine_tuned_model": "ft:davinci-002:my-org:custom_suffix:7q8mpxmy",
    "organization_id": "org-123",
    "result_files": [
        "file-abc123"
    ],
    "status": "succeeded",
    "validation_file": null,
    "training_file": "file-abc123",
    "hyperparameters": {
        "n_epochs": 4,
    },
    "trained_tokens": 5768
  }
  ```
 */
export type FineTuningObjectJob = {
  /**
   * The object type, which is always "fine_tuning.job".
   */
  object: string
  /**
   * The unique identifier for the fine-tuning job which can be referenced on the API endpoints
   */
  id: string
  /**
   * The base that the model that is being fine-tuned is based on.
   */
  model: string
  /**
   * The date and time the fine-tuning job was created.
   */
  created_at: number
  /**
   * The date and time the fine-tuning job was finished.
   */
  finished_at: number
  /**
   * The fine-tuned model id that was created.
   */
  fine_tuned_model: string
  /**
   * The organization that the fine-tuning job was created for.
   */
  organization_id: string
  /**
   * The result files that were created for the fine-tuning job.
   */
  result_files: string[]
  /**
   * The status of the fine-tuning job.
   */
  status: string
  /**
   * The validation file that was used for the fine-tuning job.
   */
  validation_file: string | null
  /**
   * The training file that was used for the fine-tuning job.
   */
  training_file: string
  /**
   * The hyperparameters used for the fine-tuning job. See the fine-tuning guide for more details.
   */
  hyperparameters: {
    /**
     * The number of epochs to train the model for. An epoch refers to one full cycle through the training dataset. "auto" decides the optimal number of epochs based on the size of the dataset. If setting the number manually, we support any number between 1 and 50 epochs.
     */
    n_epochs: number
  }  

  trained_tokens: number
}

export interface CreateFineTuningJobParams {
  model: string
  training_file: string
  validation_file?: string
  hyperparameters?: {
    n_epochs?: number
  }
  suffix?: string
}

export interface FineTuningEvent {
  id: string
  created_at: number
  level: string
  message: string
  object: string
}

export interface OpenAIFile {
  id: string
  object: "file",
  bytes: number
  created_at: number
  filename: string
  purpose: string | "fine-tune" | "fine-tune-results"  
  status_details: string
  url: string

}

export interface OpenAIImage {
  b64_json?: string
  url?: string
}

export interface OpenAIImageGenerationResult {
  created: number
  data: Partial<OpenAIImage>[]
}

export interface ImageParams { 
  n: number
  response_format: "url" | "b64_json"
  size: string | "256x256" | "512x512" | "1024x1024"
  user: string
}

export interface ImageGenerationParams extends ImageParams {
  prompt: string  
}

export interface ImageVariantParams extends ImageParams {
  image: string
}

export interface ImageExtensionParams extends ImageGenerationParams, ImageVariantParams {  
  mask?: string
}

export interface ChatParams { 
  personaId: string
  message: string
  chatSessionId?: string,
  streamingMode?: StreamingMode
}

export interface AudioChatParams extends ChatParams {
  audio: string | Buffer[]
  format: "mp3" | "wav" | "ogg"
}

export interface IOpenAIServiceProps extends Reactory.Service.IReactoryServiceProps {
  /**
   * The OpenAI API key to use for the service
   */
  apiKey: string
  /**
   * The OpenAI API endpoint to use for the service
   */
  apiEndpoint: string
  /**
   * The OpenAI API version to use for the service
   */
  apiVersion: string
  /**
   * The OpenAI API organization id to use for the service
   */
  apiOrganizationId?: string
  /**
   * The OpenAI API base url to use for the service
   */
  apiBaseURL?: string
  
  /**
   * The chat session id to use for the service instance
   */
  chatSessionId?: string
  /**
   * The persona id to use for the service insstance. Defaults to "reactor"
   */
  personaId?: string

  /**
   * The streaming mode to use for the service instance. Defaults to StreamingMode.NONE
   */
  streamingMode?: StreamingMode
}


/**
 * The OpenAI API service interface defines the methods that are available for
 * OpenAI API. These are based on the OpenAI API endpoints that are
 * documented here: https://platform.openai.com/docs/api-reference/introduction
 * @name IOpenAPIService
 */
export interface IOpenAIService extends Reactory.Service.IReactoryService {

  initialize(chatSessionId: string, persona: IAIPersona): Promise<void>;
  // Fine Tuning API Methods
  createFineTuningJob(params: CreateFineTuningJobParams): Promise<FineTuningObjectJob>;

  listFineTuningJobs(params: ListFineTuningJobParams): Promise<FineTuningObjectJob[]>;

  getFineTuningJob(jobId: string): Promise<FineTuningObjectJob>;

  cancelFineTuningJob(jobId: string): Promise<FineTuningObjectJob>;

  listFineTuningEvents(jobId: string): Promise<FineTuningEvent[]>;

  listFiles(): Promise<OpenAIFile[]>;

  uploadFile(filename: string, purpose: string): Promise<OpenAIFile>;

  deleteFile(fileId: string): Promise<OpenAIFile>;

  getFile(fileId: string): Promise<OpenAIFile>;

  getFileContents(fileId: string): Promise<string>;

  generateImage(params: ImageGenerationParams): Promise<OpenAIListResponse<OpenAIImage>>;

  extendImage(params: ImageExtensionParams): Promise<OpenAIListResponse<OpenAIImage>>;

  listModels(): Promise<OpenAIListResponse<OpenAIModel>>;

  chat(params: ChatParams) : Promise<OpenAI.Chat.Completions.ChatCompletion>;

  chatAudio(params: AudioChatParams) : Promise<OpenAI.Chat.Completions.ChatCompletion>;

  speech2Text(audio: string | Buffer[]): Promise<string>;
}


/**
 * Defines the object shape of the AI Appearance
 */
export interface IAIAppearance {
    voice?: string[];    
    face?: string[];
    hair?: string[];
    body?: string[];
    clothes?: string[];
    accessories?: string[];
    metrics?: {
      height?: number;
      weight?: number;
      age?: number;
    };
    skin?: {
      color: string;
      tone: string;
    };
    background?: [{
      src: string;
      type: "image" | "video" | "audio";
      order: number;
      options?: {
        image?: {
          alpha?: number;
          brightness?: number;
          contrast?: number;
          blur?: number;
          grayscale?: number;
          hueRotate?: number;
          invert?: number;
          opacity?: number;
          saturate?: number;
          sepia?: number;
          chromaKey?: string;
        };
        time: {
          loop?: boolean;
          loopStart?: number;
          loopEnd?: number;
        }
        audio?: {
          volume?: number;  
          mute?: boolean;
          autoplay?: boolean;
        }
        controls?: boolean;
      }
    }];
}

export interface IAIPersonaPromptTemplate {
  /**
   * The content of the prompt
   */
  content?: string;
  /**
   * The variables that are available in the prompt
   */
  variables?: string[];
  /**
   * The parameters that are available in the prompt
   */
  parameters?: Schema;
  /**
   * The form that is used to render the input fields for the prompt
   */
  formFqn?: Reactory.FQN;
  /**
   * The role of the prompt
   */
  /**
   * The role of the prompt
   */
  role: "user" | "assistant" | "system" | "tool";
}

export interface OpenAIModelConfig { }
export interface xAIModelConfig { }
export interface AzureModelConfig { }
export interface GoogleModelConfig { }
export type KnownAIModelConfigs = OpenAIModelConfig | xAIModelConfig | GoogleModelConfig | AzureModelConfig;

export interface IAIPersonaResource {
  id: string;
  name: string;
  description?: string;
  type: "file" | "image" | "video" | "audio" | "text" | "code" | "url" | "directory";
  url?: string;
  content?: string;
  created: Date;
}

/**
 * Defines the shape fo the AI Persona object
 */
export interface IAIPersona {
  id: string;
  modelId?: string;
  /**
   * Model configuration is model configuration specific to the provider used.
   */
  modelConfig?: any;
  /**
   * The message configuration is used for message specifc configuration.
   */
  messageConfig?: any;
  providerId?: string;
  name: string;
  description?: string;
  defaultGreeting?: string;
  persona: string;
  features: string;
  avatar?: string;
  appearance?: IAIAppearance;
  /**
   * Maximum number of tokens allowed for this persona's conversations
   */
  maxTokens?: number;
  prompts?: {
    [key: string]: IAIPersonaPromptTemplate
  },
  config? : {
    apiKey?: string;
    apiOrg?: string;
    apiEndpoint?: string;
    apiVersion?: string;
    apiBaseURL?: string;
    [key: string]: any;
  },
  tools?: MacroToolDefinition[]
  macros?: MacroComponentDefinition<unknown>[]
  resources?: {
    id: string;
    name: string;
    description?: string;
    type: "file" | "image" | "video" | "audio" | "text" | "code" | "url" | "directory";
    url?: string;
    content?: string;
    created: Date;
  }[]
}

/**
 * The AI Persona Provider service interface defines the methods that are available for
 * AI Persona configuration and management.
 */
export interface IAIPersonaProviderService { 
  
    /**
    * Returns a list of all the personas that are available for the user.
    * @returns {Promise<Persona[]>} A promise that resolves to a list of personas.
    */
    listPersonas(): Promise<IAIPersona[]>;
  
    /**
    * Returns a list of all the personas that are available for the user.
    * @returns {Promise<Persona[]>} A promise that resolves to a list of personas.
    */
    getPersona(id: string): Promise<IAIPersona>;
  
    /**
    * Creates a new persona for the user.
    * @param {CreatePersonaParams} params The parameters for creating the persona.
    * @returns {Promise<Persona>} A promise that resolves to the created persona.
    */
    createPersona(params: IAIPersona): Promise<IAIPersona>;
  
    /**
    * Updates an existing persona for the user.
    * @param {UpdatePersonaParams} params The parameters for updating the persona.
    * @returns {Promise<Persona>} A promise that resolves to the updated persona.
    */
    updatePersona(params: IAIPersona): Promise<IAIPersona>;
  
    /**
    * Deletes an existing persona for the user.
    * @param {string} id The id of the persona to delete.
    * @returns {Promise<Persona>} A promise that resolves to the deleted persona.
    */
    deletePersona(id: string): Promise<IAIPersona>;
}

export type ReactorInitiateSSEResponse = {
  __typename: 'ReactorInitiateSSE',
  sessionId: string,
  endpoint: string,
  token: string,
  status: string,
  expiry: Date,
  headers: any
}

export type ReactorErrorResponse = {
  __typename: 'ReactorErrorResponse',
  code: string,
  message: string,
  details: any,
  timestamp: Date,
  recoverable: boolean,
  suggestion: string
}

export type ReactorChatState = ChatState & {
  __typename: 'ReactorChatState',
  macros: MacroComponentDefinition<unknown>[],
  tools: MacroToolDefinition[]
}

export type ReactorInitChatResponse = ReactorChatState | ReactorErrorResponse | ReactorInitiateSSEResponse;
  
/**
 * Service interface for managing AI-powered chat conversations within the Reactor system.
 * 
 * Provides methods for starting chat sessions, executing macros and tools, attaching images,
 * deleting chat sessions, and sending messages. Designed to facilitate conversational workflows
 * with support for extensible macros, tools, and persona-based interactions.
 */
export interface IReactorConversationsService extends Reactory.Service.IReactoryService{ 
  /**
   * Initializes the chat session for the user.
   * 
   * Use this call when you want to specify the tools and macros. If you do not need to provide
   * client tools and macros then you can just start to sendMessages to the chat session. If no chat 
   * session is found then a new one will be created.
   * @param args 
   */
  startChatSession(args: {
    personaId: string,
    macros: Partial<MacroComponentDefinition<unknown>>,
    tools: Partial<MacroToolDefinition>[],
    systemPrompt: string,
    streamingMode: StreamingMode,
    promptMergeStrategy: PromptMergeStrategy,
    toolApprovalMode: ToolApprovalMode,
    contextFromSessionId?: string,
  }): Promise<ReactorInitChatResponse>;

  /**
   * Loads a chat session by its ID.
   * This method retrieves the chat session model from the database
   */
  loadChatSession(chatSessionId: string): Promise<TReactorConversationDocument | null>;

  /**
   * Gets a chat session by its ID without user authentication.
   * This method is designed for external access like GraphQL resolvers.
   */
  getChatSession(args: { id: string }): Promise<TReactorConversationDocument & {
    context?: Reactory.Server.IReactoryContext;
  }>;

  /**
   * Sets the tool approval mode for the chat session.
   * This allows you to control how tools are approved for use in the chat session.
   * @param chatSessionId 
   * @param toolApprovalMode 
   */
  setChatToolApprovalMode(chatSessionId: string, toolApprovalMode: ToolApprovalMode): Promise<any>;

  /**
   * Sets the maximum number of tokens for the chat session.
   * This allows you to control the token limit for the conversation.
   * @param chatSessionId 
   * @param maxTokens 
   */
  setChatMaxTokens(chatSessionId: string, maxTokens: number): Promise<any>;

  /**
   * Gets the current token count and usage information for the chat session.
   * @param chatSessionId 
   */
  getChatTokenCount(chatSessionId: string): Promise<{
    currentTokens: number;
    maxTokens: number | null;
    exceedsLimit: boolean;
    percentageUsed: number;
  }>;

  /**
   * Gets the full conversation history including truncated messages for analysis.
   * This combines the active history with truncated history in chronological order.
   * @param chatSessionId 
   */
  getFullConversationHistory(chatSessionId: string): Promise<{
    fullHistory: ReactorConversationHistoryItem[];
    activeHistory: ReactorConversationHistoryItem[];
    truncatedHistory: ReactorConversationHistoryItem[];
    statistics: {
      totalMessages: number;
      activeMessages: number;
      truncatedMessages: number;
      totalTokens: number;
      activeTokens: number;
      truncatedTokens: number;
    };
  }>;

  /**
   * Gets a list of conversations for the user.
   * @param args 
   */
  getConversations(args: {
    filter?: { personaId?: string; userId?: string; modelId?: string };
  }): Promise<TReactorConversationDocument[]>;

  /**
   * Clear the truncated history for a conversation.
   * This can be used for cleanup or when you want to free up storage.
   * @param chatSessionId 
   */
  clearTruncatedHistory(chatSessionId: string): Promise<{
    clearedMessages: number;
    clearedTokens: number;
  }>; 
  
  /**
   * Execute a macro string using the macro system.
   * @param args 
   */
  executeMacro(args: { 
    // The macro to execute, passed as it is in the macro registry
    // i.e. "reactor.macro.greet" or by it's alias "greet"
    macro: string, 
    // The persona id to use for the macro
    personaId: string, 
    // The chat session id to use for the macro
    chatSessionId: string,
    // The arguments to pass to the macro
    args?: any 
  }): Promise<any>;

  /**
   * Execute a system tool using the tool registry that 
   * is available for the user.
   * @param args 
   */
  executeTool(args: {
    // The tool to execute, passed as it is in the macro registry
    // i.e. "reactor.macro.greet" or by it's alias "greet"
    tool: string, 
    // The persona id to use for the macro
    personaId: string, 
    // The chat session id to use for the macro
    chatSessionId: string,
    // The arguments to pass to the macro
    args?: any 
  }): Promise<any>;

  attachImage(args: { 
    image: string, 
    personaId: string, 
    chatSessionId: string 
  }): Promise<any>;
  deleteChatSession(args: { id: string }): Promise<any>;
  
  /**
   * Attaches files to the chat session. This can be used to attach files to the chat session
   * for later retrieval or processing.
   * @param args 
   */
  attachFiles(args: {
    files: ReactoryFileDocument[],    
    chatSessionId: string
  }): Promise<any>;

  /**
   * Attaches a user file to the chat session using the file path and user file ID.
   * @param sessionId - The chat session ID
   * @param userFileId - The user file ID
   * @param path - The file path
   */
  attachUserFileToSession(sessionId: string, userFileId: string, path: string): Promise<any>;

  /**
   * Detaches a user file from the chat session using the file path and user file ID.
   * @param sessionId - The chat session ID
   * @param userFileId - The user file ID  
   * @param path - The file path
   */
  detachUserFileFromSession(sessionId: string,
    userFileId: string, 
    path: string, 
    deleteFile?: boolean): Promise<any>;

  /**
   * Sends a message to the chat session. If no chat session is found then a new one will be created.
   * @param args 
   */
  sendMessage(args: { 
    message: string, 
    personaId: string, 
    chatSessionId?: string,
    tool_results?: Record<string, any>,
    streamingMode: StreamingMode
  }): Promise<any>;
}

export type KnownLanguages =
  | "python" | "javascript" | "typescript" | "java" | "csharp" | "c" | "cpp" | "go" | "rust" | "swift" | "kotlin" | "dart" | "php" | "ruby" | "perl" | "shell" | "powershell" | "bash" | "zsh" | "groovy";

export type KnownBuildSystems =
  | "gradle" | "maven" | "ant" | "nodejs" | "make" | "cmake" | "webpack" | "gulp" | "grunt" | "terraform" | "config";

export type KnownPlatforms =
  | "reactjs" | "react-native" | "react-server-side" | "flutter" | "android" | "ios" | "web" | "unity" | "unreal" | "blazor" | "dotnet" | "aspnet" | "nextjs" | "nuxtjs" | "angular" | "angularjs" | "vue" | "vuejs" | "svelte";

export type KnownLibraries =
  | "spring-boot" | "flask" | "django" | "fastapi" | "laravel" | "symfony" | "codeigniter" | "cakephp" | "zend" | "yii" | "fuelphp" | "d3" | "three";

export type KnownConfigTypes = 
  | "backstage" | "docker" | "kubernetes" | "helm" | "ansible" | "chef" | "puppet" | "saltstack" | "vagrant" | "cloudformation" | "terraform" | "jsonnet";

export type KnownDataSystems = 
  | "tsql" | "mysql" | "postgresql" | "mongodb" | "cassandra" | "redis" | "elasticsearch" | "solr" | "neo4j" | "influxdb" | "clickhouse" | "hadoop" | "spark";

export type KnownMarkupStyles = "html" | "css" | "scss" | "less" | "sass" | "stylus";

export type KnownOfficeApps = "excel" | "word" | "powerpoint" | "outlook" | "access" | "visio" | "project" | "onenote";

export type KnownCADApps = "blender" | "maya" | "3dsmax" | "autocad" | "solidworks" | "catia" | "nx" | "creo";

export type KnownDataFormats = "text" | "csv" | "json" | "xml" | "yaml" | "toml" | "ini" | "protobuf" | "avro" | "parquet" | "orc";

export type KnownWebAPIs = "rest" | "graphql" | "soap" | "websocket" | "grpc" | "openapi" | "swagger";

export type KnownVisualizationLibs = "d3" | "three";

export type KnownReactorProjectTypes =
  | KnownLanguages
  | KnownBuildSystems
  | KnownPlatforms
  | KnownLibraries
  | KnownMarkupStyles
  | KnownOfficeApps
  | KnownCADApps
  | KnownDataFormats
  | KnownWebAPIs
  | KnownConfigTypes
  | KnownDataSystems

export interface IReactorProjectPathSpec {
  id: number;
  path: string;
  filter: string;
  type: string;
}

export interface IReactorProjectFileSpec {
  id?: number;
  path: string;
  type: string;
  content?: string;
}

export enum ReactorProjectDeploymentStatus { 
  PENDING,
  DEPLOYING,
  SUCCESS,
  FAILED,
  ROLLBACK
}

export interface ReactorProjectDeployment { 
  id: number;
  environment: string; // Environment where the project is deployed (e.g., dev, staging, prod)
  status: ReactorProjectDeploymentStatus
  name: string; // Name of the deployment
  description?: string; // Description of the deployment
  version: string; // Version of the project being deployed
  ciProvider: string; // CI/CD provider used for deployment (e.g., GitHub Actions, Jenkins, GitLab CI)
  ciBranch: string; // Branch used for the deployment
  ciPipeline: string; // CI/CD pipeline name
  ciBuildId: string; // CI/CD build identifier
  ciBuildUrl: string; // URL to the CI/CD build
  commitHash: string; // Commit hash of the code being deployed
  commitMessage: string; // Commit message of the code being deployed
  commitAuthor: string; // Author of the commit being deployed
  created: Date; // When the deployment was created
  updated: Date; // When the deployment was last updated
}

export enum ReactorProjectDashboardType {
  CHART,
  TABLE,
  MAP,
  TEXT,
  CUSTOM,
  LINK,
}

export interface ReactorProjectDashboard {
  id: number
  name: string
  description?: string
  component?: string
  componentProps?: any
  url: string
  type: ReactorProjectDashboardType
  created: Date
  updated: Date
}

export interface ReactorProjectNote {
  id: number
  title: string
  content: string
  format: "markdown" | "html" | "text"; // Format of the note content
  createdBy: Reactory.Models.TUser // User who created the note
  created: Date // When the note was created
  updated?: Date // When the note was last updated
}

/*
// Enum is used to represent the status of a project.
// This status is used to track the lifecycle of a project, such as whether it is active,
// inactive, archived, or deprecated.
*/ 
export enum ReactorProjectStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
  DEPRECATED = 'DEPRECATED',
}

// """
// Enum is used to represent the processing status of a project.
// This status is used to track the progress of project ingestion, analysis, and other processing tasks.
// """
export enum ReactorProjectProcessingStatus {
  PENDING,
  PROCESSING,
  COMPLETED,
  FAILED,
  CANCELLED,
}

export interface ReactorProjectProcessingEntry {
  id: any;
  projectId: number | string; // Reference to the project
  status: ReactorProjectProcessingStatus; // Status of the processing
  started?: Date; // When the processing started
  completed?: Date; // When the processing completed, if applicable
  errors?: string[]; // Error message if processing failed
  notes?: string; // Additional details about the processing
}

export interface ReactorProjectDocumentation {
  id: number;
  title: string;
  url?: string;
  content?: string;
  path?: string
  format: "markdown" | "html" | "text" | "pdf" | "docx" | "doc" | "xls" | "xlsx" | "ppt" | "pptx" | "csv"; // Format of the documentation
  createdBy: Reactory.Models.TUser; // User who created the documentation
  created: Date; // When the documentation was created
  updated?: Date; // When the documentation was last updated
}

export interface ReactorSlackChannel { 
  id: string;
  name: string;
  description?: string;
}

export interface IProjectProcessorConfig {
  id: string;
  processor: Reactory.FQN;
  options?: any; // Options for the processor
}

export interface IReactorProjectMetrics {
  date: Date; // The date for the metrics
  incidents: number; // Number of incidents reported on that date
  errors: number; // Number of errors reported on that date
  deployments: number; // Number of warnings reported on that date
  activeDeployments: number; // Number of warnings reported on that date
  openPullRequests: number; // Number of open pull requests on that date
  closedPullRequests: number; // Number of closed pull requests on that date
  activeBranches: number; // Performance score for the project on that date
  totalBranches: number; // Total number of branches in the project on that date
  activeTasks: number; // Total number of files in the project on that date
  openedTasks: number; // Total number of files in the project on that date
  closedTasks: number; // Total number of files in the project on that date
  totalTeams: number; // Total number of teams working on the project on that date
  totalEngineers: number; // Total number of engineers working on the project on that date
}


export interface IReactorProject extends Reactory.IComponentFqnDefinition {
  id?: number | string;
  client?: Reactory.Models.TReactoryClient; // ReactoryClient
  organization?: Partial<Reactory.Models.IOrganization> | Partial<Reactory.Models.IOrganizationDocument>; // ReactoryOrganization
  businessUnit?: Partial<Reactory.Models.TBusinessUnit>; // BusinessUnit
  fqn: string;
  name: string;
  nameSpace: string;
  version: string;
  repoPath?: string;
  repoUrl?: string;
  projectTypes: KnownReactorProjectTypes[];  
  lastSync?: Date;
  description?: string;
  tasksUrl?: string;
  primaryDocumentation: ReactorProjectDocumentation;
  secondaryDocumentation?: ReactorProjectDocumentation[];
  primarySlackChannel?: ReactorSlackChannel;
  secondarySlackChannels?: ReactorSlackChannel[];
  dependencies?: IReactorProject[];
  dependents?: IReactorProject[];
  pathSpecs?: IReactorProjectPathSpec[];
  files?: IReactorProjectFileSpec[];
  activeDeployment?: ReactorProjectDeployment; // ReactorProjectDeployment
  deployments?: ReactorProjectDeployment[]; // ReactorProjectDeployments[]
  dashboards?: ReactorProjectDashboard[]; // ReactorProjectDashboard[]
  processors: IProjectProcessorConfig[]; // ProjectProcessors[]  
  owner?: Reactory.Models.TUser; // User
  ownerTeam?: Reactory.Models.ITeam | Reactory.Models.ITeamDocument; // Team
  teams?: Reactory.Models.ITeam[] | Reactory.Models.ITeamDocument[]; // Team[]
  engineers?: Reactory.Models.TUser[]; // User[]
  activeBranch?: string;
  mainBranch?: string;
  branches?: string[];
  tags?: string[];
  created?: Date;
  updated?: Date;
  errors?: any[]; // ReactorProjectError[]
  notes?: ReactorProjectNote[]; // ReactorProjectNotes[]
  security?: any; // ReactorProjectSecurity
  projectStatus?: ReactorProjectStatus; // Status of the project
  processingHistory?: ReactorProjectProcessingEntry[]; // Processing status of the project
  [key: string]: any; // Allows for additional properties to be added dynamically
}

export interface PagedFilter {
  search?: string
  ownerTeam?: string
  owner?: string
  system?: string
  businessUnit?: string
  status?: string
  comparitor?: Partial<IReactorProject>
  paging?: PagingRequest
}

export type PageReactorProjectResult = {
  projects: Partial<IReactorProject>[]
  paging: PagingResult
}

export interface ReactorNodeAttributes extends Reactory.IKeyValuePair<string, any> { 
  id: number
}

export interface AttributeProvider extends Reactory.Service.IReactoryService {
  getAttributes(node: ReactorNode): Promise<ReactorNodeAttributes[]>
}

export interface ProjectSynchronizer extends Reactory.Service.IReactoryService { 
  /**
   * The sync method is used to synchronize the project with the 
   * reactory data store. This is used to keep the project up to data.
   * 
   * The sync process will also run the the search indexing process
   * @param project 
   */
  sync(project: IReactorProject): Promise<IReactorProject>;
  
  /**
   * Used to index the project and make the content searchable.
   * @param project 
   */
  index(project: IReactorProject): Promise<IReactorProject>;
}


export interface ReactorProjectService extends Reactory.Service.IReactoryService, ProjectSynchronizer, AttributeProvider { 
  /**
   * Returns a list of all the projects that are available for the user.
   * @param filter 
   */
  getProjects(filter?: Partial<PagedFilter>): Promise<PageReactorProjectResult>;

  /**
   * Returns a project by id or path
   * @param idOrPath 
   */
  getProject(idOrPath: string): Promise<Partial<IReactorProject>>;

  /**
   * Creates a new project
   * @param project 
   */
  createProject(project: Partial<IReactorProject>): Promise<Partial<IReactorProject>>;

  /**
   * Updates an existing project
   * @param idOrPath 
   * @param updates 
   */
  updateProject(idOrPath: string, updates: Partial<IReactorProject>): Promise<Partial<IReactorProject>>;

  /**
   * Deletes a project by id or path
   * @param idOrPath 
   */
  deleteProject(idOrPath: string): Promise<boolean>;

  /**
   * Catalogs a project
   * @param projectSpec 
   */
  catalogProject(projectSpec: Partial<IReactorProject>, options?: any): Promise<Partial<IReactorProject>>;

  /**
   * Returns a project for the specified catalog node
   * @param node 
   */
  getProjectForCatalogNode(node: Partial<ReactorNode>): Promise<Partial<IReactorProject>>;

  /**
   * Detects the project type based on the project specification.
   * @param project 
   */
  detectProjectTypes(project: Partial<IReactorProject>): Promise<KnownReactorProjectTypes[]>;

  /**
   * 
   * @param project 
   */
  detectProjectProcessors(project: Partial<IReactorProject>): Promise<IProjectProcessorConfig[]>;

  /**
   * Returns the primary documentation for the project.
   * @param project 
   */
  getPrimaryDocumentation(project: Partial<IReactorProject>): Promise<ReactorProjectDocumentation>;

  /**
   * Returns the secondary documentation for the project.
   * @param project 
   */
  getAdditionalDocumentation(project: Partial<IReactorProject>): Promise<ReactorProjectDocumentation[]>;

  /**
   * Returns the repo url for the project.
   * @param project 
   */
  getRepoUrl(project: Partial<IReactorProject>): string;

  /**
   * Returns a series of metrics for the project for the time period.
   * Default to the last 14 days
   * @param project 
   * @param startDate 
   * @param endDate 
   */
  getProjectMetrics(project: Partial<IReactorProject>, startDate?: Date, endDate?: Date): Promise<IReactorProjectMetrics[]>;

}

export interface ISystemGraphManager extends Reactory.Service.IReactoryDefaultService {

  /**
   * Returns a node using the id
   * @param id 
   * @param key - a concatenated key that provides the node tree path i.e. "1|2|3"
   */
  getNode(id: number, key?: string): Promise<ReactorNode>;
  /**
   * Returns a list of all the projects that are available for the user.
   */
  getProjects(filter?: Partial<PagedFilter>): Promise<PageReactorProjectResult>;
  
  /**
   * Get a project by path
   * @param path 
   */
  getProject(path: string): Promise<Partial<IReactorProject>>;
  
  /**
   * 
   * @param projectSpec 
   */
  catalogProject(projectSpec: Partial<IReactorProject>): Promise<Reactory.Models.ISearchable[]>;
  /**
   * Returns the root catalog nodes
   */
  getCatalogNodes(): Promise<ReactorNode[]>;
  /**
   * 
   * @param id 
   */
  getCatalogNode(id: number): Promise<ReactorNode>;
  /**
   * Populates the children of the specified nodes.
   * @param parents 
   */
  getChildren(parents: ReactorNode[]): Promise<ReactorNode[]>;

  /**
   * Populates the children of the specified nodes.
   * @param parents 
   */
  getCategoryNodes(): Promise<ReactorNodeCategory[]>;
  
  /**
   * Returns a project for the specified catalog node
   * @param node 
   */
  getProjectForCatalogNode(node: Partial<ReactorNode>): Promise<Partial<IReactorProject>>;
  /**
   * 
   * @param sources 
   * @param types 
   * @param targets 
   */
  getLinks(sources: ReactorNode[], types: string[], targets: ReactorNode[]): Promise<ReactorNodeLink[]>;

  /**
   * Creates a link between two nodes
   * @param source 
   * @param type 
   * @param target 
   */
  createLink(source: ReactorNode, type: string, target: ReactorNode): Promise<ReactorNodeLink>;

  /**
   * Updates a link
   * @param link 
   */
  updateLink(link: ReactorNodeLink): Promise<ReactorNodeLink>;

  /**
   * Deletes a link
   * @param link 
   */
  deleteLink(link: ReactorNodeLink): Promise<ReactorNodeLink>;

}

export interface IProjectNodeProvider {
  getProjectNode(project: Partial<IReactorProject>): Promise<Partial<ReactorDataNode<Partial<IReactorProject>>>>;
  /**
   * Returns children for a given node id
   * @param node 
   * @param treeKey 
   */
  getChildrenForNode(node: Partial<ReactorNode>,treeKey: string, filter: string, paging: PagingRequest): Promise<ReactorDataNode<any>[]>;
}


export interface IProjectProcessor extends ProjectSynchronizer, AttributeProvider, IProjectNodeProvider { 
  getFileSpecs(project: Partial<IReactorProject>): Partial<IReactorProjectFileSpec>[];
  setFileSpecs(project: Partial<IReactorProject>, specs: Partial<IReactorProjectFileSpec>[]): Promise<Partial<IReactorProject>>;
  /**
   * Processes the project and returns a list of searchable items.
   * This is used to index the project for search.
   * @param project 
   */
  process(project: Partial<IReactorProject>): Partial<IReactorProject>;  
  /**
   * Returns true if the processor supports the project type.
   * @param project 
   */
  supportsProject(project: Partial<IReactorProject>): boolean;
  /**
   * If the processor supports the project type then it will return the project data
   * that is specific to the processor.
   * @param project 
   */
  getProjectData(project: Partial<IReactorProject>): Promise<Partial<IReactorProject>>;
  /**
   * Returns the project type for the given project.
   * The project type is a known reactor project type.
   * @param project 
   */
  getProjectTypes(project: Partial<IReactorProject>): KnownReactorProjectTypes[];  
}

/**
 * Provider abstraction service interface.
 * Handles provider registry, model discovery, and adapter management.
 */
export interface IReactorProviderService extends Reactory.Service.IReactoryService {
  /**
   * Get all registered providers
   */
  getProviders(): Promise<any[]>;

  /**
   * Get a specific provider by ID
   */
  getProvider(providerId: string): Promise<any>;

  /**
   * Register a new provider
   */
  registerProvider(providerConfig: any): Promise<any>;

  /**
   * Update provider status
   */
  updateProviderStatus(providerId: string, status: any): Promise<any>;

  /**
   * Get adapter for provider
   */
  getAdapter(providerId: string): Promise<any>;
}

/**
 * Capability service interface.
 * Handles capability discovery, routing, and negotiation.
 */
export interface IReactorCapabilityService extends Reactory.Service.IReactoryService {
  /**
   * Get all capabilities
   */
  getCapabilities(): Promise<any[]>;

  /**
   * Get providers supporting a specific capability
   */
  getProvidersForCapability(capabilityId: string): Promise<any[]>;

  /**
   * Route a request to the appropriate provider based on capabilities
   */
  routeRequest(request: any, routingConfig: any): Promise<any>;
}


/**
 * Generic AI Provider Service interface.
 * Defines a provider-agnostic contract for AI services.
 */
export interface IAIProviderService extends Reactory.Service.IReactoryService {
  initialize(chatSessionId: string, persona: IAIPersona): Promise<void>;

  // Fine Tuning API Methods
  createFineTuningJob(params: CreateAIFineTuningJobParams): Promise<AIFineTuningJob>;
  listFineTuningJobs(params?: Record<string, any>): Promise<AIFineTuningJob[]>;
  getFineTuningJob(jobId: string): Promise<AIFineTuningJob>;
  cancelFineTuningJob(jobId: string): Promise<AIFineTuningJob>;
  listFineTuningEvents(jobId: string): Promise<AIFineTuningEvent[]>;

  // File Management
  listFiles(): Promise<AIFile[]>;
  uploadFile(filename: string, purpose: string): Promise<AIFile>;
  deleteFile(fileId: string): Promise<AIFile>;
  getFile(fileId: string): Promise<AIFile>;
  getFileContents(fileId: string): Promise<string>;

  // Image Generation
  generateImage(params: AIImageGenerationParams): Promise<AIListResponse<AIImage>>;
  extendImage(params: AIImageGenerationParams): Promise<AIListResponse<AIImage>>;

  // Model Management
  listModels(): Promise<AIListResponse<AIModel>>;

  // Chat
  chat(params: AIChatParams): Promise<AIChatCompletion>;
  chatAudio(params: AIAudioChatParams): Promise<AIChatCompletion>;
  speech2Text(audio: string | Buffer[]): Promise<string>;
}

/**
 * Extended AI Provider Service interface with streaming capabilities.
 * Defines streaming methods for real-time AI interactions.
 */
export interface IAIStreamingProviderService extends IAIProviderService {
  // Streaming Chat Methods
  chatStream(params: AIChatParams): AsyncIterable<AIStreamingEvent>;
  chatAudioStream(params: AIAudioChatParams): AsyncIterable<AIStreamingEvent>;
  
  // Provider-specific streaming capabilities
  getStreamingCapabilities(): Promise<AIStreamingCapabilities>;
}

/**
 * Streaming capabilities supported by an AI provider
 */
export interface AIStreamingCapabilities {
  /** Whether the provider supports token-by-token streaming */
  supportsTokenStreaming: boolean;
  /** Whether the provider supports tool execution streaming */
  supportsToolStreaming: boolean;
  /** Whether the provider supports function calling during streaming */
  supportsFunctionStreaming: boolean;
  /** Maximum concurrent streaming sessions */
  maxConcurrentStreams?: number;
  /** Supported streaming formats */
  supportedFormats: ('json' | 'text' | 'sse')[];
}

/**
 * Streaming event types from AI providers
 */
export type AIStreamingEventType = 
  | 'token' 
  | 'tool_call' 
  | 'function_call' 
  | 'error' 
  | 'complete'
  | 'metadata';

/**
 * Base streaming event structure
 */
export interface AIStreamingEvent {
  /** Type of streaming event */
  type: AIStreamingEventType;
  /** Event timestamp */
  timestamp: Date;
  /** Optional session identifier */
  sessionId?: string;
  /** Event data payload */
  data: any;
}

/**
 * Token streaming event data
 */
export interface AITokenStreamingData {
  /** Token content */
  content: string;
  /** Token delta (incremental change) */
  delta: string;
  /** Position in the response */
  position: number;
  /** Whether this is the final token */
  isComplete: boolean;
  /** Optional token metadata */
  metadata?: {
    logprobs?: number;
    finish_reason?: string;
  };
}

/**
 * Tool call streaming event data
 */
export interface AIToolCallStreamingData {
  /** Tool call identifier */
  id: string;
  /** Tool/function name */
  name: string;
  /** Tool arguments (may be partial during streaming) */
  arguments: string;
  /** Whether the tool call is complete */
  isComplete: boolean;
  /** Tool execution result (if available) */
  result?: any;
}

/**
 * Error streaming event data
 */
export interface AIErrorStreamingData {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Optional error details */
  details?: any;
}

/**
 * Completion streaming event data
 */
export interface AICompletionStreamingData {
  /** Complete response content */
  content: string;
  /** Completion metadata */
  metadata: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    finishReason: string;
    model: string;
  };
}

export default IOpenAIService;

