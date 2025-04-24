import Reactory from '@reactory/reactory-core';
import OpenAI from "openai"
import { TReactorConversationModel } from "../models/ReactorChatState"
import { ReactorDataNode, ReactorNode, ReactorNodeCategory, ReactorNodeLink, ReactorNodeType } from "./model.types"
import { PagingRequest, PagingResult } from "@reactory/server-core/database/types"
import { ObjectId } from "mongodb"
import { MacroComponentDefinition, MacroToolDefinition } from '../ai/openai/types/chat';

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
  chatSessionId?: string
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
  content?: string;
  variables?: string[];
  role: "user" | "assistant" | "system";
}

/**
 * Defines the shape fo the AI Persona object
 */
export interface IAIPersona {
  id: string;
  modelId?: string;
  providerId?: string;
  name: string;
  description?: string;
  defaultGreeting?: string;
  persona: string;
  features: string;
  appearance?: IAIAppearance;
  prompts?: {
    [key: string]: IAIPersonaPromptTemplate
  },
  config? : {
    apiKey?: string;
    apiOrg?: string;
    apiEndpoint?: string;
    apiVersion?: string;
    apiBaseURL?: string;
  },
  tools?: any[]
  macros?: MacroComponentDefinition<unknown>[]  
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

export interface IReactorConversationsService extends Reactory.Service.IReactoryService{ 
  startChatSession(args: {
    personaId: string, 
    message: string, 
    macros: Partial<MacroComponentDefinition<unknown>>,  
    tools: Partial<MacroToolDefinition>[]
  }): Promise<any>;
  executeMacro(args: { macro: string, personaId: string, chatSessionId: string }): Promise<any>;
  attachImage(args: { image: string, personaId: string, chatSessionId: string }): Promise<any>;
  deleteChatSession(args: { id: string }): Promise<any>; 
  sendMessage(args: { message: string, personaId: string, chatSessionId?: string }): Promise<any>;
}

export type KnownReactorProjectTypes = string | "python" | "javascript" 
  | "typescript" | "react-web" | "react-native" | "react-server-side" | "java" | "csharp" | "c" 
  | "cpp" | "go" | "rust" | "swift" | "kotlin" | "dart" | "flutter" | "php" | "ruby" 
  | "perl" | "shell" | "powershell" | "bash" | "zsh" | "html" | "css" | "scss" | "less"
  | "sass" | "stylus" | "vue" | "angular" | "svelte" | "d3" | "three" | "unity" | "unreal"
  | "blender" | "maya" | "3dsmax" | "autocad" | "solidworks" | "catia" | "nx" | "creo"
  | "excel" | "word" | "powerpoint" | "outlook" | "access" | "visio" | "project" | "onenote" 
  | "android" | "ios" | "web" | "rest" | "graphql" | "gradle" | "groovy"

export interface IReactorProjectPathSpec {
  id: number;
  path: string;
  filter: string;
  type: string;
}

export interface IReactorProjectFileSpec {
  id: number;
  path: string;
  type: string;
  content: string;
}

export interface IReactorProject extends Reactory.IComponentFqnDefinition {
  id?: number;
  lastSync?: Date;
  /**
   * The root folder for the project
   */  
  source: string; 
  projectType: ReactorNodeType;
  subTypes?: KnownReactorProjectTypes[]; 
  description?: string;
  /**
   * The path specifications to use for 
   * ingesting the project. If blank then 
   * the entire project is ingested. 
   * 
   * This gives better search results and
   * allows for better categorization of
   * the project. However it is more
   * complex to manage and the data load
   * increases.
   */ 
  pathSpecs?: IReactorProjectPathSpec[];
  /**
   * The files to include in the project
   * if the pathSpecs are not used.
   * 
   * Path specs are used to populate the files
   */
  files?: Partial<IReactorProjectFileSpec>[];
  /**
   * The processor to use for the project.
   * This is used to process the project.
   */
  providerId?: string;
  providerOptions?: any;
  errors?: {
    message: string;
    stack: string;    
  }[];
}

export interface PagedFilter {
  search?: string
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
   * Used the index the project
   * @param project 
   */
  index(project: IReactorProject): Promise<IReactorProject>;
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
  getFileSpecs(project: IReactorProject): Partial<IReactorProjectFileSpec>[];
  process(project: IReactorProject): Reactory.Models.ISearchable[];  
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

export default IOpenAIService;

