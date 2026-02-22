import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import fs from 'fs';
import path from 'path';

export type GetBookChapterParams = {
  bookId: string;
  chapterNumber?: number;
  chapterName?: string;
  includeExercises?: boolean;
  format?: 'json' | 'markdown' | 'text';
  section?: string;
}

export interface ChapterContent {
  bookId: string;
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  content: string;
  sections: ChapterSection[];
  exercises: Exercise[];
  metadata: ChapterMetadata;
  navigationInfo: {
    previousChapter?: ChapterReference;
    nextChapter?: ChapterReference;
  };
}

export interface ChapterSection {
  title: string;
  content: string;
  subsections: string[];
  pageReference?: string;
}

export interface Exercise {
  number: number;
  type: 'practice' | 'review' | 'challenge';
  question: string;
  answer?: string;
  hint?: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface ChapterMetadata {
  readingTime: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  keyTerms: string[];
  learningObjectives: string[];
  prerequisites: string[];
}

export interface ChapterReference {
  number: number;
  title: string;
}

const GetBookChapterMacro = async (
  params: GetBookChapterParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    bookId,
    chapterNumber,
    chapterName,
    includeExercises = true,
    format = 'json',
    section
  } = params;

  if (!bookId) {
    return {
      success: false,
      error: "Book ID is required.",
      tool: 'get_book_chapter',
      params: params
    };
  }

  if (!chapterNumber && !chapterName) {
    return {
      success: false,
      error: "Either chapterNumber or chapterName must be provided.",
      tool: 'get_book_chapter',
      params: params
    };
  }

  try {
    context.debug("Starting GetBookChapterMacro execution", { params }, "GetBookChapterMacro");
    
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
        tool: 'get_book_chapter',
        params: params
      };
    }

    // Read and parse catalog
    const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
    const catalog = JSON.parse(catalogContent);
    
    // Find the book
    const book = catalog.books?.find((b: any) => b.id === bookId);
    if (!book) {
      return {
        success: false,
        error: `Book with ID "${bookId}" not found in catalog.`,
        tool: 'get_book_chapter',
        params: params
      };
    }

    // Find the chapter
    let targetChapter: any = null;
    if (chapterNumber) {
      targetChapter = book.chapters?.find((c: any) => c.number === chapterNumber);
    } else if (chapterName) {
      const nameLower = chapterName.toLowerCase();
      targetChapter = book.chapters?.find((c: any) => 
        c.title.toLowerCase().includes(nameLower)
      );
    }

    if (!targetChapter) {
      const identifier = chapterNumber ? `number ${chapterNumber}` : `name "${chapterName}"`;
      return {
        success: false,
        error: `Chapter with ${identifier} not found in book "${book.title}".`,
        tool: 'get_book_chapter',
        params: params
      };
    }

    // Construct chapter file path
    const chapterFileName = `chapter-${targetChapter.number.toString().padStart(2, '0')}.md`;
    const bookDir = path.join(libraryPath, bookId);
    const chapterPath = path.join(bookDir, chapterFileName);

    if (!fs.existsSync(chapterPath)) {
      return {
        success: false,
        error: `Chapter file not found: ${chapterFileName}. The chapter may not be available yet.`,
        tool: 'get_book_chapter',
        params: params
      };
    }

    // Read chapter content
    const rawContent = fs.readFileSync(chapterPath, 'utf-8');
    
    // Parse the chapter content
    const parsedChapter = parseChapterContent(rawContent, book, targetChapter);
    
    // Add navigation information
    const chapterIndex = book.chapters.findIndex((c: any) => c.number === targetChapter.number);
    const previousChapter = chapterIndex > 0 ? book.chapters[chapterIndex - 1] : null;
    const nextChapter = chapterIndex < book.chapters.length - 1 ? book.chapters[chapterIndex + 1] : null;
    
    parsedChapter.navigationInfo = {
      previousChapter: previousChapter ? {
        number: previousChapter.number,
        title: previousChapter.title
      } : undefined,
      nextChapter: nextChapter ? {
        number: nextChapter.number,
        title: nextChapter.title
      } : undefined
    };

    // Filter by section if specified
    let content = parsedChapter;
    if (section) {
      const sectionLower = section.toLowerCase();
      const matchingSection = parsedChapter.sections.find(s => 
        s.title.toLowerCase().includes(sectionLower)
      );
      
      if (matchingSection) {
        content = {
          ...parsedChapter,
          content: matchingSection.content,
          sections: [matchingSection]
        };
      } else {
        return {
          success: false,
          error: `Section "${section}" not found in chapter "${targetChapter.title}".`,
          tool: 'get_book_chapter',
          params: params
        };
      }
    }

    // Filter exercises if not requested
    if (!includeExercises) {
      content.exercises = [];
    }

    // Format results based on requested format
    let formattedResult: any;
    
    switch (format) {
      case 'markdown':
        formattedResult = formatChapterAsMarkdown(content);
        break;
      
      case 'text':
        formattedResult = formatChapterAsText(content);
        break;
      
      case 'json':
      default:
        formattedResult = content;
        break;
    }

    context.debug("Chapter retrieved successfully", { 
      bookId,
      chapterNumber: targetChapter.number,
      chapterTitle: targetChapter.title,
      sectionsCount: content.sections.length,
      exercisesCount: content.exercises.length
    }, "GetBookChapterMacro");

    return {
      success: true,
      result: formattedResult,
      metadata: {
        bookId,
        bookTitle: book.title,
        chapterNumber: targetChapter.number,
        chapterTitle: targetChapter.title,
        format,
        includeExercises,
        sectionFilter: section
      },
      tool: 'get_book_chapter',
      params: params
    };

  } catch (error) {
    context.error("Error in GetBookChapterMacro", { error: error.message, params }, "GetBookChapterMacro");
    return {
      success: false,
      error: `Failed to retrieve chapter: ${error.message}`,
      tool: 'get_book_chapter',
      params: params
    };
  }
};

