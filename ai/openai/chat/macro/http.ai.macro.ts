import { ChatState, Macro } from "modules/reactor/types/chat.types";

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