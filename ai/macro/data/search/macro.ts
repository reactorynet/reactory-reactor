import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";

// ==================== TYPE DEFINITIONS ====================

export type OutputFormat = "json" | "markdown" | "summary" | "detailed";

export interface SearchContentParams {
  query: string;
  index?: string;
  indices?: string[];
  fields?: string[];
  limit?: number;
  offset?: number;
  highlight?: boolean;
  format?: OutputFormat;
}

export interface IndexContentParams {
  index: string;
  documents: Record<string, any>[];
  idField?: string;
  replaceExisting?: boolean;
  format?: OutputFormat;
}

export interface CreateIndexParams {
  index: string;
  primaryKey?: string;
  searchableAttributes?: string[];
  filterableAttributes?: string[];
  sortableAttributes?: string[];
  format?: OutputFormat;
}

export interface DeleteIndexParams {
  index: string;
  confirm: boolean;
  format?: OutputFormat;
}

export interface GetIndexStatsParams {
  index?: string;
  includeDocumentCount?: boolean;
  includeFieldStats?: boolean;
  format?: OutputFormat;
}

export interface SearchSuggestionsParams {
  query: string;
  index?: string;
  limit?: number;
  field?: string;
  format?: OutputFormat;
}

export interface SearchResult {
  id: string;
  score: number;
  source: Record<string, any>;
  highlights?: Record<string, string[]>;
  index: string;
}

export interface SearchMetadata {
  query: string;
  executionTime: number;
  totalHits: number;
  maxScore: number;
  indices: string[];
  processingTime: number;
}

export interface SearchSummary {
  resultCount: number;
  hasMore: boolean;
  topScore: number;
  searchTerms: string[];
  suggestedFilters: string[];
}

export interface IndexOperation {
  indexId: string;
  status: "processing" | "completed" | "failed";
  documentsAdded: number;
  documentsUpdated: number;
  documentsFailed: number;
  errors?: string[];
}

// ==================== UTILITY FUNCTIONS ====================

function validateSearchService(context: Reactory.Server.IReactoryContext, tool: string, params: any): {
  service: Reactory.Service.ISearchService | null;
  error: any;
} {
  const searchService = context.getService<Reactory.Service.ISearchService>("core.ReactorySearchService@1.0.0");
  
  if (!searchService) {
    context.error("ReactorySearchService not found", {}, "SearchMacro");
    return {
      service: null,
      error: {
        success: false,
        error: "ReactorySearchService is not available",
        tool,
        params
      }
    };
  }
  
  return { service: searchService, error: null };
}

function formatSearchResults(results: any[], metadata: any, format: OutputFormat): any {
  switch (format) {
    case "markdown":
      return `
# Search Results

**Query**: ${metadata.query}
**Total Results**: ${metadata.totalHits}
**Execution Time**: ${metadata.executionTime}ms

## Results

${results.map((result, index) => `
### ${index + 1}. ${result.source.title || result.id}
**Score**: ${result.score}
**Index**: ${result.index}

${result.source.content ? result.source.content.substring(0, 200) + '...' : 'No content preview available'}

${result.highlights ? Object.entries(result.highlights).map(([field, highlights]) => 
  `**${field}**: ${Array.isArray(highlights) ? highlights.join(', ') : highlights}`
).join('\n') : ''}
`).join('\n')}
      `;
      
    case "summary":
      return {
        summary: {
          query: metadata.query,
          totalResults: metadata.totalHits,
          returnedResults: results.length,
          executionTime: metadata.executionTime,
          hasMore: metadata.totalHits > results.length,
          topScore: results.length > 0 ? results[0].score : 0
        },
        results: results.map(r => ({
          id: r.id,
          title: r.source.title || r.id,
          score: r.score,
          index: r.index,
          preview: r.source.content ? r.source.content.substring(0, 100) + '...' : null
        }))
      };
      
    case "detailed":
      return {
        metadata,
        results: results,
        analysis: {
          averageScore: results.reduce((sum, r) => sum + r.score, 0) / results.length,
          indicesUsed: [...new Set(results.map(r => r.index))],
          hasHighlights: results.some(r => r.highlights),
          contentTypes: [...new Set(results.map(r => r.source.type || 'unknown'))]
        }
      };
      
    default: // json
      return {
        metadata,
        results,
        summary: {
          totalResults: metadata.totalHits,
          returnedResults: results.length,
          hasMore: metadata.totalHits > results.length
        }
      };
  }
}

