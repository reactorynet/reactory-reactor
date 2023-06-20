export type DirectoryElement = { 
  name: string, 
  extension?: string, 
  size?: number, 
  path?: string 
};
  
/**
 * Path to the file or directory to review
 */
export type CodeReviewPath = string;
/**
 * The specifications for the code review
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