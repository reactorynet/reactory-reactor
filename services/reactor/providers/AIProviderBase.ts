import Reactory from "@reactorynet/reactory-core";
import Mongoose from "mongoose";
import ReactorConversationModel from "@reactory/server-modules/reactory-reactor/models/ReactorChatState";
import { ChatState, ToolApprovalMode } from "../../../ai/openai/types/chat";
import {
  AIModel,
  AIListResponse,
  AIFineTuningJob,
  CreateAIFineTuningJobParams,
  AIFineTuningEvent,
  AIFile,
  AIImage,
  AIImageGenerationParams,
  AIChatParams,
  AIAudioChatParams,
  AIChatCompletion
} from "../../../types/model.types";
import { IAIPersona, IAIPersonaPromptTemplate, IAIProviderService } from "../../../types/service.types";
import { AIProviderError } from "./AIProviderError";
import { resolvePromptDirectives } from "../../../ai/persona/loader/system-prompt";

import { loadHistoryForContext } from "../conversationHistoryLoader";

abstract class AIProviderBase implements IAIProviderService {
  context: Reactory.Server.IReactoryContext;
  props: any;
  chatStateModel: Mongoose.Document;
  chatState: ChatState;
  personaProvider: any;

  constructor(props: any, context: Reactory.Server.IReactoryContext) {
    this.context = context;
    this.props = props;
  }

  /**
   * Persists the chat state to the database
   */
  protected async persistChatState(): Promise<void> {
    const { personaId, modelId, started, id, sseSession, vars } = this.chatState;
    const { user } = this.context;
    const meta = {
      summary: "Chat session",
      title: `Chat session`,
    };

    try {
      // Use findOneAndUpdate with upsert to handle the unique constraint properly
      // This prevents duplicate key errors when the same conversation is being updated
      const updateData: any = {
        personaId,
        modelId,
        sseSessionId: sseSession,
        user,
        vars,
        tools: this.chatState.tools || [],
        macros: this.chatState.macros || [],
        updated: new Date(),
        meta
      };

      // The message store is the source of truth, so the embedded `history` array is never written
      // here: doing so would (a) re-create the retired field and (b) race the `$push` + mirror
      // writes the conversation service already performs for the same turn. Metadata is still
      // persisted either way.

      // Only set started and created if this is a new conversation
      if (!this.chatStateModel || !this.chatStateModel._id) {
        updateData.started = started;
        updateData.created = new Date();
      }

      const nextStateModel = await ReactorConversationModel.findOneAndUpdate(
        { _id: id },
        updateData,
        { 
          new: true, 
          upsert: true,
          setDefaultsOnInsert: true
        }
      ).exec();

      // Validate user ownership
      if (nextStateModel.user && nextStateModel.user._id.toString() !== user._id.toString()) {
        throw new AIProviderError(`User ${user._id.toString()} does not match chat state user ${nextStateModel.user._id.toString()}`);
      }

      this.chatStateModel = nextStateModel;
    } catch (error: any) {
      // Handle duplicate key errors gracefully
      if (error.code === 11000) {
        this.context.warn("Duplicate conversation detected during persist, attempting to find existing", {
          personaId,
          userId: user._id,
          chatId: id,
          error: error.message
        });
        
        // Try to find the existing conversation
        const existingConversation = await ReactorConversationModel.findOne({
          personaId,
          user: user._id,
          started: started
        }).exec();
        
        if (existingConversation) {
          // Update the existing conversation instead. Same rule as the upsert above: the embedded
          // array is never written, so the retired field cannot be re-created.
          existingConversation.updated = new Date();
          existingConversation.sseSessionId = sseSession;
          existingConversation.vars = vars;
          existingConversation.tools = this.chatState.tools || [];
          existingConversation.macros = this.chatState.macros || [];
          await existingConversation.save();
          
          this.chatStateModel = existingConversation;
          return;
        }
      }
      
      this.context.error(
        `Error persisting chat state: ${error.message || error.toString()}`,
        { error },
        'AIProviderBase.persistChatState'
      );
      throw new AIProviderError('Failed to persist chat state');
    }
  }