function extractSearchTerms(query: string): string[] {
  return query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(term => term.length > 2);
}

// ==================== SEARCH CONTENT MACRO ====================

const SearchContentMacro = async (
  params: SearchContentParams,
  chatState: ChatState,
) => {
  const { context } = chatState;
  const {
    query,
    index,
    indices,
    fields,
    limit = 10,
    offset = 0,
    highlight = true,
    format = "json",
  } = params;

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: "Search query is required and cannot be empty.",
      tool: 'searchContent',
      params: params
    };
  }

  const { service: searchService, error } = validateSearchService(context, 'searchContent', params);
  if (error) return error;

  try {
    context.debug("Starting SearchContentMacro execution", { params }, "SearchMacro");
    
    const startTime = Date.now();
    
    // Determine which indices to search
    const searchIndices = indices || (index ? [index] : ['book-catalog', 'book-chapters', 'book-glossary']);
    
    // Perform search across indices
    const searchPromises = searchIndices.map(async (indexName) => {
      try {
        const result = await searchService.search(indexName, query, fields, limit, offset);
        return {
          index: indexName,
          results: result.results,
          total: result.total,
          success: true
        };
      } catch (error) {
        context.warn(`Search failed for index ${indexName}`, { error }, "SearchMacro");
        return {
          index: indexName,
          results: [] as any[],
          total: 0,
          success: false,
          error: error.message
        };
      }
    });

    const indexResults = await Promise.all(searchPromises);
    const executionTime = Date.now() - startTime;

    // Combine and sort results
    const allResults: SearchResult[] = [];
    let totalHits = 0;
    const successfulIndices: string[] = [];

    indexResults.forEach(({ index: indexName, results, total, success }) => {
      if (success) {
        successfulIndices.push(indexName);
        totalHits += total;
        results.forEach((result: any) => {
          allResults.push({
            id: result.id || result._id,
            score: result._score || 1,
            source: result,
            highlights: highlight ? result._formatted : undefined,
            index: indexName
          });
        });
      }
    });

    // Sort by score and apply limit
    allResults.sort((a, b) => b.score - a.score);
    const limitedResults = allResults.slice(0, limit);

    const metadata: SearchMetadata = {
      query,
      executionTime,
      totalHits,
      maxScore: limitedResults.length > 0 ? limitedResults[0].score : 0,
      indices: successfulIndices,
      processingTime: executionTime
    };

    const summary: SearchSummary = {
      resultCount: limitedResults.length,
      hasMore: totalHits > limitedResults.length,
      topScore: metadata.maxScore,
      searchTerms: extractSearchTerms(query),
      suggestedFilters: [...new Set(limitedResults.map(r => r.source.type || r.source.subject).filter(Boolean))]
    };

    // Store in chat state for AI reference
    chatState.vars.lastSearchResults = limitedResults;
    chatState.vars.lastSearchQuery = query;
    chatState.vars.searchMetadata = metadata;
    chatState.vars.searchSummary = summary;

    // Update search history
    const searchHistory = (chatState.vars.searchHistory as any[]) || [];
    searchHistory.push({
      query,
      timestamp: new Date(),
      resultCount: limitedResults.length,
      totalHits,
      executionTime,
      indices: successfulIndices
    });
    chatState.vars.searchHistory = searchHistory.slice(-50); // Keep last 50 searches

    const output = formatSearchResults(limitedResults, metadata, format);

    context.info(`Search completed`, {
      query,
      resultCount: limitedResults.length,
      totalHits,
      executionTime,
      indices: successfulIndices
    }, "SearchMacro");

    return {
      success: true,
      data: output,
      tool: 'searchContent',
      params: params,
      format: format,
      instructions: `
## Search Results Summary

Successfully searched for: **"${query}"**

### Results Overview:
- **Total Results Found**: ${totalHits}
- **Results Returned**: ${limitedResults.length}
- **Execution Time**: ${executionTime}ms
- **Indices Searched**: ${successfulIndices.join(', ')}
- **Top Score**: ${metadata.maxScore.toFixed(2)}

### Search Analysis:
- **Search Terms Identified**: ${summary.searchTerms.join(', ')}
- **Content Types Found**: ${summary.suggestedFilters.join(', ')}
- **More Results Available**: ${summary.hasMore ? 'Yes' : 'No'}

### State Variables Available:
- lastSearchResults: ${limitedResults.length} search results
- lastSearchQuery: "${query}"
- searchMetadata: Execution details and statistics
- searchSummary: Result analysis and suggestions
- searchHistory: Updated with this search

${limitedResults.length === 0 ? 
  '**Note**: No results found. Consider broadening your search terms or checking spelling.' :
  `**Top Result**: ${limitedResults[0].source.title || limitedResults[0].id} (Score: ${limitedResults[0].score.toFixed(2)})`
}
      `
    };

  } catch (error) {
    context.error("Error performing search", { error, params }, "SearchMacro");
    
    return {
      success: false,
      error: `Search failed: ${error?.message || "Unknown error"}`,
      tool: 'searchContent',
      params: params
    };
  }
};

