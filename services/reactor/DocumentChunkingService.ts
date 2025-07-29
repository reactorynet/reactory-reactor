import { service } from "@reactory/server-core/application/decorators/service";

export interface ChunkingOptions {
  maxChunkSize?: number; // Maximum tokens per chunk
  overlapSize?: number; // Overlap between chunks to maintain context
  chunkBy?: 'tokens' | 'characters' | 'sentences' | 'paragraphs';
  preserveStructure?: boolean; // Try to keep logical structure intact
  includeSummary?: boolean; // Whether to generate summaries for chunks
  summaryStrategy?: 'individual' | 'hierarchical' | 'final'; // Summary generation strategy
}

export interface SendMessageFunction {
  (args: {
    personaId: string;
    chatSessionId: string;
    message: string;
    role?: string;
    tool_name?: string;
    tool_args?: any;
    tool_call_id?: string;
  }): Promise<any>;
}

export interface DocumentChunk {
  id: string;
  content: string;
  startIndex: number;
  endIndex: number;
  metadata?: Record<string, any>;
  summary?: string;
}

export interface ChunkingResult {
  chunks: DocumentChunk[];
  summary: {
    totalChunks: number;
    totalTokens: number;
    originalSize: number;
    processingTime: number;
    summary?: string; // Overall document summary
  };
}

@service({
  id: "reactor.DocumentChunkingService@1.0.0",
  name: "DocumentChunkingService",
  nameSpace: "reactor",
  version: "1.0.0",
  description: "Service for chunking large documents and generating summaries for AI processing",
  serviceType: "ai",
  dependencies: [],
})
export default class DocumentChunkingService {
  private readonly context: Reactory.Server.IReactoryContext;

  nameSpace: string = "reactor";
  name: string = "Document Chunking Service";
  version: string = "1.0.0";
  description?: string = "Service for chunking large documents and generating summaries for AI processing";
  tags?: string[] = ["document", "chunking", "ai", "summary"];

  constructor(props: Reactory.Service.IReactoryServiceProps, context: Reactory.Server.IReactoryContext) {
    this.context = context;
  }

  toString(includeVersion?: boolean): string {
    if (includeVersion) {
      return `${this.nameSpace}.${this.name}@${this.version}`;
    }
    return `${this.nameSpace}.${this.name}`;
  }

  toStringWithVersion(): string {
    return `${this.nameSpace}.${this.name}@${this.version}`;
  }

  /**
   * Estimate token count for a given text
   * Rough approximation: 1 token ≈ 4 characters for English text
   */
  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Chunk document by tokens with optional summarization
   */
  async chunkDocument(
    content: string, 
    options: ChunkingOptions = {},
    sendMessage?: SendMessageFunction,
    chatState?: any
  ): Promise<ChunkingResult> {
    const startTime = Date.now();
    const {
      maxChunkSize = 4000,
      overlapSize = 200,
      preserveStructure = true,
      includeSummary = false,
      summaryStrategy = 'individual'
    } = options;

    const chunks: DocumentChunk[] = [];
    let currentIndex = 0;
    let chunkId = 0;
    const originalSize = content.length;
    const totalTokens = this.estimateTokenCount(content);

    this.context.info(`Starting document chunking`, {
      originalSize,
      totalTokens,
      maxChunkSize,
      includeSummary,
      summaryStrategy
    }, "DocumentChunkingService.chunkDocument");

    while (currentIndex < content.length) {
      const chunkStart = Math.max(0, currentIndex - overlapSize);
      const chunkEnd = Math.min(content.length, currentIndex + maxChunkSize * 4);
      
      let chunkContent = content.substring(chunkStart, chunkEnd);
      
      // If preserving structure, try to break at sentence boundaries
      if (preserveStructure && chunkEnd < content.length) {
        const lastSentenceEnd = chunkContent.lastIndexOf('.');
        const lastParagraphEnd = chunkContent.lastIndexOf('\n\n');
        const breakPoint = Math.max(lastSentenceEnd, lastParagraphEnd);
        
        if (breakPoint > chunkStart + maxChunkSize * 2) {
          chunkContent = chunkContent.substring(0, breakPoint + 1);
        }
      }

      const chunk: DocumentChunk = {
        id: `chunk_${chunkId}`,
        content: chunkContent,
        startIndex: chunkStart,
        endIndex: chunkStart + chunkContent.length,
        metadata: {
          tokenEstimate: this.estimateTokenCount(chunkContent),
          chunkNumber: chunkId + 1,
          totalChunks: Math.ceil(content.length / (maxChunkSize * 4))
        }
      };

      // Generate summary for individual chunk if requested
      if (includeSummary && summaryStrategy === 'individual' && sendMessage && chatState) {
        try {
          chunk.summary = await this.generateChunkSummary(chunkContent, sendMessage, chatState);
        } catch (error) {
          this.context.warn(`Failed to generate summary for chunk ${chunkId}`, { error });
        }
      }

      chunks.push(chunk);
      currentIndex = chunkStart + chunkContent.length;
      chunkId++;
    }

    // Generate hierarchical or final summary if requested
    let overallSummary: string | undefined;
    if (includeSummary && (summaryStrategy === 'hierarchical' || summaryStrategy === 'final') && sendMessage && chatState) {
      try {
        if (summaryStrategy === 'hierarchical') {
          overallSummary = await this.generateHierarchicalSummary(chunks, sendMessage, chatState);
        } else {
          overallSummary = await this.generateFinalSummary(content, chunks, sendMessage, chatState);
        }
      } catch (error) {
        this.context.warn(`Failed to generate overall summary`, { error });
      }
    }

    const processingTime = Date.now() - startTime;

    this.context.info(`Document chunking completed`, {
      totalChunks: chunks.length,
      processingTime,
      averageChunkSize: Math.round(totalTokens / chunks.length)
    }, "DocumentChunkingService.chunkDocument");

    return {
      chunks,
      summary: {
        totalChunks: chunks.length,
        totalTokens,
        originalSize,
        processingTime,
        summary: overallSummary
      }
    };
  }

