// BookTutor Macro Exports
// This file exports all BookTutor-specific macros for registration

import { 
  SearchBookCatalogMacroDefinition,
  type SearchBookCatalogParams,
  type BookCatalogEntry 
} from './SearchBookCatalog.macro';

import { 
  SearchBookContentMacroDefinition,
  type SearchBookContentParams,
  type BookContentResult,
  type BookContentSearchMetadata 
} from './SearchBookContent.macro';

import { 
  GetBookChapterMacroDefinition,
  type GetBookChapterParams,
  type ChapterContent,
  type ChapterSection,
  type Exercise,
  type ChapterMetadata,
  type ChapterReference 
} from './GetBookChapter.macro';

import { 
  CreateLearningPathMacroDefinition,
  type CreateLearningPathParams,
  type LearningPath,
  type LearningStep,
  type LearningResource,
  type LearningPathMetadata 
} from './CreateLearningPath.macro';

// Re-export all types and definitions
export type { 
  SearchBookCatalogParams,
  BookCatalogEntry,
  SearchBookContentParams,
  BookContentResult,
  BookContentSearchMetadata,
  GetBookChapterParams,
  ChapterContent,
  ChapterSection,
  Exercise,
  ChapterMetadata,
  ChapterReference,
  CreateLearningPathParams,
  LearningPath,
  LearningStep,
  LearningResource,
  LearningPathMetadata 
};

export {
  SearchBookCatalogMacroDefinition,
  SearchBookContentMacroDefinition,
  GetBookChapterMacroDefinition,
  CreateLearningPathMacroDefinition
};

// Collect all macro definitions for easy registration
export const BOOKTUTOR_MACROS = [
  SearchBookCatalogMacroDefinition,
  SearchBookContentMacroDefinition,
  GetBookChapterMacroDefinition,
  CreateLearningPathMacroDefinition
];

// Export macro names for tool inclusion
export const BOOKTUTOR_MACRO_TOOLS = [
  'search_book_catalog',
  'search_book_content', 
  'get_book_chapter',
  'create_learning_path'
];

// Utility function to get macro by name
export function getBookTutorMacro(name: string) {
  return BOOKTUTOR_MACROS.find(macro => macro.name === name);
}

// Utility function to get all tool definitions
export function getBookTutorTools() {
  return BOOKTUTOR_MACROS.map(macro => macro.tools).flat();
}
