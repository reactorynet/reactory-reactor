import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { extractSearchTerms, analyzeSearchResults, createSearchSummaryMarkdown } from "./utils";

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
  /**
   * When true, returns each result's full indexed `source` document instead of a
   * truncated preview. Off by default — full documents (e.g. entire book chapters)
   * are a major context-bloat risk and should be an explicit, deliberate opt-in
   * combined with a small `limit`.
   */
  includeFullContent?: boolean;
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

/**
 * Character budget applied to any long string field on a result's `source`
 * document (e.g. `content`, `description`, `summary`) when `includeFullContent`
 * is not explicitly requested. Keeps searchContent's default payload small
 * regardless of output format, instead of relying solely on the downstream
 * ToolResultProcessor guard to catch it after the fact.
 */
const SOURCE_FIELD_PREVIEW_LENGTH = 400;

/**
 * Returns a shallow copy of a result's `source` document with any long string
 * field truncated to a preview. Short fields (titles, ids, tags, etc.) pass
 * through untouched. Never mutates the original document.
 */
function curateSourceDocument(source: Record<string, any>): Record<string, any> {
  if (!source || typeof source !== 'object') return source;
  const curated: Record<string, any> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.length > SOURCE_FIELD_PREVIEW_LENGTH) {
      curated[key] = `${value.substring(0, SOURCE_FIELD_PREVIEW_LENGTH)}...`;
      curated[`${key}FullLength`] = value.length;
    } else {
      curated[key] = value;
    }
  }
  return curated;
}

/**
 * Applies content curation to a full result set. When `includeFullContent` is
 * true the results are returned unmodified (explicit caller opt-in); otherwise
 * every result's `source` is passed through `curateSourceDocument`.
 */
function curateResults(results: SearchResult[], includeFullContent: boolean): SearchResult[] {
  if (includeFullContent) return results;
  return results.map(r => ({ ...r, source: curateSourceDocument(r.source) }));
}

