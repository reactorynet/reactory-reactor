import { Default } from "../../specifications"
import { CodeReviewOptions } from "../../types";

/**
 * The specifications for a TypeScript project.
 */
export default {
  framework: "vanilla",
  specs: {
    "typescript": { 
      languages: [
        "typescript",
        "javascript"
      ],
      specs: Default
    },
    "javascript": {
      languages: ["javascript"],
      specs: Default
    }
  },
  files: {
    include: [".ts", ".js"],
    exclude: [
      "node_modules",
      "dist",
      "docs",
      ".gitignore",
      ".git",
    ]
  },
  git: {
    branch: "master",
  }
} as CodeReviewOptions;