  /**
   * Remove the in-flight user turn from the transcript this provider loaded.
   *
   * The message store (Postgres) is authoritative and `sendMessage` persists the
   * turn *before* handing it to the provider; `loadChatState` then loads the whole
   * transcript, which already ends with that turn. Every provider's message builder
   * iterates the transcript **and** appends the current `message`, so without this
   * the turn reaches the model twice — once from history, once from the append.
   *
   * Removing the duplicate here rather than dropping the append is deliberate: the
   * append is still load-bearing for callers that do *not* persist first —
   * `generateCompactionSummary` sends a synthesised transcript that has no row in
   * the message store, and the audio path sends a freshly transcribed message.
   * Those callers pass no `messageId`, so this is a no-op for them.
   *
   * Matching is by identity, not content, on purpose: a content comparison would
   * silently swallow a legitimate back-to-back repeat of identical text.
   *
   * @param messageId `id` of the turn as persisted in the transcript. When absent
   *   (any caller that did not persist first) this does nothing.
   * @returns number of transcript entries removed — 0 or 1 in practice.
   */
  public excludeInFlightTurn(messageId?: string | null): number {
    if (!messageId) return 0;

    const history = this.chatState?.history;
    if (!Array.isArray(history) || history.length === 0) return 0;

    const target = String(messageId);
    const kept = history.filter((item: any) => {
      const id = item?.id ?? item?._id;
      return id === undefined || id === null || String(id) !== target;
    });

    const removed = history.length - kept.length;
    if (removed > 0) {
      // Reassign so providers that read `chatState.history` at build time (all of
      // them) see the trimmed transcript without any further plumbing.
      this.chatState.history = kept as any;

      this.context?.debug?.(
        `Excluded in-flight turn ${target} from provider history`,
        { removed, remaining: kept.length },
        'AIProviderBase.excludeInFlightTurn'
      );
    }

    return removed;
  }

  /**
   * Loads a chat state from the database or creates a new one if it doesn't exist
   */
  protected async loadChatState(chatSessionId?: string): Promise<boolean> {
    const { context } = this;
    
    if (!chatSessionId) {
      chatSessionId = new Mongoose.Types.ObjectId().toString();
      this.chatStateModel = null;
      return true;
    }
    
    try {
      const chatSession = await ReactorConversationModel.findById(chatSessionId).populate("files").exec();
      
      if (!chatSession) {
        this.chatStateModel = null;
        return true;
      }
      
      if (chatSession.user && chatSession.user._id.toString() !== context.user._id.toString()) {
        throw new AIProviderError(`Chat session ${chatSessionId} does not belong to user ${context.user._id.toString()}`);
      }
      
      // @ts-ignore
      this.chatStateModel = chatSession;

      // Resolve persona — getPersona is async so we must await it
      let persona;
      try {
        persona = this.personaProvider
          ? await this.personaProvider.getPersona(chatSession.personaId)
          : undefined;
      } catch {
        // Persona lookup can fail for removed or renamed personas;
        // initialize() will overwrite with the caller-supplied persona.
        persona = undefined;
      }
      
      this.chatState = {
        id: chatSession._id.toString(),
        user: context.user,
        // See the matching comment in the new-session branch above: this must
        // always be populated so role-gated macros/tools work when invoked
        // through a provider's internal tool-execution loop.
        context,
        modelId: chatSession.modelId,
        started: chatSession.started,
        // Phase 3: model context comes from the message store when it is
        // authoritative. `loadHistoryForContext` fails open to the embedded
        // array, so this is behaviour-preserving under the `mongo` source.
        history:
          (await loadHistoryForContext(
            chatSession._id.toString(),
            chatSession.history,
            this.context as any
          )) ?? chatSession.history,        
        personaId: chatSession.personaId,
        persona,
        vars: chatSession.vars || {},
        sseSession: chatSession.sseSessionId,
        macros: chatSession.macros,
        tools: chatSession.tools,
        files: chatSession.files || [],
        toolApprovalMode: chatSession.toolApprovalMode || (process.env.TOOL_APPROVAL_MODE as ToolApprovalMode) || ToolApprovalMode.PROMPT,
        apiKey: undefined,
        apiOrg: undefined,
        ai: undefined,
      };
      
      return false;
    } catch (error) {
      if (error.message.includes('does not belong to user')) {
        throw error;
      }
      
      this.context.error(
        `Error loading chat state: ${error.message || error.toString()}`,
        { error, chatSessionId },
        'AIProviderBase.loadChatState'
      );
      
      this.chatStateModel = null;
      return true;
    }
  }

