# Reactory Search Macros

This directory contains AI macros that provide comprehensive search capabilities through the ReactorySearchService. These macros enable indexing, searching, and managing searchable content across the Reactory platform.

## Overview

The search macros provide a unified interface for:
- **Indexing Content**: Adding documents to search indices
- **Searching Content**: Full-text search across indexed content
- **Managing Indices**: Creating, updating, and deleting search indices
- **Search Analytics**: Tracking search performance and usage

## Available Macros

### 1. SearchContent
**Tool Name**: `searchContent`
**Description**: Performs full-text search across one or more indices with advanced filtering and pagination.

**Parameters**:
- `query` (string, required): Search query string
- `index` (string): Specific index to search (if not provided, searches default indices)
- `indices` (string[]): Multiple indices to search across
- `fields` (string[]): Specific fields to search within
- `limit` (number): Maximum number of results to return (default: 10)
- `offset` (number): Number of results to skip for pagination (default: 0)
- `highlight` (boolean): Whether to include highlighting in results (default: true)
- `format` (string): Output format (json, markdown, summary, detailed)

**State Variables**:
- `lastSearchResults`: Complete search results
- `lastSearchQuery`: The executed search query
- `searchMetadata`: Search metadata (timing, total hits, etc.)

### 2. IndexContent
**Tool Name**: `indexContent`
**Description**: Adds documents to a search index for future searching.

**Parameters**:
- `index` (string, required): The search index name
- `documents` (object[], required): Array of documents to index
- `idField` (string): Field to use as document ID (default: 'id')
- `replaceExisting` (boolean): Whether to replace existing documents (default: true)
- `format` (string): Output format for indexing results

**State Variables**:
- `lastIndexOperation`: Details of the indexing operation
- `indexedDocuments`: Count and metadata of indexed documents

### 3. CreateIndex
**Tool Name**: `createIndex`
**Description**: Creates a new search index with specified configuration.

**Parameters**:
- `index` (string, required): The index name to create
- `primaryKey` (string): Primary key field for documents
- `searchableAttributes` (string[]): Fields that should be searchable
- `filterableAttributes` (string[]): Fields that can be used for filtering
- `sortableAttributes` (string[]): Fields that can be used for sorting
- `format` (string): Output format

### 4. DeleteIndex
**Tool Name**: `deleteIndex`
**Description**: Deletes a search index and all its documents.

**Parameters**:
- `index` (string, required): The index name to delete
- `confirm` (boolean, required): Confirmation flag to prevent accidental deletion

### 5. GetIndexStats
**Tool Name**: `getIndexStats`
**Description**: Retrieves statistics and metadata for search indices.

**Parameters**:
- `index` (string): Specific index to get stats for
- `includeDocumentCount` (boolean): Include document count (default: true)
- `includeFieldStats` (boolean): Include field statistics (default: false)
- `format` (string): Output format

### 6. SearchSuggestions
**Tool Name**: `searchSuggestions`
**Description**: Provides search suggestions and auto-completion based on indexed content.

**Parameters**:
- `query` (string, required): Partial query for suggestions
- `index` (string): Index to search for suggestions
- `limit` (number): Maximum number of suggestions (default: 5)
- `field` (string): Specific field to generate suggestions from

## Usage Examples

### Basic Content Search
```typescript
// Search for content across all indices
await searchContent({
  query: "machine learning algorithms",
  limit: 20,
  format: "summary"
});
```

### Index Educational Content
```typescript
// Index book chapters for the BookTutor
await indexContent({
  index: "book-chapters",
  documents: [
    {
      id: "storrar-ch1",
      title: "Introduction to Mining Industry",
      content: "Chapter content...",
      book: "storrar-sampling",
      chapter: 1,
      subjects: ["mining", "economics"]
    }
  ]
});
```

### Search with Filtering
```typescript
// Search within specific book content
await searchContent({
  query: "sampling techniques",
  index: "book-chapters",
  fields: ["title", "content"],
  highlight: true,
  format: "detailed"
});
```

## Integration with BookTutor

The search macros are specifically designed to support the BookTutor AI agent:

### Book Content Indexing
- **Chapter Indexing**: Individual chapters indexed with metadata
- **Book Catalogs**: Book metadata and structure indexed separately
- **Cross-references**: Links between chapters and concepts
- **Search Terms**: Glossary terms and definitions indexed

### Educational Search Features
- **Semantic Search**: Find concepts even with different terminology
- **Progressive Difficulty**: Search results ordered by complexity
- **Topic Clustering**: Related content grouped together
- **Learning Path**: Sequential content discovery

### BookTutor Specific Indices
- `book-catalog`: Book metadata and structure
- `book-chapters`: Individual chapter content
- `book-glossary`: Terms and definitions
- `learning-paths`: Structured learning sequences

## Error Handling

All search macros include comprehensive error handling:
- **Service Availability**: Checks for ReactorySearchService availability
- **Index Validation**: Validates index names and existence
- **Query Validation**: Validates search queries and parameters
- **Result Processing**: Handles empty results and malformed data

## Performance Considerations

- **Pagination**: All search results support pagination
- **Field Selection**: Limit searched fields for better performance
- **Index Optimization**: Separate indices for different content types
- **Caching**: Search results cached in chat state for reference

## State Management

Search macros maintain state for AI analysis:
- **Search History**: Previous searches and results
- **Index Status**: Current state of search indices
- **Performance Metrics**: Search timing and success rates
- **Content Metadata**: Information about indexed content

This search infrastructure provides the foundation for intelligent content discovery and educational support within the Reactory platform.
