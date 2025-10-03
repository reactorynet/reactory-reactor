// Type definitions for the Search Macro system

// Import types for local use
import type { SearchResult, SearchMetadata } from './macro';

export interface BookCatalogDocument {
  id: string;              // Unique book identifier
  title: string;           // Book title
  authors: string[];       // Book authors
  subjects: string[];      // Subject areas
  level: string;           // Difficulty level (beginner, intermediate, advanced)
  chapters: number;        // Number of chapters
  description: string;     // Book description
  tags: string[];          // Searchable tags
  isbn?: string;           // ISBN if available
  publisher?: string;      // Publisher information
  publishDate?: Date;      // Publication date
  language: string;        // Content language
  format: string;          // Format (digital, pdf, html, etc.)
  created: Date;           // Catalog date
  updated: Date;           // Last update
}

export interface BookChapterDocument {
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
  sections: ChapterSection[]; // Chapter sections
  exercises?: Exercise[];  // Practice exercises
  references?: Reference[]; // Bibliography/references
}

export interface ChapterSection {
  id: string;
  title: string;
  content: string;
  subsections?: ChapterSection[];
  figures?: Figure[];
  tables?: Table[];
}

export interface GlossaryDocument {
  id: string;              // Unique term identifier
  term: string;            // Glossary term
  definition: string;      // Term definition
  synonyms: string[];      // Alternative terms
  relatedTerms: string[];  // Related concepts
  bookIds: string[];       // Books containing term
  chapterIds: string[];    // Chapters using term
  difficulty: string;      // Term complexity
  domain: string;          // Subject domain
  examples?: string[];     // Usage examples
  pronunciation?: string;  // Phonetic pronunciation
}

export interface LearningPathDocument {
  id: string;              // Unique path identifier
  name: string;            // Learning path name
  description: string;     // Path description
  difficulty: string;      // Overall difficulty
  estimatedTime: number;   // Total time in hours
  prerequisites: string[]; // Required background
  objectives: string[];    // Learning outcomes
  steps: LearningStep[];   // Ordered learning steps
  tags: string[];          // Classification tags
  subject: string;         // Primary subject area
  created: Date;           // Creation date
  updated: Date;           // Last update
}

export interface LearningStep {
  id: string;
  order: number;
  type: 'chapter' | 'exercise' | 'assessment' | 'project';
  resourceId: string;      // ID of chapter, exercise, etc.
  title: string;
  description: string;
  estimatedTime: number;   // Time in minutes
  required: boolean;       // Is this step mandatory
  alternatives?: string[]; // Alternative resource IDs
}

export interface Exercise {
  id: string;
  type: 'multiple-choice' | 'short-answer' | 'essay' | 'practical' | 'calculation';
  question: string;
  options?: string[];      // For multiple choice
  correctAnswer?: string;  // Correct answer or explanation
  hints?: string[];        // Progressive hints
  difficulty: string;
  estimatedTime: number;   // Time in minutes
  topics: string[];        // Related topics/concepts
}

export interface Figure {
  id: string;
  caption: string;
  url: string;
  alt: string;
  type: 'image' | 'diagram' | 'chart' | 'graph';
}

export interface Table {
  id: string;
  caption: string;
  headers: string[];
  rows: string[][];
  notes?: string;
}

export interface Reference {
  id: string;
  type: 'book' | 'article' | 'website' | 'paper' | 'report';
  title: string;
  authors: string[];
  publication?: string;
  year?: number;
  url?: string;
  pages?: string;
  isbn?: string;
  doi?: string;
}

// Search-specific types
export interface SearchFilter {
  field: string;
  value: string | string[];
  operator: 'equals' | 'contains' | 'in' | 'range';
}

export interface SearchSort {
  field: string;
  order: 'asc' | 'desc';
}

export interface AdvancedSearchParams {
  query: string;
  filters?: SearchFilter[];
  sort?: SearchSort[];
  facets?: string[];
  boost?: Record<string, number>; // Field boost weights
}

export interface SearchFacet {
  field: string;
  values: Array<{
    value: string;
    count: number;
  }>;
}

export interface SearchResultWithFacets {
  results: SearchResult[];
  facets: SearchFacet[];
  metadata: SearchMetadata;
  suggestions?: string[];
}

// BookTutor-specific search types
export interface ConceptSearchResult {
  concept: string;
  definitions: GlossaryDocument[];
  explanations: BookChapterDocument[];
  examples: BookChapterDocument[];
  relatedConcepts: string[];
  difficulty: string;
  learningPaths: LearningPathDocument[];
}

export interface ProgressiveSearchResult {
  beginner: SearchResult[];
  intermediate: SearchResult[];
  advanced: SearchResult[];
  recommended: SearchResult[];
}

// Re-export main types
export type {
  OutputFormat,
  SearchContentParams,
  IndexContentParams,
  CreateIndexParams,
  DeleteIndexParams,
  GetIndexStatsParams,
  SearchSuggestionsParams,
  SearchResult,
  SearchMetadata,
  SearchSummary,
  IndexOperation
} from './macro';