  /**
   * Initialize provider client with appropriate model
   */
  protected abstract initializeClient(persona: IAIPersona): Promise<void>;

  /**
   * Create system prompt message based on persona
   */
  protected createSystemPrompt(persona: IAIPersona): any {
    if (!persona.prompts || !persona.prompts["system"]) {
      throw new AIProviderError(`Persona ${persona.id} does not have a system prompt`);
    }
    
    const promptTemplate: IAIPersonaPromptTemplate = persona.prompts["system"];
    // YAML personas declare their system prompt as ${buildSystemPrompt()}; the
    // PersonaLoaderService resolves that at load time. This call is a no-op for
    // already-resolved content and a safety net for personas that bypassed the loader.
    const promptContent = resolvePromptDirectives(promptTemplate.content || "", {
      persona: persona.persona,
      features: persona.features,
      tools: persona.tools || [],
      resources: persona.resources || [],
      userRoles: (this.context.user?.roles as string[]) || ["USER"],
    });

    return {
      role: "system",
      // Interpolate only the classic <%= ... %> delimiter, NOT the ES ${...}
      // delimiter that lodash enables by default. Persona prompt content is
      // already fully rendered at load time (see each persona's buildSystemPrompt,
      // which uses this same interpolate option) and the rendered text legitimately
      // contains literal ${...} examples documenting the workflow template syntax.
      // Leaving lodash's default ES interpolation on would try to compile those
      // literals — e.g. `${...}` throws "Unexpected token ')'" at compile time and
      // `${env.VAR_NAME}` throws a ReferenceError at runtime — corrupting or crashing
      // the system prompt. Overriding `interpolate` with a fresh regex disables the
      // ES delimiter (lodash only enables it when the default interpolate regex is used).
      content: this.context.utils.lodash.template(promptContent, {
        interpolate: /<%=([\s\S]+?)%>/g,
      })({
        persona: persona,
        tools: persona.tools,
        macros: persona.macros,
        user: {
          id: this.context.user.id,
          fullName: this.context.user.fullName(false),
          firstName: this.context.user.firstName,
          lastName: this.context.user.lastName,
        },
      }),
    };
  }

  /**
   * Initialize the AI provider with a chat session and persona
   */
  public async initialize(chatSessionId: string, persona: IAIPersona): Promise<void> {
    try {
      await this.initializeClient(persona);
      
      const isNewSession = await this.loadChatState(chatSessionId);
      
      if (isNewSession) {
        const SYSTEM_INITIALIZER_MESSAGE = this.createSystemPrompt(persona);
        
        //@ts-ignore
        this.chatState = {
          id: chatSessionId,
          user: this.context.user,
          // Bug fix: `context` is part of the ChatState contract (and the Macro
          // signature accepts it as a 3rd param) specifically so role-gated
          // macros/tools (e.g. the `shell` macro's `hasAnyRole` check) can
          // authorize correctly when executed via a provider's internal
          // agentic tool loop (see AnthropicService.executeToolCall). Without
          // this, `state.context` is undefined and every role-gated tool call
          // routed through such a loop fails closed with an Unauthorized error,
          // regardless of the invoking user's actual roles.
          context: this.context,
          modelId: persona.modelId,
          started: new Date(),
          history: [SYSTEM_INITIALIZER_MESSAGE],      
          personaId: persona.id,
          persona,
          vars: {},
          macros: persona.macros || [],
          tools: persona.tools || [],
          toolApprovalMode: (process.env.TOOL_APPROVAL_MODE as ToolApprovalMode) || ToolApprovalMode.PROMPT,
        };

        await this.persistChatState();
      }

      // Always ensure the persona is set from the caller's parameter.
      // loadChatState may have resolved an outdated or undefined persona;
      // the caller (e.g. executeProviderChat) always passes the authoritative one.
      if (persona) {
        this.chatState.persona = persona;
      }
    } catch (error) {
      this.context.error(
        `Error initializing AI provider: ${error.message || error.toString()}`,
        { error },
        'AIProviderBase.initialize'
      );
      throw error;
    }
  }