  /**
   * Process large document in chunks with AI using sendMessage function
   */
  async processLargeDocumentWithAI<T>(
    content: string,
    sendMessage: SendMessageFunction,
    chatState: any,
    options: ChunkingOptions = {}
  ): Promise<{
    results: T[];
    summary: {
      totalChunks: number;
      processedChunks: number;
      failedChunks: number;
      totalTokens: number;
      originalSize: number;
      processingTime: number;
      finalSummary?: string;
    };
  }> {
    const startTime = Date.now();
    const originalSize = content.length;
    const estimatedTokens = this.estimateTokenCount(content);
    
    this.context.info(`Processing large document with AI`, {
      originalSize,
      estimatedTokens,
      maxChunkSize: options.maxChunkSize || 4000
    }, "DocumentChunkingService.processLargeDocumentWithAI");

    // Check if document is already small enough
    if (estimatedTokens <= (options.maxChunkSize || 4000)) {
      this.context.debug("Document is small enough, processing directly", {
        estimatedTokens
      }, "DocumentChunkingService.processLargeDocumentWithAI");
      
      const result = await sendMessage({
        personaId: chatState.personaId,
        chatSessionId: chatState._id.toString(),
        message: content
      });
      
      const processingTime = Date.now() - startTime;

      return {
        results: [result],
        summary: {
          totalChunks: 1,
          processedChunks: 1,
          failedChunks: 0,
          totalTokens: estimatedTokens,
          originalSize,
          processingTime
        }
      };
    }

    // Use chunking service to process large document
    const chunkResult = await this.chunkDocument(content, options, sendMessage, chatState);
    const results: T[] = [];
    let processedChunks = 0;
    let failedChunks = 0;

    for (const chunk of chunkResult.chunks) {
      try {
        const result = await sendMessage({
          personaId: chatState.personaId,
          chatSessionId: chatState._id.toString(),
          message: chunk.content
        });
        
        results.push(result);
        processedChunks++;
        
        this.context.debug(`Processed chunk ${chunk.metadata?.chunkNumber}/${chunkResult.chunks.length}`, {
          chunkId: chunk.id,
          tokenEstimate: chunk.metadata?.tokenEstimate
        }, "DocumentChunkingService.processLargeDocumentWithAI");
        
      } catch (error) {
        failedChunks++;
        this.context.error(`Failed to process chunk ${chunk.id}`, {
          chunkId: chunk.id,
          error: error.message
        }, "DocumentChunkingService.processLargeDocumentWithAI");
      }
    }

    const processingTime = Date.now() - startTime;

    // Generate final summary if requested
    let finalSummary: string | undefined;
    if (options.includeSummary && options.summaryStrategy === 'final' && results.length > 0) {
      try {
        finalSummary = await this.generateResultsSummary(results, sendMessage, chatState);
      } catch (error) {
        this.context.warn(`Failed to generate final summary`, { error });
      }
    }

    return {
      results,
      summary: {
        totalChunks: chunkResult.chunks.length,
        processedChunks,
        failedChunks,
        totalTokens: chunkResult.summary.totalTokens,
        originalSize,
        processingTime,
        finalSummary
      }
    };
  }

