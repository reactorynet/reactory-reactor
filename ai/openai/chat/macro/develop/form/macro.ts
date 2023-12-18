import { ChatState, IQuestion, Macro, QuestionHandlerResponse } from "@reactory/server-core/modules/reactor/ai/openai/types/chat";
import { readFileSync } from "fs";
import { ask } from "@reactory/server-core/modules/reactor/helpers/ask";




const nameCheck = (name: string): boolean => { 
  if(name === undefined || name === null) return false;
  return name && name.length > 0;
}

const moduleCheck = (module: string): boolean => { 
  if(module === undefined || module === null) return false;
  return module && module.length > 0;
}

const moduleQuestion: IQuestion = { 
  id: 1,
  question: 'What module should the form be created in?',
  handler: async (response, state): Promise<QuestionHandlerResponse> => { 
    if(!moduleCheck(response)) { 
      state.context.error(state.context.i18n.t('reactor:chat.form.macro.module.invalid'));
      return {
        next: moduleQuestion,
        state,
      }
    }

    return {
      next: null,
      state,
    }
  }
}

const nameQuestion: IQuestion = { 
  id: 0,
  question: 'What is the name of the form?',
  handler: async (response, state): Promise<QuestionHandlerResponse> => { 
    if(!nameCheck(response)) { 
      state.context.error(state.context.i18n.t('reactor:chat.form.macro.name.invalid'));
      return {
        next: nameQuestion,
        state,
      }
    }

    return {
      next: null,
      state,
    }
  }
}

const questionsStack: IQuestion[] =  [
  nameQuestion
]



/**
 * Creates a new form folder with all the files needed to create a form
 * @param args 
 * @param state 
 */
const FormMacro: Macro<string> = async (
  args: string[],
  state: ChatState) => { 
    let form: Reactory.Forms.IReactoryForm;
    let targetModule: string;

    const [name, module] = args;

    
  };

export const FormMacroComponentRegister: Reactory.IReactoryComponentDefinition<typeof FormMacro> = { 
  nameSpace: 'reactor',
  name: 'FormMacro',
  version: '1.0.0',
  component: FormMacro,
  description: readFileSync(require.resolve('./readme.md'), 'utf-8').toString(),
  features: [],
  stem: 'form',
}