import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import fs from 'fs';
import path from 'path';

export type SearchBookCatalogParams = {
  query: string;
  searchType?: 'title' | 'author' | 'subject' | 'keyword' | 'all';
  limit?: number;
  format?: 'json' | 'markdown' | 'summary';
}

export interface BookCatalogEntry {
  id: string;
  title: string;
  author: string;
  subject: string;
  description?: string;
  chapters: Array<{
    number: number;
    title: string;
    pages?: number;
  }>;
  metadata: {
    language: string;
    difficulty: 'beginner' | 'intermediate' | 'advanced';
    estimatedReadTime?: string;
    tags: string[];
  };
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

const SearchBookCatalogMacro = async (
  params: SearchBookCatalogParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    query,
    searchType = 'all',
    limit = 10,
    format = 'json',
  } = params;

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: "Search query is required and cannot be empty.",
      tool: 'search_book_catalog',
      params: params
    };
  }

  try {
    context.debug("Starting SearchBookCatalogMacro execution", { params }, "SearchBookCatalogMacro");
    
    // Get the BookTutor data root from environment
    const APP_DATA_ROOT = process.env.APP_DATA_ROOT || process.env.REACTORY_DATA;
    const BOOKTUTOR_DATA_ROOT = path.join(APP_DATA_ROOT, 'guideai/booktutor');
    const catalogPath = path.join(BOOKTUTOR_DATA_ROOT, 'library/catalog.json');

    // Check if catalog file exists
    if (!fs.existsSync(catalogPath)) {
      context.warn("Book catalog file not found, creating empty catalog", { catalogPath }, "SearchBookCatalogMacro");
      
      // Ensure directory exists
      const catalogDir = path.dirname(catalogPath);
      if (!fs.existsSync(catalogDir)) {
        fs.mkdirSync(catalogDir, { recursive: true });
      }
      
      // Create empty catalog
      const emptyCatalog = {
        version: "1.0.0",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalBooks: 0,
        books: [] as BookCatalogEntry[]
      };
      
      fs.writeFileSync(catalogPath, JSON.stringify(emptyCatalog, null, 2));
      
      return {
        success: true,
        results: [] as BookCatalogEntry[],
        metadata: {
          query,
          searchType,
          totalResults: 0,
          catalogStatus: "empty",
          message: "Catalog file was created but contains no books. Please add books to the library first."
        },
        tool: 'search_book_catalog',
        params: params
      };
    }

    // Read and parse catalog
    const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
    const catalog = JSON.parse(catalogContent);
    
    if (!catalog.books || !Array.isArray(catalog.books)) {
      context.error("Invalid catalog format: books array not found", { catalogPath }, "SearchBookCatalogMacro");
      return {
        success: false,
        error: "Invalid catalog format: books array not found",
        tool: 'search_book_catalog',
        params: params
      };
    }

    // Perform search based on searchType
    const queryLower = query.toLowerCase();
    let filteredBooks: BookCatalogEntry[] = [];

    switch (searchType) {
      case 'title':
        filteredBooks = catalog.books.filter((book: BookCatalogEntry) => 
          book.title.toLowerCase().includes(queryLower)
        );
        break;
      
      case 'author':
        filteredBooks = catalog.books.filter((book: BookCatalogEntry) => 
          book.author.toLowerCase().includes(queryLower)
        );
        break;
      
      case 'subject':
        filteredBooks = catalog.books.filter((book: BookCatalogEntry) => 
          book.subject.toLowerCase().includes(queryLower)
        );
        break;
      
      case 'keyword':
        filteredBooks = catalog.books.filter((book: BookCatalogEntry) => 
          book.metadata.tags.some(tag => tag.toLowerCase().includes(queryLower)) ||
          (book.description && book.description.toLowerCase().includes(queryLower))
        );
        break;
      
      case 'all':
      default:
        filteredBooks = catalog.books.filter((book: BookCatalogEntry) => 
          book.title.toLowerCase().includes(queryLower) ||
          book.author.toLowerCase().includes(queryLower) ||
          book.subject.toLowerCase().includes(queryLower) ||
          book.metadata.tags.some(tag => tag.toLowerCase().includes(queryLower)) ||
          (book.description && book.description.toLowerCase().includes(queryLower))
        );
        break;
    }

    // Apply limit
    const limitedResults = filteredBooks.slice(0, limit);

    // Format results based on requested format
    let formattedResults: any;
    
    switch (format) {
      case 'markdown':
        formattedResults = formatAsMarkdown(limitedResults, query, searchType);
        break;
      
      case 'summary':
        formattedResults = formatAsSummary(limitedResults, query, searchType);
        break;
      
      case 'json':
      default:
        formattedResults = limitedResults;
        break;
    }

    context.debug("Search completed successfully", { 
      totalFound: filteredBooks.length,
      returned: limitedResults.length,
      query,
      searchType 
    }, "SearchBookCatalogMacro");

    return {
      success: true,
      results: formattedResults,
      metadata: {
        query,
        searchType,
        totalResults: filteredBooks.length,
        returnedResults: limitedResults.length,
        hasMore: filteredBooks.length > limit,
        catalogVersion: catalog.version,
        lastUpdated: catalog.updatedAt
      },
      tool: 'search_book_catalog',
      params: params
    };

  } catch (error) {
    context.error("Error in SearchBookCatalogMacro", { error: error.message, params }, "SearchBookCatalogMacro");
    return {
      success: false,
      error: `Failed to search book catalog: ${error.message}`,
      tool: 'search_book_catalog',
      params: params
    };
  }
};