// ==================== INDEX CONTENT MACRO ====================

const IndexContentMacro = async (
  params: IndexContentParams,
  chatState: ChatState,
) => {
  const { context } = chatState;
  const {
    index,
    documents,
    idField = 'id',
    replaceExisting = true,
    format = "json",
  } = params;

  if (!index || index.trim().length === 0) {
    return {
      success: false,
      error: "Index name is required and cannot be empty.",
      tool: 'indexContent',
      params: params
    };
  }

  if (!documents || !Array.isArray(documents) || documents.length === 0) {
    return {
      success: false,
      error: "Documents array is required and cannot be empty.",
      tool: 'indexContent',
      params: params
    };
  }

  const { service: searchService, error } = validateSearchService(context, 'indexContent', params);
  if (error) return error;

  try {
    context.debug("Starting IndexContentMacro execution", { 
      index, 
      documentCount: documents.length,
      idField,
      replaceExisting 
    }, "SearchMacro");

    const startTime = Date.now();

    // Validate documents have required ID field
    const invalidDocs = documents.filter(doc => !doc[idField]);
    if (invalidDocs.length > 0) {
      return {
        success: false,
        error: `${invalidDocs.length} documents missing required ID field '${idField}'`,
        tool: 'indexContent',
        params: params
      };
    }

    // Index the documents
    const indexResult = await searchService.index(index, documents);
    const executionTime = Date.now() - startTime;

    const operation: IndexOperation = {
      indexId: indexResult.id || index,
      status: indexResult.success ? "completed" : "failed",
      documentsAdded: indexResult.success ? documents.length : 0,
      documentsUpdated: 0, // MeiliSearch doesn't distinguish between add/update
      documentsFailed: indexResult.success ? 0 : documents.length,
      errors: indexResult.error ? [indexResult.error] : undefined
    };

    // Store in chat state for AI reference
    chatState.vars.lastIndexOperation = operation;
    chatState.vars.indexedDocuments = {
      count: documents.length,
      index,
      timestamp: new Date(),
      success: indexResult.success
    };

    let output;
    switch (format) {
      case "markdown":
        output = `
# Indexing Operation Complete

**Index**: ${index}
**Status**: ${operation.status}
**Documents Processed**: ${documents.length}
**Success**: ${indexResult.success ? 'Yes' : 'No'}
**Execution Time**: ${executionTime}ms

${operation.errors ? `## Errors\n${operation.errors.map(e => `- ${e}`).join('\n')}` : ''}
        `;
        break;
      case "summary":
        output = {
          summary: {
            index,
            status: operation.status,
            documentsProcessed: documents.length,
            success: indexResult.success,
            executionTime
          },
          operation
        };
        break;
      default: // json and detailed
        output = {
          indexedCount: operation.documentsAdded,
          failedCount: operation.documentsFailed,
          indexId: operation.indexId,
          operation,
          executionTime,
          success: indexResult.success
        };
    }

    context.info(`Indexing operation completed`, {
      index,
      documentCount: documents.length,
      success: indexResult.success,
      executionTime
    }, "SearchMacro");

    return {
      success: indexResult.success,
      data: output,
      tool: 'indexContent',
      params: params,
      format: format,
      instructions: `
## Indexing Operation Summary

Successfully indexed content in: **"${index}"**

### Operation Details:
- **Documents Processed**: ${documents.length}
- **Operation Status**: ${operation.status}
- **Execution Time**: ${executionTime}ms
- **Index ID**: ${operation.indexId}

### Results:
- **Documents Added**: ${operation.documentsAdded}
- **Documents Failed**: ${operation.documentsFailed}
- **Overall Success**: ${indexResult.success ? 'Yes' : 'No'}

### State Variables Available:
- lastIndexOperation: Complete operation details
- indexedDocuments: Document count and metadata

${indexResult.success ? 
  `**Success**: All ${documents.length} documents have been indexed and are now searchable.` :
  `**Error**: Indexing failed. Check error details: ${indexResult.error || 'Unknown error'}`
}
      `
    };

  } catch (error) {
    context.error("Error indexing content", { error, params }, "SearchMacro");
    
    return {
      success: false,
      error: `Indexing failed: ${error?.message || "Unknown error"}`,
      tool: 'indexContent',
      params: params
    };
  }
};

// ==================== DELETE INDEX MACRO ====================

const DeleteIndexMacro = async (
  params: DeleteIndexParams,
  chatState: ChatState,
) => {
  const { context } = chatState;
  const { index, confirm, format = "json" } = params;

  if (!index || index.trim().length === 0) {
    return {
      success: false,
      error: "Index name is required and cannot be empty.",
      tool: 'deleteIndex',
      params: params
    };
  }

  if (!confirm) {
    return {
      success: false,
      error: "Confirmation required. Set confirm: true to delete the index.",
      tool: 'deleteIndex',
      params: params
    };
  }

  const { service: searchService, error } = validateSearchService(context, 'deleteIndex', params);
  if (error) return error;

  try {
    context.debug("Starting DeleteIndexMacro execution", { index }, "SearchMacro");

    const startTime = Date.now();
    const deleteResult = await searchService.deleteIndex(index);
    const executionTime = Date.now() - startTime;

    // Store in chat state for AI reference
    chatState.vars.lastDeletedIndex = {
      index,
      timestamp: new Date(),
      success: deleteResult,
      executionTime
    };

    let output;
    switch (format) {
      case "markdown":
        output = `
# Index Deletion ${deleteResult ? 'Successful' : 'Failed'}

**Index**: ${index}
**Status**: ${deleteResult ? 'Deleted' : 'Failed'}
**Execution Time**: ${executionTime}ms
        `;
        break;
      case "summary":
        output = {
          summary: {
            index,
            deleted: deleteResult,
            executionTime
          }
        };
        break;
      default: // json
        output = {
          index,
          deleted: deleteResult,
          executionTime,
          timestamp: new Date()
        };
    }

    context.info(`Index deletion ${deleteResult ? 'completed' : 'failed'}`, {
      index,
      success: deleteResult,
      executionTime
    }, "SearchMacro");

    return {
      success: deleteResult,
      data: output,
      tool: 'deleteIndex',
      params: params,
      format: format,
      instructions: `
## Index Deletion Summary

${deleteResult ? 'Successfully deleted' : 'Failed to delete'} index: **"${index}"**

### Operation Details:
- **Index Name**: ${index}
- **Deletion Status**: ${deleteResult ? 'Success' : 'Failed'}
- **Execution Time**: ${executionTime}ms

### State Variables Available:
- lastDeletedIndex: Deletion operation details

${deleteResult ? 
  `**Warning**: Index "${index}" and all its documents have been permanently deleted.` :
  `**Error**: Failed to delete index "${index}". The index may not exist or there may be a service issue.`
}
      `
    };

  } catch (error) {
    context.error("Error deleting index", { error, params }, "SearchMacro");
    
    return {
      success: false,
      error: `Index deletion failed: ${error?.message || "Unknown error"}`,
      tool: 'deleteIndex',
      params: params
    };
  }
};

// ==================== MACRO DEFINITIONS ====================

const SearchContentMacroDefinition: MacroComponentDefinition<typeof SearchContentMacro> = {
  name: "SearchContent",
  nameSpace: "reactory-reactor",
  description: "Performs full-text search across one or more indices with advanced filtering and pagination. Supports educational content discovery for the BookTutor AI agent.",
  component: SearchContentMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "searchContent",
  icon: "search",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "search",
        name: "searchContent",
        description: "Performs full-text search across indexed content with highlighting, pagination, and multi-format output.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query string. Use natural language or specific terms.",
            },
            index: {
              type: "string",
              description: "Specific index to search. If not provided, searches common indices.",
            },
            indices: {
              type: "array",
              items: { type: "string" },
              description: "Multiple indices to search across for broader results.",
            },
            fields: {
              type: "array",
              items: { type: "string" },
              description: "Specific fields to search within (e.g., ['title', 'content']).",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return.",
              default: 10,
              minimum: 1,
              maximum: 1000
            },
            offset: {
              type: "number",
              description: "Number of results to skip for pagination.",
              default: 0,
              minimum: 0
            },
            highlight: {
              type: "boolean",
              description: "Whether to include highlighting in search results.",
              default: true
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary", "detailed"],
              description: "Output format for search results.",
              default: "json"
            }
          },
          required: ["query"],
        },
      },
    },
  ],
};

const IndexContentMacroDefinition: MacroComponentDefinition<typeof IndexContentMacro> = {
  name: "IndexContent",
  nameSpace: "reactory-reactor",
  description: "Adds documents to a search index for future searching. Supports batch operations and educational content indexing.",
  component: IndexContentMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "indexContent",
  icon: "cloud_upload",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "cloud_upload",
        name: "indexContent",
        description: "Indexes documents for searching. Validates document structure and provides detailed operation feedback.",
        parameters: {
          type: "object",
          properties: {
            index: {
              type: "string",
              description: "The search index name where documents will be stored.",
            },
            documents: {
              type: "array",
              items: { type: "object" },
              description: "Array of documents to index. Each must have an ID field.",
            },
            idField: {
              type: "string",
              description: "Field name to use as document ID.",
              default: "id"
            },
            replaceExisting: {
              type: "boolean",
              description: "Whether to replace existing documents with same ID.",
              default: true
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format for indexing results.",
              default: "json"
            }
          },
          required: ["index", "documents"],
        },
      },
    },
  ],
};

const DeleteIndexMacroDefinition: MacroComponentDefinition<typeof DeleteIndexMacro> = {
  name: "DeleteIndex",
  nameSpace: "reactory-reactor",
  description: "Deletes a search index and all its documents. Requires explicit confirmation to prevent accidental deletion.",
  component: DeleteIndexMacro,
  version: "1.0.0",
  roles: ["USER"],
  alias: "deleteIndex",
  icon: "delete_forever",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      function: {
        icon: "delete_forever",
        name: "deleteIndex",
        description: "Permanently deletes a search index and all its documents. Requires confirmation.",
        parameters: {
          type: "object",
          properties: {
            index: {
              type: "string",
              description: "The search index name to delete.",
            },
            confirm: {
              type: "boolean",
              description: "Confirmation flag. Must be true to proceed with deletion.",
            },
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format for deletion results.",
              default: "json"
            }
          },
          required: ["index", "confirm"],
        },
      },
    },
  ],
};

// Export all macro definitions
export default [
  SearchContentMacroDefinition,
  IndexContentMacroDefinition,
  DeleteIndexMacroDefinition
];