import schema from './schema';
import uiSchema from './uiSchema';
import modules from './modules';

const ChatBotForm: Reactory.Forms.IReactoryForm = { 
  id: `reactor.ChatBot@1.0.0`,
  schema,
  description: `
    A Chat Bot Form that allows users to interact with a chat bot.
    This form is designed to be used with the Reactory Chat Bot Widget.
    The form includes a text input for the user to enter their message,
    and a submit button to send the message to the chat bot.
    The chat bot will respond with a message that is displayed in the chat window.
    The form also includes a list of previous messages in the chat history.
    The chat history is displayed in a scrollable window, and the user can
    scroll through the history to see previous messages.
  `,
  uiFramework: 'material',
  uiSupport: ['material'],
  uiSchema,  
  uiResources: [],
  helpTopics: ['help-chat-bot'],
  title: "Reactory Chat Bot",  
  registerAsComponent: true,  
  nameSpace: "reactor",
  name: "ChatBot",  
  version: '1.0.0',
  widgetMap: [
    { componentFqn: 'reactor.ChatBotWidget@1.0.0', widget: 'ChatBotWidget' }
  ],
  modules
}

export default ChatBotForm;