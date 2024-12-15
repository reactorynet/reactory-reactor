import { ChatState, Macro } from "modules/reactory-reactor/ai/openai/types/chat";

/**
 * A macro that fetches data from the given URL and returns it as text
 * @param args 
 * @param state 
 * @param context 
 * @returns 
 */
export const FetchMacro: Macro<string> = async (
  args: any[], 
  state: ChatState) => { 
  const [ url, requestInit ] = args;
  try {
    const response = await fetch(url.trim(), requestInit);
    const data = await response.text();
    return data;
  } catch (err) {
    console.error(`Error fetching data from ${url}:`, err);
    return '';
  }
};

export const FetchMacroRegistry: Reactory.IReactoryComponentDefinition<typeof FetchMacro> = {
  nameSpace: 'reactor-macros',
  name: 'fetch',
  version: '1.0.0',
  component: FetchMacro,
  description: `A macro that fetches data from the given URL and returns it as text`,
  features: [],
  stem: 'fetch',
  tags: ['fetch', 'http', 'url', 'data'],
}


export const WebMacros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  FetchMacroRegistry,
]