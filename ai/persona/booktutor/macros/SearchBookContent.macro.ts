import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import fs from 'fs';
import path from 'path';

export type SearchBookContentParams = {
  query: string;
  bookId?: string;
  chapterFilter?: string;
  contentType?: 'text' | 'definition' | 'example' | 'exercise' | 'all';
  limit?: number;
  format?: 'json' | 'markdown' | 'summary';
}

export interface BookContentResult {
  bookId: string;
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  contentType: string;
  snippet: string;
  context: string;
  relevanceScore: number;
  pageReference?: string;
  matchedTerms: string[];
}

export interface BookContentSearchMetadata {
  query: string;
  booksSearched: number;
  chaptersSearched: number;
  totalMatches: number;
  searchTime: number;
  contentTypeFilter?: string;
}

const SearchBookContentMacro = async (
  params: SearchBookContentParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    query,
    bookId,
    chapterFilter,
    contentType = 'all',
    limit = 20,
    format = 'json',
  } = params;

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: "Search query is required and cannot be empty.",
      tool: 'search_book_content',
      params: params
    };
  }

  const startTime = Date.now();

  try {
    context.debug("Starting SearchBookContentMacro execution", { params }, "SearchBookContentMacro");
    
    // Get the BookTutor data root from environment
    const APP_DATA_ROOT = process.env.APP_DATA_ROOT || process.env.REACTORY_DATA;
    const BOOKTUTOR_DATA_ROOT = path.join(APP_DATA_ROOT, 'guideai/booktutor');
    const catalogPath = path.join(BOOKTUTOR_DATA_ROOT, 'library/catalog.json');
    const libraryPath = path.join(BOOKTUTOR_DATA_ROOT, 'library');

    // Check if catalog file exists
    if (!fs.existsSync(catalogPath)) {
      return {
        success: false,
        error: "Book catalog not found. Please ensure books are cataloged first.",
        tool: 'search_book_content',
        params: params
      };
    }

    // Read and parse catalog
    const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
    const catalog = JSON.parse(catalogContent);
    
    if (!catalog.books || !Array.isArray(catalog.books)) {
      return {
        success: false,
        error: "Invalid catalog format: books array not found",
        tool: 'search_book_content',
        params: params
      };
    }

    // Filter books to search
    let booksToSearch = catalog.books;
    if (bookId) {
      booksToSearch = catalog.books.filter((book: any) => book.id === bookId);
      if (booksToSearch.length === 0) {
        return {
          success: false,
          error: `Book with ID "${bookId}" not found in catalog.`,
          tool: 'search_book_content',
          params: params
        };
      }
    }

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 2);
    
    let allResults: BookContentResult[] = [];
    let booksSearched = 0;
    let chaptersSearched = 0;

    // Search through each book
    for (const book of booksToSearch) {
      booksSearched++;
      
      // Filter chapters if specified
      let chaptersToSearch = book.chapters || [];
      if (chapterFilter) {
        const filterLower = chapterFilter.toLowerCase();
        chaptersToSearch = chaptersToSearch.filter((chapter: any) => 
          chapter.title.toLowerCase().includes(filterLower) ||
          chapter.number.toString() === chapterFilter
        );
      }

      // Search through each chapter
      for (const chapter of chaptersToSearch) {
        chaptersSearched++;
        
        try {
          // Construct chapter file path
          const chapterFileName = `chapter-${chapter.number.toString().padStart(2, '0')}.md`;
          const bookDir = path.join(libraryPath, book.id);
          const chapterPath = path.join(bookDir, chapterFileName);

          if (!fs.existsSync(chapterPath)) {
            context.debug(`Chapter file not found: ${chapterPath}`, {}, "SearchBookContentMacro");
            continue;
          }

          // Read chapter content
          const chapterContent = fs.readFileSync(chapterPath, 'utf-8');
          
          // Search for content based on type and query
          const matches = searchInChapterContent(
            chapterContent, 
            queryTerms, 
            contentType,
            book,
            chapter
          );

          allResults.push(...matches);

        } catch (error) {
          context.warn(`Error reading chapter ${chapter.number} of book ${book.id}`, { error: error.message }, "SearchBookContentMacro");
          continue;
        }
      }
    }

    // Sort results by relevance score (highest first)
    allResults.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    // Apply limit
    const limitedResults = allResults.slice(0, limit);

    const searchTime = Date.now() - startTime;

    // Create metadata
    const metadata: BookContentSearchMetadata = {
      query,
      booksSearched,
      chaptersSearched,
      totalMatches: allResults.length,
      searchTime,
      contentTypeFilter: contentType !== 'all' ? contentType : undefined
    };

    // Format results based on requested format
    let formattedResults: any;
    
    switch (format) {
      case 'markdown':
        formattedResults = formatContentAsMarkdown(limitedResults, metadata);
        break;
      
      case 'summary':
        formattedResults = formatContentAsSummary(limitedResults, metadata);
        break;
      
      case 'json':
      default:
        formattedResults = limitedResults;
        break;
    }

    context.debug("Content search completed successfully", { 
      totalMatches: allResults.length,
      returned: limitedResults.length,
      booksSearched,
      chaptersSearched,
      searchTime
    }, "SearchBookContentMacro");

    return {
      success: true,
      results: formattedResults,
      metadata,
      tool: 'search_book_content',
      params: params
    };

  } catch (error) {
    context.error("Error in SearchBookContentMacro", { error: error.message, params }, "SearchBookContentMacro");
    return {
      success: false,
      error: `Failed to search book content: ${error.message}`,
      tool: 'search_book_content',
      params: params
    };
  }
};

