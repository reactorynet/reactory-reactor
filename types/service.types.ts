import { ChatCompletionResponseMessage } from "openai"
import { TReactorConversationModel } from "../models/ReactorChatState"

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
  botId: string
  question: string
  chatSessionId: string
}

export interface AudioChatParams extends ChatParams {
  audio: string | Buffer[]
  format: "mp3" | "wav" | "ogg"
}

/**
 * The OpenAI API service interface defines the methods that are available for
 * OpenAI API. These are based on the OpenAI API endpoints that are
 * documented here: https://platform.openai.com/docs/api-reference/introduction
 * @name IOpenAPIService
 */
interface IOpenAIService extends Reactory.Service.IReactoryService {

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

  chat(params: ChatParams) : Promise<ChatCompletionResponseMessage>;

  chatAudio(params: AudioChatParams) : Promise<ChatCompletionResponseMessage>;

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

/**
 * Defines the shape fo the AI Persona object
 */
export interface IAIPersona {
  id: string;
  modelId?: string;
  name: string;
  description?: string;
  persona: string;
  features: string;
  appearance?: IAIAppearance;
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
  executeMacro(args: { macro: string, botId: string, chatSessionId: string }): Promise<TReactorConversationModel>;
  attachImage(args: { image: string, botId: string, chatSessionId: string }): Promise<TReactorConversationModel>;
  deleteChatSession(args: { id: string }): Promise<TReactorConversationModel>; 
}

export default IOpenAIService;