// Helper function to parse chapter content from markdown
function parseChapterContent(content: string, book: any, chapter: any): ChapterContent {
  const lines = content.split('\n');
  const sections: ChapterSection[] = [];
  const exercises: Exercise[] = [];
  let currentSection: ChapterSection | null = null;
  
  let keyTerms: string[] = [];
  let learningObjectives: string[] = [];
  let prerequisites: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Parse section headers (## Section Title)
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections.push(currentSection);
      }
      
      currentSection = {
        title: line.substring(3).trim(),
        content: '',
        subsections: []
      };
    }
    // Parse subsection headers (### Subsection Title)
    else if (line.startsWith('### ')) {
      if (currentSection) {
        const subsectionTitle = line.substring(4).trim();
        currentSection.subsections.push(subsectionTitle);
        currentSection.content += `\n${line}\n`;
      }
    }
    // Parse exercises
    else if (line.toLowerCase().includes('exercise') && /^\d+\./.test(lines[i + 1]?.trim() || '')) {
      const exerciseMatch = parseExercise(lines, i);
      if (exerciseMatch.exercise) {
        exercises.push(exerciseMatch.exercise);
        i = exerciseMatch.nextIndex;
      }
    }
    // Parse metadata sections
    else if (line.toLowerCase().includes('key terms:') || line.toLowerCase().includes('vocabulary:')) {
      keyTerms = parseListItems(lines, i + 1);
    }
    else if (line.toLowerCase().includes('learning objectives:') || line.toLowerCase().includes('objectives:')) {
      learningObjectives = parseListItems(lines, i + 1);
    }
    else if (line.toLowerCase().includes('prerequisites:')) {
      prerequisites = parseListItems(lines, i + 1);
    }
    // Add content to current section
    else if (currentSection && line.length > 0) {
      currentSection.content += line + '\n';
    }
  }
  
  // Add the last section
  if (currentSection) {
    sections.push(currentSection);
  }
  
  // Estimate reading time (average 200 words per minute)
  const wordCount = content.split(/\s+/).length;
  const readingTimeMinutes = Math.ceil(wordCount / 200);
  const readingTime = readingTimeMinutes === 1 ? '1 minute' : `${readingTimeMinutes} minutes`;
  
  // Determine difficulty based on content complexity
  const difficulty = determineDifficulty(content, keyTerms.length);
  
  return {
    bookId: book.id,
    bookTitle: book.title,
    chapterNumber: chapter.number,
    chapterTitle: chapter.title,
    content: content,
    sections: sections,
    exercises: exercises,
    metadata: {
      readingTime,
      difficulty,
      keyTerms,
      learningObjectives,
      prerequisites
    },
    navigationInfo: {
      // Will be set by the main function
    }
  };
}

