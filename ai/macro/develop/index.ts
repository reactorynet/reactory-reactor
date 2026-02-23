import { GitMacroRegistry } from './git';
import { 
  CodeReviewComponentRegister, 
  CodeReviewFileComponentRegister 
} from './review';


export { 
  CodeReview as review, 
  CodeReviewFile as reviewFile 
} from './review';

export default [
  CodeReviewComponentRegister,
  CodeReviewFileComponentRegister,
];