  /**
   * Generate summary for a single chunk
   */
  private async generateChunkSummary(content: string, sendMessage: SendMessageFunction, chatState: any): Promise<string> {
    try {
      const prompt = `Please provide a concise summary (2-3 sentences) of the following content:\n\n${content}`;
      
      const response = await sendMessage({
        personaId: chatState.personaId,
        chatSessionId: chatState._id.toString(),
        message: prompt
      });

      return response?.content || `Summary: ${content.substring(0, 100)}...`;
    } catch (error) {
      this.context.warn(`Failed to generate chunk summary`, { error });
      return `Summary: ${content.substring(0, 100)}...`;
    }
  }

  /**
   * Generate hierarchical summary from chunk summaries
   */
  private async generateHierarchicalSummary(chunks: DocumentChunk[], sendMessage: SendMessageFunction, chatState: any): Promise<string> {
    try {
      const chunkSummaries = chunks
        .map((chunk, index) => `Chunk ${index + 1}: ${chunk.summary || chunk.content.substring(0, 100)}...`)
        .join('\n\n');

      const prompt = `Please provide a comprehensive summary of this document based on the following chunk summaries:\n\n${chunkSummaries}`;
      
      const response = await sendMessage({
        personaId: chatState.personaId,
        chatSessionId: chatState._id.toString(),
        message: prompt
      });

      return response?.content || `Document summary: ${chunks.length} chunks processed`;
    } catch (error) {
      this.context.warn(`Failed to generate hierarchical summary`, { error });
      return `Document summary: ${chunks.length} chunks processed`;
    }
  }

  /**
   * Generate final summary from original content and chunks
   */
  private async generateFinalSummary(content: string, chunks: DocumentChunk[], sendMessage: SendMessageFunction, chatState: any): Promise<string> {
    try {
      const prompt = `Please provide a comprehensive summary of this document:\n\n${content}`;
      
      const response = await sendMessage({
        personaId: chatState.personaId,
        chatSessionId: chatState._id.toString(),
        message: prompt
      });

      return response?.content || `Document summary: ${chunks.length} chunks processed`;
    } catch (error) {
      this.context.warn(`Failed to generate final summary`, { error });
      return `Document summary: ${chunks.length} chunks processed`;
    }
  }

  /**
   * Generate summary of processing results
   */
  private async generateResultsSummary(results: any[], sendMessage: SendMessageFunction, chatState: any): Promise<string> {
    try {
      const resultsText = results
        .map((result, index) => `Result ${index + 1}: ${JSON.stringify(result).substring(0, 200)}...`)
        .join('\n\n');

      const prompt = `Please provide a summary of the processing results:\n\n${resultsText}`;
      
      const response = await sendMessage({
        personaId: chatState.personaId,
        chatSessionId: chatState._id.toString(),
        message: prompt
      });

      return response?.content || `Processed ${results.length} chunks successfully`;
    } catch (error) {
      this.context.warn(`Failed to generate results summary`, { error });
      return `Processed ${results.length} chunks successfully`;
    }
  }

  /**
   * Monitor document size and warn if approaching limits
   */
  monitorDocumentSize(content: string, warningThreshold: number = 15000): {
    size: number;
    estimatedTokens: number;
    warnings: string[];
    recommendations: string[];
  } {
    const size = content.length;
    const estimatedTokens = this.estimateTokenCount(content);
    const warnings: string[] = [];
    const recommendations: string[] = [];

    if (estimatedTokens > warningThreshold) {
      warnings.push(`Document estimated at ${estimatedTokens} tokens, approaching AI model limits`);
      recommendations.push(`Consider using chunking with maxChunkSize: ${Math.floor(warningThreshold * 0.8)}`);
    }

    if (size > 100000) { // 100KB
      warnings.push(`Document size is ${(size / 1024).toFixed(1)}KB, consider chunking`);
      recommendations.push(`Use chunking with preserveStructure: true for better results`);
    }

    if (estimatedTokens > 50000) {
      warnings.push(`Very large document (${estimatedTokens} tokens), processing may be slow`);
      recommendations.push(`Consider using hierarchical summarization to reduce processing time`);
    }

    if (warnings.length > 0) {
      this.context.warn("Document size warnings", {
        size,
        estimatedTokens,
        warnings,
        recommendations
      }, "DocumentChunkingService.monitorDocumentSize");
    }

    return {
      size,
      estimatedTokens,
      warnings,
      recommendations
    };
  }

  async onStartup(): Promise<void> {
    this.context.debug("DocumentChunkingService started", {}, "DocumentChunkingService.onStartup");
  }
} 