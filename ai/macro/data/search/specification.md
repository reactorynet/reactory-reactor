# Reactory Search Macro Specification

## Version: 1.0.0
## Namespace: reactory-reactor
## Component: SearchMacro

---

## Executive Summary

The Reactory Search Macro provides comprehensive search capabilities through the ReactorySearchService, enabling AI agents to index, search, and manage searchable content across the platform. This macro is specifically designed to support educational applications like the BookTutor AI agent.

---

## Functional Requirements

### FR-1: Content Search
**Priority**: High
**Description**: The macro must provide full-text search capabilities across indexed content.

**Acceptance Criteria**:
- Support single and multi-index searching
- Provide field-specific search capabilities
- Include pagination support (limit/offset)
- Return highlighted search results
- Support multiple output formats (json, markdown, summary, detailed)

### FR-2: Content Indexing
**Priority**: High
**Description**: The macro must enable indexing of documents for future searching.

**Acceptance Criteria**:
- Support batch document indexing
- Handle document ID assignment and management
- Provide indexing progress and status reporting
- Support document replacement and updates
- Validate document structure before indexing

### FR-3: Index Management
**Priority**: Medium
**Description**: The macro must provide index lifecycle management capabilities.

**Acceptance Criteria**:
- Create new search indices with configuration
- Delete existing indices with confirmation
- Retrieve index statistics and metadata
- Configure searchable, filterable, and sortable attributes

### FR-4: Search Suggestions
**Priority**: Medium
**Description**: The macro must provide auto-completion and search suggestions.

**Acceptance Criteria**:
- Generate suggestions based on partial queries
- Support field-specific suggestions
- Limit number of suggestions returned
- Integrate with existing indexed content

### FR-5: Error Handling
**Priority**: High
**Description**: The macro must handle all error scenarios gracefully.

**Acceptance Criteria**:
- Validate ReactorySearchService availability
- Handle malformed queries and parameters
- Provide clear error messages and troubleshooting guidance
- Gracefully handle empty result sets

---

## Technical Requirements

### TR-1: Service Integration
**Component**: ReactorySearchService
**Requirement**: The macro must integrate with the ReactorySearchService using the established service pattern.

```typescript
const searchService = context.getService<Reactory.Service.ISearchService>("core.ReactorySearchService@1.0.0");
```

### TR-2: Type Safety
**Requirement**: All macro parameters and return types must be strongly typed.

```typescript
export interface SearchContentParams {
  query: string;
  index?: string;
  indices?: string[];
  fields?: string[];
  limit?: number;
  offset?: number;
  highlight?: boolean;
  format?: "json" | "markdown" | "summary" | "detailed";
}
```

### TR-3: State Management
**Requirement**: Search results and metadata must be stored in chat state for AI reference.

```typescript
chatState.vars.lastSearchResults = searchResults;
chatState.vars.lastSearchQuery = query;
chatState.vars.searchMetadata = metadata;
```

### TR-4: Performance
**Requirement**: Search operations must complete within acceptable time limits.
- Simple searches: < 500ms
- Complex multi-index searches: < 2000ms
- Indexing operations: < 5000ms per batch

---

## API Specification

### SearchContent Function

```typescript
interface SearchContentParams {
  query: string;                    // Required: Search query string
  index?: string;                   // Optional: Single index to search
  indices?: string[];               // Optional: Multiple indices to search
  fields?: string[];                // Optional: Specific fields to search
  limit?: number;                   // Optional: Max results (default: 10)
  offset?: number;                  // Optional: Pagination offset (default: 0)
  highlight?: boolean;              // Optional: Include highlighting (default: true)
  format?: OutputFormat;            // Optional: Output format (default: "json")
}

interface SearchContentResult {
  success: boolean;
  data?: {
    results: SearchResult[];
    metadata: SearchMetadata;
    summary: SearchSummary;
  };
  error?: string;
  tool: "searchContent";
  params: SearchContentParams;
  format: OutputFormat;
}
```

### IndexContent Function

```typescript
interface IndexContentParams {
  index: string;                    // Required: Index name
  documents: Record<string, any>[]; // Required: Documents to index
  idField?: string;                 // Optional: ID field name (default: "id")
  replaceExisting?: boolean;        // Optional: Replace existing docs (default: true)
  format?: OutputFormat;            // Optional: Output format
}

interface IndexContentResult {
  success: boolean;
  data?: {
    indexedCount: number;
    failedCount: number;
    indexId: string;
    operation: IndexOperation;
  };
  error?: string;
  tool: "indexContent";
  params: IndexContentParams;
}
```

---

## Data Models

### SearchResult
```typescript
interface SearchResult {
  id: string;
  score: number;
  source: Record<string, any>;
  highlights?: Record<string, string[]>;
  index: string;
}
```

### SearchMetadata
```typescript
interface SearchMetadata {
  query: string;
  executionTime: number;
  totalHits: number;
  maxScore: number;
  indices: string[];
  processingTime: number;
}
```

### IndexOperation
```typescript
interface IndexOperation {
  indexId: string;
  status: "processing" | "completed" | "failed";
  documentsAdded: number;
  documentsUpdated: number;
  documentsFailed: number;
  errors?: string[];
}
```