// Helper function to search within chapter content
function searchInChapterContent(
  content: string, 
  queryTerms: string[], 
  contentType: string,
  book: any,
  chapter: any
): BookContentResult[] {
  const results: BookContentResult[] = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    
    // Skip if content type filter doesn't match
    if (contentType !== 'all' && !matchesContentType(line, contentType)) {
      continue;
    }
    
    // Check if line contains any query terms
    const matchedTerms: string[] = [];
    let relevanceScore = 0;
    
    for (const term of queryTerms) {
      if (lineLower.includes(term)) {
        matchedTerms.push(term);
        relevanceScore += 1;
        
        // Boost score for exact matches
        if (lineLower === term) {
          relevanceScore += 2;
        }
        
        // Boost score for word boundaries
        const wordBoundaryRegex = new RegExp(`\\b${term}\\b`, 'i');
        if (wordBoundaryRegex.test(line)) {
          relevanceScore += 1;
        }
      }
    }
    
    if (matchedTerms.length > 0) {
      // Get context around the match
      const contextStart = Math.max(0, i - 2);
      const contextEnd = Math.min(lines.length, i + 3);
      const context = lines.slice(contextStart, contextEnd).join('\n');
      
      // Determine content type
      const detectedContentType = detectContentType(line);
      
      results.push({
        bookId: book.id,
        bookTitle: book.title,
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        contentType: detectedContentType,
        snippet: line.trim(),
        context: context.trim(),
        relevanceScore,
        matchedTerms,
        pageReference: `Chapter ${chapter.number}, Line ${i + 1}`
      });
    }
  }
  
  return results;
}

