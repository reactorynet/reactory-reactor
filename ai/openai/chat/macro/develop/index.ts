import { GitMacroRegistry } from './git';
import { 
  CodeReviewComponentRegister, 
  CodeReviewFileComponentRegister 
} from './review';

export { GitMacro as git } from './git';
export { 
  CodeReview as review, 
  CodeReviewFile as reviewFile 
} from './review';

export default [
  GitMacroRegistry,
  CodeReviewComponentRegister,
  CodeReviewFileComponentRegister,
];