---

## BookTutor Integration Specification

### Educational Content Indices

#### book-catalog Index
```typescript
interface BookCatalogDocument {
  id: string;              // Unique book identifier
  title: string;           // Book title
  authors: string[];       // Book authors
  subjects: string[];      // Subject areas
  level: string;           // Difficulty level
  chapters: number;        // Number of chapters
  description: string;     // Book description
  tags: string[];          // Searchable tags
  created: Date;           // Catalog date
  updated: Date;           // Last update
}
```

#### book-chapters Index
```typescript
interface BookChapterDocument {
  id: string;              // Unique chapter identifier
  bookId: string;          // Parent book ID
  chapter: number;         // Chapter number
  title: string;           // Chapter title
  content: string;         // Full chapter content
  summary: string;         // Chapter summary
  learningObjectives: string[]; // Learning goals
  keyTerms: string[];      // Important terms
  difficulty: string;      // Chapter difficulty
  estimatedTime: number;   // Reading time in minutes
  prerequisites: string[]; // Required prior knowledge
  nextChapters: string[];  // Recommended next chapters
}
```

#### book-glossary Index
```typescript
interface GlossaryDocument {
  id: string;              // Unique term identifier
  term: string;            // Glossary term
  definition: string;      // Term definition
  synonyms: string[];      // Alternative terms
  relatedTerms: string[];  // Related concepts
  bookIds: string[];       // Books containing term
  chapterIds: string[];    // Chapters using term
  difficulty: string;      // Term complexity
  domain: string;          // Subject domain
}
```

### Search Capabilities for BookTutor

#### Content Discovery
- **Semantic Search**: Find concepts using natural language
- **Progressive Learning**: Search ordered by difficulty
- **Prerequisite Mapping**: Find required background knowledge
- **Cross-references**: Discover related topics across books

#### Learning Support
- **Concept Explanation**: Search for term definitions and explanations
- **Example Finding**: Locate practical examples and case studies
- **Assessment Support**: Find review questions and exercises
- **Path Planning**: Discover optimal learning sequences

---

## Security Requirements

### SR-1: Access Control
**Requirement**: Search operations must respect user permissions and data access rights.

### SR-2: Data Validation
**Requirement**: All search queries and indexed content must be validated for safety and structure.

### SR-3: Resource Limits
**Requirement**: Search operations must be bounded to prevent resource exhaustion.
- Maximum query length: 1000 characters
- Maximum results per request: 1000
- Maximum indexed document size: 10MB

---

## Testing Requirements

### Unit Tests
- Parameter validation
- Service integration
- Error handling
- State management

### Integration Tests
- ReactorySearchService interaction
- Multi-index search operations
- Large document indexing
- Performance benchmarks

### Educational Content Tests
- BookTutor search scenarios
- Educational content indexing
- Learning path discovery
- Cross-reference resolution

---

## Implementation Guidelines

### Code Organization
```
/data/search/
├── macro.ts              # Main search macro implementation
├── types.ts              # TypeScript type definitions
├── utils.ts              # Utility functions
├── validators.ts         # Parameter validation
├── formatters.ts         # Output formatting
├── README.md             # Documentation
└── specification.md      # This specification
```

### Error Handling Pattern
```typescript
try {
  // Operation implementation
  return successResult;
} catch (error) {
  context.error("Operation failed", { error, params }, "SearchMacro");
  return {
    success: false,
    error: `Operation failed: ${error?.message || "Unknown error"}`,
    tool: 'operationName',
    params: params
  };
}
```

### State Management Pattern
```typescript
// Store results for AI reference
chatState.vars.lastSearchResults = results;
chatState.vars.searchHistory = [
  ...(chatState.vars.searchHistory || []),
  { query, timestamp: new Date(), resultCount: results.length }
];
```

---

## Future Enhancements

### Phase 2 Features
- **Analytics**: Search usage tracking and optimization
- **Machine Learning**: Personalized search ranking
- **Federated Search**: Cross-platform content discovery
- **Real-time Indexing**: Live content updates

### BookTutor Extensions
- **Adaptive Learning**: Search results adapted to user progress
- **Collaborative Filtering**: Recommendations based on peer learning
- **Assessment Integration**: Search tied to quiz and exercise results
- **Progress Tracking**: Search history analysis for learning insights

---

## Acceptance Criteria Summary

1. ✅ **Core Search**: Full-text search across indices with pagination
2. ✅ **Content Indexing**: Batch document indexing with progress tracking
3. ✅ **Index Management**: Create, delete, and monitor search indices
4. ✅ **Error Handling**: Comprehensive error handling and user feedback
5. ✅ **Type Safety**: Strongly typed parameters and return values
6. ✅ **Performance**: Sub-second search response times
7. ✅ **BookTutor Integration**: Educational content search capabilities
8. ✅ **State Management**: Search results stored for AI analysis

---

This specification provides the complete technical and functional requirements for implementing a comprehensive search macro that will enable powerful content discovery and educational support within the Reactory platform.
