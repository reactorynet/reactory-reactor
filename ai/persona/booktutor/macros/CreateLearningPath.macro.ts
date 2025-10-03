import { MacroComponentDefinition, ChatState } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import fs from 'fs';
import path from 'path';

export type CreateLearningPathParams = {
  subject: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  duration?: string;
  prerequisites?: string[];
  learningObjectives?: string[];
  pathName?: string;
  saveToFile?: boolean;
  format?: 'json' | 'markdown' | 'summary';
}

export interface LearningPath {
  id: string;
  name: string;
  subject: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  description: string;
  duration: string;
  prerequisites: string[];
  learningObjectives: string[];
  steps: LearningStep[];
  metadata: LearningPathMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface LearningStep {
  stepNumber: number;
  title: string;
  description: string;
  type: 'reading' | 'exercise' | 'review' | 'assessment';
  estimatedTime: string;
  resources: LearningResource[];
  completionCriteria: string[];
  optional: boolean;
}

export interface LearningResource {
  type: 'book_chapter' | 'book_section' | 'exercise' | 'external';
  bookId?: string;
  bookTitle?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  section?: string;
  description: string;
  url?: string;
}

export interface LearningPathMetadata {
  totalSteps: number;
  estimatedTotalTime: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  tags: string[];
  sourceBooks: string[];
  progressTracking: boolean;
}

const CreateLearningPathMacro = async (
  params: CreateLearningPathParams,
  chatState: ChatState,  
) => {
  const { context } = chatState;
  const { 
    subject,
    level,
    duration = 'flexible',
    prerequisites = [],
    learningObjectives = [],
    pathName,
    saveToFile = true,
    format = 'json'
  } = params;

  if (!subject || subject.trim().length === 0) {
    return {
      success: false,
      error: "Subject is required and cannot be empty.",
      tool: 'create_learning_path',
      params: params
    };
  }

  if (!level) {
    return {
      success: false,
      error: "Learning level is required (beginner, intermediate, or advanced).",
      tool: 'create_learning_path',
      params: params
    };
  }

  try {
    context.debug("Starting CreateLearningPathMacro execution", { params }, "CreateLearningPathMacro");
    
    // Get the BookTutor data root from environment
    const APP_DATA_ROOT = process.env.APP_DATA_ROOT || process.env.REACTORY_DATA;
    const BOOKTUTOR_DATA_ROOT = path.join(APP_DATA_ROOT, 'guideai/booktutor');
    const catalogPath = path.join(BOOKTUTOR_DATA_ROOT, 'library/catalog.json');
    const learningPathsDir = path.join(BOOKTUTOR_DATA_ROOT, 'learning-paths');

    // Ensure learning paths directory exists
    if (!fs.existsSync(learningPathsDir)) {
      fs.mkdirSync(learningPathsDir, { recursive: true });
    }

    // Read catalog to find relevant books
    let availableBooks: any[] = [];
    if (fs.existsSync(catalogPath)) {
      const catalogContent = fs.readFileSync(catalogPath, 'utf-8');
      const catalog = JSON.parse(catalogContent);
      availableBooks = catalog.books || [];
    }

    // Find books relevant to the subject
    const relevantBooks = findRelevantBooks(availableBooks, subject, level);
    
    if (relevantBooks.length === 0) {
      context.warn("No relevant books found for subject", { subject, level }, "CreateLearningPathMacro");
    }

    // Generate learning path
    const learningPath = generateLearningPath(
      subject,
      level,
      duration,
      prerequisites,
      learningObjectives,
      relevantBooks,
      pathName
    );

    // Save to file if requested
    if (saveToFile) {
      const pathFileName = `${learningPath.id}.json`;
      const pathFilePath = path.join(learningPathsDir, pathFileName);
      
      try {
        fs.writeFileSync(pathFilePath, JSON.stringify(learningPath, null, 2));
        context.debug("Learning path saved to file", { pathFilePath }, "CreateLearningPathMacro");
      } catch (error) {
        context.warn("Failed to save learning path to file", { error: error.message }, "CreateLearningPathMacro");
      }
    }

    // Format results based on requested format
    let formattedResult: any;
    
    switch (format) {
      case 'markdown':
        formattedResult = formatLearningPathAsMarkdown(learningPath);
        break;
      
      case 'summary':
        formattedResult = formatLearningPathAsSummary(learningPath);
        break;
      
      case 'json':
      default:
        formattedResult = learningPath;
        break;
    }

    context.debug("Learning path created successfully", { 
      pathId: learningPath.id,
      subject,
      level,
      stepsCount: learningPath.steps.length,
      sourceBooks: learningPath.metadata.sourceBooks.length
    }, "CreateLearningPathMacro");

    return {
      success: true,
      result: formattedResult,
      metadata: {
        pathId: learningPath.id,
        subject,
        level,
        stepsCount: learningPath.steps.length,
        estimatedTime: learningPath.metadata.estimatedTotalTime,
        sourceBooks: relevantBooks.length,
        savedToFile: saveToFile
      },
      tool: 'create_learning_path',
      params: params
    };

  } catch (error) {
    context.error("Error in CreateLearningPathMacro", { error: error.message, params }, "CreateLearningPathMacro");
    return {
      success: false,
      error: `Failed to create learning path: ${error.message}`,
      tool: 'create_learning_path',
      params: params
    };
  }
};

// Helper function to find books relevant to the subject
function findRelevantBooks(books: any[], subject: string, level: string): any[] {
  const subjectLower = subject.toLowerCase();
  const relevantBooks: any[] = [];

  for (const book of books) {
    let relevanceScore = 0;

    // Check subject match
    if (book.subject.toLowerCase().includes(subjectLower)) {
      relevanceScore += 10;
    }

    // Check title match
    if (book.title.toLowerCase().includes(subjectLower)) {
      relevanceScore += 8;
    }

    // Check tags match
    if (book.metadata?.tags) {
      for (const tag of book.metadata.tags) {
        if (tag.toLowerCase().includes(subjectLower)) {
          relevanceScore += 5;
        }
      }
    }

    // Check description match
    if (book.description && book.description.toLowerCase().includes(subjectLower)) {
      relevanceScore += 3;
    }

    // Check level compatibility
    if (book.metadata?.difficulty === level) {
      relevanceScore += 5;
    } else if (
      (level === 'intermediate' && book.metadata?.difficulty === 'beginner') ||
      (level === 'advanced' && ['beginner', 'intermediate'].includes(book.metadata?.difficulty))
    ) {
      relevanceScore += 2;
    }

    if (relevanceScore > 0) {
      relevantBooks.push({ ...book, relevanceScore });
    }
  }

  // Sort by relevance score (highest first)
  return relevantBooks.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// Helper function to generate a learning path
function generateLearningPath(
  subject: string,
  level: string,
  duration: string,
  prerequisites: string[],
  learningObjectives: string[],
  relevantBooks: any[],
  pathName?: string
): LearningPath {
  const pathId = generatePathId(subject, level);
  const defaultName = pathName || `${subject} Learning Path (${level})`;
  
  // Generate default learning objectives if none provided
  const defaultObjectives = learningObjectives.length > 0 ? learningObjectives : 
    generateDefaultObjectives(subject, level);

  // Generate learning steps based on available books and objectives
  const steps = generateLearningSteps(subject, level, relevantBooks, defaultObjectives);
  
  // Calculate total estimated time
  const totalTimeMinutes = steps.reduce((total, step) => {
    const timeMatch = step.estimatedTime.match(/(\d+)/);
    return total + (timeMatch ? parseInt(timeMatch[1]) : 30);
  }, 0);
  
  const totalTime = formatDuration(totalTimeMinutes);
  
  // Create metadata
  const sourceBooks = [...new Set(relevantBooks.map(book => book.title))];
  const tags = [
    subject.toLowerCase(),
    level,
    ...subject.split(' ').map(word => word.toLowerCase()),
    'learning-path'
  ];

  return {
    id: pathId,
    name: defaultName,
    subject,
    level: level as 'beginner' | 'intermediate' | 'advanced',
    description: `A structured learning path for ${subject} at ${level} level, designed to guide you through comprehensive understanding of the topic.`,
    duration,
    prerequisites,
    learningObjectives: defaultObjectives,
    steps,
    metadata: {
      totalSteps: steps.length,
      estimatedTotalTime: totalTime,
      difficulty: level as 'beginner' | 'intermediate' | 'advanced',
      tags,
      sourceBooks,
      progressTracking: true
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Helper function to generate learning steps
function generateLearningSteps(
  subject: string,
  level: string,
  relevantBooks: any[],
  objectives: string[]
): LearningStep[] {
  const steps: LearningStep[] = [];
  let stepNumber = 1;

  // Step 1: Introduction and Prerequisites
  steps.push({
    stepNumber: stepNumber++,
    title: 'Introduction and Foundation',
    description: `Begin your ${subject} journey by understanding the fundamentals and ensuring you have the necessary background knowledge.`,
    type: 'reading',
    estimatedTime: '30 minutes',
    resources: generateIntroResources(relevantBooks, level),
    completionCriteria: [
      'Understand basic terminology',
      'Review prerequisite concepts',
      'Familiarize yourself with key concepts'
    ],
    optional: false
  });

  // Generate steps based on learning objectives
  for (const objective of objectives) {
    const objectiveSteps = generateStepsForObjective(objective, relevantBooks, stepNumber, level);
    steps.push(...objectiveSteps);
    stepNumber += objectiveSteps.length;
  }

  // Add practice and review steps
  if (relevantBooks.length > 0) {
    steps.push({
      stepNumber: stepNumber++,
      title: 'Practice and Application',
      description: 'Apply your knowledge through exercises and practical problems.',
      type: 'exercise',
      estimatedTime: '45 minutes',
      resources: generateExerciseResources(relevantBooks),
      completionCriteria: [
        'Complete practice exercises',
        'Apply concepts to real problems',
        'Self-assess understanding'
      ],
      optional: false
    });

    steps.push({
      stepNumber: stepNumber++,
      title: 'Review and Assessment',
      description: 'Review key concepts and assess your understanding of the material.',
      type: 'assessment',
      estimatedTime: '30 minutes',
      resources: generateReviewResources(relevantBooks),
      completionCriteria: [
        'Review all key concepts',
        'Complete self-assessment',
        'Identify areas for improvement'
      ],
      optional: false
    });
  }

  return steps;
}

// Helper function to generate steps for a learning objective
function generateStepsForObjective(
  objective: string,
  relevantBooks: any[],
  startStepNumber: number,
  level: string
): LearningStep[] {
  const steps: LearningStep[] = [];
  
  // Find relevant chapters for this objective
  const relevantResources = findResourcesForObjective(objective, relevantBooks);
  
  if (relevantResources.length > 0) {
    steps.push({
      stepNumber: startStepNumber,
      title: `Learn: ${objective}`,
      description: `Study and understand ${objective.toLowerCase()}.`,
      type: 'reading',
      estimatedTime: level === 'beginner' ? '45 minutes' : level === 'intermediate' ? '60 minutes' : '90 minutes',
      resources: relevantResources,
      completionCriteria: [
        `Understand ${objective.toLowerCase()}`,
        'Take notes on key concepts',
        'Identify practical applications'
      ],
      optional: false
    });
  } else {
    // If no specific resources found, create a general study step
    steps.push({
      stepNumber: startStepNumber,
      title: `Study: ${objective}`,
      description: `Research and study ${objective.toLowerCase()} using available resources.`,
      type: 'reading',
      estimatedTime: '60 minutes',
      resources: [{
        type: 'external',
        description: `Research ${objective} using textbooks, online resources, or academic materials`,
        url: `https://www.google.com/search?q=${encodeURIComponent(objective)}`
      }],
      completionCriteria: [
        `Research ${objective.toLowerCase()}`,
        'Create summary notes',
        'Find additional resources if needed'
      ],
      optional: false
    });
  }
  
  return steps;
}

// Helper function to find resources for a specific objective
function findResourcesForObjective(objective: string, relevantBooks: any[]): LearningResource[] {
  const resources: LearningResource[] = [];
  const objectiveLower = objective.toLowerCase();
  
  for (const book of relevantBooks.slice(0, 3)) { // Limit to top 3 most relevant books
    // Check if any chapters are particularly relevant
    const relevantChapters = book.chapters?.filter((chapter: any) => 
      chapter.title.toLowerCase().includes(objectiveLower) ||
      objectiveLower.split(' ').some((word: string) => chapter.title.toLowerCase().includes(word))
    ) || [];
    
    if (relevantChapters.length > 0) {
      for (const chapter of relevantChapters.slice(0, 2)) { // Max 2 chapters per book per objective
        resources.push({
          type: 'book_chapter',
          bookId: book.id,
          bookTitle: book.title,
          chapterNumber: chapter.number,
          chapterTitle: chapter.title,
          description: `Study ${chapter.title} from ${book.title}`
        });
      }
    } else {
      // Add the first few chapters as general resources
      const chaptersToAdd = book.chapters?.slice(0, 2) || [];
      for (const chapter of chaptersToAdd) {
        resources.push({
          type: 'book_chapter',
          bookId: book.id,
          bookTitle: book.title,
          chapterNumber: chapter.number,
          chapterTitle: chapter.title,
          description: `Read ${chapter.title} from ${book.title}`
        });
      }
    }
  }
  
  return resources;
}

// Helper function to generate introduction resources
function generateIntroResources(relevantBooks: any[], level: string): LearningResource[] {
  const resources: LearningResource[] = [];
  
  for (const book of relevantBooks.slice(0, 2)) {
    const introChapter = book.chapters?.find((c: any) => 
      c.title.toLowerCase().includes('introduction') ||
      c.title.toLowerCase().includes('overview') ||
      c.number === 1
    );
    
    if (introChapter) {
      resources.push({
        type: 'book_chapter',
        bookId: book.id,
        bookTitle: book.title,
        chapterNumber: introChapter.number,
        chapterTitle: introChapter.title,
        description: `Read the introduction from ${book.title}`
      });
    }
  }
  
  return resources;
}

// Helper function to generate exercise resources
function generateExerciseResources(relevantBooks: any[]): LearningResource[] {
  const resources: LearningResource[] = [];
  
  for (const book of relevantBooks.slice(0, 2)) {
    // Look for chapters with exercises
    const exerciseChapters = book.chapters?.filter((c: any) => 
      c.title.toLowerCase().includes('exercise') ||
      c.title.toLowerCase().includes('practice') ||
      c.title.toLowerCase().includes('problem')
    ) || [];
    
    for (const chapter of exerciseChapters.slice(0, 1)) {
      resources.push({
        type: 'exercise',
        bookId: book.id,
        bookTitle: book.title,
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        description: `Complete exercises from ${chapter.title}`
      });
    }
  }
  
  return resources;
}

// Helper function to generate review resources
function generateReviewResources(relevantBooks: any[]): LearningResource[] {
  const resources: LearningResource[] = [];
  
  for (const book of relevantBooks.slice(0, 1)) {
    // Look for summary or review chapters
    const reviewChapter = book.chapters?.find((c: any) => 
      c.title.toLowerCase().includes('summary') ||
      c.title.toLowerCase().includes('review') ||
      c.title.toLowerCase().includes('conclusion')
    );
    
    if (reviewChapter) {
      resources.push({
        type: 'book_chapter',
        bookId: book.id,
        bookTitle: book.title,
        chapterNumber: reviewChapter.number,
        chapterTitle: reviewChapter.title,
        description: `Review key concepts from ${reviewChapter.title}`
      });
    }
  }
  
  return resources;
}

// Helper function to generate default learning objectives
function generateDefaultObjectives(subject: string, level: string): string[] {
  const baseObjectives = [
    `Understand fundamental concepts of ${subject}`,
    `Apply ${subject} principles to practical problems`,
    `Analyze ${subject} scenarios critically`
  ];
  
  if (level === 'intermediate') {
    baseObjectives.push(
      `Compare different approaches in ${subject}`,
      `Synthesize knowledge from multiple ${subject} sources`
    );
  } else if (level === 'advanced') {
    baseObjectives.push(
      `Evaluate complex ${subject} theories`,
      `Create original solutions using ${subject} principles`,
      `Critique existing ${subject} methodologies`
    );
  }
  
  return baseObjectives;
}

// Helper function to generate a unique path ID
function generatePathId(subject: string, level: string): string {
  const timestamp = Date.now();
  const subjectSlug = subject.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `${subjectSlug}-${level}-${timestamp}`;
}

// Helper function to format duration
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minutes`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (remainingMinutes === 0) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  
  return `${hours} hour${hours > 1 ? 's' : ''} ${remainingMinutes} minutes`;
}

// Helper function to format learning path as markdown
function formatLearningPathAsMarkdown(learningPath: LearningPath): string {
  let markdown = `# ${learningPath.name}\n\n`;
  markdown += `**Subject:** ${learningPath.subject}\n`;
  markdown += `**Level:** ${learningPath.level}\n`;
  markdown += `**Duration:** ${learningPath.duration}\n`;
  markdown += `**Estimated Time:** ${learningPath.metadata.estimatedTotalTime}\n`;
  markdown += `**Total Steps:** ${learningPath.metadata.totalSteps}\n\n`;
  
  markdown += `## Description\n${learningPath.description}\n\n`;
  
  if (learningPath.prerequisites.length > 0) {
    markdown += `## Prerequisites\n`;
    learningPath.prerequisites.forEach(prereq => {
      markdown += `- ${prereq}\n`;
    });
    markdown += `\n`;
  }
  
  markdown += `## Learning Objectives\n`;
  learningPath.learningObjectives.forEach(obj => {
    markdown += `- ${obj}\n`;
  });
  markdown += `\n`;
  
  markdown += `## Learning Steps\n\n`;
  learningPath.steps.forEach(step => {
    markdown += `### Step ${step.stepNumber}: ${step.title}\n`;
    markdown += `**Type:** ${step.type}\n`;
    markdown += `**Estimated Time:** ${step.estimatedTime}\n`;
    markdown += `**Optional:** ${step.optional ? 'Yes' : 'No'}\n\n`;
    markdown += `${step.description}\n\n`;
    
    if (step.resources.length > 0) {
      markdown += `**Resources:**\n`;
      step.resources.forEach(resource => {
        if (resource.type === 'book_chapter') {
          markdown += `- ${resource.bookTitle}, Chapter ${resource.chapterNumber}: ${resource.chapterTitle}\n`;
        } else {
          markdown += `- ${resource.description}\n`;
        }
      });
      markdown += `\n`;
    }
    
    markdown += `**Completion Criteria:**\n`;
    step.completionCriteria.forEach(criteria => {
      markdown += `- ${criteria}\n`;
    });
    markdown += `\n`;
  });
  
  return markdown;
}

// Helper function to format learning path as summary
function formatLearningPathAsSummary(learningPath: LearningPath): any {
  const stepTypes = learningPath.steps.reduce((acc, step) => {
    acc[step.type] = (acc[step.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    pathOverview: {
      id: learningPath.id,
      name: learningPath.name,
      subject: learningPath.subject,
      level: learningPath.level,
      totalSteps: learningPath.metadata.totalSteps,
      estimatedTime: learningPath.metadata.estimatedTotalTime,
      sourceBooks: learningPath.metadata.sourceBooks.length
    },
    stepDistribution: stepTypes,
    keyMilestones: learningPath.steps
      .filter(step => !step.optional && ['assessment', 'review'].includes(step.type))
      .map(step => ({
        stepNumber: step.stepNumber,
        title: step.title,
        type: step.type,
        estimatedTime: step.estimatedTime
      })),
    resourceSummary: {
      totalResources: learningPath.steps.reduce((total, step) => total + step.resources.length, 0),
      bookChapters: learningPath.steps.reduce((total, step) => 
        total + step.resources.filter(r => r.type === 'book_chapter').length, 0),
      exercises: learningPath.steps.reduce((total, step) => 
        total + step.resources.filter(r => r.type === 'exercise').length, 0),
      externalResources: learningPath.steps.reduce((total, step) => 
        total + step.resources.filter(r => r.type === 'external').length, 0)
    }
  };
}

// Macro definition for the registry
export const CreateLearningPathMacroDefinition: MacroComponentDefinition<any> = {
  component: CreateLearningPathMacro,
  name: 'create_learning_path',
  nameSpace: 'booktutor',
  version: '1.0.0',
  description: 'Create a structured learning path from book content',
  features: [],
  runat: 'server',
  roles: ['USER', 'DEVELOPER', 'ADMIN'],
  stem: 'learning',
  tags: ['macro', 'learning', 'path', 'education', 'booktutor'],
  tools: [{
    type: 'function',
    runat: 'server',
    function: {
      name: 'create_learning_path',
      description: 'Create a personalized learning path using available book content. This tool generates a structured sequence of learning activities based on your specified subject and level.',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Main subject or topic for the learning path (e.g., "Mathematics", "Physics", "Computer Science")'
          },
          level: {
            type: 'string',
            enum: ['beginner', 'intermediate', 'advanced'],
            description: 'Learning level: beginner (basic concepts), intermediate (building on fundamentals), advanced (complex applications)'
          },
          duration: {
            type: 'string',
            description: 'Expected duration for completing the path (e.g., "2 weeks", "3 months", "flexible")',
            default: 'flexible'
          },
          prerequisites: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of prerequisite topics or knowledge required before starting this path'
          },
          learningObjectives: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific learning objectives to achieve through this path'
          },
          pathName: {
            type: 'string',
            description: 'Custom name for the learning path (optional, will be auto-generated if not provided)'
          },
          saveToFile: {
            type: 'boolean',
            description: 'Whether to save the learning path to a file for future reference',
            default: true
          },
          format: {
            type: 'string',
            enum: ['json', 'markdown', 'summary'],
            description: 'Output format: json (detailed structure), markdown (readable format), summary (overview)',
            default: 'json'
          }
        },
        required: ['subject', 'level']
      }
    }
  }]
};

export default CreateLearningPathMacroDefinition;