function formatSearchResults(results: any[], metadata: any, format: OutputFormat): any {
  switch (format) {
    case "markdown":
      // Delegates to the richer, previously-unused createSearchSummaryMarkdown /
      // analyzeSearchResults helpers in ./utils instead of the ad-hoc inline
      // template that used to live here. Adds score-distribution, content-type,
      // subject and difficulty breakdowns on top of the original per-result
      // preview list, with no extra bloat risk since `results` at this point
      // has already been curated (curateResults) upstream in SearchContentMacro.
      return createSearchSummaryMarkdown(metadata.query, results, metadata, analyzeSearchResults(results));

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
      
    case "detailed": {
      // Extends the original analysis shape with the richer breakdown from
      // analyzeSearchResults (score distribution, subjects, difficulty levels).
      // Original fields (averageScore, indicesUsed, hasHighlights, contentTypes)
      // are preserved as-is for back-compat — analyzeSearchResults' own
      // `contentTypes` (a count map, not a string array) is exposed separately
      // as `contentTypeCounts` to avoid silently changing an existing field's
      // shape under callers that already parse `contentTypes` as a string[].
      const richAnalysis = analyzeSearchResults(results);
      return {
        metadata,
        results: results,
        analysis: {
          averageScore: richAnalysis.averageScore,
          indicesUsed: [...new Set(results.map(r => r.index))],
          hasHighlights: results.some(r => r.highlights),
          contentTypes: [...new Set(results.map(r => r.source.type || 'unknown'))],
          scoreDistribution: richAnalysis.scoreDistribution,
          contentTypeCounts: richAnalysis.contentTypes,
          subjects: richAnalysis.subjects,
          difficultyLevels: richAnalysis.difficultyLevels
        }
      };
    }
      
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

// Note: extractSearchTerms now imported from ./utils (was previously duplicated
// here with an identical, weaker implementation — see also analyzeSearchResults /
// createSearchSummaryMarkdown in ./utils for additional curation helpers available
// to this macro but not yet wired in).

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
    includeFullContent = false,
  } = params;

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: "Search query is required and cannot be empty.",
      tool: 'searchContent',
      params: params
    };
  }

  chatState.vars = chatState.vars || {};

  const { service: searchService, error } = validateSearchService(context, 'searchContent', params);
  if (error) return error;

  try {
    context.debug("Starting SearchContentMacro execution", { params }, "SearchMacro");
    
    const startTime = Date.now();
    
    // Determine which indices to search: explicit args win; otherwise the
    // persona's configured defaults. There is NO global fallback — guessing an
    // index silently misroutes every non-book agent (Providers Session 08).
    const personaDefaults = ((chatState as any)?.persona?.config?.defaultSearchIndexes ||
      []) as string[];
    const searchIndices =
      indices || (index ? [index] : personaDefaults.length > 0 ? personaDefaults : null);
    if (!searchIndices || searchIndices.length === 0) {
      return {
        success: false,
        error:
          "No search index specified and this persona defines no default indexes.",
        tool: 'searchContent',
        params,
        instructions: `
## No search index specified

searchContent needs to know WHICH index to search. Do not guess index names.

### How to proceed:
1. Call \`listSearchIndexes\` to discover the indexes you may search (each entry carries a description and document count).
2. Re-run \`searchContent(query, indices: [...])\` with the relevant index name(s).
3. For project content, \`searchProject(projectName, query)\` resolves the index for you (project indexes follow the convention \`reactor_graph_<nameSpace>_<name>\`).
        `,
      };
    }
    
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
    const limitedResultsRaw = allResults.slice(0, limit);
    // Curate full documents down to previews by default — raw indexed documents
    // (e.g. full book chapters) are a major context-bloat risk regardless of
    // output `format`; callers must explicitly opt in via includeFullContent.
    const limitedResults = curateResults(limitedResultsRaw, includeFullContent);

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

/**
 * Input-side sanity caps for indexContent. ToolResultProcessor guards the
 * *response* side of every macro, but indexContent's bloat risk is on the
 * *request* side — a caller can hand it an arbitrarily large `documents`
 * array and there is nothing downstream to catch that before it's stringified
 * into the tool-call payload and, separately, forwarded to the search engine.
 * These are hard validation errors (not silent truncation) so callers always
 * know to split into smaller batches rather than unknowingly indexing a
 * partial/inconsistent set of documents.
 */
const MAX_INDEX_DOCUMENTS_PER_CALL = 500;
/** Combined character budget for `JSON.stringify(documents)` in a single call (~5MB of text). */
const MAX_INDEX_INPUT_CHARACTERS = 5_000_000;

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

  if (documents.length > MAX_INDEX_DOCUMENTS_PER_CALL) {
    return {
      success: false,
      error: `Too many documents in a single indexContent call (${documents.length} > ${MAX_INDEX_DOCUMENTS_PER_CALL}).`,
      tool: 'indexContent',
      params: params,
      instructions: `## Index Content — Batch Too Large\n\nSplit **${documents.length}** documents into multiple calls of ${MAX_INDEX_DOCUMENTS_PER_CALL} or fewer.\n\n### Recovery Options:\n- Chunk the documents array client-side and call `+'`indexContent`'+` once per chunk.\n- Use \`getIndexStats\` afterwards to confirm the running document count.`
    };
  }

  let totalInputCharacters = 0;
  try {
    totalInputCharacters = JSON.stringify(documents).length;
  } catch {
    // Unserializable input (e.g. circular references) — let the downstream
    // search service surface the real error rather than guessing a size here.
    totalInputCharacters = 0;
  }
  if (totalInputCharacters > MAX_INDEX_INPUT_CHARACTERS) {
    return {
      success: false,
      error: `Combined document payload is too large (${totalInputCharacters} characters > ${MAX_INDEX_INPUT_CHARACTERS}).`,
      tool: 'indexContent',
      params: params,
      instructions: `## Index Content — Payload Too Large\n\nThe combined size of **${documents.length}** documents is ${totalInputCharacters} characters, exceeding the ${MAX_INDEX_INPUT_CHARACTERS}-character limit for a single call.\n\n### Recovery Options:\n- Split into smaller batches (fewer documents per call).\n- Reduce individual document size (e.g. store large fields in a supporting index and reference them by id rather than inlining full text).`
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

    // Ensure vars object exists on chatState
    chatState.vars = chatState.vars || {};


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

    chatState.vars = chatState.vars || {};

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
  nameSpace: "reactor-macros",
  alias: "searchContent",
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
      safeForAutoExecution: true,
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
              description:
                "Specific index to search. Discover names with listSearchIndexes; project indexes follow reactor_graph_<nameSpace>_<name>. Without an index (and no persona default) the call returns guidance instead of results.",
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
              description: "Maximum number of results to return. Kept small by design — large limits combined with full document content risk severe context bloat; use includeFullContent sparingly and only with a low limit.",
              default: 10,
              minimum: 1,
              maximum: 100
            },
            includeFullContent: {
              type: "boolean",
              description: "Return each result's full indexed source document instead of a ~400-character preview. Off by default. Only enable this for a small number of results (low limit) when the full document content is genuinely required — otherwise responses can become extremely large.",
              default: false
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
              description: "Output format for search results. 'markdown' and 'detailed' include a richer analysis (score distribution, content types, subjects, difficulty levels) via the shared search-results analyzer.",
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
  nameSpace: "reactor-macros",
  alias: "indexContent",
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
              description: "Array of documents to index. Each must have an ID field. Capped at 500 documents and ~5,000,000 combined characters per call — split larger batches into multiple calls.",
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
  nameSpace: "reactor-macros",
  alias: "deleteIndex",
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

// ==================== LIST SEARCH INDEXES MACRO ====================

const SYSTEM_GRAPH_SERVICE = "reactor.SystemGraphManager@1.0.0";

const ListSearchIndexesMacro = async (
  params: { format?: OutputFormat },
  chatState: ChatState,
) => {
  const { context } = chatState;
  try {
    const graphSvc: any = context.getService(SYSTEM_GRAPH_SERVICE);
    if (!graphSvc?.getSearchIndexCatalog) {
      return {
        success: false,
        error: `${SYSTEM_GRAPH_SERVICE} is not available or does not expose the search index catalog`,
        tool: 'listSearchIndexes',
        params,
      };
    }
    const catalog = await graphSvc.getSearchIndexCatalog({});
    const rows = catalog.map((entry: any) => ({
      index: entry.index,
      kind: entry.kind,
      title: entry.title,
      description: entry.description,
      documentCount: entry.documentCount,
      exists: entry.exists,
      lastSync: entry.lastSync,
    }));
    chatState.vars = chatState.vars || {};
    chatState.vars.searchIndexCatalog = rows;
    return {
      success: true,
      data: rows,
      tool: 'listSearchIndexes',
      params,
      instructions: `
## Searchable Indexes (${rows.length})

${rows
  .slice(0, 50)
  .map(
    (r: any) =>
      `- **${r.index}**${r.documentCount !== undefined ? ` (${r.documentCount} docs)` : ''}${r.exists === false ? ' — not yet built' : ''}: ${r.description || r.title}`
  )
  .join('\n')}

### How to use:
- Search one or more with \`searchContent(query, indices: ["<index>"])\`.
- Project indexes follow \`reactor_graph_<nameSpace>_<name>\`; \`searchProject(projectName, query)\` resolves them for you.
- Never guess index names — this catalog is the source of truth.
      `,
    };
  } catch (error) {
    context.error("listSearchIndexes failed", { error }, "SearchMacro");
    return {
      success: false,
      error: `listSearchIndexes failed: ${error?.message || 'Unknown error'}`,
      tool: 'listSearchIndexes',
      params,
    };
  }
};

const ListSearchIndexesMacroDefinition: MacroComponentDefinition<typeof ListSearchIndexesMacro> = {
  name: "ListSearchIndexes",
  nameSpace: "reactor-macros",
  alias: "listSearchIndexes",
  description:
    "Lists the search indexes the caller may query — curated, tenant-safe catalog with per-index descriptions and document counts. Use before searchContent when the index is unknown.",
  component: ListSearchIndexesMacro,
  version: "1.0.0",
  roles: ["USER"],
  icon: "manage_search",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "manage_search",
        name: "listSearchIndexes",
        description:
          "Discover which search indexes exist and what they contain. Call this before searchContent when you do not know the index name.",
        parameters: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["json", "markdown", "summary"],
              description: "Output format.",
              default: "json",
            },
          },
        },
      },
    },
  ],
};