// Helper function to check if content matches type filter
function matchesContentType(line: string, contentType: string): boolean {
  switch (contentType) {
    case 'definition':
      return /^[\*\-\#].*?:/ .test(line.trim()) || 
             /definition|defined as|refers to|means/i.test(line);
    
    case 'example':
      return /example|for instance|such as|e\.g\.|like/i.test(line);
    
    case 'exercise':
      return /exercise|practice|problem|question|solve|calculate/i.test(line) ||
             /^\d+\./.test(line.trim());
    
    case 'text':
    case 'all':
    default:
      return true;
  }
}

// Helper function to detect content type
function detectContentType(line: string): string {
  if (/^[\*\-\#].*?:/.test(line.trim()) || /definition|defined as|refers to|means/i.test(line)) {
    return 'definition';
  }
  if (/example|for instance|such as|e\.g\.|like/i.test(line)) {
    return 'example';
  }
  if (/exercise|practice|problem|question|solve|calculate/i.test(line) || /^\d+\./.test(line.trim())) {
    return 'exercise';
  }
  return 'text';
}

// Helper function to format results as markdown
function formatContentAsMarkdown(results: BookContentResult[], metadata: BookContentSearchMetadata): string {
  if (results.length === 0) {
    return `# Content Search Results\n\nNo content found for "${metadata.query}"`;
  }

  let markdown = `# Book Content Search Results\n\n`;
  markdown += `**Query:** "${metadata.query}"\n`;
  markdown += `**Results:** ${results.length} matches found (searched ${metadata.booksSearched} books, ${metadata.chaptersSearched} chapters)\n`;
  markdown += `**Search Time:** ${metadata.searchTime}ms\n\n`;

  results.forEach((result, index) => {
    markdown += `## ${index + 1}. ${result.bookTitle} - ${result.chapterTitle}\n\n`;
    markdown += `- **Content Type:** ${result.contentType}\n`;
    markdown += `- **Relevance Score:** ${result.relevanceScore}\n`;
    markdown += `- **Reference:** ${result.pageReference}\n`;
    markdown += `- **Matched Terms:** ${result.matchedTerms.join(', ')}\n\n`;
    
    markdown += `### Content Snippet:\n`;
    markdown += `> ${result.snippet}\n\n`;
    
    if (result.context !== result.snippet) {
      markdown += `### Context:\n`;
      markdown += '```\n';
      markdown += result.context;
      markdown += '\n```\n\n';
    }
  });

  return markdown;
}

// Helper function to format results as summary
function formatContentAsSummary(results: BookContentResult[], metadata: BookContentSearchMetadata): any {
  const bookCounts = results.reduce((acc, result) => {
    acc[result.bookId] = (acc[result.bookId] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const contentTypeCounts = results.reduce((acc, result) => {
    acc[result.contentType] = (acc[result.contentType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    searchSummary: {
      ...metadata,
      bookMatches: Object.keys(bookCounts).length,
      contentTypeDistribution: contentTypeCounts
    },
    topResults: results.slice(0, 5).map(result => ({
      bookTitle: result.bookTitle,
      chapterTitle: result.chapterTitle,
      contentType: result.contentType,
      snippet: result.snippet.substring(0, 100) + (result.snippet.length > 100 ? '...' : ''),
      relevanceScore: result.relevanceScore,
      matchedTerms: result.matchedTerms
    })),
    bookDistribution: bookCounts
  };
}

// Macro definition for the registry
export const SearchBookContentMacroDefinition: MacroComponentDefinition<any> = {
  component: SearchBookContentMacro,
  name: 'search_book_content',
  nameSpace: 'booktutor',
  version: '1.0.0',
  description: 'Search within book pages and chapters for specific content',
  features: [],
  roles: ['USER', 'DEVELOPER', 'ADMIN'],
  stem: 'search',
  runat: 'server',
  tags: ['macro', 'book', 'search', 'content', 'booktutor'],
  tools: [{
    type: 'function',
    runat: 'server',
    function: {
      name: 'search_book_content',
      
      description: 'Search for specific content within books and chapters. This tool allows you to find text, definitions, examples, or exercises within the actual content of books.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Content to search for - keywords, phrases, or concepts within book text'
          },
          bookId: {
            type: 'string',
            description: 'Specific book ID to search within (optional). If not provided, searches all books.'
          },
          chapterFilter: {
            type: 'string',
            description: 'Filter by chapter name or number (optional). Can be chapter title or chapter number.'
          },
          contentType: {
            type: 'string',
            enum: ['text', 'definition', 'example', 'exercise', 'all'],
            description: 'Type of content to search for: text (general content), definition (definitions and explanations), example (examples and illustrations), exercise (practice problems), all (any content type)',
            default: 'all'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 20)',
            default: 20,
            minimum: 1,
            maximum: 100
          },
          format: {
            type: 'string',
            enum: ['json', 'markdown', 'summary'],
            description: 'Output format: json (detailed data), markdown (readable format), summary (overview with distribution)',
            default: 'json'
          }
        },
        required: ['query']
      }
    }
  }]
};

export default SearchBookContentMacroDefinition;