// Helper function to parse exercises
function parseExercise(lines: string[], startIndex: number): { exercise: Exercise | null, nextIndex: number } {
  let i = startIndex + 1;
  const exerciseLines: string[] = [];
  
  while (i < lines.length && !lines[i].toLowerCase().includes('exercise') && !lines[i].startsWith('##')) {
    exerciseLines.push(lines[i]);
    i++;
  }
  
  if (exerciseLines.length === 0) {
    return { exercise: null, nextIndex: startIndex };
  }
  
  const firstLine = exerciseLines[0].trim();
  const numberMatch = firstLine.match(/^(\d+)\./);
  
  if (!numberMatch) {
    return { exercise: null, nextIndex: startIndex };
  }
  
  const number = parseInt(numberMatch[1]);
  const questionText = firstLine.substring(numberMatch[0].length).trim();
  
  // Look for answer, hint, etc. in subsequent lines
  let answer: string | undefined;
  let hint: string | undefined;
  
  for (const line of exerciseLines.slice(1)) {
    const lineLower = line.toLowerCase().trim();
    if (lineLower.startsWith('answer:') || lineLower.startsWith('solution:')) {
      answer = line.substring(line.indexOf(':') + 1).trim();
    } else if (lineLower.startsWith('hint:')) {
      hint = line.substring(5).trim();
    }
  }
  
  // Determine exercise type and difficulty
  const type = questionText.toLowerCase().includes('challenge') ? 'challenge' :
               questionText.toLowerCase().includes('review') ? 'review' : 'practice';
  
  const difficulty = questionText.length > 100 || keyTermCount(questionText) > 3 ? 'hard' :
                    questionText.length > 50 || keyTermCount(questionText) > 1 ? 'medium' : 'easy';
  
  return {
    exercise: {
      number,
      type,
      question: questionText,
      answer,
      hint,
      difficulty
    },
    nextIndex: i - 1
  };
}

// Helper function to parse list items
function parseListItems(lines: string[], startIndex: number): string[] {
  const items: string[] = [];
  let i = startIndex;
  
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) break;
    
    if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('+ ')) {
      items.push(line.substring(2).trim());
    } else if (/^\d+\./.test(line)) {
      items.push(line.substring(line.indexOf('.') + 1).trim());
    } else if (line && items.length === 0) {
      // Single line item
      items.push(line);
      break;
    } else if (!line) {
      break;
    }
    
    i++;
  }
  
  return items;
}

// Helper function to determine difficulty
function determineDifficulty(content: string, keyTermsCount: number): 'beginner' | 'intermediate' | 'advanced' {
  const wordCount = content.split(/\s+/).length;
  const avgWordsPerSentence = wordCount / (content.split(/[.!?]+/).length || 1);
  const complexityScore = keyTermsCount + (avgWordsPerSentence / 10);
  
  if (complexityScore > 15) return 'advanced';
  if (complexityScore > 8) return 'intermediate';
  return 'beginner';
}

// Helper function to count key terms in text
function keyTermCount(text: string): number {
  const technicalWords = text.match(/[A-Z][a-z]*[A-Z][a-z]*|[a-z]+ology|[a-z]+ism|[a-z]+tion/g);
  return technicalWords ? technicalWords.length : 0;
}