  // Default implementations that throw errors - should be implemented by providers
  async chat(params: AIChatParams): Promise<AIChatCompletion> {
    throw new AIProviderError("Method not implemented");
  }

  /**
   * Transcribes audio to text using the SpeechService, sends the text through
   * the provider's chat method, and optionally synthesizes the response back
   * to audio. Falls back to text-only if the SpeechService is unavailable.
   */
  async chatAudio(params: AIAudioChatParams): Promise<AIChatCompletion> {
    const speechService = this.getSpeechService();
    if (!speechService) {
      throw new AIProviderError("SpeechService is not available. Ensure the reactory-speech module is loaded.");
    }

    // Step 1: Transcribe the audio input to text
    const audioBuffer = typeof params.audio === 'string'
      ? Buffer.from(params.audio, 'base64')
      : Buffer.concat(params.audio);

    const transcription = await speechService.transcribe(audioBuffer, {
      language: params.language,
    });

    // Step 2: Send the transcribed text through the regular chat pipeline
    const chatResult = await this.chat({
      ...params,
      message: transcription.text,
    });

    return chatResult;
  }

  /**
   * Converts audio to text using the SpeechService.
   */
  async speech2Text(audio: string | Buffer[]): Promise<string> {
    const speechService = this.getSpeechService();
    if (!speechService) {
      throw new AIProviderError("SpeechService is not available. Ensure the reactory-speech module is loaded.");
    }

    const audioBuffer = typeof audio === 'string'
      ? Buffer.from(audio, 'base64')
      : Buffer.concat(audio);

    const result = await speechService.transcribe(audioBuffer);
    return result.text;
  }

  /**
   * Attempts to retrieve the SpeechService from the execution context.
   * Returns null if the service is not available.
   */
  private getSpeechService(): any | null {
    try {
      return this.context.getService('speech.SpeechService@1.0.0');
    } catch {
      return null;
    }
  }

  async createFineTuningJob(params: CreateAIFineTuningJobParams): Promise<AIFineTuningJob> {
    throw new AIProviderError("Method not implemented");
  }

  async listFineTuningJobs(params?: Record<string, any>): Promise<AIFineTuningJob[]> {
    throw new AIProviderError("Method not implemented");
  }

  async getFineTuningJob(jobId: string): Promise<AIFineTuningJob> {
    throw new AIProviderError("Method not implemented");
  }

  async cancelFineTuningJob(jobId: string): Promise<AIFineTuningJob> {
    throw new AIProviderError("Method not implemented");
  }

  async listFineTuningEvents(jobId: string): Promise<AIFineTuningEvent[]> {
    throw new AIProviderError("Method not implemented");
  }

  async listFiles(): Promise<AIFile[]> {
    throw new AIProviderError("Method not implemented");
  }

  async uploadFile(filename: string, purpose: string): Promise<AIFile> {
    throw new AIProviderError("Method not implemented");
  }

  async deleteFile(fileId: string): Promise<AIFile> {
    throw new AIProviderError("Method not implemented");
  }

  async getFile(fileId: string): Promise<AIFile> {
    throw new AIProviderError("Method not implemented");
  }

  async getFileContents(fileId: string): Promise<string> {
    throw new AIProviderError("Method not implemented");
  }

  async generateImage(params: AIImageGenerationParams): Promise<AIListResponse<AIImage>> {
    throw new AIProviderError("Method not implemented");
  }

  async extendImage(params: AIImageGenerationParams): Promise<AIListResponse<AIImage>> {
    throw new AIProviderError("Method not implemented");
  }

  async listModels(): Promise<AIListResponse<AIModel>> {
    throw new AIProviderError("Method not implemented");
  }

  // Required by IReactoryService interface
  toString?(includeVersion?: boolean): string {
    return `AIProvider${includeVersion ? `@${this.version}` : ''}`;
  }

  description?: string = "Base AI Provider Service";
  tags?: string[] = ["ai", "provider"];
  nameSpace: string = "reactor";
  name: string = "AIProviderBase";
  version: string = "1.0.0";
}

export default AIProviderBase;
