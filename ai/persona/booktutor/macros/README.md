# BookTutor Macros

This directory contains BookTutor-specific macros that provide specialized functionality for educational content management and search capabilities. These macros work in conjunction with the general search macros to provide comprehensive book and learning management features.

## Available Macros

### 1. SearchBookCatalog.macro.ts
**Function:** `search_book_catalog`

Searches the book catalog for books by title, author, subject, or keywords.

**Parameters:**
- `query` (required): Search query (title, author, subject, or keywords)
- `searchType` (optional): Type of search ('title', 'author', 'subject', 'keyword', 'all')
- `limit` (optional): Maximum number of results (default: 10)
- `format` (optional): Output format ('json', 'markdown', 'summary')

**Example Usage:**
```typescript
// Search for all books about mathematics
{
  "query": "mathematics",
  "searchType": "subject",
  "limit": 5,
  "format": "markdown"
}

// Search for books by a specific author
{
  "query": "Isaac Newton",
  "searchType": "author"
}
```

### 2. SearchBookContent.macro.ts
**Function:** `search_book_content`

Searches within book pages and chapters for specific content.

**Parameters:**
- `query` (required): Content to search for (keywords, phrases, concepts)
- `bookId` (optional): Specific book ID to search within
- `chapterFilter` (optional): Filter by chapter name or number
- `contentType` (optional): Type of content ('text', 'definition', 'example', 'exercise', 'all')
- `limit` (optional): Maximum number of results (default: 20)
- `format` (optional): Output format ('json', 'markdown', 'summary')

**Example Usage:**
```typescript
// Search for definitions of calculus
{
  "query": "calculus",
  "contentType": "definition",
  "format": "markdown"
}

// Search for examples in a specific chapter
{
  "query": "integration",
  "bookId": "calculus-101",
  "chapterFilter": "Chapter 5",
  "contentType": "example"
}
```

### 3. GetBookChapter.macro.ts
**Function:** `get_book_chapter`

Retrieves complete chapter content from a specific book.

**Parameters:**
- `bookId` (required): Unique identifier of the book
- `chapterNumber` (optional): Chapter number to retrieve
- `chapterName` (optional): Chapter name (alternative to number)
- `includeExercises` (optional): Whether to include exercises (default: true)
- `format` (optional): Output format ('json', 'markdown', 'text')
- `section` (optional): Specific section within the chapter

**Example Usage:**
```typescript
// Get a specific chapter by number
{
  "bookId": "physics-fundamentals",
  "chapterNumber": 3,
  "format": "markdown"
}

// Get a chapter by name without exercises
{
  "bookId": "chemistry-basics",
  "chapterName": "Chemical Reactions",
  "includeExercises": false,
  "format": "text"
}
```

### 4. CreateLearningPath.macro.ts
**Function:** `create_learning_path`

Creates a structured learning path from book content.

**Parameters:**
- `subject` (required): Main subject or topic for the learning path
- `level` (required): Learning level ('beginner', 'intermediate', 'advanced')
- `duration` (optional): Expected duration (default: 'flexible')
- `prerequisites` (optional): List of prerequisite topics
- `learningObjectives` (optional): Specific learning objectives
- `pathName` (optional): Custom name for the learning path
- `saveToFile` (optional): Whether to save to file (default: true)
- `format` (optional): Output format ('json', 'markdown', 'summary')

**Example Usage:**
```typescript
// Create a beginner math learning path
{
  "subject": "Algebra",
  "level": "beginner",
  "duration": "4 weeks",
  "prerequisites": ["Basic arithmetic", "Number theory"],
  "learningObjectives": [
    "Solve linear equations",
    "Understand variables and expressions",
    "Graph linear functions"
  ],
  "format": "markdown"
}
```

## Integration with BookTutor

These macros are automatically integrated with the BookTutor AI persona and are available as tools during tutoring sessions. They work together to provide:

1. **Discovery**: Find relevant books and content using catalog search
2. **Content Access**: Retrieve specific chapters and content
3. **Learning Structure**: Create organized learning paths
4. **Targeted Learning**: Search for specific types of content (definitions, examples, exercises)

## File Structure

```
/macros/
├── index.ts                     # Main export file
├── SearchBookCatalog.macro.ts   # Book catalog search functionality
├── SearchBookContent.macro.ts   # Content search within books
├── GetBookChapter.macro.ts      # Chapter retrieval functionality
├── CreateLearningPath.macro.ts  # Learning path generation
└── README.md                    # This documentation file
```

## Data Requirements

These macros expect the following data structure in the BookTutor library:

### Book Catalog (`library/catalog.json`)
```json
{
  "version": "1.0.0",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "totalBooks": 1,
  "books": [
    {
      "id": "book-unique-id",
      "title": "Book Title",
      "author": "Author Name",
      "subject": "Subject Area",
      "description": "Book description",
      "chapters": [
        {
          "number": 1,
          "title": "Chapter Title",
          "pages": 25
        }
      ],
      "metadata": {
        "language": "en",
        "difficulty": "beginner",
        "estimatedReadTime": "4 hours",
        "tags": ["tag1", "tag2"]
      },
      "filePath": "/path/to/book/directory",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

### Chapter Files (`library/{bookId}/chapter-{number}.md`)
Each chapter should be stored as a markdown file with the following structure:
```markdown
# Chapter Title

## Introduction
Chapter introduction content...

## Section 1: Topic
Content for this section...

### Subsection
More detailed content...

## Key Terms:
- Term 1: Definition
- Term 2: Definition

## Learning Objectives:
- Objective 1
- Objective 2

## Exercises
1. Exercise question...
   Answer: Solution...
   Hint: Helpful hint...
```

## Error Handling

All macros include comprehensive error handling for:
- Missing or invalid parameters
- File system errors (missing catalog, chapters)
- Invalid data formats
- Search failures
- Resource allocation issues

## Performance Considerations

- Catalog searches are optimized for small to medium-sized libraries
- Content searches may be slow for very large books
- Learning path generation complexity scales with available book content
- File I/O operations are cached where possible

## Future Enhancements

Planned improvements include:
- Full-text search indexing for faster content search
- Machine learning-based content recommendations
- Interactive learning path progression tracking
- Multi-language support
- Advanced analytics and progress reporting