// Helper function to format chapter as markdown
function formatChapterAsMarkdown(chapter: ChapterContent): string {
  let markdown = `# ${chapter.chapterTitle}\n\n`;
  markdown += `**Book:** ${chapter.bookTitle}\n`;
  markdown += `**Chapter:** ${chapter.chapterNumber}\n`;
  markdown += `**Reading Time:** ${chapter.metadata.readingTime}\n`;
  markdown += `**Difficulty:** ${chapter.metadata.difficulty}\n\n`;
  
  if (chapter.navigationInfo.previousChapter || chapter.navigationInfo.nextChapter) {
    markdown += `## Navigation\n`;
    if (chapter.navigationInfo.previousChapter) {
      markdown += `← Previous: Chapter ${chapter.navigationInfo.previousChapter.number} - ${chapter.navigationInfo.previousChapter.title}\n`;
    }
    if (chapter.navigationInfo.nextChapter) {
      markdown += `→ Next: Chapter ${chapter.navigationInfo.nextChapter.number} - ${chapter.navigationInfo.nextChapter.title}\n`;
    }
    markdown += `\n`;
  }
  
  if (chapter.metadata.learningObjectives.length > 0) {
    markdown += `## Learning Objectives\n`;
    chapter.metadata.learningObjectives.forEach(obj => {
      markdown += `- ${obj}\n`;
    });
    markdown += `\n`;
  }
  
  if (chapter.metadata.prerequisites.length > 0) {
    markdown += `## Prerequisites\n`;
    chapter.metadata.prerequisites.forEach(prereq => {
      markdown += `- ${prereq}\n`;
    });
    markdown += `\n`;
  }
  
  markdown += `## Content\n\n`;
  markdown += chapter.content;
  
  if (chapter.metadata.keyTerms.length > 0) {
    markdown += `\n\n## Key Terms\n`;
    chapter.metadata.keyTerms.forEach(term => {
      markdown += `- **${term}**\n`;
    });
  }
  
  if (chapter.exercises.length > 0) {
    markdown += `\n\n## Exercises\n\n`;
    chapter.exercises.forEach(exercise => {
      markdown += `### Exercise ${exercise.number} (${exercise.difficulty})\n`;
      markdown += `${exercise.question}\n\n`;
      if (exercise.hint) {
        markdown += `**Hint:** ${exercise.hint}\n\n`;
      }
      if (exercise.answer) {
        markdown += `**Answer:** ${exercise.answer}\n\n`;
      }
    });
  }
  
  return markdown;
}

// Helper function to format chapter as text
function formatChapterAsText(chapter: ChapterContent): string {
  let text = `${chapter.chapterTitle}\n`;
  text += `${'='.repeat(chapter.chapterTitle.length)}\n\n`;
  text += `Book: ${chapter.bookTitle}\n`;
  text += `Chapter: ${chapter.chapterNumber}\n`;
  text += `Reading Time: ${chapter.metadata.readingTime}\n`;
  text += `Difficulty: ${chapter.metadata.difficulty}\n\n`;
  
  // Strip markdown formatting from content
  const plainContent = chapter.content
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^\s*[-*+]\s/gm, '• ');
  
  text += plainContent;
  
  if (chapter.exercises.length > 0) {
    text += `\n\nEXERCISES\n${'='.repeat(9)}\n\n`;
    chapter.exercises.forEach(exercise => {
      text += `${exercise.number}. ${exercise.question}\n`;
      if (exercise.hint) text += `   Hint: ${exercise.hint}\n`;
      if (exercise.answer) text += `   Answer: ${exercise.answer}\n`;
      text += `\n`;
    });
  }
  
  return text;
}

// Macro definition for the registry
export const GetBookChapterMacroDefinition: MacroComponentDefinition<any> = {
  component: GetBookChapterMacro,
  name: 'get_book_chapter',
  alias: 'get_book_chapter',
  nameSpace: 'booktutor',
  version: '1.0.0',
  description: 'Retrieve complete chapter content from a specific book',
  features: [],
  roles: ['USER', 'DEVELOPER', 'ADMIN'],
  stem: 'book',
  runat: 'server',
  tags: ['macro', 'book', 'chapter', 'content', 'booktutor'],
  tools: [{
    type: 'function',
    runat: 'server',
    function: {
      name: 'get_book_chapter',
      description: 'Retrieve the full content of a specific chapter from a book, including text, sections, exercises, and metadata.',
      parameters: {
        type: 'object',
        properties: {
          bookId: {
            type: 'string',
            description: 'Unique identifier of the book containing the chapter'
          },
          chapterNumber: {
            type: 'number',
            description: 'Chapter number to retrieve (e.g., 1, 2, 3)',
            minimum: 1
          },
          chapterName: {
            type: 'string',
            description: 'Chapter name/title (alternative to chapter number)'
          },
          includeExercises: {
            type: 'boolean',
            description: 'Whether to include exercises and practice problems in the response',
            default: true
          },
          format: {
            type: 'string',
            enum: ['json', 'markdown', 'text'],
            description: 'Output format: json (structured data), markdown (formatted text), text (plain text)',
            default: 'json'
          },
          section: {
            type: 'string',
            description: 'Specific section within the chapter to retrieve (optional)'
          }
        },
        required: ['bookId']
      }
    }
  }]
};

export default GetBookChapterMacroDefinition;
