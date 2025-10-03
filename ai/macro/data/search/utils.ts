// Utility functions for the Search Macro system

import type { BookChapterDocument, BookCatalogDocument, GlossaryDocument } from './types';

/**
 * Extracts meaningful search terms from a query string
 */
export function extractSearchTerms(query: string): string[] {
  return query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(term => term.length > 2);
}

/**
 * Normalizes text for consistent searching
 */
export function normalizeText(text: string): string {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculates reading time estimate for content
 */
export function calculateReadingTime(content: string, wordsPerMinute: number = 200): number {
  const wordCount = content.split(/\s+/).length;
  return Math.ceil(wordCount / wordsPerMinute);
}

/**
 * Extracts key terms from content using simple heuristics
 */
export function extractKeyTerms(content: string, maxTerms: number = 10): string[] {
  const words = normalizeText(content).split(/\s+/);
  const wordFreq = new Map<string, number>();
  
  // Count word frequencies (exclude common words)
  const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'must', 'shall', 'this', 'that', 'these', 'those']);
  
  words.forEach(word => {
    if (word.length > 3 && !commonWords.has(word)) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  });
  
  // Sort by frequency and return top terms
  return Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([word]) => word);
}

/**
 * Formats highlights for display
 */
export function formatHighlights(highlights: Record<string, unknown>): Record<string, string[]> {
  const formatted: Record<string, string[]> = {};
  
  Object.entries(highlights).forEach(([field, value]) => {
    if (Array.isArray(value)) {
      formatted[field] = value.map(v => String(v));
    } else if (typeof value === 'string') {
      formatted[field] = [value];
    } else {
      formatted[field] = [String(value)];
    }
  });
  
  return formatted;
}

/**
 * Determines content difficulty based on various factors
 */
export function assessContentDifficulty(content: string): 'beginner' | 'intermediate' | 'advanced' {
  const wordCount = content.split(/\s+/).length;
  const avgWordsPerSentence = wordCount / (content.split(/[.!?]+/).length - 1);
  const complexWords = content.match(/\w{8,}/g)?.length || 0;
  const complexWordRatio = complexWords / wordCount;
  
  // Simple heuristic scoring
  let score = 0;
  
  if (avgWordsPerSentence > 20) score += 2;
  else if (avgWordsPerSentence > 15) score += 1;
  
  if (complexWordRatio > 0.2) score += 2;
  else if (complexWordRatio > 0.1) score += 1;
  
  if (score >= 3) return 'advanced';
  if (score >= 1) return 'intermediate';
  return 'beginner';
}

/**
 * Creates a search-optimized document for book chapters
 */
export function createChapterSearchDocument(
  bookId: string,
  chapterNumber: number,
  title: string,
  content: string,
  options: {
    summary?: string;
    learningObjectives?: string[];
    keyTerms?: string[];
    estimatedTime?: number;
  } = {}
): BookChapterDocument {
  const difficulty = assessContentDifficulty(content);
  const estimatedTime = options.estimatedTime || calculateReadingTime(content);
  const keyTerms = options.keyTerms || extractKeyTerms(content);
  
  return {
    id: `${bookId}-ch${chapterNumber}`,
    bookId,
    chapter: chapterNumber,
    title,
    content,
    summary: options.summary || content.substring(0, 500) + '...',
    learningObjectives: options.learningObjectives || [],
    keyTerms,
    difficulty,
    estimatedTime,
    prerequisites: [],
    nextChapters: [],
    sections: []
  };
}

/**
 * Creates a search-optimized document for book catalog
 */
export function createBookCatalogDocument(
  id: string,
  title: string,
  options: {
    authors?: string[];
    subjects?: string[];
    level?: string;
    description?: string;
    tags?: string[];
    chapters?: number;
    language?: string;
  } = {}
): BookCatalogDocument {
  return {
    id,
    title,
    authors: options.authors || [],
    subjects: options.subjects || [],
    level: options.level || 'intermediate',
    chapters: options.chapters || 0,
    description: options.description || '',
    tags: options.tags || [],
    language: options.language || 'en',
    format: 'digital',
    created: new Date(),
    updated: new Date()
  };
}

/**
 * Creates a glossary document from term and definition
 */
export function createGlossaryDocument(
  term: string,
  definition: string,
  options: {
    synonyms?: string[];
    relatedTerms?: string[];
    bookIds?: string[];
    chapterIds?: string[];
    domain?: string;
    examples?: string[];
  } = {}
): GlossaryDocument {
  const difficulty = assessContentDifficulty(definition);
  
  return {
    id: `term-${normalizeText(term).replace(/\s+/g, '-')}`,
    term,
    definition,
    synonyms: options.synonyms || [],
    relatedTerms: options.relatedTerms || [],
    bookIds: options.bookIds || [],
    chapterIds: options.chapterIds || [],
    difficulty,
    domain: options.domain || 'general',
    examples: options.examples
  };
}

/**
 * Validates that documents have required fields for indexing
 */
