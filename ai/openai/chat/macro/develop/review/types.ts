
/**
 * Properties for the CodeReviewFile macro
 */
export interface CodeReviewFileProps {
  /** Path to the file to review */
  path: string;
  /** Path to specification file (optional) */
  specs?: string;
  /** Target output type - 'inline' or 'file' */
  target?: 'inline' | 'file';
  /** Target file path when target is 'file' */
  targetPath?: string;
}

/**
 * Properties for the CodeReview macro (directory review)
 */
export interface CodeReviewProps {
  /** Path to the directory to review */
  path: string;
  /** Path to specification file (optional) */
  specs?: string;
  /** Target output type - 'inline' or 'file' */
  target?: 'inline' | 'file';
  /** Target file path when target is 'file' */
  targetPath?: string;
  /** Throttle delay between reviews in milliseconds */
  throttle?: string;
  /** Enable verbose output */
  verbose?: string;
}

/**
 * The programming language to use for the code review
 * @example
 * javascript
 * typescript
 * java
 * python
 */
export type ProgrammingLanguage = string;
/**
 * The framework to use for the code review
 * @example
 * react
 * angular
 * vue
 * spring
 * express
 */
export type Framework = string;

/**
 * A feature is a specific feature of a framework, i.e. redux, react-router, etc.
 */
export type Feature = string;

/**
 * A metric represent a category of a code review, i.e. security, performance, etc.
 */
export type ReviewMetric = string |
  "security" |
  "performance" |
  "maintainability" |
  "reliability" |
  "readability" |
  "testability" |
  "portability" |
  "usability" |
  "accessibility" |
  "concurrency" |
  "internationalization" |
  "localization" |
  "documentation" |
  "efficiency" |
  "correctness" |
  "robustness" |
  "flexibility" |
  "extensibility" |
  "reusability" |
  "interoperability";

/**
 * Detected framework score.
 */
export interface DetectedFrameworks {
  [key: Framework]: number;
}

/**
 * Metric weighted values
 */
export interface ReviewMetricValues {
  weight: number;
  target: number;
  description: string;
}

/**
 * The specifications for each metric
 */
export interface MetricSpecifications {
  [key: ReviewMetric]: ReviewMetricValues;
}

/**
 * The specifications for a code review provides the language 
 * and framework to use for the code review. It also provides the
 * specifications for each metric.
 */
export interface CodeReviewSpecification {
  /**
   * The programming language or languages to use for the code review.
   */
  languages: ProgrammingLanguage[];
  /**
   * The framework to use for the code review. The framework is optional
   * however it is useful for providing more accurate code reviews for
   * frameworks that have specific code review requirements.
   */
  framework?: Framework;
  /**
   * The features to use for the code review. The features are optional
   * however it is useful for providing more accurate code reviews for
   * frameworks that have specific code review requirements.
   * 
   * @example
   * features: ['react', 'redux', 'typescript']
   */
  features?: Feature[];
  /**
   * The specifications for each metric
   */
  specs: MetricSpecifications;
}

export interface GitOptions {
  /**
   * The url to the git repository if the git repository is not local
   */
  url?: string;

  /**
   * The branch to check out / review
   */
  branch: string;
  /**
   * The comparison branch to use for the code review. This is useful for creating a
   * review for a pull request.
   */
  comparison?: string

  /**
   * The target folder for the repo.
   */
  target?: string;

  /**
   * The git provider
   */
  provider?: 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'custom';
}

/**
 * The options for the code review
 */
export interface CodeReviewOptions {
  /**
   * The framework to use for the code review. The framework is optional, 
   * however it is useful for providing more accurate code reviews for 
   * frameworks that have specific code review requirements.
   */
  framework?: Framework;
  /**
   * The specifications for the code review. The specifications are required
   * and are used to determine the specifications for the code review.
   */
  specs: {
    [key in ProgrammingLanguage]: CodeReviewSpecification;
  };

  /**
   * File specifications for the code review are used for specific
   * files that need to be reviewed. This is useful for reviewing
   * files that are not part of the project, i.e. configuration files, or 
   * to provide additional review instructions for the project.
   * 
   * If a file pattern matches a exlude pattern, the file will be excluded
   * from the code review.
   * @example
   * fileSpecs: {
   * "package.json": "Ensure that the package.json file is valid and contains all required fields for public npm packages",
   * "tsconfig.json": "Ensure that the tsconfig.json file is valid and contains all required fields for typescript projects",
   * "tslint.json": "Ensure that the tslint.json file is valid and contains all required fields for typescript projects",
   * }
   */
  fileSpecs?: {
    [key: string]: CodeReviewSpecification
  };

