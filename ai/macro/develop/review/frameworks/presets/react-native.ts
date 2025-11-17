
import { CodeReviewOptions } from '../../types';
import TypeScript from './typescript'

export default {
  ...TypeScript,
  specs: {
    ...TypeScript.specs,
  },
  files: {
    include: [".ts", ".js", ".tsx", ".jsx", ".css", ".scss", ".sass", ".html", ".json", ".md"],
    exclude: [...TypeScript?.files?.exclude],
  }
} as CodeReviewOptions;