// ==================== GET INDEX STATS MACRO ====================

const GetIndexStatsMacro = async (
  params: GetIndexStatsParams,
  chatState: ChatState,
) => {
  const { context } = chatState;
  const { service: searchService, error } = validateSearchService(context, 'getIndexStats', params);
  if (error) return error;
  try {
    if (params.index) {
      const anySearch: any = searchService;
      const stats =
        typeof anySearch.getIndexStats === 'function'
          ? await anySearch.getIndexStats(params.index)
          : { name: params.index, exists: true, documentCount: await anySearch.count?.(params.index) };
      return { success: true, data: stats, tool: 'getIndexStats', params };
    }
    // No index → stats for the whole catalog.
    const graphSvc: any = context.getService(SYSTEM_GRAPH_SERVICE);
    const catalog = (await graphSvc?.getSearchIndexCatalog?.({})) || [];
    return {
      success: true,
      data: catalog,
      tool: 'getIndexStats',
      params,
      instructions: `Returned stats for ${catalog.length} catalogued index(es). Pass \`index\` for a single index.`,
    };
  } catch (err) {
    return {
      success: false,
      error: `getIndexStats failed: ${(err as Error)?.message || 'Unknown error'}`,
      tool: 'getIndexStats',
      params,
    };
  }
};

const GetIndexStatsMacroDefinition: MacroComponentDefinition<typeof GetIndexStatsMacro> = {
  name: "GetIndexStats",
  nameSpace: "reactor-macros",
  alias: "getIndexStats",
  description: "Returns existence and document-count statistics for one search index, or for the whole catalog.",
  component: GetIndexStatsMacro,
  version: "1.0.0",
  roles: ["USER"],
  icon: "query_stats",
  runat: "server",
  tools: [
    {
      type: "function",
      roles: ["USER"],
      safeForAutoExecution: true,
      function: {
        icon: "query_stats",
        name: "getIndexStats",
        description: "Get document count / existence stats for a search index (or all catalogued indexes when omitted).",
        parameters: {
          type: "object",
          properties: {
            index: { type: "string", description: "Index name (optional)." },
            format: { type: "string", enum: ["json", "markdown", "summary"], default: "json" },
          },
        },
      },
    },
  ],
};

// Export all macro definitions
export default [
  SearchContentMacroDefinition,
  IndexContentMacroDefinition,
  DeleteIndexMacroDefinition,
  ListSearchIndexesMacroDefinition,
  GetIndexStatsMacroDefinition,
];