  files: {
    /**
     * a list of files to include in the code review.
     * If this is not provided, all files will be included in the code review.
     * @example
     * include: ['*.js', '*.ts', '*.jsx', '*.tsx']
     */
    include?: string[];
    /**
     * a list of files to exclude from the code review.
     * If this is not provided, no files will be excluded from the code review.
     * @example
     * exclude: ['*.gitignore', '*.git', '.eslintrc', 'tsconfig.json']
     */
    exclude?: string[];
  };

  /**
   * Git options for the code review
   */
  git?: GitOptions;
}

/**
 * Defines the interface for the code review result for a file.
 */
export interface CodeReviewFileResult {
  
  id: string;
  /**
   * The specifications for the code review used on the file.
   */
  spec: CodeReviewSpecification;
  /**
   * The file that was reviewed.
   */
  file: string;
  /**
   * The review for the file. This is a markdown
   * string that contains the review for the file.
   */
  review: string;
  /**
   * The score for the code review. This is a 
   * number between 0 and 1. The higher the score,
   * the better the code review.
   * @example
   * 0.8 
   */
  score: number;
  /**
   * The metrics for the code review. This is a
   * map of the metrics and their scores. The higher
   * the score, the better the code review.
   * 
   * @example
   * {
   *  security: 0.8,
   *  performance: 0.8,
   *  maintainability: 0.6,
   * }
   */
  metrics: {
    [key in ReviewMetric]: number;
  };
  /**
   * The date the code review was complete
   */
  created: Date;
  /**
   * The duration of the code review in milliseconds
   */
  duration: number;
  /**
   * The accuracy of the code review. This is a number
   * between 0 and 1. The higher the accuracy, the more
   * accurate the code review. 
   * 
   * The accuracy is calculated by comparing the code review
   * to the specifications for the code review and can be set
   * by a user.
   */
  accuracy: number;
}

/**
 * The result of a code review
 * @example
 */ 
export interface CodeReviewResult {
  id: string;
  options? : CodeReviewOptions;
  /**
   * indivudal file reviews
   */
  fileReviews: CodeReviewFileResult[];
  /**
   * The review for the code review. This is a markdown
   * string that contains the review for the code review.
   */
  review: string;
  /**
   * The score for the code review. This is a
   * number between 0 and 1. The higher the score,
   * the better the code review.
   */
  score: number;
  /**
   * The accuracy of the code review. This is a number
   * between 0 and 1. The higher the accuracy, the more
   * accurate the code review.
   * 
   * The accuracy is calculated by comparing the code review
   * to the specifications for the code review and can be set
   * by a user.
   */
  accuracy: number;
  /**
   * The metrics for the code review. This is a
   * map of the metrics and their scores. This is the 
   * overall score for the code review and is calculated
   * by aggregating the scores for each file review
   * 
   * @example
   * {
   *  security: 0.8,
   *  performance: 0.8,
   *  maintainability: 0.6,
   * }
   */
  metrics: {
    [key in ReviewMetric]: number;
  };
  /**
   * The date the code review was complete.
   */
  created: Date;
  /**
   * The duration of the code review in milliseconds
   */
  duration: number;
}

/**
 * A code review processor is used to process the code review result after the code review is complete.
 * It aggregates the results of the code review and returns the final code review result. Different processors
 * may have different strategies for aggregating the results of the code review.
 */
export type CodeRviewProcessor = (result: CodeReviewResult) => Promise<CodeReviewResult>;
/**
 * Function that returns the specifications for a file. If no specifications are found for the file,
 * the default specifications for the code review will be used.
 * 
 * @param file the file to get the specifications for, can either be a path or url.
 */
export type GetFileSpec = (file: string) => Promise<CodeReviewSpecification>


/**
 * Directory element used in the ListDirectory macro. 
 */
export type DirectoryElement = { 
  name: string, 
  isDirectory: boolean,
  extension?: string, 
  size?: number, 
  path?: string
  children?: DirectoryElement[] 
};
  
/**
 * Path to the file or directory to review
 */
export type CodeReviewPath = string;
/**
 * The specifications for the code review.
 * This is a markdown file that contains the specifications for the code review 
 * or a path to a file that contains the specifications for the code review
 */
export type CodeReviewSpecifications = string;
/**
 * The target for the code review
 */
export type CodeReviewTarget = string & "inline" | "file";
/**
 * The path to the target file
 * @example
 * /path/to/file
 * ${process.env.APP_DATA_ROOT}/path/to/file}
 * */
export type CodeReviewTargetPath = string
/**
 * The throttle for the code review. This is used to throttle the number of requests made to the OpenAI API
 * If we don't throttle the requests, we will get rate limited by the OpenAI API and the code review will fail
 * 
 * Default value is 500ms
 */
export type CodeReviewThrottle = string;
export type CodeReviewArgs = [
  CodeReviewPath,
  CodeReviewSpecifications, 
  CodeReviewTarget,
  CodeReviewTargetPath,
  CodeReviewThrottle
];