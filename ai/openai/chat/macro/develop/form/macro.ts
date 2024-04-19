import { ChatState, IQuestion, Macro, QuestionHandlerResponse } from "@reactory/server-core/modules/reactor/ai/openai/types/chat";
import { readFileSync } from "fs";
import { ask } from "@reactory/server-core/modules/reactor/helpers/ask";
import uuid from "uuid";
import { ChatFactory } from "../../../questions/factory";


interface FormMacroState { 
  form: Reactory.Forms.IReactoryForm,
  targetModule: string,
  catalog_result: Reactory.Forms.IReactoryForm[]
  errors: string[]
}

const nameCheck = (name: string): boolean => { 
  if(name === undefined || name === null) return false;
  return name && name.length > 0;
}

const moduleCheck = (module: string): boolean => { 
  if(module === undefined || module === null) return false;
  return module && module.length > 0;
}

const selectFormQuestion: IQuestion = { 
  id: 3,
  question: 'Found ${state.vars.catalog_result.length} forms, which form would you like to edit?',
  askIf: (state): boolean => {
    const FormMacro = state.vars.FormMacro as FormMacroState;
    const { name } = FormMacro.form as Reactory.Forms.IReactoryForm;
    return name === undefined || name === null || name.length === 0;
  },
  handler: async (response, state): Promise<QuestionHandlerResponse> => { 
    if(!nameCheck(response)) { 
      state.context.error(state.context.i18n.t('reactor:chat.form.macro.name.invalid', { 
        name: response, 
        defaultValue: 'Invalid name'
      }));
      return {
        next: nameQuestion,
        state,
      }
    }
    return {
      next: moduleQuestion,
      state,
    }
  }
};

const descriptionQuestion: IQuestion = { 
  id: 2,
  question: 'What is the description of the form?',
  askIf: (state): boolean => {
    const FormMacro = state.vars.FormMacro as FormMacroState;
    const { description } = FormMacro.form as Reactory.Forms.IReactoryForm;
    return description === undefined || description === null || description.length === 0;
  },
  handler: async (response, state): Promise<QuestionHandlerResponse> => { 
    if(!response || response.length === 0) { 
      state.context.error(state.context.i18n.t('reactor:chat.form.macro.description.invalid', { 
        name: response, 
        defaultValue: 'A description is required in order to suggest a schema.'
      }));

      return {
        next: descriptionQuestion,
        state,
      }
    }

    const FormMacro = state.vars.FormMacro as FormMacroState;
    FormMacro.form.description = response;

    const formService = state.context.getService<Reactory.Service.IReactoryFormService>('reactor.ReactoryFormService@1.0.0');
    formService.search({ 
      form: FormMacro.form, 
      module: FormMacro.targetModule 
    });

    return {
      next: null,
      state,
    }
  }
};

const moduleQuestion: IQuestion = { 
  id: 1,
  question: 'What module should the form be created in?',  
  askIf: (state): boolean => { 
    const FormMacro = state.vars.FormMacro as FormMacroState;    
    return moduleCheck(FormMacro.targetModule);        
  },
  next: descriptionQuestion,  
  handler: async (response, state): Promise<QuestionHandlerResponse> => { 
    if(!moduleCheck(response)) { 
      state.context.error(state.context.i18n.t('reactor:chat.form.macro.module.invalid'));
      return {
        next: moduleQuestion,
        state,
      }
    }
    return {
      next: descriptionQuestion,
      state,
    }
  }
}

const nameQuestion: IQuestion = { 
  id: 0,
  question: 'What is the name of the form?',
  askIf: (state): boolean => {
    const { __form } = state.vars;
    const { name } = __form as Reactory.Forms.IReactoryForm;
    return name === undefined || name === null || name.length === 0;
  },
  next: moduleQuestion,
  handler: async (response, state): Promise<QuestionHandlerResponse> => { 
    if(!nameCheck(response)) { 
      state.context.error(state.context.i18n.t('reactor:chat.form.macro.name.invalid', { 
        name: response, 
        defaultValue: 'Invalid name'
      }));

      return {
        next: nameQuestion,
        state,
      }
    }
    return {
      next: moduleQuestion,
      state,
    }
  }
};

/**
 * Creates a new form folder with all the files needed to create a form
 * @param args 
 * @param state 
 */
const FormMacro: Macro<string> = async (
  args: string[],
  state: ChatState) => {     
    

    const [name, module] = args;
    let targetModule: string = module; 
    let form: Reactory.Forms.IReactoryForm = {
      id: '',
      name,
      nameSpace: '',
      version: '1.0.0',
      description: '',
      uiFramework: 'material',
      schema: {} as Reactory.Schema.AnySchema,
      uiSchema: {},
      uiSchemas: [],
      fields: [],
      actions: [],
    };
    const macroState: FormMacroState = { 
      form,
      targetModule,
      catalog_result: [],
      errors: [],
    };
    
    state.vars.FormMacro = macroState;

    try { 
      await ask(nameQuestion, state);
      delete state.vars.FormMacro; // clear the state
    } 
    catch (error) { 
      state.context.error(error);
      return `Error creating form ${name} in module ${module}: ${error.message}`;
    }
        
    return `
Form ${name} created in module ${module}.
  * To view the form use the macro @form(view, ${form.id}, ...params?)) 
  * To edit the form use the macro @form(edit, ${form.id})
  * To delete the form use the macro @form(delete, ${form.id})`;
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