export function validateDocuments(documents: Record<string, any>[], requiredFields: string[]): {
  valid: Record<string, any>[];
  invalid: Record<string, any>[];
  errors: string[];
} {
  const valid: Record<string, any>[] = [];
  const invalid: Record<string, any>[] = [];
  const errors: string[] = [];
  
  documents.forEach((doc, index) => {
    const missingFields = requiredFields.filter(field => !doc[field]);
    
    if (missingFields.length === 0) {
      valid.push(doc);
    } else {
      invalid.push(doc);
      errors.push(`Document ${index}: Missing required fields: ${missingFields.join(', ')}`);
    }
  });
  
  return { valid, invalid, errors };
}

/**
 * Generates search suggestions based on query and indexed content
 */
export function generateSearchSuggestions(
  query: string,
  indexedTerms: string[],
  maxSuggestions: number = 5
): string[] {
  const normalizedQuery = normalizeText(query);
  const suggestions = new Set<string>();
  
  // Find terms that start with the query
  indexedTerms.forEach(term => {
    const normalizedTerm = normalizeText(term);
    if (normalizedTerm.startsWith(normalizedQuery) && normalizedTerm !== normalizedQuery) {
      suggestions.add(term);
    }
  });
  
  // If not enough suggestions, find terms that contain the query
  if (suggestions.size < maxSuggestions) {
    indexedTerms.forEach(term => {
      const normalizedTerm = normalizeText(term);
      if (normalizedTerm.includes(normalizedQuery) && normalizedTerm !== normalizedQuery) {
        suggestions.add(term);
      }
    });
  }
  
  return Array.from(suggestions).slice(0, maxSuggestions);
}

/**
 * Analyzes search results to provide insights
 */
export function analyzeSearchResults(results: any[]): {
  averageScore: number;
  scoreDistribution: { high: number; medium: number; low: number };
  contentTypes: Record<string, number>;
  subjects: Record<string, number>;
  difficultyLevels: Record<string, number>;
} {
  if (results.length === 0) {
    return {
      averageScore: 0,
      scoreDistribution: { high: 0, medium: 0, low: 0 },
      contentTypes: {},
      subjects: {},
      difficultyLevels: {}
    };
  }
  
  const totalScore = results.reduce((sum, r) => sum + (r.score || 0), 0);
  const averageScore = totalScore / results.length;
  
  const scoreDistribution = { high: 0, medium: 0, low: 0 };
  const contentTypes: Record<string, number> = {};
  const subjects: Record<string, number> = {};
  const difficultyLevels: Record<string, number> = {};
  
  results.forEach(result => {
    const score = result.score || 0;
    if (score > 0.8) scoreDistribution.high++;
    else if (score > 0.4) scoreDistribution.medium++;
    else scoreDistribution.low++;
    
    const type = result.source?.type || 'unknown';
    contentTypes[type] = (contentTypes[type] || 0) + 1;
    
    const subject = result.source?.subject || result.source?.subjects?.[0] || 'general';
    subjects[subject] = (subjects[subject] || 0) + 1;
    
    const difficulty = result.source?.difficulty || 'intermediate';
    difficultyLevels[difficulty] = (difficultyLevels[difficulty] || 0) + 1;
  });
  
  return {
    averageScore,
    scoreDistribution,
    contentTypes,
    subjects,
    difficultyLevels
  };
}

/**
 * Creates a markdown summary of search results
 */
export function createSearchSummaryMarkdown(
  query: string,
  results: any[],
  metadata: any,
  analysis: ReturnType<typeof analyzeSearchResults>
): string {
  return `
# Search Results Summary

**Query**: "${query}"
**Total Results**: ${metadata.totalHits}
**Returned**: ${results.length}
**Execution Time**: ${metadata.executionTime}ms
**Average Score**: ${analysis.averageScore.toFixed(2)}

## Score Distribution
- **High Quality (>0.8)**: ${analysis.scoreDistribution.high}
- **Medium Quality (0.4-0.8)**: ${analysis.scoreDistribution.medium}
- **Lower Quality (<0.4)**: ${analysis.scoreDistribution.low}

## Content Analysis
### Content Types
${Object.entries(analysis.contentTypes).map(([type, count]) => `- **${type}**: ${count}`).join('\n')}

### Subjects
${Object.entries(analysis.subjects).map(([subject, count]) => `- **${subject}**: ${count}`).join('\n')}

### Difficulty Levels
${Object.entries(analysis.difficultyLevels).map(([level, count]) => `- **${level}**: ${count}`).join('\n')}

## Top Results
${results.slice(0, 5).map((result, index) => `
### ${index + 1}. ${result.source?.title || result.id}
- **Score**: ${(result.score || 0).toFixed(2)}
- **Type**: ${result.source?.type || 'unknown'}
- **Difficulty**: ${result.source?.difficulty || 'unknown'}
${result.source?.content ? `- **Preview**: ${result.source.content.substring(0, 100)}...` : ''}
`).join('\n')}
  `;
}

export default {
  extractSearchTerms,
  normalizeText,
  calculateReadingTime,
  extractKeyTerms,
  formatHighlights,
  assessContentDifficulty,
  createChapterSearchDocument,
  createBookCatalogDocument,
  createGlossaryDocument,
  validateDocuments,
  generateSearchSuggestions,
  analyzeSearchResults,
  createSearchSummaryMarkdown
};