// Helper function to format results as markdown
function formatAsMarkdown(books: BookCatalogEntry[], query: string, searchType: string): string {
  if (books.length === 0) {
    return `# Search Results\n\nNo books found for "${query}" (search type: ${searchType})`;
  }

  let markdown = `# Book Catalog Search Results\n\n`;
  markdown += `**Query:** "${query}" (${searchType})\n`;
  markdown += `**Results:** ${books.length} book(s) found\n\n`;

  books.forEach((book, index) => {
    markdown += `## ${index + 1}. ${book.title}\n\n`;
    markdown += `- **Author:** ${book.author}\n`;
    markdown += `- **Subject:** ${book.subject}\n`;
    markdown += `- **Difficulty:** ${book.metadata.difficulty}\n`;
    markdown += `- **Language:** ${book.metadata.language}\n`;
    
    if (book.description) {
      markdown += `- **Description:** ${book.description}\n`;
    }
    
    if (book.metadata.estimatedReadTime) {
      markdown += `- **Estimated Read Time:** ${book.metadata.estimatedReadTime}\n`;
    }
    
    markdown += `- **Tags:** ${book.metadata.tags.join(', ')}\n`;
    markdown += `- **Chapters:** ${book.chapters.length}\n\n`;
    
    if (book.chapters.length > 0) {
      markdown += `### Chapter Overview:\n`;
      book.chapters.slice(0, 5).forEach(chapter => {
        markdown += `  ${chapter.number}. ${chapter.title}\n`;
      });
      
      if (book.chapters.length > 5) {
        markdown += `  ... and ${book.chapters.length - 5} more chapters\n`;
      }
      markdown += `\n`;
    }
  });

  return markdown;
}

// Helper function to format results as summary
function formatAsSummary(books: BookCatalogEntry[], query: string, searchType: string): any {
  const subjects = [...new Set(books.map(book => book.subject))];
  const authors = [...new Set(books.map(book => book.author))];
  const difficulties = books.reduce((acc, book) => {
    acc[book.metadata.difficulty] = (acc[book.metadata.difficulty] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    searchSummary: {
      query,
      searchType,
      totalResults: books.length,
      subjects: subjects,
      authors: authors,
      difficultyDistribution: difficulties
    },
    topResults: books.slice(0, 3).map(book => ({
      id: book.id,
      title: book.title,
      author: book.author,
      subject: book.subject,
      difficulty: book.metadata.difficulty,
      chapterCount: book.chapters.length
    }))
  };
}

// Macro definition for the registry
export const SearchBookCatalogMacroDefinition: MacroComponentDefinition<any> = {
  component: SearchBookCatalogMacro,
  name: 'search_book_catalog',
  alias: 'search_book_catalog',
  nameSpace: 'booktutor',
  version: '1.0.0',
  description: 'Search the book catalog for books by title, author, subject, or keywords',
  features: [],
  roles: ['USER', 'DEVELOPER', 'ADMIN'],
  stem: 'search',
  runat: 'server',
  tags: ['macro', 'book', 'search', 'catalog', 'booktutor'],
  tools: [{
    type: 'function',
    runat: 'server',
    function: {
      name: 'search_book_catalog',
      description: 'Search for books in the catalog using various criteria. This tool allows you to find books by title, author, subject, or keywords within the BookTutor library.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query - can be a title, author name, subject, or keywords to search for'
          },
          searchType: {
            type: 'string',
            enum: ['title', 'author', 'subject', 'keyword', 'all'],
            description: 'Type of search to perform: title (exact title match), author (author name), subject (subject area), keyword (tags and description), all (search all fields)',
            default: 'all'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          format: {
            type: 'string',
            enum: ['json', 'markdown', 'summary'],
            description: 'Output format: json (detailed data), markdown (readable format), summary (overview with top results)',
            default: 'json'
          }
        },
        required: ['query']
      }
    }
  }]
};

export default SearchBookCatalogMacroDefinition;
